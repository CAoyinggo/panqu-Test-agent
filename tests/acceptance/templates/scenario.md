# Scenario

<!--
复制本文件到 tests/acceptance/scenarios/<domain>/<scenario-id>/requirement.md。
模板只定义通用执行契约，不包含任何产品、模型或业务专用字段。
设计阶段只能使用 EXECUTABLE / DESIGNED_ONLY / BLOCKED；PASS / FAIL 只能来自真实运行结果。
-->

## Scenario ID

SCN-<domain>-<intent>

## Requirement

- Source: <需求文档、工单或版本>
- Intent: <要验证的业务意图>

## Acceptance Criteria

### AC-001

<可判定、可追溯的验收条件>

## Priority

P0

## Patterns

- FUNCTIONAL
- <按风险选择 PERSISTENCE / NON_MUTATION / IDEMPOTENCY / AUTHORIZATION / ...>

## Actor

- Type: USER
- ID: ${ACTOR_ID}

## Role

<角色；无角色要求时写 NOT_APPLICABLE>

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
| PRE-001 | <执行前必须成立的条件> | API |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | ${ACTOR_ID} | `{}` | prepare hook |

## API Contract

<!--
每个 API 操作必须精确声明 Method + Path，并绑定 AC 与证据通道。
Request 是 JSON、标量或 `-`；Capture 使用 `变量=响应路径`，多个值用逗号分隔。
非 API 操作可将 Method/Path 写为 `-`，但仍必须指定 Channel 与 Processor。
-->

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | API | api | POST | /api/resources | `{"name":"${RESOURCE_NAME}"}` | resourceId=body.data.id | AC-001 | EV-001 |
| STEP-002 | API | api | GET | /api/resources/${STEP-001.resourceId} | - | persistedName=body.data.name | AC-001 | EV-002 |

## Execution Steps

1. STEP-001：执行写操作并捕获新资源标识。
2. STEP-002：使用 STEP-001 的输出读回资源，证明持久化结果。

## Expected Response

- STEP-001 返回明确的成功状态和资源标识。
- STEP-002 返回与写入值一致的业务字段。

## Expected State

- 资源持久化状态与 AC-001 一致。
- 未声明可变更的字段保持不变。

## Expected Side Effects

- REQUIRED: <必须发生的副作用及次数；无则写 NOT_APPLICABLE>
- FORBIDDEN: <不得发生的副作用及次数；无则写 NOT_APPLICABLE>

## Assertions

<!-- Operator: EQUALS / NOT_EQUALS / EXISTS / NOT_EXISTS / CONTAINS / NOT_CONTAINS / TYPE_IS / COUNT_EQUALS / UNCHANGED / TRANSITIONED_TO -->

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-001 | RESPONSE | status | EQUALS | 201 | - |
| AS-002 | AC-001 | STEP-002 | STATE | body.data.name | EQUALS | - | input.RESOURCE_NAME |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-001 | RESPONSE | RESPONSE | STEP-001 | AS-001 | 写操作 Request/Response 与断言结果 |
| EV-002 | STATE_AFTER | STATE | STEP-002 | AS-002 | 读回状态与断言结果 |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| prepare-resource | true | 创建归属于本场景 Actor/Tenant/Project 的隔离数据 |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| cleanup-resource | true | 删除本场景创建的资源并验证删除结果 |

## Execution Mode

EXECUTABLE

## Blocked Reason

<!-- BLOCKED 时至少保留一行；非 BLOCKED 写 NONE。 -->

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| NONE | DESIGN | false | - |

## Risk

- <真实执行、数据、权限、计费或外部依赖风险>

## Dependencies

- <环境、服务、Processor、Evidence Provider；无则写 NONE>
