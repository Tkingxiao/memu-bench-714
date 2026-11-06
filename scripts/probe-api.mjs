#!/usr/bin/env node
/**
 * M0 — 探测 LLM 端点。
 *
 * 默认目标：DYS router（https://router.dys.asia/v1，OpenAI completions 线协议，
 * 模型 deepseek-v4.1-flash）。API key 从 PROBE_KEY 或 PROBE_KEY_FILE 读取，
 * 不写进任何日志。
 *
 * 2026-11-06 实测：非流式、多轮、SSE 流式、function calling 全部 200。
 * 旧的 8899 Z·POOL 反代已被替换（/v1/messages 在高负载下停摆、SSE 503）。
 *
 * 所有请求记入 logs/api-log.jsonl（时间/用途/模型/估算 token，不含 key）。
 * 退出码：0 = 非流式对话拿到非空回复；1 = 失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LOG = path.join(ROOT, 'logs', 'api-log.jsonl')
fs.mkdirSync(path.dirname(LOG), { recursive: true })

const BASE = process.env.PROBE_BASE || 'https://router.dys.asia/v1'
const MODEL = process.env.PROBE_MODEL || 'deepseek-v4.1-flash'
// key 只从环境或 bench profile 里读；不写进仓库、不写进日志。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), 'AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.2.2-rc.1')
const PROFILE_YML = path.join(DSH_HOME, 'profiles/memubench/cordis.patch.yml')
function profileKey() {
  try {
    const m = fs.readFileSync(PROFILE_YML, 'utf8').match(/authorization:\s*Bearer\s+(\S+)/)
    return m ? m[1] : ''
  } catch { return '' }
}
const KEY = process.env.PROBE_KEY ||
  (process.env.PROBE_KEY_FILE && fs.existsSync(process.env.PROBE_KEY_FILE)
    ? fs.readFileSync(process.env.PROBE_KEY_FILE, 'utf8').trim()
    : '') || profileKey()

function logApi(entry) {
  fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), purpose: 'probe', model: MODEL, ...entry }) + '\n')
}

async function post(pathname, body, extraHeaders = {}) {
  const started = Date.now()
  try {
    const res = await fetch(BASE + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}), ...extraHeaders },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, ms: Date.now() - started, text }
  } catch (error) {
    return { status: 0, ms: Date.now() - started, text: String(error) }
  }
}

async function main() {
  console.log('node', process.version, '| base', BASE, '| model', MODEL, '| key', KEY ? '(set)' : '(none)')

  // 1) 非流式对话
  const chat = await post('/chat/completions', {
    model: MODEL,
    max_tokens: 64,
    temperature: 0,
    messages: [{ role: 'user', content: '只回复两个字：通了' }],
  })
  let body = null
  try { body = JSON.parse(chat.text) } catch { body = null }
  const reply = body?.choices?.[0]?.message?.content || ''
  console.log(`[chat] ${chat.status} ${chat.ms}ms reply=${JSON.stringify(reply)} usage=${JSON.stringify(body?.usage || null)}`)
  logApi({
    outcome: chat.status === 200 && reply.trim() ? 'success' : 'fail',
    path: '/chat/completions', style: 'openai', status: chat.status, ms: chat.ms, replyChars: reply.length,
    promptTokens: body?.usage?.prompt_tokens ?? null,
    completionTokens: body?.usage?.completion_tokens ?? null,
    cacheHit: body?.usage?.prompt_cache_hit_tokens ?? body?.usage?.cached_tokens ?? null,
    cacheMiss: body?.usage?.prompt_cache_miss_tokens ?? null,
  })
  if (chat.status !== 200 || !reply.trim()) {
    console.error('FAIL:', chat.text.slice(0, 400))
    process.exitCode = 1
    return
  }

  // 2) 多轮上下文
  const multi = await post('/chat/completions', {
    model: MODEL,
    max_tokens: 80,
    temperature: 0,
    messages: [
      { role: 'user', content: '记住：我的代号是蓝鲸 7 号。' },
      { role: 'assistant', content: '好的，已记住：代号蓝鲸 7 号。' },
      { role: 'user', content: '我的代号是什么？只回答代号。' },
    ],
  })
  let multiBody = null
  try { multiBody = JSON.parse(multi.text) } catch {}
  const multiReply = multiBody?.choices?.[0]?.message?.content || ''
  console.log(`[multi-turn] ${multi.status} ${multi.ms}ms reply=${JSON.stringify(multiReply)}`)
  logApi({ outcome: multiReply.includes('蓝鲸') ? 'success' : 'fail', path: '/chat/completions', style: 'multi-turn', status: multi.status, ms: multi.ms })

  // 3) SSE 流式
  {
    const started = Date.now()
    try {
      const res = await fetch(BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
        body: JSON.stringify({ model: MODEL, max_tokens: 80, temperature: 0, stream: true, messages: [{ role: 'user', content: '用一句话说明你收到了流式请求。' }] }),
      })
      let chunks = 0, text = ''
      const dec = new TextDecoder()
      for await (const part of res.body) {
        chunks++
        for (const line of dec.decode(part, { stream: true }).split('\n')) {
          if (!line.startsWith('data:')) continue
          const p = line.slice(5).trim()
          if (!p || p === '[DONE]') continue
          try { text += JSON.parse(p)?.choices?.[0]?.delta?.content || '' } catch {}
        }
      }
      console.log(`[stream] ${res.status} ${Date.now() - started}ms chunks=${chunks} chars=${text.length}`)
      logApi({ outcome: res.status === 200 && chunks > 1 ? 'success' : 'fail', path: '/chat/completions', style: 'sse', status: res.status, ms: Date.now() - started, chunks })
    } catch (error) {
      console.log(`[stream] ERROR ${error.message}`)
      logApi({ outcome: 'fail', path: '/chat/completions', style: 'sse', status: 0 })
    }
  }

  // 4) function calling（整理 worker 依赖）
  const tool = await post('/chat/completions', {
    model: MODEL,
    max_tokens: 120,
    temperature: 0,
    tool_choice: 'auto',
    messages: [{ role: 'user', content: '把「测试条目 A」写进记忆。' }],
    tools: [{
      type: 'function',
      function: { name: 'memu_private_remember', description: '写入一条私有记忆', parameters: { type: 'object', properties: { text: { type: 'string' }, title: { type: 'string' } }, required: ['text'] } },
    }],
  })
  let toolBody = null
  try { toolBody = JSON.parse(tool.text) } catch {}
  const calls = toolBody?.choices?.[0]?.message?.tool_calls || []
  console.log(`[tool-call] ${tool.status} ${tool.ms}ms calls=${calls.length} name=${calls[0]?.function?.name || '-'}`)
  logApi({ outcome: calls.length ? 'success' : 'fail', path: '/chat/completions', style: 'tool-call', status: tool.status, ms: tool.ms, calls: calls.length })
  if (!calls.length) process.exitCode = 1
}

main().catch((e) => { console.error('probe crashed:', e); process.exitCode = 1 })
