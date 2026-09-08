# Scenario

<!--
复制后必须用 Requirement/Business Model 值替换所有尖括号占位符。
模板保留现有 Scenario Parser 的章节与列名，不预置产品、项目、接口、字段或业务流程。
-->

## Scenario ID

SCN-<domain>-<intent>

## Requirement

- Source: <requirement-source-ref>
- Intent: <business-intent>

## Acceptance Criteria

### AC-001

<deterministic-acceptance-outcome>

## Priority

P0

## Patterns

- FUNCTIONAL
- <按风险选择 PERSISTENCE / NON_MUTATION / IDEMPOTENCY / AUTHORIZATION / ...>

## Actor

- Type: USER
- ID: ${ACTOR_ID}

## Role

<role-ref-or-not-applicable>

## Tenant

- ID: ${TENANT_ID}

## Project

- ID: ${PROJECT_ID}

## Authentication

- Type: TOKEN
- Reference: ${ACTOR_TOKEN_REF}

## Preconditions

| ID | Condition | Evidence Channel |
| --- | --- | --- |
| PRE-001 | <requirement-precondition> | API |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | ${ACTOR_ID} | `<runtime-data-ref>` | <data-source-ref> |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | API | <processor-ref-1> | <method-1> | <path-1> | `<request-ref-1>` | <capture-1> | AC-001 | EV-001 |
| STEP-002 | API | <processor-ref-2> | <method-2> | <path-2> | `<request-ref-2>` | <capture-2> | AC-001 | EV-002 |

## Execution Steps

1. STEP-001：<requirement-derived-action-1>。
2. STEP-002：<requirement-derived-action-2>。

## Expected Response

- <response-oracle-from-requirement>

## Expected State

- <state-oracle-or-not-applicable>

## Expected Side Effects

- <side-effect-oracle-or-not-applicable>

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-001 | RESPONSE | <target-ref-1> | <operator-1> | <expected-1> | - |
| AS-002 | AC-001 | STEP-002 | STATE | <target-ref-2> | <operator-2> | - | <expected-from-2> |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-001 | RESPONSE | RESPONSE | STEP-001 | AS-001 | <response-proof> |
| EV-002 | STATE_AFTER | STATE | STEP-002 | AS-002 | <state-proof> |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| <prepare-hook-ref> | true | <prepare-description> |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| <cleanup-hook-ref> | true | <cleanup-description> |

## Execution Mode

EXECUTABLE

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| NONE | DESIGN | false | - |

## Risk

- <risk-from-business-model>

## Dependencies

- <环境、服务、Processor、Evidence Provider；无则写 NONE>
