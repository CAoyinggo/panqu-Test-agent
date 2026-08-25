# Scenario

## Scenario ID

SCN-profile-denied-write-non-mutation

## Requirement

- Source: controlled-profile-v1 本地合约夹具
- Intent: 非资源所有者修改资料必须被拒绝，并以修改前后独立状态证明资源未发生变化。

## Acceptance Criteria

### AC-001

同租户但非资源所有者的用户提交资料修改时，受控夹具返回 HTTP 403 和 PROFILE_WRITE_FORBIDDEN。

### AC-002

拒绝操作前后的资源 revision 与 canonicalDigest 完全一致。

### AC-003

拒绝操作不得改变 displayName、email、role、tenantId 或 projectId。

## Priority

P0

## Patterns

- AUTHORIZATION
- NON_MUTATION
- SECURITY

## Actor

- Type: USER
- ID: ${UNAUTHORIZED_ACTOR_ID}

## Role

MEMBER

## Tenant

- ID: ${TENANT_ID}

## Project

- ID: ${PROJECT_ID}

## Authentication

- Type: TOKEN
- Reference: ${UNAUTHORIZED_ACTOR_TOKEN_REF}

## Preconditions

| ID | Condition | Evidence Channel |
| --- | --- | --- |
| PRE-001 | controlled-profile-v1 只在本机运行，目标资料归 TARGET_OWNER_ID 所有 | API |
| PRE-002 | UNAUTHORIZED_ACTOR_ID 与 TARGET_OWNER_ID 不同，但属于相同测试租户和项目 | STATE |
| PRE-003 | profile-observer 为受控夹具只读证据端点，不属于被测业务 API | STATE |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | ${TARGET_OWNER_ID} | `${TARGET_PROFILE_USER_ID}` | prepare hook |
| DATA-002 | ${UNAUTHORIZED_ACTOR_ID} | `{"displayName":"unauthorized-change"}` | prepare hook |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | API | api | GET | /__fixtures/profile-observer/users/${TARGET_PROFILE_USER_ID} | - | beforeRevision=body.data.revision, beforeDigest=body.data.canonicalDigest, beforeDisplayName=body.data.profile.displayName, beforeEmail=body.data.profile.email, beforeRole=body.data.profile.role, beforeTenantId=body.data.profile.tenantId, beforeProjectId=body.data.profile.projectId | AC-002, AC-003 | EV-001 |
| STEP-002 | API | api | PUT | /__fixtures/profile/users/${TARGET_PROFILE_USER_ID} | `{"displayName":"${UNAUTHORIZED_DISPLAY_NAME}"}` | - | AC-001 | EV-002 |
| STEP-003 | API | api | GET | /__fixtures/profile-observer/users/${TARGET_PROFILE_USER_ID} | - | afterRevision=body.data.revision, afterDigest=body.data.canonicalDigest | AC-002, AC-003 | EV-003 |

## Execution Steps

1. STEP-001：通过只读夹具观察器保存目标资料的完整前置摘要与字段值。
2. STEP-002：以非所有者身份请求修改目标资料。
3. STEP-003：再次通过独立观察器读取目标资料，比较 revision、摘要和保护字段。

## Expected Response

- STEP-002 返回 HTTP 403。
- STEP-002 的 body.error.code 精确等于 PROFILE_WRITE_FORBIDDEN。

## Expected State

- STEP-003 的 revision 与 canonicalDigest 等于 STEP-001 捕获值。
- displayName、email、role、tenantId、projectId 均与拒绝前一致。

## Expected Side Effects

- REQUIRED: NOT_APPLICABLE。
- FORBIDDEN: 不得更新目标资料，不得改变资源归属，不得创建业务写入记录。

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-002 | RESPONSE | status | EQUALS | 403 | - |
| AS-002 | AC-001 | STEP-002 | RESPONSE | body.error.code | EQUALS | PROFILE_WRITE_FORBIDDEN | - |
| AS-003 | AC-002 | STEP-003 | STATE | body.data.revision | UNCHANGED | - | STEP-001.beforeRevision |
| AS-004 | AC-002 | STEP-003 | STATE | body.data.canonicalDigest | UNCHANGED | - | STEP-001.beforeDigest |
| AS-005 | AC-003 | STEP-003 | STATE | body.data.profile.displayName | UNCHANGED | - | STEP-001.beforeDisplayName |
| AS-006 | AC-003 | STEP-003 | STATE | body.data.profile.email | UNCHANGED | - | STEP-001.beforeEmail |
| AS-007 | AC-003 | STEP-003 | STATE | body.data.profile.role | UNCHANGED | - | STEP-001.beforeRole |
| AS-008 | AC-003 | STEP-003 | STATE | body.data.profile.tenantId | UNCHANGED | - | STEP-001.beforeTenantId |
| AS-009 | AC-003 | STEP-003 | STATE | body.data.profile.projectId | UNCHANGED | - | STEP-001.beforeProjectId |
| AS-010 | AC-002 | STEP-001 | RESPONSE | status | EQUALS | 200 | - |
| AS-011 | AC-002 | STEP-003 | RESPONSE | status | EQUALS | 200 | - |
| AS-012 | AC-001 | STEP-002 | RESPONSE | body.data | NOT_EXISTS | - | - |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-000 | REQUEST | API | STEP-002 | AS-001, AS-002 | 非所有者身份引用、目标作用域和拒绝请求摘要 |
| EV-001 | STATE_BEFORE | STATE | STEP-001 | AS-003, AS-004, AS-005, AS-006, AS-007, AS-008, AS-009, AS-010 | 只读观察器提供的拒绝前资源快照、摘要和读取成功断言 |
| EV-002 | RESPONSE | RESPONSE | STEP-002 | AS-001, AS-002, AS-012 | 被拒请求的状态码、结构化错误与无资源泄露证明 |
| EV-003 | STATE_AFTER | STATE | STEP-003 | AS-003, AS-004, AS-005, AS-006, AS-007, AS-008, AS-009, AS-011 | 只读观察器提供的拒绝后资源快照、摘要和读取成功断言 |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| prepare-profile-denied-write | true | 创建同租户的所有者与非所有者，输出两者身份引用及目标资料 ID |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| cleanup-profile-denied-write | true | 删除本场景的隔离用户与资料，并验证运行标识下无残留 |

## Execution Mode

EXECUTABLE

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| NONE | DESIGN | false | - |

## Risk

- 403 不是充分 PASS 条件；缺少 STATE_BEFORE 或 STATE_AFTER 任一证据时必须 BLOCKED。
- profile-observer 仅可在受控本地夹具中开放，禁止复用为线上调试后门。

## Dependencies

- controlled-profile-v1 local fixture contract
- api Processor
- prepare-profile-denied-write hook
- cleanup-profile-denied-write hook
