# 判分工具

这套工具整理自 Suzu 强制检索重测时使用的判分流程：先由 Codex 根据题目、标准和证据判断回答，再由程序计算是否通过和各项统计。它不要求联网，也不指定模型或调用任何 API。

## 1. 保存回答

先按[测试方法](../docs/methodology.md)让记忆系统处理历史、逐题回答。把实际回答保存成 UTF-8 JSONL，一行一个，`id` 必须是正式题号：

```json
{"id":"P01-CASE-001/d03","answer":"你的系统在这一题的实际回答"}
```

文件可包含部分题目；只统计提交并完成判分的题目。不要把标准答案、判分证据喂给作答系统。

## 2. 准备判分材料

在仓库根目录运行：

```sh
python grading/grade.py prepare --answers answers.jsonl --out packets.jsonl
```

每行包含一道题、其标准、对应事实和历史证据、系统回答以及回答和标准的 SHA-256。`grading/evidence.jsonl` 是本次正式判分使用的证据，引用来自公开的合成历史。

## 3. 判断回答

把 [`judge-prompt.md`](judge-prompt.md) 和 `packets.jsonl` 交给 Codex 判分，按提示逐行写成 `reviews.jsonl`。`required` 必须与该题 `rubric.required` 顺序对应，两个 SHA-256 从对应题的材料原样复制。可以分批判断，最终合并为一个文件，每题一行。

## 4. 汇总成绩

```sh
python grading/grade.py score --packets packets.jsonl --reviews reviews.jsonl --out judgments.jsonl --summary summary.json
```

`judgments.jsonl` 记录每题判断和通过情况；`summary.json` 给出总通过数、实际判分题数、按人物、考点及时间间隔的统计。一个题可属于多个考点，各考点题数不能相加当总题数。脚本校验题号、判断格式，以及回答和标准的 SHA-256；提交的回答与判分必须一一对应。

## 通过规则

所有必答项满足；不能违反禁止项、把未知内容说成事实、错认、错否、越界或编造日期。与问题无关的旧事达到三件，或不当披露私事，也不通过。不评分表达风格。具体事实是否满足由判分者判断，脚本负责规则汇总；它不是自动理解语义的模型。

判断文件格式示例，`required` 的个数以对应题目为准，`reason` 填实际判断理由：

```json
{"id":"P01-CASE-001/d03","answer_sha256":"复制材料中的值","rubric_sha256":"复制材料中的值","required":[true,true],"错认":false,"错否":false,"越界":false,"编造日期":false,"不当私事披露":false,"违反禁止":[],"未知当事实":[],"无关旧事":[],"reason":"写明对照证据后的判断理由"}
```
