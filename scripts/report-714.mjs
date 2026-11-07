#!/usr/bin/env node
/**
 * report-714 — 把一次全量评测的 scored/reviews/summary/token-report 汇总成得分汇报。
 *
 * 分类口径：
 *  - 全对：pass=true。
 *  - 错误：fail，且出现硬性事实问题（错认/错否/编造日期/违反禁止/越界/不当私事披露），
 *    或 rubric required 未满足。
 *  - 可错可对：fail，但没有硬性事实问题，仅因为「未知当事实」这类题外补充被扣分
 *    （事实本身没错，属于判分口径/叙述边界争议）。
 *
 * 成本按 DeepSeek-V4.1-Flash 谷价（元/百万 token）：
 *   缓存命中输入 0.02 · 缓存未命中输入 1 · 输出 4
 *
 * 用法：
 *   node report-714.mjs --label dashboard-20261106-124824 \
 *     [--answers results/answers-dashboard-<label>.jsonl] \
 *     [--plugin-version 1.2.7] \
 *     [--out results/report-714-<label>.md]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RESULTS = path.join(ROOT, 'results')
const DATASET = path.join(ROOT, 'datasets', 'natural-timegrid-20261101-v2')

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const LABEL = flag('label')
if (!LABEL) { console.error('usage: --label <label>'); process.exit(2) }
const OUT = path.resolve(ROOT, flag('out', `results/report-714-${LABEL}.md`))
const JSON_OUT = OUT.replace(/\.md$/, '.json')
const TOKEN_REPORT = path.join(RESULTS, 'token-report.json')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), 'AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.2.2-rc.1')
const MEMU_HOME = path.join(DSH_HOME, 'dsh-memu-memory')
const PRICES = { input: 1, cacheHit: 0.02, output: 4 } // 元/百万 token（谷价）

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).map((s) => JSON.parse(s))
  } catch { return [] }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function fmt(n) { return Number(n || 0).toLocaleString('zh-CN') }
function money(n) { return `¥${(Number(n) || 0).toFixed(2)}` }

/** 从本机插件 state / engine / vector-active 读取本次评测使用的记忆与向量配置。 */
function readVectorInfo() {
  const state = readJson(path.join(MEMU_HOME, 'state.json'), {}) || {}
  const engine = readJson(path.join(MEMU_HOME, 'engine/current.json'), {}) || {}
  const active = readJson(path.join(MEMU_HOME, 'index/vector-active.json'), {}) || {}
  const a = active.active || {}
  const manifest = (a.profile && a.profile.manifest) || {}
  return {
    engine: engine.version || 'unknown',
    backend: (state.settings && state.settings.memoryBackend) || 'unknown',
    vectorSource: (state.settings && state.settings.vectorSource) || 'unknown',
    embedding: manifest.displayName || manifest.id || 'unknown',
    dimension: manifest.dimension ?? null,
    pooling: manifest.pooling || null,
    quant: (manifest.quantization && manifest.quantization.weights) || null,
    generation: a.generation ?? null,
    fingerprint: a.fingerprint ? a.fingerprint.slice(0, 8) + '…' : null,
    database: 'libraries/lib_<id>.<fingerprint>.g' + (a.generation ?? '?') + '.sqlite3',
    recall: 'managed-vector-rrf',
  }
}

/** 本机 profile 里实际加载的插件版本（junction 指向源码目录，package.json 可读）。 */
function readPluginInfo() {
  const candidates = [
    path.join(DSH_HOME, 'profiles', 'memubench', 'node_modules', 'dsh-memu-memory', 'package.json'),
    path.join(ROOT, '..', 'dsh-memu-memory', 'package.json'),
  ]
  for (const file of candidates) {
    const pkg = readJson(file, null)
    if (pkg && pkg.name === 'dsh-memu-memory') return { version: pkg.version || 'unknown', path: file }
  }
  return { version: 'unknown', path: null }
}

/** 1.2.8 的注入预算与省 token 配置：从实际插件 state 读取，避免报告写成默认值。 */
function readInjectionInfo() {
  const state = readJson(path.join(MEMU_HOME, 'state.json'), {}) || {}
  const s = state.settings || {}
  return {
    autoInject: s.autoInject !== false,
    privateTopK: s.privateTopK ?? null,
    anchorTokens: s.anchorTokens ?? null,
    turnTokens: s.turnTokens ?? null,
    injectionTotalTokens: s.injectionTotalTokens ?? null,
  }
}

/** 直接读取插件 lib/budget.js 的意图候选上限，不在评测仓库里复制一份常量。 */
async function readIntentBudget(plugin) {
  if (!plugin?.path) return null
  try {
    const mod = await import(pathToFileURL(path.join(path.dirname(plugin.path), 'lib', 'budget.js')).href)
    return { recallIntentTopK: mod.RECALL_INTENT_TOPK || null }
  } catch { return null }
}

function versionAtLeast(version, target) {
  const va = String(version || '').split('.').map(Number)
  const vb = String(target || '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const a = va[i] || 0
    const b = vb[i] || 0
    if (a !== b) return a > b
  }
  return true
}

const scored = readJsonl(path.join(RESULTS, `scored-${LABEL}.jsonl`))
const reviews = readJsonl(path.join(RESULTS, `reviews-${LABEL}.jsonl`))
const answers = readJsonl(path.join(RESULTS, `answers-${LABEL}.jsonl`))
const summary = readJson(path.join(RESULTS, `summary-${LABEL}.jsonl.json`), {}) || {}
const inputs = readJsonl(path.join(DATASET, 'exam-inputs.jsonl'))
const inputById = new Map(inputs.map((r) => [r.id, r]))
const reviewById = new Map(reviews.map((r) => [r.id, r]))
const answerById = new Map(answers.map((r) => [r.id, r]))

const HARD_FLAGS = ['错认', '错否', '越界', '编造日期', '不当私事披露']

function classify(row) {
  const review = reviewById.get(row.id) || {}
  const required = Array.isArray(row.required) ? row.required : []
  const hard = HARD_FLAGS.filter((k) => row[k] === true)
  const forbidden = Array.isArray(row['违反禁止']) ? row['违反禁止'] : []
  if (row.pass === true) return { category: 'pass', hard, forbidden, unknown: row['未知当事实'] || [], reason: row.reason || '' }
  const requiredMissing = required.some((v) => v !== true)
  if (hard.length || forbidden.length || requiredMissing) {
    return { category: 'error', hard, forbidden, unknown: row['未知当事实'] || [], reason: row.reason || '', requiredMissing }
  }
  if (Array.isArray(row['未知当事实']) && row['未知当事实'].length > 0) {
    return { category: 'ambiguous', hard, forbidden, unknown: row['未知当事实'], reason: row.reason || '' }
  }
  // 事实都对、只是主动多写了无关旧事被扣 relevance：归为可错可对（不是硬性事实错误）
  if (row.factual_pass === true && row.relevance_pass === false) {
    return { category: 'ambiguous', hard, forbidden, unknown: [], reason: row.reason || '' }
  }
  // 其余没有硬旗标但 required 未满足等情况仍归错误
  return { category: 'error', hard, forbidden, unknown: [], reason: row.reason || '', requiredMissing }
}

const rows = scored
  .filter((r) => r && typeof r.id === 'string')
  .map((r) => {
    const input = inputById.get(r.id) || {}
    const answer = answerById.get(r.id) || {}
    return { ...r, ...classify(r), persona: r.persona || input.persona || '—', tags: r.content_tags || input.content_tags || [], question: input.question || '', answer: answer.answer || '' }
  })

const pass = rows.filter((r) => r.category === 'pass')
const ambiguous = rows.filter((r) => r.category === 'ambiguous')
const errors = rows.filter((r) => r.category === 'error')

function costOf(bucket) {
  if (!bucket) return 0
  return (Number(bucket.input || 0) * PRICES.input + Number(bucket.cacheHit || 0) * PRICES.cacheHit + Number(bucket.output || 0) * PRICES.output) / 1_000_000
}

const report = readJson(TOKEN_REPORT, {}) || {}
const PURPOSE_LABELS = { exam: '考试', consolidation: '记忆整理', judge: '判分', probe: '探测', other: '其他' }
const purposes = ['exam', 'consolidation', 'judge', 'probe', 'other']
const costRows = purposes.map((name) => {
  const b = (report.byPurpose && report.byPurpose[name]) || { calls: 0, input: 0, cacheHit: 0, output: 0, total: 0 }
  return {
    name, label: PURPOSE_LABELS[name] || name, calls: b.calls || 0, input: b.input || 0,
    cacheHit: b.cacheHit || 0, output: b.output || 0, total: b.total || 0,
    billable: (b.input || 0) + (b.output || 0), cost: costOf(b),
  }
})
const totalCost = costRows.reduce((a, r) => a + r.cost, 0)
const billableTotal = costRows.reduce((a, r) => a + r.billable, 0)

const byPersona = {}
const byTag = {}
for (const r of rows) {
  const p = r.persona
  byPersona[p] ||= { total: 0, pass: 0, error: 0, ambiguous: 0 }
  byPersona[p].total += 1
  byPersona[p][r.category] += 1
  for (const t of r.tags) {
    byTag[t] ||= { total: 0, pass: 0, error: 0, ambiguous: 0 }
    byTag[t].total += 1
    byTag[t][r.category] += 1
  }
}

function idList(list) {
  return list.map((r) => `- \`${r.id}\`（${r.persona}）`).join('\n')
}

function detailList(list) {
  return list.map((r) => {
    const flags = [...r.hard, ...(r.forbidden.length ? [`违反禁止: ${r.forbidden.join('；')}`] : []), ...(r.unknown.length ? [`未知当事实: ${r.unknown.join('；')}`] : [])]
    return `- \`${r.id}\`（${r.persona}）${flags.length ? ` · ${flags.join(' · ')}` : ''}\n  - ${r.reason || '（无理由）'}`
  }).join('\n')
}

const vec = readVectorInfo()
const detectedPlugin = readPluginInfo()
const plugin = flag('plugin-version')
  ? { ...detectedPlugin, version: String(flag('plugin-version')) }
  : detectedPlugin
const injection = readInjectionInfo()
const intentBudget = await readIntentBudget(plugin)
const intentCapLine = intentBudget?.recallIntentTopK
  ? Object.entries(intentBudget.recallIntentTopK).map(([k, v]) => `${k} ${v}`).join(' · ') + ' · 封顶 20'
  : 'unknown'
const modern = versionAtLeast(plugin.version, '1.2.9')
const recallFeatures = modern
  ? ['bm25-lexical', 'slot-aware-dedup', 'topk-fill-expansion', 'fact-ledger']
  : ['includes-lexical']

const lines = [
  `# Memu Bench 714 · 得分汇报`,
  '',
  `- 批次：\`${LABEL}\``,
  `- 插件：dsh-memu-memory \`${plugin.version}\``,
  `- 模型：dys-router / deepseek-v4.1-flash · 思考强度 high`,
  `- 规模：${rows.length} 题${rows.length === inputs.length ? '（全量）' : `（抽样子集，数据集 ${inputs.length} 题）`} · 并发 8 · 每轮按 cutoff 重建记忆库`,
  `- 判分：deepseek-v4.1-flash · 分节备忘录判据`,
  '',
  '## 记忆与向量库',
  '',
  '| 项 | 配置 |',
  '|---|---|',
  `| 插件 | \`dsh-memu-memory\` \`${plugin.version}\` |`,
  `| 记忆引擎 | MemU \`${vec.engine}\`（Python venv） |`,
  `| 记忆后端 | \`${vec.backend}\` |`,
  `| 向量来源 | \`${vec.vectorSource}\` |`,
  `| 嵌入模型 | \`${vec.embedding}\`${vec.dimension ? ` · ${vec.dimension} 维` : ''}${vec.pooling ? ` · ${vec.pooling} pooling` : ''}${vec.quant ? ` · ${vec.quant}` : ''} |`,
  `| 向量库 | 每库独立 SQLite：\`${vec.database}\` |`,
  `| 向量代际 | generation ${vec.generation ?? '?'}${vec.fingerprint ? `，fingerprint \`${vec.fingerprint}\`` : ''} |`,
  `| 召回 | \`${vec.recall}\` |`,
  ...(modern ? [
    '| 词法腿 | BM25（默认；`DSH_MEMU_RECALL_LEXICAL=includes` 可回退） |',
    '| 去重 | 槽位感知（数字/日期/时间/星期/引号人名） |',
    '| 图扩展 | 只补未满的 topK 座位，不追加注入 |',
    '| 事实账本 | `fact_authority` / `fact_evidence`；冲突卡只调 A/B 顺序 |',
  ] : [
    '| 词法腿 | includes（旧口径） |',
  ]),
  `| 召回意图上限 | ${intentCapLine} |`,
  `| 注入预算 | privateTopK ${injection.privateTopK ?? '?'} · anchorTokens ${injection.anchorTokens ?? '?'} · turnTokens ${injection.turnTokens ?? '?'} · injectionTotalTokens ${injection.injectionTotalTokens ?? '?'} |`,
  '',
  '## 总分',
  '',
  `| 指标 | 数值 |`,
  `|---|---|`,
  `| 判分题数 | ${fmt(rows.length)} |`,
  `| 全对 | ${fmt(pass.length)} |`,
  `| 错误 | ${fmt(errors.length)} |`,
  `| 可错可对 | ${fmt(ambiguous.length)} |`,
  `| 通过率 | ${rows.length ? ((pass.length / rows.length) * 100).toFixed(2) : '0.00'}% |`,
  '',
  '## 按 Persona',
  '',
  '| Persona | 题数 | 全对 | 错误 | 可错可对 | 通过率 |',
  '|---|---|---|---|---|---|',
  ...Object.entries(byPersona).sort().map(([p, s]) =>
    `| ${p} | ${fmt(s.total)} | ${fmt(s.pass)} | ${fmt(s.error)} | ${fmt(s.ambiguous)} | ${s.total ? ((s.pass / s.total) * 100).toFixed(1) : '0.0'}% |`),
  '',
  '## 按考点标签',
  '',
  '| 标签 | 题数 | 全对 | 错误 | 可错可对 |',
  '|---|---|---|---|---|',
  ...Object.entries(byTag).sort((a, b) => b[1].total - a[1].total).map(([t, s]) =>
    `| ${t} | ${fmt(s.total)} | ${fmt(s.pass)} | ${fmt(s.error)} | ${fmt(s.ambiguous)} |`),
  '',
  '## 成本（DeepSeek-V4.1-Flash 谷价）',
  '',
  '单价：缓存命中输入 ¥0.02/M · 缓存未命中输入 ¥1/M · 输出 ¥4/M。控制台「本次跑批」只算 exam-log 逐题最终回答的 usage（不含整理/判分）；本表是本次评测全量消耗。',
  '',
  '| 用途 | 调用 | 未命中输入 | 缓存命中输入 | 输出 | 计费令牌（未命中+输出） | 总令牌数（含缓存） | 成本 |',
  '|---|---|---|---|---|---|---|---|',
  ...costRows.map((r) => `| ${r.label} | ${fmt(r.calls)} | ${fmt(r.input)} | ${fmt(r.cacheHit)} | ${fmt(r.output)} | ${fmt(r.billable)} | ${fmt(r.total)} | ${money(r.cost)} |`),
  `| **合计** |  |  |  |  | **${fmt(billableTotal)}** | **${fmt(costRows.reduce((a, r) => a + r.total, 0))}** | **${money(totalCost)}** |`,
  '',
  `## 错误题（${errors.length}）`,
  '',
  detailList(errors) || '（无）',
  '',
  `## 可错可对（${ambiguous.length}）`,
  '',
  '这些题的答案事实大体正确，但补充了题目未问到的内容或把未证实信息写成确定事实，按当前判分口径扣分；是否算错可人工复核。',
  '',
  detailList(ambiguous) || '（无）',
  '',
  `## 全对题（${pass.length}）`,
  '',
  idList(pass) || '（无）',
  '',
]

fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
fs.writeFileSync(JSON_OUT, JSON.stringify({
  label: LABEL,
  plugin,
  injection,
  intentTopK: intentBudget?.recallIntentTopK || null,
  recallFeatures,
  model: 'dys-router/deepseek-v4.1-flash',
  vector: vec,
  counts: { total: rows.length, pass: pass.length, error: errors.length, ambiguous: ambiguous.length },
  byPersona,
  byTag,
  cost: { prices: PRICES, rows: costRows, total: totalCost, tokens: report.totals || null },
  passIds: pass.map((r) => r.id),
  errorIds: errors.map((r) => r.id),
  ambiguousIds: ambiguous.map((r) => r.id),
  rows,
}, null, 1), 'utf8')
console.log('report ->', OUT)
console.log('json   ->', JSON_OUT)
console.log(`pass=${pass.length} error=${errors.length} ambiguous=${ambiguous.length} cost=${money(totalCost)}`)
