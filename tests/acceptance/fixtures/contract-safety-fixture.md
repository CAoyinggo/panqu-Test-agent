# 资源审计与转义 <script>alert("xss")</script> & "测试"

## API

| Method | Path |
| --- | --- |
| GET | /resources/audit |

### Query 参数

| 参数 | 位置 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- | --- |
| filter | query | string | 否 | 过滤类型 "active" & "archived" |

### 响应

| 状态码 | 描述 |
| --- | --- |
| 200 | 查询成功 |

## Acceptance Criteria

- AC-1 GET /resources/audit 查询资源返回 200。
