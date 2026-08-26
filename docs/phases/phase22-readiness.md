# Phase 22 Readiness：自治测试系统改造前扫描

> 依据任务书第三十三节，实施前先扫描 9 个目录（regression / knowledge / cost / quality /
> operations / observability / test-selection / risk / memory），输出 7 项分析。
> 扫描方式：3 个并行只读子代理读取全部 30+ 源文件 + 全仓交叉 grep 验证。

## 一、哪些能力已经存在

| 能力 | 位置 | 说明 |
|---|---|---|
| 风险分析 | `src/agents/risk/risk-analyzer.ts` | 规则确定性，`RiskItem.level: high/medium/low` + confidence，10 类风险维度 |
| 测试选择 | `src/agents/test-selection/selection-analyzer.ts` | P0-P3 选择 + 历史失败提优 + 预算裁剪 + 每用例 reasons |
| 历史记忆 | `src/agents/memory/` | TestMemory 7 查询 + JsonMemoryStore + memory-bridge（失败≥2 次判 flaky） |
| 知识库 | `src/knowledge/` | confidence + stats + rank（含时间衰减）+ 生命周期 + advisor 决策参与 |
| 成本台账 | `src/cost/cost-ledger.ts` | Cost/Case/Feature/Regression/Defect 四级聚合 + recordLLM 通路 |
| 质量度量 | `src/quality/` | 九维质量分 + 六维趋势 + Flaky 生命周期状态机 |
| 运维视图 | `src/operations/` | 11 类数据聚合 + Release Gate 四检查 + 模型四维对比 |
| 可观测性 | `src/agents/observability/` | AgentTrace（span/LLM/tool）+ AgentBudget 七项预算 |
| 持续回归 | `src/regression/` | 变更影响分析 + 回归计划（P0/P1 全量 + P2 直选）+ 历史趋势 |

## 二、哪些能力可以直接复用

1. `knowledge-advisor.failureRateOf` + `adviseFromKnowledge` → 22.7 知识权重更新的失败率来源
2. `KnowledgeStore.rank` 的 recency 时间衰减（`1 - ageDays/30`）→ 22.7 Knowledge Weight Decay 基础
3. `CostLedger.costPerCase()` → 22.1 CaseIntelligence.executionCost
4. `flaky-analyzer.classifyStatus` / `computeFlakinessIndex` → 22.1 flakyRate、22.3 失败聚集
5. `FlakyLifecycle`（六态状态机）→ 22.1 flakyRate、22.5 输入
6. `selectMinimumCostSuite` 的覆盖率/风险覆盖率计算 → 22.4 stopping 的 riskCoverage/coverage 判定
7. `analyzeChangeImpact` → 22.1 changeImpact、22.6 变更驱动
8. `RegressionHistory.trend` → 22.3 时间趋势
9. `RiskAnalyzer.analyzeRisks` → 22.3 Risk Prediction 的特征来源
10. `computeCiResult` / `evaluateReleaseGate` → 22.8 决策输入
11. `TestMemory.queryHistoricalRisk` / `querySimilarCase` → 历史失败/缺陷数据源
12. `memory-bridge.buildHistoricalRiskItems` → 22.3 失败聚集线索

## 三、哪些能力需要新增

| 阶段 | 需要新增 | 状态 |
|---|---|---|
| 22.1 | CaseIntelligence / FeatureRisk / FailureRisk / ChangeRisk / TestValue 统一计算 | 全新增 |
| 22.2 | Dynamic Priority Score（数字 score + reasons + 提降级） | 全新增 |
| 22.3 | Risk Prediction Engine（失败概率 + 时间衰减 + 趋势 + 变更信号 + 失败聚集） | 全新增 |
| 22.4 | Adaptive Test Stopping（动态停止 + 停止理由 + 置信度） | 全新增 |
| 22.5 | Failure Prediction（预执行失败预测） | 全新增 |
| 22.6 | Autonomous Regression Controller（select/prioritize/execute/observe/re-plan/stop） | 全新增 |
| 22.7 | Continuous Learning（执行结果自动改知识权重）+ Weight Decay | 全新增 |
| 22.8 | Autonomous Release Decision（REVIEW + confidence + evidence + actions） | 全新增 |
| 通用 | Test Portfolio（7 类）、Exploration Testing、DecisionTrace、Autonomous Simulation、--autonomous 开关、自治预算 | 全新增 |

## 四、哪些模块存在重复实现风险

1. **风险评分重复**：risk-analyzer 已有 level 分级；22.3 要数字概率。规则：预测引擎**引用** analyzer 结果做特征，不重写 analyzer。
2. **优先级重复**：selection-analyzer 已有 P0-P3；22.2 要动态 score。规则：新 prioritization 模块做评分，**不改** selection-analyzer，输出兼容（可降级回既有 P0-P3）。
3. **失败统计重复**：memory 无聚合接口；flaky-analyzer 有按 caseId 聚合。规则：22.1 failureRate 由 intelligence 自实现统计，不重复 flaky 的 flakinessIndex。
4. **停止条件重复**：cost-optimizer 有覆盖率计算。规则：22.4 复用其思路但针对"实时观察+停止"场景新实现。
5. **覆盖/风险覆盖**：多模块各自算。规则：22.1 intelligence-score 提供统一 `coverageValue/riskCoverage` 归一函数，22.4/22.6 复用。

## 五、哪些接口应该扩展而不是新增

1. **BudgetLimits**：新增自治预算字段（maxReplans / maxAutonomousCases / maxAutonomousCost / maxAutonomousDuration）——**扩展**既有接口（可选字段，向后兼容）。
2. **observability**：新增独立 `src/decisions/`（DecisionTrace）——**新增**模块并入 trace 体系，**不重构** tracer。
3. **release-gate**：22.8 新增 autonomous 决策模块，**保留** `evaluateReleaseGate` 作为底层检查，升级层只做增强。
4. **KnowledgeStore**：22.7 扩展 API（如 updateStatsFromRun），**追加**方法不破坏既有 add/query/rank。
5. **run-agent CLI**：新增 `--autonomous` 开关 + `manual/assisted/autonomous` 三模式，默认 false，不影响现有参数。

## 六、哪些阶段会影响现有 Pipeline

| 阶段 | 对现有 Pipeline 影响 |
|---|---|
| 22.1-22.5 | **零影响**：纯增量计算模块，无调用方依赖 |
| 22.6 | 新编排器（Autonomous Regression Controller），**不改** RegressionScheduler；作为 `--autonomous` 路径可选接入 |
| 22.7 | 仅**扩展** KnowledgeStore API（追加方法）；不改 add/query/rank 语义 |
| 22.8 | 新模块 + 升级 release 决策，**保留** evaluateReleaseGate |
| --autonomous 开关 | 新 CLI 参数，默认 false，既有调用（`npm run agent:run` 等）不受影响 |
| 验收命令 | 全部为**新增** npm 脚本；既有 npm test / agent:test / eval / e2e / dashboard / health 必须继续 PASS |

## 七、Phase 22 最小改造路径

每阶段固定流程（新目录新文件 + 单测 + 脚本 + 回归 + 报告），仅 22.7 追加 KnowledgeStore 方法、通用阶段追加 CLI 与脚本：

```
22.1 src/intelligence/（5 文件 + 测试）        → agent:intelligence:test
22.2 src/prioritization/（评分 + 测试）        → agent:priority:test
22.3 src/risk-prediction/（引擎 + 测试）       → agent:risk-prediction:test
22.4 src/stopping/（停止判定 + 测试）          → agent:stopping:test
22.5 src/failure-prediction/（预测 + 测试）    → agent:failure-prediction:test
22.6 src/autonomous/（回归控制器 + 测试）      → agent:autonomous:test
22.7 src/learning/（知识权重更新 + 测试）      → agent:learning:test
22.8 src/release-decision/（自治发布 + 测试）  → agent:release-decision:test
通用  src/portfolio/（7 类组合）+ src/decisions/（DecisionTrace）
     + src/exploration/（探索测试）+ bin/autonomous-sim.ts（仿真）
     → npm run agent:autonomous:test（5 个 Scenario）
```

约束红线：纯增量、零新增 Agent、无向量库、LLM 仅解释不决策、确定性可复现。
