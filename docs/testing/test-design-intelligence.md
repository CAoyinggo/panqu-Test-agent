# DevTest 测试设计智能标准

本标准约束现有测试用例生成链，不建立新的 Requirement、Case 或 Runner 协议：

```text
Requirement Model
→ Business Model Projection
→ Business Understanding
→ Risk-driven Test Strategy
→ Business Scenario
→ Dynamic Test Dimension
→ TEST_CASE_V2
→ Quality Gate / Test Design Review
```

## Current Capability

- Canonical Fact Ledger 保留 Fact ID、Source、Confidence、Conflict 与 UNKNOWN。
- Business Model Projection 表达 Actor、Role、Resource、Owner、Tenant/Project、State、Rule、Dependency、Risk、Flow。
- TEST_CASE_V2、Scenario Adapter、Scenario Runner、Runtime Readiness、Evidence、Oracle 与 Report 继续作为执行主链。
- Fact-level Strategy Policy 只读取 canonical Fact，不允许 Generator 重新解析文本补规则。
- 默认 `TestDesignAgent` 在调用 LLM 前先生成 canonical Requirement、Business Model、Business Understanding、Risk-driven Test Strategy 与 Scenario Candidates，并将其作为唯一设计上下文。
- LLM 不可用或输出不合格时，确定性回退复用 Acceptance Generator 与 Quality Gate，输出仍为 `TEST_CASE_V2`；不再生成固定 `submit` 和 `result exists` 的旧 DSL Case。

## Missing Test Intelligence 基线

历史生成链只有 Fact 级维度和单 Fact Scenario，缺少组合业务理解、风险组合策略、State Graph、权限/隔离关系推理，以及覆盖与业务重复 Review。P0 负责补齐这些生成期能力；P1 预留外部依赖故障注入与更丰富组合探索；P2 预留基于历史缺陷和生产风险的自适应策略。

## Business Understanding

每个规范性 Fact 必须回答：谁，对什么资源，在什么状态，执行什么动作，满足什么规则，产生什么结果和副作用。答案来自 Requirement Model 与 Business Model；缺失项只能标记为 `UNKNOWN` 或 `NEED_CONFIRMATION`，不得补写为需求。

State Graph 的节点和边只来自显式状态或 State Transition。Data Relationship 只投影显式 Ownership、Tenant/Project Scope、Resource Dependency 和 Side Effect。

## Risk-driven Test Strategy

组合策略包含：Core Business Flow、High Risk Flow、Negative Business Flow、State、Permission、Data Isolation、Concurrency、Idempotency、Side Effect、Recovery。每个领域都必须记录 Applicability、Priority、Fact IDs、Risk IDs、选择理由和所需测试维度。

- P0：核心业务、权限、隔离、关键状态、安全、原子性和一致性。
- P1：高风险异常、幂等、并发、恢复与副作用。
- P2：普通参数验证、边界与低风险组合。

未被 Requirement/Business Model 支持的领域为 `NOT_APPLICABLE`；需要补充的信息为 `NEED_CONFIRMATION`，不得机械生成 Case。

## Business Scenario 与 Case

Scenario 标题和 Goal 描述用户业务目标，不使用 Method/Path 代替业务语义。原始 Requirement statement 继续保留在 Fact 和 Objective 的“需求依据”中，保证 trace 不丢失。

Case 必须包含 `riskJustification` 和 `designOrigin`：

- `REQUIREMENT_DERIVED`
- `RULE_DERIVED`
- `RISK_DERIVED`
- `EXPLORATORY`

Risk-derived/Exploratory 只能保留推导依据，不能提升为产品需求。幂等、并发、状态冲突、跨 Scope 和恢复使用现有 TEST_CASE_V2 多步骤表达；运行时仍通过现有 Scenario Adapter/Runner 执行。

## Test Design Review

生成后统一检查 Requirement、Core Flow、Risk、Negative、State、Permission、Isolation、Side Effect 覆盖，以及 Executable Rate、Oracle/Evidence Completeness、UNKNOWN 安全阻断、Semantic Duplicate 和 Business Duplicate。

同一主要结论、相同证明义务的低价值单步设计必须由更完整的组合场景替代；合并时保留全部 Fact、Objective、Acceptance Criteria 和原阻断原因。Review 发现高价值缺失时必须报告，不允许以 Case 数量或 HTTP Status 伪造覆盖。

## Execution Boundary

`runAgentPipeline` 的 Data/Risk/Selection/Execution 段直接消费 canonical `TEST_CASE_V2`。Execution Agent 通过现有 Scenario Adapter 解析 Processor、Observer、Hook、Environment、Test Data 和 Dependency，重新计算 Runtime/Effective Readiness 后交给 Scenario Runner。

旧 Test DSL 转换函数只供非 Agent Pipeline 的独立历史调用方；标准生成、Quality Gate、Agent Pipeline 和开发者入口不依赖该路径，也不用手工 Scenario 替换 Generator Case。
