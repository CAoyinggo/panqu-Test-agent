# Scenario

## Scenario ID

SCN-generic-multi-api-operation-binding

## Requirement

- Source: controlled-workflow-v1 本地合约夹具
- Intent: 上传、创建任务、查询状态、读取详情和观察资源必须由显式 Operation Binding 串联，且每个 AC 都能追溯到操作、断言与证据。

## Acceptance Criteria

### AC-001

上传操作返回 HTTP 201 和非空 uploadId。

### AC-002

任务创建操作使用 STEP-001 捕获的 uploadId，返回 HTTP 202、非空 taskId 和 QUEUED 初始状态。

### AC-003

状态查询返回同一 taskId 的 COMPLETED 终态。

### AC-004

详情中的 sourceUploadId 等于 STEP-001 的 uploadId，resultRef 存在，且观察器证明只创建一个 upload、task 和 result。

## Priority

P0

## Patterns

- FUNCTIONAL
- PERSISTENCE
- STATE_MACHINE
- ASYNC

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
| PRE-001 | controlled-workflow-v1 仅监听 127.0.0.1，执行模式固定为 immediate-success | API |
| PRE-002 | fixture://payload/input-a.bin 由 prepare hook 创建并归当前运行所有 | RESOURCE |
| PRE-003 | workflow-observer 是受控夹具的只读证据端点 | STATE |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | ${ACTOR_ID} | `fixture://payload/input-a.bin` | prepare hook |
| DATA-002 | ${ACTOR_ID} | `${RUN_ID}` | prepare hook |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | API | api | POST | /__fixtures/workflow/uploads | `{"contentRef":"fixture://payload/input-a.bin","runId":"${RUN_ID}"}` | uploadId=body.data.uploadId | AC-001, AC-004 | EV-001 |
| STEP-002 | API | api | POST | /__fixtures/workflow/tasks | `{"uploadId":"${STEP-001.uploadId}","runId":"${RUN_ID}"}` | taskId=body.data.taskId, initialStatus=body.data.status | AC-002, AC-003 | EV-002, EV-003 |
| STEP-003 | API | api | GET | /__fixtures/workflow/tasks/${STEP-002.taskId}/status | - | terminalStatus=body.data.status | AC-003 | EV-004 |
| STEP-004 | API | api | GET | /__fixtures/workflow/tasks/${STEP-002.taskId} | - | resultRef=body.data.resultRef | AC-004 | EV-005 |
| STEP-005 | API | api | GET | /__fixtures/workflow-observer/runs/${RUN_ID} | - | uploadCount=body.data.uploadCount, taskCount=body.data.taskCount, resultCount=body.data.resultCount | AC-004 | EV-006 |

## Execution Steps

1. STEP-001：上传预置 payload 并捕获 uploadId。
2. STEP-002：只使用 STEP-001.uploadId 创建任务并捕获 taskId 与初始状态。
3. STEP-003：使用 STEP-002.taskId 查询确定性的终态。
4. STEP-004：使用同一 taskId 读取详情并验证输入、任务与结果绑定。
5. STEP-005：通过只读观察器证明当前 RUN_ID 只有一组资源。

## Expected Response

- STEP-001 返回 HTTP 201；STEP-002 返回 HTTP 202；STEP-003、STEP-004、STEP-005 返回 HTTP 200。
- 所有捕获标识必须存在，后续操作只能引用前序捕获值。

## Expected State

- 任务状态从 STEP-002 的 QUEUED 转换到 STEP-003 的 COMPLETED。
- STEP-004 的 sourceUploadId 等于 STEP-001.uploadId，taskId 等于 STEP-002.taskId。
- STEP-005 的 uploadCount、taskCount、resultCount 均为 1。

## Expected Side Effects

- REQUIRED: 当前 RUN_ID 创建一个 upload、一个 task 和一个 result。
- FORBIDDEN: 不得创建未绑定 upload 的任务，不得产生第二个任务或结果。

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-001 | RESPONSE | status | EQUALS | 201 | - |
| AS-002 | AC-001 | STEP-001 | RESPONSE | body.data.uploadId | EXISTS | - | - |
| AS-003 | AC-002 | STEP-002 | RESPONSE | status | EQUALS | 202 | - |
| AS-004 | AC-002 | STEP-002 | STATE | body.data.status | EQUALS | QUEUED | - |
| AS-005 | AC-003 | STEP-003 | RESPONSE | status | EQUALS | 200 | - |
| AS-006 | AC-003 | STEP-003 | STATE | body.data.status | TRANSITION | COMPLETED | - |
| AS-007 | AC-004 | STEP-004 | STATE | body.data.sourceUploadId | EQUALS | - | STEP-001.uploadId |
| AS-008 | AC-004 | STEP-004 | RESPONSE | body.data.resultRef | EXISTS | - | - |
| AS-009 | AC-004 | STEP-005 | STATE | body.data.uploadCount | COUNT_EQUALS | 1 | - |
| AS-010 | AC-004 | STEP-005 | STATE | body.data.taskCount | COUNT_EQUALS | 1 | - |
| AS-011 | AC-004 | STEP-005 | STATE | body.data.resultCount | COUNT_EQUALS | 1 | - |
| AS-012 | AC-004 | STEP-005 | RESPONSE | status | EQUALS | 200 | - |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-000 | REQUEST | API | STEP-002 | AS-003, AS-004 | 任务创建请求及 STEP-001.uploadId 的显式绑定 |
| EV-001 | RESPONSE | RESPONSE | STEP-001 | AS-001, AS-002 | 上传响应与 uploadId 捕获 |
| EV-002 | RESPONSE | RESPONSE | STEP-002 | AS-003 | 任务创建响应与 taskId 捕获 |
| EV-003 | RESPONSE | STATE | STEP-002 | AS-004, AS-006 | 任务创建响应中的协议级初始 QUEUED 状态；持久化终态由 STEP-003 独立查询证明 |
| EV-004 | STATE_AFTER | STATE | STEP-003 | AS-005, AS-006 | 同一任务的 COMPLETED 终态 |
| EV-005 | RESOURCE | STATE | STEP-004 | AS-007, AS-008 | 任务详情、输入绑定和结果引用 |
| EV-006 | STATE_AFTER | STATE | STEP-005 | AS-009, AS-010, AS-011, AS-012 | RUN_ID 作用域的资源计数快照和观察器响应断言 |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| prepare-controlled-workflow | true | 创建隔离 RUN_ID、Actor、payload，并将夹具设置为 immediate-success |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| cleanup-controlled-workflow | true | 按 RUN_ID 删除 upload、task、result 与 payload，并验证资源计数归零 |

## Execution Mode

EXECUTABLE

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| NONE | DESIGN | false | - |

## Risk

- 该资产只绑定 controlled-workflow-v1 本地夹具，不代表任何真实产品 API。
- 任一步未执行、捕获值未解析或所需证据缺失时，最终结果必须 BLOCKED 而非 PASS。

## Dependencies

- controlled-workflow-v1 local fixture contract
- api Processor
- prepare-controlled-workflow hook
- cleanup-controlled-workflow hook
