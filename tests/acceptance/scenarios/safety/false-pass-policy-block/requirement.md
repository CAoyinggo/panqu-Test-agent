# Scenario

## Scenario ID

SCN-safety-false-pass-policy-block

## Requirement

- Source: Scenario Result fail-close policy
- Intent: 候选测试未实际执行、没有 Processor、没有有效断言或没有必需证据时，Policy Gate 必须在任何副作用前阻断，且结果绝不能为 PASS。

## Acceptance Criteria

### AC-001

候选测试的 executed=false 或 processor=null 时，策略决定必须为 BLOCKED。

### AC-002

候选测试的 assertions 为空或 required evidence 不完整时，策略决定必须为 BLOCKED。

### AC-003

策略阻断不得调用业务 Processor、Prepare Hook、Tool、Provider 或 Billing，并产生可审计的 POLICY_BLOCKED 证据。

## Priority

P0

## Patterns

- NON_MUTATION
- AUDIT
- SECURITY

## Actor

- Type: SYSTEM
- ID: scenario-policy-negative-control

## Role

TEST_SAFETY_GUARD

## Tenant

- ID: NOT_APPLICABLE

## Project

- ID: test-flow-safety

## Authentication

- Type: NONE
- Reference: -

## Preconditions

| ID | Condition | Evidence Channel |
| --- | --- | --- |
| PRE-001 | 候选结果为隔离内存对象，不包含真实 endpoint、凭据或业务操作 | SYSTEM |
| PRE-002 | Policy Gate 在 Prepare、Processor 和 Tool 调度之前执行 | TRACE |
| PRE-003 | 运行时可记录策略决定与下游调用计数 | AUDIT |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | scenario-policy-negative-control | `{"declaredMode":"EXECUTABLE","executed":false,"processor":null,"assertions":[],"requiredEvidence":[]}` | explicit |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | DATA | policy-gate | - | - | `{"candidate":"${DATA-001}"}` | decision=output.decision, code=output.blockedReason.code | AC-001, AC-002 | EV-001 |
| STEP-002 | DATA | policy-audit-observer | - | - | `{"decisionRef":"${STEP-001.decision}"}` | downstreamCallCount=output.downstreamCallCount | AC-003 | EV-002 |

## Execution Steps

1. STEP-001：将无执行、无 Processor、无断言、无证据的 negative-control 候选交给执行前 Policy Gate。
2. STEP-002：只读检查策略审计与下游调用计数，不调度任何业务执行。

## Expected Response

- STEP-001 的 decision 等于 BLOCKED，blockedReason.code 等于 POLICY_BLOCKED。
- 任何输出字段均不得出现 PASS。

## Expected State

- 候选结果保持 executed=false、processorInvoked=false、passedAssertions=0。
- 下游调用计数保持 0。

## Expected Side Effects

- REQUIRED: 产生一条不含敏感数据的 POLICY_BLOCKED 审计证据。
- FORBIDDEN: Prepare、业务 Processor、Tool、Provider、Billing 调用次数必须全部为 0。

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-001 | SYSTEM | decision | EQUALS | BLOCKED | - |
| AS-002 | AC-001 | STEP-001 | SYSTEM | blockedReason.code | EQUALS | POLICY_BLOCKED | - |
| AS-003 | AC-002 | STEP-001 | SYSTEM | result.status | NOT_EQUALS | PASS | - |
| AS-004 | AC-002 | STEP-001 | SYSTEM | result.executed | EQUALS | false | - |
| AS-005 | AC-003 | STEP-002 | AUDIT | downstreamCallCount | COUNT_EQUALS | 0 | - |
| AS-006 | AC-003 | STEP-002 | AUDIT | policyDecisionCount | COUNT_EQUALS | 1 | - |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-001 | TRACE | SYSTEM | POLICY-GATE-NEGATIVE-CONTROL | AS-001, AS-002, AS-003, AS-004 | Gate 输入摘要、结构化决定和阻断原因 |
| EV-002 | AUDIT_RECORD | AUDIT | POLICY-AUDIT-OBSERVER | AS-005, AS-006 | 策略审计记录和所有下游调用计数 |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| - | false | negative control 必须是纯内存数据，禁止执行 Prepare Hook |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| - | false | 没有业务状态或外部资源需要清理 |

## Execution Mode

BLOCKED

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| POLICY_BLOCKED | POLICY | false | 本资产是禁止真实执行的 negative control；只能由隔离策略测试 harness 验证阻断语义 |

## Risk

- 若执行链绕过 Policy Gate，未执行候选可能被错误汇总为 PASS。
- 本资产自身不得被当作业务执行场景启动；其唯一合法结果是 POLICY_BLOCKED。

## Dependencies

- isolated policy test harness
- policy decision trace provider
- policy audit observer
