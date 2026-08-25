# Scenario

## Scenario ID

SCN-wan3-provider-failure-refund

## Requirement

- Source: Wan3 Provider 失败补偿意图，尚未提供可执行合约
- Intent: 当受控 Provider 确定性失败时，任务进入失败终态，调用次数符合批准的重试策略，并以账务流水证明扣费已被一次性补偿。

## Acceptance Criteria

### AC-001

可由受控故障注入器触发确定性的 Provider 失败，并将该失败与唯一 correlation ID 关联。

### AC-002

任务最终进入权威状态机定义的失败终态，失败分类为 PROVIDER_ERROR。

### AC-003

Provider 调用次数等于已批准重试策略的预期次数；业务扣费与退款各一次、金额相抵、净额为零。

## Priority

P0

## Patterns

- PROVIDER_FAILURE
- STATE_MACHINE
- BILLING
- ATOMICITY

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
| PRE-001 | Provider 故障注入器能在非生产隔离环境按 correlation ID 确定性失败 | PROVIDER |
| PRE-002 | 权威状态机和重试策略版本已发布 | SYSTEM |
| PRE-003 | 任务、Provider 调用和不可变账务流水均可独立观察 | STATE |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | ${WAN3_ACTOR_ID} | `<contract-valid-request>` | configuration |
| DATA-002 | ${WAN3_ACTOR_ID} | `<unique-correlation-id>` | generated |
| DATA-003 | ${WAN3_ACTOR_ID} | `<approved-retry-policy-version>` | configuration |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | PROVIDER | - | - | - | - | - | AC-001 | EV-001 |
| STEP-002 | API | - | - | - | - | - | AC-001, AC-002 | EV-002 |
| STEP-003 | DATA | - | - | - | - | - | AC-002 | EV-003 |
| STEP-004 | PROVIDER | - | - | - | - | - | AC-003 | EV-004 |
| STEP-005 | DATA | - | - | - | - | - | AC-003 | EV-005 |

## Execution Steps

1. STEP-001：在隔离环境为唯一 correlation ID 配置确定性 Provider 失败。
2. STEP-002：使用已发布 API 合约提交一次有效任务并捕获业务标识。
3. STEP-003：观察任务直到权威失败终态或测试超时。
4. STEP-004：按 correlation ID 查询所有 Provider 尝试并比对重试策略。
5. STEP-005：查询不可变账务流水，核对扣费、退款和净额。

## Expected Response

- 提交响应状态和业务标识必须来自权威 API 合约，当前不猜测。
- Provider 失败不得被映射为成功业务结果。

## Expected State

- 任务进入权威状态机定义的失败终态，失败分类为 PROVIDER_ERROR。
- 任务不得在测试完成后继续异步转为成功或重复执行。

## Expected Side Effects

- REQUIRED: Provider 尝试次数符合批准策略；一条业务扣费和一条等额退款使净额为零。
- FORBIDDEN: 不得重复扣费、重复退款或在终态后继续调用 Provider。

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-001 | PROVIDER | injectedFailureClass | EQUALS | PROVIDER_ERROR | - |
| AS-002 | AC-002 | STEP-003 | STATE | terminalState | EQUALS | - | resolvedStateMachine.providerFailureState |
| AS-003 | AC-002 | STEP-003 | STATE | failureClass | EQUALS | PROVIDER_ERROR | - |
| AS-004 | AC-003 | STEP-004 | SIDE_EFFECT | providerCallCount | COUNT_EQUALS | - | resolvedRetryPolicy.expectedAttempts |
| AS-005 | AC-003 | STEP-005 | SIDE_EFFECT | chargeCount | COUNT_EQUALS | 1 | - |
| AS-006 | AC-003 | STEP-005 | SIDE_EFFECT | refundCount | COUNT_EQUALS | 1 | - |
| AS-007 | AC-003 | STEP-005 | SIDE_EFFECT | netAmount | EQUALS | 0 | - |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-000 | STATE_BEFORE | STATE | UNRESOLVED-BILLING-OBSERVER | AS-005, AS-006, AS-007 | 故障任务提交前的账户、账务和关联任务基线 |
| EV-001 | PROVIDER_CALL | PROVIDER | UNRESOLVED-FAILURE-INJECTOR | AS-001 | 故障注入确认及 correlation ID |
| EV-002 | RESPONSE | RESPONSE | UNRESOLVED-SUBMIT-OPERATION | AS-002 | 提交响应和业务标识 |
| EV-003 | STATE_AFTER | STATE | UNRESOLVED-TASK-OBSERVER | AS-002, AS-003 | 任务终态与失败分类 |
| EV-004 | PROVIDER_CALL | SIDE_EFFECT | UNRESOLVED-PROVIDER-OBSERVER | AS-004 | 所有 Provider 尝试及时间序列 |
| EV-005 | BILLING_RECORD | SIDE_EFFECT | UNRESOLVED-BILLING-OBSERVER | AS-005, AS-006, AS-007 | 不可变扣费与退款流水及净额 |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| - | false | 故障注入、API 和观察器未绑定前禁止调用真实 Provider 或账务系统 |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| - | false | 未允许执行；未来 Cleanup 必须撤销故障规则并清理测试任务 |

## Execution Mode

BLOCKED

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| MISSING_API_CONTRACT | BINDING | true | 任务提交 Operation 与响应结构未提供 |
| MISSING_DEPENDENCY | PREPARE | true | 缺少隔离环境的确定性 Provider 故障注入器和已批准重试策略 |
| MISSING_STATE_OBSERVER | EVIDENCE | true | 无法独立观察任务终态和失败分类 |
| MISSING_SIDE_EFFECT_OBSERVER | EVIDENCE | true | 无法观察 Provider 尝试及不可变扣费退款流水 |

## Risk

- 未受控的失败测试可能调用真实 Provider、产生真实费用或留下异步任务。
- 仅看到失败响应不能证明退款发生，也不能证明没有终态后重试。

## Dependencies

- versioned submit API operation contract
- controlled Provider failure injector
- approved retry policy
- task state observer
- Provider call observer
- billing ledger observer
