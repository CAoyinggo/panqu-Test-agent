# Wan3 VideoHub Pipeline 开发自测需求

Wan3 使用 Workflow qnck 展示项目级 VideoHub Pipeline；真实任务提交依赖
VideoHub submit Contract，在该 Contract 的 Method、Path、Request 或计费语义未知时禁止提交。

## 页面

入口为 `/aivideo/v2/videohub/pipeline?project_id=365`。页面应显示当前项目的
Pipeline 列表、默认状态、加载失败状态和任务操作入口。

## API

| Method | Path |
| --- | --- |
| GET | /aivideo/v2/videohub/pipeline |

### Query 参数

| 参数 | 位置 | 类型 | 必填 | 可空 | 范围 | 描述 |
| --- | --- | --- | --- | --- | --- | --- |
| project_id | query | integer | 是 | 否 | 1~999999 | 当前项目 ID |
| Cookie | header | string | 是 | 否 | | 测试账号会话引用 |

### 响应

| 状态码 | 描述 |
| --- | --- |
| 200 | 返回当前 Project 的 Pipeline 页面 |
| 400 | project_id 参数非法 |
| 401 | 会话缺失 |
| 403 | 跨项目访问被拒绝 |

## Actor / Role / Tenant

| Actor ID | 用户 ID | 角色 | 租户 | Token Ref |
| --- | --- | --- | --- | --- |
| wan3-user | wan3-user | USER | panqu | WAN3_TEST_SESSION |
| other-project-user | other-user | USER | panqu | WAN3_OTHER_PROJECT_SESSION |

## 功能

- 用户进入 Pipeline 页面后只能看到当前 Project 的任务数据。
- 页面加载成功、空列表和加载失败都必须有确定状态，不能只验证 HTTP 200。
- 真实 Provider 生成和业务扣费属于禁止的 SAFE 副作用。

## 数据隔离

- Project 365 用户不得读取其他 Project 的 Pipeline 数据。
- 跨 Project 拒绝后，目标任务、Provider 调用和 Billing 记录均保持不变。

## Acceptance Criteria

- AC-1 当前 Project 用户访问 GET /aivideo/v2/videohub/pipeline?project_id=365 返回 200。
- AC-2 project_id 缺失、0、1000000 或类型错误时返回 400。
- AC-3 会话缺失时返回 401。
- AC-4 跨 Project 访问返回 403，且目标项目数据和 Billing 均不变。
- AC-5 页面进入、默认状态、成功状态和失败状态均可观察。
- AC-6 VideoHub submit Contract UNKNOWN 时不得发起任务、Provider 或扣费请求。
