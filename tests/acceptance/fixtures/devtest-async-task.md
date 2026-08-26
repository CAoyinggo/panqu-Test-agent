# 异步导出任务

## API

POST /api/exports

公开测试接口，无需认证。

## 响应

| 状态码 | 描述 |
| --- | --- |
| 202 | 已接受并创建异步任务 |

## Acceptance Criteria

- AC-1 POST /api/exports 返回 202，任务状态从 QUEUED 迁移到 RUNNING，最终进入 SUCCEEDED。
