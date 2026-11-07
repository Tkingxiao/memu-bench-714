/**
 * memu-bench-714 评测可视化控制台 —— 后端服务（单文件，零依赖，只用 node: 内置模块）
 *
 * 为什么只有一个文件：后端只做三件事——读 results/台账、起 exam/judge 子进程、
 * 把状态用 REST + SSE 推给 dashboard/public 的前端。不值得引框架或拆模块。
 *
 * 约束：
 * - 默认监听 127.0.0.1:39772（env DASHBOARD_PORT 可覆盖）；宿主 39771 只做 TCP 连通探测。
 * - 数据集用仓库内本地副本 datasets/natural-timegrid-20261101-v2/，不再跨仓库引用
 *   chat-memory-benchmark（2026-11-06 二轮迁移，原路径已作废）。
 * - results 目录很小，每次请求现扫现读；exam-inputs/answer-key 靠 mtime 比对缓存。
 * - 判分子进程内部还有 python 孙进程，Windows 停进程必须 taskkill /T 杀树，kill 杀不干净。
 * - `exam-run crashed:` 实测走 console.error（stderr），所以子进程 stdout/stderr 同等解析。
 *
 * 2026-11-06 二轮增补：
 * - exam 完成行尾部多出 tokens 段（`answer chars: N tokens: T|n/a`），逐题状态相应加
 *   tokensTotal；answers 行新增 tokens/sessionId，题目详情随行下发。
 * - judge 支持可选 model/baseUrl/key 覆盖（PROBE_MODEL/PROBE_BASE/PROBE_KEY）——
 *   只透传进子进程 env，绝不写日志/state；默认追加 --keep：控制台要保留判分现场供
 *   复盘与人工改分，自动清库改由 /api/reset/run 显式触发，避免"一判分就丢证据"。
 * - 新增外部判分工作流（prepare → 外部模型出 reviews → import/edit/rescore/reset）
 *   与结果台账端点（/api/answers、/api/score/labels、/api/tokens 的 report/examLog）。
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execSync, execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // memu-bench-714
const PUBLIC_DIR = path.join(HERE, 'public');
const RESULTS_DIR = path.join(ROOT, 'results');
const API_LOG = path.join(ROOT, 'logs', 'api-log.jsonl');
const HOST_COOKIE = path.join(ROOT, 'logs', 'host-cookie.txt');
const EXAM_LOG = path.join(ROOT, 'logs', 'exam-log.jsonl'); // exam-run 逐题 token 台账（含汇总行）
const TOKEN_REPORT = path.join(ROOT, 'results', 'token-report.json'); // token-report.mjs 的汇总产物
const GRADE_PY = path.join(ROOT, 'grading', 'grade.py'); // 本地判分工具（prepare/score 两段式 CLI）
const EXTERNAL_PROMPT_MD = path.join(ROOT, 'grading', 'external-judge-prompt.md'); // 外部判分提示词模板

const PORT = Number(process.env.DASHBOARD_PORT) || 39772;
const HOST_PORT = 39771;
const JUDGE_BATCH_DEFAULT = Math.max(1, Math.min(100, Number(process.env.DASHBOARD_JUDGE_BATCH) || 32)); // 与 judge-grade 默认一致；请求可覆盖（1..100）

// 数据集本地副本（2026-11-06 二轮起不再指向 chat-memory-benchmark 仓库）
const DATASET_DIR = path.join(ROOT, 'datasets', 'natural-timegrid-20261101-v2');
const EXAM_INPUTS = path.join(DATASET_DIR, 'exam-inputs.jsonl');
const ANSWER_KEY = path.join(DATASET_DIR, 'review-only', 'answer-key.jsonl');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** label 用本地时间：与历史批次命名同一套，按文件名排序即按时间排序 */
function makeLabel(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 携带状态码抛错，统一由请求入口的 catch 落成 JSON 响应 */
function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** JSONL 逐行解析：坏行跳过不中断（台账/结果文件都可能混入人工编辑痕迹） */
function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      /* 跳过解析失败的行 */
    }
  }
  return rows;
}

/** results 目录按前缀+扩展名列文件，mtime 升序（同 id 多文件时后写覆盖先写依赖此顺序） */
function listResultsFiles(prefix, ext) {
  let names;
  try {
    names = fs.readdirSync(RESULTS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(ext)) continue;
    try {
      const st = fs.statSync(path.join(RESULTS_DIR, name));
      if (st.isFile()) out.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      /* 列目录与 stat 之间的竞态，忽略即可 */
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
  return out;
}

function tsSortKey(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string') {
    const n = Date.parse(ts);
    if (!Number.isNaN(n)) return n;
  }
  return Number.MAX_SAFE_INTEGER; // 没有时间戳的行排最后，避免 NaN 搅乱排序
}

// ---------------------------------------------------------------------------
// api-log 台账行的 token 归一化（/api/tokens 与 SSE 增量 tail 共用）
// ---------------------------------------------------------------------------

function pickNumber(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * 台账行 → 归一化结构。真实用量与估算量语义互斥地落不同桶：
 * usage 对象（或顶层数值 promptTokens/completionTokens）→ 真实；
 * promptTokensEst/completionTokensEst → 估算。字段为 null 不计（typeof 挡掉）。
 */
function parseTokenLine(rec) {
  let prompt = null;
  let completion = null;
  let estPrompt = 0;
  let estCompletion = 0;
  if (rec.usage && typeof rec.usage === 'object') {
    prompt = pickNumber(rec.usage, ['inputTokens', 'input_tokens', 'prompt_tokens']);
    completion = pickNumber(rec.usage, ['outputTokens', 'output_tokens', 'completion_tokens']);
  } else {
    if (typeof rec.promptTokens === 'number') prompt = rec.promptTokens;
    if (typeof rec.completionTokens === 'number') completion = rec.completionTokens;
  }
  if (typeof rec.promptTokensEst === 'number') estPrompt = rec.promptTokensEst;
  if (typeof rec.completionTokensEst === 'number') estCompletion = rec.completionTokensEst;
  const model = typeof rec.model === 'string' && rec.model ? rec.model : '未知';
  const purpose = typeof rec.purpose === 'string' && rec.purpose ? rec.purpose : '未标注';
  const qid = typeof rec.qid === 'string' && rec.qid ? rec.qid : null;
  const fail = rec.outcome === 'fail' || rec.outcome === 'error';
  return {
    prompt,
    completion,
    estPrompt,
    estCompletion,
    est: estPrompt + estCompletion,
    model,
    purpose,
    qid,
    fail,
    hasTokens: prompt !== null || completion !== null || estPrompt !== 0 || estCompletion !== 0,
  };
}

// ---------------------------------------------------------------------------
// 数据集缓存（mtime 变了才重读：714 行读入不贵，但每次请求重读纯属浪费）
// ---------------------------------------------------------------------------

const inputCache = { mtimeMs: null, rows: [] };
const keyCache = { mtimeMs: null, rows: [] };

function getJsonlCached(cache, file) {
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {
    /* 文件暂时不在（换机器/未就绪），按空处理 */
  }
  const m = st && st.isFile() ? st.mtimeMs : null;
  if (cache.mtimeMs === m) return cache.rows;
  cache.mtimeMs = m;
  cache.rows = m === null ? [] : readJsonl(file);
  return cache.rows;
}

const getExamInputs = () => getJsonlCached(inputCache, EXAM_INPUTS);
const getAnswerKey = () => getJsonlCached(keyCache, ANSWER_KEY);

// ---------------------------------------------------------------------------
// results 扫描与联表
// ---------------------------------------------------------------------------

/**
 * answers/scored/packets 三类各建 id 索引。文件按 mtime 升序套用，
 * 同 id 后写的行覆盖先写的行——与"最新一次写入代表当前状态"的口径一致。
 */
function scanResults() {
  const answersById = new Map(); // id -> answer（空串也算命中）
  const answersInfoById = new Map(); // id -> 最新一行的 {answer, tokens, sessionId}，后两者可能 null
  const answerFilesById = new Map(); // id -> [文件名...]，按 mtime 升序
  const scoredById = new Map(); // id -> scored 行全文
  const scoredFileById = new Map();
  const packetsById = new Map(); // id -> 最新 packets 行

  for (const f of listResultsFiles('answers-', '.jsonl')) {
    for (const row of readJsonl(path.join(RESULTS_DIR, f.name))) {
      if (!row || typeof row.id !== 'string') continue;
      answersById.set(row.id, typeof row.answer === 'string' ? row.answer : '');
      // exam-run 二轮起每行带 tokens/sessionId；mtime 升序套用，后写覆盖先写（取最新行）
      answersInfoById.set(row.id, {
        answer: typeof row.answer === 'string' ? row.answer : null,
        tokens: row.tokens && typeof row.tokens === 'object' ? row.tokens : null,
        sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
      });
      let arr = answerFilesById.get(row.id);
      if (!arr) answerFilesById.set(row.id, (arr = []));
      if (!arr.includes(f.name)) arr.push(f.name);
    }
  }
  for (const f of listResultsFiles('scored-', '.jsonl')) {
    for (const row of readJsonl(path.join(RESULTS_DIR, f.name))) {
      if (!row || typeof row.id !== 'string') continue;
      scoredById.set(row.id, row);
      scoredFileById.set(row.id, f.name);
    }
  }
  for (const f of listResultsFiles('packets-', '.jsonl')) {
    for (const row of readJsonl(path.join(RESULTS_DIR, f.name))) {
      if (!row || typeof row.id !== 'string') continue;
      packetsById.set(row.id, row);
    }
  }
  return { answersById, answersInfoById, answerFilesById, scoredById, scoredFileById, packetsById };
}

/** content_tags/interval_days 以 answer-key 为稳定源；个别条目缺失时退回 scored 行（判分时已联过表） */
function tagsAndInterval(keyRow, scoredRow) {
  let tags = keyRow && Array.isArray(keyRow.content_tags) ? keyRow.content_tags : null;
  if (!tags && scoredRow && Array.isArray(scoredRow.content_tags)) tags = scoredRow.content_tags;
  let interval = keyRow && typeof keyRow.interval_days === 'number' ? keyRow.interval_days : null;
  if (interval === null && scoredRow && typeof scoredRow.interval_days === 'number') {
    interval = scoredRow.interval_days;
  }
  return { tags: tags || [], interval };
}

// ---------------------------------------------------------------------------
// REST 数据装配
// ---------------------------------------------------------------------------

function apiQuestions() {
  const inputs = getExamInputs();
  const keyById = new Map();
  for (const r of getAnswerKey()) {
    if (r && typeof r.id === 'string') keyById.set(r.id, r);
  }
  const scan = scanResults();
  const questions = inputs.map((q) => {
    if (!q || typeof q.id !== 'string') return null;
    const scoredRow = scan.scoredById.get(q.id) || null;
    // 状态优先级：scored 有终审结论 > answers 有作答（哪怕空串）> 未作答
    const status = scoredRow
      ? (scoredRow.pass === true ? 'passed' : 'failed')
      : (scan.answersById.has(q.id) ? 'answered' : 'pending');
    const { tags, interval } = tagsAndInterval(keyById.get(q.id) || null, scoredRow);
    return {
      id: q.id,
      persona: q.persona ?? null,
      now: q.now ?? null,
      cutoff_turn: q.cutoff_turn ?? null,
      question: q.question ?? null,
      interval_days: interval,
      content_tags: tags,
      status,
    };
  }).filter(Boolean);
  return { total: inputs.length, questions };
}

function apiQuestionDetail(id) {
  const input = getExamInputs().find((q) => q && q.id === id);
  if (!input) throw httpError(404, `题目不存在: ${id}`);
  const keyRow = getAnswerKey().find((r) => r && r.id === id) || null;
  const scan = scanResults();
  const pkt = scan.packetsById.get(id) || null;
  const scoredRow = scan.scoredById.get(id) || null;

  // rubric 以 packets（最新含该 id 的那个）优先，无 packets 才用 answer-key
  let rubric = null;
  if (pkt && pkt.rubric && typeof pkt.rubric === 'object') rubric = pkt.rubric;
  else if (keyRow && keyRow.rubric && typeof keyRow.rubric === 'object') rubric = keyRow.rubric;

  // answer 优先取最新 answers 命中（空串是有效作答，不能当 null），否则回退 packets 暂存的
  let answer = null;
  if (scan.answersById.has(id)) answer = scan.answersById.get(id);
  else if (pkt && typeof pkt.answer === 'string') answer = pkt.answer;
  // 二轮新增：随最新 answers 行下发的会话 id 与 token 用量（没有 answers 行就是 null）
  const answerInfo = scan.answersInfoById.get(id) || null;

  const { tags, interval } = tagsAndInterval(keyRow, scoredRow);
  return {
    id,
    persona: input.persona ?? null,
    now: input.now ?? null,
    cutoff_turn: input.cutoff_turn ?? null,
    question: input.question ?? null,
    interval_days: interval,
    content_tags: tags,
    rubric,
    facts: pkt ? (pkt.facts ?? null) : null,
    sources: pkt ? (pkt.sources ?? null) : null,
    answer,
    sessionId: answerInfo ? answerInfo.sessionId : null,
    tokens: answerInfo ? answerInfo.tokens : null,
    review: scoredRow, // scored 行全文原样给出，前端自行取字段
    answerFiles: scan.answerFilesById.get(id) || [],
    scoredFile: scan.scoredFileById.get(id) || null,
  };
}

function apiSummary() {
  const files = listResultsFiles('summary-', '.json');
  // 升序遍历、逐个覆盖：最后一个成功解析的就是 mtime 最新的
  let latest = null;
  let latestFile = null;
  for (const f of files) {
    try {
      latest = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f.name), 'utf8'));
      latestFile = f.name;
    } catch {
      /* 坏的 summary 跳过，不挡住 latest 选取 */
    }
  }
  const inputs = getExamInputs();
  const scan = scanResults();
  let answered = 0;
  let scored = 0;
  let passed = 0;
  for (const q of inputs) {
    if (!q || typeof q.id !== 'string') continue;
    if (scan.answersById.has(q.id)) answered += 1;
    const s = scan.scoredById.get(q.id);
    if (s) {
      scored += 1;
      if (s.pass === true) passed += 1;
    }
  }
  // 判分错误分类计数：按每题最新 scored 行（与状态推导同口径）累计。
  // FLAGS 计「命中次数」，LISTS 计「清单条目数」——总览的错误分类图直接用。
  const FLAGS = ['错认', '错否', '越界', '编造日期', '不当私事披露'];
  const LISTS = ['违反禁止', '未知当事实', '无关旧事'];
  const flags = {};
  for (const k of [...FLAGS, ...LISTS]) flags[k] = 0;
  for (const s of scan.scoredById.values()) {
    if (!s) continue;
    for (const k of FLAGS) if (s[k] === true) flags[k] += 1;
    for (const k of LISTS) if (Array.isArray(s[k])) flags[k] += s[k].length;
  }
  return {
    latest,
    latestFile,
    files: files.map((f) => ({ file: f.name, mtime: new Date(f.mtimeMs).toISOString() })),
    totals: { total: inputs.length, answered, scored, passed },
    flags,
  };
}

/** POST /api/questions/reset：把某题从全部 answers/packets/reviews/scored 文件里剔除，
 *  题库状态随之回落为「未作答」——为反复重测同一题服务（summary 是时点快照，不动）。 */
function apiQuestionsReset(body) {
  if (runState.mode !== 'idle') throw httpError(409, '已有跑批进行中');
  const id = typeof body.id === 'string' ? body.id : '';
  if (!getExamInputs().some((q) => q && q.id === id)) throw httpError(400, `未知题目 id: ${id}`);
  const changed = [];
  let removed = 0;
  for (const prefix of ['answers-', 'packets-', 'reviews-', 'scored-']) {
    for (const f of listResultsFiles(prefix, '.jsonl')) {
      const rows = readJsonl(path.join(RESULTS_DIR, f.name));
      const kept = rows.filter((r) => !(r && r.id === id));
      if (kept.length !== rows.length) {
        if (kept.length) {
          fs.writeFileSync(
            path.join(RESULTS_DIR, f.name),
            kept.map((r) => JSON.stringify(r)).join('\n') + '\n',
            'utf8',
          );
        } else {
          // 整文件只剩该题时直接删掉：留 0 字节壳会搅乱「文件存在=有批次」的直觉
          fs.unlinkSync(path.join(RESULTS_DIR, f.name));
        }
        changed.push(f.name);
        removed += rows.length - kept.length;
      }
    }
  }
  return { id, changed, removed };
}

function apiTokens() {
  const rows = readJsonl(API_LOG); // 台账量小，每次全量重读，换取实现简单与永远最新
  const totals = {
    requests: 0, fail: 0,
    promptReal: 0, completionReal: 0,
    promptEst: 0, completionEst: 0,
    estimated: 0,
  };
  const purposeMap = new Map();
  const modelMap = new Map();
  const questionMap = new Map();
  const timeline = [];
  const examRows = readJsonl(EXAM_LOG); // 一次读入：examLog 键取尾部，runs 全量分段

  for (const rec of rows) {
    if (!rec || typeof rec !== 'object') continue; // 非对象行无法归组，不计入 requests
    totals.requests += 1;
    const info = parseTokenLine(rec);
    if (info.fail) totals.fail += 1;
    if (info.prompt !== null) totals.promptReal += info.prompt;
    if (info.completion !== null) totals.completionReal += info.completion;
    totals.promptEst += info.estPrompt;
    totals.completionEst += info.estCompletion;

    let g = purposeMap.get(info.purpose);
    if (!g) purposeMap.set(info.purpose, (g = { purpose: info.purpose, requests: 0, prompt: 0, completion: 0, est: 0 }));
    g.requests += 1;
    if (info.prompt !== null) g.prompt += info.prompt;
    if (info.completion !== null) g.completion += info.completion;
    g.est += info.est;

    let gm = modelMap.get(info.model);
    if (!gm) modelMap.set(info.model, (gm = { model: info.model, requests: 0, prompt: 0, completion: 0, est: 0 }));
    gm.requests += 1;
    if (info.prompt !== null) gm.prompt += info.prompt;
    if (info.completion !== null) gm.completion += info.completion;
    gm.est += info.est;

    // 只有考试链路（purpose 以 exam- 开头）才按题目归集，判分/probe 不属于任何单题
    if (info.qid && info.purpose.startsWith('exam-')) {
      let gq = questionMap.get(info.qid);
      if (!gq) questionMap.set(info.qid, (gq = { qid: info.qid, prompt: 0, completion: 0, est: 0, requests: 0 }));
      gq.requests += 1;
      if (info.prompt !== null) gq.prompt += info.prompt;
      if (info.completion !== null) gq.completion += info.completion;
      gq.est += info.est;
    }

    if (info.hasTokens) {
      timeline.push({
        ts: typeof rec.ts === 'string' || typeof rec.ts === 'number' ? rec.ts : null,
        prompt: info.prompt ?? 0,
        completion: info.completion ?? 0,
        est: info.est,
        purpose: info.purpose,
      });
    }
  }
  totals.estimated = totals.promptEst + totals.completionEst;

  // 契约只说降序；按真实+估算合计排，最贵的组在最前，最贴合"看花销"的用途
  const byTotal = (e) => e.prompt + e.completion + e.est;
  const byPurpose = [...purposeMap.values()].sort((a, b) => byTotal(b) - byTotal(a));
  const byModel = [...modelMap.values()].sort((a, b) => byTotal(b) - byTotal(a));
  const byQuestion = [...questionMap.values()].sort((a, b) => byTotal(b) - byTotal(a)).slice(0, 50);
  timeline.sort((a, b) => tsSortKey(a.ts) - tsSortKey(b.ts));

  // 二轮新增：token-report.mjs 的汇总报告原样透传；未生成/损坏按 null，前端自行隐藏区块
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(TOKEN_REPORT, 'utf8'));
  } catch {
    /* 报告缺失/坏行不挡主汇总 */
  }
  // exam-run 逐题台账取尾部 300 行：文件按时间升序追加，尾部即最新一轮
  const examLog = examRows.slice(-300);

  return { totals, byPurpose, byModel, byQuestion, timeline, report, examLog, runs: groupExamRuns(examRows).slice(0, 100) };
}

/**
 * exam-log 按次分段：exam-run 汇总行是每次考试结束的分界，段内 exam-question 行归属该次。
 * 分段而不是全量合计——用户要的是"每次考试分开算"；末尾没有 exam-run 收尾的段
 * （token-report 失败/正在跑）单独成段，totals 从逐题行现算。新的批次在前。
 */
function groupExamRuns(rows) {
  const runs = [];
  let cur = null;
  const startCur = () => { cur = { ts: null, endedAt: null, byPurpose: null, questions: [] }; };
  const flush = () => {
    if (!cur || !cur.questions.length) return;
    runs.push({
      ts: cur.endedAt || cur.ts,
      qids: cur.questions.map((q) => q.qid),
      questionCount: cur.questions.length,
      totals: sumQuestionTokens(cur.questions),
      byPurpose: cur.byPurpose,
      perQid: cur.questions.map((q) => ({
        qid: q.qid, turnEnd: q.turnEnd ?? null, answerChars: q.answerChars ?? null, tokens: q.tokens ?? null,
      })),
    });
  };
  startCur();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.event === 'exam-question') {
      if (cur.ts === null) cur.ts = row.ts ?? null;
      cur.questions.push(row);
    } else if (row.event === 'exam-run') {
      cur.endedAt = row.ts ?? null;
      cur.byPurpose = row.byPurpose ?? null;
      flush();
      startCur();
    }
  }
  flush();
  return runs.reverse();
}

/** 逐题行 token 求和（exam-log 行形状：tokens.{input,cacheHit,cacheWrite,output,total,hitRate}） */
function sumQuestionTokens(qrows) {
  const t = { calls: 0, input: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0, hitRate: 0 };
  for (const q of qrows) {
    const tk = q.tokens && typeof q.tokens === 'object' ? q.tokens : {};
    t.calls += 1;
    t.input += Number(tk.input) || 0;
    t.cacheHit += Number(tk.cacheHit) || 0;
    t.cacheWrite += Number(tk.cacheWrite) || 0;
    t.output += Number(tk.output) || 0;
    t.total += Number(tk.total) || 0;
  }
  const prompt = t.input + t.cacheHit + t.cacheWrite;
  t.hitRate = prompt > 0 ? t.cacheHit / prompt : 0;
  return t;
}

/** TCP 一次握手即判 up：宿主是否存活不需要发真实请求 */
function tcpProbe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* 已销毁/未连上，无所谓 */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

async function apiHostStatus() {
  return {
    up: await tcpProbe(HOST_PORT),
    cookie: fs.existsSync(HOST_COOKIE),
    port: HOST_PORT,
  };
}

// ---------------------------------------------------------------------------
// 宿主 settings 直通（provider 编辑）
// ---------------------------------------------------------------------------

// 宿主网关用的是会话 cookie；文件缺失/过期时给出可操作的错误，而不是裸 fetch 失败
function hostCookie() {
  try {
    const v = fs.readFileSync(HOST_COOKIE, 'utf8').trim();
    if (v) return v;
  } catch {
    /* fallthrough */
  }
  throw httpError(503, '宿主 cookie 不存在，请先启动宿主（RUNBOOK §1）');
}

/** 调用宿主网关 /api/<method>；结果取 result.value，宿主拒绝时带出它的 message */
async function hostRpc(method, args = {}, timeoutMs = 15000) {
  const res = await fetch(`http://127.0.0.1:${HOST_PORT}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: hostCookie() },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON：落到下面的错误里 */ }
  if (!res.ok || !body || !body.result) throw httpError(502, `宿主 ${method} 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  if (!body.result.ok) {
    const err = body.result.error || {};
    throw httpError(400, `宿主拒绝 ${method}：${err.message || err.code || 'unknown'}`);
  }
  return body.result.value;
}

/** 插件 RPC（/dsh-memu-memory/<endpoint>）；用于同步记忆整理模型等插件设置 */
async function hostPluginRpc(endpoint, payload = {}, timeoutMs = 30000) {
  const res = await fetch(`http://127.0.0.1:${HOST_PORT}/dsh-memu-memory/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: hostCookie() },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 同上 */ }
  if (!res.ok || !body || !body.result) throw httpError(502, `插件 ${endpoint} 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  return body.result;
}

/**
 * 判分子进程用的 provider 运行时参数：key 只在本进程内解析，绝不回给浏览器。
 * judge-grade 只走 OpenAI /chat/completions，所以非 openai-completions 的 provider 直接拒绝。
 */
async function providerRuntime(id) {
  if (!(await tcpProbe(HOST_PORT))) throw httpError(503, `宿主未启动（127.0.0.1:${HOST_PORT}）`);
  const d = await hostRpc('settings/describe', {});
  const ns = (d.namespaces || []).find((n) => n.ns === 'llm-pi-ai');
  const p = ns && ns.value && ns.value.providers ? ns.value.providers[id] : null;
  if (!p) throw httpError(400, `未知 provider：${id}`);
  const api = p.api || 'openai-completions';
  if (api !== 'openai-completions') {
    throw httpError(400, `判分子进程只支持 openai-completions；${id} 是 ${api}`);
  }
  const baseURL = p.baseURL || '';
  if (!/^https?:\/\//.test(baseURL)) throw httpError(400, `provider ${id} 缺少合法的 baseURL`);
  const model = Array.isArray(p.models) && p.models[0] && typeof p.models[0].id === 'string' ? p.models[0].id : '';
  if (!model) throw httpError(400, `provider ${id} 没有可用模型`);
  // 现有 profile 把 key 放在 headers.authorization；也兼容 apiKeyEnv 指向的环境变量
  let key = '';
  if (p.headers && typeof p.headers.authorization === 'string') {
    key = p.headers.authorization.replace(/^Bearer\s+/i, '').trim();
  }
  if (!key && p.apiKeyEnv && typeof process.env[p.apiKeyEnv] === 'string') {
    key = process.env[p.apiKeyEnv].trim();
  }
  return { id, api, baseURL, model, key };
}

/**
 * GET /api/provider：把宿主 settings 里的 llm-pi-ai 摘要成可编辑表单。
 * 只回 id/显示名/协议/baseURL/模型/有没有 key——headers 里的 key 永不离开宿主。
 */
async function apiProviderGet() {
  if (!(await tcpProbe(HOST_PORT))) throw httpError(503, `宿主未启动（127.0.0.1:${HOST_PORT}）`);
  const d = await hostRpc('settings/describe', {});
  const nss = Array.isArray(d.namespaces) ? d.namespaces : [];
  const ns = nss.find((n) => n.ns === 'llm-pi-ai');
  if (!ns) throw httpError(502, '宿主没有 llm-pi-ai 命名空间');
  const def = nss.find((n) => n.ns === 'agent-default-model') || null;
  const providers = Object.entries((ns.value && ns.value.providers) || {}).map(([id, p]) => ({
    id,
    displayName: p.displayName || '',
    api: p.api || 'openai-completions',
    baseURL: p.baseURL || '',
    models: Array.isArray(p.models) ? p.models.map((m) => ({ ...m })) : [],
    hasKey: !!((p.headers && typeof p.headers.authorization === 'string' && p.headers.authorization.trim()) || p.apiKeyEnv),
  }));
  return {
    writable: !!d.writable,
    applies: ns.applies || null,
    revision: ns.revision,
    defaultRevision: def && typeof def.revision === 'number' ? def.revision : null,
    defaultProvider: def && def.value ? def.value.provider : null,
    defaultModel: def && def.value ? def.value.model : null,
    defaultReasoningEffort: def && def.value && typeof def.value.reasoningEffort === 'string' ? def.value.reasoningEffort : null,
    providers,
  };
}

/**
 * POST /api/provider：保存某个 provider（可新建），并可选设为默认模型 / 同步记忆整理。
 * 写入走宿主 settings（applies=live），所以不需要重启宿主；key 只从请求进、返回值不含。
 */
async function apiProviderSave(body) {
  if (runState.mode !== 'idle') throw httpError(409, '已有跑批进行中，稍后再改 provider');
  const provider = String(body.provider || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(provider)) throw httpError(400, 'provider 名称只允许字母、数字、点、下划线、连字符');
  const baseURL = String(body.baseURL || '').trim();
  if (!/^http(s)?:\/\//.test(baseURL)) throw httpError(400, 'baseURL 必须以 http:// 或 https:// 开头');
  const api = String(body.api || 'openai-completions');
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(api)) {
    throw httpError(400, `不支持的 API 协议：${api}`);
  }
  const model = String(body.model || '').trim();
  if (!model) throw httpError(400, '模型 ID 不能为空');
  const displayName = String(body.displayName || '').trim() || provider;
  const modelName = String(body.modelName || '').trim() || model;
  const contextWindow = Number(body.contextWindow);
  const maxTokens = Number(body.maxTokens);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) throw httpError(400, '上下文长度必须是正整数');
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) throw httpError(400, '最大输出必须是正整数');
  const apiKey = String(body.apiKey || '').trim();
  const oldModelId = String(body.oldModelId || '').trim();
  const setDefault = body.setDefault !== false;

  const snap = await apiProviderGet();
  if (!snap.writable) throw httpError(403, '宿主设置为只读，无法保存 provider');
  // 思考强度是默认模型（agent-default-model）的属性；选中档位时顺带为模型声明标准档位
  const EFFORT_LEVELS = { off: null, low: 'low', medium: 'medium', high: 'high' };
  const reasoningEffort = body.reasoningEffort !== undefined
    ? String(body.reasoningEffort || '').trim()
    : (snap.defaultReasoningEffort || '');
  if (reasoningEffort && !Object.prototype.hasOwnProperty.call(EFFORT_LEVELS, reasoningEffort)) {
    throw httpError(400, `不支持的思考强度：${reasoningEffort}`);
  }
  const existing = snap.providers.find((p) => p.id === provider);
  const oldModel = existing && oldModelId ? existing.models.find((m) => m.id === oldModelId) : null;
  // 保留同 provider 的其它模型；oldModelId 命中时沿用它的额外字段（input/compat 等）
  const models = (existing ? existing.models : [])
    .filter((m) => m.id !== model && (!oldModelId || m.id !== oldModelId))
    .map((m) => ({ ...m }));
  models.unshift({ ...(oldModel || {}), id: model, name: modelName, contextWindow, maxTokens });
  // 选了思考强度就先把该模型的标准档位声明齐；否则宿主会在回合开始前拒绝
  // UNSUPPORTED_REASONING_EFFORT（ds/deepseek-flash 之前就是这样失败的）。
  if (setDefault && reasoningEffort) {
    const target = models[0];
    const currentMap = typeof target.reasoningEfforts === 'object' && target.reasoningEfforts !== null
      ? { ...target.reasoningEfforts }
      : {};
    target.reasoningEfforts = { ...currentMap, ...EFFORT_LEVELS };
  }

  const ops = [
    { op: 'set', path: ['providers', provider, 'displayName'], value: displayName },
    { op: 'set', path: ['providers', provider, 'api'], value: api },
    { op: 'set', path: ['providers', provider, 'baseURL'], value: baseURL },
    { op: 'set', path: ['providers', provider, 'models'], value: models },
  ];
  // 留空 = 保留现有 key；填了才覆盖（兼容用户直接粘贴 "Bearer sk-..."）
  if (apiKey) {
    ops.push({
      op: 'set', path: ['providers', provider, 'headers', 'authorization'],
      value: /^Bearer\s+/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`,
    });
  }
  const saved = await hostRpc('settings/mutate', {
    ns: 'llm-pi-ai', ops, expectedRevision: snap.revision,
  });

  const warnings = [];
  let defaultSet = false;
  if (setDefault) {
    try {
      const defOps = [
        { op: 'set', path: ['provider'], value: provider },
        { op: 'set', path: ['model'], value: model },
      ];
      if (reasoningEffort) defOps.push({ op: 'set', path: ['reasoningEffort'], value: reasoningEffort });
      else defOps.push({ op: 'unset', path: ['reasoningEffort'] });
      await hostRpc('settings/mutate', {
        ns: 'agent-default-model',
        ops: defOps,
        expectedRevision: snap.defaultRevision == null ? undefined : snap.defaultRevision,
      });
      defaultSet = true;
    } catch (e) {
      warnings.push(`默认模型未更新：${e.message}`);
    }
  }

  let consolidation = null;
  if (body.setConsolidation !== false) {
    try {
      const r = await hostPluginRpc('setSettings', {
        patch: { consolidationModelMode: 'host', consolidationModel: `${provider}/${model}` },
      });
      consolidation = r && r.ok === false
        ? { ok: false, error: (r.error && r.error.message) || '插件拒绝写入' }
        : { ok: true };
    } catch (e) {
      consolidation = { ok: false, error: e.message };
    }
    if (consolidation.ok === false) warnings.push(`记忆整理模型未同步：${consolidation.error}`);
  }

  return { saved: true, provider, model, displayName, revision: saved.revision, defaultSet, consolidation, warnings };
}

// ---------------------------------------------------------------------------
// 跑批状态与 SSE 广播
// ---------------------------------------------------------------------------

// 结构即契约：/api/run/state 与 SSE state 事件原样下发这个对象
const runState = {
  mode: 'idle',
  exam: {
    running: false, label: null, outFile: null, ids: [], current: null,
    statuses: {}, startedAt: null, endedAt: null, error: null,
  },
  judge: {
    running: false, answersFile: null, label: null,
    model: null, keep: false, // 二轮：判分端点覆盖与"保留现场"旗标，形状与运行中一致
    packets: 0, batchesTotal: 0, currentBatch: 0,
    startedAt: null, endedAt: null, error: null,
    outFiles: { reviews: null, scored: null, summary: null },
  },
  lastLines: [], // exam/judge 合并的最近 40 行，前端冷启动时靠它补进度上下文
};

const sseClients = new Set();

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    sseClients.delete(res); // 写失败的客户端由 close/error 兜底清理
  }
}

function sseSendAll(event, data) {
  for (const res of [...sseClients]) sseSend(res, event, data);
}

let lastBroadcastAt = 0;
let stateTimer = null;

/** 300ms 节流合并：逐 token 行的高频变更不打爆前端，末次变更 300ms 内必有 trailing 推送 */
function broadcastState() {
  const now = Date.now();
  const wait = 300 - (now - lastBroadcastAt);
  if (wait <= 0) {
    lastBroadcastAt = now;
    sseSendAll('state', runState);
    return;
  }
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    lastBroadcastAt = Date.now();
    sseSendAll('state', runState);
  }, wait);
}

function pushLine(source, line) {
  runState.lastLines.push({ source, line, ts: Date.now() });
  if (runState.lastLines.length > 40) {
    runState.lastLines.splice(0, runState.lastLines.length - 40);
  }
  sseSendAll('log', { source, line });
}

// ---------------------------------------------------------------------------
// 子进程管理（exam / judge）
// ---------------------------------------------------------------------------

let examChild = null;
let judgeChild = null;
let examCrashMode = false; // 崩溃行之后到来的输出并入 error，保留堆栈给前端展示

function killTree(child) {
  if (!child || child.pid == null) return;
  if (child.exitCode !== null || child.signalCode !== null) return; // 已经退了
  if (process.platform === 'win32') {
    // /T 必须带上：judge 链里有 python 孙进程，只杀父进程会留孤儿还占着结果文件
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
      return;
    } catch {
      /* 进程可能恰好自行退出，落到下面的 kill 兜底 */
    }
  }
  try {
    child.kill();
  } catch {
    /* 同上 */
  }
}

/**
 * 挂 stdout/stderr 的按行解析与收尾钩子。手动 split 而非 readline：
 * 残留半行留在 buf 里等下一块拼上，流 end 时兜底冲刷。
 * 收尾挂 close 而非 exit：close 保证 stdio 已排空，末尾几行不会漏解析。
 */
function wireChild(child, source, onLine, onFinalize) {
  let finalized = false;
  const finalizeOnce = (code, signal) => {
    if (finalized) return;
    finalized = true;
    try {
      onFinalize(code, signal);
    } catch (err) {
      console.error('[finalize]', err);
    }
  };
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
    });
    stream.on('end', () => {
      const rest = buf.replace(/\r$/, '');
      buf = '';
      if (rest.trim()) onLine(rest);
    });
  }
  child.on('close', (code, signal) => finalizeOnce(code, signal));
  child.on('error', (err) => {
    pushLine(source, `子进程启动失败: ${err.message}`);
    finalizeOnce(-1, null);
  });
}

// ---- exam ----

function startExam(ids, label, opts = {}) {
  const outFile = `results/answers-dashboard-${label}.jsonl`;
  const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || 4));
  const prepare = opts.prepare !== false; // 默认每轮都重建记忆库再考
  const statuses = {};
  // 全部 ids 预置 pending：前端一开跑就能画出整列进度，而不是等行进来逐个冒出
  for (const id of ids) {
    statuses[id] = {
      state: 'pending', attempts: 0, turnEnd: null, answerChars: 0,
      tokensTotal: null, // 完成行 tokens 段（总 token 数；n/a/缺失为 null）
      tokens: { prompt: 0, completion: 0, est: 0 },
    };
  }
  runState.mode = 'exam';
  runState.exam = {
    running: true, label, outFile, ids: ids.slice(), current: null,
    statuses, startedAt: Date.now(), endedAt: null, error: null,
    concurrency, prepare, phase: prepare ? 'prepare' : 'exam',
    prepareDone: 0, prepareTotal: 0, prepareTag: null,
  };
  examCrashMode = false;
  // 714 全量的 ids 串会超 Windows 命令行长度，>50 题改走 ids 文件
  const idsFile = ids.length > 50 ? `results/run-ids-${label}.txt` : null;
  const argv = [path.join(ROOT, 'scripts', 'exam-run.mjs')];
  if (idsFile) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ROOT, idsFile), ids.join('\n') + '\n', 'utf8');
    argv.push('--ids-file', idsFile);
  } else {
    argv.push('--ids', ids.join(','));
  }
  argv.push('--out', outFile, '--max-attempts', '3', '--concurrency', String(concurrency), '--label', label);
  if (!prepare) argv.push('--no-prepare');
  const child = spawn(process.execPath, argv, { cwd: ROOT, windowsHide: true });
  examChild = child;
  wireChild(child, 'exam', onExamLine, (code, signal) => finalizeExam(child, code, signal));
  broadcastState();
}

function onExamLine(line) {
  pushLine('exam', line);
  if (runState.mode !== 'exam') return; // 收尾后的残余输出不再改状态
  const ex = runState.exam;
  let m;
  // 记忆重建阶段：prepare checkpoint i/N <persona> ck<cutoff> ...
  if ((m = /^prepare checkpoint\s+(\d+)\/(\d+)\s+(\S+)\s+ck(\d+)/.exec(line))) {
    ex.phase = 'prepare';
    ex.prepareDone = Number(m[1]) || 0;
    ex.prepareTotal = Number(m[2]) || 0;
    ex.prepareTag = `${m[3]} ck${m[4]}`;
    broadcastState();
    return;
  }
  if (/^prepare done/.test(line)) {
    ex.phase = 'exam';
    broadcastState();
    return;
  }
  if ((m = /^exam\s+(.+?)\s+cutoff_turn\s+(\d+)\s*$/.exec(line))) {
    const st = ex.statuses[m[1]];
    if (st) {
      st.state = 'running';
      ex.current = m[1];
      broadcastState();
    }
    return;
  }
  // 并发模式下重试行必须带题号，否则无法归属到具体题
  if ((m = /^\s*(\S+)\s+attempt\s+(\d+)\s+failed,\s*backoff\s+[\d.]+s/.exec(line))) {
    const cur = ex.statuses[m[1]];
    if (cur) {
      cur.attempts = Math.max(cur.attempts, Number(m[2]) || 0);
      broadcastState();
    }
    return;
  }
  if ((m = /^\s*attempt\s+(\d+)\s+failed,\s*backoff\s+[\d.]+s/.exec(line))) {
    // 兼容旧格式：没有题号时只能归到最近启动的那道题
    const cur = ex.current ? ex.statuses[ex.current] : null;
    if (cur) {
      cur.attempts = Math.max(cur.attempts, Number(m[1]) || 0);
      broadcastState();
    }
    return;
  }
  if ((m = /^\s*->\s*(\S+)\s+(\S+)\s+answer chars:\s*(\d+)(?:\s+tokens:\s*(\S+))?\s*$/.exec(line))) {
    // 首尾两段：题号 + end.kind（completed/timeout/failed...）。completed 且有非空作答才算 done。
    const cur = ex.statuses[m[1]];
    if (cur) {
      cur.turnEnd = m[2];
      cur.answerChars = Number(m[3]) || 0;
      const tok = m[4];
      cur.tokensTotal = tok && tok !== 'n/a' && Number.isFinite(Number(tok)) ? Number(tok) : null;
      cur.state = m[2] === 'completed' && cur.answerChars > 0 ? 'done' : 'failed';
      if (ex.current === m[1]) {
        ex.current = Object.keys(ex.statuses).find((qid) => ex.statuses[qid].state === 'running') || null;
      }
      broadcastState();
    }
    return;
  }
  if (line.includes('exam-run crashed:')) {
    examCrashMode = true;
    ex.error = line;
    return;
  }
  if (examCrashMode && ex.error && ex.error.length < 4000) {
    ex.error += `\n${line}`; // 崩溃堆栈并进 error，限长防异常输出撑爆内存
  }
}

function finalizeExam(child, code, signal) {
  if (examChild !== child) return; // 旧进程的 close 迟到，不能污染新一轮的状态对象
  examChild = null;
  const ex = runState.exam;
  for (const st of Object.values(ex.statuses)) {
    if (st.state === 'running') st.state = 'failed'; // 进程没了还没出结果的就是失败
  }
  ex.running = false;
  ex.endedAt = Date.now();
  if (ex.error === null && ((code !== null && code !== 0) || signal)) {
    ex.error = `exam 进程异常退出 code=${code}${signal ? ` signal=${signal}` : ''}`;
  }
  runState.mode = 'idle';
  broadcastState();
}

// ---- judge ----

function startJudge(answersFile, label, opts = {}) {
  const batch = Math.max(1, Math.min(100, Number(opts.batch) || JUDGE_BATCH_DEFAULT));
  runState.mode = 'judge';
  runState.judge = {
    running: true, answersFile, label,
    model: opts.model || null, keep: opts.keep === true,
    packets: 0, batch, batchesTotal: 0, currentBatch: 0,
    startedAt: Date.now(), endedAt: null, error: null,
    outFiles: {
      reviews: `results/reviews-${label}.jsonl`,
      scored: `results/scored-${label}.jsonl`,
      summary: `results/summary-${label}.jsonl.json`, // 与 judge-grade 的派生命名一致（runScore 处有说明）
    },
  };
  // 端点/模型/key 覆盖只经环境变量进子进程（PROBE_*），key 绝不写日志/state/lastLines
  const env = { ...process.env };
  if (opts.model) env.PROBE_MODEL = opts.model;
  if (opts.baseUrl) env.PROBE_BASE = opts.baseUrl;
  if (opts.key) env.PROBE_KEY = opts.key;
  // --keep 只在用户显式勾选「保留」时带上（keep===true）。默认不保留＝判分成功后
  // 脚本自动 bench-reset 清库，防止残留记忆干扰后续批次的测试（用户裁定 2026-11-06）
  const args = [
    path.join(ROOT, 'scripts', 'judge-grade.mjs'),
    '--answers', `results/${answersFile}`,
    '--stage', `results/packets-${label}.jsonl`,
    '--reviews', `results/reviews-${label}.jsonl`,
    '--batch', String(batch),
  ];
  if (opts.keep === true) args.push('--keep');
  const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env });
  judgeChild = child;
  wireChild(child, 'judge', onJudgeLine, (code, signal) => finalizeJudge(child, code, signal));
  broadcastState();
}

function onJudgeLine(line) {
  pushLine('judge', line);
  if (runState.mode !== 'judge') return;
  const j = runState.judge;
  let m;
  if ((m = /^packets:\s*(\d+)\s*$/.exec(line))) {
    j.packets = Number(m[1]) || 0;
    j.batchesTotal = Math.ceil(j.packets / j.batch); // batch 大小是我们自己传的，可据此出进度条
    broadcastState();
    return;
  }
  if ((m = /^judge batch\s+(\d+):\s*\d+\s+questions/.exec(line))) {
    j.currentBatch = Math.max(j.currentBatch, Number(m[1]) || 0); // 脚本内可能整批重试，取最大批次号
    broadcastState();
    return;
  }
  // "judge batch failed (attempt ...)" 是脚本内自重试，等它的下一行即可，不改状态；
  // "reviews written:/scored:" 打印的是绝对路径，outFiles 保持 start 时预测的相对路径（契约形状）。
}

function finalizeJudge(child, code, signal) {
  if (judgeChild !== child) return;
  judgeChild = null;
  const j = runState.judge;
  j.running = false;
  j.endedAt = Date.now();
  if (j.error === null && ((code !== null && code !== 0) || signal)) {
    j.error = `judge 进程异常退出 code=${code}${signal ? ` signal=${signal}` : ''}`;
  }
  runState.mode = 'idle';
  broadcastState();
}

// ---- 跑批 REST 动作 ----

async function apiRunStart(body) {
  if (runState.mode !== 'idle') throw httpError(409, '已有跑批进行中');
  if (!(await tcpProbe(HOST_PORT))) {
    throw httpError(503, `宿主未启动（127.0.0.1:${HOST_PORT} 不可达）`);
  }
  // label 防撞：命名只到秒，同一秒内连开两次会得到同名文件（判分产物按同 stem 派生，
  // 一撞就是整批互相覆盖）——已存在就追加 -2/-3 序号
  const base = makeLabel();
  let label = base;
  for (let n = 1; fs.existsSync(path.join(RESULTS_DIR, `answers-${label}.jsonl`)); ) {
    label = `${base}-${++n}`;
  }
  const concurrency = Math.max(1, Math.min(8, Number(body.concurrency) || 4));
  const prepare = body.prepare !== false; // 默认每轮重建记忆库
  // 显式 ids 优先（单题重测/题库勾选/跨组选题等场景）：必须全部是 exam-inputs 里存在的题号
  if (Array.isArray(body.ids)) {
    const ids = body.ids.filter((x) => typeof x === 'string' && x);
    if (!ids.length) throw httpError(400, 'ids 为空');
    const known = new Set(getExamInputs().map((q) => q && q.id).filter(Boolean));
    const bad = ids.filter((id) => !known.has(id));
    if (bad.length) throw httpError(400, `未知题目 id: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ' …' : ''}`);
    startExam(ids, label, { concurrency, prepare });
    return { started: true, label, ids, outFile: `results/answers-dashboard-${label}.jsonl`, concurrency, prepare };
  }
  // 多组同时跑：personas 数组 + startIndex/count（每组各切一段），一次可跑后面多组或全部组
  const personaArg = typeof body.persona === 'string' ? body.persona : '';
  const personas = Array.isArray(body.personas)
    ? body.personas.filter((x) => typeof x === 'string' && x)
    : (personaArg ? [personaArg] : []);
  const startIndex = Number(body.startIndex);
  const count = Number(body.count);
  if (!personas.length || !Number.isInteger(startIndex) || startIndex < 1 || !Number.isInteger(count) || count < 1) {
    throw httpError(400, '参数不合法：需要 ids 数组，或 personas/persona、startIndex>=1、count>=1');
  }
  const all = getExamInputs();
  const slice = [];
  for (const persona of personas) {
    const ids = all
      .filter((r) => r && r.persona === persona && typeof r.id === 'string')
      .map((r) => r.id);
    if (!ids.length) throw httpError(400, `未知 persona: ${persona}`);
    slice.push(...ids.slice(startIndex - 1, startIndex - 1 + count));
  }
  if (!slice.length) throw httpError(400, '切片为空：startIndex 超出所选 persona 的题目范围');
  startExam(slice, label, { concurrency, prepare });
  return { started: true, label, ids: slice, outFile: `results/answers-dashboard-${label}.jsonl`, concurrency, prepare };
}

function apiRunStop() {
  const child = examChild;
  if (runState.mode !== 'exam' || !child) throw httpError(409, '当前没有进行中的考试');
  runState.exam.error = '已被手动停止'; // 预置错误文案，finalize 里就不会再补"异常退出"
  killTree(child);
  return { stopped: true };
}

/**
 * answers 文件名公共校验（judge/start 与 external/prepare 共用）：
 * 只收 results/ 下的 basename——判分子进程与 grade.py 都以 cwd=ROOT 解析相对路径，
 * 路径穿越/绝对路径会落到错误位置；返回文件名与从文件名推导的 label。
 */
function resolveAnswersFile(raw) {
  if (typeof raw !== 'string' || raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw httpError(400, 'answersFile 只允许文件名');
  }
  if (!/^answers-.+\.jsonl$/.test(raw)) throw httpError(400, 'answersFile 必须匹配 answers-*.jsonl');
  let ok = false;
  try {
    ok = fs.statSync(path.join(RESULTS_DIR, raw)).isFile();
  } catch {
    /* 不存在 */
  }
  if (!ok) throw httpError(400, `answers 文件不存在: ${raw}`);
  const label = raw.slice('answers-'.length, raw.length - '.jsonl'.length);
  if (!label) throw httpError(400, 'label 为空');
  return { file: raw, label };
}

async function apiJudgeStart(body) {
  if (runState.mode !== 'idle') throw httpError(409, '已有跑批进行中');
  const { file, label } = resolveAnswersFile(body.answersFile);
  // 可选判分端点覆盖：缺省 undefined 即用脚本内置默认值
  const opts = {};
  if (body.model !== undefined) {
    if (typeof body.model !== 'string') throw httpError(400, 'model 必须是字符串');
    const model = body.model.trim();
    if (model.length > 200) throw httpError(400, 'model 超过 200 字符');
    opts.model = model;
  }
  if (body.baseUrl !== undefined) {
    if (typeof body.baseUrl !== 'string') throw httpError(400, 'baseUrl 必须是字符串');
    const baseUrl = body.baseUrl.trim();
    if (!/^https?:\/\//.test(baseUrl)) throw httpError(400, 'baseUrl 必须以 http:// 或 https:// 开头');
    opts.baseUrl = baseUrl;
  }
  if (body.key !== undefined) {
    if (typeof body.key !== 'string') throw httpError(400, 'key 必须是字符串');
    if (body.key.length > 500) throw httpError(400, 'key 超过 500 字符');
    opts.key = body.key;
  }
  // 选择已有 provider 时，baseURL/model/key 由服务端补全；
  // 手填的 model/baseUrl/key 优先级更高（允许临时覆盖某个 provider 的默认值）。
  let provider = null;
  if (typeof body.provider === 'string' && body.provider.trim()) {
    provider = await providerRuntime(body.provider.trim());
    if (!opts.model) opts.model = provider.model;
    if (!opts.baseUrl) opts.baseUrl = provider.baseURL;
    if (!opts.key) opts.key = provider.key;
  }
  opts.keep = body.keep; // !== false 即保留（缺省也保留；只有显式 false 才让脚本自动清库）
  // 判分批大小可调：越大请求越少（20 题可一次判完），上限 100 防止回复被截断。
  if (body.batch !== undefined) {
    const batch = Number(body.batch);
    if (!Number.isInteger(batch) || batch < 1 || batch > 100) throw httpError(400, 'batch 必须是 1..100 的整数');
    opts.batch = batch;
  }
  startJudge(file, label, opts);
  return {
    started: true,
    label,
    provider: provider ? { id: provider.id, model: provider.model, baseURL: provider.baseURL } : null,
  };
}

// ---------------------------------------------------------------------------
// 外部判分工作流与结果台账端点
// prepare → 拿 promptMd 喂外部模型/人工 → import（或 edit 修正）→ rescore/reset。
// grade.py 是离线纯计算、秒级完成，动作全部同步阻塞在请求里，不再另开异步任务状态。
// ---------------------------------------------------------------------------

/** reviews 行的旗标键（全 bool）与清单键（全为非空字符串数组）——与 grade.py 口径一致 */
const REVIEW_FLAGS = ['错认', '错否', '越界', '编造日期', '不当私事披露'];
const REVIEW_LISTS = ['违反禁止', '未知当事实', '无关旧事'];

/** score 系列端点的 label 公共校验：白名单字符集，拼文件名时杜绝路径穿越 */
function validScoreLabel(raw) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._-]+$/.test(raw)) {
    throw httpError(400, 'label 只允许字母、数字、点、下划线、连字符');
  }
  return raw;
}

function resultsFileExists(name) {
  try {
    return fs.statSync(path.join(RESULTS_DIR, name)).isFile();
  } catch {
    return false;
  }
}

/** packets-<label>.jsonl → id 索引（文件序即时间序，同 id 后行覆盖前行） */
function packetsIndex(label) {
  const map = new Map();
  for (const row of readJsonl(path.join(RESULTS_DIR, `packets-${label}.jsonl`))) {
    if (row && typeof row.id === 'string') map.set(row.id, row);
  }
  return map;
}

/** 「非空字符串数组」：数组本身可为空（合规样本就是 []），但元素必须都是非空字符串 */
function isStringArrayOfNonEmpty(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');
}

/**
 * 单行 review 对 packet 的合规检查，返回 null 或首个不合规字段名。
 * 口径学 judge-grade.mjs：sha 必须与对应 packet 一致、required 长度一致，
 * 外加旗标/清单/reason 的类型闭合（import 与 edit 共用同一套）。
 */
function reviewRowProblem(row, packet) {
  if (row.answer_sha256 !== packet.answer_sha256) return 'answer_sha256';
  if (row.rubric_sha256 !== packet.rubric_sha256) return 'rubric_sha256';
  const reqLen = packet.rubric && Array.isArray(packet.rubric.required) ? packet.rubric.required.length : -1;
  if (!Array.isArray(row.required) || row.required.length !== reqLen
    || row.required.some((x) => typeof x !== 'boolean')) {
    return 'required';
  }
  for (const k of REVIEW_FLAGS) {
    if (typeof row[k] !== 'boolean') return k;
  }
  for (const k of REVIEW_LISTS) {
    if (!isStringArrayOfNonEmpty(row[k])) return k;
  }
  if (typeof row.reason !== 'string' || row.reason === '') return 'reason';
  return null;
}

/** 共享校验器入口：不合规即抛 400，消息带题号（无 id 时退行号）与首个不合规字段 */
function validateReviewRow(row, packetsById, idx) {
  const tag = row && typeof row.id === 'string' && row.id ? row.id : `第${idx + 1}行`;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw httpError(400, `review 行不合规（${tag}）: 不是 JSON 对象`);
  }
  const packet = packetsById.get(row.id);
  if (!packet) throw httpError(400, `review 行不合规（${tag}）: packets 里没有该题`);
  const problem = reviewRowProblem(row, packet);
  if (problem) throw httpError(400, `review 行不合规（${tag}）: ${problem}`);
}

/** 跑 grade.py（同步、pipe、限时 120s）；失败 500，带 stderr 尾部 400 字符方便定位 */
function runGradePy(args) {
  try {
    execFileSync('python', ['-I', GRADE_PY, ...args], { cwd: ROOT, timeout: 120000, encoding: 'utf8', windowsHide: true });
  } catch (err) {
    const tail = typeof err.stderr === 'string' ? err.stderr.slice(-400) : '';
    throw httpError(500, `grade.py 执行失败: ${tail || (err && err.message) || String(err)}`);
  }
}

/** 跑 grade.py score：packets+reviews → scored+summary。
 * summary 落点必须与 judge-grade.mjs 的派生规则逐字一致：
 * scored 路径把 scored- 换成 summary- 后再追加 .json → `summary-<label>.jsonl.json`，
 * 否则同一个批次会出现两个 summary 文件、reset 也删不干净。 */
function runScore(label) {
  runGradePy(['score',
    '--packets', `results/packets-${label}.jsonl`,
    '--reviews', `results/reviews-${label}.jsonl`,
    '--out', `results/scored-${label}.jsonl`,
    '--summary', `results/summary-${label}.jsonl.json`]);
}

/** 读 summary：优先脚本命名的 summary-<label>.jsonl.json，兼容旧式 summary-<label>.json */
function readSummaryJson(label) {
  for (const name of [`summary-${label}.jsonl.json`, `summary-${label}.json`]) {
    try {
      return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, name), 'utf8'));
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

/** GET /api/answers：results/answers-*.jsonl 一览，mtime 降序（新的在前） */
function apiAnswers() {
  const files = listResultsFiles('answers-', '.jsonl')
    .reverse() // listResultsFiles 给的是 mtime 升序，接口契约要降序
    .map((f) => {
      const rows = readJsonl(path.join(RESULTS_DIR, f.name));
      return {
        file: f.name,
        mtime: new Date(f.mtimeMs).toISOString(),
        rows: rows.length,
        answered: rows.filter((r) => r && typeof r.answer === 'string' && r.answer !== '').length,
      };
    });
  return { files };
}

/** POST /api/external/prepare：拼一份"判分模板 + packets JSON"的完整提示词给外部模型 */
function apiExternalPrepare(body) {
  if (runState.mode !== 'idle') throw httpError(409, '已有跑批进行中');
  const { file, label } = resolveAnswersFile(body.answersFile);
  runGradePy(['prepare', '--answers', `results/${file}`, '--out', `results/packets-${label}.jsonl`]);
  const rows = readJsonl(path.join(RESULTS_DIR, `packets-${label}.jsonl`));
  let template;
  try {
    template = fs.readFileSync(EXTERNAL_PROMPT_MD, 'utf8');
  } catch {
    throw httpError(500, '判分模板缺失: grading/external-judge-prompt.md');
  }
  const promptMd = `${template}\n\n\`\`\`json\n${JSON.stringify(rows, null, 1)}\n\`\`\`\n`;
  return { label, packetsCount: rows.length, promptMd };
}

/** POST /api/score/import：外部判分结果整体导入并计分 */
function apiScoreImport(body) {
  if (runState.mode !== 'idle') throw httpError(409, '已有跑批进行中');
  const label = validScoreLabel(body.label);
  if (!resultsFileExists(`packets-${label}.jsonl`)) {
    throw httpError(400, `packets 文件不存在: packets-${label}.jsonl（先跑 /api/external/prepare）`);
  }
  if (typeof body.reviewsText !== 'string' || !body.reviewsText.trim()) {
    throw httpError(400, 'reviewsText 必须是非空字符串');
  }
  // 两路解析：整体 JSON 数组优先（外部模型常整段回复），失败退逐行 JSONL
  let reviews = null;
  try {
    const parsed = JSON.parse(body.reviewsText);
    if (Array.isArray(parsed)) reviews = parsed;
  } catch {
    /* 落逐行解析 */
  }
  if (reviews === null) {
    reviews = [];
    for (const line of body.reviewsText.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        reviews.push(JSON.parse(t));
      } catch {
        throw httpError(400, `reviewsText 逐行解析失败: ${t.slice(0, 80)}`);
      }
    }
  }
  if (!reviews.length) throw httpError(400, 'reviewsText 没有解析出任何 review 行');
  const packetsById = packetsIndex(label);
  for (let i = 0; i < reviews.length; i += 1) validateReviewRow(reviews[i], packetsById, i);
  // 校验通过才覆盖写盘；行格式与 judge-grade 的写法一致（单行 JSON + 换行收尾）
  fs.writeFileSync(
    path.join(RESULTS_DIR, `reviews-${label}.jsonl`),
    reviews.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
  runScore(label);
  const scoredRows = readJsonl(path.join(RESULTS_DIR, `scored-${label}.jsonl`));
  return {
    label,
    scored: scoredRows.length,
    passed: scoredRows.filter((r) => r && r.pass === true).length,
    summary: readSummaryJson(label),
  };
}

/** POST /api/score/edit：人工修正单条 review 后重算 */
function apiScoreEdit(body) {
  if (runState.mode !== 'idle') throw httpError(409, '已有跑批进行中');
  const label = validScoreLabel(body.label);
  if (!resultsFileExists(`packets-${label}.jsonl`)) throw httpError(400, `packets 文件不存在: packets-${label}.jsonl`);
  if (!resultsFileExists(`reviews-${label}.jsonl`)) throw httpError(400, `reviews 文件不存在: reviews-${label}.jsonl`);
  if (typeof body.id !== 'string' || !body.id) throw httpError(400, 'id 必须是非空字符串');
  const patch = body.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw httpError(400, 'patch 必须是对象');
  const rows = readJsonl(path.join(RESULTS_DIR, `reviews-${label}.jsonl`));
  const idx = rows.findIndex((r) => r && r.id === body.id);
  if (idx < 0) throw httpError(404, `reviews 里没有该题: ${body.id}`);
  const packetsById = packetsIndex(label);
  const packet = packetsById.get(body.id);
  if (!packet) throw httpError(400, `题 ${body.id} 在 packets 中不存在`);
  const reqLen = packet.rubric && Array.isArray(packet.rubric.required) ? packet.rubric.required.length : -1;
  // 白名单外的键直接忽略；id/answer_sha256/rubric_sha256 不在白名单里，天然改不到
  const merged = { ...rows[idx] };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'required') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'boolean') || v.length !== reqLen) {
        throw httpError(400, `patch.required 不合法: 需要长度为 ${reqLen} 的布尔数组`);
      }
      merged[k] = v.slice();
    } else if (REVIEW_FLAGS.includes(k)) {
      if (typeof v !== 'boolean') throw httpError(400, `patch.${k} 必须是布尔值`);
      merged[k] = v;
    } else if (REVIEW_LISTS.includes(k)) {
      if (!isStringArrayOfNonEmpty(v)) throw httpError(400, `patch.${k} 必须是非空字符串数组`);
      merged[k] = v.slice();
    } else if (k === 'reason') {
      if (typeof v !== 'string' || v === '') throw httpError(400, 'patch.reason 必须是非空字符串');
      merged[k] = v;
    }
  }
  validateReviewRow(merged, packetsById, idx); // 合并行过一遍共享校验器，写盘前兜底
  rows[idx] = merged;
  fs.writeFileSync(
    path.join(RESULTS_DIR, `reviews-${label}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
  runScore(label);
  return { label, review: merged, summary: readSummaryJson(label) };
}

/** POST /api/score/rescore：reviews 不动，只重跑计分 */
function apiScoreRescore(body) {
  if (runState.mode !== 'idle') throw httpError(409, '已有跑批进行中');
  const label = validScoreLabel(body.label);
  if (!resultsFileExists(`packets-${label}.jsonl`)) throw httpError(400, `packets 文件不存在: packets-${label}.jsonl`);
  if (!resultsFileExists(`reviews-${label}.jsonl`)) throw httpError(400, `reviews 文件不存在: reviews-${label}.jsonl`);
  runScore(label);
  return { label, summary: readSummaryJson(label) };
}

/** POST /api/score/reset：清掉某一轮的判分产物（reviews 可选保留），不存在的跳过 */
function apiScoreReset(body) {
  if (runState.mode !== 'idle') throw httpError(409, '已有跑批进行中');
  const label = validScoreLabel(body.label);
  // summary 有两种历史命名（脚本派生的 .jsonl.json 与旧式 .json），两个候选都清
  const names = [`scored-${label}.jsonl`, `summary-${label}.jsonl.json`, `summary-${label}.json`];
  if (body.includeReviews === true) names.push(`reviews-${label}.jsonl`);
  const deleted = [];
  for (const name of names) {
    try {
      fs.unlinkSync(path.join(RESULTS_DIR, name));
      deleted.push(name);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // 只跳过"不存在"，其它错误照常 500
    }
  }
  return { deleted };
}

/**
 * POST /api/score/reset-all：一键清空所有批次的判分产物（题库页按钮）。
 * 默认只删 scored/summary，answers/packets/reviews 保留；includeReviews=true 时连 reviews 删。
 * includeAnswers=true 时连作答与判据包（含 exam 快照）一起删，题库回到「未作答」——
 * 这是「全新模式」的语义；记忆库/会话不在这里处理。
 */
function apiScoreResetAll(body) {
  if (runState.mode !== 'idle') throw httpError(409, '已有跑批进行中');
  const includeReviews = body && body.includeReviews === true;
  const includeAnswers = body && body.includeAnswers === true;
  let names = [];
  try {
    names = fs.readdirSync(RESULTS_DIR);
  } catch {
    return { deleted: [], includeReviews, includeAnswers }; // results 目录暂时不在：等价于没有可清的东西
  }
  const deleted = [];
  for (const name of names) {
    const isScored = /^scored-[^/]+\.jsonl$/.test(name);
    const isSummary = /^summary-[^/]+\.(jsonl\.json|json)$/.test(name);
    const isReview = includeReviews && /^reviews-[^/]+\.jsonl$/.test(name);
    const isAnswers = includeAnswers && (
      /^answers-[^/]+\.jsonl$/.test(name)
      || /^packets-[^/]+\.jsonl$/.test(name)
      || name === 'exam-packets.jsonl'
      || name === 'exam-judge-prompt.md'
      || /^run-ids-[^/]+\.txt$/.test(name)
    );
    if (!isScored && !isSummary && !isReview && !isAnswers) continue;
    try {
      fs.unlinkSync(path.join(RESULTS_DIR, name));
      deleted.push(name);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return { deleted, includeReviews, includeAnswers };
}

/**
 * POST /api/reset/run：手动跑 bench-reset.mjs（清会话+记忆库）。
 * reset 可能要几十秒，不设超时，挂 close 收尾；bench-reset 的 pretty JSON 摘要
 * 打在 stdout，从第一个 { 到最后一个 } 截取解析（stderr 单独收，不搅乱截取）。
 */
function apiResetRun(body) {
  if (runState.mode !== 'idle') throw httpError(409, '已有跑批进行中');
  const args = [path.join(ROOT, 'scripts', 'bench-reset.mjs')];
  if (body.dryRun === true) args.push('--dry-run');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    const lines = []; // stdout+stderr 全部行，原样回给前端
    const outLines = []; // 仅 stdout：摘要 JSON 只可能出自这里
    const collect = (mirror) => (chunk) => {
      for (const raw of chunk.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        lines.push(line);
        if (mirror) mirror.push(line);
      }
    };
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', collect(outLines));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', collect(null));
    }
    child.on('close', (code) => {
      const text = outLines.join('\n');
      let result = null;
      const a = text.indexOf('{');
      const b = text.lastIndexOf('}');
      if (a >= 0 && b > a) {
        try {
          result = JSON.parse(text.slice(a, b + 1));
        } catch {
          /* 摘要缺失/不完整就按 null 下发，ok 仍以退出码为准 */
        }
      }
      resolve({ ok: code === 0, result, lines });
    });
    child.on('error', (err) => {
      lines.push(`子进程启动失败: ${err.message}`);
      resolve({ ok: false, result: null, lines });
    });
  });
}

/** GET /api/score/labels：扫 summary-*.json 给前端下拉，mtime 降序（新的在前）。
 * label 还原成批次 stem：脚本的 summary 命名是 summary-<stem>.jsonl.json，
 * 旧文件是 summary-<stem>.json——先剥 summary- 前缀，再剥对应后缀。 */
function apiScoreLabels() {
  const labels = listResultsFiles('summary-', '.json')
    .reverse() // listResultsFiles 给的是 mtime 升序，接口契约要降序
    .map((f) => {
      const stem = f.name.slice('summary-'.length);
      const suffix = stem.endsWith('.jsonl.json') ? '.jsonl.json' : '.json';
      return {
        label: stem.slice(0, stem.length - suffix.length),
        summaryFile: f.name,
        mtime: new Date(f.mtimeMs).toISOString(),
      };
    });
  return { labels };
}

// ---------------------------------------------------------------------------
// api-log 增量 tail：喂当前考试的每题 token 累计
// ---------------------------------------------------------------------------

// 启动时对齐到文件尾：tail 只追服务启动之后的新增行，历史台账由 /api/tokens 全量负责
let apiLogOffset = (() => {
  try {
    return fs.statSync(API_LOG).size;
  } catch {
    return null; // 文件还没出现，等第一次 tick 再对齐
  }
})();

function tailApiLog() {
  try {
    let st;
    try {
      st = fs.statSync(API_LOG);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    if (apiLogOffset === null) {
      apiLogOffset = st.size;
      return;
    }
    if (st.size < apiLogOffset) apiLogOffset = 0; // 文件被截断/轮转，从头重读
    if (st.size === apiLogOffset) return;

    const len = st.size - apiLogOffset;
    const fd = fs.openSync(API_LOG, 'r');
    let text = '';
    try {
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, apiLogOffset);
      // 只消费到最后一个完整行；半行按字节留在原地等下一轮（按 0x0A 切，多字节字符不会被切坏）
      const nl = buf.lastIndexOf(0x0a);
      if (nl < 0) return;
      apiLogOffset += nl + 1;
      text = buf.slice(0, nl + 1).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }

    // 只有行带 qid 且落在当前考试的 ids 里才累加——其它 purpose 的行不该记到题目头上
    const active = runState.mode === 'exam' && runState.exam.running
      ? new Set(runState.exam.ids)
      : null;
    if (!active) return;
    let dirty = false;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let rec;
      try {
        rec = JSON.parse(t);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== 'object' || typeof rec.qid !== 'string' || !active.has(rec.qid)) continue;
      const stq = runState.exam.statuses[rec.qid];
      if (!stq) continue;
      const info = parseTokenLine(rec); // exam-usage 行带 usage → 真实值；exam-prompt 行 → 估算值
      stq.tokens.prompt += info.prompt || 0;
      stq.tokens.completion += info.completion || 0;
      stq.tokens.est += info.est || 0;
      dirty = true;
    }
    if (dirty) broadcastState();
  } catch {
    /* 台账读取的任何意外都不允许拖垮服务主流程 */
  }
}

// ---------------------------------------------------------------------------
// HTTP 路由 / 静态文件 / 请求体
// ---------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        req.destroy();
        reject(httpError(413, '请求体超过 1MB 上限'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    throw httpError(400, 'bad path');
  }
  if (decoded.includes('\0')) throw httpError(404, 'not found');
  const filePath = path.normalize(path.join(PUBLIC_DIR, decoded));
  // 归一化后必须仍在 public 根内：拦 ../ 穿越，也给"目录本身"这类怪路径一个 404
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw httpError(404, 'not found');
  let st = null;
  try {
    st = fs.statSync(filePath);
  } catch {
    /* 不存在 */
  }
  if (!st || !st.isFile()) throw httpError(404, 'not found');
  const ext = path.extname(filePath).toLowerCase();
  const mime = STATIC_MIME[ext];
  if (!mime) throw httpError(404, 'not found'); // 扩展名白名单，未登记类型一律不给
  const body = ext === '.png' ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8');
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': Buffer.byteLength(body),
    // 本地开发工具：静态文件也禁止缓存，改完 index/app.js/style 刷新即生效
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 防中间代理缓冲 SSE 流
  });
  sseClients.add(res);
  const drop = () => sseClients.delete(res);
  req.on('close', drop);
  res.on('close', drop);
  res.on('error', drop);
  sseSend(res, 'state', runState); // 连上立即推一次全量，前端不必等下一次状态变更
}

async function handleRequest(req, res) {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = u.pathname;

    if (p === '/api/stream') {
      if (req.method !== 'GET') throw httpError(404, 'not found');
      return handleStream(req, res);
    }
    if (p === '/api/questions') return sendJson(res, 200, apiQuestions());
    if (p === '/api/questions/reset' && req.method === 'POST') {
      return sendJson(res, 200, apiQuestionsReset(await readJsonBody(req)));
    }
    const mDetail = /^\/api\/questions\/(.+)$/.exec(p);
    if (mDetail) {
      let id;
      try {
        id = decodeURIComponent(mDetail[1]); // id 含 '/'，前端按 encodeURIComponent 传上来
      } catch {
        throw httpError(400, 'bad id encoding');
      }
      return sendJson(res, 200, apiQuestionDetail(id));
    }
    if (p === '/api/summary') return sendJson(res, 200, apiSummary());
    if (p === '/api/tokens') return sendJson(res, 200, apiTokens());
    if (p === '/api/host/status') return sendJson(res, 200, await apiHostStatus());
    if (p === '/api/provider' && req.method === 'GET') return sendJson(res, 200, await apiProviderGet());
    if (p === '/api/provider' && req.method === 'POST') {
      return sendJson(res, 200, await apiProviderSave(await readJsonBody(req)));
    }
    if (p === '/api/run/state') return sendJson(res, 200, runState);
    if (p === '/api/run/start' && req.method === 'POST') {
      return sendJson(res, 200, await apiRunStart(await readJsonBody(req)));
    }
    if (p === '/api/run/stop' && req.method === 'POST') return sendJson(res, 200, apiRunStop());
    if (p === '/api/judge/start' && req.method === 'POST') {
      return sendJson(res, 200, await apiJudgeStart(await readJsonBody(req)));
    }
    if (p === '/api/answers' && req.method === 'GET') return sendJson(res, 200, apiAnswers());
    if (p === '/api/external/prepare' && req.method === 'POST') {
      return sendJson(res, 200, apiExternalPrepare(await readJsonBody(req)));
    }
    if (p === '/api/score/import' && req.method === 'POST') {
      return sendJson(res, 200, apiScoreImport(await readJsonBody(req)));
    }
    if (p === '/api/score/edit' && req.method === 'POST') {
      return sendJson(res, 200, apiScoreEdit(await readJsonBody(req)));
    }
    if (p === '/api/score/rescore' && req.method === 'POST') {
      return sendJson(res, 200, apiScoreRescore(await readJsonBody(req)));
    }
    if (p === '/api/score/reset' && req.method === 'POST') {
      return sendJson(res, 200, apiScoreReset(await readJsonBody(req)));
    }
    if (p === '/api/score/reset-all' && req.method === 'POST') {
      return sendJson(res, 200, apiScoreResetAll(await readJsonBody(req)));
    }
    if (p === '/api/reset/run' && req.method === 'POST') {
      return sendJson(res, 200, await apiResetRun(await readJsonBody(req)));
    }
    if (p === '/api/score/labels' && req.method === 'GET') return sendJson(res, 200, apiScoreLabels());
    if (p.startsWith('/api/')) throw httpError(404, 'not found');
    if (req.method === 'GET') return serveStatic(res, p);
    throw httpError(404, 'not found');
  } catch (err) {
    const status = (err && err.statusCode) || 500;
    sendJson(res, status, { error: (err && err.message) || String(err) });
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    // 路由框架层的最后兜底：任何 handler 里漏抛的异常都落成 500 JSON
    const status = (err && err.statusCode) || 500;
    sendJson(res, status, { error: (err && err.message) || String(err) });
  });
});

server.on('error', (err) => {
  console.error('[dashboard] 监听失败:', err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dashboard] listening http://127.0.0.1:${PORT}  root=${ROOT}`);
  if (!getExamInputs().length) {
    console.warn(`[dashboard] 警告：exam-inputs 未读到（${EXAM_INPUTS}）`);
  }
});

// 心跳与台账 tail 都是全局单例：客户端集合为空时空转，开销可忽略
setInterval(() => {
  for (const res of [...sseClients]) {
    try {
      res.write(': heartbeat\n\n'); // 注释行：防代理闲置断连，不需要客户端处理
    } catch {
      sseClients.delete(res);
    }
  }
}, 15000);

setInterval(tailApiLog, 2000);

// 退出前先杀子进程树：否则 exam/judge 连着宿主继续烧 token，python 孙进程还会占着结果文件
function shutdown() {
  killTree(examChild);
  killTree(judgeChild);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
