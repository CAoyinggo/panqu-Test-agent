# Scenario

## Scenario ID

SCN-wan3-insufficient-balance

## Requirement

- Source: Wan3 余额不足拒绝意图，尚未提供价格、余额和执行合约
- Intent: 当可用余额低于权威公式计算出的所需金额时，请求在创建任务和调用 Provider 前被拒绝，余额及账务状态保持不变。

## Acceptance Criteria

### AC-001

测试账户满足 availableBalance 小于 authoritativeRequiredCharge，且两者来自可审计的余额与定价观察器。

### AC-002

提交操作按权威 API 合约返回余额不足错误，业务任务数量和 Provider 调用次数均为 0。

### AC-003

拒绝前后可用余额、账务摘要和扣费记录数保持不变。

## Priority

P0

## Patterns

- BILLING
- NON_MUTATION
- ATOMICITY
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
| PRE-001 | 受控账户夹具可证明余额小于权威公式计算金额，不使用猜测价格 | STATE |
| PRE-002 | 提交 API 的 Method、Path、错误码和鉴权合约已发布 | API |
| PRE-003 | 任务、Provider 与账务观察器可按 correlation ID 证明零副作用 | SIDE_EFFECT |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | ${WAN3_ACTOR_ID} | `<controlled-insufficient-balance-account>` | prepare hook |
| DATA-002 | ${WAN3_ACTOR_ID} | `<contract-valid-request-with-authoritative-cost>` | configuration |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | DATA | - | - | - | - | - | AC-001, AC-003 | EV-001 |
| STEP-002 | API | - | - | - | - | - | AC-002 | EV-002 |
| STEP-003 | DATA | - | - | - | - | - | AC-002, AC-003 | EV-003 |
| STEP-004 | PROVIDER | - | - | - | - | - | AC-002 | EV-004 |
| STEP-005 | DATA | - | - | - | - | - | AC-003 | EV-005 |

## Execution Steps

1. STEP-001：读取余额、价格版本、权威所需金额和账务摘要作为前置证据。
2. STEP-002：使用已发布合约提交一次唯一 correlation ID 的有效业务请求。
3. STEP-003：观察任务集合与拒绝后的账户状态。
4. STEP-004：查询 Provider 调用观察器。
5. STEP-005：查询账务流水并比较拒绝前后摘要。

## Expected Response

- STEP-002 必须返回权威合约定义的余额不足状态和错误码，当前不猜测具体值。
- 响应不得包含任务已创建或 Provider 已受理的成功语义。

## Expected State

- 当前 correlation ID 的业务任务数量为 0。
- availableBalance 与账务摘要在拒绝前后保持不变。

## Expected Side Effects

- REQUIRED: NOT_APPLICABLE。
- FORBIDDEN: Provider 调用、任务创建和业务扣费次数都必须为 0。

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-001 | STATE | availableBalance | LESS_THAN | - | resolvedPricing.authoritativeRequiredCharge |
| AS-002 | AC-002 | STEP-002 | RESPONSE | status | EQUALS | - | resolvedContract.insufficientBalanceStatus |
| AS-003 | AC-002 | STEP-003 | STATE | taskCount | COUNT_EQUALS | 0 | - |
| AS-004 | AC-002 | STEP-004 | SIDE_EFFECT | providerCallCount | COUNT_EQUALS | 0 | - |
| AS-005 | AC-003 | STEP-003 | STATE | availableBalance | UNCHANGED | - | STEP-001.availableBalance |
| AS-006 | AC-003 | STEP-005 | SIDE_EFFECT | billingDigest | UNCHANGED | - | STEP-001.billingDigest |
| AS-007 | AC-003 | STEP-005 | SIDE_EFFECT | chargeCount | COUNT_EQUALS | 0 | - |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-001 | STATE_BEFORE | STATE | UNRESOLVED-BALANCE-OBSERVER | AS-001, AS-005, AS-006 | 拒绝前余额、价格版本、所需金额和账务摘要 |
| EV-002 | RESPONSE | RESPONSE | UNRESOLVED-SUBMIT-OPERATION | AS-002 | 余额不足拒绝响应 |
| EV-003 | STATE_AFTER | STATE | UNRESOLVED-TASK-AND-BALANCE-OBSERVER | AS-003, AS-005 | 拒绝后的任务集合与余额状态 |
| EV-004 | PROVIDER_CALL | SIDE_EFFECT | UNRESOLVED-PROVIDER-OBSERVER | AS-004 | correlation ID 下的 Provider 调用集合 |
| EV-005 | BILLING_RECORD | SIDE_EFFECT | UNRESOLVED-BILLING-OBSERVER | AS-006, AS-007 | 拒绝后的不可变账务摘要与记录集合 |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| - | false | 未提供受控低余额账户和权威价格前禁止操作真实账户 |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| - | false | 未允许执行；未来 Cleanup 必须恢复受控账户且不得改写审计流水 |

## Execution Mode

BLOCKED

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| MISSING_TEST_DATA | PREPARE | true | 缺少能证明余额小于权威所需金额的隔离账户与价格版本 |
| MISSING_API_CONTRACT | BINDING | true | 提交 Operation、余额不足状态和错误响应未定义 |
| MISSING_STATE_OBSERVER | EVIDENCE | true | 无法比较拒绝前后余额、账务摘要和任务集合 |
| MISSING_SIDE_EFFECT_OBSERVER | EVIDENCE | true | 无法证明 Provider 调用和扣费记录均为零 |

## Risk

- 以猜测价格构造余额不足会产生错误前提，甚至触发真实扣费。
- 单独断言错误响应不能证明任务未创建、Provider 未调用或余额未变化。

## Dependencies

- authoritative pricing and balance contract
- versioned submit API operation contract
- controlled insufficient-balance fixture
- task and balance observer
- Provider call observer
- billing ledger observer
