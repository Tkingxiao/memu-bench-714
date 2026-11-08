#!/usr/bin/env node
/**
 * memu-bench-714 — 考试执行（E2 形态 + 按 cutoff 重建记忆）。
 *
 * 协议（methodology.md 口径）：
 *  - 作答模型只见「该题可见历史前缀的最近六轮 + 插件原生召回注入/工具」，不给完整历史与答案。
 *  - 每题一个全新会话；考题与回答不写入后续记忆（会话用后即弃，不参与回放）。
 *
 * 每轮评测 = 重建记忆库再考：
 *  1) 按 persona 建立一条全新种子会话，按 cutoff 升序增量追加冻结历史轮次；
 *  2) 每个 checkpoint 用插件 generatePrivate 整理增量，写入本轮的独立记忆库；
 *  3) 整理完成后再考该 checkpoint 的题目（考试会话绑定同一个库，只读）；
 *  4) 考完清理考试回合误写入的条目（回滚到整理后的基线）。
 * 这样早 cutoff 的题不会看到晚 cutoff 的记忆（避免时间穿越泄漏）。
 *
 * 用法：
 *   node exam-run.mjs --ids P01-CASE-003/d00,P01-CASE-006/d00 \
 *     --out results/answers-sample.jsonl [--concurrency 1..8] [--no-prepare]
 *   node exam-run.mjs --ids-file results/run-ids.txt --label dashboard-20261106-120000 ...
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LOGS = path.join(ROOT, 'logs')
const COOKIE_FILE = path.join(LOGS, 'host-cookie.txt')
const DATASET = path.join(ROOT, 'datasets', 'natural-timegrid-20261101-v2')
const ANSWER_KEY = path.join(DATASET, 'review-only', 'answer-key.jsonl')
const EVIDENCE = path.join(ROOT, 'grading', 'evidence.jsonl')
const JUDGE_TEMPLATE = path.join(ROOT, 'grading', 'external-judge-prompt.md')
const EXAM_LOG = path.join(LOGS, 'exam-log.jsonl')
const BASE = process.env.BENCH_BASE || 'http://127.0.0.1:39771'
const HOME = process.env.BENCH_HOME || path.join(os.homedir(), 'AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.2.2-rc.1')
const API_LOG = path.join(LOGS, 'api-log.jsonl')
const DEFAULT_WORKSPACE = path.join(ROOT, 'workspace')

function logApi(entry) {
  fs.appendFileSync(API_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
}

function appendJsonl(file, row) {
  fs.appendFileSync(file, JSON.stringify(row) + '\n')
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
    .map((s) => JSON.parse(s))
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

// 记账完全由后台数据决定：usage 直接来自宿主会话事件（assistant/message.data.usage），
// 不经过作答 agent，也不要求模型自报。inputTokens 是未命中，cacheReadTokens 是命中。
function tokensOf(usage) {
  if (!usage) return null
  const input = Number(usage.inputTokens || 0)
  const cacheHit = Number(usage.cacheReadTokens || 0)
  const cacheWrite = Number(usage.cacheWriteTokens || 0)
  const output = Number(usage.outputTokens || 0)
  const total = Number(usage.totalTokens || (input + cacheHit + cacheWrite + output))
  const prompt = input + cacheHit + cacheWrite
  return { input, cacheHit, cacheWrite, output, total, hitRate: prompt > 0 ? cacheHit / prompt : 0 }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// 与 grade.py 的 rubric_digest 同口径：json.dumps(obj, ensure_ascii=False, sort_keys=True)
// 默认分隔符是 ", " / ": "，键按 Unicode 码点排序。
function pyJson(value) {
  if (Array.isArray(value)) return '[' + value.map(pyJson).join(', ') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ': ' + pyJson(value[key])).join(', ') + '}'
  }
  return JSON.stringify(value)
}

function rubricDigest(rubric) {
  return sha256(pyJson(rubric))
}

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const has = (name) => args.includes(`--${name}`)

function rpcId() { return crypto.randomUUID() }
function cookie() { return fs.readFileSync(COOKIE_FILE, 'utf8').trim() }

async function callRoute(routePath, method, payload, { timeoutMs = 60_000 } = {}) {
  const res = await fetch(`${BASE}${routePath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie() },
    body: JSON.stringify({ type: 'client-request', rpcId: rpcId(), method, payload: { args: payload } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch {}
  if (res.status !== 200 || !body?.result) throw new Error(`gateway ${routePath} -> ${res.status}: ${text.slice(0, 200)}`)
  return body.result
}

/** 插件 RPC（/dsh-memu-memory/<endpoint>）：用于显式绑定记忆库、整理与清理。 */
async function pluginRpc(endpoint, payload, { timeoutMs = 60_000 } = {}) {
  const res = await fetch(`${BASE}/dsh-memu-memory/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie() },
    body: JSON.stringify({ type: 'client-request', rpcId: rpcId(), method: endpoint, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch {}
  if (!body?.result) throw new Error(`plugin ${endpoint} -> ${res.status}: ${text.slice(0, 200)}`)
  return body.result
}

/** 宿主/插件结果可能包一层 value；统一拆开，调用方只看业务字段。 */
function unwrap(result) {
  return result && result.value !== undefined ? result.value : result
}

/** 读冻结历史并按逻辑时间取该题可见前缀（read_exam.py 同口径）。 */
function loadPrefix(record) {
  const rows = fs.readFileSync(path.join(DATASET, record.history_file), 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean).map((s) => JSON.parse(s))
  const now = Date.parse(record.now)
  return rows.filter((r) => Date.parse(r['逻辑时间']) <= now)
}

/**
 * 每个 cutoff 的场景时间 = 该轮历史的逻辑时间。
 * 1.2.8 起插件把相对日期（明天/下周X/月底）按 sceneTime 落绝对日期；
 * 种子会话必须跟着 checkpoint 走，不能停在第一次绑定时的时刻，更不能落到真实时钟。
 */
function sceneTimeMap(historyFile) {
  const rows = fs.readFileSync(path.join(DATASET, historyFile), 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean).map((s) => JSON.parse(s))
  return new Map(rows.map((row) => [Number(row['轮次']), row['逻辑时间']]))
}

/** 最近六轮内联转录（E2 形态）。 */
function recentBlock(prefix, six = 6) {
  const tail = prefix.slice(-six)
  return tail.map((r) => `轮${r['轮次']}（${r['逻辑时间']}）\n用户：${r['用户消息']}\n助手：${r['助手回复']}`).join('\n\n')
}

/**
 * 作答提示：两种普通记忆备忘录。
 * memo  = 事无巨细，按事实/时间/说话人/承诺/冲突分节写全；
 * brief = 简明备忘录，只填关键项，不复述整段记忆（默认）。
 * 两种都不含评测口径、分值暗示或 rubric 覆盖数量。
 */
function examPrompt(record, prefix, mode = 'brief') {
  const context = [
    '下面是这段对话最近几轮的原文，方便你回忆上下文。',
    '系统可能另外给你一些长期记忆片段；其中的时间、说话人/来源、版本或到期提醒是记忆标记，不是新的用户发言，按标记理解即可。',
    '',
    '===== 最近对话记录开始 =====',
    recentBlock(prefix),
    '===== 最近对话记录结束 =====',
    '',
    `【当前时间】${record.now}`,
    `【我的问题】${record.question}`,
  ]
  if (mode === 'memo') {
    return [...context, '',
      '请根据你记得的内容，写一份事无巨细的记忆备忘录来回答。不要只回一句话，把与问题相关的记忆都写出来，方便我逐项核对。',
      '可以按下面的方式组织，不要求固定格式：',
      '- 结论：先用一两句话直接回答。',
      '- 事实明细：人物、物品、地点、事件、偏好、称呼、关系等，逐条写，每条一行。',
      '- 时间：每条事实的绝对日期或相对时间，并注明是发生、说到、生效还是失效；能分清公历/农历就写清。',
      '- 原话与说话人：谁说的（我 / 你 / 第三方），尽量保留原话关键词。',
      '- 约定与欠账：对谁、做什么、什么时候到期、是否完成。',
      '- 变化与冲突：同一件事有几种说法、各自时间和说话人；确认不了就写“无法确认”。',
      '- 边界：哪些能主动说、哪些只在被问时说、哪些不能说。',
      '- 不确定：记忆里没有或记不清的，直接写“不知道”，不要猜。',
      '',
      '只写记忆里有依据的内容，不要编日期、不要补没发生过的细节，也不要扯与问题无关的旧事。这次只是问我，不要改动或新增记忆。',
    ].join('\n')
  }
  return [...context, '',
    '请根据你记得的内容，写一份简明备忘录来回答。只填关键信息，简要但精准，不要复述整段记忆，也不要写成行为日志。',
    '要求：人物、地点、时间、事情都要写具体；时间优先写绝对日期；记不清的项填“不知道”，不要猜；只写记忆里有依据的内容。',
    '结论：____',
    '人物：____',
    '地点：____',
    '时间：____',
    '事情：____',
    '原话/说话人：____',
    '不确定：____',
    '这次只是问我，不要改动或新增记忆。',
  ].join('\n')
}

/** 等待 turn/end（completed）。 */
async function waitTurnEnd(sessionId, { timeoutMs = 300_000 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const result = await callRoute('/api/session/events', 'session/events', { request: { address: { kind: 'session', sessionId } } }, { timeoutMs: 20_000 })
      const page = unwrap(result) || {}
      // 0.2.2-rc.1 wire: value.records = [{ type:'event', event:{ type, seq, data } }]
      const records = page.records || page.events || page.items || []
      const events = records.map((e) => e?.event || e)
      const ends = events.filter((e) => e?.type === 'turn/end')
      if (ends.length) {
        const last = ends[ends.length - 1]
        return {
          kind: last.data?.reason?.kind || 'unknown',
          reason: last.data?.reason || null,
        }
      }
    } catch {}
  }
  return { kind: 'timeout' }
}

/** 读取会话日志的全部事件行（v4 多帧 zstd 逐帧解压）。 */
function readSessionRows(sessionId, workspace = DEFAULT_WORKSPACE) {
  const key = '--' + workspace.replace(/[^A-Za-z0-9.]+/g, '-') + '--'
  const file = path.join(HOME, 'sessions', key, sessionId, 'session.v4.jsonl.zstd')
  if (!fs.existsSync(file)) return []
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
  const offs = []
  let idx = 0
  while (true) {
    const i = buf.indexOf(magic, idx)
    if (i < 0) break
    offs.push(i)
    idx = i + 4
  }
  const text = offs.map((off, n) =>
    zlib.zstdDecompressSync(buf.subarray(off, n + 1 < offs.length ? offs[n + 1] : buf.length)).toString('utf8')
  ).join('')
  return text.split('\n').filter(Boolean).map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
}

/** 会话最后一个事件的 seq：用来判断整理是否已经推进到转录末尾，避免多余的收尾 fork。 */
function lastSessionSeq(sessionId, workspace) {
  const rows = readSessionRows(sessionId, workspace)
  let max = -1
  for (const row of rows) if (typeof row.seq === 'number' && row.seq > max) max = row.seq
  return max
}

/** 从持久会话日志抽取最后一条 assistant/message 文本。 */
function readLastAssistant(sessionId, workspace = DEFAULT_WORKSPACE) {
  const rows = readSessionRows(sessionId, workspace)
  for (let i = rows.length - 1; i >= 0; i--) {
    const o = rows[i]
    if (o.type === 'assistant/message') {
      const blocks = o.data?.message?.content || []
      const t = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
      return { text: t, seq: o.seq, usage: o.data?.usage || null }
    }
  }
  return null
}

/** 简单工作池：按并发跑 fn，输出顺序与输入一致。 */
async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 把本库所有 pending_review（矛盾/待复核）条目接受为 active，并保留冲突双方。
 * 评测口径：矛盾也是记忆，不在整理阶段替模型裁决；考试时把两种说法都召回，
 * 由作答模型自己判断该信哪一条。resolution=coexist 不会把旧条目 supersede 掉。
 */
async function acceptContradictions(libraryId, tag) {
  if (!libraryId) return 0
  let items = []
  try {
    const list = unwrap(await pluginRpc('listReviews', { libraryId }, { timeoutMs: 30_000 }))
    items = Array.isArray(list?.items) ? list.items : []
  } catch (error) {
    console.warn(`  ${tag} listReviews failed: ${String(error?.message || error).slice(0, 160)}`)
    return 0
  }
  let accepted = 0
  for (const item of items) {
    if (!item || typeof item.id !== 'string') continue
    try {
      await pluginRpc('resolveReview', {
        libraryId,
        id: item.id,
        action: 'accept',
        resolution: 'coexist',
        reason: 'bench: keep contradictory memories visible; let the exam model decide',
      }, { timeoutMs: 60_000 })
      accepted += 1
    } catch (error) {
      console.warn(`  ${tag} accept review ${item.id} failed: ${String(error?.message || error).slice(0, 160)}`)
    }
  }
  if (accepted) console.log(`prepare contradictions ${tag} accepted=${accepted} (coexist)`)
  return accepted
}

async function listMemoryIds(sessionId) {
  const list = await pluginRpc('listPrivate', { sessionId, limit: 500 }, { timeoutMs: 30_000 })
  return new Set(((unwrap(list) || {}).files || []).map((f) => f && f.id).filter(Boolean))
}

/** 逐题清理考试回合自己写进去的条目（回滚到该 checkpoint 整理后的基线）。 */
async function cleanupExamWrites(sessionId, libraryId, baselineIds) {
  if (!baselineIds || !sessionId || !libraryId) return 0
  try {
    const current = await listMemoryIds(sessionId)
    const added = [...current].filter((id) => !baselineIds.has(id))
    for (const id of added) {
      await pluginRpc('archiveMemory', { libraryId, id }, { timeoutMs: 30_000 })
      await pluginRpc('deleteMemory', { libraryId, id }, { timeoutMs: 30_000 })
    }
    if (added.length) console.log(`  cleaned ${added.length} exam-written memories: ${added.join(',')}`)
    return added.length
  } catch (error) {
    console.warn(`  cleanup exam-written memories failed: ${String(error?.message || error).slice(0, 160)}`)
    return 0
  }
}

/**
 * 单题作答。workspace/libraryId 由调用方给出（重建记忆时是 checkpoint 目录），
 * 未给时退回共享 workspace 库（--no-prepare 的旧路径）。
 */
async function runOne(record, { workspace, libraryId, maxAttempts, promptMode = 'brief' }) {
  const prefix = loadPrefix(record)
  const promptText = examPrompt(record, prefix, promptMode)
  console.log('exam', record.id, 'cutoff_turn', record.cutoff_turn)
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const created = await callRoute('/api/session/create', 'session/create', { request: { cwd: workspace } })
    const sessionId = unwrap(created)?.sessionId
    if (!sessionId) throw new Error('no sessionId from create')
    // 显式绑定记忆库：重建路径直接绑 checkpoint 库；旧路径按 cwd 复用/创建。
    const initPayload = { sessionId, cwd: workspace, createLibrary: true }
    if (libraryId) {
      initPayload.libraryId = libraryId
      initPayload.createLibrary = false
    }
    const init = unwrap(await pluginRpc('initSession', initPayload))
    const boundId = init?.binding?.libraryId || libraryId || null
    if (!boundId) throw new Error('no memory library bound for exam session')
    // 场景时间 = 该题的逻辑时间，让注入端 freshness 按题目时间算；失败不阻断作答
    try {
      await pluginRpc('setMemoryContext', { sessionId, context: null, sceneTime: record.now })
    } catch (error) {
      console.warn(`  setMemoryContext skipped for ${record.id}: ${String(error?.message || error).slice(0, 120)}`)
    }
    logApi({ purpose: 'exam-session-create', qid: record.id, attempt, sessionId, libraryId: boundId })
    try {
      await callRoute('/api/session/prompt', 'session/prompt', {
        request: {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: promptText }],
          clientTimeZone: 'Asia/Shanghai',
        },
      })
      logApi({
        purpose: 'exam-prompt', qid: record.id, attempt, sessionId,
        promptTokensEst: Math.ceil(promptText.length * 0.6), model: 'deepseek-v4.1-flash',
      })
      const end = await waitTurnEnd(sessionId)
      // provider/模型配置错误不会靠重试自愈：直接把错误信息抛出去，避免 45s/90s 空等
      const fatalCode = end.reason && end.reason.error && end.reason.error.code
      if (end.kind === 'error' && fatalCode === 'UNSUPPORTED_REASONING_EFFORT') {
        const msg = `provider config error (${fatalCode}): ${end.reason.error.message || ''}`
        logApi({ purpose: 'exam-turn-failed', qid: record.id, attempt, turnEnd: end.kind, error: msg.slice(0, 300) })
        throw Object.assign(new Error(msg), { fatal: true })
      }
      const answer = readLastAssistant(sessionId, workspace)
      if (end.kind === 'completed' && answer?.text?.trim()) {
        if (answer.usage) logApi({ purpose: 'exam-usage', qid: record.id, usage: answer.usage })
        const tokens = tokensOf(answer.usage)
        console.log(' ->', record.id, 'completed answer chars:', answer.text.length, 'tokens:', tokens?.total ?? 'n/a')
        return {
          id: record.id,
          answer: answer.text,
          sessionId,
          libraryId: boundId,
          attempt,
          turnEnd: end.kind,
          usage: answer.usage || null,
          tokens,
        }
      }
      logApi({
        purpose: 'exam-turn-failed', qid: record.id, attempt, turnEnd: end.kind,
        error: end.reason?.error?.message || null,
      })
      console.warn(`  turn failed (${end.kind}) for ${record.id}: ${end.reason?.error?.message || '-'}`)
    } catch (error) {
      if (error && error.fatal) throw error   // 配置错误：不重试，直接让整轮失败
      logApi({ purpose: 'exam-error', qid: record.id, attempt, error: String(error?.message || error).slice(0, 300) })
    }
    if (attempt < maxAttempts) {
      const wait = 45_000 * attempt
      console.log(`  ${record.id} attempt ${attempt} failed, backoff ${wait / 1000}s`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  console.log(' ->', record.id, 'failed answer chars:', 0, 'tokens:', 'n/a')
  return { id: record.id, answer: '', sessionId: null, libraryId, attempt: maxAttempts, turnEnd: 'failed', interrupted: true }
}

// ---------------------------------------------------------------------------
// 记忆重建：persona 种子会话 + 每个 cutoff 整理一次
// ---------------------------------------------------------------------------

const CONSOLIDATION_SKIP_DONE = new Set([
  'no-new-events', 'already-consolidated', 'empty-window', 'empty-seed',
])

function seedTurns({ historyFile, from, to, sessionId, workspace, append }) {
  const argv = [
    path.join(HERE, 'seed-session.mjs'),
    '--history', historyFile,
    '--from', String(from),
    '--to', String(to),
    '--session', sessionId,
    '--workspace', workspace,
  ]
  if (append) argv.push('--append')
  try {
    execFileSync(process.execPath, argv, { cwd: ROOT, stdio: 'pipe' })
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).slice(0, 400)
    throw new Error(`seed-session failed (turns ${from}..${to}): ${detail}`)
  }
}

/** 把该会话所有尚未整理的增量都推进到库：一次 generatePrivate 只吃一窗（约 300 事件）。 */
async function consolidateAll(seedSid, tag, workspace) {
  const targetSeq = lastSessionSeq(seedSid, workspace)
  let passes = 0
  let retries = 0
  for (let i = 1; i <= 60; i++) {
    let result
    try {
      result = unwrap(await pluginRpc('generatePrivate', { sessionId: seedSid, force: true }, { timeoutMs: 15 * 60_000 }))
    } catch (error) {
      console.warn(`  ${tag} consolidate error: ${String(error?.message || error).slice(0, 200)}`)
      return { ok: false, passes, error: String(error?.message || error).slice(0, 200) }
    }
    passes = i
    const created = result?.createdIds?.length ?? result?.count ?? null
    const through = result?.snapshot?.throughSeq ?? null
    console.log(`prepare consolidate ${tag} pass=${i} ok=${result?.ok} settled=${result?.settled ?? '-'} skipped=${result?.skipped || '-'} created=${created ?? '-'} through=${through ?? '-'}/${targetSeq}`)
    if (!result?.ok) {
      if (result?.running) { await new Promise((r) => setTimeout(r, 5000)); continue }
      // 回执类失败（receipt-invalid / receipt-unverified）是插件标记 retryable 的：
      // 失败一次就让游标卡住，后续 checkpoint 会在更大的窗口上重复失败。
      // 同一 checkpoint 最多补跑 2 次，成功一次就能把游标推过去。
      if (result?.retryable === true && retries < 2) {
        retries += 1
        console.log(`  ${tag} consolidate retry ${retries}/2 after ${result?.reasonCode || 'error'}`)
        await new Promise((r) => setTimeout(r, 10_000))
        continue
      }
      return { ok: false, passes, error: result?.error || result?.reasonCode || 'consolidate failed' }
    }
    if (result?.timedOut) return { ok: false, passes, error: 'timed out' }
    // 同一快照撞到失败上限：这不是「整理完成」，而是这一窗没被收编。若当成 done，
    // 后面的窗口根本不会开始，覆盖率会被静默截断在游标处。
    if (result?.skipped === 'snapshot-failed') {
      console.warn(`  ${tag} consolidate blocked: snapshot failed twice at ${through}/${targetSeq}`)
      return { ok: false, passes, error: 'snapshot-failed' }
    }
    if (result?.skipped && CONSOLIDATION_SKIP_DONE.has(result.skipped)) return { ok: true, passes }
    // 已推进到转录末尾就停：别再为了确认「没有新事件」多 fork 一次整窗（每次 30–60s）。
    if (through !== null && targetSeq >= 0 && through >= targetSeq) return { ok: true, passes }
    // settled=true 但还有剩余窗口：继续循环
  }
  console.warn(`  ${tag} consolidate stopped after 60 passes`)
  return { ok: true, passes }
}

function readJsonFile(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 处理一个 persona：按 cutoff 升序 追加种子 → 整理 → 考该 cutoff 的题 → 清理考试写入。
 * 状态按 persona 落盘（run-state-<label>-<persona>.json），崩溃后可用 --resume 接着跑：
 * 已完成的 cutoff 跳过，未完成的 checkpoint 重新整理（通常已无新事件）并补考剩余题。
 * 返回 qid -> row 的 Map。
 */
async function runPersonaStream(persona, records, { label, concurrency, maxAttempts, promptMode, progress, existingRows, resume, onRow, answerIds = null }) {
  const ckRoot = path.join(ROOT, 'workspace', 'checkpoints', label, persona)
  fs.mkdirSync(ckRoot, { recursive: true })
  const statePath = path.join(ROOT, 'results', `run-state-${label}-${persona}.json`)
  const saved = resume ? readJsonFile(statePath) : null
  const seedSid = saved?.seedSid || ('session-' + crypto.randomUUID())
  let libraryId = saved?.libraryId || null
  let seededTo = Number(saved?.seededTo) || 0
  const doneCutoffs = new Set(Array.isArray(saved?.doneCutoffs) ? saved.doneCutoffs : [])
  const groups = new Map()
  for (const record of records) {
    if (!groups.has(record.cutoff_turn)) groups.set(record.cutoff_turn, [])
    groups.get(record.cutoff_turn).push(record)
  }
  const cutoffs = [...groups.keys()].sort((a, b) => a - b)
  const historyFile = path.join(DATASET, records[0].history_file)
  const sceneTimes = sceneTimeMap(records[0].history_file)
  const rows = new Map()
  const saveState = () => writeJsonAtomic(statePath, {
    label, persona, seedSid, libraryId, ckRoot, seededTo, doneCutoffs: [...doneCutoffs],
  })
  saveState()
  if (progress) progress.done += doneCutoffs.size
  for (const cutoff of cutoffs) {
    if (doneCutoffs.has(cutoff)) continue
    const tag = `${persona} ck${cutoff}`
    if (progress) progress.done += 1
    const done = progress ? progress.done : cutoffs.indexOf(cutoff) + 1
    const total = progress ? progress.total : cutoffs.length
    console.log(`prepare checkpoint ${done}/${total} ${persona} ck${cutoff} turns=${seededTo + 1}..${cutoff}`)
    if (cutoff > seededTo) {
      seedTurns({
        historyFile, from: seededTo + 1, to: cutoff, sessionId: seedSid, workspace: ckRoot, append: seededTo > 0,
      })
      seededTo = cutoff
      saveState()
    }
    if (!libraryId) {
      const init = unwrap(await pluginRpc('initSession', { sessionId: seedSid, cwd: ckRoot, createLibrary: true }))
      libraryId = init?.binding?.libraryId || null
      if (!libraryId) throw new Error(`no library created for checkpoint ${tag}`)
      console.log(`  memory library ${libraryId} · ${tag}`)
      saveState()
    }
    // 1.2.8：整理与写入都按该 checkpoint 的逻辑时间解析相对日期（不能落系统时钟）。
    const sceneTime = sceneTimes.get(Number(cutoff)) || groups.get(cutoff)[0]?.now || null
    if (sceneTime) {
      try {
        await pluginRpc('setMemoryContext', { sessionId: seedSid, context: null, sceneTime })
      } catch (error) {
        console.warn(`  ${tag} seed sceneTime skipped: ${String(error?.message || error).slice(0, 120)}`)
      }
    }
    const cons = await consolidateAll(seedSid, tag, ckRoot)
    if (!cons.ok) console.warn(`  ${tag} consolidation incomplete: ${cons.error}`)
    // 矛盾条目也当记忆用：接受为 active 且 coexist，双方都保留，考试时由作答模型抉择
    await acceptContradictions(libraryId, tag)
    const baseline = await listMemoryIds(seedSid)
    console.log(`prepare ready ${tag} memories=${baseline.size}`)
    // 该 cutoff 的题并行；workspace 用 checkpoint 目录，保证会话日志与库绑定同一 scope。
    // 崩溃恢复时只补跑没有完整答案的题，已完成的题不重复作答。
    const remaining = groups.get(cutoff).filter((record) => !answerIds || answerIds.has(record.id)).filter((record) => {
      const prior = existingRows.get(record.id)
      return !prior || !(typeof prior.answer === 'string' && prior.answer.trim() && prior.turnEnd === 'completed')
    })
    if (remaining.length) {
      const groupRows = await pool(remaining, concurrency, (record) => runOne(record, {
        workspace: ckRoot, libraryId, maxAttempts, promptMode,
      }))
      for (const row of groupRows) {
        rows.set(row.id, row)
        if (onRow) onRow(row)
      }
    }
    await cleanupExamWrites(seedSid, libraryId, baseline)
    doneCutoffs.add(cutoff)
    saveState()
  }
  console.log(`prepare persona done persona=${persona} checkpoints=${cutoffs.length} questions=${answerIds ? records.filter((record) => answerIds.has(record.id)).length : records.length} resumed=${doneCutoffs.size}`)
  return { rows, libraryId, ckRoot }
}

async function main() {
  const runStartedAt = new Date().toISOString()
  const argsIds = (flag('ids') || '').split(',').map((s) => s.trim()).filter(Boolean)
  const idsFile = flag('ids-file')
  let ids = argsIds
  if (!ids.length && idsFile) {
    ids = fs.readFileSync(path.resolve(ROOT, idsFile), 'utf8')
      .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  }
  const out = path.resolve(ROOT, flag('out', 'results/answers-sample.jsonl'))
  const packetOut = path.resolve(ROOT, flag('packets', 'results/exam-packets.jsonl'))
  const judgeOut = path.resolve(ROOT, flag('judge', 'results/exam-judge-prompt.md'))
  const maxAttempts = Number(flag('max-attempts', '3'))
  const concurrency = clamp(Number(flag('concurrency', '4')) || 1, 1, 8)
  const personaConcurrency = clamp(Number(flag('persona-concurrency', '2')) || 1, 1, 6)
  const resume = has('resume')
  const promptMode = flag('prompt-mode', 'brief')
  if (!['memo', 'brief'].includes(promptMode)) { console.error('prompt-mode must be memo or brief'); process.exit(2) }
  const label = flag('label', path.basename(out, '.jsonl').replace(/^answers-/, ''))
  const prepareEnabled = !has('no-prepare')
  if (!ids.length) { console.error('usage: --ids id1,id2,... | --ids-file <file> --out file'); process.exit(2) }
  const records = readJsonl(path.join(DATASET, 'exam-inputs.jsonl'))
  const index = new Map(records.map((r) => [r.id, r]))
  const keyIndex = new Map(readJsonl(ANSWER_KEY).map((r) => [r.id, r]))
  const evidenceIndex = new Map(readJsonl(EVIDENCE).map((r) => [r.id, r]))
  const selected = []
  for (const id of ids) {
    const record = index.get(id)
    if (!record) { console.error('unknown id:', id); process.exit(2) }
    selected.push(record)
  }
  console.log(`exam plan ids=${selected.length} concurrency=${concurrency} persona-parallel=${personaConcurrency} prepare=${prepareEnabled ? 'on' : 'off'} resume=${resume ? 'on' : 'off'} prompt=${promptMode} label=${label}`)

  // 逐题作答即时追加到 out：崩溃后 --resume 会读回这些行，跳过已完成的题。
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const existingRows = new Map()
  if (resume && fs.existsSync(out)) {
    for (const row of readJsonl(out)) if (row && typeof row.id === 'string') existingRows.set(row.id, row)
    console.log(`resume: ${existingRows.size} existing answers in ${path.basename(out)}`)
  } else {
    fs.writeFileSync(out, '', 'utf8')
  }
  const rowsById = new Map(existingRows)
  const onRow = (row) => {
    rowsById.set(row.id, row)
    fs.appendFileSync(out, JSON.stringify({
      id: row.id, answer: row.answer, usage: row.usage || null, tokens: row.tokens || null, sessionId: row.sessionId || null,
    }) + '\n')
  }
  const ckRoots = []
  if (prepareEnabled) {
    // persona 流彼此独立（各自的种子会话与库）；同一 persona 内仍按 cutoff 升序串行以免记忆泄漏。
    // persona 并行数单独封顶（默认 2）：6 条流同时 fork 实测会把宿主压到原生崩溃。
    const byPersona = new Map()
    for (const record of selected) {
      if (!byPersona.has(record.persona)) byPersona.set(record.persona, [])
      byPersona.get(record.persona).push(record)
    }
    // --all-checkpoints：为每个 persona 补齐到“最后一题的 cutoff”之间的所有 checkpoint，
    // 只整理不答题；这样记忆库按完整 checkpoint 序列推进，不会因为抽样跳点而少写记忆。
    const allCheckpoints = has('all-checkpoints')
    const allByPersona = new Map()
    if (allCheckpoints) {
      for (const record of records) {
        if (!allByPersona.has(record.persona)) allByPersona.set(record.persona, [])
        allByPersona.get(record.persona).push(record)
      }
    }
    const entries = [...byPersona.entries()].map(([persona, groupRecords]) => {
      const answerIds = new Set(groupRecords.map((record) => record.id))
      let consolidationRecords = groupRecords
      if (allCheckpoints) {
        const maxCutoff = Math.max(...groupRecords.map((record) => record.cutoff_turn))
        consolidationRecords = (allByPersona.get(persona) || []).filter((record) => record.cutoff_turn <= maxCutoff)
      }
      consolidationRecords.sort((a, b) => a.cutoff_turn - b.cutoff_turn)
      return [persona, consolidationRecords, answerIds]
    });
    const personaWidth = Math.max(1, Math.min(entries.length, personaConcurrency, concurrency));
    // 总并发守恒：多个 persona 流并行时，每条流内同时考的题数相应降低
    const subConcurrency = Math.max(1, Math.floor(concurrency / personaWidth));
    // 全局 checkpoint 进度：多个 persona 流并行时，前端只认这一组单调递增的数字。
    const checkpointTotal = entries.reduce(
      (sum, [, recs]) => sum + new Set(recs.map((r) => r.cutoff_turn)).size, 0);
    const progress = { done: 0, total: checkpointTotal };
    console.log(`prepare start personas=${entries.length} checkpoints=${checkpointTotal} questions=${selected.length} parallel=${personaWidth} exam-concurrency=${subConcurrency}`);
    const results = await pool(entries, personaWidth, ([persona, groupRecords, answerIds]) =>
      runPersonaStream(persona, groupRecords, {
        label, concurrency: subConcurrency, maxAttempts, promptMode, progress, existingRows, resume, onRow, answerIds,
      }));
    for (const res of results) {
      ckRoots.push(res.ckRoot)
      for (const [id, row] of res.rows) rowsById.set(id, row)
    }
    console.log(`prepare done personas=${entries.length} checkpoints=${checkpointTotal} questions=${selected.length}`);
  } else {
    // 旧路径：共享 workspace 库，题目并行；基线在首个会话绑定后记录。
    const workspace = DEFAULT_WORKSPACE
    let baseline = null
    const remaining = selected.filter((record) => {
      const prior = existingRows.get(record.id)
      return !prior || !(typeof prior.answer === 'string' && prior.answer.trim() && prior.turnEnd === 'completed')
    })
    const results = await pool(remaining, concurrency, async (record) => {
      const row = await runOne(record, { workspace, libraryId: null, maxAttempts, promptMode })
      if (!row.sessionId) return row
      if (baseline === null) {
        try { baseline = await listMemoryIds(row.sessionId) } catch { baseline = null }
      }
      await cleanupExamWrites(row.sessionId, row.libraryId, baseline)
      return row
    })
    for (const row of results) onRow(row)
  }

  const rows = []
  const packets = []
  for (const id of ids) {
    const row = rowsById.get(id) || { id, answer: '', sessionId: null, attempt: maxAttempts, turnEnd: 'failed', interrupted: true, tokens: null, usage: null }
    const record = index.get(id)
    rows.push({ id, answer: row.answer, usage: row.usage || null, tokens: row.tokens || null, sessionId: row.sessionId })
    // 判据包：题目 + 作答 + rubric/facts/sources + token 用量，外部模型可直接拿去判。
    const rubric = keyIndex.get(id)?.rubric ?? null
    packets.push({
      id,
      question: record.question,
      now: record.now,
      answer: row.answer,
      turnEnd: row.turnEnd,
      sessionId: row.sessionId,
      rubric,
      facts: evidenceIndex.get(id)?.facts ?? null,
      sources: evidenceIndex.get(id)?.sources ?? null,
      usage: row.usage || null,
      tokens: row.tokens || null,
      answer_sha256: sha256(row.answer || ''),
      rubric_sha256: rubric ? rubricDigest(rubric) : null,
    })
    // 后台记账：一行一题，token 直接来自会话 usage，不经过 agent。
    appendJsonl(EXAM_LOG, {
      ts: new Date().toISOString(),
      event: 'exam-question',
      qid: id,
      sessionId: row.sessionId,
      turnEnd: row.turnEnd,
      answerChars: (row.answer || '').length,
      tokens: row.tokens || null,
    })
  }

  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  fs.writeFileSync(packetOut, packets.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  console.log('written:', out)
  console.log('packets:', packetOut)

  // 复制即用的外部判分文件：提示词模板 + 本次判分包（JSON 数组）一次成文。
  const template = fs.existsSync(JUDGE_TEMPLATE) ? fs.readFileSync(JUDGE_TEMPLATE, 'utf8') : '# 判分指令\n\n'
  fs.writeFileSync(judgeOut, template.replace(/\s*$/, '') + '\n\n```json\n' + JSON.stringify(packets, null, 1) + '\n```\n', 'utf8')
  console.log('judge prompt:', judgeOut)

  // 后台汇总：本次考试全部宿主调用的 token（会话 usage），写入 token-report/ledger。
  try {
    const tokenArgv = [path.join(HERE, 'token-report.mjs'), '--since', runStartedAt, '--out', path.join(ROOT, 'results', 'token-report.json')]
    // 重建记忆时会话在 checkpoint 目录下，必须把各 persona 的 scope 一并传给统计器
    if (ckRoots.length) tokenArgv.push('--workspaces', ckRoots.join(';'))
    execFileSync(process.execPath, tokenArgv, { stdio: 'inherit' })
    const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', 'token-report.json'), 'utf8'))
    appendJsonl(EXAM_LOG, { ts: new Date().toISOString(), event: 'exam-run', qids: ids, totals: report.totals, byPurpose: report.byPurpose })
  } catch (error) {
    console.error('token report failed:', String(error?.message || error).slice(0, 200))
  }
}

main().catch((e) => { console.error('exam-run crashed:', e); process.exit(1) })
