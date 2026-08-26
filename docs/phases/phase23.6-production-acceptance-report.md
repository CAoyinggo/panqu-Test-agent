# Phase 23.6 Production Acceptance 报告

- 阶段：23.6 Production Acceptance（生产验收）
- 主题：把 23.1–23.5 的自治测试能力收口为「可验收、可解释、可上生产」的闭环
- 原则：Deterministic First（决策全部由规则引擎推导，不调用 LLM）；REVIEW 绝不返回 0；自治模式不改变安全策略

## 一、验收目标

| # | 验收项 | 结论 |
|---|--------|------|
| 1 | Dashboard Autonomous Run Summary（自治运行聚合） | ✅ 通过 |
| 2 | 16 段 HTML Report（可解释性） | ✅ 通过 |
| 3 | Production Safety（dangerous=DENY、risky=Approval） | ✅ 通过 |
| 4 | 预算防无限循环（maxDecisionDepth / maxConsecutiveReplans → AUTONOMOUS_STOP） | ✅ 通过 |
| 5 | 保留命令全部继续通过 | ✅ 通过 |

## 二、Dashboard Autonomous Run Summary

- 数据来源：`bin/dashboard.ts` 递归扫描 `output/**/run-summary.json`，聚合为 `OperationsView.autonomous`。
- 结构：`OperationsAutonomousRun`（runId / feature / total / executed / skipped / passed / failed / replans / rcaCount / coverage / riskLevel / stopReason / portfolioRate / explorationGenerated / Screened / Rejected / decision / releaseDecision）。
- 高亮规则：BLOCK → HIGH，REVIEW → MEDIUM，PASS 不高亮。
- 实测结果（`node dist/bin/dashboard.js`）：
  - 自治运行 **6 次**（`--all` 6 场景，每个场景唯一 runId：`run-<ts>-<scenarioId>`）
  - 最新 Release = REVIEW，RePlan 合计 4，RCA 合计 4
  - 关注项 5 条：2 个 BLOCK（HIGH）+ 3 个 REVIEW（MEDIUM）
- 唯一 runId 修复：`--all` 模式下每个场景独立 runId，并按场景写入独立子目录
  `output/<date>/<feature>/<scenarioId>/`，避免同 feature 多场景互相覆盖 `run-summary.json`。

## 三、16 段 HTML Report（为什么）

`src/autonomous/autonomous-report.ts` 生成 `output/<date>/<feature>/<scenario>/autonomous-report.html`，共 16 段：

01 Requirement / 02 Change Impact / 03 Portfolio / 04 Exploration / 05 Priority / 06 Regression Plan / 07 Execution / 08 RePlanning / 09 Adaptive Stop / 10 RCA / 11 Defect / 12 Healing / 13 Knowledge Update / 14 Release Decision / 15 Unified Trace / 16 Cost

报告内置「为什么」回答，每段均有证据：

| 问题 | 回答段落 |
|------|----------|
| 为什么选这些 Case？ | 03 Portfolio（组合策略 Core/Risk/Change/Regression + 证据列表 + 选中/跳过明细） |
| 为什么没执行其他 Case？ | 07 Execution（计划 vs 执行 vs 跳过 + 原因：组合筛选 / 自适应停止 / 暂停低优先级 / 预算上限） |
| 为什么重新规划？ | 08 RePlanning（失败用例按相关性标签触发提升与暂停，逐条列出 cause/action） |
| 为什么停止？ | 09 Adaptive Stop（stopReason + 暂停低优先级列表） |
| 为什么 BLOCK / REVIEW？ | 14 Release Decision（blockReasons / recommendations 逐条） |
| AI 到底做了什么？ | 15 Unified Trace（requirement → selection → risk → priority → replanning → stopping → rca → release 全链路决策记录） |

## 四、Production Safety（自治模式不改变安全策略）

- `tests/unit/autonomous-dashboard.test.ts` 覆盖（24 用例全 PASS）：
  - **production 环境危险探索 DENY**：`environment: 'production'` + 危险覆盖缺口 `billing`，探索候选被 DENY，不进入回归用例列表，`exploration.evidence` 含 `DENY`。
  - **test 环境危险动作仍需审批**：`database-mutation` 等 risky 探索候选未审批 → 不执行，不能自动绕过 Approval。
- `agent:health` 实测：`生产安全策略：production 默认关闭（6 项危险动作被守卫）`。
- 结论：自治流水线在 exploration 阶段即执行 Permission + Approval 三进门禁，production 下 dangerous=DENY、risky=Approval，与人工模式一致。

## 五、预算防无限循环（AUTONOMOUS_STOP）

- 语义：`(used.decisionDepth ?? 0) > limits.maxDecisionDepth` 触发（超过才停），默认 `maxDecisionDepth: 20`。
- 测试覆盖（全 PASS）：
  - **maxDecisionDepth 超限**：30 个 P0 用例 + `maxDecisionDepth: 5` → `decision=BUDGET_EXHAUSTED`、`exceededLimit=maxDecisionDepth`、`reason` 含「最大决策深度」，且输出 `budgetUsed.decisionDepth` 与 `AUTONOMOUS STOP` 证据（trace 可解释）。
  - **maxConsecutiveReplans 超限**：8 个 P2 用例全失败 + `maxConsecutiveReplans: 1` + `clusterFailureTrigger: 99` → 连续重规划第 2 次后 `exceededLimit=maxConsecutiveReplans`、`BUDGET_EXHAUSTED`。
- 停止时输出：reason / budget / trace（由 RunSummary.stopReason 与 DecisionTrace 承载）。

## 六、CI Exit Code（Release Gate）

`scripts/ci/agent-release-gate.mjs` 实测：PASS→0、BLOCK→1、REVIEW→2、SYSTEM_ERROR→3（REVIEW 绝不返回 0）。`--all` 6 场景验收：PASS/0、REVIEW/2、REVIEW/2、BLOCK/1、REVIEW/2、BLOCK/1。

## 七、全量回归

| 命令 | 结果 |
|------|------|
| `npm test` | 1065 PASS / 18 SKIP（75 文件通过） |
| `npm run agent:test` | 450 PASS（34 文件） |
| `npm run agent:autonomous:e2e` | `--all` 6 场景通过 + e2e 26 PASS |
| `npm run agent:eval` | 8 PASS |
| `npm run agent:e2e` | 2 PASS |
| `npm run agent:health` | HEALTHY 4/4（含生产安全守卫） |
| `npm run agent:dashboard` | 自治运行 6 次聚合正确 |
| 新增单测 | `replan.test.ts` 7 PASS、`autonomous-dashboard.test.ts` 24 PASS |

## 八、产物清单

`output/2026-08-18/` 下 6 场景 × 4 类产物 = 24 个文件：
- `run-summary.json`（Dashboard / Gate 消费，含 rcaCount / stopReason / portfolioRate / exploration 计数）
- `autonomous-pipeline.json`（完整结果）
- `release-decision.json`（统一 Release Contract）
- `autonomous-report.html`（16 段可解释报告）
- `output/operations-dashboard.json` + `output/operations-dashboard.html`（运维视图）

## 九、结论

23.6 Production Acceptance 全部达标：自治运行可在 Dashboard 独立呈现与高亮、16 段报告回答全部「为什么」、生产安全策略不被自治模式改变、预算双保险（maxDecisionDepth / maxConsecutiveReplans）防无限循环，且保留命令全部继续通过。Phase 23 六阶段（23.1→23.6）全部完成。
