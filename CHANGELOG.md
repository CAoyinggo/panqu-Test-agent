# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 语义，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
