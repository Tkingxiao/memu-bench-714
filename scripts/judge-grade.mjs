#!/usr/bin/env node
/**
 * memu-bench-714 — 判分执行（M5）。
 *
 * 流程（grading/grade.py 口径）：
 *  1. grade.py prepare：answers.jsonl → packets.jsonl（含 rubric/facts/sources）
 *  2. 本脚本按 grading/judge-prompt.md 调 GLM-5.3-Flash（8899 /v1/messages）逐题判，
 *     输出 reviews.jsonl（字段校验同 grade.py score 的要求）
 *  3. grade.py score → scored.jsonl + summary.json
 *
 * 判分批处理：默认一次 32 题（--batch 可调，1..100）；批越大请求越少、越快，
 * 但要给输出留够 max_tokens（--max-tokens，默认 32000）。
 * 重试：每批最多 3 次，指数退避 45s/90s/180s；失败写明批次，不静默吞错。
 *
 * 用法：
 *   node judge-grade.mjs --answers results/answers-sample.jsonl \
 *     --stage results/packets-sample.jsonl --reviews results/reviews-sample.jsonl \
 *     [--batch 32] [--max-tokens 32000] [--keep]
 *
 * 收尾：判分成功后默认调用 bench-reset.mjs——先写 logs/reset-log.jsonl 审计，
 * 再清空本次 bench 的会话与记忆库，让下一题从空库开始；--keep 跳过清理（留档调试用）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LOGS = path.join(ROOT, 'logs')
const BENCH = ROOT
const API_LOG = path.join(LOGS, 'api-log.jsonl')
const BASE = process.env.PROBE_BASE || 'https://router.dys.asia/v1'
const MODEL = process.env.PROBE_MODEL || 'deepseek-v4.1-flash'
// 判分是结构化输出任务，不需要推理过程。deepseek-v4.1-flash 默认会把 max_tokens 全花在
// reasoning_content 上（实测 8000 全部耗尽、content 为空），显式关闭思考后同一请求正常返回。
// 需要保留模型默认行为时设 PROBE_REASONING=default。
const REASONING = process.env.PROBE_REASONING || 'none'
// key 只从环境或 bench profile 里读；不写进仓库、不写进日志。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), 'AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.2.2-rc.1')
const PROFILE_YML = path.join(DSH_HOME, 'profiles/memubench/cordis.patch.yml')
function profileKey() {
  try {
    const m = fs.readFileSync(PROFILE_YML, 'utf8').match(/authorization:\s*Bearer\s+(\S+)/)
    return m ? m[1] : ''
  } catch { return '' }
}
const KEY = process.env.PROBE_KEY || profileKey()

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
// 批越大，单次回复的 JSON 越长；默认 32000 token 输出上限，可用 --max-tokens 覆盖。
const MAX_TOKENS = Number(flag('max-tokens', process.env.PROBE_MAX_TOKENS || '32000')) || 32000
// 批大小硬限 1..100：太小浪费请求，太大容易撞输出上限或 JSON 截断。
function clampBatch(n) {
  if (!Number.isFinite(n)) return 32
  return Math.max(1, Math.min(100, Math.floor(n)))
}
function logApi(entry) {
  fs.appendFileSync(API_LOG, JSON.stringify({ ts: new Date().toISOString(), purpose: 'judge', model: MODEL, ...entry }) + '\n')
}

const JUDGE_HEADER = fs.readFileSync(path.join(BENCH, 'grading', 'judge-prompt.md'), 'utf8')

function readRows(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).map((s) => JSON.parse(s))
}

/**
 * 判分模型偶尔把列表字段写成单个字符串或 null（`"违反禁止": "..."`、缺字段）。
 * grade.py 要求「非空字符串数组」，这里先归一化，避免一次格式抖动让整批判分崩溃。
 */
function sanitizeReview(r) {
  const out = { ...r }
  for (const key of ['违反禁止', '未知当事实', '无关旧事']) {
    const v = out[key]
    if (Array.isArray(v)) out[key] = v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    else if (typeof v === 'string' && v.trim()) out[key] = [v.trim()]
    else out[key] = []
  }
  for (const key of ['错认', '错否', '越界', '编造日期', '不当私事披露']) {
    out[key] = out[key] === true || out[key] === 'true'
  }
  if (Array.isArray(out.required)) out.required = out.required.map((v) => v === true || v === 'true')
  return out
}

function packetView(p) {
  return {
    id: p.id,
    question: p.question,
    now: p.now,
    rubric: p.rubric,
    facts: p.facts,
    sources: p.sources,
    answer: p.answer,
    answer_sha256: p.answer_sha256,
    rubric_sha256: p.rubric_sha256,
  }
}

async function judgeBatch(packets) {
  const body = packets.map(packetView)
  const prompt = [
    JUDGE_HEADER,
    '',
    '以下是需要判分的题目材料（JSON 数组，每题一个对象）：',
    JSON.stringify(body, null, 1),
    '',
    '要求：对每题输出一行 JSON（与指令中的字段一致），全部行合并成一个 JSON 数组返回，不要输出其他文字。',
  ].join('\n')
  const payload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
    // 'default' = 不传该字段，保留 provider 默认（推理模型可能耗尽额度，不推荐）
    ...(REASONING && REASONING !== 'default' ? { reasoning_effort: REASONING } : {}),
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now()
    let meta = null
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(240_000),
      })
      const text = await res.text()
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      const data = JSON.parse(text)
      const choice = data.choices?.[0] || {}
      const message = choice.message || {}
      const usage = data.usage || {}
      const finishReason = choice.finish_reason || null
      const reasoningChars = typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0
      meta = {
        status: res.status,
        ms: Date.now() - started,
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
        cacheHit: usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? null,
        cacheMiss: usage.prompt_cache_miss_tokens ?? null,
        batch: packets.length,
        finishReason,
        reasoningChars,
      }
      const content = message.content || ''
      // 推理模型把额度烧在 reasoning_content 上时 content 为空：报出 finish_reason 与思考长度，
      // 不要只留一句空白的 "no JSON array"
      if (!content.trim()) {
        throw new Error(`judge reply empty (finish_reason=${finishReason}, reasoning_chars=${reasoningChars})`)
      }
      const start = content.indexOf('[')
      const end = content.lastIndexOf(']')
      if (start < 0 || end < 0) throw new Error('judge reply has no JSON array: ' + content.slice(0, 200))
      const reviews = JSON.parse(content.slice(start, end + 1))
      if (!Array.isArray(reviews)) throw new Error('judge reply is not an array')
      logApi({ outcome: 'success', attempt, ...meta, reviews: reviews.length })
      return reviews.map(sanitizeReview)
    } catch (error) {
      const msg = String(error?.message || error)
      logApi({ outcome: 'error', attempt, ...(meta || {}), error: msg.slice(0, 300) })
      // 空回复/无 JSON 是确定性失败：同一请求重试 3 次只会再烧三次额度；
      // 只对 HTTP/网络这类可能自愈的错误保留指数退避。
      const deterministic = msg.startsWith('judge reply empty')
        || msg.startsWith('judge reply has no JSON array')
        || msg.startsWith('judge reply is not an array')
      if (attempt === 3 || deterministic) throw error
      const wait = 45_000 * attempt
      console.log(`  judge batch failed (attempt ${attempt}), backoff ${wait / 1000}s:`, msg.slice(0, 120))
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

async function main() {
  const answers = path.resolve(ROOT, flag('answers'))
  const stage = path.resolve(ROOT, flag('stage', 'results/packets.jsonl'))
  const reviewsOut = path.resolve(ROOT, flag('reviews', 'results/reviews.jsonl'))
  const batch = clampBatch(Number(flag('batch', '32')))
  fs.mkdirSync(path.dirname(stage), { recursive: true })

  // 1) grade.py prepare
  execFileSync('python', ['-I', path.join(BENCH, 'grading', 'grade.py'), 'prepare', '--answers', answers, '--out', stage], { stdio: 'inherit' })
  const packets = readRows(stage)
  console.log('packets:', packets.length)

  // 2) judge（分批；缺失题按轮补判，unknown/duplicate 只告警不崩整批）
  const ids = new Set(packets.map((p) => p.id))
  const results = new Map()
  let pending = packets
  for (let round = 1; round <= 3 && pending.length; round++) {
    for (let i = 0; i < pending.length; i += batch) {
      const chunk = pending.slice(i, i + batch)
      console.log(`judge batch ${round}.${i / batch + 1}: ${chunk.length} questions`)
      const part = await judgeBatch(chunk)
      for (const r of part) {
        if (!ids.has(r.id)) { console.warn(`judge returned unknown id: ${r.id}; ignored`); continue }
        if (results.has(r.id)) { console.warn(`judge returned duplicate id: ${r.id}; ignored`); continue }
        results.set(r.id, r)
      }
    }
    pending = packets.filter((p) => !results.has(p.id))
    if (pending.length) console.warn(`judge missed ${pending.length} question(s), retrying: ${pending.map((p) => p.id).join(',')}`)
  }
  // 三轮仍缺失：补一条“未通过”的保守 review，避免整批无结果；日志里点名，便于人工复核。
  for (const packet of pending) {
    console.warn(`judge never returned ${packet.id}; recorded as not passed (manual review needed)`)
    results.set(packet.id, {
      id: packet.id,
      answer_sha256: packet.answer_sha256,
      rubric_sha256: packet.rubric_sha256,
      required: packet.rubric.required.map(() => false),
      错认: false, 错否: false, 越界: false, 编造日期: false, 不当私事披露: false,
      违反禁止: [], 未知当事实: [], 无关旧事: [],
      reason: '判分模型三轮均未返回该题；按未通过处理，需人工复核。',
    })
  }
  const reviews = [...results.values()]

  // 基本一致性检查
  for (const r of reviews) {
    const packet = packets.find((p) => p.id === r.id)
    if (r.answer_sha256 !== packet.answer_sha256 || r.rubric_sha256 !== packet.rubric_sha256) {
      // 判分模型偶尔回抄 hash 出错；评分按 id 对应题目包，hash 以题目包为准。
      console.warn(`hash mismatch for ${r.id}, using packet hashes`)
      r.answer_sha256 = packet.answer_sha256
      r.rubric_sha256 = packet.rubric_sha256
    }
    if (!Array.isArray(r.required)) r.required = []
    if (r.required.length !== packet.rubric.required.length) {
      // 个别题判分模型把 required 少给/多给一条时，整批崩溃代价太大；按 rubric 长度
      // 归一化（缺的记 false，多的截断），并在日志里留下具体题号，便于事后抽查。
      console.warn(`required length mismatch for ${r.id}: judge ${r.required.length} vs rubric ${packet.rubric.required.length}; normalized`)
      const n = packet.rubric.required.length
      r.required = Array.from({ length: n }, (_, i) => Boolean(r.required[i]))
    }
  }
  fs.writeFileSync(reviewsOut, reviews.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  console.log('reviews written:', reviewsOut)

  // 3) grade.py score
  const scored = reviewsOut.replace(/reviews/, 'scored')
  execFileSync('python', ['-I', path.join(BENCH, 'grading', 'grade.py'), 'score',
    '--packets', stage, '--reviews', reviewsOut, '--out', scored,
    '--summary', scored.replace(/scored/, 'summary') + '.json'], { stdio: 'inherit' })
  console.log('scored:', scored)

  // 收尾：答案/判分文件已经落盘，再清会话与记忆（审计先写 reset-log）。
  if (!args.includes('--keep')) {
    console.log('bench reset: cleaning sessions and memories')
    execFileSync(process.execPath, [path.join(HERE, 'bench-reset.mjs')], { stdio: 'inherit' })
  } else {
    console.log('bench reset skipped (--keep)')
  }
}

main().catch((e) => { console.error('judge-grade crashed:', e); process.exit(1) })
