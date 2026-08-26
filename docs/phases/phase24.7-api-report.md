# Phase 24.7：Platform API + Service Layer 报告

## 1. 目标

统一 HTTP API + CLI + Scheduler 共用同一 Service Layer，禁止维护两套业务逻辑；新增审计模块（API 依赖）与幂等存储；任务书 13/14/15/16 的服务端支撑。

## 2. 新增模块

| 文件 | 职责 |
| --- | --- |
| `src/platform/service/idempotency.ts` | `IdempotencyStore`：`begin` / `complete` / `has` / `clear`，按 `kind + key` 去重，绑定既有结果防重复 Run / Bug / Release |
| `src/platform/service/platform-service.ts` | `PlatformService`（核心 Service Layer）：Project / Run 生命周期 / 入队 / 审批 / 权限门禁 / 事件发布 / 审计 / 幂等 / 运维视图 / Run Detail / API 延迟采样 |
| `src/platform/service/factory.ts` | `createPlatformService`：一次性装配全部依赖；存储后端 `memory | json` 可替换；幂等种子项目 |
| `src/platform/audit/audit-log.ts` | `AuditLog`：actor / role / action / resource / environment / result / approvalId / traceId，`redactSensitive` 脱敏 |
| `src/platform/api/server.ts` | `createPlatformServer`：node:http 实现，Bearer Token + RBAC 头 + 每 IP 限流 + 请求校验 + 审计 + API 延迟采样 |

## 3. 关键设计

- **统一 Service Layer**：API Handler 与 CLI 子命令（`bin/platform-cli.ts`）全部委托 `PlatformService`，无第二套业务逻辑。
- **API 安全**：无 Token → 401；超限流 → 429；非法 / 无权限 / 不存在 → 400；未知路由 → 404。请求体 JSON 校验、`X-Actor` / `X-Role` 头注入身份、`Idempotency-Key` 头幂等。
- **API 路由**：`POST/GET /projects`、`POST /runs`、`GET /runs/:id`、`/runs/:id/cancel`、`/runs/:id/retry`、`/runs/:id/report`、`/runs/:id/trace`、`/runs/:id/detail`、`/approvals`、`/approvals/:id/approve|reject`、`/dashboard`、`/health` 等。
- **JSON 持久化**：工厂新增 `storage: 'memory' | 'json'`，CLI 默认 json，跨进程保留平台状态（Run / Job / Audit / Approval / 幂等记录）。
- **审计**：Run 创建/取消/重试、审批决策、生产访问等高风险操作全部落审计，可按 actor / runId / traceId / approvalId 检索。
- **事件接线**：`wireNotifications()` 将 EventBus 事件桥接至 NotificationDispatcher（Run 状态变化 → 控制台通道示例）。

## 4. 验收结果

| 检查项 | 结果 |
| --- | --- |
| Build（`tsc --noEmit` + `npm run build`） | ✅ 通过 |
| 单元 `platform-api.test.ts` | ✅ 16 PASS（认证 401 / 限流 429 / 404 / RBAC 400 / 幂等 / Approval / Run Detail / Dashboard） |
| 单元 `idempotency.test.ts` | ✅ 6 PASS |
| 集成 `platform-run.test.ts` | ✅ 8 PASS（生命周期 / checkpoint / 状态机 / retry / RBAC / 幂等 / 事件 / 审计） |
| 集成 `scheduler-worker.test.ts` | ✅ 4 PASS（执行 / 重试 / 环境路由 / 崩溃回收） |
| 集成 `api-run.test.ts` | ✅ 4 PASS（HTTP 全链路 / 审计 / 幂等） |
| `npm test` | ✅ 1217 PASS（无回归） |
| `npm run agent:test` | ✅ 450 PASS |
| CLI 冒烟 | ✅ `platform health` / `run create` / `run list` / `run detail` / `platform metrics` / `project list` |

## 5. 与任务书对应

- 任务书 11（Platform API）：✅ 全部端点 + `POST /runs` 返回 `{ runId, status: 'QUEUED' }`。
- 任务书 12（Checkpoint / Resume）：✅ Service 侧 pause/resume/cancel/retry + checkpoint 恢复（集成测试覆盖）。
- 任务书 13（幂等性）：✅ IdempotencyStore + API `Idempotency-Key` + 集成测试（重复 POST /runs 只创建 1 个 Run）。
- 任务书 14（审计）：✅ AuditLog + 关键操作落审计 + 按维度检索。
- 任务书 22（CLI）：✅ `agent project / run / worker / approval / platform` 全部子命令，与 API 共用 Service Layer。
- 任务书 23（验收命令）：✅ 11 个 `platform:*` 命令全部通过。

## 6. 后续

- 24.8 统一运维视图 + 平台指标 + SLO 计算（已接线 `metrics()` / `runDetail()` / 延迟采样）。

下一阶段：24.8 Platform Operations。
