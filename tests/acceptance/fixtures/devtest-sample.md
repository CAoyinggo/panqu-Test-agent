# 文章管理

## 页面

入口为 `/articles`，用户可以查看文章详情并创建新文章。

## API

| Method | Path |
| --- | --- |
| GET | /api/articles/{id} |
| POST | /api/articles |

### Body 参数

| 参数 | 位置 | 类型 | 必填 | 可空 | 范围 | 描述 |
| --- | --- | --- | --- | --- | --- | --- |
| Authorization | header | string | 是 | 否 | | Bearer Token |
| title | body | string | 是 | 否 | 1~50 | 文章标题 |
| priority | body | integer | 否 | 否 | 1~5 | 展示优先级 |

### 响应

| 状态码 | 描述 |
| --- | --- |
| 200 | 查询成功 |
| 201 | 创建成功 |
| 400 | 参数非法 |
| 401 | 未登录 |
| 403 | 无权限或跨租户 |
| 404 | 文章不存在 |

## Actor / Role / Tenant

| Actor ID | 用户 ID | 角色 | 租户 | Token Ref |
| --- | --- | --- | --- | --- |
| author-a | author-a | AUTHOR | tenant-a | author-a |
| author-b | author-b | AUTHOR | tenant-a | author-b |
| other-tenant-user | user-x | USER | tenant-b | other-tenant-user |

## 权限

- 作者只能查询自己的文章。
- 作者修改其他作者的文章必须被禁止。

## 数据隔离

- Tenant B 用户不能访问 Tenant A 的文章数据。

## 业务规则

- 分辨率约束示例：240~8000，480P 与 8K 均为合法枚举描述。
- 文章创建成功后必须返回创建后的完整文章对象。

## Acceptance Criteria

- AC-1 作者查询自己的文章返回 200。
- AC-2 title 缺失时创建文章返回 400。
- AC-3 title 超过 50 字符时返回 400。
- AC-4 未登录创建文章返回 401。
- AC-5 跨租户查询必须被拒绝并返回 403。
