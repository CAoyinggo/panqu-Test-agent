# Phase 23.3 Exploration → Regression 接入报告

## 一、目标

把 Phase 22 的 Exploration Testing 从「生成候选输入」升级为真正进入执行链：
`Regression → Coverage Gap → Exploration → Risk Gate → Budget Gate → Permission Gate → 加入 Regression Plan`。
新增生命周期状态机与三进门禁，并接入 Regression Plan。

## 二、改动清单

| 文件 | 改动 |
| --- | --- |
| `src/exploration/exploration-schema.ts` | `ExplorationConfig` 新增 `maxExplorationDuration`（默认 120000ms）；新增 `ExplorationLifecycleStatus`（GENERATED/SCREENED/APPROVED/EXECUTED/VALIDATED/REJECTED）；`ExplorationCandidate` 新增可选 `estimatedDurationMs` / `status`；`ExplorationResult` 新增 `usedDuration` |
| `src/exploration/exploration-engine.ts` | 候选统一补 `estimatedDurationMs`（history 40000ms / 其他 20000ms）与 `status: GENERATED`；新增 duration 预算门禁（maxExplorationDuration）；返回 `usedDuration` |
| `src/exploration/exploration-lifecycle.ts` | **新建**：权限分类、三进门禁、生命周期状态机、`runExplorationPlan`（接入 Regression） |
| `src/exploration/index.ts` | 导出新模块 |
| `tests/unit/exploration-regression.test.ts` | **新建**：12 个测试 |
| `package.json` | 新增 `agent:exploration-regression:test` |

## 三、核心设计

### 生命周期状态机

```text
GENERATED → SCREENED → APPROVED → EXECUTED → VALIDATED
    │          │            │            │         └── 已验证（发现缺陷/确认无缺陷）
    │          │            └── 授权    └── 已执行
    │          └── 通过三进门禁
    └── 任一门禁未通过 → REJECTED
```

`advanceExploration(state, to)`：确定性校验合法转移，非法转移抛错。

### 三进门禁

```text
Risk Gate：riskScore ≥ riskGateThreshold 且未授权 → block（P0 dangerous input 禁止生成）
Budget Gate：maxExplorationCases / maxExplorationCost / maxExplorationDuration 任一超限 → block
Permission Gate：production → dangerous=DENY、risky=Approval；非生产 → dangerous 需 approveProduction
```

权限分类 `classifyPermission`（确定性）：
- 命中危险动作关键词（billing / payment / delete / db-modify / run-production / stress 等）→ dangerous
- 历史失败探索或 riskScore ≥ 0.5 → risky
- 其余（覆盖缺口 / 参数组合）→ safe

### 接入 Regression Plan

```text
runExplorationPlan(input):
  Coverage Gap / 历史失败 / 参数空间
    → generateExplorations（基础门禁）
    → screenCandidate（完整三进门禁 + 生命周期）
    → screened（SCREENED，可加入 Regression Plan）/ rejected（REJECTED + 原因）
```

## 四、验收结果

```text
agent:exploration-regression:test   12 PASS
agent:exploration:test               9 PASS（22 阶段不受影响）
npm test                            997 PASS + 18 skipped（新增 12 个 23.3 测试）
```

## 五、测试覆盖

1. 生命周期完整链：GENERATED → SCREENED → APPROVED → EXECUTED → VALIDATED
2. 失败链：任意状态 → REJECTED；非法转移抛错（GENERATED→EXECUTED、REJECTED→APPROVED）
3. Risk Gate：高风险未授权 → block；授权 → pass
4. Budget Gate：count / cost / duration 超限 → block
5. Permission Gate：production → dangerous=DENY（即使授权也拒绝）
6. Permission Gate：非生产 dangerous → 需 approveProduction
7. 权限分类：coverage-gap→safe、history/risk≥0.5→risky、危险标签→dangerous
8. 覆盖缺口触发探索 → 通过门禁候选可加入 Regression Plan
9. 历史失败未授权 → Risk 门禁拒绝，不加入 Regression
10. Budget 门禁：maxExplorationDuration 超限 → 拒绝并记录原因
11. production 安全：自治模式不改变安全策略（dangerous 候选 DENY）
12. 确定性：相同输入相同计划

## 六、关键修复

- **runExplorationPlan 拒绝候选丢失**：generateExplorations 内基础门禁（Budget 等）拒绝的候选最初未并入 runExplorationPlan 的 rejected / lifecycle，已修复为全部并入并标 REJECTED。
- **advanceExploration 签名**：允许 `REJECTED` 转移（GENERATED→REJECTED 合法），不允许回到 `GENERATED`。

## 七、下一步

进入 Phase 23.4 Autonomous Release → CI/CD：统一 Release Contract、CI Exit Code（0/1/2/3）、
`release-gate.js` CLI、GitHub Actions `agent-release-gate.yml`、GitLab CI job、自治预算扩展（maxDecisionDepth / maxConsecutiveReplans）。
