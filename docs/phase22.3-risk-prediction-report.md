# Phase 22.3 变更报告：Risk Prediction Engine

> 阶段目标：根据历史执行数据预测 Case 下一次失败概率、Feature/Model/Environment 风险。
> 使用历史频率 + 时间衰减 + 趋势 + 变更信号 + 失败聚集，确定性统计预测，无 ML 平台。

## 一、本阶段变更（全部纯增量）

### `src/risk-prediction/`（3 文件）

| 文件 | 能力 |
|---|---|
| `risk-prediction-schema.ts` | ExecutionSample / ChangeSignal / PredictedCaseRisk / PredictedDimensionRisk / PredictionConfig |
| `risk-prediction-engine.ts` | `computeFailureStats`（历史频率 + 时间衰减加权 + 窗口趋势 + 连续失败聚集）、`predictCaseFailure`、`predictDimensionRisk` |
| `index.ts` | 统一导出 |

### 失败概率公式（五因子，合计 1.0）

```
failureProbability = 0.3×历史频率 + 0.3×时间衰减加权 + 0.15×趋势 + 0.15×变更 + 0.1×失败聚集
```

- **时间衰减**：`w = 0.95^ageDays`（30 天 ≈ 0.9，符合任务书 Weight Decay 量级）
- **趋势**：最近窗口失败率 − 更早窗口失败率（恶化为正，改善为 0）
- **失败聚集**：末尾连续失败数 / 3（上限 1）
- **置信度**：随样本量与证据数增长（上限 0.95），数据不足不虚报

### 可解释证据（任务书示例对齐）

```
evidence: [
  "过去 30 次失败 11 次（37%）",
  "最近 5 次失败 3 次",
  "连续失败 3 次",
  "关联变更影响 80%"
]
factors: { historical, recencyWeighted, trend, change, clustering }   // 因子分解
```

### 维度聚合

`predictDimensionRisk(key, cases)`：Feature / Model / Environment 风险 = 各用例失败概率按置信度加权平均，输出 riskScore + level + caseCount + evidence。

## 二、测试结果

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:risk-prediction:test` | 1 文件 / 9 用例 PASS |
| `npm test` | 880 用例 PASS + 18 skipped（872 → 880，+8） |
| `npm run agent:test` | 450 PASS（无回归） |

覆盖：任务书场景（证据三要素）、全 PASS / 全失败 / 空样本、时间衰减方向性、趋势恶化/改善、乱序与确定性、维度聚合、数据不足低置信。

## 三、与 Phase 22 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| Case / Feature / Model / Environment 风险预测 | ✅ |
| 历史频率 + 时间衰减 + 趋势 + 变更信号 + 失败聚集 | ✅ 五因子确定性 |
| 输出 failureProbability / riskLevel / confidence / evidence | ✅ |
| 第一阶段不引入 ML 平台 | ✅ 纯统计 |
| Deterministic First（先规则/统计，AI 只解释） | ✅ 无 LLM 参与计算 |

## 四、下一步

进入 **Phase 22.4 Adaptive Test Stopping**：实时观察结果，动态判断继续/停止，必须输出停止理由。
