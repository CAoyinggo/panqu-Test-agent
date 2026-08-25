# Scenario

## Scenario ID

SCN-profile-mass-assignment

## Requirement

- Source: controlled-profile-v1 本地合约夹具
- Intent: 资料更新请求混入受保护字段时必须整体拒绝，合法字段和受保护字段均不得部分写入。

## Acceptance Criteria

### AC-001

包含 role、tenantId 或 projectId 任一受保护字段的资料更新返回 HTTP 422 和 PROFILE_FIELD_NOT_WRITABLE。

### AC-002

整个更新原子拒绝，displayName、role、tenantId、projectId、revision 和 canonicalDigest 均保持不变。

## Priority

P0

## Patterns

- AUTHORIZATION
- NON_MUTATION
- ATOMICITY

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
| PRE-001 | controlled-profile-v1 只在本机运行，ACTOR_ID 是目标资料所有者 | API |
| PRE-002 | 合约只允许用户修改 displayName，role、tenantId、projectId 明确不可写 | STATE |
| PRE-003 | profile-observer 返回资源 revision 与 canonicalDigest | STATE |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | ${ACTOR_ID} | `${PROFILE_USER_ID}` | prepare hook |
| DATA-002 | ${ACTOR_ID} | `{"displayName":"should-not-persist","role":"ADMIN","tenantId":"fixture-tenant-b","projectId":"fixture-project-b"}` | controlled fixture contract |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | API | api | GET | /__fixtures/profile-observer/users/${PROFILE_USER_ID} | - | beforeRevision=body.data.revision, beforeDigest=body.data.canonicalDigest, beforeDisplayName=body.data.profile.displayName, beforeRole=body.data.profile.role, beforeTenantId=body.data.profile.tenantId, beforeProjectId=body.data.profile.projectId | AC-002 | EV-001 |
| STEP-002 | API | api | PUT | /__fixtures/profile/users/${PROFILE_USER_ID} | `{"displayName":"should-not-persist","role":"ADMIN","tenantId":"fixture-tenant-b","projectId":"fixture-project-b"}` | - | AC-001 | EV-002 |
| STEP-003 | API | api | GET | /__fixtures/profile-observer/users/${PROFILE_USER_ID} | - | afterRevision=body.data.revision, afterDigest=body.data.canonicalDigest | AC-002 | EV-003 |

## Execution Steps

1. STEP-001：保存更新前资源摘要和全部可能被越权修改的字段。
2. STEP-002：本人提交同时包含合法字段与三个受保护字段的单次请求。
3. STEP-003：通过独立观察器读取更新后资源，验证请求没有发生部分提交。

## Expected Response

- STEP-002 返回 HTTP 422。
- STEP-002 的 body.error.code 等于 PROFILE_FIELD_NOT_WRITABLE。

## Expected State

- STEP-003 的 revision 和 canonicalDigest 与 STEP-001 一致。
- 合法的 displayName 与受保护的 role、tenantId、projectId 全部保持不变。

## Expected Side Effects

- REQUIRED: NOT_APPLICABLE。
- FORBIDDEN: 不得发生部分更新，不得提升角色，不得迁移租户或项目。

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-002 | RESPONSE | status | EQUALS | 422 | - |
| AS-002 | AC-001 | STEP-002 | RESPONSE | body.error.code | EQUALS | PROFILE_FIELD_NOT_WRITABLE | - |
| AS-003 | AC-002 | STEP-003 | STATE | body.data.revision | UNCHANGED | - | STEP-001.beforeRevision |
| AS-004 | AC-002 | STEP-003 | STATE | body.data.canonicalDigest | UNCHANGED | - | STEP-001.beforeDigest |
| AS-005 | AC-002 | STEP-003 | STATE | body.data.profile.displayName | UNCHANGED | - | STEP-001.beforeDisplayName |
| AS-006 | AC-002 | STEP-003 | STATE | body.data.profile.role | UNCHANGED | - | STEP-001.beforeRole |
| AS-007 | AC-002 | STEP-003 | STATE | body.data.profile.tenantId | UNCHANGED | - | STEP-001.beforeTenantId |
| AS-008 | AC-002 | STEP-003 | STATE | body.data.profile.projectId | UNCHANGED | - | STEP-001.beforeProjectId |
| AS-009 | AC-002 | STEP-001 | RESPONSE | status | EQUALS | 200 | - |
| AS-010 | AC-002 | STEP-003 | RESPONSE | status | EQUALS | 200 | - |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-000 | REQUEST | API | STEP-002 | AS-001, AS-002 | 所有者身份引用与包含受保护字段的请求摘要 |
| EV-001 | STATE_BEFORE | STATE | STEP-001 | AS-003, AS-004, AS-005, AS-006, AS-007, AS-008, AS-009 | 请求前的资源快照、规范摘要和读取成功断言 |
| EV-002 | RESPONSE | RESPONSE | STEP-002 | AS-001, AS-002 | 拒绝响应和结构化错误码 |
| EV-003 | STATE_AFTER | STATE | STEP-003 | AS-003, AS-004, AS-005, AS-006, AS-007, AS-008, AS-010 | 请求后的资源快照、规范摘要和读取成功断言 |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| prepare-profile-mass-assignment | true | 创建 MEMBER 用户及隔离资料，输出身份、作用域和资源变量 |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| cleanup-profile-mass-assignment | true | 删除夹具资料并确认角色、租户和项目基线未被污染 |

## Execution Mode

EXECUTABLE

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| NONE | DESIGN | false | - |

## Risk

- 仅验证 controlled-profile-v1 显式定义的字段可写规则，不推断真实产品字段。
- 422 响应缺少前后状态证据时不得判定 PASS。

## Dependencies

- controlled-profile-v1 local fixture contract
- api Processor
- prepare-profile-mass-assignment hook
- cleanup-profile-mass-assignment hook
