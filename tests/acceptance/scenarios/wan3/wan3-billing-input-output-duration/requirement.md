# Scenario

## Scenario ID

SCN-wan3-billing-input-output-duration

## Requirement

- Source: Wan3 当前需求草案，尚未形成可执行 API 与计费合约
- Intent: 验证输入边界、输出时长与最终计费完全遵循同一份权威规则，并且一次业务提交只产生一次账务结果。

## Acceptance Criteria

### AC-001

输入长度只能有一个权威上下限；当前需求中的冲突值必须先由产品合约消解。

### AC-002

输出时长边界、单位和舍入规则必须由权威合约提供，边界外请求按该合约确定性拒绝。

### AC-003

有效提交的账务金额等于权威定价公式对实际输入、输出与时长的计算结果，且只产生一条业务扣费记录。

## Priority

P0

## Patterns

- BOUNDARY
- BILLING
- PERSISTENCE

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
| PRE-001 | 产品方提供唯一的输入限制、输出时长、单位、舍入和价格版本 | SYSTEM |
| PRE-002 | API Operation Contract 明确提交与账务查询的 Method、Path、Request、Response | API |
| PRE-003 | 可按 correlation ID 查询任务状态和不可伪造的账务流水 | STATE |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | ${WAN3_ACTOR_ID} | `<authoritative-min-boundary>` | configuration |
| DATA-002 | ${WAN3_ACTOR_ID} | `<authoritative-max-boundary>` | configuration |
| DATA-003 | ${WAN3_ACTOR_ID} | `<authoritative-pricing-version>` | configuration |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | API | - | - | - | - | - | AC-001, AC-002 | EV-001 |
| STEP-002 | API | - | - | - | - | - | AC-003 | EV-002 |
| STEP-003 | DATA | - | - | - | - | - | AC-003 | EV-003 |
| STEP-004 | DATA | - | - | - | - | - | AC-003 | EV-004 |

## Execution Steps

1. STEP-001：按已消解的权威边界分别提交有效边界与边界外输入。
2. STEP-002：提交带唯一 correlation ID 的有效任务并保存响应。
3. STEP-003：通过独立状态观察器取得实际输入、输出与时长。
4. STEP-004：通过账务观察器按 correlation ID 查询业务扣费记录。

## Expected Response

- 边界请求的状态码和错误码必须来自已发布 API 合约，当前不猜测数值。
- 有效提交必须返回可关联任务状态与账务流水的稳定业务标识。

## Expected State

- 实际输入、输出与时长的状态记录可被独立观察并与提交关联。
- 价格版本和计算输入必须在账务证据中可追溯。

## Expected Side Effects

- REQUIRED: 有效提交按照权威定价合约形成一次业务扣费。
- FORBIDDEN: 边界拒绝请求不得扣费；同一 correlation ID 不得重复扣费。

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-001 | SYSTEM | contract.inputBoundaryConflictCount | COUNT_EQUALS | 0 | - |
| AS-002 | AC-002 | STEP-001 | RESPONSE | status | EQUALS | - | resolvedContract.boundaryStatus |
| AS-003 | AC-003 | STEP-003 | STATE | observedUsage | EQUALS | - | resolvedContract.expectedUsage |
| AS-004 | AC-003 | STEP-004 | SIDE_EFFECT | amount | EQUALS | - | resolvedPricing.calculatedAmount |
| AS-005 | AC-003 | STEP-004 | SIDE_EFFECT | chargeCount | COUNT_EQUALS | 1 | - |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-000 | REQUEST | API | UNRESOLVED-BOUNDARY-OPERATION | AS-001, AS-002 | 权威边界向量、版本和请求身份，当前缺少 API 绑定 |
| EV-001 | RESPONSE | RESPONSE | UNRESOLVED-BOUNDARY-OPERATION | AS-001, AS-002 | 权威边界请求与响应证据，当前缺少 API 绑定 |
| EV-002 | RESPONSE | RESPONSE | UNRESOLVED-SUBMIT-OPERATION | AS-003 | 有效提交与 correlation ID，当前缺少 API 绑定 |
| EV-003 | STATE_AFTER | STATE | UNRESOLVED-USAGE-OBSERVER | AS-003 | 实际输入、输出、时长和任务状态证据 |
| EV-004 | BILLING_RECORD | SIDE_EFFECT | UNRESOLVED-BILLING-OBSERVER | AS-004, AS-005 | 带定价版本的不可伪造账务流水 |
| EV-005 | STATE_BEFORE | STATE | UNRESOLVED-BILLING-OBSERVER | AS-004, AS-005 | 执行前账户状态、价格版本和账务基线 |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| - | false | 在合约冲突、API、状态观察器和账务观察器齐备前不得准备真实账户或产生费用 |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| - | false | 未允许执行；未来 Cleanup 必须删除测试任务且不得篡改账务审计记录 |

## Execution Mode

BLOCKED

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| REQUIREMENT_CONFLICT | REQUIREMENT | true | 输入长度存在冲突值，输出时长与计费单位尚无唯一权威规则 |
| MISSING_API_CONTRACT | BINDING | true | 边界提交、任务提交和账务查询的 Method、Path、Request、Response 未提供 |
| MISSING_STATE_OBSERVER | EVIDENCE | true | 无法独立取得实际输入、输出、时长与任务状态 |
| MISSING_SIDE_EFFECT_OBSERVER | EVIDENCE | true | 无法按 correlation ID 取得不可伪造的账务流水 |

## Risk

- 猜测限制值、字段或价格会生成错误 oracle，并可能造成真实扣费。
- 缺少账务证据时不得以提交响应推断计费正确。

## Dependencies

- authoritative Wan3 requirement and pricing contract
- versioned API operation contract
- usage state observer
- billing ledger observer
