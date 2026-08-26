# Phase 21.6 变更报告：Cost Optimization

> 阶段目标：记录 LLM / 环境 / API / GPU / 积分 / 执行时间 六类成本，
> 输出 Cost/Case、Cost/Feature、Cost/Regression、Cost/Defect，
> 并自动选择满足 Coverage ≥90% + Risk Coverage 100% + P0 Coverage 100% 的最小成本测试集合。

## 一、本阶段变更（全部纯增量，未修改既有文件）

### 1. `src/cost/cost-schema.ts`

- `CostCategory`：llm / environment / api / gpu / credit / time
- `CostRecord`：amount + unit + 多维归属（businessId / feature / caseId / regressionRunId / defectId）+ quantity
- `estimateLLMCost(inputTokens, outputTokens, config)`：token → 成本折算，默认费率与 `AgentTracer` 的 `DEFAULT_COST` 一致（0.001/0.002 每 1K token）
- `normalizeCreateCostInput`：category 白名单 + amount ≥0 校验

### 2. `src/cost/cost-ledger.ts`（成本台账）

| 能力 | 实现 |
|---|---|
| 记录 | `record`（六类成本）、`recordLLM`（token 折算入账，补齐 tracer 的成本数据通路） |
| Cost/Case | `costPerCase()` |
| Cost/Feature | `costPerFeature()` |
| Cost/Regression | `costPerRegression()`（按回归 runId） |
| Cost/Defect | `costPerDefect()`（定位/修复/回归验证缺陷的成本） |
| 汇总 | `byCategory()` / `total(filter)` / `summarize()` |
| 持久化 | `save` / `static load`（损坏文件降级为空台账） |

### 3. `src/cost/cost-optimizer.ts`（最小成本测试集合）

`selectMinimumCostSuite(candidates, universe, constraints)`，确定性贪心 set-cover：

1. **P0 必选**（P0 Coverage 100%）
2. **风险项补齐**：按「新覆盖风险 / 成本」性价比贪心，直到 Risk Coverage 100%；无候选覆盖 → 标记不可行并列出缺失风险项
3. **覆盖率补齐**：按「新覆盖项 / 成本」贪心，直到 Coverage ≥90%（默认）即停止，不多选
4. 同分按 id 字典序，保证确定性；返回 `{ selected, totalCost, coverage, riskCoverage, p0Coverage, feasible, reasons }`

## 二、关键验证（单元测试 11 条）

- 高性价比用例优先：覆盖同样 5 项，成本 2 的 `big` 入选、成本 10 的 `expensive` 被排除
- 风险覆盖最优组合：`risk-a + risk-c`（成本 2）优于 `risk-b`（成本 5）
- Coverage 达标即停：9/10 = 90% 达标后不再多选第 10 项
- 不可行判定：风险项无候选覆盖 / 覆盖项不足 → `feasible=false` + 原因说明
- recordLLM：1000 in + 1000 out → 0.003 credit，正确归属到 case/feature

## 三、测试结果

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:cost:test` | 1 文件 / 11 用例 PASS |
| `npm run agent:test` | 450 用例 PASS（无回归） |
| `npm test` | 824 用例 PASS + 18 skipped（813 → 824，+11） |

## 四、与 Phase 21 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 记录 LLM / 环境 / API / GPU / 积分 / 执行时间成本 | ✅ 六类 CostCategory |
| Cost/Case、Cost/Feature、Cost/Regression、Cost/Defect | ✅ 四种聚合 |
| 最小成本集合满足 Coverage ≥90% | ✅ 贪心达标即停 |
| Risk Coverage 100% | ✅ 强制补齐，缺失则判不可行 |
| P0 Coverage 100% | ✅ P0 必选 |
| 复用既有 tracer/budget 结构 | ✅ 费率与 CostConfig 对齐，recordLLM 补齐数据通路 |
| 不引入求解器/向量库 | ✅ 确定性贪心 |

## 五、下一步

进入 **Phase 21.7 Quality Optimization**：Test Quality Score（九维度）→ Feature Quality Score + 多维趋势，
Flaky Lifecycle（STABLE→SUSPECTED→FLAKY→QUARANTINED→FIXED→STABLE，连续 N 次稳定自动恢复）。
