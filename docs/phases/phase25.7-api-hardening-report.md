# Phase 25.7 API Hardening 报告

## 一、目标与结论

25.6 让 Dashboard 与 API 同源可用，但 API 仍是"功能可用"水平。25.7 对平台 API 做**生产级加固**：
链路追踪（requestId/traceId 可透传）、统一错误契约、每 IP 限流（含配额头与重试提示）、列表可选分页。
全程零破坏（默认行为向后兼容，既有客户端/测试不受影响）。

```text
请求 → 服务端生成或透传 requestId/traceId → 挂到 res._meta → 贯穿所有响应
    → 认证（JWT/RBAC）
    → 限流（X-RateLimit-Limit/Remaining/Reset；超限 429 + Retry-After）
    → 路由（/api 前缀剥离 + SPA fallback）
    → 列表可选分页（?page&pageSize → {items,pagination}；不传 → 纯数组）
    → 统一错误契约 {error, message, status, requestId, traceId}
```

**结论：25.7 完成。** 全部验收指标 PASS：

```text
npm test                  1342 PASS（新增 6）
agent:test                 450 PASS
npm run build + build:web  成功
npm run platform:test      205 PASS
npm run platform:integration  60 PASS（新增 api-hardening 6）
```

## 二、新增能力（`src/platform/api/server.ts`）

### 1. requestId / traceId 链路追踪
- 请求可透传 `X-Request-Id` / `X-Trace-Id`（截断至 64 字符防注入）；未透传则服务端生成 `req-*` / `trace-*`
- 所有 JSON 响应（成功/失败/认证）统一注入 `X-Request-Id` / `X-Trace-Id` 响应头，便于日志/审计跨服务关联
- 请求元数据（`RequestMeta`）挂到 `res._meta`，贯穿 sendJson/sendError 全程

### 2. 统一错误契约
- 所有错误响应统一 `{ error: code, message, status, requestId, traceId }`（补 `status` 字段）
- requestId/traceId 与响应头严格一致（读 `res._meta`，优于调用方参数，静态/内部路径兜底 `static`）

### 3. 限流增强（每 IP / 每分钟）
- `rateLimitInfo` 返回配额信息：`{limited, remaining, resetAt, limit}`
- 正常响应注入 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`
- 超限返回 `429`，附带 `Retry-After: 1` 响应头
- 认证路由（login/refresh/logout/info）与静态资源不计入限流

### 4. 列表可选分页
- `maybePaginate(url, items)`：显式传 `?page&pageSize` 才返回 `{ items, pagination: {page, pageSize, total, totalPages} }`；不传则原样返回纯数组（向后兼容）
- pageSize 默认 50、上限 200；page 从 1 起；越界页返回空 items
- 应用到 7 个列表路由：`/runs`、`/projects`、`/approvals`、`/telemetry/events`、`/jobs`、`/audit`、`/workers`

## 三、前端适配（`web/src/api.ts`）

- 会话级 `X-Trace-Id`：同一控制台会话所有请求共享一个 traceId（localStorage），便于审计链路关联
- 错误解析适配统一契约：`message` 为顶层字段（旧实现误把 `error` 当对象取 message）

## 四、测试（`tests/integration/api-hardening.test.ts`，6 例）

- 客户端透传 `X-Request-Id` / `X-Trace-Id` → 响应头原样返回
- 未透传 → 服务端生成（`req-*` / `trace-*`）
- 401 错误体含 `error/message/status/requestId/traceId`，与响应头一致
- 404 未匹配路由返回统一错误契约
- 限流：`rateLimitPerMinute=3` 时第 4 次请求 429，带 `Retry-After`、`X-RateLimit-Remaining: 0`；正常响应带配额头
- 分页：`?page&pageSize` → `{items, pagination}`；越界页空 items；不传 → 纯数组；audit 分页同样生效

## 五、风险与说明

- Breaking Change：无。分页仅在显式传参时启用；错误契约新增 `status` 字段（向后兼容新增字段）；响应头为增量
- 限流按 IP + 1 分钟滑动窗口（内存态），单实例部署适用；多实例场景建议 25.8 前置于网关
- 强约束满足：未虚构 Metrics、未把 Mock 当生产数据、未默认关闭鉴权
