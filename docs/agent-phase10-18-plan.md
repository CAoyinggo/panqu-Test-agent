# AI Test Agent Phase 10-18 升级分析与实施计划

> 本文档为 Phase 10-18 增强与智能化升级任务开始前的代码勘察与映射分析（任务书第 28 节要求）。
> 结论：**不推翻现有 Phase 1-9，在现有架构上增量扩展**。所有新增能力遵循「LLM 优先 + 确定性回退」「Agent 必须经 Tool 调用执行能力」「复用现有 Core/Engine/Assertion/DataFactory」三条铁律。

---

## 一、现有 Phase 1-9 结构扫描

### 1.1 目录结构（src/agents/）

| 目录 | 现有文件 | 阶段产物 |
|---|---|---|
| `core/` | `agent.ts`（TestAgent 接口 + BaseAgent）、`agent-context.ts`、`agent-result.ts`、`agent-state.ts`（StageStatus + AgentRunState）、`agent-registry.ts` | 统一 Agent 基础设施 |
| `tools/` | `tool.ts`（AgentTool + ToolResult）、`tool-registry.ts`（注册/超时/审计/安全调用） | Tool Registry |
| `memory/` | `memory-store.ts`（TestMemory 接口 + MemoryRecord + NoopMemory）、`json-memory.ts`、`memory-bridge.ts` | Memory 层 |
| `requirement/` | `requirement-agent.ts`、`requirement-schema.ts`、`requirement-parser.ts` | Phase 10 增强目标 |
| `test-design/` | `test-design-agent.ts`、`testcase-schema.ts`、`testcase-generator.ts` | Test DSL |
| `risk/` | `risk-agent.ts`、`risk-schema.ts`、`risk-analyzer.ts` | 风险评估 |
| `data/` | `data-agent.ts`、`data-schema.ts`、`data-analyzer.ts`、`data-prepare-tool.ts` | 数据准备 |
| `execution/` | `execution-agent.ts`、`execution-schema.ts`、`execution-run-tool.ts` | 执行 |
| `analysis/` | `analysis-agent.ts`、`analysis-schema.ts`、`analysis-analyzer.ts` | 分析（Phase 13 拆分增强目标） |
| `orchestration/` | `agent-pipeline.ts`（7 阶段串联）、`orchestrator.ts`（阶段编排 + 审批 AUTO/REVIEW/MANUAL + 重试） | 编排 |

### 1.2 关键接口现状

- **AgentContext**：taskId / feature / environment / requirement / testCases / riskAssessment / executionResults / history / tools / memory / llm / logger / metadata。已有 `metadata` 扩展槽位。
- **Agent 接口**：`TestAgent<TInput,TOutput>`（name/version/description/execute）+ `BaseAgent`（含 `runWithResult` 包装）。Agent 统一走 `context.llm` 推理。
- **ToolRegistry**：`register/get/has/list/call`；`call` 内置超时（默认 30s）+ 错误捕获 + 审计回调（`onAudit`）。已有 `AgentTool` 接口（name/description/inputSchema/outputSchema/timeoutMs/execute）。
- **TestMemory**：`save/query/getSimilarFailures`；MemoryRecord 含 `type`（已含 execution/failure/root-cause/environment-change/model-change/api-change/flaky/test-data/test-design/manual-confirmation/defect）。`json-memory.ts` 已实现 `getSimilarFailures` 相似度检索。
- **StageStatus**：pending/running/completed/failed/skipped/waiting-approval（`agent-state.ts`）。Orchestrator 已支持阶段跳过、审批（AUTO/REVIEW/MANUAL）、重试、超时。
- **CLI**：`bin/run-agent.ts`（requirement 文本 → pipeline → 报告；`--env/--skip-execution/--json/--memory/--help`）。
- **数据模型**：`Requirement`（feature/capabilities/inputs/requirements/businessRules/dependencies/source/confidence）、`TestCase`（id/feature/name/priority/tags/steps/assertions/...，复用 17 个断言操作符）、`RiskItem`（10 维度）、`CaseExecutionResult`、`AnalysisReport`。全部带 JSON Schema（ajv 动态加载校验）。

### 1.3 当前验证基线（Phase 1-9 已确认）

- `npm run build` ✅
- `npm test`：21 文件 / 422 测试全过 ✅
- `npx vitest run --coverage`：lines≥80 / functions≥80 / branches≥75 / statements≥80 门禁通过 ✅
- `npm run agent:test`：13 文件 / 197 测试 ✅
- CLI 冒烟 + 完整链路（mock 执行 + 记忆持久化）✅

---

## 二、Phase 10-18 与现有代码映射关系

| Phase | 目标 | 复用现有 | 新增/修改点 | 依赖现有接口 |
|---|---|---|---|---|
| **P10 Requirement Agent 增强** | 需求理解（goal/constraints/risks/版本/文档输入） | `requirement-schema.ts`、`requirement-parser.ts`、ajv | 新增 `requirement-normalizer.ts`、`prompts/`；修改 `requirement-schema.ts`、`requirement-agent.ts`、`requirement-parser.ts` | `AgentContext.llm`、`TestAgent` |
| **P11 Test Selection Agent** | 智能选例（风险/历史/变更/预算） | `risk-schema`、`TestCase`、`memory.query` | 新增 `test-selection/`（schema/analyzer/agent） | `AgentContext.memory`、`AgentContext.tools` |
| **P12 Coverage Agent** | 覆盖分析（需求/参数/边界/风险/缺口） | `Requirement`、`TestCase`、`RiskItem` | 新增 `coverage/`（schema/analyzer/agent） | 阶段产物串联 |
| **P13 RCA 深度根因** | 证据链 + 根因分类 | `AnalysisReport`、`CaseExecutionResult`、`memory.query` | 新增 `analysis/evidence-collector.ts`、`failure-classifier.ts`、`root-cause-schema.ts`、`root-cause-agent.ts` | `AgentContext.memory`、`AgentContext.tools` |
| **P14 Defect Agent** | 标准缺陷草稿（与提交分离） | `AnalysisReport`、`CaseExecutionResult` | 新增 `defect/`（schema/agent） | 复用 RCA 产物 |
| **P15 Self-Healing Agent** | 路径失效检测 + Diff 建议（人工确认） | `TestCase.assertions`、Path 断言 | 新增 `self-healing/`（schema/analyzer/agent） | 复用 ToolRegistry + Approval |
| **P16 Approval / HITL** | 风险操作分级审批 + 审计 | `orchestrator.ts`（已有 ApprovalMode） | 新增 `approval/`（policy/schema/audit） | `ToolRegistry` 审计钩子 |
| **P17 Observability** | Agent Trace / Token / Cost / Budget | `ToolRegistry.onAudit`、`BaseAgent.runWithResult` | 新增 `observability/`（tracer/budget/schema）+ `model-router.ts` | `AgentContext.metadata` |
| **P18 Evaluation** | Agent 评测体系 + Benchmark | `MockLLMProvider`、全部 Agent | 新增 `tests/evals/`（runner/benchmark）+ `agent:eval` 脚本 | 全部 Agent 可注入 |

### 2.1 跨章节能力归属

任务书第 13-23 节为横切能力，按最小侵入原则归入对应 Phase：

| 横切能力 | 归属阶段 | 落点 |
|---|---|---|
| Memory → Knowledge System（querySimilarCase/queryKnownIssue/queryCoverageGap） | P11/P13 | 扩展 `memory-store.ts` 接口 + `json-memory.ts` 实现 + `memory-bridge.ts` 桥接 |
| Flaky Test Agent（flakiness_index + 分类） | P13（分析侧） | 新增 `flaky/` 模块，供 Analysis/RCA 消费 |
| AI 测试预算控制（Budget） | P17 | 新增 `observability/budget.ts`，Pipeline/Execution 校验 |
| Agent 状态机 + 失败恢复（checkpoint/resume/pause/cancel/retry） | P16/P17 | 增强 `agent-state.ts` + `agent-pipeline.ts` |
| 安全边界（Permission/脱敏/禁止 LLM→shell） | 全部 Phase | 增强 `tool-registry.ts`（权限层）+ `utils/` 脱敏工具 |
| Prompt 管理（versioned prompts） | P10 起 | 新增 `prompts/` 注册表，逐步替换硬编码 SYSTEM_PROMPT |
| 模型路由（Model Router） | P17 | 新增 `llm/model-router.ts`，按任务路由 |
| 确定性优先（Deterministic First） | 全部 Phase | 延续现有「LLM 优先 + 确定性回退」模式，规则引擎负责确定性结果 |
| 报告升级（AI 专区 14 段） | P18 前 | 扩展 `agent-pipeline.ts` 结果结构 + CLI 输出 |
| CLI 增强（--select/--coverage/--rca/--defect/--heal/--approve/--resume/--trace/--eval/--budget） | 各 Phase 收尾 | 扩展 `bin/run-agent.ts` |

---

## 三、新增文件清单

### Phase 10
- `src/agents/requirement/requirement-normalizer.ts`（归一化增强：goal/constraints/risks/版本/原始需求保留）
- `src/agents/prompts/registry.ts`（Prompt 注册表：version/purpose/input/output/model/temperature）
- `src/agents/prompts/requirement.ts`（Requirement Prompt v1）

### Phase 11
- `src/agents/test-selection/selection-schema.ts`
- `src/agents/test-selection/selection-analyzer.ts`（确定性选例）
- `src/agents/test-selection/test-selection-agent.ts`

### Phase 12
- `src/agents/coverage/coverage-schema.ts`
- `src/agents/coverage/coverage-analyzer.ts`
- `src/agents/coverage/coverage-agent.ts`

### Phase 13
- `src/agents/analysis/failure-classifier.ts`
- `src/agents/analysis/evidence-collector.ts`
- `src/agents/analysis/root-cause-schema.ts`
- `src/agents/analysis/root-cause-agent.ts`
- `src/agents/flaky/flaky-schema.ts`
- `src/agents/flaky/flaky-analyzer.ts`
- `src/agents/flaky/flaky-agent.ts`

### Phase 14
- `src/agents/defect/defect-schema.ts`
- `src/agents/defect/defect-agent.ts`

### Phase 15
- `src/agents/self-healing/healing-schema.ts`
- `src/agents/self-healing/healing-analyzer.ts`
- `src/agents/self-healing/self-healing-agent.ts`

### Phase 16
- `src/agents/approval/approval-schema.ts`
- `src/agents/approval/approval-policy.ts`（确定性分级策略 AUTO/REVIEW/MANUAL/DENY）
- `src/agents/approval/approval-audit.ts`（审计日志）

### Phase 17
- `src/agents/observability/tracer.ts`（Agent Trace 记录）
- `src/agents/observability/observability-schema.ts`
- `src/agents/observability/budget.ts`（Token/Call/Case/并发/时长/积分预算）
- `src/llm/model-router.ts`（模型路由）

### Phase 18
- `tests/evals/run-evals.ts`（评测运行器）
- `tests/evals/benchmark/`（60 条固定 Benchmark 数据）
- `tests/evals/agent-eval.test.ts`（评测测试）

### 测试文件（各 Phase 配套）
- `tests/unit/requirement-normalizer.test.ts`、`test-selection-agent.test.ts`、`coverage-agent.test.ts`、`root-cause-agent.test.ts`、`defect-agent.test.ts`、`self-healing-agent.test.ts`、`approval.test.ts`、`observability.test.ts`、`flaky-agent.test.ts`、`model-router.test.ts`、`budget.test.ts`、`prompt-registry.test.ts`、`state-machine.test.ts`

---

## 四、修改文件清单

| 文件 | 修改内容 |
|---|---|
| `src/agents/requirement/requirement-schema.ts` | 新增 goal/constraints/risks/version 字段 + JSON Schema |
| `src/agents/requirement/requirement-parser.ts` | 确定性提取 goal/constraints/risks |
| `src/agents/requirement/requirement-agent.ts` | 文档输入（Markdown/接口文档）、保存原始+归一化+版本、接入 Prompt Registry |
| `src/agents/memory/memory-store.ts` | TestMemory 接口扩展（querySimilarCase/queryKnownIssue/queryCoverageGap/queryHistoricalRisk） |
| `src/agents/memory/json-memory.ts` | 实现新增知识查询方法 |
| `src/agents/memory/memory-bridge.ts` | 新增桥接：知识检索、RCA 记忆、缺陷记忆、自愈记忆 |
| `src/agents/core/agent-state.ts` | 升级为完整状态机（INIT→...→COMPLETED + FAILED/PAUSED/WAITING_APPROVAL/CANCELLED + checkpoint/resume） |
| `src/agents/core/agent-context.ts` | 新增可观测/预算/审批/状态机字段 |
| `src/agents/tools/tool-registry.ts` | 新增权限层（Permission 检查）+ 审计日志增强 |
| `src/agents/orchestration/agent-pipeline.ts` | 接入 Selection/Coverage/RCA/Defect/Healing/Flaky/StateMachine/Budget/Trace 阶段；checkpoint/resume |
| `src/agents/orchestration/orchestrator.ts` | 状态机对接、审批策略接入 |
| `src/agents/index.ts` | 新增模块导出 |
| `bin/run-agent.ts` | CLI 增强（--select/--coverage/--rca/--defect/--heal/--approve/--resume/--pause/--cancel/--trace/--eval/--budget/--requirement 文件） |
| `package.json` | 新增 `agent:eval`、`agent:trace` 等脚本；agent:test 追加新测试文件 |
| `src/agents/analysis/analysis-schema.ts` | RCA 报告字段扩展（可选） |
| `vitest.config.ts` | 覆盖率 include 追加新目录（如需） |

---

## 五、需要兼容的接口

1. `TestAgent<TInput,TOutput>` / `BaseAgent` —— 全部新 Agent 遵循同一接口，可被 `AgentRegistry`/`AgentOrchestrator` 消费。
2. `AgentContext` —— 只增不改：新增字段全部可选，`createAgentContext` 向后兼容。
3. `ToolRegistry.call` 签名 —— 保持 `(name, input, context) => Promise<ToolResult>` 不变；权限层内部追加，不破坏调用方。
4. `TestMemory` 接口 —— 新方法给默认实现（`NoopMemory` 返回空），避免破坏既有实现。
5. `AgentRunState` / `StageStatus` —— 新增状态值以联合类型扩展方式追加，既有 `setStatus/isDone/hasFailure` 保持兼容。
6. `Requirement` / `TestCase` / `RiskAssessment` / `ExecutionOutcome` / `AnalysisReport` —— 只增可选字段，既有消费方不受影响。
7. `runAgentPipeline(input, context)` 签名 —— 保持不动；新阶段以选项方式开启（`options.select/coverage/rca/...`），默认行为与 Phase 1-9 一致。
8. `bin/run-test.ts`（原有执行 CLI）—— 不改，仅扩展 `bin/run-agent.ts`。

---

## 六、重复实现风险识别

| 风险 | 规避措施 |
|---|---|
| RCA 与 Analysis 功能重叠 | Analysis 保留整体汇总；RCA 只做「单失败用例证据链 + 根因定位」，输入来自 Analysis 产物，二者职责分离 |
| Defect 与 Analysis findings 重叠 | Defect 只把失败转为标准缺陷草稿结构，不重复分析；Source 为 RCA 产物 |
| Flaky 与 Risk compatibility 重叠 | Flaky 专注统计分类（flakiness_index），Risk 专注风险项；Flaky 结果可回填 Risk/Selection |
| Selection 与 Execution.planExecution 重叠 | Execution.planExecution 做「排序/并发」，Selection 做「选哪些/跳过哪些/为何」，Selection 输出喂给 Execution |
| Coverage 与 testcase-generator 重叠 | Coverage 只算「已覆盖 vs 缺口」，不生成用例；缺口建议喂给后续 Design 迭代 |
| 状态机与 orchestrator 阶段状态重叠 | 状态机升级现有 `AgentRunState`（复用），不另起炉灶 |
| 审批与 orchestrator approval 重叠 | 扩展现有 `ApprovalPolicy`/`ApprovalMode`，新增确定性策略引擎（按环境/严重度/操作类型定级），不重写 orchestrator |
| Budget 与 CLI 参数重复 | Budget 统一收敛到 `observability/budget.ts`，CLI/Execution 都读同一结构 |

---

## 七、潜在 Breaking Change 与规避

| 风险点 | 影响 | 规避 |
|---|---|---|
| `TestMemory` 接口新增方法 | 第三方实现（如有）需补方法 | 新方法设默认实现；本项目仅 `NoopMemory`/`JsonMemoryStore` 两个实现 |
| `Requirement` 新增字段 | normalizeRequirement 返回值结构变化 | 新字段全可选；`buildRequirement` 补默认值 |
| `agent-state.ts` 状态扩展 | 既有 `StageStatus` 消费方 | 以追加联合成员方式扩展；`toJSON` 保持 |
| Pipeline 新增阶段默认关闭 | 既有测试断言 stages 集合 | 新阶段仅 `options` 开启时执行；默认跑通 Phase 1-9 全量回归确认 |
| Coverage 门禁 | 新目录未被覆盖拖低阈值 | 每 Phase 配套测试；必要时调整 include（不降阈值） |
| ajv 动态加载 | 无 | 沿用现有模式 |

---

## 八、实施计划（小步提交）

每个 Phase：`实现 → build → 单测 → 集成测 → 全量回归 → 变更小结`，通过后才进入下一 Phase。

```
Phase 10  Requirement Agent 增强 + Prompt 管理
Phase 11  Test Selection Agent
Phase 12  Coverage Agent
Phase 13  RCA + Failure Classifier + Evidence Collector + Flaky
Phase 14  Defect Agent
Phase 15  Self-Healing Agent
Phase 16  Approval / Human-in-the-loop + 状态机 + 失败恢复
Phase 17  Observability / Trace / Budget / Model Router + 安全边界
Phase 18  Evaluation / Benchmark + 报告升级 + CLI 增强
收尾      全量验收（build / test / coverage / agent:test / agent:eval / 端到端）
```

验收标准（任务书第 25 节）：`npm run build`、`npm test`、`npm run test:coverage`、`npm run agent:test`、`npm run agent:eval` 全部通过 + 端到端 Demo 需求走通 15 步闭环。
