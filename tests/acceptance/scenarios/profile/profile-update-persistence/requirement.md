# Scenario

## Scenario ID

SCN-profile-update-persistence

## Requirement

- Source: controlled-profile-v1 本地合约夹具
- Intent: 用户修改自己的展示名称后，响应与重新读取的持久化状态一致，未声明字段保持不变。

## Acceptance Criteria

### AC-001

受控夹具接受合法的本人资料修改，并返回 HTTP 200 及修改后的展示名称。

### AC-002

使用独立 GET 操作重新读取资料时，展示名称等于本次输入。

### AC-003

邮箱、角色、租户和项目字段在修改前后保持不变。

## Priority

P0

## Patterns

- FUNCTIONAL
- PERSISTENCE
- AUTHORIZATION

## Actor

- Type: USER
- ID: ${ACTOR_ID}

## Role

MEMBER

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
| PRE-001 | controlled-profile-v1 夹具仅监听 127.0.0.1，且 Actor 拥有目标资料 | API |
| PRE-002 | 目标资料具有稳定的 email、role、tenantId 和 projectId 基线 | STATE |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | ${ACTOR_ID} | `{"displayName":"fixture-updated-name"}` | prepare hook |
| DATA-002 | ${ACTOR_ID} | `${PROFILE_USER_ID}` | prepare hook |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | API | api | GET | /__fixtures/profile/users/${PROFILE_USER_ID} | - | originalEmail=body.data.email, originalRole=body.data.role, originalTenantId=body.data.tenantId, originalProjectId=body.data.projectId | AC-003 | EV-001 |
| STEP-002 | API | api | PUT | /__fixtures/profile/users/${PROFILE_USER_ID} | `{"displayName":"${PROFILE_DISPLAY_NAME}"}` | updatedName=body.data.displayName | AC-001 | EV-002 |
| STEP-003 | API | api | GET | /__fixtures/profile/users/${PROFILE_USER_ID} | - | persistedName=body.data.displayName | AC-002, AC-003 | EV-003 |

## Execution Steps

1. STEP-001：读取受控夹具中的资料基线并捕获所有不得变化的字段。
2. STEP-002：以资料所有者身份提交唯一允许修改的 displayName。
3. STEP-003：通过独立读取重新取得资源，验证持久化与未触碰字段。

## Expected Response

- STEP-002 返回 HTTP 200，body.data.displayName 等于 PROFILE_DISPLAY_NAME。
- STEP-003 返回 HTTP 200 和同一 PROFILE_USER_ID 的完整资料。

## Expected State

- STEP-003 的 displayName 等于本次写入值。
- STEP-003 的 email、role、tenantId 和 projectId 分别等于 STEP-001 捕获值。

## Expected Side Effects

- REQUIRED: controlled-profile-v1 中只更新目标资料一次。
- FORBIDDEN: 不得修改角色、租户、项目或其他用户资料。

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-002 | RESPONSE | status | EQUALS | 200 | - |
| AS-002 | AC-001 | STEP-002 | RESPONSE | body.data.displayName | EQUALS | - | input.PROFILE_DISPLAY_NAME |
| AS-003 | AC-002 | STEP-003 | STATE | body.data.displayName | EQUALS | - | input.PROFILE_DISPLAY_NAME |
| AS-004 | AC-003 | STEP-003 | STATE | body.data.email | UNCHANGED | - | STEP-001.originalEmail |
| AS-005 | AC-003 | STEP-003 | STATE | body.data.role | UNCHANGED | - | STEP-001.originalRole |
| AS-006 | AC-003 | STEP-003 | STATE | body.data.tenantId | UNCHANGED | - | STEP-001.originalTenantId |
| AS-007 | AC-003 | STEP-003 | STATE | body.data.projectId | UNCHANGED | - | STEP-001.originalProjectId |
| AS-008 | AC-003 | STEP-001 | RESPONSE | status | EQUALS | 200 | - |
| AS-009 | AC-002 | STEP-003 | RESPONSE | status | EQUALS | 200 | - |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-000 | REQUEST | API | STEP-002 | AS-001, AS-002 | 资料所有者身份引用、作用域和写入请求摘要 |
| EV-001 | STATE_BEFORE | STATE | STEP-001 | AS-004, AS-005, AS-006, AS-007, AS-008 | 修改前资源快照、摘要和读取成功断言 |
| EV-002 | RESPONSE | RESPONSE | STEP-002 | AS-001, AS-002 | 写操作的请求、响应和状态码 |
| EV-003 | STATE_AFTER | STATE | STEP-003 | AS-003, AS-004, AS-005, AS-006, AS-007, AS-009 | 独立读回的持久化资源快照和读取成功断言 |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| prepare-profile-persistence | true | 在 controlled-profile-v1 中创建隔离用户，输出 ACTOR_ID、ACTOR_TOKEN_REF、TENANT_ID、PROJECT_ID、PROFILE_USER_ID 和 PROFILE_DISPLAY_NAME |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| cleanup-profile-persistence | true | 删除本场景夹具数据，并验证目标用户和运行标识均不存在 |

## Execution Mode

EXECUTABLE

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| NONE | DESIGN | false | - |

## Risk

- 本资产只允许受控本地夹具；示例配置默认 realExecution=false，未显式启用时不得发送请求。
- PASS 必须同时具有写响应和独立读回状态证据。

## Dependencies

- controlled-profile-v1 local fixture contract
- api Processor
- prepare-profile-persistence hook
- cleanup-profile-persistence hook
