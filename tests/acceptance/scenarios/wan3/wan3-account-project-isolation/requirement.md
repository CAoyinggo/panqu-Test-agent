# Scenario

## Scenario ID

SCN-wan3-account-project-isolation

## Requirement

- Source: Wan3 账户与项目隔离意图，尚未提供身份、资源和 API 合约
- Intent: Account A 的 Project A 不得读取、修改或触发 Account B 的 Project B 资源，拒绝后目标状态及外部副作用保持不变。

## Acceptance Criteria

### AC-001

跨账户或跨项目访问按权威鉴权合约拒绝，响应不泄露目标资源内容或存在性细节。

### AC-002

目标资源 revision、canonicalDigest、owner、tenant 和 project 在拒绝前后保持不变。

### AC-003

拒绝请求不得创建任务、调用 Provider 或产生业务扣费。

## Priority

P0

## Patterns

- AUTHORIZATION
- TENANT_ISOLATION
- PROJECT_ISOLATION
- NON_MUTATION
- BILLING

## Actor

- Type: USER
- ID: ${ACCOUNT_A_ACTOR_ID}

## Role

UNRESOLVED_CONTRACT

## Tenant

- ID: ${ACCOUNT_A_TENANT_ID}

## Project

- ID: ${ACCOUNT_A_PROJECT_ID}

## Authentication

- Type: TOKEN
- Reference: ${ACCOUNT_A_TOKEN_REF}

## Preconditions

| ID | Condition | Evidence Channel |
| --- | --- | --- |
| PRE-001 | Account A 与 Account B 的身份、Tenant、Project 和凭据由受控 fixture 显式创建 | STATE |
| PRE-002 | 目标资源归 Account B 的 Project B 所有，资源观察器不会通过被测权限路径读取 | STATE |
| PRE-003 | 跨作用域 API、拒绝语义及资源标识格式由已发布合约定义 | API |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | ${ACCOUNT_A_ACTOR_ID} | `<account-a-project-a-context>` | prepare hook |
| DATA-002 | ${ACCOUNT_B_ACTOR_ID} | `<account-b-project-b-resource>` | prepare hook |
| DATA-003 | ${ACCOUNT_A_ACTOR_ID} | `<cross-scope-action-from-published-contract>` | configuration |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | DATA | - | - | - | - | - | AC-002 | EV-001 |
| STEP-002 | API | - | - | - | - | - | AC-001 | EV-002 |
| STEP-003 | DATA | - | - | - | - | - | AC-002, AC-003 | EV-003 |
| STEP-004 | PROVIDER | - | - | - | - | - | AC-003 | EV-004 |
| STEP-005 | DATA | - | - | - | - | - | AC-003 | EV-005 |

## Execution Steps

1. STEP-001：以独立只读观察器保存 Account B 目标资源的完整前置摘要。
2. STEP-002：使用 Account A 凭据对 Account B 的 Project B 资源执行已发布合约中的跨作用域操作。
3. STEP-003：重新观察目标资源、关联任务集合与资源所有权。
4. STEP-004：查询 correlation ID 下的 Provider 调用。
5. STEP-005：查询 correlation ID 下的账务记录。

## Expected Response

- STEP-002 返回权威鉴权合约指定的拒绝状态和错误码，当前不猜测数值。
- 响应不得包含目标资源业务字段、owner、tenant、project 或可枚举存在性信息。

## Expected State

- 目标资源 revision、canonicalDigest、owner、tenant、project 均不变。
- Account A 作用域和 Account B 作用域均不得新增由本次拒绝请求创建的任务。

## Expected Side Effects

- REQUIRED: NOT_APPLICABLE。
- FORBIDDEN: Provider 调用次数和业务扣费次数均为 0。

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-002 | RESPONSE | status | EQUALS | - | resolvedContract.crossScopeDenyStatus |
| AS-002 | AC-001 | STEP-002 | RESPONSE | body.resource | NOT_EXISTS | - | - |
| AS-003 | AC-002 | STEP-003 | STATE | target.canonicalDigest | UNCHANGED | - | STEP-001.targetCanonicalDigest |
| AS-004 | AC-002 | STEP-003 | STATE | target.owner | UNCHANGED | - | STEP-001.targetOwner |
| AS-005 | AC-002 | STEP-003 | STATE | target.tenant | UNCHANGED | - | STEP-001.targetTenant |
| AS-006 | AC-002 | STEP-003 | STATE | target.project | UNCHANGED | - | STEP-001.targetProject |
| AS-007 | AC-003 | STEP-003 | STATE | createdTaskCount | COUNT_EQUALS | 0 | - |
| AS-008 | AC-003 | STEP-004 | SIDE_EFFECT | providerCallCount | COUNT_EQUALS | 0 | - |
| AS-009 | AC-003 | STEP-005 | SIDE_EFFECT | chargeCount | COUNT_EQUALS | 0 | - |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-000 | REQUEST | API | UNRESOLVED-CROSS-SCOPE-OPERATION | AS-001, AS-002 | Account A 身份、Tenant、Project 和目标资源引用 |
| EV-001 | STATE_BEFORE | STATE | UNRESOLVED-CROSS-SCOPE-OBSERVER | AS-003, AS-004, AS-005, AS-006 | 目标资源的前置摘要与所有权上下文 |
| EV-002 | RESPONSE | RESPONSE | UNRESOLVED-CROSS-SCOPE-OPERATION | AS-001, AS-002 | 使用 Account A 凭据得到的拒绝响应 |
| EV-003 | STATE_AFTER | STATE | UNRESOLVED-CROSS-SCOPE-OBSERVER | AS-003, AS-004, AS-005, AS-006, AS-007 | 目标资源后置摘要与双方作用域任务集合 |
| EV-004 | PROVIDER_CALL | SIDE_EFFECT | UNRESOLVED-PROVIDER-OBSERVER | AS-008 | correlation ID 对应的 Provider 调用集合 |
| EV-005 | BILLING_RECORD | SIDE_EFFECT | UNRESOLVED-BILLING-OBSERVER | AS-009 | correlation ID 对应的账务记录集合 |
| EV-006 | RESOURCE | STATE | UNRESOLVED-CROSS-SCOPE-OBSERVER | AS-003, AS-004, AS-005, AS-006 | Account B 目标资源的 owner、tenant、project 归属证明 |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| - | false | 缺少隔离身份、资源 fixture 与精确 API 合约时禁止使用真实账户验证 |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| - | false | 未允许执行；未来 Cleanup 必须分别清理两个作用域且验证无跨域残留 |

## Execution Mode

BLOCKED

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| MISSING_TEST_DATA | PREPARE | true | 缺少可证明归属关系的双账户、双项目和目标资源隔离 fixture |
| MISSING_API_CONTRACT | BINDING | true | 跨作用域操作的 Method、Path、Request 和拒绝语义未发布 |
| MISSING_STATE_OBSERVER | EVIDENCE | true | 无法独立比较目标资源、所有权与双方任务集合的前后状态 |
| MISSING_SIDE_EFFECT_OBSERVER | EVIDENCE | true | 无法证明拒绝后 Provider 调用和业务扣费均为零 |

## Risk

- 使用真实账户测试未知跨域 Operation 可能造成数据泄露、越权写入或真实扣费。
- 仅断言 403 或 404 不能证明没有信息泄露和状态变更。

## Dependencies

- authoritative identity and scope contract
- versioned cross-scope API operation contract
- isolated dual-account fixture
- resource and task observer
- Provider call observer
- billing ledger observer
