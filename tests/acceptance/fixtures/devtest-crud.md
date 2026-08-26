# 任务 CRUD

## API

| Method | Path |
| --- | --- |
| POST | /api/tasks |
| GET | /api/tasks/{id} |
| PATCH | /api/tasks/{id} |
| DELETE | /api/tasks/{id} |

## Actor / Role

| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| owner | owner | USER | owner |

## Acceptance Criteria

- AC-1 POST /api/tasks 创建任务成功返回 201。
- AC-2 GET /api/tasks/{id} 查询已创建任务返回 200。
- AC-3 PATCH /api/tasks/{id} 更新标题成功返回 200。
- AC-4 DELETE /api/tasks/{id} 删除成功返回 204。
