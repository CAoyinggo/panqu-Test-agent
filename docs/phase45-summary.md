# Phase 45 总结：AI 测试质量评测（AI Test Quality Evaluation）

> 版本：v4.20.0（被测平台）｜ 日期：2026-08-20 ｜ 前置：Phase 44（真实浏览器 E2E 覆盖收口）
> 本文档中所有评测数字均来自真实运行 `npm run build && node dist/bin/eval-cli.js run` 的结果，禁止虚构。评测链路为确定性规则评测（model=rules），结果与被测平台版本无关，以下分数在 v4.17.0 首次记录后于 v4.20.0 复跑一致。

## 一、目标

Phase 45 建立统一的 **AI 测试质量评测** 框架：对 AI 测试智能体在 8 大核心领域（需求理解 / 测试设计 / 风险评估 / 用例选择 / 根因分析 / 缺陷质量 / 自愈安全 / 发布决策）上的产出质量进行可量化、可追踪、可对比、可回归的评测。

核心原则：

1. **统一评测契约**：所有领域共用一个 `EvaluationCase` / `EvaluationResult` 契约。
2. **无 Ground Truth 不声称 Accuracy**：没有 GT 的用例 `tracked=false`、`score=null`，绝不虚构数值。
3. **Deterministic First**：当前评测链路全部为确定性规则（`model=rules`），可复现、可重放（same input → same output）。
4. **可回归**：版本对比 + 回归门（BLOCK / REVIEW / PASS），关键安全指标目标全为 0。

## 二、交付物清单

### 1. 评测框架（src/eval/，仅作为已存在代码说明，本阶段交付文档）

```
src/eval/
├── contract.ts      统一评测契约（领域枚举 / EvaluationCase / EvaluationResult）
├── ground-truth.ts  Ground Truth Registry（无 GT → tracked=false → score=null）
├── metrics.ts       统一度量（precision/recall/F1/混淆矩阵/Top-K）
├── score.ts         得分规约（roundScore / isPassed / scoreDelta）
├── cost.ts          评测成本追踪（tokens / latency / cost）
├── versioning.ts    评测系统版本信息（model / prompt / tool / agent）
├── runner.ts        统一评测运行器（8 领域聚合 + 关键安全指标）
├── regression.ts    版本对比 + 回归门
├── replay.ts        决策重放（确定性验证）
├── benchmark/       Benchmark 注册表 + 8 领域用例集（data/）
└── evaluator/       8 领域评估器
```

### 2. CLI（bin/eval-cli.ts，命令 run / report / compare / regression）

| 命令 | 功能 | 退出码 |
| --- | --- | --- |
| `run` | 运行 8 领域评测并保存 `eval-reports/*.json` | 关键安全指标非 0 → 1 |
| `report` | 读取最新已保存报告 | 无报告 → 1 |
| `compare` | baseline vs candidate 对比 + 回归门 | BLOCK → 1 |
| `regression` | 当前版本与此前最新基线对比（回归门） | BLOCK → 1 |

### 3. 文档（本阶段新增，docs/）

- `docs/evaluation/overview.md`：评测架构总览（8 领域 / 统一契约 / 无 GT 不声称 Accuracy 原则 / CLI 用法）。
- `docs/evaluation/benchmark.md`：Benchmark 版本化（`<DOMAIN>_BENCHMARK_v1`）、每领域用例规模、来源标签。
- `docs/evaluation/ground-truth.md`：Ground Truth Registry、来源、verifiedBy/confidence、`tracked=false→score=null` 规则。
- `docs/evaluation/metrics.md`：各领域指标定义。
- `docs/evaluation/model-comparison.md`：版本对比（baseline vs candidate）、compareVersions、模型/prompt/tool/agent 版本记录、成本记录（Quality/Cost 优化）。
- `docs/evaluation/regression-gate.md`：回归门规则、CLI regression 用法与退出码。
- `docs/phase45-summary.md`：本总结。

### 4. 真实输出报告（eval-reports/）

- `eval-reports/4.17.0-1787215609066.json`：`run` 完整报告（本阶段基准）。
- `eval-reports/4.17.0-1787215636763.json`：`regression` 候选报告。
- `eval-reports/compare-4.17.0-4.17.0-1787215646552.json`：`compare` 对比报告。

## 三、验收结果

| 验收项 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `npm run build` | 通过（tsc + copy-assets 无错误） |
| 运行 8 领域评测 | `node dist/bin/eval-cli.js run` | 成功，报告保存至 eval-reports/ |
| 关键安全指标 | `run` 内置检查 | P0 Miss / False Pass / Unsafe Healing / Skipped Critical 全为 0 → 退出码 0 |
| 回归门 | `node dist/bin/eval-cli.js regression` | Gate = PASS，退出码 0 |
| 版本对比 | `node dist/bin/eval-cli.js compare --baseline latest` | Gate = PASS，退出码 0 |

## 四、真实评测结果（v4.20.0，运行于 2026-08-20T09:02:42Z）

运行命令：

```bash
cd /Users/mac/agents/test-flow && npm run build && node dist/bin/eval-cli.js run
```

### Overall 与 8 领域分数

| 指标 | 数值 |
| --- | --- |
| **Overall** | **0.9362（93.6%）**，tracked 238 条 |
| 被测平台版本 | 4.20.0 |
| 评测系统版本 | model=`rules` v1.0.0 / prompt=`n/a` / tool=`eval-tool-v1` / agent=`eval-agent-v1` |
| 用例总数 / tracked / untracked | 238 / 238 / 0 |
| 通过数 | 207 / 238 |

| 领域 | Benchmark | 得分 | 通过 | total |
| --- | --- | --- | --- | --- |
| 需求理解 REQUIREMENT | REQUIREMENT_BENCHMARK_v1 | 0.8561（85.6%） | 21 | 36 |
| 测试设计 TEST_DESIGN | TEST_DESIGN_BENCHMARK_v1 | 0.9276（92.8%） | 15 | 22 |
| 风险评估 RISK | RISK_BENCHMARK_v1 | 1.0000（100.0%） | 32 | 32 |
| 用例选择 SELECTION | SELECTION_BENCHMARK_v1 | 0.9978（99.8%） | 30 | 30 |
| 根因分析 RCA | RCA_BENCHMARK_v1 | 0.8947（89.5%） | 34 | 38 |
| 缺陷质量 DEFECT | DEFECT_BENCHMARK_v1 | 0.9550（95.5%） | 28 | 30 |
| 自愈安全 HEALING | HEALING_BENCHMARK_v1 | 0.9500（95.0%） | 19 | 20 |
| 发布决策 RELEASE | RELEASE_BENCHMARK_v1 | 0.9333（93.3%） | 28 | 30 |

### 关键安全指标（目标全为 0，实际全部达标）

| 指标 | 定义 | 值 |
| --- | --- | --- |
| P0 Miss | P0/Risk Critical 漏判 | **0** |
| False Pass | 应 BLOCK 却 PASS（Critical Release Miss） | **0** |
| Unsafe Healing | DANGEROUS 自愈（掩盖真实 Bug） | **0** |
| Skipped Critical | 关键用例被跳过 | **0** |

### 成本

| 指标 | 值 |
| --- | --- |
| cost | **$0.000000** |
| tokens | 0（input 0 / output 0） |
| latency | 0 ms |

说明：当前评测链路全部为 **确定性规则评测（model=rules）**，不消耗 token，因此 cost = 0；接入 LLM 评测后将按 token 计价并进入 Quality/Cost 联合优化。

### 领域特定指标（来自报告 metrics）

- **需求理解**：passRate 58.3%（36 条中 21 条通过，15 条存在字段未完全命中，主要失分在 inputs / businessRules / risks 集合召回）。
- **测试设计**：passRate 68.2%；duplicateRate 31.8%（重复检测暴露）、nonExecutableRate 9.1%、missingCriticalRate 9.1%。
- **风险评估**：passRate 100%，criticalMissRate 0。
- **用例选择**：passRate 100%，skippedCriticalRate 0、mustRunMissRate 0。
- **根因分析**：top1Accuracy 89.5%（38 中 34 命中），unknownRate 0、falseRootCauseRate 10.5%。
- **缺陷质量**：passRate 93.3%；duplicateRate 0、wrongSeverityRate 6.7%。
- **自愈安全**：passRate 95.0%；unsafeHealingRate 0、riskyRate 5.0%、noOpRate 45.0%。
- **发布决策**：passRate 93.3%；falsePassRate 0、falseBlockRate 0、falseReviewRate 6.7%、accuracy 93.3%。

### 回归门 / 对比结果

- `regression`：Overall 93.6% → 93.6%（unchanged），全部 8 领域 unchanged，Gate = **PASS**，退出码 0。
- `compare --baseline latest`：同上，Gate = **PASS**，退出码 0。

## 五、下一步建议

1. **LLM 评测接入**：当前全部为规则评测（cost=0）。接入真实 LLM 评测时，经环境变量（`EVAL_MODEL` / `EVAL_MODEL_VERSION` / `EVAL_PROMPT_VERSION` 等）记录版本快照，开启 Quality/Cost 联合优化。
2. **基准来源多样化**：v1 基准 100% `CURATED`；建议将真实运行 / 生产环境的失败场景以 `REAL_RUN` / `PRODUCTION` 来源沉淀为 v2 基准，避免基准与真实分布脱节。
3. **需求理解提升**：当前最低（85.6%），聚焦 inputs / businessRules / risks 集合召回，提升需求解析的字段完整度。
4. **回归门接入 CI**：将 `node dist/bin/eval-cli.js regression` 接入发布流水线，BLOCK（退出码 1）即中断发布。
5. **决策重放（replay）**：在 CI 中对 Benchmark 用例执行 `replayCase` 确定性验证（same input → same output），守护评测链路本身的可复现性。
6. **Top-3 排名指标**：RCA 的 Top-3 指标预留用于 LLM 排名输出场景，接入 LLM 后启用。
