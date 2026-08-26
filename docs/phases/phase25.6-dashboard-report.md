# Phase 25.6 Web Dashboard 报告

## 一、目标与结论

25.4/25.5 让平台具备真实遥测与指标激活能力，但缺少可视化入口。25.6 构建 **React + Vite Web Dashboard**：
与平台 API 同源部署，15 个页面、2 秒轮询，把真实遥测/执行/调度/审批/审计/健康检查实时呈现给运维与测试人员。

```text
浏览器（SPA，2s 轮询）
  │  fetch /api/*（JWT Bearer）
  ▼
Platform HTTP API（25.3 认证 + 25.6 静态托管 + /api 前缀剥离 + SPA fallback）
  ▼
PlatformService（透传 telemetrySnapshot / telemetryCost / telemetryEvents / listJobs / listAudit …）
  ▼
TelemetryService / Scheduler / AuditLog / ApprovalCenter / Workers …
```

**结论：25.6 完成。** 全部验收指标 PASS：

```text
npm test                   1336 PASS
agent:test                  450 PASS
npm run build               成功
npm run build:web           成功（53 modules，193KB JS / 5.4KB CSS）
npm run platform:test       205 PASS
npm run platform:integration  54 PASS（新增 web-dashboard 8）
端到端冒烟                 静态托管 / SPA / /api 前缀 / 登录 / 运营闭环（激活 cost+execution）
```

## 二、前端（`web/`，React 18 + Vite 5 + TypeScript strict）

### 1. 脚手架
- `package.json` / `vite.config.ts`（dev 代理 `/api`、`/auth` → 后端 8787）/ `tsconfig.json`（strict）/ `index.html`
- 根 `package.json` 新增：`build:web`、`dev:web`、`platform:web:test`

### 2. 核心模块
- `src/api.ts`：`login/logout/getToken/setSession/clearSession`；`request<T>` 自动带 JWT Bearer，401 清会话；`api.get/post`
- `src/hooks/usePolling.ts`：2 秒轮询 + 手动 refresh + alive 防泄漏，fetcherRef 保持最新
- `src/components/ui.tsx`：`Card / MetricCard / Badge / StatusBadge / Table / JsonBlock / Empty / fmtTime / WindowSwitcher`
  - `MetricCard`：`tracked=false` 显示「○ 未激活」，绝不把无数据显示成 0
- `src/styles.css`：暗色主题（CSS 变量），响应式网格

### 3. 15 个页面（全部从真实 API 取数）
| 路由 | 页面 | 数据源 |
|---|---|---|
| `/` | 总览 Dashboard | `/dashboard` |
| `/runs`、`/runs/:id` | 执行列表 / 详情 | `/runs`、`/runs/:id/detail` |
| `/projects` | 项目管理（列表+创建） | `/projects` |
| `/approvals` | 审批中心（批准/驳回） | `/approvals`、`/approvals/:id/approve|reject` |
| `/metrics` | 平台指标 + 时间窗口 | `/metrics?window=` |
| `/telemetry` | 遥测快照（成本/RCA/Flaky/Healing） | `/telemetry/snapshot?window=` |
| `/telemetry/events` | 遥测事件流 | `/telemetry/events` |
| `/telemetry/activation` | 指标激活状态 | `/metrics/activation` |
| `/jobs` | 调度任务 | `/jobs` |
| `/workers` | Worker 池 | `/workers` |
| `/audit` | 审计日志 | `/audit` |
| `/health` | 健康检查 | `/health` |
| `/settings` | 会话/接口信息 | 本地会话 + 说明 |
| `*` | 404 | — |

登录门禁：未登录仅渲染 `<Login>`；登录后 localStorage 持 JWT 会话，侧栏 14 项导航 + 退出。

## 三、后端（`src/platform/api/server.ts`）

1. **静态托管**：`webDir` 提供时挂载 `/`（index.html）与 `/assets/*`（Content-Type 按扩展名，assets 加 `Cache-Control: public,max-age=3600`）；未构建时 `/` 返回 `dashboard_not_built`
2. **SPA fallback**：浏览器直链/刷新（`Accept: text/html`）访问客户端路由（如 `/runs`、`/settings`）回退 `index.html`；`/api`、`/auth` 与 fetch 默认 `Accept: */*` 不受影响，仍走 API——解决了 SPA 客户端路由与 API 路由同路径冲突
3. **`/api` 前缀剥离**：前端统一 `API_BASE='/api'`，后端请求处理时剥离前缀匹配根路由；根路径（无前缀）兼容保留，既有客户端不受影响
4. **新增 8 个 Dashboard 数据源路由**：`metrics`、`metrics/activation`、`telemetry/snapshot`、`telemetry/cost`、`telemetry/events`（`?run=` 可选）、`jobs`、`audit`、`workers`
5. **PlatformService 透传方法**：`telemetrySnapshot(window)`、`telemetryCost(window)`、`telemetryEvents(runId?)`、`listJobs()`、`listAudit()`

## 四、CLI serve 命令（`bin/platform-cli.ts`）

新增 `platform-cli serve [--port 8787] [--host 127.0.0.1] [--web web/dist]`：
- 启动 API + Web Dashboard（默认托管 `web/dist`，未构建时提示）
- 注入 JWT 认证（seed 用户 `admin/admin123`）
- **自动派发循环**（1s）：Dashboard 新建的 Run → 调度 → CLI Worker 真实执行 → LLM 遥测 → 成本落账 → 指标激活

端到端冒烟验证运营闭环：
```text
POST /api/runs（admin JWT）→ QUEUED
→ 自动派发 → Worker 真实执行（2 次 LLM 调用）
→ /api/metrics/activation：activeCount=2（cost=true 24样本 / execution=true 24样本）
→ /api/telemetry/snapshot：total={value:0.0008, tracked:true, unit:'CNY'}（真实 token×单价）
```

## 五、测试（`tests/integration/web-dashboard.test.ts`，8 例）

- 静态托管：`/`、`/index.html`、`/assets/*.js|css`（含 Content-Type 与缓存头）
- SPA fallback：`Accept: text/html` 访问 `/runs`、`/settings` 返回 index.html（未认证也回退，SPA 负责登录门禁）
- `/api` 前缀：无 token → 401；带 token 访问 `metrics?window=`、`activation`、`telemetry/snapshot`、`telemetry/cost`、`telemetry/events`、`jobs`、`audit`、`workers`、`dashboard` 全部 200
- 根路径兼容：`/health`、`/runs`、`/projects`、`/approvals` 带 token 正常
- 内部模式：无 auth 时 `/api/metrics` 用静态 Token 可访问
- 未构建场景：webDir 无 index.html → `/` 返回 `dashboard_not_built`

## 六、风险与说明

- Breaking Change：无。后端仅新增可选项（`webDir`）与兼容前缀剥离；既有根路径 API 契约不变
- SPA fallback 仅针对 `Accept: text/html`，不会污染 API 语义
- 强约束满足：Dashboard 所有数值来自真实 API；`tracked=false` 语义严格（无数据显示「○ 未激活」，不使用 0 占位）；鉴权默认开启（未登录仅见登录页）
