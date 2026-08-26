# Phase 22.2 变更报告：Adaptive Prioritization

> 阶段目标：从静态 P0-P3 升级为动态测试优先级（数字 score + reasons + 升降级）。

## 一、本阶段变更（全部纯增量）

### `src/prioritization/`（2 文件）

`prioritization-schema.ts` + `index.ts`：

- `PriorityInput`：caseId + basePriority + 风险/变更/历史失败/最近失败/覆盖缺口/缺陷密度/Flaky/成本/业务关键度
- `computePriorityScore(input)`：确定性评分
  ```
  score = base(P0:0.85 / P1:0.65 / P2:0.45 / P3:0.25)
          + Σ(正项×权重)          // risk0.2 changeImpact0.15 historicalFailure0.15 recentFailure0.15 coverageGap0.15 defectDensity0.1 businessCriticality0.1
          - flakyRate×0.3 - executionCost×0.2
  阈值：≥0.8→P0，≥0.6→P1，≥0.4→P2，否则 P3
  ```
- `PriorityScore`：score + priority + adjustment（up/down/same/promoted-to-p0）+ reasons（仅显著信号）
- `prioritizeCases(inputs)`：批量评分重排（score 降序，同分 caseId 字典序）

### 任务书场景验证（P2 → 动态 P0）

```
base P2 + changeImpact 0.8 + historicalFailure 0.35 + risk 0.7
→ score ≥0.8 → P0（promoted-to-p0）
reasons: 变更影响 0.8 / 历史失败率 35% / 风险评分 0.7
```

## 二、测试结果

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:priority:test` | 1 文件 / 8 用例 PASS |
| `npm test` | 872 用例 PASS + 18 skipped（864 → 872，+8） |

覆盖：P2→P0 提权、P0 保持、flaky/成本惩罚降级（P0→P3）、信号混合提权、批量重排、score 截断、确定性。

## 三、与 Phase 22 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 动态测试优先级 + PriorityScore 结构 | ✅ |
| 优先级输入 10 项 | ✅ 全部纳入 |
| P2→P0 场景（变更+历史失败+关联 P0 风险） | ✅ 验证通过 |
| 不用 LLM 随机决定优先级 | ✅ 确定性评分 |
| 可复现 / 可解释 | ✅ reasons 输出 |

## 四、下一步

进入 **Phase 22.3 Risk Prediction Engine**：预测 Case/Feature/Model/Environment 风险。
