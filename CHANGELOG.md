# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 语义，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [4.13.0] - 2026-08-19

### 新增（E2E 时序卫生治理，Phase 37）

- DEBT-13 已解决（**技术债清零**：TECH-DEBT 12 项债务全部关闭）：审计确认 E2E / 集成测试已普遍采用健壮模式——随机端口（`server.listen()` 无参 / `listen(0)`）、固定时钟注入（`FIXED_ISO`，固定输入→固定输出，非 flaky）、`Date.now()` 生成唯一 ID、轮询 + 超时等待；未发现硬编码端口、运行时时间戳固定字面量断言或固定长 sleep 残留。
- 新增脚本 `phase37:test`（构建 + 时序卫生守护 + 代表性 E2E / 集成回归）。

### 变更

- `docs/TECH-DEBT.md`：DEBT-13（慢 / 易碎测试）已解决，开放债务归零。

### 测试

- 新增 `tests/unit/e2e-timing-hygiene.test.ts`（4 项）结构性守护：全部 E2E / 集成测试文件（1）无硬编码监听端口（`listen(<数字>)`）、（2）无对时间字段的固定 ISO 字面量断言（`FIXED_ISO` 注入除外）、（3）无 ≥1000ms 固定 sleep（应为轮询 + 超时）、（4）现状基线确认（随机端口 + FIXED_ISO + 超时轮询模式存在）；全量回归：1508 passed / 18 skipped（131 个测试文件）。

## [4.12.0] - 2026-08-19

### 新增（身份解析统一 + 防伪造不可绕过，Phase 36）

- DEBT-12 已解决：审计确认 `resolvePrincipal` 为唯一身份解析实现（无历史版本残留）；同时将「静态身份来源」的守卫与解析真正收敛到 security 模块——新增 `resolveStaticIdentity(mode, headers)`：production 返回 `null`（防身份伪造不可绕过），其余模式从 X-Actor/X-Role 头解析（数组取首项；无 actor 默认 `api`，无 role 默认 `VIEWER`）。
- `api/server.ts` 静态 Token 回退改调 `resolveStaticIdentity`，不再直接读取 `x-actor` / `x-role` 头——**平台层 X-Actor/X-Role 头读取仅存在于 security 模块**（结构上固化，防新 API 入口绕过生产关闭）。
- 新增脚本 `phase36:test`（构建 + 身份解析守护 + security / auth / RBAC 相关回归）。

### 变更

- `docs/TECH-DEBT.md`：DEBT-12（身份解析重复实现残留）已解决。

### 测试

- 新增 `tests/unit/identity-resolution-guard.test.ts`（8 项）：`resolveStaticIdentity` 功能（生产关闭 / 各模式解析 / 默认回退 / 数组首项 / 空字符串回退 / 非字符串字符串化）+ 结构性守护（`src/platform/**` 中 X-Actor/X-Role 头读取仅存在于 security 模块）+ `resolvePrincipal` 唯一实现守护 + 集成语义（production 关闭不可绕过，staging 为生产演练模式仍允许静态身份）；全量回归：1504 passed / 18 skipped（130 个测试文件）。

## [4.11.0] - 2026-08-19

### 新增（类型级反向依赖上移 core，Phase 35）

- 消除平台层对 agents 域的类型反向依赖（DEBT-11 已解决）：失败分类共享模型（`FailureCategory` / `FAILURE_CATEGORIES` / `isFailureCategory`）从 agents 域 `agents/analysis/root-cause-schema.ts` 上移至 **core 层唯一权威来源** `core/failure-category.ts`（core 为最底层、可被任意域依赖，符合依赖规则）。
- agents 域 `root-cause-schema.ts` 改为从 core 导入并 **re-export**（既有 API 完全兼容，`root-cause-agent.ts` 的 `FailureCategory` / `FAILURE_CATEGORIES` 使用不受影响）；`autonomous` 域经 agents 正常使用。
- 平台层 3 处 `import type { FailureCategory }` 改从 core 导入：`telemetry/telemetry-types.ts`、`telemetry/telemetry-service.ts`、`ops/real-run.ts`——**平台层至此对 agents 域零依赖**（结构上已由守护测试固化）。
- 新增脚本 `phase35:test`（构建 + 失败分类模型 + RCA / defect / telemetry / real-run 相关回归）。

### 变更

- `vitest.config.ts` coverage include 纳入 `src/core/failure-category.ts`（新模块计入覆盖率门禁）。
- `docs/TECH-DEBT.md`：DEBT-11（类型级反向依赖）已解决。

### 测试

- 新增 `tests/unit/core-failure-category.test.ts`（6 项）：分类清单完整性 / 守卫正反例 / core 与 agents re-export 同一权威源（同一数组引用，防双源漂移）/ agents 兼容可用 / core 分类清单与 RCA JSON Schema enum 完全一致（防分类改动漂移）/ **结构性依赖守护**（`src/platform/**` 全部源文件无 agents 域 import，防回归）；全量回归：1496 passed / 18 skipped（129 个测试文件）。

## [4.10.0] - 2026-08-19

### 新增（断言可视化接入 HTML 报告，Phase 34）

- 变废为用（DEBT-05 已解决）：将此前「仅被自身测试引用」的 `utils/assertion-visualizer.ts` 断言可视化引擎接入 `reports/html-reporter.ts`，HTML 报告新增 **4.4 断言可视化** 节，复用其 Diff View（JSON/TEXT/NUMERIC/BOOLEAN/SCHEMA 节点级差异）与 Assertion Heatmap（热度权重 0 绿 / 1-3 黄橙 / 4-5 红 + Flakiness Index）两大协议。
- 报告 4.4 节渲染内容：失败断言逐条输出节点级 Diff 明细表（路径/变更类型/期望/实际/说明），全通过时显示「无失败差异视图」；断言热力图矩阵表（断言/目标/路径/操作符/权重/失败率/运行数）覆盖全部声明式断言。
- 新增脚本 `phase34:test`（构建 + 断言可视化接入相关测试：html-reporter-visualization + assertion-visualizer + assertion-engine + path-extractor）。

### 变更

- `docs/TECH-DEBT.md`：DEBT-05（`utils/assertion-visualizer.ts` 未使用模块）已解决——接入 HTML 报告器对外提供能力，消除唯一「未使用模块」开放债。

### 测试

- 新增 `tests/unit/html-reporter-visualization.test.ts`（4 项）：失败断言输出 Diff 视图 / 全通过时无失败差异视图但输出热力图 / 无声明式断言时无可视化数据 / HTML 特殊字符转义防注入；全量回归：1490 passed / 18 skipped（128 个测试文件）。

## [4.9.0] - 2026-08-19

### 新增（环境策略职责边界与跨层一致性，Phase 33）

- 新增跨层一致性契约（DEBT-01 已解决）：平台层 `environmentTypeToTier`（dev/test→test、staging/preprod→preonline、production→production）与 `environmentTypeToMode`（dev→development、test→test、staging/preprod→staging、production→production）映射函数 + `PRODUCTION_LIKE_GUARD_TIERS`，作为 agent 层启用守卫 / 平台层动作分级 / 安全模块运行模式加固三层策略的互操作契约。
- **修复跨层漂移缺口**：agent 层 `resolveEnvironmentTier` 不识别平台层 `preprod` 环境名，此前 `preprod` 被解析为 test 档（危险动作可放行）；现正确归入 preonline 档（危险动作拒绝）。
- 新增职责边界文档 `docs/environment-policy-boundaries.md`：三层模型表、职责划分、互操作契约、5 条不变量、变更检查单。
- 新增脚本 `phase33:test`（构建 + 跨层一致性 + 相关回归）。

### 变更

- `docs/TECH-DEBT.md`：DEBT-01（双环境策略源）已解决（保留 + 边界文档化 + 跨层一致性校验）。

### 测试

- 新增 `tests/unit/environment-policy-coherence.test.ts`（15 项）：跨层映射契约与解析一致 / 生产类环境三模型一致（平台 isProductionLike ⇒ agent 生产类档位 ⇒ 运行模式生产安全） / 危险动作跨层拒绝一致（禁止动作清单全覆盖） / 纵深防御不变量（平台 deny ⇒ agent 必拒绝） / 禁止动作清单完整性 / 运行模式别名对齐；扩展 `tests/unit/environment-policy.test.ts`（preprod 档位）。

## [4.8.0] - 2026-08-19

### 新增（变异测试，Phase 32）

- 引入变异测试基础设施（Stryker + `@stryker-mutator/vitest-runner`，Vitest `related` 模式 + perTest 覆盖率分析，仅运行与变异点相关的测试）；新增 `stryker.config.mjs`：变异目标集聚焦平台 Critical 决策逻辑（生产安全 / RBAC / 审批中心 / Run 状态机 7 个源文件），`excludedMutations` 排除 `StringLiteral`，`concurrency=4`。
- 新增变异分数门禁（`thresholds: high=80 / low=70 / break=60`）：总体变异分数 98.96%（191 杀死 / 2 存活 / 0 无覆盖），高于 high 阈值；子模块 security 100% / approval-center 100% / rbac 98.44% / runs 96.55%。
- 新增脚本：`phase32:test`（构建 + 相关单测 + 完整变异门禁）/ `mutation:test` / `mutation:dry`（仅校验测试环境）。
- 变异报告落盘 `reports/mutation/mutation.html`（已入 `.gitignore`，与 `coverage/` 一致不入版本库）。

### 变更

- 依据变异测试甄别的真实缺口补齐测试（首次变异 85.49% → 补测后 98.96%）：访问决策四分支全字段形状断言（`{verdict, requiresApproval, rbacPassed, policy}`，防布尔字段被翻转）、`DEVELOPER`/`SERVICE_ACCOUNT` 权限矩阵、`listPermissions`、PlatformGate 审批不存在/无审批权限抛错与 reason/evidence 回退默认值、`resolvePlatformMode` trim/大小写规范化、静态身份来源 detail、审批 `clear()` 与 evidence 默认空数组、Run 状态机六状态完整转移表与终态空转移。
- `docs/TECH-DEBT.md`：DEBT-07（无变异测试与 Critical 变异门禁）已解决。

### 测试

- 新增 `tests/unit/run-schema.test.ts`（5 项：状态转移表 / 终态空转移 / canTransition 正反例 / transitionRun / isTerminal）+ 扩展现有 rbac/security/approval-center 测试；全量回归：1471 passed / 18 skipped（126 个测试文件）。
- 已知等价存活 2 项（已甄别）：`platform-gate.ts:43` evidence 回退 `??`→`&&`（perTest 覆盖率映射的保守假象，实测行为不同且新测试可杀死）、`run-schema.ts:75` runId 月份算术（需 mock Date 才能测，实践等价）。

## [4.7.0] - 2026-08-19

### 新增（迁移 down / 回滚，Phase 31）

- `Migration` 接口新增 `revert`（down）实现；`v1/base-schema` 回滚 = 删除全部 16 个集合表（`_migrations` 表保留为基础设施，记录由回滚流程删除）。
- 新增回滚核心：`resolveRevertTarget`（无已应用 → null；未指定取最新；指定必须为最新，禁止跳级回滚；目标迁移必须存在且实现 revert）与 `revertSqliteMigration` / `revertPostgresMigration`（回滚后同步删除 `_migrations` 记录，返回回滚迁移 id；可再次应用恢复）。
- CLI `migrate` 新增 `down` 子命令：`migrate down sqlite|postgres [--id <id>]`（回滚最新已应用迁移）与 `migrate down check`（展示两端已应用与可回滚状态）。
- 验证 backup→migrate→rollback→restore 完整链：升级前 `collectSnapshot` 备份 → 回滚 schema（集合表 + 记录删除）→ 重新应用迁移恢复 → `restoreSnapshot` + `verifyRestore` 三一致（Count / Checksum / Key ID）。结论：只要升级前有备份，迁移回滚不会造成数据永久丢失。

### 变更

- `docs/TECH-DEBT.md`：DEBT-09（迁移框架缺口：无 down/回滚）已解决。

### 测试

- 新增 `tests/unit/migrations-down.test.ts`（5 项：SQLite 回滚闭环/幂等空操作/目标解析边界/mock Pool 回滚/Postgres 空态）+ `tests/integration/migrations-rollback.test.ts`（2 项：真实 SQLite 回滚闭环 + `_migrations` 基础设施保留）；全量回归：1452 passed / 18 skipped（125 个测试文件）。

## [4.6.0] - 2026-08-19

### 新增（覆盖率补齐，Phase 30）

- `vitest.config.ts` coverage include 纳入 `src/platform/**`（DEBT-08 已解决）：平台层与核心/智能层共用同一门禁（行/函数/语句 ≥ 80，分支 ≥ 75）；`perf-harness.ts` 由独立性能套件（`tests/perf` + `vitest.perf.config.ts`）运行，排除以免以 0% 虚假稀释平台层覆盖率。
- 新增集中补测 `tests/unit/platform-coverage-gap.test.ts`（15 项）：覆盖平台层此前低于门槛的缺口模块——
  - EventBus：`clear` / `listenerCount(type|无参)` / `totalPublished`；
  - NotificationDispatcher：`notifyEvent` 模板与上下文后缀分支（含/省略 environment/projectId）、`buildNotificationMessage` 覆盖全部模板类型；
  - Migrations：PostgreSQL 迁移（`ensurePostgresMigrationsTable` / `listAppliedPostgres` / `applyPostgresMigrations` 幂等，mock Pool 规避 pg-mem 多列约束 DDL 局限）与 SQLite 迁移落盘验证；
  - EnvironmentPolicy：`describeDecision` 三种决策、无 custom 时回退单一策略源、`isProductionLike` 各档位；
  - Scheduler：`pause`/`resume` 非执行态边界、`requeueRetries` 环境过滤、`isJobTerminal`、`clear`；
  - WorkerRegistry：`count` / `getExecutor` / 未注册健康判定 / `healthyWorkers` 过滤 / `release` 下界 / down 心跳恢复 / 缺省选项构造；
  - WorkerPool：执行器抛非 Error 值 → FAILED 记录原文、`recoverOrphans` 回收无主 RUNNING Job；
  - CheckpointStore：`delete`（含不存在静默）/ `clear` / 空查询返回 null。
- 新增脚本 `phase30:test`（构建 + 平台层相关测试 + 完整覆盖率门禁校验）。

### 变更

- 平台层纳入覆盖率统计后，全量门禁（行/函数/语句 ≥ 80，分支 ≥ 75）在所有平台子模块均成立：events 96.66/100/90/100、notifications 95.65/95.5/100/100、scheduler 94.87/91.07/100/100、runs 96.82/90.32/100/100、ops 94.3/78.73/95.12/94.68、workers 93.51/81.81/96.55/98.88、api 89.66/77.91/90.54/92.57 等。
- `docs/TECH-DEBT.md`：DEBT-08（覆盖率缺口）已解决。

### 测试

- 新增 `tests/unit/platform-coverage-gap.test.ts`（15 项）；全量覆盖率：Statements 90.45 / Branch 79.77 / Functions 91.51 / Lines 92.03；全量回归：1445 passed / 18 skipped。

## [4.5.0] - 2026-08-19

### 新增（性能与容量基线，Phase 29）

- 新增性能基准测量模块 `src/platform/ops/perf-harness.ts`（唯一测量源）：覆盖 10/50/100/500 Runs 生命周期（createRun → Scheduler → Worker → startRun/completeRun）吞吐/延迟、Scheduler 队列吞吐、Audit 写入吞吐（含脱敏）、Telemetry 事件写入吞吐与内存稳定性；计时统一 `performance.now()`（µs），每项取 min-of-3 滤除 GC/调度抖动。
- 新增性能门禁 CLI `scripts/perf/run-perf.mjs`：`--baseline`（固化 `perf/baseline.json`）/ `--gate`（相对基线回归判定，延迟 > 2× / 吞吐 < 50% 即失败）/ `--json`。
- 新增 `tests/perf/platform-perf.test.ts`（Vitest sanity 门禁）+ `vitest.perf.config.ts`（`tests/perf/` 独立于默认 `npm test` 运行）。
- 新增脚本：`phase29:test` / `perf:test` / `perf:baseline` / `perf:gate` / `perf:report`。

### 修复（性能基准暴露的真实缺陷）

- **高吞吐下 ID 碰撞缺陷**：审计 / 调度 Job / 遥测事件 / 实体 / Run ID 原用 `Date.now().toString(36) + Math.random().toString(36).slice()` 组合，在容量基线（10 万+ ops/s 写入）下会碰撞导致「实体已存在」。新增 `src/core/id.ts`（`generateId`，crypto.randomUUID 128 bit 熵），统一替换 `audit-log` / `scheduler` / `telemetry-store` / `storage/repository` / `run-schema` 五处生成器；`generatePlatformRunId` 随机尾由 4 位 base36 升级为 32 位 hex。
- 新增回归守卫 `tests/unit/id.test.ts`（4 项）：同一毫秒内 10000 个 ID 无重复、`generatePlatformRunId` 5000 个无重复、格式断言。

### 变更

- 默认 `npm test` 通过 `vitest.config.ts` exclude 排除 `tests/perf/**`（性能套件单独运行，不影响全量回归计数与时长）。
- `docs/TECH-DEBT.md`：DEBT-06（性能基线缺失）与 DEBT-14（ID 碰撞）已解决。

### 测试

- 新增 `tests/unit/id.test.ts`（4 项）+ `tests/perf/platform-perf.test.ts`（2 项，sanity 门禁）；全量回归：1430 passed / 18 skipped（122 个测试文件）；`agent:test` 450 通过；性能门禁连续多轮 PASS（基线：500 Runs 生命周期 ~11k runs/s、create p95 < 3ms、Audit/Telemetry 10 万+ ops/s、内存增长 < 150MB）。

## [4.4.0] - 2026-08-19

### 新增（工程治理，Phase 28）

- 新增共享安全工具模块 `src/core/redact.ts`（`redactSensitive` / `SENSITIVE_KEYS`），供 Agent Tool 审计与平台 AuditLog 共用，消除平台层对 agents 域的反向依赖。
- 新增技术债登记 `docs/TECH-DEBT.md`（债务清单 + 阶段趋势，供每阶段维护）。
- 修复脱敏缺陷：字段名归一化分隔符（下划线/连字符），`api_key` 现在也能命中 `X-Api-Key` 等变体。

### 变更

- 配置模块统一：删除与 `env-loader.ts` 重复的 `config/env.ts`；`engine.ts` / `execution-run-tool.ts` 统一从 `env-loader.ts` 导入（TESTFLOW_* 环境变量覆盖单一来源）。
- `engine.ts` 移除冗余的 `applyEnvToConfig` 调用（`loadConfig` 已通过 `loadConfigFromEnv` 合并环境覆盖）。
- `src/agents/tools/tool.ts` 保留 `redactSensitive` / `SENSITIVE_KEYS` 再导出（API 兼容）。

### 移除

- 删除死代码 `src/utils/time.ts`（零引用）。

### 测试

- 新增 `tests/unit/redact.test.ts`（6 项）；全量回归：1426 passed / 18 skipped（121 个测试文件）；`agent:test` 450 通过。

## [4.3.0] - 2026-08-19

### 新增（生产安全加固，Phase 27）

- 新增 `src/platform/security/` 生产安全策略模块（单一权威来源）：运行模式统一解析、生产安全模式判断、不安全 JWT 密钥识别、默认口令策略、静态身份来源开关、Preflight 安全检查项。
- 生产/预发（production/staging）模式强制显式配置**非默认** `JWT_SECRET`：缺失或使用开发默认值 `dev-secret-change-me` 即拒绝装配（fail fast）与启动。
- 生产模式强制禁用默认种子口令（`admin/admin123` 等）与静态 `X-Actor`/`X-Role` 身份伪造（防身份伪造）。
- 运维只读端点 RBAC：`OPS_READ` 权限（ADMIN / RELEASE_MANAGER / SERVICE_ACCOUNT 持有），`/audit`、`/telemetry/cost`、`/jobs`、`/workers` 对无权限角色返回 403。
- 审批职责分离：审批人不能审批自己发起的申请（禁止自提自批）；审批 ID 由 `Math.random()` 改为 `randomUUID`（不可预测）。
- `decodeJwt` 加固：非法结构 / 非法 JSON payload 显式抛错，不静默返回。
- Preflight 新增「安全策略」检查项：运行模式 / JWT 密钥 / 默认口令 / 静态身份来源四合一，生产/预发违规返回 BLOCK。
- CLI `serve` 横幅展示运行模式与生产安全约束；仅非生产模式提示默认账号。

### 变更

- `RBAC` 权限模型新增 `OPS_READ`（影响：VIEWER/QA 访问审计、遥测成本、Job、Worker 端点由 200 变为 403，属预期安全收紧）。
- `server.ts` 新增 `HttpError`（带状态码的业务错误），读端点 RBAC 拒绝返回 403 而非 400。

### 测试

- 新增 `tests/unit/security.test.ts`（17 项）；扩充 `auth`、`approval-center`、`jwt`、`api-auth`、`web-dashboard`、`api-hardening`、`platform-scenarios` 用例。
- 全量回归：1420 passed / 18 skipped（120 个测试文件）。

### 修复

- 修复 package-lock.json 版本残留（3.0.0 → 4.3.0）。

## [4.2.0] - 2026-08-19

### 新增（生产验证闭环，Phase 26）

- 版本溯源与部署验收链（`/api/version`、构建溯源、回滚版本兼容）。
- 50 真实 TestCase 接入平台（`src/platform/test-assets/`）。
- 四形态真实 Run 执行引擎（smoke / sanity / regression / autonomous）。
- 故障恢复演练（S1 Worker Crash / S2 LLM 故障 / S3 存储故障 + 恢复指标）。
- 统一发布门禁（PASS / REVIEW / BLOCK + Agent 防绕过）。
- 备份恢复三一致校验 + 禁止自动重触发。
- 六类可观测告警（Run 失败 / 恢复 / 审批 / 成本 / 队列 / 心跳）。
- 30 Run 生产试运行（KPI + 10 条人工 QA 对照）。

## [4.1.0] - 2026-08-18

### 新增（生产化，Phase 25）

- SQLite / PostgreSQL 持久化与迁移、备份 / 恢复 / 冒烟 / Preflight。
- JWT 认证与用户体系（登录 / 刷新 / 登出 / 作用域）。
- 真实遥测（成本 / RCA / Flaky / Healing / Release）与指标自动激活。
- React Web Dashboard（15+ 页面）。
- API 加固：链路追踪 / 限流 / 统一错误契约 / 分页。

## [4.0.0] - 2026-08-18

### 新增（平台化，Phase 20-24）

- AI Test Platform 平台层（`src/platform`）：Project / Run 状态机 / Scheduler / Worker / RBAC / Approval / EventBus / Notification / HTTP API / 运维指标。
- 多业务接入、测试资产管理、持续回归、知识 / 成本 / 质量优化。
- 智能排序与风险预测、自治回归流水线、统一追踪、发布决策与生产验收。

## [3.5.0] - 2026-08-17

### 新增（Agent 化与能力沉淀，Phase 10-19）

- RCA / Flaky 治理、自愈、缺陷生命周期、审批状态机、可观测性、评估体系。
- 通用断言引擎、数据生成 / Mock 录制回放 / 动态并发、断言可视化。

## [3.4.0] - 2026-08-17

- 数据工厂（`--auto-setup`）+ 环境一致性检测（基线对比 + 断言注入）。

## [3.3.0] - 2026-08-16

- 并发执行：`--concurrency` / `--parallel`，p-limit 并发池，caseId 归档。

## [3.2.0] - 2026-08-16

- 多功能模块化：按功能分子文件夹、loader 递归扫描、迁移脚本分目录。

## [3.0.0] - 2026-08-15

### 破坏性变更

- TypeScript 重构：模块化分层 + 7 钩子 + 断言注册表 + 三格式报告。

## [2.0.0] - 2026-08-15

### 破坏性变更

- 插件式重构：场景处理器、按 scene 路由、模板通用化。

## [1.3.0] - 2026-08-15

- 文档去重合并、代码层重构（素材函数 / 步骤编号）。

## [1.2.0] - 2026-08-15

- 新增「项目说明格式规范」，四场景验证表更新。

## [1.1.0] - 2026-08-15

- 输出归档规则升级为 `output/<日期>/<功能名>/`，脚本支持 `--func`。

## [1.0.0] - 2026-08-12

- 交付包初始化。
