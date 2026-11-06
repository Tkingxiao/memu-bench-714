#!/usr/bin/env node
/**
 * memu-bench-714 宿主客户端 — 通过公开网关驱动 DSH 会话与插件 RPC。
 *
 * 传输形状（与 dsh-memu-memory/scripts/drive-session.mjs 的实测一致）：
 *   POST <base>/api/<method，'/' → '/'>        Connection RPC carrier
 *     body:  { type:'client-request', rpcId, method, payload:{ args } }
 *     resp:  { type:'server-response', rpcId, result:{ ok, value } }
 *   POST /dsh-memu-memory/<endpoint>           插件 RPC（method 必须等于 endpoint）
 *     body:  { type:'client-request', rpcId, method:'<endpoint>', payload:{...} }
 *     resp:  { type:'server-response', rpcId, result:{ ok, value } }
 *
 * 鉴权：GET /?token=… 303 换会话 cookie；此后带 cookie。
 * 只监听 127.0.0.1，cookie 文件留在 logs/ 下。
 *
 * 子命令：
 *   init                                  用 logs/host-url.txt 里的 URL 换 cookie
 *   create [--cwd <dir>] [--id <sid>]     建会话（--id 指向已种子化的会话文件）
 *   prompt --session <id> --text <t>      发一条用户消息并等待 turn/end
 *   page --session <id> [--after <seq>]   读事件分页
 *   rpc --endpoint <e> [--payload <json>] 插件 RPC
 *   prompt-state --session <id>           读 getSessionPromptState（绑定状态）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LOGS = path.join(ROOT, 'logs')
const COOKIE_FILE = path.join(LOGS, 'host-cookie.txt')
const URL_FILE = path.join(LOGS, 'host-url.txt')

const BASE = process.env.BENCH_BASE || 'http://127.0.0.1:39771'

function rpcId() { return crypto.randomUUID() }

function cookieHeader() {
  if (!fs.existsSync(COOKIE_FILE)) throw new Error('no cookie; run `host-client.mjs init` first')
  return fs.readFileSync(COOKIE_FILE, 'utf8').trim()
}

async function callRoute(routePath, method, payload, { timeoutMs = 60_000 } = {}) {
  const res = await fetch(`${BASE}${routePath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader() },
    body: JSON.stringify({ type: 'client-request', rpcId: rpcId(), method, payload: { args: payload } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* leave raw */ }
  if (res.status !== 200 || !body?.result) {
    throw new Error(`gateway ${routePath} -> ${res.status}: ${text.slice(0, 300)}`)
  }
  return body.result
}

async function pluginRpc(endpoint, payload = {}, { timeoutMs = 120_000 } = {}) {
  const res = await fetch(`${BASE}/dsh-memu-memory/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader() },
    body: JSON.stringify({ type: 'client-request', rpcId: rpcId(), method: endpoint, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* leave raw */ }
  if (!body?.result) throw new Error(`plugin rpc ${endpoint} -> ${res.status}: ${text.slice(0, 300)}`)
  return body.result
}

async function init() {
  const urlFile = URL_FILE
  if (!fs.existsSync(urlFile)) throw new Error(`missing ${urlFile}`)
  const url = fs.readFileSync(urlFile, 'utf8').trim()
  const res = await fetch(url, { redirect: 'manual' })
  const setCookie = res.headers.get('set-cookie') || ''
  if (!setCookie) throw new Error(`no set-cookie from ${url} (status ${res.status})`)
  const pair = setCookie.split(';')[0]
  fs.writeFileSync(COOKIE_FILE, pair)
  console.log('cookie saved:', pair.slice(0, 40) + '…')
}

async function createSession(args) {
  const request = {}
  if (args.cwd) request.cwd = args.cwd
  if (args.id) request.sessionId = args.id
  const result = await callRoute('/api/session/create', 'session/create', { request })
  console.log(JSON.stringify(result, null, 1))
}

async function readEvents(sessionId) {
  const result = await callRoute('/api/session/events', 'session/events', {
    request: { address: { kind: 'session', sessionId } },
  })
  const page = result.value || result
  // 0.2.2-rc.1 wire: value.records = [{ type:'event', event:{ type, seq, data } }]
  const records = page.records || page.events || page.items || []
  return records.map((e) => e?.event || e)
}

async function lastSeqOf(sessionId) {
  try {
    const events = await readEvents(sessionId)
    return events.reduce((max, ev) => (typeof ev.seq === 'number' && ev.seq > max ? ev.seq : max), -1)
  } catch {
    return -1
  }
}

async function waitTurnEnd(sessionId, { timeoutMs = 300_000, after = -1 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500))
    try {
      const events = await readEvents(sessionId)
      for (const ev of events) {
        if (ev.type === 'turn/end' && typeof ev.seq === 'number' && ev.seq > after) {
          return { done: true, reason: ev.data?.reason || null, seq: ev.seq }
        }
      }
    } catch (error) {
      if (String(error).includes('401')) throw error
      // 网关偶发抖动：继续轮询
    }
  }
  return { done: false, reason: { kind: 'timeout' } }
}

async function prompt(sessionId, text, { timeoutMs } = {}) {
  const baseline = await lastSeqOf(sessionId)
  const request = {
    requestId: crypto.randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
    clientTimeZone: 'Asia/Shanghai',
  }
  const result = await callRoute('/api/session/prompt', 'session/prompt', { request })
  const accepted = result.value?.accepted === true || result.accepted === true
  if (!accepted) throw new Error('prompt not accepted: ' + JSON.stringify(result).slice(0, 300))
  const wait = await waitTurnEnd(sessionId, { timeoutMs, after: baseline })
  console.log(JSON.stringify({ accepted: true, turnEnd: wait }, null, 1))
}

async function page(sessionId, after) {
  const events = await readEvents(sessionId)
  console.log(JSON.stringify(events.map((e) => ({
    seq: e.seq, type: e.type,
    text: (e.data?.message?.content?.[0]?.text || e.data?.content?.[0]?.text || '').slice(0, 120),
    reason: e.data?.reason?.kind || undefined,
  })), null, 1))
}

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const commands = {
  init,
  create: () => createSession({ cwd: flag('cwd'), id: flag('id') }),
  prompt: () => prompt(flag('session'), flag('text')),
  page: () => page(flag('session'), flag('after')),
  rpc: () => pluginRpc(flag('endpoint'), flag('payload') ? JSON.parse(flag('payload')) : {}, { timeoutMs: Number(flag('timeout')) || 120_000 }).then((r) => console.log(JSON.stringify(r, null, 1).slice(0, 8000))),
  // 直通网关：workspace/create 这类宿主 RPC 不在插件前缀下，只能走 /api/<method>。
  gateway: () => callRoute(`/api/${flag('method')}`, flag('method'), flag('payload') ? JSON.parse(flag('payload')) : {}, { timeoutMs: Number(flag('timeout')) || 120_000 }).then((r) => console.log(JSON.stringify(r, null, 1).slice(0, 8000))),
}

if (!commands[cmd]) {
  console.error('usage: host-client.mjs <init|create|prompt|page|rpc|gateway> [flags]')
  process.exit(2)
}
commands[cmd]().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
