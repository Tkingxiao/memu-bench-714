#!/usr/bin/env node
/**
 * bench-reset — 一次考试 + 判分结束后的收尾：先写审计记录，再清空本 bench 的会话与记忆。
 *
 * 清理范围（只动评测数据，不动宿主/插件/结果文件）：
 *   1. <home>/sessions/<bench scope 目录>/            该 workspace 的全部会话（含种子会话、整理 fork）
 *   2. <home>/storages/session_projcache/sessions/<id>.json   对应的投影缓存
 *   3. 私有记忆库（默认 lib_4a9b8a60）：archive → delete（会一并删除索引、实体图、向量库
 *      文件、会话绑定，并从 active 向量代际里摘除该库）
 *
 * “不影响新任务”：清理后宿主照常运行；下一次考试从空库开始，种入 → 整理（写入并
 * enroll 进当前 e5 代际）→ 考试（召回走 managed-vector-rrf），整条链路自洽。
 *
 * 审计先落盘再删：logs/reset-log.jsonl，一行一次清理。
 *
 * 用法：
 *   node scripts/bench-reset.mjs [--dry-run] [--keep-library] [--library lib_xxx]
 *     [--home <dsh home>] [--workspace <dir>] [--base http://127.0.0.1:39771]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LOGS = path.join(ROOT, 'logs')
fs.mkdirSync(LOGS, { recursive: true })

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name) => args.includes(`--${name}`)

const HOME = flag('home') || process.env.DSH_HOME || path.join(os.homedir(), 'AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.2.2-rc.1')
const WORKSPACE = path.resolve(flag('workspace') || path.join(ROOT, 'workspace'))
const BASE = flag('base') || process.env.BENCH_BASE || 'http://127.0.0.1:39771'
const LIBRARY_ID = flag('library') || 'lib_4a9b8a60'
const COOKIE_FILE = path.join(LOGS, 'host-cookie.txt')
const RESET_LOG = path.join(LOGS, 'reset-log.jsonl')
const TOKEN_LEDGER = path.join(LOGS, 'token-ledger.jsonl')
const DRY = has('dry-run')
const KEEP_LIBRARY = has('keep-library')

const memoryDir = path.join(HOME, 'dsh-memu-memory')
const sessionsRoot = path.join(HOME, 'sessions')
const projCache = path.join(HOME, 'storages', 'session_projcache', 'sessions')

function scopeDirName(workspace) {
  return '--' + path.resolve(workspace).replace(/[^A-Za-z0-9.]+/g, '-') + '--'
}

function normScope(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// 会话文件删掉后，插件 state.sessions 里仍可能留着指向它们的绑定（libraryId 为 null
// 的那些不会被 deleteLibrary 带走）。按 workspace scope 找出全部绑定，逐个解绑。
function staleBindings() {
  const state = readJson(path.join(memoryDir, 'state.json'), { sessions: {} })
  const target = normScope(WORKSPACE)
  return Object.entries(state?.sessions || {})
    .filter(([, binding]) => normScope(binding?.scopeKey) === target)
    .map(([sessionId]) => sessionId)
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

// 把最近一次 token 报告的总量与分项带进清理审计，之后只读 reset-log 也能对上账。
function lastTokenSummary() {
  try {
    const lines = fs.readFileSync(TOKEN_LEDGER, 'utf8').split('\n').filter(Boolean)
    const last = JSON.parse(lines[lines.length - 1])
    return {
      ts: last.generatedAt || null,
      since: last.since || null,
      totals: last.totals || null,
      byPurpose: last.byPurpose || null,
    }
  } catch {
    return null
  }
}

function libraryStats(libraryId) {
  const index = readJson(path.join(memoryDir, 'index', `${libraryId}.json`), { entries: {} })
  const entries = Object.keys(index?.entries || {}).length
  let vectorRows = null
  let vectorPath = null
  try {
    const active = readJson(path.join(memoryDir, 'index', 'vector-active.json'), null)
    vectorPath = active?.active?.databases?.libraries?.[libraryId]?.path || null
    if (vectorPath) {
      const abs = path.join(memoryDir, ...String(vectorPath).split(/[\\/]+/))
      vectorRows = countSqliteRows(abs)
    }
  } catch { /* stats must never block cleanup */ }
  return { entries, vectorRows, vectorPath }
}

function countSqliteRows(file) {
  try {
    const buf = fs.readFileSync(file)
    // 只读页面里粗略数行没有意义；这里用文件大小作为存在性证据，行数交给调用方按需查。
    return { bytes: buf.length }
  } catch { return null }
}

async function pluginRpc(endpoint, payload = {}, timeoutMs = 60_000) {
  const cookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim()
  const res = await fetch(`${BASE}/dsh-memu-memory/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch {}
  if (!body?.result) throw new Error(`plugin rpc ${endpoint} -> ${res.status}: ${text.slice(0, 200)}`)
  if (body.result.ok === false) throw new Error(`plugin rpc ${endpoint} failed: ${JSON.stringify(body.result.error || body.result).slice(0, 260)}`)
  return body.result.value ?? body.result
}

function removeSessions(scopeDir) {
  const removed = []
  const dir = path.join(sessionsRoot, scopeDir)
  if (!fs.existsSync(dir)) return removed
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    removed.push(name)
    if (!DRY) fs.rmSync(full, { recursive: true, force: true })
  }
  if (!DRY && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    try { fs.rmdirSync(dir) } catch {}
  }
  return removed
}

function removeProjections(sessionIds) {
  const removed = []
  if (!fs.existsSync(projCache)) return removed
  for (const name of fs.readdirSync(projCache)) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    if (!sessionIds.includes(id)) continue
    if (!DRY) fs.rmSync(path.join(projCache, name), { force: true })
    removed.push(name)
  }
  return removed
}

async function main() {
  const scopeDir = scopeDirName(WORKSPACE)
  const stats = libraryStats(LIBRARY_ID)
  const sessionIds = fs.existsSync(path.join(sessionsRoot, scopeDir))
    ? fs.readdirSync(path.join(sessionsRoot, scopeDir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : []
  const bindingIds = staleBindings()

  const record = {
    ts: new Date().toISOString(),
    event: 'bench-reset',
    dryRun: DRY,
    workspace: WORKSPACE.replace(/\\/g, '/'),
    scopeDir,
    sessions: { count: sessionIds.length, ids: sessionIds },
    bindings: { count: bindingIds.length },
    library: {
      id: LIBRARY_ID,
      entries: stats.entries,
      vectorPath: stats.vectorPath,
      vectorBytes: stats.vectorRows?.bytes ?? null,
      action: KEEP_LIBRARY ? 'kept' : 'archive+delete',
    },
    tokens: lastTokenSummary(),
    projectionsRemoved: 0,
  }

  // 审计先写：哪怕后续删除失败，也留下“这次准备清什么”的证据。
  if (!DRY) fs.appendFileSync(RESET_LOG, JSON.stringify(record) + '\n')

  const removedSessions = removeSessions(scopeDir)
  const removedProjections = removeProjections(sessionIds)

  let libraryResult = null
  if (!KEEP_LIBRARY) {
    try {
      if (!DRY) {
        await pluginRpc('archiveLibrary', { libraryId: LIBRARY_ID })
        libraryResult = await pluginRpc('deleteLibrary', { libraryId: LIBRARY_ID })
      } else {
        libraryResult = { ok: true, dryRun: true }
      }
    } catch (error) {
      const message = String(error?.message || error)
      // 幂等：库已经被上一次清理删掉时不算失败，也不写错误行。
      if (/library not found/i.test(message)) {
        libraryResult = { ok: true, skipped: 'absent' }
      } else {
        libraryResult = { ok: false, error: message.slice(0, 300) }
        if (!DRY) fs.appendFileSync(RESET_LOG, JSON.stringify({ ...record, event: 'bench-reset-library-error', error: libraryResult.error }) + '\n')
      }
    }
  }

  // 解绑指向已删除会话的插件绑定；逐个调用，单个失败只记日志，不阻断清理。
  let bindingsRemoved = 0
  if (!DRY) {
    for (const sessionId of bindingIds) {
      try {
        await pluginRpc('unbindSession', { sessionId })
        bindingsRemoved += 1
      } catch (error) {
        fs.appendFileSync(RESET_LOG, JSON.stringify({ ts: new Date().toISOString(), event: 'bench-reset-unbind-error', sessionId, error: String(error?.message || error).slice(0, 200) }) + '\n')
      }
    }
  }

  const summary = {
    ok: true,
    dryRun: DRY,
    scopeDir,
    sessionsRemoved: removedSessions.length,
    projectionsRemoved: removedProjections.length,
    bindingsRemoved,
    library: KEEP_LIBRARY ? 'kept' : libraryResult,
    log: DRY ? '(dry run, not written)' : RESET_LOG,
  }
  console.log(JSON.stringify(summary, null, 1))
}

main().catch((error) => {
  console.error('bench-reset failed:', error?.message || error)
  process.exitCode = 1
})
