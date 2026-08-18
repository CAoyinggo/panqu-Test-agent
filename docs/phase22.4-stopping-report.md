# Phase 22.4 变更报告：Adaptive Test Stopping

> 阶段目标：从「把选中的 Case 全部跑完」改为「观察实时结果 → 动态判断是否继续」，
> 必须输出停止理由，不能静默停止。

## 一、本阶段变更（全部纯增量）

### `src/stopping/`（3 文件）

| 文件 | 能力 |
|---|---|
| `stopping-schema.ts` | StoppingInput / StoppingRules / StoppingCondition / StoppingDecision |
| `adaptive-stopping.ts` | `evaluateStopping` 停止判定（确定性） |
| `index.ts` | 统一导出 |

### 停止判定语义（两类条件 + 门禁）

**强制停止**（无条件触发）：环境异常 / P0 失败或 Critical 缺陷（Release BLOCK）/ 预算使用 ≥90%

**安全停止**（需 P0 门禁放行）：Coverage ≥90% / Risk 覆盖 100% / 剩余用例信息增益 <20%

**P0 门禁**：安全停止必须保证 P0 已全覆盖（不能为了覆盖率牺牲 P0）；Release BLOCK 场景除外。

**防过早停止**：已执行用例数 < 最少执行数（默认 3）→ 阻断停止。

输出：`stop / reason / confidence(≤0.98) / remainingCases / riskCoverage / coverage / p0Coverage / conditions(7 项全量评估) / blocks`。

### 任务书场景验证

```
Coverage 95% + P0 100% + 信息增益 5%  →  stop=true，reason 含「覆盖 95%」「信息增益 5%」
P0 failure 1                          →  stop=true（暂停低优先级 → RCA → BLOCK）
Coverage 95% 但 P0 仅 70%             →  stop=false（P0 门禁阻止，不能牺牲 P0）
预算 95% / 环境异常                   →  stop=true（强制停止）
已执行 1 个用例覆盖 100%              →  stop=false（防过早停止）
```

## 二、测试结果

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:stopping:test` | 1 文件 / 9 用例 PASS |
| `npm test` | 889 用例 PASS + 18 skipped（880 → 889，+9） |
| `npm run agent:test` | 450 PASS（无回归） |

## 三、与 Phase 22 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| StoppingDecision 结构（stop/reason/confidence/remainingCases/riskCoverage/coverage） | ✅ |
| 六种停止条件 | ✅ 全部纳入（P0 全覆盖作为门禁而非单独触发） |
| 必须输出为什么停止 | ✅ reason + 全量 conditions 评估 |
| 不能静默停止 | ✅ 每次判定都有理由 |
| 覆盖已充分 → 自动停止（场景 3） | ✅ |

## 四、下一步

进入 **Phase 22.5 Failure Prediction**：执行前预测哪些 Case 最容易失败，高失败概率提前优先执行。
