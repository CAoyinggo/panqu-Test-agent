# Phase 23 Readiness：自治测试生产闭环与 CI/CD 集成

## 一、扫描结论（11 项分析）

### 1. DecisionTrace 当前结构
`src/decisions/`：`DecisionRecorder` 记录 `kind/decision/score/evidence/reason/confidence/timestamp/inputs`，`toTrace()` 输出按类型汇总。
- 已有 6 类：requirement / risk / selection / priority / stopping / release。
- **缺**：`replanning` 类型（任务书要求至少 7 类）。
- **缺**：`caseId` / `outputs` 字段（决策与用例/输出关联）。

### 2. AgentTracer 当前结构
`src/agents/observability/`：`AgentTracer.startSpan/endSpan/recordLLM/recordTool/recordRetry/recordFallback/recordError/toTrace()`。
- span 级聚合 Token/LLM/Tool/重试/回退/错误。
- **缺**：事件级 Tool/LLM 明细（目前只记计数）、与 DecisionTrace 的合并视图。

### 3. Portfolio 当前 API
`src/portfolio/`：`categorizeCase / buildPortfolio / selectPortfolio / portfolioStats`，七类 + 默认策略。
- **缺**：`PortfolioPolicy` 完整配置接口（coreRate/riskRate/changeRate/regressionRate/historicalTopN/explorationBudgetRate/excludeQuarantinedFlaky），当前 `PortfolioSelectionRules` 无 excludeQuarantinedFlaky、regressionRate 等对齐项。
- **缺**：与 AutonomousRegression 的对接（目前离线）。

### 4. Exploration 当前 API
`src/exploration/`：`generateExplorations` 带 Risk/Budget/Permission 门禁，输出 GENERATED→(REJECTED)。
- **缺**：生命周期状态机（GENERATED→SCREENED→APPROVED→EXECUTED→VALIDATED/REJECTED）与进入 Regression Plan 的接口。
- **缺**：maxExplorationDuration 预算维度。

### 5. AutonomousRegression 当前 API
`src/autonomous/`：`runAutonomousRegression` 闭环（Select→Prioritize→Execute→Observe→Re-Plan→Stop），`simulation.ts` 5 个 Scenario。
- **缺**：直接接收 Portfolio 计划 / Exploration 候选作为输入；Re-Plan 记录的完整还原（Initial/RePlan#1/#2/Final）。

### 6. ReleaseDecision 当前 API
`src/release-decision/`：`decideRelease` 三态 PASS/BLOCK/REVIEW + 结构化证据。
- **缺**：`ReleaseDecision` 统一 Contract（releaseId/runId/checks/blockReasons/recommendations/traceId/createdAt）、输出 `output/<date>/<feature>/release-decision.json`、CI Exit Code 映射。

### 7. 当前 CI/CD Pipeline
- GitHub Actions：`.github/workflows/release.yml`（安全门禁 → 镜像 → 部署 → 通知），**无自治回归/发布门禁 job**。
- GitLab CI：`.gitlab-ci.yml`（build/test/deploy + 安全扫描），**无 agent-release-gate job**。

### 8. 可以直接复用的接口
- `DecisionRecorder`（决策存储）→ 扩展 kind/caseId/outputs 后复用。
- `AgentTracer`（span 观测）→ 作为 UnifiedTrace 的 spans 来源。
- `categorizeCase/buildPortfolio`（组合分类）→ 直接用于 Regression Plan 构建。
- `generateExplorations`（探索生成 + 门禁）→ 直接用于执行链。
- `runAutonomousRegression`（自治回归闭环 + 预算）→ 作为 E2E 流水线核心。
- `decideRelease`（三态决策）→ 作为 CI Gate 决策源。
- `evaluateReleaseGate`（operations）→ 保留为兼容层，不删除。

### 9. 需要扩展的接口
- `DecisionKind` 增加 `replanning`；`DecisionRecord` 增加 `caseId`/`outputs`。
- `AgentTracer`：无改动（复用），由新增 `UnifiedTracer` 聚合事件级明细。
- `PortfolioSelectionRules` → 升级为 `PortfolioPolicy`（新增 excludeQuarantinedFlaky / regressionRate 对齐）。
- `ExplorationResult` 增加生命周期状态与 `maxExplorationDuration`。
- `runAutonomousRegression` 增加接收 `portfolioPlan` / `explorationCandidates` 入参（可选，向后兼容）。
- `AutonomousBudget` 增加 `maxDecisionDepth` / `maxConsecutiveReplans`（任务书二十）。
- Dashboard aggregator 增加 Autonomous Run Summary。

### 10. 不允许修改的核心接口
- `AgentTracer` 现有方法签名（观测管线依赖）。
- `decideRelease` 决策逻辑与阈值（22.8 测试锁定，仅做适配输出 Contract）。
- `runAutonomousRegression` 既有参数与返回（22.6 的 19 个测试锁定；新入参全部可选默认值）。
- `evaluateReleaseGate`（Phase 21.8 operations，保留兼容）。

### 11. Phase 23 最小改造方案
```text
23.1 扩展 decisions（+replanning/+caseId/+outputs）+ 新增 unified-trace.ts（UnifiedTracer 聚合四轨）
23.2 新增 portfolio-regression.ts（PortfolioPolicy → Regression Plan，接入 AutonomousRegression 入参）
23.3 新增 exploration-regression.ts（生命周期状态机 + 三个门禁 + 加入 Regression Plan）
23.4 新增 release-ci.ts（Release Contract + JSON 输出 + exit code）+ bin/release-gate.ts + CI 工作流
23.5 新增 autonomous-pipeline.ts（离线 E2E 编排 + Re-Plan 记录还原）+ bin/run-autonomous-pipeline.ts
23.6 新增 dashboard Autonomous Run Summary + 报告 16 段 + Production Acceptance 测试
```

## 二、实施顺序（严格）
23.1 → 23.2 → 23.3 → 23.4 → 23.5 → 23.6，每步 Build + Unit Test + Agent Test + Full Regression + Phase Report。
