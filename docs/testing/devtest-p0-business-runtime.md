# DevTest P0：Business Model、V2 Adapter 与 Runtime Readiness

本阶段保持既有主链和 Scenario Runner 协议不变：

```text
AcceptanceRequirement + Fact Ledger
→ Business Model Projection
→ Business Scenario / TEST_CASE_V2
→ Generator Quality Gate 原始 Case
→ TestCaseV2ScenarioAdapter
→ canonical Scenario
→ existing Scenario Runner
→ Evidence / deterministic Oracle / Report
```

Agent Pipeline 与 Acceptance Pipeline 在执行边界都传递同一个
`TEST_CASE_V2` 对象。Generator + Quality Gate 的输出不再先编译成
`TaskDef` / `LoadedCase`，也不经过 `LEGACY_EXECUTION`；旧 Test DSL 的独立调用方
仅保留在 Execution Tool 的隔离兼容边界，Agent Pipeline 不依赖该路径。

## Business Model Projection

`buildBusinessModelProjection()` 是现有 Requirement Model 的投影，不是第二套需求模型。Actor、Role、Resource、Ownership、Tenant、Project、State、Business Rule、Dependency、Risk 和 Business Flow 都保留原始 `factIds`、`sources`、`confidence`、`conflict` 与 `conflictReasons`。

资源归属使用 `ownerships[]` 表达完整多资源关系，Scope 使用 `scopes[]` 保留 USER/TENANT/PROJECT 等全部维度。兼容字段 `businessScenario.resourceContext` 与 `businessScenario.ownership` 仍存在，但新 Gate 与报告以复数关系为准。Business Scenario 的 Flow ID、资源、Actor 与风险来自 Projection，不再从 Requirement 文本二次猜测。

## V2 → Scenario Adapter

`adaptTestCaseV2ToScenario()` 只映射到既有 `Scenario` primitive：Operation、Capture、dependsOn、Assertion、EvidenceRequirement、TestData、Prepare/Cleanup 和 Contract Dependency。Runner 协议与核心执行循环未另建或替换。

- 多步骤与变量捕获：`TestStep.capture` 映射到 `ScenarioOperation.capture`，后续输入支持 `${...}` 和兼容 `{{...}}` 引用。
- Case Dependency：required `CASE` dependency 必须在 `availableDependencies` 中解析。
- API/UI/DATA/QUEUE/PROVIDER：按已注册 Processor 的 `supports()` 动态绑定。
- 并发：相同 `concurrencyGroup` 编译成一个普通 DATA Operation，由 `createConcurrentScenarioProcessor()` 并发调用 delegate；不修改 Runner 协议。
- Prepare/Cleanup：沿用 allowlisted hook map；Adapter 为成功 Hook 增加 Lifecycle Evidence，Runner 继续用 `finally` 执行 Cleanup。
- 生成与执行同一性：Reference E2E 对 Adapter 返回的 `testCase` 与
  Quality Gate 输出做对象级比较，阻止测试代码用手工 Scenario 替换生成 Case。

## 三层 Readiness

执行前解析 Executor、Processor、Observer、Hook、Environment、Test Data、Dependency 和 Preflight，并回写：

```text
readiness.generated
readiness.runtime
readiness.effective
```

生成期 `DESIGNED_ONLY / COMPOSITE_EXECUTION_REQUIRED` 不再是永久状态。Requirement 与确定性 Oracle 完整且运行时能力齐备时，Effective Readiness 自动升级为 `EXECUTABLE`；缺 Processor、Observer、Hook、Environment、Data 或 Dependency 时为 `BLOCKED`；需求结果未知或负向证明义务不完整时保持 `DESIGNED_ONLY`，实际 Runner 结果为 `NOT_EXECUTED`。这些状态均不得降级成 PASS。

HTTP、UI、DB/State、Log 和 Queue 都通过 Processor/Observer 的实际注册状态
解析，不使用生成期静态标签假定能力存在。部分 Case 真实执行时，
Pipeline 保留未执行 Case 的 `BLOCKED / DESIGNED_ONLY / NOT_EXECUTED`，不会用
已执行子集把整体冒充为全量已执行。

## Negative Oracle

负向写操作必须同时具备：

```text
Response + State Before + State After/Non-Mutation + Side Effect
```

Side Effect 可使用 EVENT、QUEUE_MESSAGE、PROVIDER_CALL、BILLING_RECORD、AUDIT_RECORD 或 LOG。缺少任一证明义务时，Adapter 的 `oracleVerdict` 为 `NOT_VERIFIED`，不会调度业务 Processor。

Acceptance Criterion 的可判定结果会绑定到具体 API Operation、State Before/After、
Non-Mutation 和 Side Effect Evidence Requirement。没有独立证明价值的
Contract-only / Parameter-only 候选 Case 由 Quality Gate 合并；无法合并且缺少
可观测 Oracle 的 Case 明确阻断，不以用例数换取覆盖率。

## Quality Gate 与 Report

Quality Gate 对 V2 Case 独立记录 `Traceable / Business Relevant / Executable / Deterministic / Evidence-backed / Non-duplicate`，并额外输出 Business Risk Deduplication、Scenario Coverage 和 Actor/Owner/Tenant/Resource Relationship 问题。

现有报告结构新增一级 `businessCoverage`：Business Flow、State、Permission、Isolation、Side Effect。每项分别给出 `GENERATED / EXECUTABLE / EXECUTED / VERIFIED`，不以生成数量冒充执行或验证覆盖。

## 回归入口

```bash
npx vitest run tests/acceptance/p0-business-model.test.ts
npx vitest run tests/acceptance/p0-v2-scenario-adapter.test.ts
npx vitest run tests/e2e/p0-reference-scenarios.test.ts
```
