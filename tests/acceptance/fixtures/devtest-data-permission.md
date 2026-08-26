# 租户文档查询权限

## API

GET /api/documents/{id}

## Actor / Role / Tenant

| Actor ID | 用户 ID | 角色 | 租户 | Token Ref |
| --- | --- | --- | --- | --- |
| user-a | user-a | USER | tenant-a | user-a |
| user-b | user-b | USER | tenant-b | user-b |

## 参数

| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| Authorization | header | string | 是 |

## 数据隔离

- Tenant A 用户只能查看 Tenant A 的文档。
- Tenant A 用户访问 Tenant B 文档必须拒绝并返回 403。

## Acceptance Criteria

- AC-1 用户查询同租户文档返回 200。
- AC-2 跨租户查询文档返回 403。
