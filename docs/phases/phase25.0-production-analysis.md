# Phase 25.0：生产化现状分析报告

- 阶段：25.0 扫描分析（不写代码）
- 结论：平台能力完整，但生产化存在 **3 类核心缺口**（持久化升级、真实用户认证、真实遥测接线）与 **4 项高风险漏洞**，改造路径已明确。

## 1. 当前 Repository 实现

| 项 | 现状 | 分类 |
|---|---|---|
| `Repository<T>` 接口 | `create/get/update/delete/query/count/clear`，`Entity{id}` / `Query{filter,limit,offset}` | 已存在，可直接复用 |
| `InMemoryRepository<T>` | 内存实现，浅相等过滤 + limit/offset | 已存在，可直接复用 |
| `JsonRepository<T>` | 原子落盘（tmp+rename），损坏文件按空处理 | 已存在，可直接复用 |
| `StorageKind` | `'memory' \| 'json'`，**未预留 `'sqlite'`** | 需要扩展 |
| 工厂 `createRepository` | 按 kind 返回实现 | 需要扩展（加 sqlite/postgres 分支） |

## 2. 当前 JSON 持久化

- ProjectService 独立文件持久化；runs/checkpoints/jobs/approvals/audit/idempotency 经 `createRepository('json', ...)` 统一切换。
- 迁移对象共 15 类：Project / Environment / Run / Job / Worker / Approval / Audit / TestAsset / Defect / Knowledge / Decision / Cost / Quality / ReleaseDecision / 用户（新增）。
- **Migration 风险**：JSON 记录 id 格式为 `${prefix}-时间-随机`，需保证 SQLite 迁移后 id 不变；JSON 嵌套对象（payload/evidence）需序列化存储。

## 3. 当前 API Auth

| 项 | 现状 | 风险 |
|---|---|---|
| 认证 | 单点 Bearer 比较，`opts.token ?? env.PLATFORM_API_TOKEN ?? 'dev-token'` | **高危**：默认 dev-token 可绕过配置 |
| 身份 | `X-Actor` / `X-Role` 头由上游注入，服务端不校验真实性 | **高危**：直连时客户端可自报 `x-role: ADMIN` 提权 |
| 限流 | 每 IP 滑动窗口（默认 120/min），内存态 | 需分级（Anonymous/Auth/Service Account）+ 分维度 |
| 分页 | **无分页**，列表全量返回 | 数据量大时 Dashboard/列表超时 |
| 错误 | 401/429/404/400/500，500 回显内部 message | **中危**：信息泄露；需统一错误契约 + requestId/traceId |

- `createProject` 硬编码 `'ADMIN'`（不校验调用者）——鉴权信任漏洞放大点，**必须修复**。

## 4. 当前 RBAC

| 项 | 现状 | 分类 |
|---|---|---|
| 角色 | ADMIN/QA/DEVELOPER/RELEASE_MANAGER/VIEWER/SERVICE_ACCOUNT（6 角色） | 已存在，可直接复用 |
| 权限 | 11 权限点 + `ROLE_PERMISSIONS` 矩阵 + `hasPermission` | 已存在，可直接复用 |
| 访问链 | `evaluateAccessChain`：RBAC → 环境安全策略 → 审批 → 执行（ADMIN 不可绕过 DENY） | 已存在，闭环 |
| **作用域** | **不支持** Project/Environment/Business 作用域，角色全局化 | **必须扩展**（架构级） |

- **Breaking 风险**：引入作用域会触达 `hasPermission` / `ROLE_PERMISSIONS` / `evaluateAccessChain` 签名，涉及 service/api/cli/测试多消费方。方案：**新增 `ScopedAccessRequest` + 作用域解析层，保留原全局接口兼容**。

## 5. 当前 Metrics

- 14 指标 + 6 SLO 已存在，`MetricValue{value,tracked,unit}` 机制完善。
- **tracked=false 共 3 项**：`rcaAccuracy` / `flakyRate` / `healingRate`（无遥测源）；`costPerRun/costPerFeature` 在无 costs 时 null。
- **需扩展**：接入真实遥测后自动翻转 tracked；`queueLength` 无 MetricValue 包装（裸 number）需统一。

## 6. 当前 Dashboard

- CLI + JSON + 静态 HTML（`bin/dashboard.ts` / `agent:dashboard`）；平台侧 `GET /dashboard` 返回聚合 JSON。
- **web/ 目录不存在**，无任何前端工程 → **必须新增** React + Vite Dashboard。

## 7. 当前 Telemetry（核心缺口）

| 数据 | 现状 | 分类 |
|---|---|---|
| `src/platform/telemetry/` | **不存在** | 必须新增 |
| LLM 成本 | `OpenAICompatibleProvider` 返回**真实 usage**（input/output tokens + model + latencyMs）；但 `CostLedger` 与 `recordLLM` **从未被调用**，成本段为预估 | 需要接线（真实数据源已存在） |
| RCA | 证据链 + 分类器齐备；**无 prediction vs actual 对照 / ground truth 回标**，全库 grep 零匹配 | 必须新增验证闭环 |
| Flaky | 算法 + 状态机齐备；**无真实多轮运行数据源**，`FlakyLifecycle` 未实例化 | 需要接线 |
| Healing | 4 态（SUGGESTED/APPROVED/REJECTED/APPLIED）；**缺 ROLLED_BACK**、无持久化、无状态转移历史 | 必须新增回滚态 + 持久化 |
| Release | ReleaseDecision 已落盘（真实产物可见） | 已接线 |

## 8. 当前 Run / Job / Worker

- Run 状态机（6 态）、TestJob 队列（优先级/重试/超时/幂等）、Worker 注册/心跳/调度/崩溃回收全部齐备，实体统一继承 `Entity{id}`。
- **需扩展**：实体缺通用 `updatedAt`；弱关联（runId/projectId 无引用完整性）；并发更新最后写入胜出（无乐观锁）。

## 9. 当前 CI/CD

- 5 个 workflow（test / agent-test / agent-release-gate / release / security）+ dependabot，齐全。
- **需扩展**：平台 preflight/health/smoke 命令；生产运行模式校验（JSON/Memory/Mock 在生产 DENY）。

## 10. Phase 25 最小改造路径

```text
25.1 SQLite      新增 SqliteRepository（node:sqlite 内置）→ StorageKind 加 'sqlite' → 15 类实体迁移
25.2 PostgreSQL  新增 PostgresRepository（同 Repository<T> 接口）→ STORAGE_BACKEND=postgres
25.3 Auth        新增 src/platform/auth/（JWT + User + login/logout/refresh/info）→ RBAC 作用域
25.4 Telemetry   新增 src/platform/telemetry/（8 类事件）→ 接线 LLM Cost / RCA / Flaky / Healing
25.5 Metrics     翻转 tracked（Cost/RCA/Flaky/Healing）→ 时间窗口（1h/6h/24h/7d/30d/release/version）
25.6 Dashboard   web/（React + Vite）→ 15 页面 + 2s 轮询
25.7 API Hardening  分页/错误契约/requestId/traceId/限流分级/认证中间件
25.8 Production    运行模式 + preflight/health/smoke + migrate/backup/restore
```

## 生产风险清单（最高优先级）

| # | 风险 | 影响 | 处置阶段 |
|---|---|---|---|
| P0 | X-Role 直信任 + 默认 dev-token | 越权 / 提权 | 25.3 Auth + 25.7 |
| P0 | `createProject` 硬编码 ADMIN | 任意调用者记作 ADMIN | 25.3 |
| P1 | 500 错误回显内部 message | 信息泄露 | 25.7 |
| P1 | 无分页 | 大列表超时 | 25.7 |
| P1 | 生产可用 Mock（JSON/Memory/Mock LLM） | 假数据 / 假运营 | 25.8 运行模式 |
| P2 | 实体无 updatedAt / 弱关联 | 审计与一致性弱 | 25.1/25.8 |
| P2 | RBAC 作用域为架构级扩展 | Breaking 风险 | 25.3 兼容方案 |

**强约束确认**：不新增 Agent 类型；不重写 Autonomous/Assertion 引擎；不破坏 Phase 24 API；JSON/Memory 兼容层保留；API/CLI 共用 Service；Repository 向后兼容。
