# Phase 22.1 变更报告：Test Intelligence

> 阶段目标：统一计算 Feature Risk / Case Risk / Failure Risk / Change Risk / Test Value，
> Deterministic Metrics + Statistical Model，AI 只负责解释。

## 一、本阶段变更（全部纯增量，未修改既有文件）

### `src/intelligence/`（6 文件）

| 文件 | 能力 |
|---|---|
| `intelligence-score.ts` | 确定性评分工具：`clamp01` / `normalizeRange` / `logNormalize` / `levelOf`（≥0.6 HIGH，≥0.3 MEDIUM）/ `toHundred` / `coverageValueOf` / `computeTestValue` |
| `case-intelligence.ts` | 单用例九维智能评分 `computeCaseIntelligence` |
| `feature-risk.ts` | 功能风险 `computeFeatureRisk`（六维加权，权重合计 1.0） |
| `failure-intelligence.ts` | 用例失败概率 `computeFailureRisk`（历史×0.4 + 最近×0.25 + 变更×0.2 + Flaky×0.15 + 置信度随数据量） |
| `change-intelligence.ts` | 变更风险 `computeChangeRisk`（类型高危度 + 影响范围对数归一） |
| `index.ts` | 统一导出 |

### TestValue 公式（忠实任务书）

```
testValue = risk + changeImpact + historicalFailure + coverageValue + businessCriticality
            - executionCost - flakyPenalty(flakyRate × 0.5)
```

`computeTestValue` 返回原始值（可为负）与归一化 0~1 值；`computeCaseIntelligence` 输出全部九维 + dimensions + level。

### 确定性保证
- 全部纯函数、无 LLM、无向量库、无随机
- 权重固定、等级阈值固定、对数/范围归一化确定，相同输入输出完全一致

## 二、测试结果

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:intelligence:test` | 1 文件 / 15 用例 PASS |
| `npm run agent:test` | 450 用例 PASS（无回归） |
| `npm test` | 864 用例 PASS + 18 skipped（849 → 864，+15） |

覆盖：TestValue 正负项、flakyPenalty、九维越界截断、FeatureRisk 加权/覆盖缺口、FailureRisk 数据不足低置信、变更类型高危排序、边界与确定性。

## 三、与 Phase 22 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 统一计算 Feature / Case / Failure / Change Risk / Test Value | ✅ |
| CaseIntelligence 九字段 + testValue | ✅ |
| 不用 LLM 计算基础指标 | ✅ 纯确定性 |
| Deterministic Metrics + Statistical Model | ✅ 统计加权 + 置信度随数据量 |
| 可复现 / 可测试 / 可解释 | ✅ 固定公式 + reasons/evidence |

## 四、下一步

进入 **Phase 22.2 Adaptive Prioritization**：动态测试优先级（数字 score + reasons + P0-P3 动态升降）。
