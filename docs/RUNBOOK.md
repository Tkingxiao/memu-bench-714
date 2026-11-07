# 运行手册

本手册只描述**如何运行** memu-bench-714，不记录项目演进或修改过程。

## 1. 适用范围

适用于在本机 DSH 宿主上执行 714 题长期记忆评测，包括：

- 初始化宿主与控制台；
- 重置题库；
- 按 Persona / cutoff 重建记忆并考试；
- LLM 判分；
- Token 与成本核算；
- 生成报告、清理现场。

## 2. 路径与占位符

| 占位符 | 含义 |
|---|---|
| `<DSH_HOME>` | DSH 隔离 home，例如 `.../homes/0.2.2-rc.1` |
| `<DSH_BIN>` | 宿主入口 `@deepseek-ai/dsh/lib/bin.js` |
| `<REPO_ROOT>` | 本仓库根目录 |
| `<PLUGIN_ROOT>` | `dsh-memu-memory` 插件源码目录 |
| `<DSH_PLUGIN_ROOT>` | 同时包含插件与评测仓库的父目录 |

宿主默认端口 `39771`，控制台默认端口 `39772`。

## 3. 环境配置

### 3.1 宿主与插件

- 宿主版本：`0.2.2-rc.1`（需提供 `session/*` 网关与插件 RPC）。
- 插件版本：成绩基线为 `dsh-memu-memory` `1.2.7`；`1.2.8` / `1.2.9` 已适配（种子会话在每个 cutoff 前设置该轮 `sceneTime`，RPC 与参数向后兼容，报告读取真实插件版本、召回意图与注入预算）。需重新跑分后才能把成绩记到新版本。
- profile：`memubench`。
- 插件通过 `profiles/memubench/node_modules/dsh-memu-memory` 加载；该目录应指向 `<PLUGIN_ROOT>`。
- 插件私有库绑定 `<REPO_ROOT>/workspace`。

### 3.2 Provider

`memubench` profile 的 `cordis.patch.yml` 配置 OpenAI-compatible provider。判分脚本只支持 `/chat/completions`，因此 provider 的 `api` 必须是 `openai-completions`。

Key 只在以下位置读取，不写入仓库与日志：

- 环境变量 `PROBE_KEY`；
- profile 的 `headers.authorization`。

### 3.3 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_HOME` | 宿主 home | `~/AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.2.2-rc.1` |
| `BENCH_HOME` | 种子会话/usage 读取的 home | 同 `DSH_HOME` |
| `BENCH_BASE` | 宿主网关地址 | `http://127.0.0.1:39771` |
| `DASHBOARD_PORT` | 控制台端口 | `39772` |
| `PROBE_MODEL` | 判分模型 | `deepseek-v4.1-flash` |
| `PROBE_BASE` | 判分端点 | `https://router.dys.asia/v1` |
| `PROBE_KEY` | 判分 key | 从 profile 读取 |
| `PROBE_REASONING` | 判分思考强度 | `none` |
| `DASHBOARD_JUDGE_BATCH` | 控制台默认判分批大小 | `32` |

## 4. 启动与停止

### 4.1 启动宿主

```powershell
$env:DSH_HOME="<DSH_HOME>"
node "<DSH_BIN>" --profile memubench --no-open --port 39771
```

宿主 stdout 会打印：

```text
dsh web: http://127.0.0.1:39771/?token=...
```

### 4.2 交换 Cookie

```bash
printf 'http://127.0.0.1:39771/?token=<上一步的token>' > logs/host-url.txt
node scripts/host-client.mjs init
```

Cookie 写入 `logs/host-cookie.txt`，属于本地凭据，不提交。

### 4.3 启动控制台

```bash
node dashboard/server.mjs
```

或直接运行 `start-console.bat`（会同时拉起宿主与控制台）。

浏览器打开 `http://127.0.0.1:39772`。

### 4.4 健康检查

```bash
curl http://127.0.0.1:39771/          # 宿主可达
curl http://127.0.0.1:39772/api/host/status
curl http://127.0.0.1:39772/api/summary
```

### 4.5 停止

| 对象 | 方法 |
|---|---|
| 考试子进程 | 控制台「停止」，或 `POST /api/run/stop` |
| 判分子进程 | 等待结束；不要只杀父进程，Windows 需 `taskkill /T` |
| 控制台 | 关闭进程 |
| 宿主 | 关闭进程；重启后重新执行 §4.1–§4.2 |

## 5. 数据与题目

### 5.1 数据集位置

```text
datasets/natural-timegrid-20261101-v2/
├─ exam-inputs.jsonl          # 714 题
├─ histories/P01.jsonl 等     # 6 个 Persona 的冻结历史
└─ review-only/answer-key.jsonl
```

### 5.2 题目字段

| 字段 | 含义 |
|---|---|
| `id` | 题号，例如 `P01-CASE-003/d00`；`dNN` 表示间隔档 |
| `persona` | P01 / P12 / P14 / P16 / P17 / P20 |
| `cutoff_turn` | 允许看到的历史轮次上限 |
| `interval_days` | 距上次相关事件的间隔（0/3/15/45） |
| `now` | 该题逻辑时间 |
| `question` | 题面 |
| `history_file` | 对应冻结历史 |

### 5.3 判据位置

| 文件 | 内容 |
|---|---|
| `grading/evidence.jsonl` | 每题 facts / sources |
| `review-only/answer-key.jsonl` | rubric（required/forbidden/acceptable） |
| `grading/judge-prompt.md` | 判分指令 |
| `grading/grade.py` | prepare / score 两段式回算 |

## 6. 重置题库（跑批前）

清空作答、判据包、判分回执、评分结果与运行 id 文件；不清理记忆库和会话。

```bash
curl -X POST http://127.0.0.1:39772/api/score/reset-all \
  -H "content-type: application/json" \
  -d '{"includeReviews":true,"includeAnswers":true}'
```

PowerShell：

```powershell
$body = @{ includeReviews=$true; includeAnswers=$true } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri http://127.0.0.1:39772/api/score/reset-all -Method Post -ContentType 'application/json' -Body $body
```

重置后 `/api/summary` 应为：

```json
{"total":714,"answered":0,"scored":0,"passed":0}
```

## 7. 考试

### 7.1 命令

```bash
node scripts/exam-run.mjs \
  --ids-file results/run-ids-<label>.txt \
  --out results/answers-<label>.jsonl \
  --packets results/packets-<label>.jsonl \
  --judge results/judge-<label>.md \
  --label <label> \
  --concurrency 8 \
  --persona-concurrency 2 \
  --max-attempts 5 \
  --resume
```

`--ids` 与 `--ids-file` 二选一；题量大时用文件，避免 Windows 命令行超长。

### 7.2 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--ids` | — | 逗号分隔题号 |
| `--ids-file` | — | 每行一个题号 |
| `--out` | `results/answers-sample.jsonl` | 作答输出；逐题追加 |
| `--packets` | `results/exam-packets.jsonl` | 判据包 |
| `--judge` | `results/exam-judge-prompt.md` | 外部判分提示词文件 |
| `--label` | 从 out 文件名推导 | 批次名，决定 checkpoint 与状态文件路径 |
| `--concurrency` | `4` | 同时进行的考试题数，1–8 |
| `--persona-concurrency` | `2` | 同时推进的 Persona 流数，1–6 |
| `--max-attempts` | `3` | 单题最大尝试次数 |
| `--prepare` | 开 | 按 cutoff 重建记忆库 |
| `--no-prepare` | — | 使用共享 workspace 库（调试用） |
| `--resume` | 关 | 读取已有作答与 checkpoint 状态继续 |

### 7.3 并发语义

- 总考试并发 = `--concurrency`。
- `Persona` 流并行数 = `min(6, --persona-concurrency, --concurrency)`。
- 每条流内同时考的题数 = `floor(--concurrency / Persona并行数)`。
- 同一 Persona 内，checkpoint 必须按 cutoff 升序串行，防止晚 cutoff 的记忆泄漏到早题。

### 7.4 输出与状态

| 文件 | 内容 |
|---|---|
| `results/answers-<label>.jsonl` | `{id, answer, usage, tokens, sessionId}` |
| `results/packets-<label>.jsonl` | 题目 + 作答 + rubric/facts/sources + 哈希 |
| `results/judge-<label>.md` | 可直接交给外部模型的判分包 |
| `results/run-state-<label>-<Persona>.json` | 每 Persona 的 seedSid / libraryId / seededTo / doneCutoffs |
| `logs/exam-log.jsonl` | 逐题 token 台账 + 每次运行汇总 |
| `results/token-report.json` | 本次考试 token 汇总 |

### 7.5 断点恢复

中断后**不要换 label**，重新执行同一条命令并保留 `--resume`：

- 已完成的题从 `answers-<label>.jsonl` 读回，不重复作答；
- 已完成的 cutoff 从 `run-state-*.json` 跳过；
- 未完成的 checkpoint 会重新整理（通常无新增事件）并补考剩余题；
- 空作答的题会重跑。

如果宿主重启，先按 §4.1–§4.2 恢复宿主与 Cookie，再执行同一条命令。

### 7.6 退出码

| 码 | 含义 |
|---|---|
| `0` | 全部题处理完成 |
| `1` | 运行崩溃（看 stderr / 日志） |
| `2` | 参数错误或未知题号 |

## 8. 判分

### 8.1 命令

```bash
node scripts/judge-grade.mjs \
  --answers results/answers-<label>.jsonl \
  --stage results/packets-<label>.jsonl \
  --reviews results/reviews-<label>.jsonl \
  --batch 60 \
  --max-tokens 32000 \
  --keep
```

### 8.2 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--answers` | 必填 | 作答文件 |
| `--stage` | `results/packets.jsonl` | `grade.py prepare` 输出 |
| `--reviews` | `results/reviews.jsonl` | 判分回执 |
| `--batch` | `32` | 每次请求判多少题，1–100 |
| `--max-tokens` | `32000` | 单次输出上限 |
| `--keep` | 关 | 判分后保留会话与记忆库；不传则执行 bench-reset |

### 8.3 流程

1. `grade.py prepare`：answers → packets；
2. 按 `batch` 调 `/chat/completions`；
3. 校验 id / 哈希 / required 长度；
4. `grade.py score`：reviews + packets → scored + summary。

### 8.4 输出

| 文件 | 内容 |
|---|---|
| `results/reviews-<label>.jsonl` | 判分回执 |
| `results/scored-<label>.jsonl` | 逐题判分 |
| `results/summary-<label>.jsonl.json` | 汇总与分组统计 |

### 8.5 判分字段

| 字段 | 含义 |
|---|---|
| `pass` | 最终通过 |
| `required` | rubric 必答项逐项布尔 |
| `错认 / 错否 / 越界 / 编造日期 / 不当私事披露` | 硬性事实问题 |
| `违反禁止` | 命中 forbidden 的内容列表 |
| `未知当事实` | 题目所问但证据缺失、却写成确定事实的内容列表 |
| `无关旧事` | 主动提及的无关旧事（不作为失败依据） |

## 9. Token 记账

```bash
node scripts/token-report.mjs \
  --since <ISO 时间> \
  --workspaces "<ck1>;<ck2>;..." \
  --out results/token-report.json
```

| 参数 | 说明 |
|---|---|
| `--since` | 只统计该时间之后的调用 |
| `--workspace` | 单个 workspace scope |
| `--workspaces` | 多个 scope，分号分隔；重建记忆时必须传各 checkpoint 目录 |
| `--home` | 会话文件所在 home |
| `--no-ledger` | 不追加 `logs/token-ledger.jsonl` |

输出：

- `results/token-report.json`：totals / byPurpose / byQid / bySession；
- `logs/token-ledger.jsonl`：每次报告追加一行完整 JSON。

### 9.1 成本

谷价单价（元 / 百万令牌）：

| 项 | 单价 |
|---|---|
| 缓存命中输入 | 0.02 |
| 缓存未命中输入 | 1 |
| 输出 | 4 |

成本 = 未命中输入×1 + 缓存命中×0.02 + 输出×4（按百万折算）。

### 9.2 控制台与报告的口径差异

- 控制台「本次跑批」只汇总 `exam-log` 里每题**最终回答**的 usage，不含记忆整理与判分；
- `token-report` 汇总所有会话每一次 `assistant/message` 的 usage（一次考试通常 2 条，另有重试），并包含整理与判分。

两者用途不同：前者看作答面，后者用于完整成本核算。

## 10. 生成报告

```bash
node scripts/report-714.mjs --label <label>
# 历史批次想固定当时的插件版本时：
node scripts/report-714.mjs --label <label> --plugin-version 1.2.7
```

输出：

| 文件 | 内容 |
|---|---|
| `results/report-714-<label>.md` | 得分、分 Persona / 标签、错误、可错可对、成本；含实际加载的插件版本、召回意图上限与注入预算 |
| `results/report-714-<label>.json` | 同内容的机器可读版本 |

报告分类：

- **全对**：`pass=true`；
- **错误**：硬性事实问题或 required 未满足；
- **可错可对**：无硬性事实问题，仅因题外/未证实细节被扣分。

## 11. 清理

### 11.1 只清题库

见 §6。

### 11.2 清会话与记忆库

```bash
node scripts/bench-reset.mjs --dry-run      # 演练
node scripts/bench-reset.mjs                # 实删
node scripts/bench-reset.mjs --keep-library # 保留记忆库，只清会话
```

`1.2.9` 起永久删除会留下 `index/<library>.deleted.json` 撤销缓冲；删库成功后 `bench-reset` 会一并删除，`--keep-library` 时保留。

### 11.3 保留判分现场

判分命令加 `--keep`，否则判分成功后会执行 `bench-reset`。

## 12. 故障排查

| 现象 | 处理 |
|---|---|
| 宿主端口被占用 | `netstat -ano \| findstr :39771`，结束占用进程后重启 |
| 控制台显示宿主离线 | 检查 §4.1；重新执行 §4.2 换 Cookie |
| 考试大量 `Request timed out` | 降低 `--concurrency` 与 `--persona-concurrency`，提高 `--max-attempts` |
| 空作答 | 保留同一 label 加 `--resume` 重跑；空答案会自动重试 |
| 整理 `receipt-unverified` | 脚本会自动补跑 2 次；仍失败时后续 checkpoint 通常会补齐，必要时重跑受影响 cutoff |
| 判分 `All detail fields must be lists` | 判分回执列表字段格式异常；`judge-grade.mjs` 已归一化，重跑该批即可 |
| 判分 JSON 解析失败 | 降低 `--batch` 或重跑；不要手工改 reviews 的哈希 |
| 宿主原生崩溃（`0xC0000409`） | 降低 persona 并行数，重启宿主，同 label + `--resume` 继续 |
| 进程杀不干净 | Windows 用 `taskkill /pid <pid> /T /F` |

## 13. 命令速查

```bash
# 宿主
$env:DSH_HOME="<DSH_HOME>"; node "<DSH_BIN>" --profile memubench --no-open --port 39771

# Cookie
node scripts/host-client.mjs init

# 控制台
node dashboard/server.mjs

# 重置题库
curl -X POST http://127.0.0.1:39772/api/score/reset-all -H "content-type: application/json" -d '{"includeReviews":true,"includeAnswers":true}'

# 考试（可恢复）
node scripts/exam-run.mjs --ids-file results/run-ids-<label>.txt --label <label> --out results/answers-<label>.jsonl --packets results/packets-<label>.jsonl --judge results/judge-<label>.md --concurrency 8 --persona-concurrency 2 --max-attempts 5 --resume

# 判分
node scripts/judge-grade.mjs --answers results/answers-<label>.jsonl --stage results/packets-<label>.jsonl --reviews results/reviews-<label>.jsonl --batch 60 --keep

# Token
node scripts/token-report.mjs --since <ISO> --workspaces "<ck1>;<ck2>" --out results/token-report.json

# 报告
node scripts/report-714.mjs --label <label>

# 清理
node scripts/bench-reset.mjs --dry-run
node scripts/bench-reset.mjs
```

## 14. 数据与隐私

- `results/`、`logs/`、`workspace/`、`backup/` 均被 `.gitignore` 忽略；
- 不提交 Cookie、宿主 token、API Key、作答原文、会话日志、记忆库快照；
- 原始答卷保留在本地 `results/`，需要复核时直接查看；
- 对外分享报告时只使用聚合指标，不附带逐题作答。
