# Memu Bench 714

面向长期记忆系统的**时间网格评测集与执行框架**。它把一段很长的对话历史冻结在磁盘上，按不同时间点切出考试题；被测系统必须在每个时间点只看到“截至那一刻”的历史，答对“当时应该记得的事”，并在信息不足、前后矛盾或边界敏感时给出正确反应。

仓库同时提供：

- 714 道题、6 个 Persona、4 种间隔档位（0 / 3 / 15 / 45 天）的评测数据；
- 从冻结历史到记忆库、再到考试与判分的完整流水线；
- 可恢复的批量执行器、并发控制、跨组选题；
- 一个零依赖的可视化控制台；
- 按 token 用量与谷价计算的成本核算。

## 评测什么

这套题不是“问答准确率”测试，而是围绕长期记忆的真实失效模式设计的：

| 维度 | 说明 |
|---|---|
| 事实回忆 | 姓名、年龄、生日、职业、家人朋友、口味、作息等 |
| 时间推理 | 相对日期（“后天”“下周三”）、改口后的日期、纪念日 |
| 信息归属 | 谁说的、谁知道、谁答应过什么 |
| 矛盾与改口 | 同一件事前后不一致时能否保留双方、指出冲突 |
| 边界与隐私 | 哪些事可以主动说、哪些只能等对方问 |
| 资料不足 | 缺失信息时明确说“不知道”，不编造 |
| 计划与跟进 | 约定、期限、未完成的承诺和后续提醒 |
| 共同叙事 | 一起编的故事、设定、称呼变化等需要延续的内容 |

每道题都有 `rubric.required`（必须满足的信息点）、`forbidden`（禁止项）、`acceptable`（可接受表述）和 `facts/sources` 证据。

## 数据规模

| 项 | 数值 |
|---|---|
| 题目总数 | 714 |
| Persona | 6（P01 / P12 / P14 / P16 / P17 / P20） |
| 唯一 cutoff | 461 |
| 间隔档位 | 0 / 3 / 15 / 45 天 |
| 历史跨度 | 约 1–382 轮 / Persona |

| Persona | 题数 |
|---|---|
| P01 | 88 |
| P12 | 79 |
| P14 | 82 |
| P16 | 123 |
| P17 | 172 |
| P20 | 170 |

## 一次评测的完整流程

1. **重置题库**：清空上一次的作答、判据包、判分与汇总，题库回到未作答。
2. **建种子会话**：每个 Persona 一条会话，先写入第一段冻结历史。
3. **按 cutoff 整理**：升序追加历史到下一个 cutoff，触发一次记忆整理，写入该 Persona 的私有库。
4. **考该 cutoff 的题**：考试会话绑定同一个库，只读；题目只看最近六轮转录 + 插件召回。
5. **回滚考试写入**：把考试回合误写进库的条目清掉，保持“考试不污染后续记忆”。
6. **继续下一个 cutoff**：重复 3–5，直到该 Persona 的所有题考完。
7. **判分与核算**：LLM 判分员按 rubric 判分，生成 scored/summary，再汇总 token 与成本。

## 核心设计

### 1. 冻结历史 + cutoff

历史对话按“逻辑时间”冻结在 `datasets/natural-timegrid-20261101-v2/histories/`。每道题带一个 `cutoff_turn`：只允许看到该轮及之前的历史，题目问的是“到这一刻为止”的记忆。

### 2. 按 cutoff 重建记忆

考试不是一次性把整段历史灌进库，而是：

1. 为每个 Persona 建一条种子会话；
2. 按 `cutoff_turn` 升序增量追加历史；
3. 每个 checkpoint 触发一次记忆整理，写入本轮独立的记忆库；
4. 整理完成后才考该 cutoff 的题；
5. 考完回滚考试回合误写入的条目。

这样早 cutoff 的题不会看到晚 cutoff 的记忆，避免“时间穿越”。

### 3. 只读考试 + 分节记忆备忘录

考试会话不写入长期记忆。作答写成一份“记忆备忘录”：按结论、事实明细、时间线、原话与说话人、约定与欠账、冲突与改口、边界与披露、资料不足分节列出；题目问到的子项要完整（例如日期要区分公历/农历），不知道的项写「不知道」，与题目无关的内容不写。

### 4. 矛盾不替模型裁决

整理阶段遇到矛盾说法时，双方都保留为可见记忆；考试时把两种说法都交给作答模型，由它自己判断该信哪条、还是指出无法确认。

### 5. LLM 判分 + 成本核算

判分员按 rubric 逐题核对，区分 `pass`、`error`（硬性事实错误）和 `ambiguous`（事实大体正确但补充了无证据细节）。Token 记账区分未命中输入、缓存命中输入和输出，并按谷价计算成本。

## 记忆与向量后端

| 项 | 配置 |
|---|---|
| 插件 | `dsh-memu-memory` `1.2.7`（成绩基线）；`1.2.8` 已核对兼容、未重跑 |
| 记忆引擎 | MemU `0.11.0b3`（Python venv） |
| 记忆后端 | `api`（`memoryBackend=api`） |
| 向量来源 | `local`（`vectorSource=local`） |
| 嵌入模型 | `multilingual-e5-small`（int8 ONNX，117.5M 参数，384 维，mean pooling + L2，qint8） |
| 向量库 | 每库独立 SQLite：`libraries/lib_<id>.<fingerprint>.g3.sqlite3` |
| 向量代际 | generation 3，fingerprint `4826773b…` |
| 召回 | `managed-vector-rrf`（向量召回 + 词法 RRF 融合） |
| 库组织 | 每个 Persona 每轮一个私有库；同一 Persona 内按 cutoff 递增写入 |

每个 checkpoint 共用该 Persona 的库；下一个 checkpoint 只整理“新增历史”，不会重复整理整段前缀。

## 当前参考基线

最近一次全量评测（2026-11-06，插件 `dsh-memu-memory` `1.2.7`，`dys-router / deepseek-v4.1-flash`，思考强度 high）：

| 指标 | 数值 |
|---|---|
| 题数 | 714 |
| 通过 | 653 |
| 通过率 | 91.46% |
| 错误 | 53 |
| 可错可对 | 8 |
| 总成本（谷价） | ¥24.45 |

表内成绩属插件 `1.2.7`。仓库已连续适配 `1.2.8` / `1.2.9`：考试执行器在每个 cutoff 前把种子会话的 `sceneTime` 设为该轮逻辑时间，考试会话同样使用该题的场景时间；并核对 `initSession`、`setMemoryContext`、`listPrivate`、`listReviews`、`resolveReview`、`archiveMemory`、`deleteMemory`、`generatePrivate` 等调用与参数均向后兼容。尚未用 `1.2.9` 重跑全量，因此不把旧成绩写成新版本成绩。

### 插件 1.2.8 的评测面变化

- **召回**：按查询意图（`date` / `entity` / `conflict` / `commitment` / `boundary`）分路取数，冲突版本成对召回并注入冲突卡；命中条目沿显式 `links` 扩展一跳。
- **写入**：落 `absolute_date` / `date_precision` / `valid_from` / `valid_to`、`speaker_id` / `source_kind`、`commitment`；助手自己的承诺和计划不再记成用户原话；同一事实可保留多版本。
- **注入**：`never_say` 不再进入自动注入面，`only_if_asked` 只在边界意图放行；到期未完成的承诺最多注入 3 条。
- **提示词**：RP guide / policy / consolidation 与整理 worker 任务书补充上述字段要求。

本仓库的对应适配：种子会话与考试会话都按 cutoff 设置 `sceneTime`；考试提示允许按时间、说话人区分冲突双方；判分提示不把“保留冲突”误判为 `错否`；报告自动读取 profile 中实际加载的插件版本。表内成绩仍是 `1.2.7` 结果，`1.2.8` 需重跑后另行记录。

### 插件 1.2.9 的评测面变化

- **本地词法腿换 BM25**：`localRecall` 从 includes 计数改为 BM25（IDF、长度归一、dfCap、按库语料缓存，60s TTL 兜底）；`DSH_MEMU_RECALL_LEXICAL=includes` 可回退。检索排序和召回结果会与 1.2.8 不同，逐题不可直接对齐。
- **槽位感知去重**：数字/日期/时间/星期/引号人名形成槽位签名；槽位不同不再按近重复折叠，子集视为补充，替换/不相交视为冲突。
- **预算内图扩展**：关联扩展只填未满的 topK 座位，topK 已满时不追加，不增加注入 token。
- **事实账本**：写入派生 `fact_authority` / `fact_evidence`；冲突卡只按 authority → observed_at → id 调整 A/B 顺序，不增加卡片文字。
- **数据安全与生命周期**：永久删除支持 `preview` / `restore`，并写本地 `.deleted.json` 撤销缓冲；记忆包校验与整批回滚；向量提交失败标 `vectorPending`；新增绑定/向量 GC 工具（默认 dry-run）。
- **无新增 LLM 调用、提示词或注入 token**：topK 与 `anchorTokens` / `turnTokens` / `injectionTotalTokens` 默认值不变。

本仓库的对应适配：报告新增“词法腿 / 去重 / 图扩展 / 事实账本”配置行；`bench-reset` 删库时同步清理 `.deleted.json` 撤销缓冲；测试提示词改为分节记忆备忘录，判分提示同步接受该格式。`1.2.9` 尚未重跑，成绩仍归 `1.2.7`。

### 1.2.8 的省 token 变化

- 召回候选不再一律拉满：按意图分档（`general` 5 / `date` 8 / `entity` 8 / `conflict` 6 / `commitment` 5 / `boundary` 5，封顶 20）。
- 冲突成对注入压缩成一张 200 字以内的冲突卡，而不是两条全文。
- 到期承诺提醒单独受 240 token 上限约束，最多 3 条。
- `injectionTotalTokens`（默认 2000）是整条插件消息的外层硬上限；`anchorTokens` / `turnTokens` 不能相加越界；guide 超出总预算时整条跳过。
- 报告新增“召回意图上限”和“注入预算”两行，直接从实际插件 state / `lib/budget.js` 读取，不复制默认常量。

详细分 Persona、考点和成本见 [docs/714-eval-20261106.md](docs/714-eval-20261106.md)。

## 快速开始

### 依赖

- Node.js 18+（仓库自带脚本与零依赖控制台）
- DSH 宿主 `0.2.2-rc.1`（提供 `session/*` 与插件 RPC）
- `dsh-memu-memory` 插件（`1.2.7` 成绩基线；`1.2.8` 兼容），通过 profile 的 `node_modules` junction 加载
- Python 3（`grading/grade.py` 用于离线判分回算）

### 1. 准备环境

按 [docs/RUNBOOK.md](docs/RUNBOOK.md) 配置 DSH home、`memubench` profile 和 provider。关键点：

- 宿主默认监听 `127.0.0.1:39771`；
- 插件库绑定 `workspace/`；
- 判分走 OpenAI-compatible `/chat/completions`，key 只从环境变量或 profile 读取。

### 2. 启动

```powershell
# 宿主
$env:DSH_HOME="<DSH_HOME>"
node "<DSH_BIN>" --profile memubench --no-open --port 39771

# 控制台
node dashboard/server.mjs
```

打开 `http://127.0.0.1:39772`，或使用 `start-console.bat` 一次拉起。

### 3. 跑一批题

控制台里选择 Persona / 题数后点「开始评测」，或直接用 CLI：

```bash
node scripts/exam-run.mjs \
  --ids P01-CASE-003/d00,P01-CASE-004/d00 \
  --out results/answers-sample.jsonl \
  --concurrency 2
```

### 4. 判分

```bash
node scripts/judge-grade.mjs \
  --answers results/answers-sample.jsonl \
  --stage results/packets-sample.jsonl \
  --reviews results/reviews-sample.jsonl \
  --batch 32 \
  --keep
```

不加 `--keep` 时，判分成功后会执行 `bench-reset`，清理本次会话与记忆库；需要保留现场时务必带上。

### 5. 生成报告

```bash
node scripts/report-714.mjs --label dashboard-20261106-120000
```

## 控制台

`dashboard/` 是一个零依赖控制台：

| 页签 | 功能 |
|---|---|
| 总览 | 作答/判分/通过率、按 Persona / 标签 / 间隔的通过率、错误分类 |
| 题库 | 搜索、按 Persona/状态筛选、勾选题目、运行选中、全新重置 |
| 运行 | 多 Persona 选择、题数/起始序号、并发 1–8、实时进度与日志、判分入口 |
| Token | 逐题/逐次 token、Token 报告、宿主张账 |
| 设置 | Provider/模型/思考强度、默认模型、判分 Provider |

控制台的运行状态只跟踪它自己发起的批次；CLI 跑批请直接看 `logs/` 与 `results/`。

## CLI 参数速查

| 脚本 | 用途 | 关键参数 |
|---|---|---|
| `seed-session.mjs` | 把冻结历史写成种子会话 | `--history --from --to --session --workspace --append` |
| `exam-run.mjs` | 重建记忆并考试 | `--ids/--ids-file --label --concurrency --persona-concurrency --max-attempts --resume --no-prepare` |
| `judge-grade.mjs` | 判分 | `--answers --stage --reviews --batch --max-tokens --keep` |
| `token-report.mjs` | 汇总 token 与成本 | `--since --workspaces --out --no-ledger` |
| `report-714.mjs` | 生成得分报告 | `--label --out` |
| `bench-reset.mjs` | 清会话/记忆库 | `--dry-run --keep-library --library --workspace` |
| `host-client.mjs` | 宿主网关客户端 | `init / create / prompt / page / rpc` |

## 判分与指标

| 字段 | 含义 |
|---|---|
| `pass` | 最终是否通过 |
| `required` | rubric 必答项逐项布尔 |
| `错认 / 错否 / 越界 / 编造日期 / 不当私事披露` | 硬性事实问题 |
| `违反禁止` | 命中 `rubric.forbidden` 的内容 |
| `未知当事实` | 题目所问但证据缺失、却写成确定事实 |
| `无关旧事` | 主动提及的无关旧事（不作为失败依据） |

报告把结果分为：

- **全对**：`pass=true`；
- **错误**：有硬性事实问题或 required 未满足；
- **可错可对**：核心事实正确，但补充了无证据的日期/细节，按当前口径扣分。

## 成本核算

```text
成本 = 未命中输入 × 1 + 缓存命中输入 × 0.02 + 输出 × 4   （元 / 百万令牌）
```

当前基线（谷价）：

| 用途 | 计费令牌 | 总令牌数 | 成本 |
|---|---|---|---|
| 考试 | 5,473,112 | 27,537,240 | ¥7.31 |
| 记忆整理 | 8,528,226 | 47,239,394 | ¥16.05 |
| 判分 | 693,473 | 741,217 | ¥1.08 |
| **合计** | **14,694,811** | **75,517,851** | **¥24.45** |

控制台「本次跑批」只显示每题最终回答的考试 usage，不含记忆整理与判分，因此比完整成本口径小。

## 限制与注意事项

- 每个 cutoff 都要触发一次记忆整理，714 题对应 461 个 checkpoint，耗时主要花在整理 fork 上。
- 同一 Persona 内必须按 cutoff 串行，跨 Persona 才能并行；并发过高会放大 provider 超时和宿主负载。
- 中断后必须用同一 `label` + `--resume` 继续；换 label 会重新建库。
- 原始作答、日志、checkpoint 记忆库都在本地并由 `.gitignore` 排除，发布前不要手工加入。

## 目录

| 路径 | 内容 |
|---|---|
| `datasets/` | 冻结历史、题目、answer-key、证据 |
| `grading/` | rubric 判分脚本与判分提示词 |
| `scripts/` | 种子会话、考试、判分、token 汇总、报告、清理 |
| `dashboard/` | 零依赖控制台（题库 / 运行 / Token / 设置） |
| `docs/` | 运行手册与评测报告 |
| `results/` | 本地生成物（作答、判据包、判分、报告；被 `.gitignore` 忽略） |
| `logs/` | 本地运行台账与日志（被 `.gitignore` 忽略） |
| `workspace/` | 宿主工作目录与 checkpoint 记忆库（被 `.gitignore` 忽略） |

## 题目来源

题库来源于 [Ornn8/chat-memory-benchmark](https://github.com/Ornn8/chat-memory-benchmark)。本仓库的 `datasets/natural-timegrid-20261101-v2/` 是该题库的本地副本；考试执行、记忆重建、判分、控制台与报告工具由本仓库提供。

## 数据与隐私

`datasets/` 与 `grading/evidence.jsonl` 是**合成评测语料**：人物、对话和事件均为虚构，仅用于评测，不对应真实个人。

仓库只提交代码、评测语料和可公开的聚合报告。以下内容不进入版本库：

- 逐题作答、判分原文、packets、reviews、scored、summary；
- 会话日志、Cookie、宿主 token、记忆库快照；
- `workspace/checkpoints/` 下的 checkpoint 数据；
- 本地备份与带本机路径的配置。

原始答卷保留在本地 `results/`，由 `.gitignore` 排除；需要复核时直接在本机查看。

## 文档

- [运行手册](docs/RUNBOOK.md)
- [714 全量评测报告](docs/714-eval-20261106.md)
