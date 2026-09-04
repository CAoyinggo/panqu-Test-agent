# DevTest 通用测试流程 SOP

> 本文只定义需求驱动的通用测试流程，不绑定产品、项目、接口、页面、账号、字段、状态或技术实现。

## 1. 唯一标准链

```text
Requirement
→ Requirement Model / Fact Ledger
→ Business Model Projection
→ Business Understanding
→ Risk-driven Test Strategy
→ Business Scenario / Business Flow
→ Dynamic Test Dimension Selection
→ TEST_CASE_V2
→ Test Design Review / Quality Gate / Runtime Readiness
→ Scenario Adapter / Scenario Runner
→ Evidence / Deterministic Oracle
→ Report
```

`TestDesignAgent` 的默认 LLM 路径与确定性回退必须复用同一 canonical Requirement、Business Model、Test Strategy 和 Quality Gate。模型输出失败不能触发旧单功能或固定步骤模板。Agent Pipeline 直接将 `TEST_CASE_V2` 交给 Scenario Adapter 和 Runtime Readiness，不经过旧 Task 编译路径。

开发者入口：

```bash
npm run devtest -- <requirement-document>
```

外部编程助手使用[开发自测智能体 Prompt](prompts/dev-selftest-agent.prompt.md)；继续实现平台能力时使用[DevTest 持续优化 Prompt](prompts/devtest-implementation-agent.prompt.md)。两者都必须遵循本 SOP，不得另建生成协议。

设计结果不等于执行结果。只有真实 Operation 执行、Assertion 判定及 required Evidence 完整时，Case 才能进入 `PASS`。

## 2. 输入标准

Requirement 至少表达可获得的信息；缺失项必须进入 Unknowns，不能由模板补默认业务规则：

- 业务意图和可判定 Acceptance Criteria；
- Actor、Role、Tenant、Project、Resource、Owner；
- Business Flow、State、Business Rule、Dependency、Risk；
- Expected Response、Expected State、Expected Side Effect；
- 执行环境、测试数据来源和生命周期约束。

身份、环境地址、资源标识和凭据只保存运行时引用。模板不得嵌入真实值。

## 3. Business Model

Business Model 是 Requirement Model 的统一投影，不是独立需求协议。所有 Actor、Role、Resource、Ownership、Tenant、Project、State、Rule、Dependency、Risk 和 Flow 必须保留 Fact ID、Source、Confidence 与 Conflict。

Business Scenario 必须从该投影派生，完整保留多 Actor、多 Resource 和全部 Scope。不得只取第一个角色、资源或 Tenant/Project Scope。

生成前必须形成 Business Understanding，逐条回答：谁、对什么资源、在什么状态、执行什么操作、满足什么规则、产生什么结果、产生什么副作用。任何缺项进入 Unknowns，不能由经验默认值补齐。

## 4. 动态测试能力选择

先形成 Core Flow、High-risk Flow、Negative Flow、State、Permission、Isolation、Concurrency、Idempotency、Side Effect、Recovery 的结构化 Test Strategy，再选择测试能力。策略必须记录 Fact/Risk 依据和优先级；不适用项明确为 `NOT_APPLICABLE`。

测试维度是可选能力，不是功能模板：

| 能力 | 选择依据 |
| --- | --- |
| Functional | Requirement 声明业务结果或业务规则 |
| UI | Requirement 声明页面、交互或展示 |
| API | 存在可绑定 Operation Contract |
| Parameter Validation | 存在 required/type/format/enum 等约束 |
| Boundary | 存在 min/max/length/range 等边界 |
| Exception | 存在拒绝、错误或不可用路径 |
| Permission | 存在身份、角色、Owner 或授权规则 |
| Data Isolation | 存在 User/Tenant/Project Scope |
| State Transition | 存在 from/action/to 或禁止状态 |
| Data Consistency | 存在跨通道、跨资源或持久化一致性要求 |
| Idempotency | 存在重复提交、唯一结果或去重规则 |
| Concurrency | 存在竞争、并发写或原子性风险 |
| Side Effect | 存在消息、账务、库存、任务、审计或外部调用 |
| Failure Recovery | 存在回滚、补偿、重试或恢复要求 |
| Cross-Case Pollution | Case 会创建或修改共享状态 |

没有 Requirement、Business Model 或 Risk 触发信号的维度不得生成占位 Case。一个 Case 能证明多个义务时应合并，不为类型齐全重复执行。

## 5. TEST_CASE_V2 设计

每个 Case 使用[统一测试用例模板](02-测试用例模板.md)，至少包含 Requirement Trace、Business Scenario、Steps、Expected、Oracle、Evidence、Cleanup、Dependencies、Readiness 和 Unknowns。

生成阶段只能给出 `EXECUTABLE / DESIGNED_ONLY / BLOCKED`。运行阶段使用 `PASS / FAIL / BLOCKED / NOT_EXECUTED / TIMEOUT / CANCELLED`。不得在模板中预填运行结果。

## 6. Gate 与运行时

Quality Gate 必须验证：

- Traceable、Business Relevant、Executable、Deterministic、Evidence-backed、Non-duplicate；
- Actor/Owner/Tenant/Project/Resource 关系；
- Business Flow、State、Rule 和 Risk 覆盖；
- 没有项目、产品、单功能或固定实现泄漏；
- Negative Case 具备 Response、Expected State、Non-Mutation 和 Side Effect 证明。

Test Design Review 还必须检查 Requirement/Core Flow/Risk/Negative/State/Permission/Isolation/Side Effect 覆盖、Oracle/Evidence 完整度、UNKNOWN 安全处置，以及 Semantic/Business Duplicate。高价值组合场景可替代同一结论的低价值单步占位，但必须合并全部 trace。

执行前重新解析 Executor、Processor、Observer、Hook、Environment、Test Data 与 Dependency，形成 Generated、Runtime、Effective Readiness。能力不足必须 fail-close。

## 7. 生命周期与证据

Prepare、Operation 和 Cleanup 使用同一 execution context。Prepare 失败时不执行 Case；Cleanup 使用 finally 语义并产生 Evidence。Case 创建或修改的数据必须可归属、可识别、可清理，防止 Cross-Case Pollution。

Evidence 必须对应具体 Assertion 和 Fact。响应状态不能替代 State、DB、Diff、Log、Queue、Provider、Audit 或 Side Effect 观察。

## 8. 报告

报告必须分别呈现 `GENERATED / EXECUTABLE / EXECUTED / VERIFIED`，并提供 Business Flow、State、Permission、Isolation、Side Effect Coverage。缺少能力、未执行或证据不完整不得计入 VERIFIED。

## 9. 变更准入

标准文档、Schema、Generator、Execution Contract、Report 和回归测试必须同步修改。任何标准化违规均以 `STANDARDIZATION_VIOLATION` 阻断合入，而不是 warning。
