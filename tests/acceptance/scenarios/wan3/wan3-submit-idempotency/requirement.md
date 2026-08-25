# Scenario

## Scenario ID

SCN-wan3-submit-idempotency

## Requirement

- Source: Wan3 当前需求意图，尚未提供幂等与观测合约
- Intent: 同一调用方以同一幂等身份重复提交时，只创建一个业务任务、一次 Provider 工作和一次业务扣费。

## Acceptance Criteria

### AC-001

幂等键的载体、作用域、有效期和重复响应语义必须由权威 API 合约定义。

### AC-002

首次提交与重复提交最终关联同一个业务任务，任务总数严格为 1。

### AC-003

同一幂等作用域内 Provider 调用次数和业务扣费次数均严格为 1。

## Priority

P0

## Patterns

- IDEMPOTENCY
- BILLING
- PROVIDER_FAILURE

## Actor

- Type: USER
- ID: ${WAN3_ACTOR_ID}

## Role

UNRESOLVED_CONTRACT

## Tenant

- ID: ${WAN3_TENANT_ID}

## Project

- ID: ${WAN3_PROJECT_ID}

## Authentication

- Type: TOKEN
- Reference: ${WAN3_ACTOR_TOKEN_REF}

## Preconditions

| ID | Condition | Evidence Channel |
| --- | --- | --- |
| PRE-001 | 发布的 API 合约定义幂等键位置、作用域、TTL 和重复响应 | SYSTEM |
| PRE-002 | 任务观察器能按幂等身份统计业务任务 | STATE |
| PRE-003 | Provider 与账务观察器能按同一 correlation ID 统计调用和扣费 | SIDE_EFFECT |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | ${WAN3_ACTOR_ID} | `<contract-valid-request>` | configuration |
| DATA-002 | ${WAN3_ACTOR_ID} | `<contract-valid-idempotency-identity>` | generated |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | API | - | - | - | - | - | AC-001, AC-002 | EV-001 |
| STEP-002 | API | - | - | - | - | - | AC-001, AC-002 | EV-002 |
| STEP-003 | DATA | - | - | - | - | - | AC-002 | EV-003 |
| STEP-004 | PROVIDER | - | - | - | - | - | AC-003 | EV-004 |
| STEP-005 | DATA | - | - | - | - | - | AC-003 | EV-005 |

## Execution Steps

1. STEP-001：使用权威合约定义的幂等身份提交一次请求并保存业务标识。
2. STEP-002：在同一作用域内原样重放该请求与幂等身份。
3. STEP-003：查询任务观察器并按幂等身份统计任务。
4. STEP-004：查询 Provider 调用观察器。
5. STEP-005：查询账务流水观察器。

## Expected Response

- 首次和重复响应必须遵循已发布的幂等响应合约；当前不猜测状态码或响应字段。
- 两次响应必须可确定性关联同一业务任务。

## Expected State

- 同一幂等身份下业务任务数量为 1。
- 重放不得创建第二个任务记录或覆盖不相关任务。

## Expected Side Effects

- REQUIRED: Provider 调用次数为 1，业务扣费次数为 1。
- FORBIDDEN: 不得产生重复任务、重复 Provider 调用或重复扣费。

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-001 | SYSTEM | contract.idempotencySemantics | EXISTS | - | - |
| AS-002 | AC-002 | STEP-002 | RESPONSE | businessTaskIdentity | EQUALS | - | STEP-001.businessTaskIdentity |
| AS-003 | AC-002 | STEP-003 | STATE | taskCount | COUNT_EQUALS | 1 | - |
| AS-004 | AC-003 | STEP-004 | SIDE_EFFECT | providerCallCount | COUNT_EQUALS | 1 | - |
| AS-005 | AC-003 | STEP-005 | SIDE_EFFECT | chargeCount | COUNT_EQUALS | 1 | - |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-000 | STATE_BEFORE | STATE | UNRESOLVED-IDEMPOTENCY-BASELINE | AS-003, AS-004, AS-005 | 首次提交前的任务、Provider 与账务计数基线 |
| EV-001 | RESPONSE | RESPONSE | UNRESOLVED-FIRST-SUBMIT | AS-001, AS-002 | 首次提交的请求、响应和业务标识 |
| EV-002 | RESPONSE | RESPONSE | UNRESOLVED-REPLAY-SUBMIT | AS-002 | 相同幂等身份的重放响应 |
| EV-003 | STATE_AFTER | STATE | UNRESOLVED-TASK-OBSERVER | AS-003 | 幂等作用域内任务集合与计数 |
| EV-004 | PROVIDER_CALL | SIDE_EFFECT | UNRESOLVED-PROVIDER-OBSERVER | AS-004 | correlation ID 对应的 Provider 调用记录 |
| EV-005 | BILLING_RECORD | SIDE_EFFECT | UNRESOLVED-BILLING-OBSERVER | AS-005 | correlation ID 对应的业务扣费记录 |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| - | false | API 与观察器未绑定前禁止创建真实任务或账户数据 |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| - | false | 未允许执行；未来 Cleanup 必须清理测试任务但保留不可变账务审计 |

## Execution Mode

BLOCKED

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| MISSING_API_CONTRACT | BINDING | true | 提交 Operation 及幂等键载体、作用域、TTL、重复响应均未定义 |
| MISSING_STATE_OBSERVER | EVIDENCE | true | 无法按幂等身份独立统计实际业务任务 |
| MISSING_SIDE_EFFECT_OBSERVER | EVIDENCE | true | 无法独立统计 Provider 调用和账务扣费 |

## Risk

- 仅比较两次 HTTP 响应不能证明没有重复任务或重复扣费。
- 猜测幂等 Header 或字段会测试错误的合约并可能触发真实副作用。

## Dependencies

- authoritative idempotency contract
- versioned submit API operation contract
- task observer
- Provider call observer
- billing ledger observer
