# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 语义，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
