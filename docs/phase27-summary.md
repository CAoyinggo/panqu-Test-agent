# Phase 27 总结报告：生产安全加固（Production Security Hardening）

- 版本：v4.3.0
- 日期：2026-08-19
- 前置版本：v4.2.0（Phase 26 完成，commit 023ddf3，全量回归 1394 PASS / 18 skipped）

## 目标

对审计发现的 **Critical 级生产安全缺口** 进行确定性（Deterministic First）修复：

1. 生产默认口令 / 默认 JWT 密钥回退 → 生产/预发模式可被默认凭据攻击。
2. 静态 token + `X-Actor`/`X-Role` 身份伪造 → 任意人可伪造管理员身份。
3. 审计 / 遥测成本 / Job / Worker 读端点无 RBAC → VIEWER/QA 可越权读取运维数据。
4. 审批自提自批（RELEASE_MANAGER 可自批自己的发布申请）→ 越权风险。
5. `Math.random()` 审批 ID 可预测；`decodeJwt` 对非法输入不防护。
6. Preflight 未覆盖 staging、默认密钥、默认口令、静态身份来源检查。

## 发现的问题

| 严重度 | 问题 | 根因 | 处置 |
|---|---|---|---|
| Critical | 生产模式 JWT_SECRET 缺失或 `dev-secret-change-me` 回退仍可启动 | `auth-service` 缺省回退开发密钥 | 27.1 生产强制非默认密钥（fail fast） |
| Critical | 静态 token 可伪造任意身份（X-Actor/X-Role），production 亦允许 | `server.resolvePrincipal` 无条件信任 X-Header | 27.1 生产模式禁止静态身份 |
| Critical | 生产模式默认种子口令 `admin/admin123` 可登录 | `allowDefaultCredentials` 缺省 true | 27.1 生产模式强制禁用 |
| High | 审计/成本/Job/Worker 读端点无 RBAC | 平台服务层无权限断言 | 27.2 新增 OPS_READ |
| High | RELEASE_MANAGER 可自提自批发布申请 | 审批无职责分离 | 27.3 禁止 requester===decidedBy |
| Medium | 审批 ID 可预测（Math.random） | 弱随机源 | 27.3 randomUUID |
| Medium | decodeJwt 对非法结构不报错 | 未做结构/JSON 校验 | 27.3 加固 |
| High | Preflight 不拦截默认密钥/默认口令/静态身份 | 仅检查 production 是否设置 secret | 27.1 集成安全策略检查 |
| Medium | package-lock.json 版本残留 3.0.0 | 未随版本同步 | 27.4 修复同步 |

## 实施内容

### 27.1 生产安全模式强制

新增 `src/platform/security/index.ts`（零依赖纯模块，唯一安全策略来源）：

- `PlatformMode` / `resolvePlatformMode(env)`：统一模式解析（缺省 development，`prod` 别名归一，未知回退 development）。
- `isProductionLike(mode)`：production + staging 均按生产安全约束。
- `isKnownInsecureJwtSecret(secret)`：类型守卫，识别缺失与开发回退值。
- `requireSecureJwtSecret(mode, secret)`：生产/预发缺失或默认值 → 抛错拒绝装配（fail fast）。
- `resolveAllowDefaultCredentials(mode, explicit)`：production 强制 false（显式 true 亦覆盖）。
- `allowHeaderIdentity(mode)`：production 禁止 X-Actor/X-Role 静态身份。
- `securityChecks(mode, opts)`：返回 4 项安全检查（运行模式 / JWT 密钥 / 默认口令 / 静态身份来源），供 Preflight 消费。

接入点：`auth-service`（requireSecureSecret 构造校验）、`factory`（mode 解析 + 密钥强制 + 默认口令策略 + bundle.mode）、`server`（resolvePrincipal 静态身份开关 + 统一模式解析）、`platform-cli` serve（统一模式解析 + 生产安全横幅）、`preflight`（checkSecurity 替换 checkEnv）。

### 27.2 读端点 RBAC

- `rbac.ts`：新增 `OPS_READ` 权限，授予 ADMIN / RELEASE_MANAGER / SERVICE_ACCOUNT；VIEWER/QA 无。
- `server.ts`：新增 `requireOpsRead(ctx)`，注入 `/audit`、`/telemetry/cost`、`/jobs`、`/workers` 四个运维读端点；新增 `HttpError`（带 status 的业务错误）与错误映射（403 保留状态码）。

### 27.3 审批职责分离 + 安全随机 ID

- `approval-center.ts`：`decide` 中 `requester === decidedBy` → 抛错（approve/reject 均拦截）；审批 ID 改 `randomUUID`。
- `jwt.ts`：`decodeJwt` 校验三段结构与 JSON 合法性。

## 修改文件

- `src/platform/security/index.ts`（新增）
- `src/platform/auth/auth-service.ts`
- `src/platform/auth/jwt.ts`
- `src/platform/service/factory.ts`
- `src/platform/rbac/rbac.ts`
- `src/platform/api/server.ts`
- `src/platform/approval-center/approval-center.ts`
- `src/platform/ops/preflight.ts`
- `bin/platform-cli.ts`
- `tests/unit/security.test.ts`（新增）
- `tests/unit/auth.test.ts`、`tests/unit/approval-center.test.ts`、`tests/unit/jwt.test.ts`
- `tests/integration/api-auth.test.ts`、`tests/integration/web-dashboard.test.ts`、`tests/integration/api-hardening.test.ts`
- `tests/e2e/platform-scenarios.test.ts`
- `package.json`、`package-lock.json`、`src/platform/version.ts`、`README.md`、`CHANGELOG.md`（新增）

## 新增文件

- `src/platform/security/index.ts`（安全策略模块）
- `tests/unit/security.test.ts`（17 项）
- `CHANGELOG.md`（修复「完全缺失」审计缺口）

## 架构变化

- 新增独立安全策略层 `src/platform/security`（Rule 优先，纯确定性逻辑，不依赖 LLM），供 auth / factory / server / CLI / preflight 共享，消除各处散落的模式判断。
- RBAC 权限模型扩展一个权限位（OPS_READ），不改变既有权限语义。
- 安全约束由「开发环境宽松、生产强制」双态统一为「development/test 宽松、staging/production 强制」两档，且均可在 preflight 中可见。

## 测试

- 新增单元测试：`security.test.ts`（17 项）+ auth requireSecureSecret（4 项）+ approval 职责分离/随机 ID（2 项）+ jwt decodeJwt 加固（1 项）。
- 新增集成测试：OPS_READ 403/200 矩阵（api-auth 3 项）、web-dashboard QA 403 负向（1 项）。
- 适配既有用例：Scenario 8 审批职责分离拆分（approver 独立）、web-dashboard/api-hardening 运维端点改用 ADMIN。
- 验收命令 `npm run phase27:test`：9 文件 92 用例 PASS。
- 全量回归 `npm test`：**1420 passed / 18 skipped**（较上一版 +26）。

## 性能

- 安全策略为纯函数与零依赖常量表，无热路径开销；OPS_READ 为常数级权限位判断。
- 无新增异步/IO，无需重建性能基线；未发现回归。

## 安全

- 覆盖任务书安全清单：JWT、RBAC、身份伪造、默认口令、审批、Audit、Prompt/SQL 注入面（未改动执行链）、Preflight。
- 生产模式启动路径 fail-fast：无 JWT_SECRET / 默认密钥 → CLI 与服务拒启；默认口令与静态身份在 production 不可用。
- 4 个运维读端点从「任意身份可读」收紧为「OPS_READ 角色可读」。

## 兼容性

- API：运维端点对 VIEWER/QA 由 200 → 403（预期安全收紧，写入 API 行为变更）；其余端点行为不变。
- CLI：serve 需生产模式时配置 JWT_SECRET；其余命令不变。
- Storage：无 Schema 变化，无需 Migration。
- 测试资产 / Trace：不变。
- 版本：package.json / version.ts / README / CHANGELOG / package-lock 全部同步 v4.3.0。

## 验收

- Build：PASS
- `npm run phase27:test`：9 文件 92 用例 PASS
- 全量回归 `npm test`：1420 PASS / 18 skipped
- Preflight：development → 安全策略 WARN（无 BLOCK）；production+安全密钥 → 全 PASS；production 无密钥 → 启动拒启
- serve：development 模式正常启动并展示安全横幅

## 遗留问题

- 双环境策略源（`config/environment-policy.ts` 与 `src/platform/projects/environment-policy.ts` 并存）尚未合并。
- 平台层反向依赖 agents 域（`audit-log.ts`、`telemetry-service.ts`）未消除。
- 无性能基线（10/50/100/500 Runs）；coverage 未含 `src/platform/**`。
- 死代码待清理：`src/utils/time.ts`、`assertion-visualizer.ts`、`/defects` 与 `/knowledge` 死端点。
- 迁移框架无 down/回滚；README 目录结构滞后。

## 下一阶段建议

按优先级（价值/风险/复杂度），候选：

1. **Phase 28 工程治理**：清理死代码与死端点、合并双环境策略源、消除平台层反向依赖、补齐 CHANGELOG/版本一致性检查（低成本高价值，消除已识别的技术债）。
2. **Phase 29 性能与容量基线**：建立 10/50/100/500 Runs 基线脚本与回归门禁（任务书硬性要求）。
3. **Phase 30 平台测试覆盖率补齐**：coverage 纳入 `src/platform/**`，补齐缺失分支。
