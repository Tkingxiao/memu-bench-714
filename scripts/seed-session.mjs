#!/usr/bin/env node
/**
 * memu-bench-714 — 会话种子化（回放架构核心）。
 *
 * 把冻结历史的「已有用户消息 + 已有助手回复」写成一个 DSH v4 会话文件
 * （session.v4.jsonl.zstd，单 zstd 帧），事件时间戳 = 该轮逻辑时间。
 * 宿主随后把该文件当作普通会话读入；dsh-memu-memory 的整理路径
 * （generatePrivate / 闲时 sleep pass）通过 sessionQuery 读这份转录并自然写库。
 * 不直接写插件库——记忆写入只走插件自身流程。
 *
 * 事件形状按 0.2.2-rc.1 真实会话文件逐字段仿写：
 *   turn/start → user/message → step/start → assistant/message(stream) → step/end → turn/end
 * assistant/message 必须带 stream（AssistantStreamRecord[]）与 usage。
 *
 * 用法：
 *   node seed-session.mjs --history <P01.jsonl> --from 1 --to 20 \
 *     --session <sid> [--workspace <dir>] [--out <file>] [--append] [--shift-hours <h>]
 *
 *   --append        在已有种子文件后继续追加更多轮（同一 session id，轮号接续）
 *   --shift-hours   把逻辑时间整体偏移 N 小时（默认 0；用于避免与真实时钟混淆时调试）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HOME = process.env.BENCH_HOME || path.join(os.homedir(), 'AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.2.2-rc.1')
const DEFAULT_WORKSPACE = path.join(ROOT, 'workspace')

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const has = (name) => args.includes(`--${name}`)

function sessionProjectDir(workspace) {
  // 宿主把 workspace 绝对路径折成 project key：连续 [^A-Za-z0-9.] 折叠为单个 '-'，
  // 点号保留（实测 0.2.2-rc.1 的目录名），两端各补一个 '-'。
  const key = '--' + workspace.replace(/[^A-Za-z0-9.]+/g, '-') + '--'
  return path.join(HOME, 'sessions', key)
}

function readHistory(file, from, to) {
  const rows = fs.readFileSync(file, 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean).map((s) => JSON.parse(s))
  // read_exam.py 的校验口径：轮次 1..N 连续、时间单调
  rows.forEach((r, i) => { if (r['轮次'] !== i + 1) throw new Error(`history turn order broken at line ${i + 1}`) })
  return rows.slice(from - 1, to)
}

function uuid() { return crypto.randomUUID() }

function buildTurnEvents(turnRow, turnNo, seqStart, shiftMs) {
  const events = []
  let seq = seqStart
  const base = Date.parse(turnRow['逻辑时间'])
  if (!Number.isFinite(base)) throw new Error(`bad 逻辑时间: ${turnRow['逻辑时间']}`)
  const T = (ms) => base + shiftMs + ms
  const push = (type, ms, data, extra) => events.push({ type, seq: seq++, time: T(ms), data, ...(extra || {}) })

  push('turn/start', 0, { turn: turnNo })
  push('user/message', 100, {
    content: [{ type: 'text', text: turnRow['用户消息'] }],
    source: { kind: 'user' },
    role: 'user',
    id: uuid(),
  }, { surfaceOp: 'append' })
  push('step/start', 200, { turn: turnNo, step: 1 })
  const text = turnRow['助手回复']
  push('assistant/message', 2500, {
    turn: turnNo,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: {
        kind: 'model',
        provider: 'dys-router',
        model: 'deepseek-v4.1-flash',
        replayState: {
          response: {
            kind: 'pi-ai', version: 2, api: 'openai-completions',
            provider: 'dys-router', model: 'deepseek-v4.1-flash',
            responseId: 'bench-seed-' + turnNo, stopReason: 'stop',
          },
          blocks: [{ type: 'text' }],
        },
      },
      id: uuid(),
    },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    stream: [
      { type: 'chunk', time: T(2400), chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'text-chunks', time0: T(2400), index: 0, dt: [], texts: [text] },
      { type: 'chunk', time: T(2450), chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } },
      { type: 'chunk', time: T(2480), chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
    ],
  }, { surfaceOp: 'append' })
  push('step/end', 3000, { turn: turnNo, step: 1 })
  push('turn/end', 4000, { turn: turnNo, reason: { kind: 'completed' } })
  return events
}

const history = flag('history')
const sid = flag('session')
if (!history || !sid) { console.error('usage: --history <file> --session <id> [--from N] [--to N] [--append] [--workspace dir] [--out file] [--shift-hours h]'); process.exit(2) }
const from = Number(flag('from', '1'))
const to = Number(flag('to', '0')) || Number(flag('turns', '0')) || from
const workspace = flag('workspace', DEFAULT_WORKSPACE)
const shiftMs = (Number(flag('shift-hours', '0')) || 0) * 3600_000

const rows = readHistory(history, from, to)
if (!rows.length) { console.error('no turns in range'); process.exit(2) }

const outFile = flag('out') || path.join(sessionProjectDir(workspace), sid, 'session.v4.jsonl.zstd')
fs.mkdirSync(path.dirname(outFile), { recursive: true })

// 已有文件则解出既有事件（--append 接续 seq 与轮号）；多帧逐帧解
function readAllFrames(file) {
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
  const offsets = []
  let idx = 0
  while (true) {
    const i = buf.indexOf(magic, idx)
    if (i < 0) break
    offsets.push(i)
    idx = i + 4
  }
  const text = offsets.map((off, n) =>
    zlib.zstdDecompressSync(buf.subarray(off, n + 1 < offsets.length ? offsets[n + 1] : buf.length)).toString('utf8')
  ).join('')
  return text.split('\n').filter(Boolean).map((s) => JSON.parse(s))
}

let header = null
let existing = []
if (fs.existsSync(outFile)) {
  const rowsAll = readAllFrames(outFile)
  header = rowsAll[0]
  if (header?.type !== 'session') { console.error('existing file has no session header'); process.exit(1) }
  existing = rowsAll.slice(1)
}

const lastSeq = existing.length ? existing[existing.length - 1].seq : -1
const lastTurn = existing.length
  ? Math.max(0, ...existing.filter((e) => e.type === 'turn/start').map((e) => e.data.turn))
  : 0
const shift = header ? 0 : shiftMs
if (!header) {
  header = {
    type: 'session', version: 4, id: sid,
    createdAt: Date.parse(rows[0]['逻辑时间']) + shiftMs,
    cwd: workspace,
    isSeeded: false,
    delegationDepth: 0,
  }
}

let seq = lastSeq + 1
let turnNo = lastTurn
const newEvents = []
for (const row of rows) {
  turnNo += 1
  const evs = buildTurnEvents(row, turnNo, seq, shift)
  seq += evs.length
  newEvents.push(...evs)
}

const all = [header, ...existing, ...newEvents]
// 真实文件格式（0.2.2-rc.1 实测）：首帧 = 仅 header 行；后续帧 = 事件行批次；每帧以 \n 结尾。
const jsonlHeader = JSON.stringify(header) + '\n'
const jsonlEvents = all.slice(1).map((e) => JSON.stringify(e)).join('\n') + '\n'
const compressed = Buffer.concat([
  zlib.zstdCompressSync(Buffer.from(jsonlHeader, 'utf8')),
  zlib.zstdCompressSync(Buffer.from(jsonlEvents, 'utf8')),
])
// 先写临时文件再原子替换：宿主可能在种子写入过程中读同一会话文件，
// 半截 zstd 帧会触发原生解压崩溃（实测 0xC0000409）。rename 保证读到的永远是完整文件。
const tmpFile = outFile + '.tmp-' + crypto.randomBytes(4).toString('hex')
fs.writeFileSync(tmpFile, compressed)
fs.renameSync(tmpFile, outFile)
const turns = all.filter((e) => e.type === 'turn/start').length
console.log(JSON.stringify({
  out: outFile,
  seededTurnsNew: newEvents.length / 6,
  totalTurns: turns,
  totalEvents: all.length,
  lastSeq: all[all.length - 1].seq,
  timeRange: [all[1]?.time, all[all.length - 2]?.time],
}, null, 1))
