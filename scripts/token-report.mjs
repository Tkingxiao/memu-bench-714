#!/usr/bin/env node
/**
 * token-report — 统计一次评测运行的 token 消耗：输入、缓存命中/未命中、输出、总计。
 *
 * 两个数据源：
 *   1. 宿主会话文件（bench workspace scope）：assistant/message.data.usage
 *        inputTokens      = 未命中输入（fresh prompt tokens）
 *        cacheReadTokens  = 缓存命中输入
 *        cacheWriteTokens = 缓存写入
 *        outputTokens     = 输出
 *        totalTokens      = 三者合计（宿主/pi-ai 口径）
 *      按会话名分类：memu-consolidate-* → 整理；命中 api-log 的 exam-session-create → 考试；
 *      其余 → 其它（种子/闲聊/验证回合）。
 *   2. logs/api-log.jsonl：judge / probe 这类直连 DYS 的调用（不走宿主会话），
 *      记录 promptTokens / completionTokens / cacheHit / cacheMiss。
 *      exam-usage 不在此列——它只是会话 usage 的副本，重复计数会被排除。
 *
 * 输出：
 *   results/token-report.json        本次运行完整报告
 *   logs/token-ledger.jsonl          每次运行追加一行摘要（清理会话后仍然保留）
 *
 * 用法：
 *   node scripts/token-report.mjs [--since <ISO 时间>] [--out results/token-report.json]
 *     [--home <dsh home>] [--workspace <dir>]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LOGS = path.join(ROOT, 'logs')
const RESULTS = path.join(ROOT, 'results')
fs.mkdirSync(LOGS, { recursive: true })
fs.mkdirSync(RESULTS, { recursive: true })

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const HOME = flag('home') || process.env.DSH_HOME || path.join(os.homedir(), 'AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.2.2-rc.1')
// 重建记忆时每题按 checkpoint 目录建会话，不再只有 workspace 一个 scope；
// --workspaces 用分号分隔，支持同时统计多个 persona 流。
const WORKSPACE = path.resolve(flag('workspace') || path.join(ROOT, 'workspace'))
const WORKSPACES = (flag('workspaces') || '').split(';').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(p))
const SCOPES = WORKSPACES.length ? WORKSPACES : [WORKSPACE]
const API_LOG = path.join(LOGS, 'api-log.jsonl')
const OUT = path.resolve(flag('out') || path.join(RESULTS, 'token-report.json'))
const LEDGER = path.join(LOGS, 'token-ledger.jsonl')
const SINCE = flag('since') ? Date.parse(flag('since')) : null
const NO_LEDGER = args.includes('--no-ledger')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function scopeDirName(workspace) {
  return '--' + path.resolve(workspace).replace(/[^A-Za-z0-9.]+/g, '-') + '--'
}

// 会话日志是多帧 zstd 拼接（每 flush 一帧）。Node 的 zstdDecompressSync 只解第一帧，
// 这里按 magic 切帧逐段解压；切错（压缩体里偶然出现 magic）时该段解压失败，跳过即可。
function readSessionRows(file) {
  const buf = fs.readFileSync(file)
  const offsets = []
  let from = 0
  while (true) {
    const i = buf.indexOf(ZSTD_MAGIC, from)
    if (i < 0) break
    offsets.push(i)
    from = i + 4
  }
  const rows = []
  for (let n = 0; n < offsets.length; n += 1) {
    const end = n + 1 < offsets.length ? offsets[n + 1] : buf.length
    let text = ''
    try { text = zlib.zstdDecompressSync(buf.subarray(offsets[n], end)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { /* skip partial */ }
    }
  }
  return rows
}

function emptyBucket() {
  return { calls: 0, input: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0 }
}

function addUsage(bucket, usage = {}) {
  const input = Number(usage.inputTokens ?? usage.promptTokens ?? 0) || 0
  const cacheHit = Number(usage.cacheReadTokens ?? usage.cacheHit ?? 0) || 0
  const cacheWrite = Number(usage.cacheWriteTokens ?? usage.cacheWrite ?? 0) || 0
  const output = Number(usage.outputTokens ?? usage.completionTokens ?? 0) || 0
  const total = Number(usage.totalTokens ?? (input + cacheHit + cacheWrite + output)) || 0
  bucket.calls += 1
  bucket.input += input
  bucket.cacheHit += cacheHit
  bucket.cacheWrite += cacheWrite
  bucket.output += output
  bucket.total += total
}

function addBucket(target, source) {
  for (const key of Object.keys(source)) target[key] = (target[key] || 0) + source[key]
}

function hitRate(bucket) {
  const prompt = bucket.input + bucket.cacheHit + bucket.cacheWrite
  return prompt > 0 ? bucket.cacheHit / prompt : 0
}

function readApiLog() {
  if (!fs.existsSync(API_LOG)) return []
  return fs.readFileSync(API_LOG, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

function sessionPurpose(sessionName, qidBySession) {
  if (sessionName.startsWith('memu-consolidate-')) return 'consolidation'
  if (qidBySession.has(sessionName)) return 'exam'
  return 'other'
}

function main() {
  const apiRows = readApiLog()
  const sinceRows = SINCE ? apiRows.filter((row) => Date.parse(row.ts) >= SINCE) : apiRows

  const qidBySession = new Map()
  for (const row of apiRows) {
    if (row.purpose === 'exam-session-create' && row.sessionId && row.qid) qidBySession.set(row.sessionId, row.qid)
  }

  const byPurpose = { exam: emptyBucket(), consolidation: emptyBucket(), other: emptyBucket(), judge: emptyBucket(), probe: emptyBucket() }
  const bySession = []
  const byQid = {}
  let sessionFiles = 0

  const seen = new Set()
  for (const workspace of SCOPES) {
    const scopeDir = scopeDirName(workspace)
    const sessionsDir = path.join(HOME, 'sessions', scopeDir)
    if (!fs.existsSync(sessionsDir)) continue
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(sessionsDir, entry.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file) || seen.has(file)) continue
      seen.add(file)
      sessionFiles += 1
      const purpose = sessionPurpose(entry.name, qidBySession)
      const bucket = emptyBucket()
      const rows = readSessionRows(file)
      for (const row of rows) {
        if (row?.type !== 'assistant/message' || !row?.data?.usage) continue
        addUsage(bucket, row.data.usage)
      }
      if (bucket.calls === 0) continue
      addBucket(byPurpose[purpose], bucket)
      const qid = qidBySession.get(entry.name) || null
      bySession.push({ sessionId: entry.name, purpose, qid, ...bucket, hitRate: hitRate(bucket) })
      if (qid) {
        byQid[qid] ||= emptyBucket()
        addBucket(byQid[qid], bucket)
      }
    }
  }

  for (const row of sinceRows) {
    if (row.purpose === 'exam-usage') continue // 会话 usage 的副本，避免重复计数
    if (row.purpose !== 'judge' && row.purpose !== 'probe') continue
    if (row.outcome === 'fail' || row.outcome === 'error') continue
    if (row.promptTokens == null && row.completionTokens == null) continue // 旧日志只有估算值，跳过
    const bucket = emptyBucket()
    addUsage(bucket, {
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cacheHit: row.cacheHit,
      cacheMiss: row.cacheMiss,
    })
    // promptTokens 已是总输入（命中+未命中）；这里把未命中拆出来，命中单独记。
    if (row.promptTokens != null) {
      const miss = Number(row.cacheMiss ?? row.promptTokens) || 0
      bucket.input = miss
      bucket.cacheHit = Number(row.cacheHit || 0) || 0
      bucket.total = (Number(row.promptTokens) || 0) + (Number(row.completionTokens) || 0)
    }
    addBucket(byPurpose[row.purpose === 'judge' ? 'judge' : 'probe'], bucket)
  }

  const totals = emptyBucket()
  for (const bucket of Object.values(byPurpose)) addBucket(totals, bucket)
  totals.hitRate = hitRate(totals)

  const report = {
    generatedAt: new Date().toISOString(),
    since: SINCE ? new Date(SINCE).toISOString() : null,
    scopeDir: SCOPES.map((w) => scopeDirName(w)),
    sources: { sessionFiles, apiRows: sinceRows.length },
    totals,
    byPurpose,
    byQid,
    bySession,
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8')
  // 完整报告（含 bySession / byQid / byPurpose）作为一行 JSONL 追加进 log，
  // 会话与记忆被清理后仍然可以直接从 logs/token-ledger.jsonl 做分析。
  if (!NO_LEDGER) fs.appendFileSync(LEDGER, JSON.stringify({ ...report, event: 'token-report' }) + '\n')

  const pct = (n) => (n * 100).toFixed(1) + '%'
  console.log('token report ->', OUT)
  console.log(`sessions=${sessionFiles} apiRows=${sinceRows.length} calls=${totals.calls}`)
  console.log(`input(miss)=${totals.input} cacheHit=${totals.cacheHit} cacheWrite=${totals.cacheWrite} output=${totals.output} total=${totals.total} hitRate=${pct(totals.hitRate)}`)
  for (const [name, bucket] of Object.entries(byPurpose)) {
    if (!bucket.calls) continue
    console.log(`  ${name.padEnd(13)} calls=${String(bucket.calls).padStart(3)} input=${String(bucket.input).padStart(7)} hit=${String(bucket.cacheHit).padStart(7)} output=${String(bucket.output).padStart(6)} total=${String(bucket.total).padStart(7)} hitRate=${pct(hitRate(bucket))}`)
  }
}

main()
