# DevTest TestCase V2 字段与生成规则

> 生成前的 Business Understanding、Risk-driven Test Strategy、Business Scenario 和生成后 Test Design Review 见 [test-design-intelligence.md](./test-design-intelligence.md)。这些能力只扩展现有生成链，不改变 TEST_CASE_V2 或 Scenario Runner 核心协议。

> P0 Runtime 补充：统一 Business Model Projection、V2→Scenario Adapter、Generated/Runtime/Effective Readiness、负向 Non-Mutation/Side Effect Oracle 以及五项业务覆盖，见 [devtest-p0-business-runtime.md](./devtest-p0-business-runtime.md)。

> **权威入口**：本文是 DevTest 自动生成 `TestCase` 的唯一字段和生成规则说明。代码类型以 [`src/agents/test-design/testcase-schema.ts`](../../src/agents/test-design/testcase-schema.ts) 为准；需要编辑 Markdown Scenario 资产时，使用 [`tests/acceptance/templates/scenario.md`](../../tests/acceptance/templates/scenario.md)。两者共用 canonical Scenario primitives，不是两套测试协议。

默认 Test Design 入口的 LLM 路径与确定性回退必须消费同一 canonical Business Model 和 Risk-driven Test Strategy；回退不得降级生成 Legacy Case。

DevTest 从 Requirement 生成 Case 时必须保留以下链路：

```text
Requirement / AC / Fact
→ Business Model（Actor / Resource / Ownership / Tenant / State / Permission / Dependency / Risk）
→ Business Scenario / Business Flow
→ Test Objective / Aspect / Executable Step
→ Execution Contract（Executor / Observer / Preflight / Lifecycle）
→ Deterministic Assertion / Oracle
→ Evidence Requirement
→ Runtime Evidence / Oracle / Readiness Write-back
→ Test Report
```

不允许以“用例已生成”代替“用例可执行”，也不允许以测试类型数量代替 Requirement Coverage。

## 1. 模型边界

### 1.1 TestCase 与 Scenario

- `TestCase` 是 Requirement Model 编译后的自动测试计划，也是 DevTest Runner 的输入。
- `Scenario` 是可以人工维护的 Acceptance 资产。
- V2 TestCase 复用 `ScenarioPrecondition`、`ScenarioTestData`、`ScenarioHook`、Operation/Assertion Channel 等 primitive；不再发明另一套 Prepare、Data 或 Evidence 协议。
- `data`、`preconditions`、`executionMode=DESCRIPTIVE_ONLY` 是兼容字段。新生成 Case 应同时产出对应的 V2 结构化字段，不得只填兼容文本。

### 1.2 设计态与运行态

`TestCase` 只声明设计态：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `requirementStatus` | `CONFIRMED` | Requirement/Contract 给出了可追溯、可判定的产品规则 |
| `requirementStatus` | `UNKNOWN` | 缺少 Actor、Action、Expected、Contract 或范围，不允许猜测 |
| `requirementStatus` | `NEED_CONFIRMATION` | 存在歧义或冲突，需要需求/契约确认 |
| `readiness.status` | `READY` | 执行契约、Oracle、Evidence、依赖与安全条件齐全 |
| `readiness.status` | `NEED_CONFIRMATION` | 设计可保留，但不允许进入确定性执行 |
| `readiness.status` | `BLOCKED` | 已知的能力、契约、数据、身份、Observer 或 SAFE Policy 缺口阻断执行 |
| `executionMode` | `EXECUTABLE` | 候选可执行；仍需通过 Preflight/Policy Gate |
| `executionMode` | `DESIGNED_ONLY` | 只有测试设计，不得产生 PASS/FAIL |

`BLOCKED`、`NOT_EXECUTED`、`PASS`、`FAIL`、`TIMEOUT`、`CANCELLED` 是一次 Runner 实例的运行结果。TestCase 中的 `readiness.status=BLOCKED` 会导致运行结果 `BLOCKED`，但作者不得在设计资产中预填 `PASS` 或 `FAIL`。

## 2. TestCase V2 顶层字段

`schemaVersion=TEST_CASE_V2` 表示新生成契约。类型中为了兼容 Legacy 而保留的可选字段，在 V2 生成链上可能仍是质量门禁必需项。

| 字段 | V2 要求 | 生成规则 |
| --- | --- | --- |
| `schemaVersion` | 必填 | 固定为 `TEST_CASE_V2` |
| `id` | 必填 | 基于执行语义稳定生成；不得使用数组下标或每次运行的随机值 |
| `feature` / `name` | 必填 | 人类可读的 Feature 与单一可判定测试意图 |
| `source.requirementId` | 必填 | 必须回链 Requirement；同时保留 AC、Fact、Objective、文档位置和 Contract 绑定 |
| `testType` | 必填 | 一个 Runner/报告主分类；不用它表达全部证明义务 |
| `testAspects` | 必填 | 一条 Case 可包含多个 Aspect；来自 Requirement/Risk/Contract 适用性判定 |
| `priority` | 必填 | `P0`~`P3`；由核心 AC、业务影响和风险确定，不按生成顺序确定 |
| `requirementStatus` | 必填 | `CONFIRMED / UNKNOWN / NEED_CONFIRMATION`；后两者不得被 LLM 补齐为产品规则 |
| `businessScenario` | 必填 | 结构化投影 Kind、Actors、Resource/Resource ID、Ownership/Tenant、State、Permission、Flow、业务 Dependency、Risk 与 Expected Business Outcome，并保留 provenance/Fact/AC |
| `actor` | 条件必填 | 需要鉴权、权限、租户/项目隔离时必须为可执行身份引用；不得写 Secret |
| `preconditions` | 兼容字段 | 人类可读摘要；不能代替 `preconditionPlan` |
| `preconditionPlan` | 必填 | 复用 `ScenarioPrecondition[]`，每项有 ID、kind、required 以及可检查 `checkRef`/证据引用 |
| `data` | 兼容字段 | Runner 已有的 key/value 输入；不能隐藏 owner、tenant、敏感性或 cleanup |
| `testData` | 条件必填 | 需要数据时复用 `ScenarioTestData[]`，声明来源、引用、owner、tenant、project、mutable、sensitive 和 cleanup hook |
| `steps` | 必填 | 按执行顺序声明稳定 ID、Channel、动作/精确绑定、依赖、AC 和 Fact；不允许只写自然语言步骤 |
| `expected` | 必填 | 分开 `response`、`state`、`sideEffects`；不得只写“结果正确” |
| `assertions` | 必填 | 每条有稳定 ID、target/operator/expected、Fact/AC 与 Evidence 引用；`DESIGN_EXPECTATION` 不是运行断言 |
| `oracle` | 必填 | 只组合确定性 assertions 与 required evidence；只允许 `deterministic=true`，LLM 不作为最终 Oracle |
| `evidenceRequirements` | 必填 | 执行前声明 Channel、Phase、Expectation、Fact、来源 Step 和断言引用 |
| `prepare` / `cleanup` | 条件必填 | 复用 allowlisted `ScenarioHook[]`；写操作和可变数据必须有可验证 cleanup，禁止嵌入任意脚本 |
| `dependencies` | 必填 | 声明 Environment、Contract、Identity、Test Data、Observer、Lifecycle、Case 依赖及解析状态 |
| `executionContract` | 必填 | 声明 Executor、Observer、Preflight 与 Lifecycle Hook；是“如何执行/观察”的权威能力契约 |
| `contractDependencies` | 条件必填 | 涉及 API/UI 契约时保留版本、Fingerprint 和解析结果；字面 URL 不取代 Contract |
| `tags` | 必填 | 仅用于搜索、选择和报告；Tag 不证明覆盖、可执行或已验证 |
| `readiness` | 必填 | 输出 `READY / BLOCKED / NEED_CONFIRMATION`、具体 reasons 和 missingCapabilities |
| `executionMode` | 必填 | V2 只生成 `EXECUTABLE` 或 `DESIGNED_ONLY`；`DESCRIPTIVE_ONLY` 只供 Legacy 兼容 |

## 3. 关键字段规则

### 3.1 Source 与 Requirement Trace

`source` 至少包含：

```text
requirementId
testPointId
acceptanceCriteriaIds[]
factIds[]
objectiveIds[]
sourceType
provenance
```

有 API 契约时还应声明 `apiSpecId`、`apiOperationKey`、`contractRef`、`contractVersion`、`contractFingerprint`。只有 Case 级回链不够；每个决定结果的 Step、Assertion 和 Evidence 也必须回链 Fact/AC。

多 Fact Case 必须分别提供断言和证据。Case PASS 不等于它引用的所有 Fact 都已验证；只有被实际执行断言观测到的 Fact 才能进入 Verified Requirement Coverage。

### 3.2 Test Type 与 Test Aspects

`testType` 是单值主分类：

```text
FUNCTIONAL | API | UI | PARAMETER | AUTH | PERMISSION | DATA_ISOLATION
| BUSINESS_RULE | STATE | ERROR | BOUNDARY | SECURITY | COMPATIBILITY
| PERFORMANCE | SIDE_EFFECT | CLEANUP | HYBRID
```

`testAspects` 是多值证明义务：

```text
UI_INTERACTION | CORE_FUNCTION | API_CONTRACT
PARAMETER_REQUIRED | PARAMETER_NULL | PARAMETER_TYPE | PARAMETER_FORMAT
BOUNDARY_VALUE | NEGATIVE_PATH | AUTHENTICATION | ROLE_PERMISSION
USER_ISOLATION | TENANT_ISOLATION | PROJECT_ISOLATION
STATE_TRANSITION | DATA_CONSISTENCY | IDEMPOTENCY | DUPLICATE_SUBMISSION
CONCURRENCY | FRONTEND_BACKEND_CONSISTENCY | SIDE_EFFECT
CROSS_CASE_SIDE_EFFECT | PRE_POST_CONDITION | ROLLBACK_RECOVERY
```

同一次请求如果能以相同的 Actor、Data、Steps、Oracle 和 Evidence 验证多个 Aspect，应合并为一条 Case 并合并 Fact/Objective/Evidence trace。不得为每个 Aspect 复制一条相同请求。
反过来，Aspect 只能在 Case 中存在对应 Assertion/Evidence 证明义务时声明；不得因为“写请求可能有副作用”就标记已覆盖 `SIDE_EFFECT`。

### 3.3 Business Scenario

`businessScenario` 回答：谁在什么业务上下文中，对什么资源做什么，为了什么结果。它必须包含 `provenance`、`factIds`、`acceptanceCriteriaIds`，不是 LLM 自由编写的测试背景。

| 字段 | 用途 | 生成与 fail-close 规则 |
| --- | --- | --- |
| `kind` | 场景主语义 | `CORE_FLOW / STATE_TRANSITION / PERMISSION / DATA_ISOLATION / RESOURCE_OWNERSHIP / PARAMETER_RULE / IDEMPOTENCY / CONCURRENCY / RECOVERY / CONSISTENCY / SIDE_EFFECT / UNKNOWN`；不得仅作报告标签，必须能映射到 Flow、Assertion 与 Evidence |
| `actors[]` | 业务参与者关系 | 用 `SUBJECT / OWNER / TARGET / OTHER_USER / OTHER_TENANT` 分离执行者、资源所有者和目标；需要第二身份而无法解析时阻断 |
| `resourceContext` | 资源类型和实例关联 | `type` 必填；组合流程需要可捕获/可预检的 `idRef`，禁止把 Actor ID 当成 Resource ID |
| `ownership` | 数据归属与租户/项目边界 | `SELF / OTHER_USER / SAME_TENANT / CROSS_TENANT / SHARED / SYSTEM / UNKNOWN / NOT_APPLICABLE`；隔离场景不得默认资源属于当前 Actor |
| `state` | 前态、终态、禁止状态和状态规则 | `status=KNOWN` 时可提供 `before/after/forbidden/expression`；规则缺失时必须为 `UNKNOWN`，不得补成常见状态机 |
| `permission` | Subject 对 Action/Resource 的授权结果 | 声明 `ALLOW / DENY / UNKNOWN / NOT_APPLICABLE`、role、action、scope；未知时禁止默认 200、401 或 403 |
| `flow` | 有序、并行或跨主体业务过程 | 由稳定 Flow ID、mode 和步骤组成；步骤声明 action、actorRef、resourceRef、operationRef、from/to state、dependsOn |
| `dependencies[]` | 业务依赖 | 只记录 Requirement/Contract 中识别出的上游业务条件；Environment/Observer/Lifecycle 能力放顶层 `dependencies` 与 `executionContract` |
| `risks[]` | 风险驱动的场景选择 | 保存 P0~P3、风险类别、描述和来源；用于决定组合深度与执行优先级，不按风险标签机械扩增 Case |

`flow.mode` 支持：

```text
SINGLE_OPERATION | SEQUENCE | PARALLEL | CROSS_ACTOR | CROSS_TENANT | RECOVERY
```

- `provenance=EXPLICIT/CONTRACT/CONFIGURED` 可在来源充分时进入确定性设计。
- `provenance=INFERRED/UNKNOWN` 必须保留为推导/未知，不得伪装为 Requirement Fact。
- `epistemicType=INFERENCE` 即使原文 provenance 被标为 `EXPLICIT`，也只能生成 HEURISTIC / `DESIGNED_ONLY`，直到获得可验证来源。
- 任一决定结果的 Actor、Resource ID、Ownership、Tenant、State、Permission 或 Flow 规则为 `UNKNOWN` 时，必须沿链路传播到 `requirementStatus=UNKNOWN/NEED_CONFIRMATION`、`oracle.status=NEED_CONFIRMATION`、`readiness.status=NEED_CONFIRMATION` 和 `executionMode=DESIGNED_ONLY`。

### 3.4 Execution Contract

`executionContract` 明确 Case 是否拥有真实的执行和观测路径：

| 结构 | 必须说明 | fail-close 规则 |
| --- | --- | --- |
| `executor` | `kind/ref/status/supports`；Kind 为 `HTTP / BROWSER / DATA / COMPOSITE / FUNCTIONAL / NONE` | required Flow/Channel 不在 `supports`、状态为 `RUNTIME_REQUIRED/UNAVAILABLE` 或实际未调用时，不得执行或 PASS |
| `observers[]` | 每个非响应 Evidence 的 channel、ref、phase、required、status | required Observer 未注册、未调用或未产生可验证 Artifact 时，Case 必须 BLOCKED，已执行操作也不能 PASS |
| `preflight[]` | Environment、Contract、Identity、Resource、State、Dependency 的检查引用 | required 检查必须在 Prepare 和被测副作用之前完成；路径、资源、身份或状态不存在时禁止继续 |
| `lifecycleHooks[]` | Prepare/Cleanup Hook 及是否要求证据 | required Hook 必须来自 allowlist；Hook 未注册、未执行或缺证据时阻断，Cleanup 失败单独报告 |

Executor/Observer 的 `AVAILABLE` 表示实现已注册，不表示本次运行已经成功调用；运行时仍需完成 Preflight 和 Policy Gate。设计态为 `RUNTIME_REQUIRED` 时不得提前写成 READY，只有实际 Resolver 将能力解析为可用后，运行实例才能进入执行。

### 3.5 Preconditions 与 Test Data

`preconditions[]` 仅用于报告摘要。`preconditionPlan[]` 中的 required 条件必须有可执行 `checkRef` 或可关联 Evidence；无法检查时必须 `NEED_CONFIRMATION/BLOCKED`。

`data` 是现有 Runner 参数视图，`testData[]` 是数据生命周期的权威视图。对可变数据至少声明：

```text
id / source / value|valueRef / resourceType / resourceOwnerId
tenantId / projectId / mutable / sensitive / cleanupHookId
```

`data` 与 `testData` 不得冲突。涉及 User/Tenant/Project/Owner 隔离的 Case，如果无法确定数据归属，必须阻断，不得默认为当前 Actor。

### 3.6 Steps

每个 Step 必须具备：

- Case 内稳定 `id`；
- `channel`：`API / UI / DATA / QUEUE / PROVIDER / FUNCTIONAL`；
- 可执行 `action` 或精确 `HTTP_REQUEST` 绑定；
- `execution=EXECUTABLE`，或显式 `PLANNED` 并使 Case 不就绪；
- 必要的 `dependsOn`、AC 和 Fact 引用。

API Step 必须唯一绑定 Method + URL/Contract Operation；UI Step 必须绑定可确定定位的页面与操作；其他 Channel 必须有注册 Processor/Observer。“调用相关接口”、“查看页面”、“验证数据”不是可执行 Step。

### 3.7 Expected、Assertions 与 Oracle

`expected` 必须按业务语义分层：

- `response`：Status、Schema、错误码、关键字段；
- `state`：`PRESENT / UNCHANGED / CHANGED / CONSISTENT / UNKNOWN`；
- `sideEffects`：每个账单、任务、事件、队列、Provider、Audit 副作用的 `REQUIRED / FORBIDDEN / UNCHANGED / UNKNOWN`。

`expected.*=UNKNOWN` 表示没有确定性 Oracle，不得自动转成“常见行为”。对应 `requirementStatus` 必须为 `UNKNOWN/NEED_CONFIRMATION`，`oracle.status` 必须为 `BLOCKED/NEED_CONFIRMATION`。

`oracle` 只引用确定性断言和必需证据：

```text
Requirement + Contract + Invariant + Observed State + Baseline
→ Expected vs Actual
→ PASS / FAIL / BLOCKED / UNKNOWN
```

LLM 可以解释差异、提供归因候选，不能单独决定 PASS/FAIL。零断言、只有 `DESIGN_EXPECTATION`、断言无 Fact trace 或断言无对应 Evidence 时，`oracle.status` 必须阻断。

### 3.8 Evidence Requirements

每个 Evidence Requirement 至少声明：

```text
id / channel / phase / required / expectation / description
factIds[] / sourceStepId / assertionIds[]
```

Channel 支持：

```text
API_REQUEST | API_RESPONSE | UI_STATE | UI_SCREENSHOT
DATABASE_STATE | LOG | STATE_CHANGE | DATA_DIFF | LIFECYCLE_HOOK
```

Phase 为 `BEFORE / DURING / AFTER`，Expectation 为 `PRESENT / UNCHANGED / CHANGED / CONSISTENT`。`required=true` 的证据缺失、未验证或语义不满足时不得 PASS。例如 403 断言通过，但 `DATA_DIFF/UNCHANGED` 显示数据已变化，Oracle 必须 FAIL。

证据规划属于执行语义：Evidence Requirement 的 Channel、Phase、Expectation 或 Fact 改变时，Case execution-plan identity 也必须改变。语义重复 Case 合并时必须保留 Evidence Requirements 并集。

### 3.9 Lifecycle、Dependencies、Readiness 与运行时回写

Prepare/Cleanup 只能引用 Runner allowlist 中的 hook handler，必须在任何 Prepare 之前完成 Requirement、Scenario、Contract 和 Policy Gate。Cleanup 必须在 `finally` 语义执行；失败必须产生 `CLEANUP_FAILED`，不能被吞掉，也不能覆盖原始产品结果。

required Dependency 的 `resolution=UNRESOLVED`、必需 Precondition 无检查、Step 不可绑定、Oracle 不就绪、required Evidence 无 Observer、写操作无 Cleanup、SAFE Policy 不允许时，统一记入：

```text
readiness.status = BLOCKED
readiness.reasons += <typed reason>
readiness.missingCapabilities += <capability>
executionMode = DESIGNED_ONLY
```

不得使用默认值、fallback Processor、异常吞掉或“待人工”将不可执行 Case 伪装为 READY。

设计态 Case 声明 required Evidence 与候选 Readiness；运行态必须按稳定 ID 回写到 Report/Run Projection，而不是篡改 Requirement 来源：

1. Preflight 逐项记录 executor、observer、identity、resource、state、dependency 的解析结果，并据此重新计算运行态 Readiness。
2. 每个采集物必须回链 `caseId + stepId + evidenceRequirementId + assertionId + runId`，并记录采集时间、来源、校验和与脱敏状态。
3. Oracle 只消费本次运行已验证的 Evidence；required Evidence 缺失为 `BLOCKED/NOT_EXECUTED`，证据存在但语义不满足为 `FAIL`。
4. Prepare/Cleanup 必须产生 `LIFECYCLE_HOOK` 证据；Cleanup 失败不能覆盖原始产品断言结果，但必须阻止无条件 PASS，并进入报告 Gap/Risk。
5. 报告必须区分 `GENERATED / EXECUTED / VERIFIED`；设计态 READY、报告生成成功或存在截图均不能提升为 VERIFIED。

## 4. 动态选择与生成

### 4.1 只生成适用的测试

Test Type/Aspect 由 Requirement Fact、Contract、Invariant、Risk 和历史信号动态选择：

1. 先对每个 Dimension 计算 `REQUIRED / OPTIONAL / NOT_APPLICABLE / UNKNOWN`。
2. `REQUIRED` 必须有 Case 或显式 Blocked Gap。
3. `OPTIONAL` 只在价值/风险足够时选择。
4. `NOT_APPLICABLE` 不生成占位 Case。
5. `UNKNOWN` 输出 Requirement Gap 或 `NEED_CONFIRMATION`，不猜测业务规则。

默认不机械生成所有 Type/Aspect，不为了“五维齐全”或 Coverage 数字增加重复请求。UI、Billing、Provider、Concurrency 等高成本/高副作用测试只在 Requirement/Risk 适用且 SAFE 条件齐备时执行。

### 4.2 高价值 Negative 选择

负向向量只在存在对应契约或业务风险时生成：

```text
Missing Required Field / Wrong Type / Invalid Format / Boundary
Unauthorized / Wrong Role / Cross User / Cross Tenant / Cross Project
Duplicate Request / Replay / Retry / Concurrent Request
Invalid State / Stale Resource / Failure Non-Mutation
```

每个负向 Case 必须有明确 Expected Response，且根据风险附加 Expected State/Side Effect。例如“返回 403”不足以验证拒绝写入，必须附加 Non-Mutation 断言和 before/after Evidence。

### 4.3 风险驱动的组合场景

高风险业务不能只生成单请求参数排列。生成器必须先识别：

```text
Actor → Resource / Resource ID → Business Flow → State
→ Permission → Ownership / Tenant → Dependency → Risk
```

再根据已确认事实构造最小但完整的组合 Flow：

| 组合 | 必须证明的业务语义 |
| --- | --- |
| 创建 → 支付 → 重复支付 | 同一订单/幂等键关联；只产生一次支付实体与账务副作用 |
| 创建 → 取消 → 再次支付 | 取消后的状态规则、再次支付响应、订单与账务最终状态 |
| 用户 A 创建 → 用户 B 访问 | Subject/Owner 分离；读、改、删的授权结果及无泄露/无写入 |
| 租户 A 创建 → 租户 B 查询 | Tenant/Resource ID 关联；列表与详情均无跨租户泄露 |
| 处理中 → 并发修改 | 并发组/屏障、冲突响应、唯一终态与数据一致性 |
| 删除 → 查询 → 恢复 | 删除可见性、恢复前置状态、恢复后资源和关联数据完整性 |
| 调用失败 → 重试/恢复 | 失败响应、本地回滚、外部副作用次数和恢复终态 |

组合 Flow 的每一步必须具有稳定 Step ID、明确 actorRef/resourceRef/operationRef、`dependsOn` 或 `concurrencyGroup`、Expected Response/State/Side Effect，以及相应 Oracle/Evidence。前一步产生的 Resource ID 必须显式 capture 后供后续步骤引用，禁止依赖隐式全局变量。

组合数量以风险和独立证明义务为依据：P0/P1 及资损、越权、数据损坏、并发、恢复风险优先；相同执行语义应合并。若 Requirement/Contract 未定义取消后能否支付、重复请求结果、冲突策略、恢复规则等预期，只能生成 `UNKNOWN` 风险设计并标记 `NEED_CONFIRMATION / DESIGNED_ONLY`，不得使用行业惯例补齐。

若当前 Executor 不支持多 Step、capture、并发或多 Channel Observer，仍应保留结构化 Flow，但必须将 Executor 标为 `RUNTIME_REQUIRED/UNAVAILABLE`，并使 Readiness/Oracle fail-close。

### 4.4 去重与执行优先级

- 去重基于 Actor、Operation、Input、Expected、Assertions、Evidence 和 Lifecycle 的执行语义，不基于 Case 名称。
- 合并后必须保留 AC/Fact/Objective、Aspect、Assertion 和 Evidence 并集。
- 优先级顺序为 Core/P0 → 高风险 SAFE → P1 → 边界/深度 Case。
- 默认执行 Tier 0 + Tier 1；P0/P1 核心组合不能仅因其是多步骤而降到 `--deep`，只有低风险、高成本扩展组合才由 `--deep` 选择。

## 5. 真实场景适用矩阵

| 场景/触发信号 | 建议 Test Type | 必需 Aspects | 最小 Oracle / Evidence | 安全与就绪条件 |
| --- | --- | --- | --- | --- |
| CRUD 新增/更新/删除 | `API` / `FUNCTIONAL` | `CORE_FUNCTION`, `API_CONTRACT`；需求明示前后状态/副作用时再加 `PRE_POST_CONDITION` / `SIDE_EFFECT` | 响应契约；若要声称持久化或删除语义，必须独立状态读回 | 精确 Contract、隔离数据、Cleanup；无 Observer 不得声称状态已验证 |
| UI 功能与前后端结果 | `UI` / `HYBRID` | `UI_INTERACTION`, `FRONTEND_BACKEND_CONSISTENCY` | UI state/screenshot + API/Data 独立观测 | 页面 URL、稳定 locator、测试身份已绑定 |
| 必填、类型、格式、边界 | `PARAMETER` / `BOUNDARY` | 对应 `PARAMETER_*`, `BOUNDARY_VALUE`, `NEGATIVE_PATH` | 明确契约来源 + 精确响应；Requirement/Invariant 明示失败无写入时再加 Non-Mutation | 无契约边界时保持 UNKNOWN，不自行设阈值 |
| 未登录/角色越权 | `AUTH` / `PERMISSION` | `AUTHENTICATION`, `ROLE_PERMISSION`, `NEGATIVE_PATH`, `PRE_POST_CONDITION` | 401/403 + before/after 不变 + 无隐藏副作用 | 可执行 Actor/credential ref 和 target owner |
| Cross User/Tenant/Project | `DATA_ISOLATION` | 对应 `*_ISOLATION`, `ROLE_PERMISSION`, `PRE_POST_CONDITION` | List/Detail/Update/Delete 的 Access Matrix + 无泄露/无污染 | 至少两个明确 Actor/scope 和归属数据 |
| 创建/提交/支付/发送/任务生成 | `BUSINESS_RULE` / `SIDE_EFFECT` | `IDEMPOTENCY`, `DUPLICATE_SUBMISSION`；有风险时加 `CONCURRENCY` | 首次、重复、响应丢失后重试的实体/副作用次数 | 无幂等键、隔离资源或并发屏障时 BLOCKED |
| 异步任务/状态机 | `STATE` | `STATE_TRANSITION`, `DATA_CONSISTENCY` | 相同 Resource ID 的前态、转移、终态与非法转移 | 多个 Resource ID 无法关联时 BLOCKED，不得报 INCONSISTENT |
| 失败后隐藏副作用 | `SIDE_EFFECT` / `BUSINESS_RULE` | `NEGATIVE_PATH`, `SIDE_EFFECT`, `ROLLBACK_RECOVERY`, `PRE_POST_CONDITION` | 失败 Response + DB/Task/Billing/Queue/Provider/Audit before/after | 高成本 Provider/Billing 默认不真实触发，无 sandbox/observer 时 BLOCKED |
| 多表/多资源同成同败 | `BUSINESS_RULE` / `HYBRID` | `DATA_CONSISTENCY`, `ROLLBACK_RECOVERY` | 同一相关 ID 下的所有参与项 before/after 与 rollback | 必须有稳定相关键和独立 Observer |
| Cross-Case 共享状态/顺序依赖 | `CLEANUP` / `SIDE_EFFECT` | `CROSS_CASE_SIDE_EFFECT`, `PRE_POST_CONDITION` | Case A cleanup 后快照 vs Case B 开始前快照 | 共享用户/资源/租户/状态机必须串行或隔离 |
| 修复后回归 | 复用原 Case | 保留原 Aspects，不生成平行“修复 Case” | 原 Minimal Repro + 同一 Oracle/Evidence + Baseline 对比 | 同 Problem ID 进入 FIXED/REGRESSION/REOPENED 生命周期 |
| Flaky/Test Pollution 信号 | 原 Type + `CLEANUP` | `CROSS_CASE_SIDE_EFFECT`, `PRE_POST_CONDITION` | 重复运行、运行前后快照、依赖/副作用对比 | 不得直接归类 PRODUCT_BUG；先区分环境、污染和产品回归 |

## 6. 最小 V2 示例：403 且数据不可修改

下例展示目标字段关系。当前单 HTTP Processor 不能采集 `DATA_DIFF` 或执行状态断言，因此实际生成时必须保持 `BLOCKED / DESIGNED_ONLY`；只有多 Channel Scenario Processor、Observer 与 Cleanup Resolver 真正接入后，才可编译为 `READY / EXECUTABLE`。

```yaml
schemaVersion: TEST_CASE_V2
id: CASE-AC-003-CROSS-TENANT-UPDATE
feature: Resource Update
name: Tenant B 不能修改 Tenant A 的资源
priority: P0
testType: DATA_ISOLATION
testAspects: [TENANT_ISOLATION, ROLE_PERMISSION, NEGATIVE_PATH, PRE_POST_CONDITION]
requirementStatus: CONFIRMED
businessScenario:
  title: Cross-tenant update denial
  goal: 阻止其他租户修改资源
  actor: tenant-b-user
  action: UPDATE
  resource: RESOURCE
  kind: DATA_ISOLATION
  actors:
    - {id: tenant-b-user, role: USER, tenantId: tenant-b, relation: SUBJECT, provenance: CONFIGURED}
    - {id: tenant-a-user, role: USER, tenantId: tenant-a, relation: OWNER, provenance: CONFIGURED}
  resourceContext: {type: RESOURCE, idRef: fixture.resourceA.id, provenance: EXPLICIT}
  ownership: {relation: CROSS_TENANT, ownerActorId: tenant-a-user, tenantId: tenant-a, provenance: EXPLICIT}
  state:
    status: KNOWN
    before: ACTIVE
    after: ACTIVE
    expression: denied update keeps resource unchanged
    provenance: EXPLICIT
  permission: {decision: DENY, role: USER, action: UPDATE, scope: TENANT:CROSS, provenance: EXPLICIT}
  flow:
    id: FLOW-CROSS-TENANT-UPDATE
    name: Tenant B attempts to update Tenant A resource
    mode: CROSS_TENANT
    steps:
      - id: STEP-DENY-UPDATE
        action: UPDATE
        actorRef: tenant-b-user
        resourceRef: fixture.resourceA.id
        operationRef: <operation-contract-ref>
        fromState: ACTIVE
        toState: ACTIVE
        dependsOn: []
  dependencies: [Tenant A resource fixture]
  risks:
    - {id: RISK-CROSS-TENANT-WRITE, level: P0, category: SECURITY, description: 跨租户越权写入与数据污染, source: REQUIREMENT}
  expectedBusinessOutcome: 返回 403 且资源与副作用不变
  provenance: EXPLICIT
  factIds: [FACT-003]
  acceptanceCriteriaIds: [AC-003]
source:
  requirementId: REQ-RESOURCE-UPDATE
  testPointId: TP-003
  acceptanceCriteriaIds: [AC-003]
  factIds: [FACT-003]
  objectiveIds: [OBJ-PERMISSION, OBJ-NON-MUTATION]
  sourceType: REQUIREMENT
  provenance: EXPLICIT
actor:
  id: tenant-b-user
  tenantId: tenant-b
  tokenRef: TENANT_B_TOKEN
  provenance: CONFIGURED
preconditions:
  - Tenant A 资源存在，Tenant B 用户已鉴权
preconditionPlan:
  - id: PRE-RESOURCE
    kind: DATA
    description: Tenant A 资源存在且归属已验证
    required: true
    checkRef: observer.resource-owner
data:
  targetId: resource-a-1
testData:
  - id: TARGET
    source: FIXTURE
    valueRef: fixture.resourceA
    resourceType: RESOURCE
    resourceOwnerId: tenant-a-user
    tenantId: tenant-a
    mutable: true
    sensitive: false
    cleanupHookId: CLEANUP-001
steps:
  - id: STEP-DENY-UPDATE
    channel: API
    type: HTTP_REQUEST
    action: update-resource
    method: PATCH
    url: /api/resources/${targetId}
    body: {name: forbidden-change}
    execution: PLANNED
    acceptanceCriteriaIds: [AC-003]
    factIds: [FACT-003]
expected:
  response: {status: 403}
  state: {expectation: UNCHANGED, description: 资源内容与 owner 不变}
  sideEffects:
    - {kind: AUDIT_WRITE_AS_OWNER, action: CREATE, description: 不得记录为 Tenant A 的成功修改, expectation: FORBIDDEN}
assertions:
  - id: ASSERT-403
    channel: RESPONSE
    type: STATUS_CODE
    expected: 403
    factIds: [FACT-003]
    acceptanceCriteriaIds: [AC-003]
    evidenceRequirementIds: [EV-RESPONSE]
  - id: ASSERT-NON-MUTATION
    channel: STATE
    target: custom
    path: resourceDiff
    operator: deepEquals
    expected: {}
    factIds: [FACT-003]
    acceptanceCriteriaIds: [AC-003]
    evidenceRequirementIds: [EV-BEFORE, EV-DIFF]
evidenceRequirements:
  - {id: EV-BEFORE, channel: DATABASE_STATE, phase: BEFORE, required: true, expectation: PRESENT, description: Observer 在操作前采集资源快照与归属, factIds: [FACT-003], sourceStepId: STEP-DENY-UPDATE, assertionIds: [ASSERT-NON-MUTATION]}
  - {id: EV-REQUEST, channel: API_REQUEST, phase: DURING, required: true, expectation: PRESENT, description: 已脱敏请求与 Actor, factIds: [FACT-003], sourceStepId: STEP-DENY-UPDATE, assertionIds: []}
  - {id: EV-RESPONSE, channel: API_RESPONSE, phase: AFTER, required: true, expectation: PRESENT, description: 真实 403 响应, factIds: [FACT-003], sourceStepId: STEP-DENY-UPDATE, assertionIds: [ASSERT-403]}
  - {id: EV-DIFF, channel: DATA_DIFF, phase: AFTER, required: true, expectation: UNCHANGED, description: Observer 比较资源 before/after 无差异, factIds: [FACT-003], sourceStepId: STEP-DENY-UPDATE, assertionIds: [ASSERT-NON-MUTATION]}
oracle:
  mode: ALL
  deterministic: true
  status: BLOCKED
  assertionIds: [ASSERT-403, ASSERT-NON-MUTATION]
  evidenceRequirementIds: [EV-BEFORE, EV-REQUEST, EV-RESPONSE, EV-DIFF]
prepare: []
cleanup:
  - id: CLEANUP-001
    phase: CLEANUP
    handler: runtime.caseCleanup
    input: {caseRef: SELF}
    required: true
    produces: [cleanupStatus, afterCleanupSnapshot]
dependencies:
  - {id: DEP-ACTOR, kind: IDENTITY, ref: TENANT_B_TOKEN, description: Tenant B 测试身份, required: true, resolution: RUNTIME_REQUIRED}
  - {id: DEP-OBSERVER, kind: OBSERVER, ref: observer.resource-snapshot, description: 独立资源观测器, required: true, resolution: STATIC}
  - {id: DEP-CLEANUP, kind: LIFECYCLE, ref: runtime.caseCleanup, description: 若越权修改实际发生则恢复隔离资源, required: true, resolution: RUNTIME_REQUIRED}
executionContract:
  executor:
    kind: COMPOSITE
    ref: acceptance.scenarioRunner
    status: UNAVAILABLE
    supports: ['<operation-contract-ref>', DATABASE_STATE, DATA_DIFF]
  observers:
    - {channel: DATABASE_STATE, ref: observer.resource-snapshot, phase: BEFORE, required: true, status: RUNTIME_REQUIRED}
    - {channel: DATA_DIFF, ref: observer.resource-snapshot, phase: AFTER, required: true, status: RUNTIME_REQUIRED}
  preflight:
    - {kind: ENVIRONMENT, ref: runtime.baseUrl, required: true}
    - {kind: CONTRACT, ref: resource-update, required: true}
    - {kind: IDENTITY, ref: TENANT_B_TOKEN, required: true}
    - {kind: RESOURCE, ref: fixture.resourceA.id, required: true}
    - {kind: STATE, ref: observer.resource-state, required: true}
  lifecycleHooks:
    - {phase: CLEANUP, hookId: CLEANUP-001, required: true, evidenceRequired: true}
contractDependencies:
  - {contractId: resource-update, version: v1, fingerprint: sha256:example, required: true}
tags: [core, permission, tenant-isolation, non-mutation]
readiness: {status: BLOCKED, reasons: [COMPOSITE_EXECUTOR_UNAVAILABLE, MISSING_STATE_OBSERVER], missingCapabilities: [acceptance.scenarioRunner, observer.resource-snapshot]}
executionMode: DESIGNED_ONLY
```

## 7. PASS 的最小条件

```text
requirementStatus = CONFIRMED
AND readiness.status = READY
AND executionMode = EXECUTABLE
AND executed = true
AND processorInvoked = true
AND deterministic assertions >= 1
AND all deterministic assertions passed
AND all required evidence present and verified
AND all evidence semantic expectations satisfied
AND no unresolved required dependency
```

任一条件不满足时必须输出 `BLOCKED / NOT_EXECUTED / UNKNOWN / FAIL` 中的真实状态，不得 fallback 为 PASS。Requirement Coverage 也必须分开 `GENERATED / EXECUTED / VERIFIED`。

## 8. Legacy 边界

任何非 TEST_CASE_V2 输入都必须先转换为 Requirement Fact、Business Scenario、可执行 Step、Oracle、Evidence 与 Readiness；非标准输入不能直接进入当前 DevTest 主链。
