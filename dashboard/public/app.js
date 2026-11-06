/* ==========================================================================
 * Memu Bench 控制台 · 前端逻辑（唯一入口）
 *
 * 为什么零依赖、无 import：页面以 <script type="module" src="app.js"> 加载，
 * 部署目录禁止外部资源（见 index.html 头注释）；本文件是唯一允许存在的 JS。
 *
 * 契约：DOM id 与后端 API 形状由任务书定死；index.html / style.css 由并行
 * 同事维护，本文件只注入内容、切换 .hidden/.active/.open 等 hook 类，
 * 注入结构与 style.css 的「样式契约」注释对齐：
 *   .bar-row > (.bar-label + .bar-track > .bar-fill + .bar-value)
 *   .run-row（末个子元素右对齐）/ .state-pill 五态 / .kv 用 dl>dt+dd
 *   .quote(.meta) / .answer-block / .flag-row(.ok/.bad) / .rubric-group(h4+ul)
 *   .run-log > .log-line(.log-err) / 主题走 html[data-theme]（本文件只切值与图标）
 * ========================================================================== */

/* ---------------- 主题 ---------------- */

// 必须最先执行（任何渲染之前）：先落 data-theme 再画页面，暗色用户才不会首帧闪白。
// localStorage 可能被禁（隐私模式/策略）：读写都包 try/catch，读失败兜底浅色
try {
  document.documentElement.dataset.theme = localStorage.getItem('mb-theme') || 'light';
} catch (e) {
  document.documentElement.dataset.theme = 'light';
}

/* ---------------- 小工具 ---------------- */

// 统一从 id 取节点：契约里的 id 必在，但 #hostBanner 这类"行为要求提到、
// DOM 契约未列"的节点仍做可空兜底，避免并行改动把页面打断成白屏
const $ = (id) => document.getElementById(id);

function setText(el, text) { if (el) el.textContent = text; }
function setHidden(el, isHidden) { if (el) el.classList.toggle('hidden', !!isHidden); }
function setFill(id, pct) {
  const el = $(id);
  if (el) el.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`;
}

// 所有动态文本（题面/引文/persona/键名等）一律转义——内容含用户语料
function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 数字千分位；契约要求 toLocaleString('zh-CN')。null/undefined 归零显示
function fmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toLocaleString('zh-CN') : '0';
}

// 时长格式 1h23m45s；小时为 0 时省略小时段
function fmtDur(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}h${p(m)}m${p(s)}s` : `${m}m${p(s)}s`;
}

// startedAt/endedAt 兼容毫秒时间戳与 ISO 字符串；秒级时间戳（<1e11）放大 1000
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e11 ? v * 1000 : v) : null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

// 任意值转展示文本：facts/sources/review 子项形状未逐一定死，兜底不炸
function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
}

// 防御性键名解析：按候选顺序取第一个非空值（review 侧键名契约未定死）
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function truncate(s, n) {
  const t = asText(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// fetch 包装：非 2xx 解析 {error} 抛出；网络失败也抛出带原因的错
async function api(path, opts) {
  let res;
  try { res = await fetch(path, opts); }
  catch (e) { throw new Error(`网络请求失败：${e && e.message ? e.message : e}`); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* 空响应体容忍（如 204） */ }
  if (!res.ok) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
  return data;
}

/* ---------------- 全局状态 ---------------- */

let questions = { total: 0, questions: [] };   // GET /api/questions 缓存
let summary = null;                            // GET /api/summary 缓存
let tokens = null;                             // GET /api/tokens 缓存
let runState = null;                           // GET /api/run/state 缓存（SSE/轮询整包替换）
let providerCache = null;                      // GET /api/provider 缓存（设置页表单）
let judgeProviderSynced = false;               // 判分 Provider 下拉是否已按默认 provider 初始化过
let answersFileCount = 0;                      // answers-*.jsonl 数量（题库「全新重置」可用性）
let scoreLabelCount = 0;                       // 判分批次数量（同上）
let personaCounts = new Map();                 // persona -> 题数（两个下拉与 all chip 共用）
let activeChip = null;                         // 当前选中的题数档（data-count 原值，含 'all'）
let selectedPersonas = new Set();              // 运行页多选的 Persona（为空时默认第一个）
let selectedQids = new Set();                  // 题库勾选的题目 id（跨筛选保留）
let drawerDetail = null;                       // 最近一次成功渲染的题目详情（评分编辑器取消回滚用）
let drawerEditMode = false;                    // 抽屉是否处于判分编辑态
let runLogSinceTs = null;                      // 新一轮考试清空日志的时刻：回补只取这之后的行
let runLogAutoScroll = true;                   // 实时日志自动滚动（用户上滚 >40px 时暂停）
let extPrepInfoText = '';                      // 外部判分卡常驻提示（「已复制」短暂顶替后恢复）
let extCopyTimer = null;                       // 「已复制」的恢复定时器：连点时重置而不是叠加

const BANK_STATE_TEXT = { pending: '未作答', answered: '已作答', passed: '通过', failed: '未通过' };
const EXAM_STATE_TEXT = { pending: '待评测', running: '评测中', done: '完成', failed: '失败' };

function pillHtml(status, text) {
  return `<span class="state-pill ${escapeHtml(status)}">${escapeHtml(text)}</span>`;
}

function countDone(ids, statuses) {
  return ids.filter((id) => {
    const s = statuses[id];
    return s && (s.state === 'done' || s.state === 'failed');
  }).length;
}

// token 摘要：prompt+completion，估算大于 0 时追加 ≈ 标注
function tokensSummary(tk) {
  const t = tk || {};
  const base = `${fmt(t.prompt)}+${fmt(t.completion)}`;
  return (t.est || 0) > 0 ? `${base}（≈${fmt(t.est)}）` : base;
}

// 在 token 摘要后追加会话级累计（statuses[qid].tokensTotal，契约 number|null；缺位不显示）
function tokensSummaryFull(st) {
  const base = tokensSummary(st && st.tokens);
  const total = st && st.tokensTotal;
  return total != null ? `${base} · 会话 ${fmt(total)} tok` : base;
}

/* ---------------- 启动加载器 ---------------- */

async function loadQuestions() {
  try {
    const d = await api('/api/questions');
    questions = { total: d && d.total, questions: (d && d.questions) || [] };
    setText($('datasetBadge'), `${fmt(questions.total != null ? questions.total : questions.questions.length)} 题`);
    fillPersonaSelects();
    renderBank();
  } catch (e) { console.warn('[app] 题库加载失败', e.message || e); }
}

async function loadSummary() {
  try {
    summary = await api('/api/summary');
    renderOverview();
  } catch (e) { console.warn('[app] 汇总加载失败', e.message || e); }
}

async function loadTokens() {
  try {
    tokens = await api('/api/tokens');
    renderTokens();
    renderOverview();   // 总览的 Token/估算两卡也吃 tokens 数据，顺带刷新
  } catch (e) { console.warn('[app] Token 数据加载失败', e.message || e); }
}

async function loadHost() {
  try {
    applyHost(true, await api('/api/host/status'));
  } catch (e) { applyHost(false, null); }
}

async function loadRunState() {
  try {
    applyRunState(await api('/api/run/state'));
  } catch (e) { console.warn('[app] run/state 拉取失败', e.message || e); }
}

// 按名单并行重拉；谁在名单里谁刷新对应页面（调用方不关心失败——loader 内部已兜底）
async function refresh(which) {
  const jobs = [];
  if (which.includes('questions')) jobs.push(loadQuestions());
  if (which.includes('summary')) jobs.push(loadSummary());
  if (which.includes('tokens')) jobs.push(loadTokens());
  await Promise.allSettled(jobs);
}

// 顶栏「刷新」：外部改动 results/logs 文件后无需刷新整个页面；加载中禁用防连点
let refreshing = false;
async function refreshAll() {
  const btn = $('refreshBtn');
  if (!btn || refreshing) return;
  refreshing = true;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    await Promise.allSettled([
      loadQuestions(), loadSummary(), loadTokens(), loadHost(), loadRunState(), loadScoreLabels(), loadProvider(),
    ]);
    await loadAnswersOptions();   // 依赖 runState.exam.outFile，放在最后
  } finally {
    btn.textContent = oldText;
    btn.disabled = false;
    refreshing = false;
  }
}

/* ---------------- 作答文件与判分批次（判分卡/外部卡/评分管理卡共用） ---------------- */

// answers-<label>.jsonl → <label>；与后端 apiJudgeStart 的推导同口径
function answersLabelOf(file) {
  const s = String(file || '');
  return (s.startsWith('answers-') && s.endsWith('.jsonl'))
    ? s.slice('answers-'.length, s.length - '.jsonl'.length)
    : '';
}

// 两个判分入口共用一份作答文件列表；调用时机：启动序列（runState 就位后）、
// exam/judge 结束、评分操作后（契约）。拉取失败只降级为空列表，不阻塞页面
async function loadAnswersOptions() {
  let files = [];
  try {
    const d = await api('/api/answers');
    files = (d && d.files) || [];
  } catch (e) { console.warn('[app] 作答文件列表加载失败', e.message || e); return; }
  const entries = files.map((f) => ({
    value: String(f.file || ''),
    label: `${f.file}（已答 ${fmt(f.answered)}/${fmt(f.rows)}）`,
  }));
  // 空列表也给一条可读的占位项，避免下拉框全白、按钮看似可点却只弹 alert
  if (!entries.length) {
    entries.push({ value: '', label: '暂无作答文件（先跑一轮考试）', disabled: true });
  }
  // 默认选中：当前考试产物 basename 命中列表则选它，否则第一项
  const ex = (runState && runState.exam) || {};
  const base = ex.outFile ? String(ex.outFile).split(/[\\/]/).pop() : null;
  rebuildSelect($('judgeAnswers'), entries, base);
  rebuildSelect($('extAnswers'), entries, base);
  answersFileCount = files.length;
  syncBankResetAvailability();
  syncAnswerActions();
}

// 「全新重置」按钮：只要还有作答或判分批次就可点，不能因为 scored 被清空而禁用
function syncBankResetAvailability() {
  const btn = $('bankResetScores');
  if (btn) btn.disabled = (answersFileCount + scoreLabelCount) === 0;
}

// 作答/外部判分按钮的可用性跟着下拉与粘贴框走：没文件就禁用，别让用户点了才吃 alert
function syncAnswerActions() {
  const ex = (runState && runState.exam) || {};
  const ju = (runState && runState.judge) || {};
  const hasJudgeFile = !!String((($('judgeAnswers') || {}).value) || '');
  const hasExtFile = !!String((($('extAnswers') || {}).value) || '');
  const hasReviews = !!String((($('extReviewsBox') || {}).value) || '').trim();
  const hasPrompt = !!String((($('extPromptBox') || {}).value) || '');
  const judgeBtn = $('judgeBtn');
  if (judgeBtn) judgeBtn.disabled = !hasJudgeFile || !!ex.running || !!ju.running;
  const prep = $('extPrepare');
  if (prep) prep.disabled = !hasExtFile;
  const copy = $('extCopy');
  if (copy) copy.disabled = !hasPrompt;
  const imp = $('extImport');
  if (imp) imp.disabled = !hasReviews;
}

async function loadScoreLabels() {
  let labels = [];
  try {
    const d = await api('/api/score/labels');
    labels = (d && d.labels) || [];
  } catch (e) { console.warn('[app] 判分批次列表加载失败', e.message || e); }
  const entries = labels.length
    ? labels.map((l) => ({ value: String(l.label), label: String(l.label) }))
    : [{ value: '', label: '暂无判分批次', disabled: true }];
  rebuildSelect($('scoreLabel'), entries, null);
  const empty = !labels.length;
  for (const id of ['scoreRescore', 'scoreReset']) { const b = $(id); if (b) b.disabled = empty; }
  scoreLabelCount = labels.length;
  syncBankResetAvailability();
  setText($('scoreManageInfo'), empty ? '暂无判分批次（完成一次判分后出现）' : `共 ${fmt(labels.length)} 个批次`);
}

// 评分管理卡两个按钮的公共前置：批次下拉为空时按钮已 disable，这里只做防御
function scoreLabelValue() {
  const v = (($('scoreLabel') || {}).value || '').trim();
  if (!v) { alert('请先选择判分批次'); return ''; }
  return v;
}

/* ---------------- 宿主状态 ---------------- */

// up 决定 .ok/.bad、横幅显隐与 #runGo 可用性；up 但没拿到 cookie 时给 .warn 提示
function applyHost(up, info) {
  const dot = $('hostDot');
  if (dot) {
    dot.classList.remove('ok', 'warn', 'bad');
    dot.classList.add(up ? (info && info.cookie === false ? 'warn' : 'ok') : 'bad');
  }
  const port = info && info.port != null ? info.port : '?';
  // 文案带全地址，避免只剩「:端口」看着像漏了主机名
  const addr = `127.0.0.1:${port}`;
  setText($('hostText'), up
    ? (info && info.cookie === false ? `在线 ${addr}（未取得 cookie）` : `宿主在线 ${addr}`)
    : '宿主离线');
  const banner = $('hostBanner');
  if (banner) banner.classList.toggle('hidden', !!up);
  const go = $('runGo');
  if (go) go.disabled = !up;
}

/* ---------------- 总览 ---------------- */

function renderOverview() {
  const t = (summary && summary.totals) || {};
  setText($('statAnswered'), fmt(t.answered));
  setText($('statScored'), fmt(t.scored));
  setText($('statPassed'), fmt(t.passed));
  setText($('statPassRate'), t.scored > 0 ? `${((t.passed / t.scored) * 100).toFixed(1)}%` : '—');
  const tt = (tokens && tokens.totals) || {};
  setText($('statTokens'), fmt((tt.promptReal || 0) + (tt.completionReal || 0)));
  setText($('statTokensSub'), `≈${fmt((tt.promptEst || 0) + (tt.completionEst || 0))}`);
  renderMiniCard();
  renderStatusBar();
  renderLastRun();
  renderLatestJudge();
  const groups = (summary && summary.latest && summary.latest.groups) || {};
  renderGroupChart($('chartPersona'), groups.persona);
  renderGroupChart($('chartTags'), groups.content_tags, { topByPassed: 12 });
  renderGroupChart($('chartInterval'), groups.interval_days, { sort: 'numeric' });
  renderFlagsChart();
}

// 题库状态分布：四段堆叠条 + 图例（与题库筛选同一口径）
function renderStatusBar() {
  const bar = $('statusBar');
  const legend = $('statusCounts');
  if (!bar || !legend) return;
  const qs = (questions && questions.questions) || [];
  const count = { pending: 0, answered: 0, passed: 0, failed: 0 };
  for (const q of qs) if (count[q.status] != null) count[q.status] += 1;
  const total = qs.length || 1;
  bar.innerHTML = ['pending', 'answered', 'passed', 'failed']
    .map((k) => `<div class="seg ${k}" style="width:${((count[k] / total) * 100).toFixed(2)}%" title="${BANK_STATE_TEXT[k]} ${fmt(count[k])}"></div>`)
    .join('');
  legend.innerHTML = ['pending', 'answered', 'passed', 'failed']
    .map((k) => `<span><i class="dot-inline seg ${k}"></i>${BANK_STATE_TEXT[k]} <b>${fmt(count[k])}</b></span>`)
    .join('');
}

// 最近一次考试卡（/api/tokens.runs[0]；点击下方按钮跳 Token 页看明细）
function renderLastRun() {
  const el = $('lastRunBody');
  if (!el) return;
  const runs = (tokens && Array.isArray(tokens.runs)) ? tokens.runs : [];
  if (!runs.length) { el.textContent = '暂无考试记录（每次考试结束后自动生成）'; return; }
  const r = runs[0];
  const tk = r.totals || {};
  const prompt = (Number(tk.input) || 0) + (Number(tk.cacheHit) || 0) + (Number(tk.cacheWrite) || 0);
  el.innerHTML = '<dl class="kv">' +
    `<dt>结束时间</dt><dd class="mono">${escapeHtml(shortTs(r.ts))}</dd>` +
    `<dt>题数</dt><dd>${fmt(r.questionCount)}</dd>` +
    `<dt>输入合计</dt><dd class="mono">${fmt(prompt)}（命中 ${Number.isFinite(tk.hitRate) ? (tk.hitRate * 100).toFixed(1) + '%' : '—'}）</dd>` +
    `<dt>输出</dt><dd class="mono">${fmt(tk.output)}</dd>` +
    '</dl>';
}

// 最近判分批次卡（summary.latest 为 mtime 最新的 summary 快照）
function renderLatestJudge() {
  const el = $('latestJudgeBody');
  if (!el) return;
  const latest = summary && summary.latest;
  if (!latest) { el.textContent = '暂无判分批次（判分后自动生成）'; return; }
  el.innerHTML = '<dl class="kv">' +
    `<dt>批次</dt><dd class="mono">${escapeHtml(String((summary && summary.latestFile) || '—'))}</dd>` +
    `<dt>成绩</dt><dd><b>${fmt(latest.passed)}</b> / ${fmt(latest.scored)} 通过（题库 ${fmt(latest.dataset_questions)} 题）</dd>` +
    '</dl>';
}

// 判分错误分类图（/api/summary.flags；按次数降序，条宽相对最大值）
function renderFlagsChart() {
  const el = $('chartFlags');
  if (!el) return;
  const flags = (summary && summary.flags) || {};
  const items = Object.entries(flags)
    .map(([key, value]) => ({ key, value: Number(value) || 0 }))
    .sort((a, b) => b.value - a.value);
  // 全零时不要画一排空条：那会让"还没判分"看起来像"八项全是 0 次"
  if (!items.length || items.every((i) => i.value === 0)) {
    el.innerHTML = '<div class="empty">暂无判分数据（完成一次判分后自动生成）</div>';
    return;
  }
  renderValueBars(el, items);
}

// 迷你跑批卡：考试或判分任一在跑就显示，进度条按各自口径
function renderMiniCard() {
  const card = $('runMiniCard');
  if (!card) return;
  const rs = runState || {};
  const ex = rs.exam || {};
  const ju = rs.judge || {};
  const examRunning = !!ex.running;
  const judgeRunning = !!ju.running;
  card.classList.toggle('hidden', !(examRunning || judgeRunning));
  if (examRunning) {
    const ids = ex.ids || [];
    const done = countDone(ids, ex.statuses || {});
    const preparing = ex.phase === 'prepare';
    if (preparing && ex.prepareTotal) {
      setFill('miniFill', ((ex.prepareDone || 0) / ex.prepareTotal) * 100);
      setText($('miniText'), `重建记忆 ${ex.prepareDone || 0}/${ex.prepareTotal} · ${ex.label || ''}`);
    } else {
      setFill('miniFill', ids.length ? (done / ids.length) * 100 : 0);
      setText($('miniText'), `考试 ${ex.label || ''} · ${done}/${ids.length}`);
    }
  } else if (judgeRunning) {
    const bt = ju.batchesTotal || 0;
    const cb = ju.currentBatch || 0;
    setFill('miniFill', bt ? (cb / bt) * 100 : 0);
    setText($('miniText'), `判分 ${ju.label || ''} · ${cb}/${bt}`);
  }
}

// 分组条形图：条宽 = 通过率（与卡片标题「通过率」及 style.css 的 ok/warn 皮肤对齐），
// 数值列给 通过/总 原始数。皮肤阈值：≥70% 绿、<50% 黄，中间用默认渐变
function renderGroupChart(el, group, opts = {}) {
  if (!el) return;
  let entries = Object.entries(group || {}).map(([key, v]) => ({
    key: String(key),
    total: (v && v.total) || 0,
    passed: (v && v.passed) || 0,
  }));
  if (!entries.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  if (opts.topByPassed) {
    // 考点标签只取通过数 top N，其余并入「其它」——组键可能几十个，一屏放不下
    entries.sort((a, b) => b.passed - a.passed || b.total - a.total || a.key.localeCompare(b.key, 'zh-CN'));
    if (entries.length > opts.topByPassed) {
      const rest = entries.slice(opts.topByPassed);
      const agg = rest.reduce((a, e) => ({ total: a.total + e.total, passed: a.passed + e.passed }), { total: 0, passed: 0 });
      entries = entries.slice(0, opts.topByPassed).concat([{ key: `其它（${rest.length} 项）`, ...agg }]);
    }
  } else if (opts.sort === 'numeric') {
    // 间隔天数按数值升序，避免 "100" 排在 "30" 前面的字符串序问题
    entries.sort((a, b) => (parseFloat(a.key) - parseFloat(b.key)) || a.key.localeCompare(b.key, 'zh-CN'));
  } else {
    entries.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key, 'zh-CN'));
  }
  el.innerHTML = entries.map((e) => {
    const rate = e.total > 0 ? e.passed / e.total : 0;
    const tone = e.total > 0 && rate >= 0.7 ? ' ok' : (e.total > 0 && rate < 0.5 ? ' warn' : '');
    return `<div class="bar-row">` +
      `<span class="bar-label" title="${escapeHtml(e.key)}">${escapeHtml(e.key)}</span>` +
      `<div class="bar-track"><div class="bar-fill${tone}" style="width:${(rate * 100).toFixed(1)}%"></div></div>` +
      `<span class="bar-value">${fmt(e.passed)} / ${fmt(e.total)}</span>` +
      `</div>`;
  }).join('');
}

// Token 用途/模型图：按 prompt+completion+est 合计降序，条宽相对最大值
function renderValueBars(el, items) {
  if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const max = Math.max(...items.map((i) => i.value), 1);
  el.innerHTML = items.map((i) =>
    `<div class="bar-row">` +
    `<span class="bar-label" title="${escapeHtml(i.key)}">${escapeHtml(i.key)}</span>` +
    `<div class="bar-track"><div class="bar-fill" style="width:${((i.value / max) * 100).toFixed(1)}%"></div></div>` +
    `<span class="bar-value">${fmt(i.value)}</span>` +
    `</div>`
  ).join('');
}

/* ---------------- 题库 ---------------- */

function fillPersonaSelects() {
  const counts = new Map();
  for (const q of questions.questions) {
    const p = q.persona == null || q.persona === '' ? '（未知）' : String(q.persona);
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  personaCounts = counts;
  const entries = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
    .map(([p, c]) => ({ value: p, label: `${p}（${c} 题）` }));
  fillSelect($('bankPersona'), entries, '全部');
  // 运行页：多选 chips（全部组 / 各组），跨组一次跑
  const valid = new Set(entries.map((e) => e.value));
  for (const p of [...selectedPersonas]) if (!valid.has(p)) selectedPersonas.delete(p);
  if (!selectedPersonas.size && entries.length) selectedPersonas.add(entries[0].value);
  renderPersonaChips();
  updateRunTotalHint();
}

function renderPersonaChips() {
  const box = $('runPersonaChips');
  if (!box) return;
  const entries = [...personaCounts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  const allOn = entries.length > 0 && entries.every(([p]) => selectedPersonas.has(p));
  box.innerHTML =
    `<button class="chip${allOn ? ' active' : ''}" data-persona="*">全部组</button>` +
    entries.map(([p, c]) =>
      `<button class="chip${selectedPersonas.has(p) ? ' active' : ''}" data-persona="${escapeHtml(p)}">${escapeHtml(p)}（${c}）</button>`
    ).join('');
}

// 只增不改：保留 HTML 里已有的 option（含选中态），缺失的才补
function fillSelect(sel, entries, allLabel) {
  if (!sel) return;
  const existing = () => [...sel.options];
  if (allLabel != null && !existing().some((o) => o.value === '' || (o.textContent || '').includes('全部'))) {
    sel.add(new Option(allLabel, ''), sel.firstChild);
  }
  const has = new Set(existing().map((o) => o.value));
  for (const e of entries) {
    if (!has.has(e.value)) sel.add(new Option(e.label, e.value));
  }
}

// 全量重建型下拉：作答文件/判分批次这类"整体换代"的列表不适用 fillSelect——
// 选项文案里的读数（已答数/批次）会随跑批变化，只增不改会留下陈旧行。
// preferred 命中列表才选中，否则落第一项（契约的默认选中规则）
function rebuildSelect(sel, entries, preferred) {
  if (!sel) return;
  sel.innerHTML = '';
  const values = entries.map((e) => e.value);
  for (const e of entries) {
    const opt = new Option(e.label, e.value);
    if (e.disabled) opt.disabled = true;   // 空态占位项：可见但不可选，value 为空让按钮随之禁用
    sel.add(opt);
  }
  sel.value = (preferred != null && values.includes(preferred)) ? preferred : (values.length ? values[0] : '');
}

function filteredQuestions() {
  const kw = (($('bankSearch') || {}).value || '').trim().toLowerCase();
  const persona = ($('bankPersona') || {}).value || '';
  const status = ($('bankStatus') || {}).value || '';
  // 客户端过滤：题库总量 714，一次性过滤无压力
  return questions.questions.filter((q) => {
    if (persona && String(q.persona) !== persona) return false;
    if (status && q.status !== status) return false;
    if (kw && !String(q.id).toLowerCase().includes(kw) && !String(q.question || '').toLowerCase().includes(kw)) return false;
    return true;
  });
}

function renderBank() {
  const body = $('bankBody');
  if (!body) return;
  const kw = (($('bankSearch') || {}).value || '').trim();
  const persona = ($('bankPersona') || {}).value || '';
  const status = ($('bankStatus') || {}).value || '';
  const list = filteredQuestions();
  setText($('bankCount'), `共 ${fmt(list.length)} 题`);
  // 无结果时整表收起，只留一条空态，避免表头孤零零挂着
  setHidden($('bankTable'), list.length === 0);
  setHidden($('bankEmpty'), list.length > 0);
  const clear = $('bankClear');
  if (clear) clear.disabled = !(kw || persona || status);
  // 列顺序与 index.html thead 逐一对应：勾选/ID/Persona/Cutoff/间隔/考点/状态/题目
  body.innerHTML = list.map((q) => {
    const st = q.status || 'pending';
    const tags = (q.content_tags || []).join('、');
    return `<tr data-qid="${escapeHtml(q.id)}">` +
      `<td class="col-select"><input type="checkbox" data-qselect="${escapeHtml(q.id)}"${selectedQids.has(q.id) ? ' checked' : ''}></td>` +
      `<td class="mono">${escapeHtml(q.id)}</td>` +
      `<td>${escapeHtml(q.persona ?? '—')}</td>` +
      `<td class="mono">${escapeHtml(q.cutoff_turn ?? '—')}</td>` +
      `<td>${escapeHtml(q.interval_days ?? '—')}</td>` +
      `<td title="${escapeHtml(tags)}">${escapeHtml(tags)}</td>` +
      `<td>${pillHtml(st, BANK_STATE_TEXT[st] || st)}</td>` +
      `<td title="${escapeHtml(q.question || '')}">${escapeHtml(truncate(q.question, 60))}</td>` +
      `</tr>`;
  }).join('');
  syncBankSelection(list);
}

// 勾选状态与按钮/全选框同步：全选只在“当前筛选结果”范围内生效
function syncBankSelection(list = filteredQuestions()) {
  const btn = $('bankRunSelected');
  if (btn) {
    btn.disabled = selectedQids.size === 0;
    btn.textContent = `运行选中（${fmt(selectedQids.size)}）`;
  }
  const allBox = $('bankSelectAll');
  if (allBox) {
    const picked = list.filter((q) => selectedQids.has(q.id)).length;
    allBox.checked = list.length > 0 && picked === list.length;
    allBox.indeterminate = picked > 0 && picked < list.length;
  }
}

function bindBank() {
  fillSelect($('bankStatus'), [
    { value: 'pending', label: '未作答' },
    { value: 'answered', label: '已作答' },
    { value: 'passed', label: '通过' },
    { value: 'failed', label: '未通过' },
  ], '全部');
  const rerender = () => renderBank();
  const search = $('bankSearch');
  if (search) search.addEventListener('input', rerender);
  const persona = $('bankPersona');
  if (persona) persona.addEventListener('change', rerender);
  const status = $('bankStatus');
  if (status) status.addEventListener('change', rerender);
  // 一键清空三个筛选条件；按钮只在有筛选时可用
  const clear = $('bankClear');
  if (clear) clear.addEventListener('click', () => {
    if (search) search.value = '';
    if (persona) persona.value = '';
    if (status) status.value = '';
    renderBank();
  });
  // 题库页顶部的一键清空判分（跨全部批次；默认保留 reviews，便于复盘）
  const resetScores = $('bankResetScores');
  if (resetScores) resetScores.addEventListener('click', resetAllScores);
  // 全选只作用于当前筛选结果；逐题勾选走 tbody 委托，行内容重绘后监听仍在
  const allBox = $('bankSelectAll');
  if (allBox) allBox.addEventListener('change', () => {
    const list = filteredQuestions();
    for (const q of list) {
      if (allBox.checked) selectedQids.add(q.id);
      else selectedQids.delete(q.id);
    }
    renderBank();
  });
  const runSelected = $('bankRunSelected');
  if (runSelected) runSelected.addEventListener('click', () => {
    const ids = questions.questions
      .filter((q) => selectedQids.has(q.id))
      .map((q) => q.id);
    startRunIds(ids, { source: '题库选中' });
  });
  // 行点击委托在 tbody 上：行内容整体重绘后监听仍在
  const body = $('bankBody');
  if (body) {
    body.addEventListener('click', (e) => {
      if (e.target.closest('input[type="checkbox"]')) return;   // 勾选不打开抽屉
      const tr = e.target.closest('tr[data-qid]');
      if (tr) openDrawer(tr.getAttribute('data-qid'));
    });
    body.addEventListener('change', (e) => {
      const box = e.target.closest('[data-qselect]');
      if (!box) return;
      const qid = box.getAttribute('data-qselect');
      if (box.checked) selectedQids.add(qid);
      else selectedQids.delete(qid);
      syncBankSelection();
    });
  }
}

/* ---------------- 抽屉（题目详情） ---------------- */

let drawerOpenQid = null;

async function openDrawer(qid) {
  const drawer = $('drawer');
  if (!drawer) return;
  drawerOpenQid = qid;
  drawerEditMode = false;   // 重开抽屉即退出编辑态：编辑器只在「修改判分」点击后出现
  setText($('drawerTitle'), qid);
  const body = $('drawerBody');
  if (body) body.innerHTML = '<div class="empty">加载中…</div>';
  drawer.classList.add('open');
  document.body.classList.add('drawer-open');   // 锁住背后页面滚动，抽屉自身仍可滚
  try {
    const d = await api('/api/questions/' + encodeURIComponent(qid));
    if (drawerOpenQid !== qid) return;   // 用户已切走，丢弃过期响应
    renderDrawerDetail(d);
  } catch (e) {
    if (drawerOpenQid !== qid) return;
    if (body) body.innerHTML = `<div class="empty">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function closeDrawer() {
  // 判分编辑未保存时先确认：Esc/背景点击/关闭钮都不该静默丢改动
  if (drawerEditMode && !confirm('判分修改尚未保存，确定关闭抽屉？')) return;
  drawerEditMode = false;
  drawerOpenQid = null;
  const drawer = $('drawer');
  if (drawer) drawer.classList.remove('open');
  document.body.classList.remove('drawer-open');
}

function bindDrawer() {
  // drawerClose 自带 data-action=close-drawer，两路绑定幂等
  const close = $('drawerClose');
  if (close) close.addEventListener('click', closeDrawer);
  document.querySelectorAll('[data-action="close-drawer"]').forEach((el) => el.addEventListener('click', closeDrawer));
  const drawer = $('drawer');
  if (drawer) drawer.addEventListener('click', (e) => { if (e.target === drawer) closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  // 评分编辑器的三个按钮走委托：判分区整体重绘后监听仍在（与 bankBody 同一套路）
  const body = $('drawerBody');
  if (body) {
    body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="edit-score"],[data-action="save-score"],[data-action="cancel-edit-score"],[data-action="reset-question"],[data-action="retest-question"]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      if (action === 'edit-score') {
        if (drawerDetail && drawerDetail.review) { drawerEditMode = true; renderDrawerDetail(drawerDetail); }
      } else if (action === 'cancel-edit-score') {
        drawerEditMode = false;
        if (drawerDetail) renderDrawerDetail(drawerDetail);   // 不发请求，直接回滚到缓存详情
      } else if (action === 'save-score') {
        saveScoreEdit();
      } else if (action === 'reset-question') {
        resetQuestionStatus();
      } else if (action === 'retest-question') {
        retestQuestion();
      }
    });
  }
}

// 重置本题状态：从全部 answers/packets/reviews/scored 文件剔除该题（summary 快照不动），
// 题库回落「未作答」——反复重测同一题的入口，重置后从题库/运行页重新发起即可
async function resetQuestionStatus() {
  const qid = drawerOpenQid;
  if (!qid) return;
  if (!confirm(`重置「${qid}」的状态？\n将从所有作答/判分文件中剔除该题（作答记录不保留；summary 快照不动），之后可重新考试本题。`)) return;
  try {
    const d = await api('/api/questions/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: qid }),
    });
    alert(`已重置：改动 ${(d.changed || []).length} 个文件，剔除 ${fmt(d.removed)} 行`);
    refresh(['questions', 'summary', 'tokens']);
    closeDrawer();
  } catch (e) { alert(`重置失败：${e.message}`); }
}

// 单测本题：只考这一题（独立 1 题批次），成功后跳运行页看进度
async function retestQuestion() {
  const qid = drawerOpenQid;
  if (!qid) return;
  if (!confirm(`单独考试「${qid}」？\n将创建 1 题的新批次，消耗共享 LLM 额度。`)) return;
  try {
    await api('/api/run/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [qid] }),
    });
    closeDrawer();
    activateTab('run');
    await loadRunState();
  } catch (e) { alert(`启动失败：${e.message}`); }
}

function renderDrawerDetail(d) {
  const body = $('drawerBody');
  if (!body) return;
  drawerDetail = d;   // 缓存给评分编辑器：取消编辑时不重新请求即可回滚
  const rubric = d.rubric || {};
  const parts = [];
  // 键值行：style.css 优先 dl>dt+dd 结构；会话/本题 token 为新增行，详情缺位就不给
  const kvRows = [
    ['Persona', d.persona],
    ['题面时间', d.now],
    ['截止轮次', d.cutoff_turn],
    ['间隔天数', d.interval_days],
  ];
  if (d.sessionId != null && d.sessionId !== '') kvRows.push(['会话', d.sessionId, true]);
  if (d.tokens && typeof d.tokens === 'object') {
    const tk = d.tokens;
    const cell = (v) => (v == null ? '—' : fmt(v));
    kvRows.push(['本题 token', `输入 ${cell(tk.input)} / 命中 ${cell(tk.cacheHit)} / 输出 ${cell(tk.output)}`]);
  }
  parts.push(`<dl class="kv">${kvRows.filter(([, v]) => v != null && v !== '')
    .map(([k, v, mono]) => `<dt>${escapeHtml(k)}</dt><dd${mono ? ' class="mono"' : ''}>${escapeHtml(String(v))}</dd>`)
    .join('')}</dl>`);
  // 反复重测入口：单测本题（独立 1 题批次）与重置本题状态（从作答/判分文件剔除，回落未作答）
  parts.push(`<div class="form-actions drawer-actions">` +
    `<button class="btn" data-action="retest-question">单测本题</button>` +
    `<button class="btn btn-danger" data-action="reset-question">重置本题状态</button>` +
    `</div>`);
  parts.push(dSection('题面', `<div style="white-space:pre-wrap;word-break:break-word">${escapeHtml(asText(d.question))}</div>`));
  parts.push(dSection('评分要点（rubric）',
    rubricGroup('必答', rubric.required) +
    rubricGroup('可接受', rubric.acceptable) +
    rubricGroup('未知需澄清', rubric.unknown) +
    rubricGroup('禁止', rubric.forbidden)));
  if (d.facts && d.facts.length) {
    parts.push(dSection('关键事实',
      `<ul style="margin:4px 0 0;padding-left:18px">${d.facts.map((f) => `<li>${escapeHtml(asText(f))}</li>`).join('')}</ul>`));
  }
  if (d.sources && d.sources.length) {
    parts.push(dSection('对话引文', d.sources.map(renderQuote).join('')));
  }
  const ans = asText(d.answer).trim();
  parts.push(dSection('作答', `<div class="answer-block">${escapeHtml(ans || '（无作答）')}</div>`));
  // 判分区：浏览态尾部带「修改判分」入口；编辑态整体换成表单（保存/取消在表单内）
  if (d.review) {
    parts.push(drawerEditMode
      ? dSection('判分（编辑中）', renderScoreEditor(d))
      : dSection('判分', renderReview(d, rubric) +
        `<div style="margin-top:12px"><button class="btn" data-action="edit-score">修改判分</button></div>`));
  }
  body.innerHTML = parts.join('');
}

function dSection(title, inner) {
  return `<h4 style="margin:14px 0 6px">${escapeHtml(title)}</h4>${inner}<div class="section-gap"></div>`;
}

function rubricGroup(title, arr) {
  const items = Array.isArray(arr) ? arr : [];
  const inner = items.length
    ? `<ul>${items.map((x) => `<li>${escapeHtml(asText(x))}</li>`).join('')}</ul>`
    : '<div style="color:var(--muted)">（无）</div>';
  return `<div class="rubric-group"><h4>${escapeHtml(title)}</h4>${inner}</div>`;
}

// 引文：引文正文 + 轮次/时间/说话人小字（键名做防御性解析，形状契约未定死）
function renderQuote(s) {
  if (typeof s === 'string') return `<div class="quote">${escapeHtml(s)}</div>`;
  const text = asText(pick(s, ['quote', 'text', 'content', 'line', 'body']));
  const bits = [];
  const turn = pick(s, ['turn', 'cutoff_turn', 'round']);
  if (turn != null && turn !== '') bits.push(`第 ${turn} 轮`);
  const time = pick(s, ['time', 'ts', 'at', 'now']);
  if (time != null && time !== '') bits.push(String(time));
  const speaker = pick(s, ['speaker', 'who', 'role', 'name']);
  if (speaker != null && speaker !== '') bits.push(String(speaker));
  const meta = bits.map(escapeHtml).join(' · ');
  return `<div class="quote"><div>${escapeHtml(text)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</div>`;
}

/* ---------------- 判分区（review 渲染） ---------------- */

// review 子结构键名已定死为中文键（scored 行原文如此，也是 /api/score/edit 的 patch 键）：
// 中文键放候选首位保证命中；英文变体只作历史兼容候选，pick 按顺序取第一个非空值
const REVIEW_REQUIRED_KEYS = ['required', 'required_results', 'required_checks', 'required_pass'];
const REVIEW_FLAGS = [
  ['错认', ['错认', 'misidentify', 'misidentified', 'misidentification', 'misrecognize', 'wrong_belief', 'wrong_recognition']],
  ['错否', ['错否', 'wrong_refusal', 'wrong_deny', 'wrong_denial', 'wrongly_refused', 'false_refusal', 'refused_incorrectly']],
  ['越界', ['越界', 'out_of_scope', 'overreach', 'beyond_scope', 'scope_violation', 'boundary_violation']],
  ['编造日期', ['编造日期', 'fabricated_date', 'fabricated_dates', 'made_up_date', 'made_up_dates', 'invented_date', 'date_fabrication']],
  ['不当私事披露', ['不当私事披露', 'improper_private_disclosure', 'private_disclosure', 'privacy_disclosure', 'privacy_leak', 'improper_disclosure', 'disclosed_private_matters']],
];
const REVIEW_LISTS = [
  ['违反禁止', ['违反禁止', 'forbidden_violations', 'violated_forbidden', 'forbidden_breaches']],
  ['未知当事实', ['未知当事实', 'unknown_as_fact', 'unknown_asserted', 'unknown_treated_as_fact']],
  ['无关旧事', ['无关旧事', 'irrelevant_old_events', 'irrelevant_olds', 'irrelevant_old_matters', 'irrelevant_history']],
];
const REVIEW_REASON_KEYS = ['reason', 'summary', 'comment', 'explanation', 'note'];

function renderReview(d, rubric) {
  const r = d.review || {};
  const parts = [];
  // required 逐项 ✓/✗：以 rubric.required 文案为轴，review 侧布尔数组按下标对齐；
  // 两侧长度不齐时缺位显示 —，多余项以「第 N 项」补出
  const reqArr = pick(r, REVIEW_REQUIRED_KEYS);
  if (Array.isArray(reqArr)) {
    const names = Array.isArray(rubric && rubric.required) ? rubric.required : [];
    const n = Math.max(names.length, reqArr.length);
    const lis = [];
    for (let i = 0; i < n; i++) {
      const v = reqArr[i];
      const mark = v === false
        ? '<span style="color:var(--bad)">✗</span>'
        : (v == null ? '<span style="color:var(--muted)">—</span>' : '<span style="color:var(--ok)">✓</span>');
      lis.push(`<li>${mark} ${escapeHtml(names[i] != null ? asText(names[i]) : `第 ${i + 1} 项`)}</li>`);
    }
    parts.push(`<ul style="margin:6px 0 0;padding-left:18px;list-style:none">${lis.join('')}</ul>`);
  }
  // 五个布尔旗帜：true=该问题成立（红），false=未发生（绿），未知=灰
  const flagSrc = (r.flags && typeof r.flags === 'object' && !Array.isArray(r.flags)) ? r.flags : r;
  parts.push(`<div style="margin-top:8px">${REVIEW_FLAGS.map(([label, keys]) => {
    const v = pick(flagSrc, keys);
    const val = v === true
      ? '<span class="bad">是</span>'
      : (v === false ? '<span class="ok">否</span>' : '<span style="color:var(--muted)">—</span>');
    return `<div class="flag-row"><span>${escapeHtml(label)}</span>${val}</div>`;
  }).join('')}</div>`);
  // 三个列表字段：空/缺省显示「无」
  parts.push(REVIEW_LISTS.map(([label, keys]) => {
    const v = pick(r, keys);
    const items = Array.isArray(v) ? v : (v != null ? [v] : []);
    const inner = items.length
      ? `<ul style="margin:4px 0 0;padding-left:18px">${items.map((x) => `<li>${escapeHtml(asText(x))}</li>`).join('')}</ul>`
      : '<div style="color:var(--muted)">无</div>';
    return `<div style="margin-top:10px"><div style="color:var(--muted);font-size:12px">${escapeHtml(label)}</div>${inner}</div>`;
  }).join(''));
  // 三个 pass pill
  const passPill = (v, label) => {
    const cls = v === true ? 'passed' : (v === false ? 'failed' : 'pending');
    const txt = v === true ? '通过' : (v === false ? '未通过' : '—');
    return `<span class="state-pill ${cls}">${escapeHtml(label)} · ${txt}</span>`;
  };
  parts.push(`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">` +
    passPill(r.factual_pass, '事实性') +
    passPill(r.relevance_pass, '相关性') +
    passPill(r.pass, '总体') +
    `</div>`);
  const reason = pick(r, REVIEW_REASON_KEYS);
  if (reason) parts.push(`<p style="margin-top:10px;white-space:pre-wrap;word-break:break-word">${escapeHtml(asText(reason))}</p>`);
  return parts.join('');
}

/* ---------------- 评分编辑器（抽屉内联，patch 走 /api/score/edit） ---------------- */

// 判分区原位替换成表单：初始值全部来自 review（scored 行）本身，取消不发请求直接回滚。
// patch 键与 scored 行同形：required(bool[])、五旗帜(bool)、三列表(非空字符串数组)、reason(非空字符串)
function renderScoreEditor(d) {
  const rubric = d.rubric || {};
  const r = d.review || {};
  const reqNames = Array.isArray(rubric.required) ? rubric.required : [];
  const reqValsRaw = pick(r, REVIEW_REQUIRED_KEYS);
  const reqVals = Array.isArray(reqValsRaw) ? reqValsRaw : [];
  const reqN = Math.max(reqNames.length, reqVals.length);
  const reqBoxes = [];
  for (let i = 0; i < reqN; i++) {
    const label = reqNames[i] != null ? asText(reqNames[i]) : `第 ${i + 1} 项`;
    const checked = reqVals[i] === true ? ' checked' : '';
    reqBoxes.push(`<label class="flag-row"><input type="checkbox" data-field="required"${checked}> ${escapeHtml(label)}</label>`);
  }
  const flags = REVIEW_FLAGS.map(([label, keys]) => {
    const checked = pick(r, keys) === true ? ' checked' : '';
    return `<label class="flag-row"><input type="checkbox" data-field="flag" data-key="${escapeHtml(label)}"${checked}> ${escapeHtml(label)}</label>`;
  }).join('');
  const lists = REVIEW_LISTS.map(([label, keys]) => {
    const v = pick(r, keys);
    const items = Array.isArray(v) ? v : (v != null ? [v] : []);
    return `<div style="margin-top:10px"><div style="color:var(--muted);font-size:12px">${escapeHtml(label)}（每行一项，留空 = 无）</div>` +
      `<textarea data-field="list" data-key="${escapeHtml(label)}" rows="${Math.max(2, items.length + 1)}" style="width:100%;margin-top:4px">${escapeHtml(items.map(asText).join('\n'))}</textarea></div>`;
  }).join('');
  const reason = asText(pick(r, REVIEW_REASON_KEYS));
  return `<div id="scoreEditor">` +
    `<div style="color:var(--muted);font-size:12px">必答要点（勾选 = 该项通过）</div>` +
    (reqBoxes.length ? reqBoxes.join('') : '<div style="color:var(--muted)">（rubric 无必答要点）</div>') +
    `<div style="margin-top:10px;color:var(--muted);font-size:12px">问题旗帜（勾选 = 该问题成立）</div>` + flags +
    lists +
    `<div style="margin-top:10px"><div style="color:var(--muted);font-size:12px">判分理由（不能为空）</div>` +
    `<textarea data-field="reason" rows="4" style="width:100%;margin-top:4px">${escapeHtml(reason)}</textarea></div>` +
    `<div style="display:flex;gap:8px;margin-top:12px">` +
    `<button class="btn btn-primary" data-action="save-score">保存</button>` +
    `<button class="btn" data-action="cancel-edit-score">取消</button>` +
    `</div></div>`;
}

// label 从详情的 scoredFile 推导（scored-<label>.jsonl），与 answersLabelOf 同一套口径
async function saveScoreEdit() {
  const d = drawerDetail;
  const qid = drawerOpenQid;
  if (!d || !d.review || !qid) return;
  const body = $('drawerBody');
  if (!body) return;
  const sf = String(d.scoredFile || '');
  const label = (sf.startsWith('scored-') && sf.endsWith('.jsonl'))
    ? sf.slice('scored-'.length, sf.length - '.jsonl'.length)
    : '';
  if (!label) { alert('详情缺少 scoredFile，无法定位判分批次'); return; }
  // checkbox 按 DOM 顺序收集 = rubric.required 下标顺序；三列表逐行 trim、去空行（契约：非空字符串数组）
  const patch = {
    required: [...body.querySelectorAll('input[data-field="required"]')].map((el) => el.checked),
    reason: ((body.querySelector('textarea[data-field="reason"]') || {}).value || '').trim(),
  };
  body.querySelectorAll('input[data-field="flag"]').forEach((el) => { patch[el.dataset.key] = el.checked; });
  body.querySelectorAll('textarea[data-field="list"]').forEach((el) => {
    patch[el.dataset.key] = el.value.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  });
  try {
    await api('/api/score/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, id: d.id, patch }),
    });
    drawerEditMode = false;
    await openDrawer(qid);      // 重拉详情重渲染抽屉（拿到后端回算后的新判分）
    refresh(['summary', 'questions']);
  } catch (e) { alert(`保存判分失败：${e.message}`); }
}

/* ---------------- 运行页 ---------------- */

function bindRunPage() {
  const chips = [...document.querySelectorAll('#countChips .chip[data-count]')];
  // HTML 预置了 active 档（3）；尊重预置，没有才补第一档
  const pre = chips.find((c) => c.classList.contains('active'));
  if (pre) activeChip = pre.dataset.count;
  chips.forEach((ch) => ch.addEventListener('click', () => {
    chips.forEach((c) => c.classList.toggle('active', c === ch));
    activeChip = ch.dataset.count;
    const custom = $('countCustom');
    if (custom) custom.value = activeChip === 'all'
      ? String(selectedPersonaTotalCount())
      : activeChip;
    updateRunTotalHint();
  }));
  // 手动改数字时取消 chip 高亮：否则显示"3"高亮、实际按 7 跑，读数与行为不一致
  const customCount = $('countCustom');
  if (customCount) customCount.addEventListener('input', () => {
    if (!customCount.value.trim()) return;
    chips.forEach((c) => c.classList.remove('active'));
    activeChip = null;
    updateRunTotalHint();
  });
  const startInput = $('runStart');
  if (startInput) startInput.addEventListener('input', updateRunTotalHint);
  // Persona 多选 chips：点「全部组」全选/清空，点具体组切换该组
  const personaBox = $('runPersonaChips');
  if (personaBox) personaBox.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-persona]');
    if (!chip) return;
    const value = chip.getAttribute('data-persona');
    if (value === '*') {
      const allOn = [...personaCounts.keys()].every((p) => selectedPersonas.has(p));
      selectedPersonas = allOn ? new Set() : new Set(personaCounts.keys());
    } else if (selectedPersonas.has(value)) {
      selectedPersonas.delete(value);
    } else {
      selectedPersonas.add(value);
    }
    renderPersonaChips();
    // 「全部」档显示的是所选组的总题数（全部组时就是 714），不是单组最大值
    if (activeChip === 'all') {
      const custom = $('countCustom');
      if (custom) custom.value = String(selectedPersonaTotalCount());
    }
    updateRunTotalHint();
  });
  const go = $('runGo');
  if (go) go.addEventListener('click', () => { startRun(); });
  const stop = $('runStop');
  if (stop) stop.addEventListener('click', () => { stopRun(); });
  const judge = $('judgeBtn');
  if (judge) judge.addEventListener('click', () => { startJudge(); });
  // 判分 Provider：选中已有 provider 时自动带出模型/端点；切回"自定义"则保留手填值
  const judgeProv = $('judgeProvider');
  if (judgeProv) judgeProv.addEventListener('change', () => fillJudgeFromProvider(judgeProv.value));
  // 判分卡其余动作 / 外部判分卡 / 评分管理卡：id 缺失时跳过绑定（并行改 HTML 的可空兜底）
  const benchReset = $('benchResetBtn');
  if (benchReset) benchReset.addEventListener('click', () => { benchResetRun(); });
  const extPrep = $('extPrepare');
  if (extPrep) extPrep.addEventListener('click', () => { extPrepareRun(); });
  const extCopyBtn = $('extCopy');
  if (extCopyBtn) extCopyBtn.addEventListener('click', () => { extCopyRun(); });
  const extImportBtn = $('extImport');
  if (extImportBtn) extImportBtn.addEventListener('click', () => { extImportRun(); });
  // 判分结果改走文件选择：选中即读入预览框，导入仍以预览框内容为准
  const reviewsFile = $('extReviewsFile');
  if (reviewsFile) reviewsFile.addEventListener('change', () => {
    const f = reviewsFile.files && reviewsFile.files[0];
    setText($('extFileInfo'), f ? `已选择：${f.name}` : '');
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const box = $('extReviewsBox');
      if (box) box.value = String(reader.result || '');
      syncAnswerActions();
    };
    reader.onerror = () => alert('读取判分结果文件失败');
    reader.readAsText(f, 'utf-8');
  });
  // 作答文件切换：判分包/判分按钮的可用性随之刷新；外部判分包已生成时作废（避免旧包配新文件）
  const judgeSel = $('judgeAnswers');
  if (judgeSel) judgeSel.addEventListener('change', () => syncAnswerActions());
  const extSel = $('extAnswers');
  if (extSel) extSel.addEventListener('change', () => {
    const box = $('extPromptBox');
    if (box) { box.value = ''; setHidden(box, true); }
    setHidden($('extCopy'), true);
    extPrepInfoText = '';
    setText($('extPrepInfo'), '');
    syncAnswerActions();
  });
  const reviewsBox = $('extReviewsBox');
  if (reviewsBox) reviewsBox.addEventListener('input', () => syncAnswerActions());
  // Token 页批次切换：只重渲染会话记账区块
  const runSel = $('runSelect');
  if (runSel) runSel.addEventListener('change', () => { renderTokenRuns(); });
  const rescore = $('scoreRescore');
  if (rescore) rescore.addEventListener('click', () => { scoreRescoreRun(); });
  const reset = $('scoreReset');
  if (reset) reset.addEventListener('click', () => { scoreResetRun(); });
  syncAnswerActions();   // 初始禁用无文件入口；列表加载完成后 loadAnswersOptions 会再同步一次
}

function selectedPersonaTotalCount() {
  let total = 0;
  for (const [p, c] of personaCounts) if (selectedPersonas.has(p)) total += c;
  return total;
}

// 运行页当前会跑多少题：全部档按每组全部题算，自定义数字按“每组最多 N 题”算。
function runSelection() {
  const personas = [...selectedPersonas];
  const startRaw = parseInt((($('runStart') || {}).value ?? ''), 10);
  const startIndex = Number.isFinite(startRaw) && startRaw > 0 ? startRaw : 1;
  const customRaw = parseInt((($('countCustom') || {}).value ?? ''), 10);
  const allMode = activeChip === 'all';
  const count = allMode
    ? Number.MAX_SAFE_INTEGER
    : (Number.isFinite(customRaw) && customRaw > 0 ? customRaw : 0);
  const ids = [];
  for (const persona of personas) {
    const all = questions.questions
      .filter((q) => String(q.persona) === persona)
      .map((q) => q.id);
    ids.push(...all.slice(startIndex - 1, startIndex - 1 + count));
  }
  return { ids, personas, startIndex, count, allMode };
}

function updateRunTotalHint() {
  const el = $('runTotalHint');
  if (!el) return;
  const { ids, personas, startIndex, count, allMode } = runSelection();
  if (!personas.length) { el.textContent = '本次共 0 题（请至少选择一个 Persona）'; return; }
  const perGroup = allMode ? '全部' : `最多 ${count || 0} 题`;
  el.textContent = `本次共 ${fmt(ids.length)} 题（已选 ${personas.length} 组，每组从第 ${startIndex} 题起，${perGroup}）`;
  el.style.color = '';
}

function runConcurrencyValue() {
  const raw = parseInt((($('runConcurrency') || {}).value ?? ''), 10);
  return Number.isFinite(raw) ? Math.max(1, Math.min(8, raw)) : 4;
}

// 统一入口：题库勾选、多组切片都落到 ids，由服务端整批下发
async function startRunIds(ids, { source = '' } = {}) {
  if (!ids.length) { alert('没有可评测的题目'); return; }
  if (!confirm(`将评测 ${fmt(ids.length)} 题${source ? `（${source}）` : ''}。\n并发 ${runConcurrencyValue()} 题；每轮先按 cutoff 重建记忆库再考（准备阶段可能较久）。\n考试走共享 LLM 额度，确认开跑？`)) return;
  try {
    await api('/api/run/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, concurrency: runConcurrencyValue(), prepare: true }),
    });
    await loadRunState();
  } catch (e) { alert(`启动失败：${e.message}`); }
}

async function startRun() {
  const { ids, personas, startIndex, count, allMode } = runSelection();
  if (!personas.length) { alert('请先选择至少一个 Persona（可点「全部组」）'); return; }
  if (!allMode && !(count > 0)) { alert('请填写有效的评测题数'); return; }
  if (!ids.length) { alert('切片为空：起始序号超出所选 Persona 的题目范围'); return; }
  const perGroup = allMode ? '全部题' : `最多 ${count} 题`;
  if (!confirm(`将评测 ${fmt(ids.length)} 题（${personas.join('、')}，每组从第 ${startIndex} 题起，${perGroup}）。\n并发 ${runConcurrencyValue()} 题；每轮先按 cutoff 重建记忆库再考。\n考试走共享 LLM 额度，确认开跑？`)) return;
  try {
    await api('/api/run/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, concurrency: runConcurrencyValue(), prepare: true }),
    });
    await loadRunState();
  } catch (e) { alert(`启动失败：${e.message}`); }
}

async function stopRun() {
  if (!confirm('确认停止当前评测？')) return;
  try {
    await api('/api/run/stop', { method: 'POST' });
    await loadRunState();
  } catch (e) { alert(`停止失败：${e.message}`); }
}

// auto=true：由「考完自动判分」触发——勾选即视为额度授权，不再弹确认框
async function startJudge(auto = false) {
  const answersFile = String((($('judgeAnswers') || {}).value) || '');
  if (!answersFile) { alert('请先选择要判分的作答文件'); return; }
  const provider = String((($('judgeProvider') || {}).value) || '');
  const model = (($('judgeModel') || {}).value || '').trim();
  const baseUrl = (($('judgeBase') || {}).value || '').trim();
  const key = (($('judgeKey') || {}).value || '').trim();
  // 默认不保留（用户裁定）：勾选才传 keep=true 让脚本 --keep；元素缺失同样按不保留处理
  const keep = $('judgeKeep') ? $('judgeKeep').checked : false;
  const batchRaw = parseInt((($('judgeBatch') || {}).value ?? ''), 10);
  const batch = Number.isFinite(batchRaw) ? Math.max(1, Math.min(100, batchRaw)) : 32;
  // keep 的后果必须让用户在确认框里看到：勾选与否是"留库"与"删库"的分界
  const keepText = keep
    ? '判分后保留会话与记忆库'
    : '⚠ 判分成功后自动 bench-reset：清空会话并删除记忆库';
  const providerText = provider ? `Provider：${provider}\n` : '';
  if (!auto && !confirm(`对「${answersFile}」发起判分。\n${providerText}模型：${model || '默认 deepseek-v4.1-flash'}\n每批 ${batch} 题\n${keepText}\n确认开始？`)) return;
  try {
    await api('/api/judge/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answersFile,
        provider: provider || undefined,
        model: model || undefined,
        baseUrl: baseUrl || undefined,
        key: key || undefined,
        batch,
        keep,
      }),
    });
    await loadRunState();
  } catch (e) { alert(`判分启动失败：${e.message}`); }
}

/* ---------------- 运行页实时日志 ---------------- */

const RUN_LOG_MAX = 300;   // 日志窗上限：超出移除最早的行，防长跑批把 DOM 撑爆

// 距底部 ≤40px 视为贴底；用户向上滚超过 40px 就暂停自动滚动，滚回底部自动恢复
function runLogAtBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= 40;
}

function appendRunLog(source, line) {
  const box = $('runLog');
  if (!box || line == null) return;
  const div = document.createElement('div');
  div.className = 'log-line';
  div.textContent = `[${source || 'exam'}] ${line}`;   // textContent 赋值天然免转义
  if (/crashed|failed|error/i.test(String(line))) div.classList.add('log-err');
  box.appendChild(div);
  while (box.children.length > RUN_LOG_MAX) box.removeChild(box.firstChild);
  if (runLogAutoScroll) box.scrollTop = box.scrollHeight;
}

// #runLog 为空时（冷启动/刚清空）用 state.lastLines 一次性补齐，保持先后顺序；
// 清空后只回补清空时刻之后的行——上一轮的尾巴不能借尸还魂
function backfillRunLog() {
  const box = $('runLog');
  if (!box || box.children.length > 0) return;
  const lines = (runState && runState.lastLines) || [];
  const due = lines.filter((l) => {
    if (!l || typeof l.line !== 'string') return false;
    if (runLogSinceTs == null) return true;
    return typeof l.ts === 'number' && l.ts >= runLogSinceTs;
  });
  for (const l of due) appendRunLog(l.source, l.line);
}

function clearRunLog() {
  const box = $('runLog');
  if (box) box.innerHTML = '';
  runLogSinceTs = Date.now();
}

function bindRunLog() {
  const box = $('runLog');
  if (!box) return;
  box.addEventListener('scroll', () => { runLogAutoScroll = runLogAtBottom(box); });
}

/* ---------------- 判分卡：bench-reset（先演练后实删，两段确认） ---------------- */

// result 形状见 scripts/bench-reset.mjs 的 summary：sessionsRemoved/projectionsRemoved/
// bindingsRemoved/library；result 为 null（脚本没出 JSON）时回退 lines 合并展示
async function benchResetRun() {
  if (!confirm('先演练（dry-run）？bench-reset 会删除本 workspace 全部会话与记忆库 lib_4a9b8a60')) return;
  const post = (dryRun) => api('/api/reset/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun }),
  });
  let dry;
  try { dry = await post(true); }
  catch (e) { alert(`演练失败：${e.message}`); return; }
  const dryText = dry && dry.result != null
    ? JSON.stringify(dry.result, null, 1)
    : ((dry && dry.lines) || []).join('\n');
  alert(`演练结果：\n${dryText || '（无输出）'}`);
  if (!confirm('确认实删？')) return;
  let real;
  try { real = await post(false); }
  catch (e) { alert(`实删失败：${e.message}`); return; }
  const r = (real && real.result) || {};
  const lib = r.library == null ? '—' : (typeof r.library === 'string' ? r.library : JSON.stringify(r.library));
  alert(`已实删：会话 ${fmt(r.sessionsRemoved)} · 投影 ${fmt(r.projectionsRemoved)} · 绑定 ${fmt(r.bindingsRemoved)} · 记忆库 ${lib}`);
}

/* ---------------- 外部判分卡（生成判分包 → 复制给外部模型 → 回执回算） ---------------- */

async function extPrepareRun() {
  const answersFile = String((($('extAnswers') || {}).value) || '');
  if (!answersFile) { alert('请先选择作答文件'); return; }
  try {
    const d = await api('/api/external/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answersFile }),
    });
    const box = $('extPromptBox');
    if (box) { box.value = String(d.promptMd || ''); setHidden(box, false); }
    setHidden($('extCopy'), false);
    extPrepInfoText = `已生成 ${fmt(d.packetsCount)} 题判分包（批次 ${d.label}）`;
    setText($('extPrepInfo'), extPrepInfoText);
    syncAnswerActions();
  } catch (e) { alert(`生成判分包失败：${e.message}`); }
}

async function extCopyRun() {
  const box = $('extPromptBox');
  const text = box ? box.value : '';
  if (!text) { setText($('extPrepInfo'), '还没有可复制的判分包，先生成'); return; }
  let ok = false;
  // 优先异步剪贴板；http 裸 IP 这类非安全上下文会抛错，退回 select + execCommand 老路
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch (e) {
    try { if (box) { box.focus(); box.select(); ok = document.execCommand('copy'); } }
    catch (e2) { ok = false; }
  }
  setText($('extPrepInfo'), ok ? '已复制' : '复制失败，请手动全选复制');
  if (extCopyTimer) clearTimeout(extCopyTimer);
  extCopyTimer = setTimeout(() => { setText($('extPrepInfo'), extPrepInfoText); extCopyTimer = null; }, 1500);
}

async function extImportRun() {
  const label = answersLabelOf(($('extAnswers') || {}).value);
  if (!label) { alert('无法从作答文件名推导批次 label（需形如 answers-*.jsonl）'); return; }
  const reviewsText = String((($('extReviewsBox') || {}).value) || '');
  if (!reviewsText.trim()) { alert('请先粘贴外部模型的判分回执'); return; }
  try {
    const d = await api('/api/score/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, reviewsText }),
    });
    alert(`回算完成：判分 ${fmt(d.scored)} 题，通过 ${fmt(d.passed)}`);
    refresh(['questions', 'summary']);
    loadAnswersOptions();
    loadScoreLabels();
  } catch (e) { alert(`回算失败：${e.message}`); }
}

/* ---------------- 评分管理卡（历史批次重算 / 重置） ---------------- */

async function scoreRescoreRun() {
  const label = scoreLabelValue();
  if (!label) return;
  try {
    const d = await api('/api/score/rescore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    const s = (d && d.summary) || {};
    alert(`重算完成：${fmt(s.passed)}/${fmt(s.scored)} 通过`);
    refresh(['summary', 'questions']);
  } catch (e) { alert(`重算失败：${e.message}`); }
}

async function scoreResetRun() {
  const label = scoreLabelValue();
  if (!label) return;
  const inc = $('scoreIncludeReviews') ? $('scoreIncludeReviews').checked : false;
  const tail = inc ? '连同 reviews 一起删除，重新出分需再判分' : '仅删 scored/summary，作答保留';
  if (!confirm(`重置 ${label} 判分结果？${tail}`)) return;
  try {
    await api('/api/score/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, includeReviews: inc }),
    });
    refresh(['questions', 'summary']);
    loadScoreLabels();
    loadAnswersOptions();
  } catch (e) { alert(`重置失败：${e.message}`); }
}

// 题库页「全新重置」：清空作答 + 判据 + 判分，题库回到未作答；记忆库/会话不动
async function resetAllScores() {
  if (!confirm('全新重置？\n将删除所有作答文件、判据包、判分回执、评分结果与考试快照，题库回到「未作答」。\n记忆库/会话不会被清理，可全新开跑。\n确认继续？')) return;
  try {
    const d = await api('/api/score/reset-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeAnswers: true, includeReviews: true }),
    });
    alert(`已清空 ${fmt((d && d.deleted || []).length)} 个文件，题库已回到全新状态`);
    await refresh(['questions', 'summary', 'tokens']);
    await loadAnswersOptions();
  } catch (e) {
    alert(`全新重置失败：${e.message}`);
  } finally {
    await loadScoreLabels();
    syncBankResetAvailability();
  }
}

// 运行页全量重绘：SSE state 事件与轮询都整包替换后重跑本函数（量小，无脑重绘最稳）
function renderRunPage() {
  const rs = runState || {};
  const ex = rs.exam || {};
  const ju = rs.judge || {};
  const examRunning = !!ex.running;
  const judgeRunning = !!ju.running;
  const ids = ex.ids || [];
  const st = ex.statuses || {};
  const done = countDone(ids, st);
  const total = ids.length;

  setHidden($('runGo'), examRunning);
  setHidden($('runStop'), !examRunning);
  // 判分与考试解耦：按钮常驻，空闲时可对任意作答文件手动发起；考试/判分进行中禁用
  setHidden($('judgeBtn'), judgeRunning);
  // 进度面板：一旦出现过考试（在跑/有题目/有产物/有结束时间）就常驻，便于回看
  setHidden($('runPanel'), !(examRunning || total > 0 || ex.outFile || ex.endedAt));

  // 记忆重建阶段优先显示 checkpoint 进度：考试题还没开始，按题数算会一直停在 0
  const preparing = !!(examRunning && ex.phase === 'prepare');
  const prepTotal = ex.prepareTotal || 0;
  const prepDone = ex.prepareDone || 0;
  setFill('runProgressFill', preparing && prepTotal
    ? (prepDone / prepTotal) * 100
    : (total ? (done / total) * 100 : 0));
  setText($('runProgressText'), preparing
    ? `记忆重建 ${prepDone}/${prepTotal || '—'} · ${ex.prepareTag || '准备中'}`
    : (total
      ? (examRunning ? `${done} / ${total} · 当前 ${ex.current || '—'}` : `${done} / ${total} · 已结束`)
      : (examRunning ? '准备中…' : '')));
  setText($('runOutFile'), ex.outFile || '');

  const cur = ex.current ? st[ex.current] : null;
  setText($('runCurrentQid'), ex.current || '—');
  const stateEl = $('runCurrentState');
  if (stateEl) {
    const s = cur ? (cur.state || 'pending') : null;
    stateEl.className = 'state-pill' + (s ? ` ${s}` : '');
    stateEl.textContent = s ? (EXAM_STATE_TEXT[s] || s) : '—';
  }
  setText($('runCurrentAttempt'), cur ? `第 ${cur.attempts ?? 0} 次` : '');
  setText($('runCurrentTokens'), cur ? tokensSummaryFull(cur) : '');

  const list = $('runList');
  if (list) {
    list.innerHTML = ids.map((id) => {
      const s = st[id] || {};
      const state = s.state || 'pending';
      return `<div class="run-row">` +
        `<span class="mono">${escapeHtml(id)}</span>` +
        `<span class="state-pill ${escapeHtml(state)}">${escapeHtml(EXAM_STATE_TEXT[state] || state)}</span>` +
        `<span class="muted small">第 ${s.attempts ?? 0} 次</span>` +
        `<span class="muted mono small">${escapeHtml(tokensSummaryFull(s))}</span>` +
        `</div>`;
    }).join('');
  }

  // 判分面板：跑批中或跑完之后都保留——否则判分一结束面板就消失，用户看不到"是否成功"
  const judgeEver = judgeRunning || !!ju.endedAt;
  setHidden($('judgePanel'), !judgeEver);
  if (judgeEver) {
    const bt = ju.batchesTotal || 0;
    const cb = ju.currentBatch || 0;
    const textEl = $('judgeText');
    if (judgeRunning) {
      setFill('judgeFill', bt ? (cb / bt) * 100 : 0);
      setText(textEl, `批次 ${cb}/${bt} · 模型 ${ju.model || '默认'} · 共 ${fmt(ju.packets)} 题`);
      if (textEl) textEl.style.color = '';
    } else {
      setFill('judgeFill', ju.error ? 0 : 100);
      if (ju.error) {
        setText(textEl, `判分失败：${ju.error}`);
        if (textEl) textEl.style.color = 'var(--bad)';
      } else {
        setText(textEl, `判分完成 · ${shortTs(ju.endedAt)} · 共 ${fmt(ju.packets)} 题（批次 ${ju.label || '—'}）`);
        if (textEl) textEl.style.color = 'var(--ok)';
      }
    }
  }

  renderMiniCard();
  tickElapsed();
  syncAnswerActions();   // 考试/判分状态变化后同步作答入口的禁用态
}

// 每秒刷已用时长与 ETA；ETA = 已完成均时 × 剩余题数（无完成样本时给不出估计）
function tickElapsed() {
  const ex = runState && runState.exam;
  if (!ex || !ex.startedAt) { setText($('runElapsed'), ''); setText($('runEta'), ''); return; }
  const startMs = toMs(ex.startedAt);
  if (startMs == null) { setText($('runElapsed'), '—'); setText($('runEta'), '—'); return; }
  const endMs = ex.endedAt ? toMs(ex.endedAt) : null;
  const elapsed = Math.max((endMs != null ? endMs : Date.now()) - startMs, 0);
  setText($('runElapsed'), `已用时 ${fmtDur(elapsed)}`);
  const ids = ex.ids || [];
  const done = countDone(ids, ex.statuses || {});
  const remain = ids.length - done;
  setText($('runEta'), ex.running && done > 0 && remain > 0
    ? `剩余 ≈ ${fmtDur((elapsed / done) * remain)}`
    : '剩余 —');
}

// 「考完自动判分」勾选即视为授权：考试一结束直接发起，不再弹确认
function maybeAutoJudge() {
  const box = $('judgeAuto');
  if (!box || !box.checked) return;
  const ex = (runState && runState.exam) || {};
  if (!ex.outFile) return;
  const base = String(ex.outFile).split(/[\\/]/).pop();
  appendRunLog('auto', `考试结束：按「考完自动判分」对 ${base} 发起判分`);
  startJudge(true);
}

// 整包替换 runState；running 翻假（或 endedAt 变化的兜底）时按契约重拉业务数据
function applyRunState(next) {
  const prev = runState;
  runState = next || {};
  const pe = prev && prev.exam;
  const pj = prev && prev.judge;
  const ne = runState.exam || {};
  const nj = runState.judge || {};
  const examStarted = !!(pe && !pe.running && ne.running);   // 新一轮考试：实时日志清空重开
  const examEnded = !!(pe && ((pe.running && !ne.running) || (!pe.running && ne.endedAt && pe.endedAt !== ne.endedAt)));
  const judgeEnded = !!(pj && ((pj.running && !nj.running) || (!pj.running && nj.endedAt && pj.endedAt !== nj.endedAt)));
  if (examStarted) clearRunLog();
  renderRunPage();
  backfillRunLog();
  // 结束时机是"状态翻转"而非轮询结果本身，所以在这里补拉（后台批量刷新，不阻塞渲染）
  if (examEnded) {
    refresh(['questions', 'summary', 'tokens']);
    // 自动判分要等作答文件下拉就位（默认选中新产物）后再发起
    loadAnswersOptions().then(() => { maybeAutoJudge(); });
  }
  if (judgeEnded) {
    refresh(['summary', 'questions', 'tokens']);
    loadAnswersOptions();   // 新判分产物落盘：作答文件读数与批次列表一起刷新
    loadScoreLabels();
  }
}

/* ---------------- Token 页 ---------------- */

function renderTokens() {
  // Token 页主视图全部按考试轮次（renderTokenRuns）；api-log 只留底部小框做全局核对
  renderTokenRuns();
  renderApiMini();
}

// api-log 全局口径的一行式摘要（真实与估算分列，仅供核对）
function renderApiMini() {
  const el = $('apiMini');
  if (!el) return;
  const tt = (tokens && tokens.totals) || {};
  const success = Math.max((tt.requests || 0) - (tt.fail || 0), 0);
  el.textContent = `请求 ${fmt(tt.requests)}（成功 ${fmt(success)} / 失败 ${fmt(tt.fail)}） · ` +
    `输入 ${fmt(tt.promptReal)}（另估算 ${fmt(tt.promptEst)}） · 输出 ${fmt(tt.completionReal)}（另估算 ${fmt(tt.completionEst)}）`;
}

/* ---------------- 会话记账 · 按次考试（exam-log 分段，runs 来自 /api/tokens） ---------------- */

// 选中批次：'' → 默认最新一次；'__all__' → 全部合计（明确选择才汇总，平时各次分开）
let tokRunEmptyEl = null;
let tokExamEmptyEl2 = null;

function shortTs(ts) {
  const d = ts != null ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return '未知时间';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 跨次求和（仅「全部合计」用）：逐字段累加，命中率按合计重算
function sumRunTotals(runs) {
  const t = { calls: 0, input: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0, hitRate: 0 };
  for (const r of runs) {
    const s = r.totals || {};
    t.calls += Number(s.calls) || 0;
    t.input += Number(s.input) || 0;
    t.cacheHit += Number(s.cacheHit) || 0;
    t.cacheWrite += Number(s.cacheWrite) || 0;
    t.output += Number(s.output) || 0;
    t.total += Number(s.total) || 0;
  }
  const prompt = t.input + t.cacheHit + t.cacheWrite;
  t.hitRate = prompt > 0 ? t.cacheHit / prompt : 0;
  return t;
}

// 「全部合计」的用途分项：把各次收尾时的 byPurpose 逐桶累加（单次视图直接用该次的）
function mergePurposes(runs) {
  const out = {};
  for (const r of runs) {
    const bp = r.byPurpose || {};
    for (const [k, b] of Object.entries(bp)) {
      if (!b) continue;
      const t = out[k] || (out[k] = { calls: 0, input: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0 });
      t.calls += Number(b.calls) || 0;
      t.input += Number(b.input) || 0;
      t.cacheHit += Number(b.cacheHit) || 0;
      t.cacheWrite += Number(b.cacheWrite) || 0;
      t.output += Number(b.output) || 0;
      t.total += Number(b.total) || 0;
    }
  }
  return out;
}

function renderTokenRuns() {
  const runs = (tokens && Array.isArray(tokens.runs)) ? tokens.runs : [];
  const hasRuns = runs.length > 0;
  const sel = $('runSelect');
  if (sel) {
    const opts = hasRuns
      ? runs.map((r, i) => ({ value: String(i), label: `${shortTs(r.ts)} · ${fmt(r.questionCount)} 题` }))
        .concat([{ value: '__all__', label: '全部合计（各次相加）' }])
      : [{ value: '', label: '暂无考试批次', disabled: true }];
    const cur = sel.value || (hasRuns ? '0' : '');
    rebuildSelect(sel, opts, opts.some((o) => o.value === cur) ? cur : (hasRuns ? '0' : ''));
  }
  // 没有批次时不要退化成"全部合计 = 全 0"，那会让人以为真的跑过一次空考试
  const pick = hasRuns ? (sel ? (sel.value || '0') : '0') : '';
  const view = hasRuns
    ? (pick === '__all__'
      ? { totals: sumRunTotals(runs), byPurpose: mergePurposes(runs), perQid: runs.flatMap((r) => r.perQid || []) }
      : (runs[Number(pick)] || null))
    : null;
  const tt = view ? (view.totals || {}) : null;
  setText($('tokInput'), tt ? fmt(tt.input) : '—');
  setText($('tokCacheHit'), tt ? fmt(tt.cacheHit) : '—');
  setText($('tokCacheWrite'), tt ? fmt(tt.cacheWrite) : '—');
  setText($('tokOutput'), tt ? fmt(tt.output) : '—');
  setText($('tokTotal'), tt ? fmt(tt.total) : '—');
  // 卡片标签已经写了"缓存命中率"，值再重复一次"命中率"就冗余了
  setText($('tokHitRate'), tt && Number.isFinite(tt.hitRate) ? `${(tt.hitRate * 100).toFixed(1)}%` : '—');
  renderRunPurpose(view);

  // 空态挂在六卡所在 stat-grid 之后；元素缓存复用，重渲染只切显隐
  const anchor = $('tokInput');
  const grid = anchor && anchor.closest ? anchor.closest('.stat-grid') : null;
  if (grid) {
    if (!tokRunEmptyEl || !tokRunEmptyEl.isConnected) {
      tokRunEmptyEl = document.createElement('div');
      tokRunEmptyEl.className = 'empty';
      tokRunEmptyEl.textContent = '暂无考试记账（每次考试的消耗在考试结束后自动分列到这里）';
      grid.insertAdjacentElement('afterend', tokRunEmptyEl);
    }
    tokRunEmptyEl.classList.toggle('hidden', hasRuns);
  }

  // 逐题表：跟随所选批次；「全部合计」时跨次摊平（最新在前，截 20 条）
  const body = $('tokExamBody');
  if (!body) return;
  const cell = (v) => (v == null ? '—' : fmt(v));
  const perQid = view ? (view.perQid || []).slice().reverse().slice(0, 20) : [];
  body.innerHTML = perQid.map((r) => {
    const tk = (r.tokens && typeof r.tokens === 'object') ? r.tokens : {};
    const turn = r.turnEnd == null ? '—' : (TURN_END_TEXT[r.turnEnd] || String(r.turnEnd));
    return `<tr>` +
      `<td class="mono">${escapeHtml(r.qid)}</td>` +
      `<td>${escapeHtml(turn)}</td>` +
      `<td>${cell(r.answerChars)}</td>` +
      `<td>${cell(tk.input)}</td>` +
      `<td>${cell(tk.cacheHit)}</td>` +
      `<td>${cell(tk.output)}</td>` +
      `<td>${cell(tk.total)}</td>` +
      `</tr>`;
  }).join('');
  const table = body.closest ? body.closest('table') : null;
  if (!table) return;
  if (!tokExamEmptyEl2 || !tokExamEmptyEl2.isConnected) {
    tokExamEmptyEl2 = document.createElement('div');
    tokExamEmptyEl2.className = 'empty';
    tokExamEmptyEl2.textContent = '该批次暂无逐题记账';
    table.insertAdjacentElement('afterend', tokExamEmptyEl2);
  }
  tokExamEmptyEl2.classList.toggle('hidden', perQid.length > 0);
}

// turnEnd 字面量 → 中文；未收录的值原样透出，不臆造译名
const TURN_END_TEXT = { completed: '完成', timeout: '超时', failed: '失败' };

// 用途总览表（选中批次的 byPurpose，来自该次收尾时的 token-report；未收尾的段为 null）
const PURPOSE_TEXT = { exam: '考试', consolidation: '记忆整理', other: '其它（宿主会话）', judge: '判分', probe: '探测' };

function renderRunPurpose(view) {
  const body = $('runPurposeBody');
  if (!body) return;
  const bp = view && view.byPurpose ? view.byPurpose : null;
  const rows = bp
    ? Object.entries(bp).filter(([, b]) => b && Number(b.calls) > 0)
        .sort((a, b) => (Number(b[1].total) || 0) - (Number(a[1].total) || 0))
    : [];
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">该批次暂无用途分项（考试未正常收尾，或为分段回算的历史数据）</td></tr>';
    return;
  }
  body.innerHTML = rows.map(([k, b]) => {
    const prompt = (Number(b.input) || 0) + (Number(b.cacheHit) || 0) + (Number(b.cacheWrite) || 0);
    const hr = prompt > 0 ? `${((Number(b.cacheHit) || 0) / prompt * 100).toFixed(1)}%` : '—';
    return `<tr><td>${escapeHtml(PURPOSE_TEXT[k] || k)}</td>` +
      `<td>${fmt(b.calls)}</td>` +
      `<td>${fmt(b.input)}</td><td>${fmt(b.cacheHit)}</td><td>${fmt(b.cacheWrite)}</td>` +
      `<td>${fmt(b.output)}</td>` +
      `<td class="mono">${fmt(b.total)}（${hr}）</td></tr>`;
  }).join('');
}

/* ---------------- 设置页：宿主 Provider ---------------- */

function setInput(id, value) {
  const el = $(id);
  if (el) el.value = value == null ? '' : String(value);
}

// 载入某个 provider 到表单；空 id = 新建，给 schema 常用默认值，避免用户面对一片空白
function fillProviderForm(id) {
  const p = providerCache && providerCache.providers.find((x) => x.id === id);
  const modelEl = $('providerModel');
  if (!p) {
    setInput('providerDisplay', '');
    setInput('providerApi', 'openai-completions');
    setInput('providerBase', '');
    setInput('providerKey', '');
    setInput('providerModel', '');
    setInput('providerModelName', '');
    setInput('providerCtx', '1000000');
    setInput('providerMax', '32768');
    setInput('providerEffort', (providerCache && providerCache.defaultReasoningEffort) || '');
    if (modelEl) delete modelEl.dataset.oldModelId;
    setText($('providerKeyState'), '新建 provider：需要鉴权时填写 API Key');
    setText($('providerEffortInfo'), '新建模型未声明档位；保存时会补齐 off/low/medium/high。');
    syncProviderEffortAvailability();
    return;
  }
  const m = (p.models && p.models[0]) || {};
  setInput('providerDisplay', p.displayName || '');
  setInput('providerApi', p.api || 'openai-completions');
  setInput('providerBase', p.baseURL || '');
  setInput('providerKey', '');   // key 不回显；留空保存即保持不变
  setInput('providerModel', m.id || '');
  setInput('providerModelName', m.name || '');
  setInput('providerCtx', m.contextWindow ?? '');
  setInput('providerMax', m.maxTokens ?? '');
  setInput('providerEffort', (providerCache && providerCache.defaultReasoningEffort) || '');
  if (modelEl) modelEl.dataset.oldModelId = m.id || '';
  const extra = p.models.length > 1 ? `；另有 ${p.models.length - 1} 个模型未在表单中展示` : '';
  setText($('providerKeyState'), p.hasKey
    ? `已配置 key，留空保持不变${extra}`
    : `未配置 key，如需鉴权请填写${extra}`);
  const effortMap = m.reasoningEfforts;
  const levels = typeof effortMap === 'object' && effortMap !== null ? Object.keys(effortMap).join(' / ') : '未声明';
  setText($('providerEffortInfo'), `当前模型声明：${levels}；保存时会补齐 off/low/medium/high。`);
  syncProviderEffortAvailability();
}

// 思考强度只对“默认模型”有效；不勾选设为默认时，禁用选择避免误导
function syncProviderEffortAvailability() {
  const setDefault = $('providerSetDefault');
  const effort = $('providerEffort');
  if (effort) effort.disabled = !(setDefault && setDefault.checked);
}

function renderProviderList(d) {
  const body = $('providerListBody');
  if (!body) return;
  const providers = (d && d.providers) || [];
  body.innerHTML = providers.map((p) => {
    const m = (p.models && p.models[0]) || {};
    const more = p.models.length > 1 ? ` +${p.models.length - 1}` : '';
    return `<tr data-provider="${escapeHtml(p.id)}">` +
      `<td class="mono">${escapeHtml(p.id)}</td>` +
      `<td>${escapeHtml(p.displayName || '—')}</td>` +
      `<td class="mono">${escapeHtml(p.api)}</td>` +
      `<td title="${escapeHtml(p.baseURL)}">${escapeHtml(p.baseURL)}</td>` +
      `<td class="mono">${escapeHtml(m.id || '—')}${escapeHtml(more)}</td>` +
      `<td>${p.hasKey ? '已配置' : '<span class="muted">缺省</span>'}</td>` +
      `</tr>`;
  }).join('');
  setHidden($('providerTable'), providers.length === 0);
  setHidden($('providerListEmpty'), providers.length > 0);
}

// 判分卡：按所选 provider 填充模型/端点；key 不回显，留空时由服务端解析 provider 的 key
function fillJudgeFromProvider(id) {
  const p = providerCache && providerCache.providers.find((x) => x.id === id);
  const modelEl = $('judgeModel');
  const baseEl = $('judgeBase');
  const keyEl = $('judgeKey');
  if (!p) {
    if (keyEl) keyEl.placeholder = '留空则用 bench profile 内的 key';
    setText($('judgeProviderInfo'), '自定义端点：模型/端点按下方手填，Key 留空则用 bench profile 内的 key。');
    return;
  }
  const m = (p.models && p.models[0]) || {};
  if (modelEl && m.id) modelEl.value = m.id;
  if (baseEl && p.baseURL) baseEl.value = p.baseURL;
  if (keyEl) {
    keyEl.value = '';
    keyEl.placeholder = `留空则用 ${p.id} 的 key`;
  }
  setText($('judgeProviderInfo'), `${p.id} · ${p.baseURL} · ${m.id || '无模型'}${p.hasKey ? ' · key 已配置' : ' · key 未配置'}`);
}

// 判分卡 Provider 下拉：首次按宿主默认 provider 选中；之后保留用户选择（含"自定义"）
function syncJudgeProviderSelect(d) {
  const sel = $('judgeProvider');
  if (!sel) return;
  const prev = sel.value;
  const providers = (d && d.providers) || [];
  sel.innerHTML = '';
  sel.add(new Option('自定义（下方手填）', ''));
  for (const p of providers) sel.add(new Option(`${p.id} · ${p.displayName || ''}`, p.id));
  if (!judgeProviderSynced) {
    judgeProviderSynced = true;
    const wanted = providers.some((p) => p.id === (d && d.defaultProvider)) ? d.defaultProvider : '';
    sel.value = wanted;
    fillJudgeFromProvider(wanted);
    return;
  }
  const still = prev && providers.some((p) => p.id === prev);
  sel.value = still ? prev : '';
  if (!still) fillJudgeFromProvider('');
}

async function loadProvider() {
  try {
    const d = await api('/api/provider');
    providerCache = d;
    const dl = $('providerIdList');
    if (dl) {
      dl.innerHTML = (d.providers || []).map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.displayName || p.id)}</option>`).join('');
    }
    renderProviderList(d);
    syncJudgeProviderSelect(d);
    const idEl = $('providerId');
    if (idEl && !idEl.value.trim()) {
      idEl.value = d.defaultProvider || (d.providers[0] && d.providers[0].id) || '';
    }
    const current = idEl ? idEl.value.trim() : '';
    // 只在命中已有 provider 时回填；用户正在输入的新名字不能被刷新清空
    if (current && (d.providers || []).some((p) => p.id === current)) fillProviderForm(current);
    else if (!current) fillProviderForm('');
    const save = $('providerSave');
    if (save) save.disabled = !d.writable;
    setText($('providerStatus'), d.writable
      ? `可写 · 默认 ${d.defaultProvider || '—'} / ${d.defaultModel || '—'} · ${d.applies || 'live'} 生效`
      : '宿主设置为只读，无法保存');
  } catch (e) {
    providerCache = null;
    setText($('providerStatus'), `读取失败：${e.message}`);
    const save = $('providerSave');
    if (save) save.disabled = true;
  }
}

async function saveProvider() {
  const provider = String((($('providerId') || {}).value) || '').trim();
  const displayName = String((($('providerDisplay') || {}).value) || '').trim();
  const apiProtocol = String((($('providerApi') || {}).value) || 'openai-completions');
  const baseURL = String((($('providerBase') || {}).value) || '').trim();
  const apiKey = String((($('providerKey') || {}).value) || '').trim();
  const model = String((($('providerModel') || {}).value) || '').trim();
  const modelName = String((($('providerModelName') || {}).value) || '').trim();
  const contextWindow = Number((($('providerCtx') || {}).value) || '');
  const maxTokens = Number((($('providerMax') || {}).value) || '');
  const reasoningEffort = String((($('providerEffort') || {}).value) || '').trim();
  const oldModelId = (((($('providerModel') || {}).dataset) || {}).oldModelId) || '';
  if (!provider) { alert('请填写 Provider ID'); return; }
  if (!/^http(s)?:\/\//.test(baseURL)) { alert('Base URL 必须以 http:// 或 https:// 开头'); return; }
  if (!model) { alert('模型 ID 不能为空'); return; }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) { alert('上下文长度必须是正整数'); return; }
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) { alert('最大输出必须是正整数'); return; }

  const btn = $('providerSave');
  if (btn) btn.disabled = true;
  setText($('providerStatus'), '保存中…');
  try {
    const d = await api('/api/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider, displayName, api: apiProtocol, baseURL, apiKey,
        model, modelName, oldModelId,
        contextWindow, maxTokens, reasoningEffort,
        setDefault: !!($('providerSetDefault') || {}).checked,
        setConsolidation: !!($('providerSetConsolidation') || {}).checked,
      }),
    });
    await loadProvider();
    // 刚保存的 provider 如果正是判分卡选中的那个，跟着刷新模型/端点（key 仍留空）
    const judgeSel = $('judgeProvider');
    if (judgeSel && judgeSel.value === d.provider) fillJudgeFromProvider(d.provider);
    const warn = (d.warnings || []).length ? `；${d.warnings.join('；')}` : '';
    setText($('providerStatus'), `已保存 ${d.provider} / ${d.model}${d.defaultSet ? '（已设为默认）' : '（未改默认）'}${warn}`);
  } catch (e) {
    setText($('providerStatus'), `保存失败：${e.message}`);
  } finally {
    const save = $('providerSave');
    if (save) save.disabled = !(providerCache && providerCache.writable);
  }
}

function bindProvider() {
  const idEl = $('providerId');
  if (idEl) {
    idEl.addEventListener('change', () => {
      const id = idEl.value.trim();
      const exists = providerCache && (providerCache.providers || []).some((p) => p.id === id);
      fillProviderForm(exists ? id : '');   // 换成新名字时清掉旧表单，避免把旧值存到新 provider
    });
  }
  const reload = $('providerReload');
  if (reload) reload.addEventListener('click', () => { loadProvider(); });
  const save = $('providerSave');
  if (save) save.addEventListener('click', () => { saveProvider(); });
  const setDefault = $('providerSetDefault');
  if (setDefault) setDefault.addEventListener('change', syncProviderEffortAvailability);
  // 列表行点击载入：内容重绘后委托监听仍在
  const body = $('providerListBody');
  if (body) {
    body.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-provider]');
      if (!tr) return;
      const id = tr.getAttribute('data-provider');
      const idInput = $('providerId');
      if (idInput) idInput.value = id;
      fillProviderForm(id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
}

/* ---------------- SSE 与轮询 ---------------- */

function startStream() {
  let es;
  try { es = new EventSource('/api/stream'); }
  catch (e) { console.warn('[app] SSE 不可用，退化为纯轮询', e); return; }
  let connectedOnce = false;
  es.addEventListener('state', (e) => {
    try { applyRunState(JSON.parse(e.data)); }
    catch (err) { console.warn('[app] state 事件解析失败', err); }
  });
  // log 事件：实时追加到运行页日志窗；state.lastLines 只在窗空时兜底补齐，
  // 两条通路同时写会乱序——以 log 事件为主，lastLines 只做冷启动上下文
  es.addEventListener('log', (e) => {
    try {
      const d = JSON.parse(e.data);
      appendRunLog(d && d.source, d && d.line);
    } catch (err) { console.warn('[app] log 事件解析失败', err); }
  });
  // EventSource 断线原生重连；open 在首连与每次重连都触发，
  // 重连后补拉一次全量，覆盖断线窗口里错过的数据变化
  es.addEventListener('open', () => {
    if (!connectedOnce) { connectedOnce = true; return; }   // 首连不补拉：启动序列刚拉过
    refresh(['questions', 'summary', 'tokens']).then(loadRunState);
  });
}

function pollTick() { if (!document.hidden) loadRunState(); }
function elapsedTick() { if (!document.hidden) tickElapsed(); }

/* ---------------- 页签与启动 ---------------- */

const TAB_NAMES = ['overview', 'bank', 'run', 'token', 'settings'];

function tabFromHash() {
  const h = String(location.hash || '').replace(/^#/, '');
  return TAB_NAMES.includes(h) ? h : 'overview';
}

// name + opts.hash=false 用于启动补位/hashchange：只切面板，不回写 URL，避免循环
function activateTab(name, opts = {}) {
  const target = TAB_NAMES.includes(name) ? name : 'overview';
  document.querySelectorAll('button.tab[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === target));
  document.querySelectorAll('section.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${target}`));
  // 页签写进 hash：刷新/收藏后回到同一页，也方便直接分享某个页签
  if (opts.hash !== false) {
    try { history.replaceState(null, '', '#' + target); }
    catch (e) { location.hash = target; }
  }
}

function gotoRun() {
  activateTab('run');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function gotoBank() {
  activateTab('bank');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function gotoToken() {
  activateTab('token');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 「去评分管理」不应只落到运行页顶部：面板切完后再滚到评分管理卡
function gotoScore() {
  activateTab('run');
  requestAnimationFrame(() => {
    const card = $('scoreManageCard');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// 主题切换：切 data-theme → 落 localStorage → 图标换向（深色显 ☀ 表示可切回浅色）
function bindTheme() {
  const btn = $('themeToggle');
  if (!btn) return;
  const paint = () => {
    btn.textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '🌙';
  };
  paint();
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('mb-theme', next); } catch (e) { /* 存不进就只在会话内生效 */ }
    paint();
  });
}

function bindChrome() {
  document.querySelectorAll('button.tab[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
  // 总览卡片上的跳转按钮（静态 DOM，直接绑）
  document.querySelectorAll('[data-action="goto-run"]').forEach((el) => {
    el.addEventListener('click', gotoRun);
  });
  document.querySelectorAll('[data-action="goto-token"]').forEach((el) => {
    el.addEventListener('click', gotoToken);
  });
  document.querySelectorAll('[data-action="goto-bank"]').forEach((el) => {
    el.addEventListener('click', gotoBank);
  });
  document.querySelectorAll('[data-action="goto-score"]').forEach((el) => {
    el.addEventListener('click', gotoScore);
  });
  const refreshBtn = $('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshAll);
}

function init() {
  bindTheme();
  bindChrome();
  activateTab(tabFromHash(), { hash: false });   // 先按 URL 的 hash 落页，刷新不丢页签
  window.addEventListener('hashchange', () => activateTab(tabFromHash(), { hash: false }));
  bindBank();
  bindRunPage();
  bindRunLog();
  bindDrawer();
  bindProvider();
  // 启动序列：并行拉取，各自渲染各自的页；互不阻塞也不互相等待。
  // 作答文件下拉的默认选中依赖 runState.exam.outFile，故等 runState 就位后再填
  Promise.allSettled([loadQuestions(), loadSummary(), loadTokens(), loadHost(), loadRunState(), loadScoreLabels(), loadProvider()])
    .then(() => loadAnswersOptions())
    .then(() => startStream());
  // 状态轮询兜底：SSE 之外每 10s 拉一次 run/state；页面隐藏时暂停省流量
  setInterval(pollTick, 10000);
  setInterval(elapsedTick, 1000);
  // 切回页面立即补一次状态，避免等满一个轮询周期
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadRunState(); });
}

init();
