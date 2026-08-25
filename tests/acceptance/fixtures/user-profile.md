# 用户资料修改

## 页面

入口为 `/profile`，用户提交资料后显示保存结果。

## API

| Method | Path |
| --- | --- |
| PUT | /api/users/{id} |

### Body 参数

| 参数 | 位置 | 类型 | 必填 | 可空 | 范围 | 描述 |
| --- | --- | --- | --- | --- | --- | --- |
| nickname | body | string | 是 | 否 | 2~20 | 用户昵称 |
| age | body | integer | 否 | 否 | 1~100 | 用户年龄 |
| Authorization | header | string | 是 | 否 | | Bearer Token |

### 响应

| 状态码 | 描述 |
| --- | --- |
| 200 | 修改成功 |
| 400 | 参数非法 |
| 401 | 未登录 |
| 403 | 无权限或跨租户 |
| 404 | 用户不存在 |

## Actor / Role / Tenant

| Actor ID | 用户 ID | 角色 | 租户 | Token Ref |
| --- | --- | --- | --- | --- |
| user-a | user-a | USER | tenant-a | user-a |
| user-b | user-b | USER | tenant-a | user-b |
| admin | admin | ADMIN | tenant-a | admin |
| tenant-b-user | user-c | USER | tenant-b | tenant-b-user |

## 权限

- 普通用户只能修改自己的资料。
- 普通用户修改其他用户必须被禁止。
- 管理员可以修改目标用户。

## 数据隔离

- Tenant A 用户不能访问 Tenant B 用户的数据。

## 业务规则

- 资料修改成功后必须返回更新后的用户资料。

## Acceptance Criteria

- AC-1 用户可以修改自己的 nickname。
- AC-2 nickname 长度非法时返回 400。
- AC-3 age 超出范围时返回 400。
- AC-4 未登录返回 401。
- AC-5 普通用户修改其他用户返回 403。
- AC-6 管理员可以修改目标用户。
- AC-7 跨租户访问必须被拒绝并返回 403。
