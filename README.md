# 盼趣AI 测试执行流程（test-flow）

> 版本：v4.26.0（AI Test Platform 生产化 + 生产安全加固 + 工程治理 + 性能容量基线 + 覆盖率补齐 + 迁移回滚 + 变异测试 + 环境策略边界 + 断言可视化 + 依赖解耦 + 身份解析统一 + 时序卫生治理 + 非法角色拒绝安全加固 + QA 工作流产品化 + **Phase 40 工程化收尾：读端点 Project Scope 加固 / Defect 缺陷平台化 / 公开分享落地页 / 报告数据真实性 / 聚合缓存** + **Phase 41 Web 真实浏览器 E2E：Playwright 14 套件覆盖登录→项目→QA Home→Plan→Run→Defect→Report→Share→Approval→权限隔离→错误态→可访问性→键盘→响应式→性能，17 项关键功能验收 PASS** + **Phase 42 Web 前端工程化：Vitest 单元/组件测试（37 用例 / 覆盖 94.96%）+ CI 接入（web-e2e.yml 三档分级）+ 跨浏览器回归（WEB_E2E_BROWSERS 门控 chromium/firefox/webkit）** + **Phase 43 Web 交互正确性：写操作统一错误反馈 / 评论契约修复（{ body }）/ Run 全生命周期（新建 / Cancel / Assign）/ 测试资产与版本追溯 Web 暴露（TestAssets / AssetVersions）** + **Phase 44 真实浏览器 E2E 覆盖收口：RunCreate / Run 操作 / 测试资产 / 资产版本追溯 4 新套件 + 可访问性/键盘/响应式扩展新页面 + 单元覆盖缺口闭合（68 用例 / 行覆盖 99.67%）+ Chromium 87 E2E 全绿 + 跨浏览器验证** + **Phase 45 AI 测试质量评测：统一评测契约 + Ground Truth Registry + 8 领域 Benchmark（238 条 tracked 用例）+ 确定性规则评测 + 版本对比/回归门禁（P0 Miss / False Pass / Unsafe Healing / Skipped Critical 四安全指标为 0）+ AI Quality Web Dashboard + CLI（run/report/compare/regression）** + **Phase 46 AI 质量优化与持续改进闭环：统一 AI Feedback（8 渠道）/ Error Taxonomy + 聚类 / Improvement Proposal（离线评测 + Gate）/ Prompt·Model 版本管理 / A/B 对比 / 多目标评分 / Shadow·Canary·自动回滚 / Knowledge Learning·Quality·Decay / Continuous Evaluation·Benchmark 自动扩充·Change Impact·AI Release Gate·Audit / 持久化（跨重启保留）/ Web「AI 改进」Dashboard + CLI + API（写操作 RELEASE_APPROVE 人工门禁）** + **Phase 47 Web AI 页真实浏览器 E2E 覆盖：修复「AI 改进」路由可达缺陷（导航曾落 NotFound）+ E2E 种子注入 AI 质量闭环数据（反馈/提案/版本/实验/知识）+ Playwright 11 新用例（未认证重定向 / 7 Tab 渲染 / 错误聚类 / Gate PASS 提案 / Prompt·Model 版本 / Shadow·Canary / 知识 Review / AI 质量聚合 / RBAC 人工门禁 RELEASE_MANAGER 批准 / AI 质量页可达）→ Web E2E 98 全绿 + 全量 1736 通过** + **Phase 48 Continuous Evaluation 落地（43.20）：Nightly / Weekly / Release 定时评测真正可运行——真实 Benchmark → Compare → Detect Regression → Alert + Block Release，历史追踪 / 回归判定（Critical 上升 → BLOCK，普通下降 → REVIEW）/ 定向领域 Targeted Evaluation / 存储快照·导入持久化 / CLI（continuous run·list·status）/ API（GET + POST run 手动触发 RELEASE_APPROVE 门禁）/ Web「持续评测」Tab（历史 + 指标 + 手动触发）→ 13 用例 E2E 全绿 + 全量 1754 通过** + **Phase 49 Eval → Feedback 桥接 + Benchmark 自动扩充候选（43.2 / 43.21）：Evaluation 失败自动进入 Feedback Registry（BENCHMARK_FAILURE 渠道：EVALUATION 来源 / INCORRECT / prediction=actual / actual=expected / 待人工核验）+ 自动生成 Benchmark 扩充候选（PENDING_REVIEW，禁止自动并库）+ 幂等去重（重复跑评测不刷屏）+ BenchmarkCandidateStore Review 状态机（approve/reject 记录 reviewer/reviewedAt/reason）+ CLI（benchmark list·bridge·approve·reject）/ API（GET + POST bridge/approve/reject RELEASE_APPROVE 门禁）/ Web「Benchmark 扩充」Tab + runContinuousEval 自动桥接 → 15 用例 E2E 全绿 + 全量 1775 通过** + **Phase 50 Benchmark 候选并入：人工 APPROVED → Registry v2/v3 + HUMAN Ground Truth + MERGED 凭据，API/CLI/Web 人工门禁落地，Web E2E 103 全绿**）｜ 更新：2026-08-21 ｜ 维护：AI 测试智能体

**标准化、可一键执行的多业务 AI 功能测试智能体框架**。所有 AI 功能测试任务强制按此流程执行：每个业务功能在 `src/cases/{feature}/` 下独占一个子文件夹即可独立接入，当前内置 `wan3`（视频生成）作为示例模块，实际使用时可将任意业务（如 `user`、`order`、`payment`）替换接入，无需改动框架代码。

自 v4.0 起，框架以 **Modular Monolith** 方式叠加 `src/platform` AI Test Platform 平台层（Project / Run 状态机 / Scheduler / Worker / RBAC / Approval / EventBus / Notification / HTTP API / 运维指标），API 与 CLI 共用统一 Service Layer。平台层此后沿八条主线持续演进：**生产化与持久化**（SQLite / PostgreSQL、JWT 认证与用户体系、真实遥测、Web Dashboard、API 加固）、**生产验证闭环**（真实 Run 执行引擎、故障恢复演练、统一发布门禁、备份恢复、可观测告警）、**安全加固**（生产模式强制非默认密钥、静态身份防伪造、运维只读 RBAC、审批职责分离）、**工程治理**（覆盖率补齐、迁移回滚、变异测试、依赖解耦、身份解析统一、时序卫生治理）、**QA 工作流产品化**（Test Suite / Test Plan / Run Template / Asset Versioning / Collaboration / Run Report / QA Home）、**工程化收尾**（读端点 Project Scope 加固、Defect 缺陷平台化、公开分享落地页、报告数据真实性、聚合缓存）、**Web 真实浏览器 E2E 与体验质量**（Playwright 真实浏览器操作 / 17 项关键功能验收 / 可访问性 axe-core / 键盘导航 / 响应式 / 性能与轮询治理 / API 客户端治理）、**Web 交互正确性与平台能力暴露**（写操作统一错误反馈、评论契约修复、Run 全生命周期 Web 呈现、测试资产与版本追溯 Web 暴露）。

各里程碑的详细演进记录见下文 **「十二、版本历史」** 表。

📄 **[查看交互式 HTML 项目完整说明](file:///Users/mac/agents/test-flow-project-overview/test-flow-project-overview.html)**（含架构图与数据图表，本地打开）

流程：`[0 启动清单] → [1 需求输入] → [2 编写用例] → [3 代码核对] → [4 数据隔离分析] → [5 数据需求清单] → [6 脚本执行] → [7 输出报告]`

---

## 一、项目概述

test-flow 覆盖从用例定义、脚本执行、断言核验、数据生成、并发调度到多格式报告输出的完整链路，核心思想是**目录即模块**：新增业务只需在 `src/cases/` 下新建子文件夹并放入用例脚本，加载器自动递归扫描识别，无需改动任何框架代码。

**关键指标**

| 指标 | 数值 |
|---|---|
| 单元测试用例 | 1586 条通过 / 18 跳过（141 个测试文件，全量回归全绿） |
| Web 真实浏览器 E2E | 18 个 Playwright 套件（登录 / 项目 / 工作流 / Run / 新建 Run / Run 操作 / 缺陷 / 测试资产 / 资产版本追溯 / 报告 / 分享 / 审批 / 项目隔离 / 错误态 / 可访问性 / 键盘 / 响应式 / 性能），17 项关键功能验收 PASS |
| 全量覆盖率 | Statements 90.45 / Branch 79.77 / Functions 91.51 / Lines 92.03（含 `src/platform/**`） |
| 平台测试 | 单元 35 文件 + 集成 14 文件 + E2E 16 文件（Phase 40 新增 defects / phase40-scope 套件） |
| 断言操作符 | 17 个 |
| 核心引擎模块 | 13 个文件 |
| 平台层模块 | 19 个子模块（`src/platform/`） |
| 标准生命周期钩子 | 7 个 |
| 版本演进 | v1.0 → v4.18.0（29 个里程碑） |
| 运行时 | Node.js ≥ 20.11 |

**技术栈**：TypeScript + ESM（NodeNext 严格模式）、Vitest + v8 覆盖率、ajv JSON Schema 校验、p-limit 并发池、chokidar 文件监听、Docker 镜像化。

## 二、架构总览

源码按职责划分为九层，各层通过标准接口解耦，插件式扩展点在每一层都预留了登记入口。

| 层 | 职责 | 关键文件 |
|---|---|---|
| `src/core` | 核心引擎、执行流水线、断言引擎、环境检测、数据工厂 | `engine.ts` `pipeline.ts` `assertion-engine.ts` `env-checker.ts` |
| `src/cases` | 用例定义与加载，按功能分子文件夹（多业务即插即用） | `define.ts` `loader.ts` `registry.ts` `wan3/` |
| `src/assertions` | 业务断言库 + 通用引擎适配器 | `wan3-adapter.ts` `db-check.ts` `billing-check.ts` |
| `src/reports` | 多格式报告输出（HTML/JSON/JUnit + 工厂） | `html-reporter.ts` `factory.ts` |
| `src/integrations` | 外部集成：HTTP、计费、素材、通知 | `http.ts` `billing.ts` `notifiers/feishu.ts` |
| `src/plugins` | 插件式场景处理器（新模块在此扩展） | `scenes/video.ts` `loader.ts` |
| `src/config` | 环境配置与 CLI 参数解析（schema 校验） | `config.ts` `environments.json` |
| `src/utils` | 通用工具：数据生成、Mock 录制回放、并发、可视化、度量 | `data-generator.ts` `mock-recorder.ts` `assertion-visualizer.ts` |
| `src/platform` | ★ AI Test Platform 平台层（v4.0-v4.17）：Project / Run 状态机 / Scheduler / Worker / RBAC / Approval / EventBus / Notification / Audit / Operations / Service / API / 存储（SQLite/PostgreSQL）/ Auth / Telemetry / Ops / Security / Test Assets / Workflow | `projects/` `runs/` `scheduler/` `workers/` `rbac/` `approval-center/` `events/` `notifications/` `audit/` `operations/` `service/` `api/` `storage/` `auth/` `telemetry/` `ops/` `security/` `test-assets/` `workflow/` |

数据流：`CLI 入口 → 核心引擎 → 场景处理器 / 7 钩子 → 执行流水线 → 断言系统 / 数据工厂 / 环境检测 / 并发控制 → 报告四通道 + 飞书通知`。

平台数据流（v4.0 / v4.1）：`API / CLI / Scheduler → 统一 PlatformService → Project / Run 状态机 → TestJob 队列 → Worker 执行 → Checkpoint / Audit / EventBus → Notification / 运维指标`。

## 三、执行流程

单用例执行由流水线驱动，三步装配：先跑默认断言，再跑通用断言引擎（DSL），最后跑业务适配器，串行叠加核验同一组执行数据。

```
DataFactory setup 准备数据
  → 步骤逐条执行（scene-handler）
  → 运行默认断言（runDefaultAssertions）
  → 通用断言引擎（runGenericAssertions）
  → 业务适配器（runAdapterAssertions）
  → DataFactory teardown 清理
  → 输出报告（四通道 + 飞书）
```

**数据工厂**（v3.4）：在流水线 step 1 前执行 `setup`、teardown 后执行 `teardown`，通过 `--auto-setup` 开关启用，默认由 `NoopDataFactory` 空实现兜底，行为完全向后兼容。

**环境一致性检测**（v3.4）：默认开启。首次执行采集快照并持久化为 `env-baseline.json`，后续执行对比基线，自动识别积分余额骤变、7 天消耗异常、模型上下线、单价变更与配置变更，差异项自动注入断言检查项；检测失败时降级跳过，不影响主流程。

**并发执行**（v3.3）：按 feature 分组——组内串行（避免同业务积分冲突），组间并行（缩短全量回归时间）；串行模式（默认）与改造前行为完全一致。

## 四、断言系统（核心）

断言系统采用「通用断言引擎 + 业务适配器」双架构：通用核心不依赖任何业务逻辑，业务侧通过适配器桥接存量断言，保证向后兼容。

### 通用断言引擎

核心入口为 `runGenericAssertions`，提供四种规则工厂：

- `assertAll`：AND 组合，全部通过才算过
- `assertAny`：OR 组合，任一通过即可
- `assertSoft`：软断言，失败不中断继续收集
- `rule`：单条规则

`runGroup` 支持模式归一化（`all/any/soft`）及 `and/or` 组合子别名；`runRule` 内置超时、重试、`durationMs` 计时与上下文快照捕获。

### 17 个断言操作符

| 类别 | 操作符 | 说明 |
|---|---|---|
| 比较类 | `equals` / `notEquals` | 严格相等 / 不相等 |
| 比较类 | `gt` / `gte` / `lt` / `lte` | 数值大小比较 |
| 比较类 | `deepEquals` | 对象/数组深比较 |
| 集合类 | `contains` / `notContains` | 字符串或数组包含 |
| 集合类 | `in` / `notIn` | 成员归属 |
| 存在性 | `exists` / `notExists` | 字段存在性 |
| 其他 | `regex` | 正则匹配 |
| 其他 | `type` / `length` | 类型与长度校验 |
| 其他 | `jsonSchema` | 基于 ajv 的真实 JSON Schema 校验（异步，带编译缓存） |

### JSON Path 提取

`path-extractor.ts` 提供 `extractPath`、`pathExists`、`formatValue`，增强版 `extractPathWithMeta` 返回 `{value, matched, path, parent, lastKey}`。支持点号路径、数组索引与通配符 `[*]`，最大递归深度 10，通配符语义为「命中任一项即通过」。

### 断言可视化引擎

`assertion-visualizer.ts` 将断言失败、历史指标与套件断言矩阵转化为结构化 JSON，输出严格遵循 `diff_view + history_trend + assertion_heatmap` 三协议：Diff View 支持 JSON/Object 递归节点级差异（ADDED/REMOVED/MODIFIED + JSON Path）、文本字符偏移、数值 absolute/relative diff、Schema 错误解析；History Trend 关联通过率、平均耗时与并发度；Heatmap 按权重着色（0 绿 / 1-3 黄橙 / 4-5 红），并计算 `flakiness_index`。

DSL 语法完整说明见 [docs/assertion-dsl.md](docs/assertion-dsl.md)。

## 五、三大执行能力

| 能力 | 模块 | 核心机制 | 关键接口 / 参数 |
|---|---|---|---|
| 数据生成器 | `src/utils/data-generator.ts` | 11 种生成器 + mulberry32 种子 PRNG（结果可复现），内置边界值生成与 `{{gen.*}}` 占位符解析 | `generateData()` `generateBatch()` `generateBoundaryValues()` `resolvePlaceholders()` |
| Mock 录制回放 | `src/utils/mock-recorder.ts` | fetch monkey-patch 录制真实响应为 fixture，回放时按 URL/Method 匹配，缺失响应走 onMissing 策略 | `createRecordSession()` `createReplaySession()`；CLI `--record` / `--replay` |
| 动态并发策略 | `src/utils/concurrency-controller.ts` | 滑动窗口 + 基于成功率的自适应调整，纯函数 `adjustConcurrency()` 便于单测；提供变化曲线 | `DynamicConcurrencyController`；CLI `--dynamic-concurrency` `--concurrency-min/max` |

三者形成闭环：数据生成器产出隔离数据 → 录制回放稳定复现接口 → 动态并发在可控水位下加速回归。引擎层对 `--record` 与 `--replay` 做互斥校验，防止参数冲突。

## 六、测试体系

基于 Vitest（含 v8 覆盖率）。全量 `npm test` 共 **141 个测试文件、1586 条用例通过 / 18 跳过**（含旧用例，无回归）；`agent:test` 450 条（Phase 1-23 行为保持）。

**核心引擎单元测试（8 个文件、225 条）**

| 测试文件 | 用例数 | 覆盖主题 |
|---|---|---|
| `assertion-operators.test.ts` | 55 | 17 操作符全量 + 边界 + ajv Schema |
| `data-generator.test.ts` | 47 | 生成器、PRNG 复现、边界值、占位符 |
| `assertion-visualizer.test.ts` | 36 | Diff/趋势/热力图三协议 + schema 校验 |
| `path-extractor.test.ts` | 25 | 路径提取、通配符、元数据 |
| `assertion-engine.test.ts` | 22 | AND/OR/soft 组合、超时重试、快照 |
| `dynamic-concurrency.test.ts` | 17 | 成功率自适应、水位约束 |
| `mock-recorder.test.ts` | 15 | 录制/回放匹配、fixture 缺失策略 |
| `define.test.ts` | 8 | 用例定义辅助函数 |

覆盖率门禁配置于 `vitest.config.ts`：行覆盖 ≥ 80%、函数覆盖 ≥ 80%、分支覆盖 ≥ 75%、语句覆盖 ≥ 80%；v4.6.0（Phase 30）起 coverage include 纳入 `src/platform/**`，平台层全子模块均满足该门禁（全量 Statements 90.45 / Branch 79.77 / Functions 91.51 / Lines 92.03）。

**AI Test Platform 测试（v4.0 / v4.1）**

| 组 | 文件 | 用例 | 覆盖主题 |
|---|---|---|---|
| `platform:test` | 19 个单元文件 | 208 | Project / Storage / SQLite / PostgreSQL / Scheduler / Worker / RBAC / Approval / Notification / Checkpoint / Idempotency / Metrics / JWT / Auth / 作用域 / Telemetry / Activation / Ops |
| `platform:integration` | 10 个集成文件 | 64 | Run 生命周期 / Checkpoint 恢复 / 崩溃回收 / HTTP 全链路 / SQLite 持久化 / 认证 / 遥测流水线 / Web Dashboard / API 加固 / 生产就绪 |
| `platform:e2e` | `platform-scenarios.test.ts` | 8 | S1-S8 核心场景（见「七、AI Test Platform 平台层」） |

**性能与容量基线**（v4.5.0 / Phase 29）：`tests/perf/` 套件 + `src/platform/ops/perf-harness.ts`（唯一测量源）覆盖 10/50/100/500 Runs 生命周期（createRun → Scheduler → Worker → complete）吞吐/延迟、Scheduler / Audit / Telemetry 写入吞吐与内存稳定性。三类入口：`npm run perf:test`（Vitest sanity 门禁）、`npm run perf:baseline`（固化 `perf/baseline.json`）、`npm run perf:gate`（相对基线回归门禁，相对退化 > 2× 延迟 / < 50% 吞吐即失败）。默认 `npm test` 已排除 `tests/perf/`（经 `vitest.perf.config.ts` 单独运行）。

**平台层覆盖率补齐**（v4.6.0 / Phase 30）：新增 `tests/unit/platform-coverage-gap.test.ts`（15 项）补齐 events / notifications / migrations(Postgres) / environment-policy / scheduler / workers / checkpoint 缺口；`perf-harness.ts` 由独立性能套件运行，排除以免以 0% 虚假稀释平台层覆盖率。验收：`npm run phase30:test`（构建 + 平台层相关测试 + 完整覆盖率门禁）。

**迁移 down / 回滚**（v4.7.0 / Phase 31，DEBT-09）：`Migration.revert` 回滚实现（`v1/base-schema` 回滚 = 删除全部集合表）、`resolveRevertTarget` 仅允许回滚最新已应用迁移（禁止跳级）、SQLite / Postgres 回滚函数与 CLI `migrate down` 子命令；新增 `tests/unit/migrations-down.test.ts`（5 项）+ `tests/integration/migrations-rollback.test.ts`（2 项，backup→migrate→rollback→restore 三一致闭环）。验收：`npm run phase31:test`（构建 + 迁移/运维相关测试）。

**变异测试**（v4.8.0 / Phase 32，DEBT-07）：引入 Stryker + `@stryker-mutator/vitest-runner`（`testRunner: 'vitest'`、`vitest.related: true` 仅跑相关测试、`coverageAnalysis: 'perTest'`）。变异目标集聚焦平台 Critical 决策逻辑 7 个源文件（`security/index.ts`、`rbac/rbac.ts`、`rbac/platform-gate.ts`、`rbac/access-chain.ts`、`approval-center/approval-center.ts`、`approval-center/approval-schema.ts`、`runs/run-schema.ts`），`excludedMutations` 排除 `StringLiteral`，`concurrency=4`。门禁 `thresholds: high=80 / low=70 / break=60`。首次变异 85.49% → 依据存活缺口补测 18 项（访问决策四分支全字段形状断言 / 权限矩阵 / listPermissions / Gate 错误路径与回退 / 审批 clear 与 evidence 默认 / Run 状态机六状态转移表 / security trim 规范化）→ **总体变异分数 98.96%**（191 杀死 / 2 存活 / 0 无覆盖），security 100% / approval-center 100% / rbac 98.44% / runs 96.55%。验收：`npm run phase32:test`（构建 + 相关单测 + 完整变异门禁）；变异报告落 `reports/mutation/mutation.html`（不入库）。

**环境策略职责边界与跨层一致性**（v4.9.0 / Phase 33，DEBT-01）：三层环境策略模型职责边界文档化（`docs/environment-policy-boundaries.md`）——agent 层执行启用守卫（`src/config/environment-policy.ts`，能否执行）/ 平台层动作分级（`src/platform/projects/environment-policy.ts`，要不要审批）/ 安全模块运行模式加固（`src/platform/security/index.ts`，运行安全级别），三者构成纵深防御。平台层新增跨层互操作契约 `environmentTypeToTier`（dev/test→test、staging/preprod→preonline、production→production）、`environmentTypeToMode`（dev→development、test→test、staging/preprod→staging、production→production）与 `PRODUCTION_LIKE_GUARD_TIERS`；新增 `tests/unit/environment-policy-coherence.test.ts`（15 项）守护 5 条不变量（映射一致 / 生产类三模型一致 / 危险动作跨层拒绝一致 / 平台 deny ⇒ agent 必拒绝 / 禁止动作清单完整性），并修复 agent 层不识别平台层 `preprod` 环境名的跨层漂移缺口（现归入 preonline 档，危险动作拒绝）。验收：`npm run phase33:test`（构建 + 跨层一致性 + 相关回归）。

**断言可视化接入**（v4.10.0 / Phase 34，DEBT-05）：将此前仅被自身测试引用的断言可视化引擎 `utils/assertion-visualizer.ts` 接入 HTML 报告器（`reports/html-reporter.ts`，变废为用），报告新增 **4.4 断言可视化** 节——失败断言逐条渲染 Diff 视图（JSON/TEXT/NUMERIC/BOOLEAN/SCHEMA 节点级差异明细：路径/变更类型/期望/实际/说明），全通过时显示「无失败差异视图」；断言热力图矩阵覆盖全部声明式断言（权重 0 绿 / 1-3 黄橙 / 4-5 红 + Flakiness Index + 失败率 + 运行数）。新增 `tests/unit/html-reporter-visualization.test.ts`（4 项）守护接入行为与 HTML 转义。验收：`npm run phase34:test`（构建 + 断言可视化接入相关测试）。

**类型级反向依赖上移 core**（v4.11.0 / Phase 35，DEBT-11）：失败分类共享模型（`FailureCategory` / `FAILURE_CATEGORIES` / `isFailureCategory`）从 agents 域 `agents/analysis/root-cause-schema.ts` 上移至 **core 层唯一权威来源** `src/core/failure-category.ts`，agents 域改为从 core 导入并 re-export（既有 API 完全兼容）；平台层 3 处（`telemetry-types.ts` / `telemetry-service.ts` / `real-run.ts`）的 `import type { FailureCategory }` 改从 core 导入——**平台层对 agents 域零依赖**。新增 `tests/unit/core-failure-category.test.ts`（6 项）守护：分类清单完整性与守卫正反例 / core 与 agents re-export 同一权威源（同一数组引用防双源漂移）/ core 分类清单与 RCA JSON Schema enum 完全一致（防分类改动漂移）/ **结构性依赖守护**（`src/platform/**` 全部源文件无 agents 域 import，防回归）。验收：`npm run phase35:test`（构建 + 失败分类模型 + RCA / defect / telemetry / real-run 相关回归）。

**身份解析统一**（v4.12.0 / Phase 36，DEBT-12）：审计确认 `resolvePrincipal` 为唯一身份解析实现（无历史版本残留），并将「静态身份来源」的守卫与解析收敛到 security 模块——新增 `resolveStaticIdentity(mode, headers)`：production 返回 `null`（防身份伪造不可绕过），其余模式从 X-Actor/X-Role 头解析（数组取首项；无 actor 默认 `api`，无 role 默认 `VIEWER`）；`api/server.ts` 静态 Token 回退改调该函数，不再直接读取 `x-actor`/`x-role` 头。新增 `tests/unit/identity-resolution-guard.test.ts`（8 项）守护：功能行为 / **结构性不可绕过**（`src/platform/**` 中 X-Actor/X-Role 头读取仅存在于 security 模块）/ `resolvePrincipal` 唯一实现 / 集成语义（production 关闭，staging 生产演练模式仍允许静态身份）。v4.13.1 补充：静态身份 role 经 `rbac.isRole` 校验，非法 X-Role（如 HACKER）拒绝 401（不再 `as Role` 硬断言），并新增 isRole 守卫 + 结构性守护测试。验收：`npm run phase36:test`（构建 + 身份解析守护 + security / auth / RBAC 相关回归）。

**E2E 时序卫生治理**（v4.13.0 / Phase 37，DEBT-13，**技术债清零**）：审计确认 E2E/集成测试已普遍采用健壮模式——随机端口（`server.listen()` 无参 / `listen(0)`）、固定时钟注入（`FIXED_ISO`，固定输入→固定输出，非 flaky）、`Date.now()` 生成唯一 ID、轮询 + 超时等待；未发现硬编码端口 / 运行时时间戳固定字面量断言 / 固定长 sleep 残留。新增 `tests/unit/e2e-timing-hygiene.test.ts`（4 项）结构性守护固化：禁止硬编码监听端口、禁止时间字段固定 ISO 字面量断言（`FIXED_ISO` 注入除外）、禁止 ≥1000ms 固定 sleep（应为轮询+超时）、现状基线确认。验收：`npm run phase37:test`（构建 + 时序卫生守护 + 代表性 E2E/集成回归）。

**Web 真实浏览器 E2E 与体验质量**（v4.16.0 / Phase 41）：将 Web Dashboard 从「代码正确 + HTTP 正确」提升到「真实浏览器操作正确 + 用户流程完整 + UI 状态正确 + 可访问 + 可回归」。基础设施：Playwright（`@playwright/test@1.62.1`）+ Chromium；内存态测试服务器 `tests/e2e/web/e2e-server.ts`（平台 + Web 构建产物，`WEB_E2E_PORT=8799`，Playwright `webServer` 自动拉起 + 种子数据）；共享助手 `helpers.ts`（UI 登录 / 会话注入 / API 认证头）。**14 个 E2E 套件**覆盖 17 项关键功能验收：`auth`（登录成功/错误密码/Token 失效）、`project`（项目列表/Run 计数/失败计数）、`workflow`（Suite→TestCase→Plan→Run→快速操作）、`run`（状态/进度/风险/覆盖/失败明细/RCA/实时刷新/无效 ID 错误态）、`defect`（从失败创建缺陷/状态流转/详情）、`report`（关键指标/无 JSON 污染/导出）、`share`（分享链接/无 Token 只读/不泄漏 JWT/非法 token 拒绝）、`approval`（发布审批/驳回/职责分离）、`project-isolation`（qa-a 见 wan3 / qa-b 见 order / 跨项目 API 403）、`error-state`（404/网络失败/限流错误态）、`accessibility`（axe-core wcag2a/aa/21a/21aa/best-practice 逐页扫描无 critical/serious）、`keyboard`（Tab 可达/焦点可见/回车提交）、`responsive`（1440/1280/1024/390/375 五档视口无溢出）、`performance`（首屏阈值/轮询治理无 429/无 console error/JS 包 < 1MB）。同阶段修复真实缺陷：登录 token 字段对齐、RunDetail 死循环刷爆限流 429、QA Home 项目作用域泄漏（Runs/Approvals 未按 scopes 过滤）、分享页路由与只读渲染、文本块链接仅靠颜色区分、按钮/徽标对比度、登录页无 h1、表单控件无可访问名、焦点不可见、窄屏导航溢出、长 ID 断行等。验收：`npm run web:e2e:test`（构建平台 + 构建 Web + Playwright 全量）；报告见 `docs/phase41-web-e2e-report.md` / `docs/phase41-frontend-quality.md` / `docs/phase41-acceptance-report.md`。

**Web 前端工程化：单元/组件测试 + CI 接入 + 跨浏览器回归**（v4.17.0 / Phase 42）：为 Web Dashboard 补齐三层工程化保障。单元/组件测试：Vitest 4.1 + jsdom + React Testing Library（`web/vitest.config.ts` 独立配置），6 个测试文件 37 条用例（api 契约 / usePolling / UI 组件 / Login / 环境探针），v8 覆盖率语句 94.96% / 行 96.09%（`ui.tsx`、`usePolling.ts`、`Login.tsx` 语句 100%）；修复 Node ≥22 实验性 `localStorage` 不可用于测试的环境问题（`test-setup.ts` 内存版 `MemoryStorage` 兜底）。CI 接入：新增 `.github/workflows/web-e2e.yml` 三档分级（`web-unit` 门禁 / `web-e2e-chromium` 门禁 / `web-e2e-cross-browser` Nightly 跨浏览器全量），E2E 服务器内存态可离线确定性执行，无需 Secrets；新增脚本 `web:test` / `web:test:coverage` / `web:e2e:cross`。跨浏览器回归：`playwright.config.ts` 增加 `WEB_E2E_BROWSERS` 门控（默认仅 Chromium、`all` 三浏览器、逗号列表指定子集），firefox / webkit 冒烟验证通过。验收：`npm run web:test`（37 用例）+ `npm run web:e2e:test`（74 用例 Chromium）+ `WEB_E2E_BROWSERS=all`（三浏览器全量）；报告见 `docs/phase42-web-engineering-report.md`。

**Web 交互正确性与平台能力暴露**（v4.18.0 / Phase 43）：修复 Web Dashboard 交互正确性缺口并将平台能力完整暴露到 Web 界面。写操作统一错误反馈：`Defects.tsx`（create/status/assign）与 `RunDetail.tsx`（Run Again / Clone / Template / Share / Comment / Cancel / Assign 经 `runAction` 包装）补 try/catch + 错误 banner，失败不再静默 unhandled rejection；**评论契约修复**（服务端读 `c.body.body`，此前前端发 `{ text }` → 200 但正文恒为空，改为 `{ body }`）；`api.ts` 补 `del`（DELETE）；`Runs.tsx` 支持 `?project=` 项目过滤（QA Home「看 Runs」直达项目视角）。Run 全生命周期 Web 呈现：新建 Run 页（`/runs/new`，全参数——项目/环境/触发/Feature/Plan/Suite/Template/模式/预算/Release 门禁/资产版本，成功跳详情、失败错误 banner）+ Cancel（仅 QUEUED/RUNNING 显示）+ Assign（逗号分隔多用户，空输入禁用）。测试资产 Web 暴露：`/assets`（TestAssets：统计卡片 + 资产列表，链接版本追溯）+ `/assets/:id`（AssetVersions：版本历史 + 字段级对比），全部复用 Phase 39-40 已有后端端点、零后端改动。测试覆盖补强：**RunDetail 回归测试扩展至 14 用例 → 行覆盖 100%**（评论契约 / Cancel 条件 / Run Again / Clone / Template / Share / Assign / 空输入 guard / 写失败错误 banner / 加载失败降级 / 报告 failures+RCA+decisionTrace / 评论 @badge / 审批表格），新增 RunCreate（3 用例）/ TestAssets（2）/ AssetVersions（2）测试；全量 **59 用例 / 行覆盖 95.12%**，`tsc -b` 通过。验收：`cd web && npx vitest run --coverage`（59 passed）；报告见 `docs/phase43-summary.md`。

**AI 质量优化、反馈学习与持续改进闭环**（v4.21.0 / Phase 46）：让 AI Test Platform 形成「测试 AI 本身」的持续优化闭环（Failure → Error Analysis → Root Cause → Improvement Proposal → Candidate → Offline Evaluation → Regression Benchmark → Approval → Activate → Observe → Learn）。统一 AI Feedback 契约（`src/ai-quality/contract.ts`，43.1/43.2）：domain / prediction / actual / feedbackType / source / channel / verified，接入 8 渠道（Human Correction / RCA Verification / Defect Review / Release Review / Healing Review / Benchmark Failure / Production Incident / Flaky Confirmation），AI 预测 vs 人工真值自动记 INCORRECT，人工核验门禁。错误分类与聚类（43.3/43.4）：统一 Error Taxonomy（WRONG / MISSING / OVER_PREDICTION / UNDER_PREDICTION / DUPLICATE / UNSAFE / INCONSISTENT / LOW_VALUE），确定性聚类键 domain+category（聚类 id 恒定 → 提案幂等去重），ErrorCluster（count / cases / suspectedCause / evidence）。改进提案（43.5/43.6/43.11）：autoProposals 从聚类自动生成（幂等），recordEvaluation 离线评测 baseline vs candidate → gateVerdict（PASS/REVIEW/BLOCK），状态机 PROPOSED → EVALUATING → APPROVED → ACTIVATED / REJECTED / ROLLED_BACK。Prompt / Model 版本管理（43.7/43.8）+ A/B 对比（Accuracy / Latency / Cost / Failure Rate / Safety 五维，43.9）+ 多目标评分（Quality / Safety / Latency / Cost，保留原始指标，43.10）。Shadow（只读不生效）/ Canary（5%→20%→50%→100%，异常自动停止、严重自动回滚）/ 自动回滚恢复基线（43.12-43.14）。Knowledge 学习 / 质量 / 衰减（43.15-43.17）：错误 → Verified → Candidate → 人工 Review → Activate（禁止 LLM 直接进生产 Knowledge）；EffectiveWeight 综合 usage / success / failure / age（持续有效减缓衰减、频繁失败快速降权）。运营能力（43.19-43.24）：Continuous Evaluation（Critical Regression → Alert + Block Release）、Benchmark 自动扩充（真实失败 → Verified GT → Benchmark Candidate → Review）、Change Impact（变更 → Affected Benchmarks/Agents/Projects/Runs → Targeted Evaluation）、AI Release Gate（Code + AI Release 双门禁）、Improvement Audit 完整链路。持久化：snapshot / restore + `persistToFile` / `loadFromFile`（原子写），server 配置 `aiQualityStateFile` 跨重启保留改进闭环。API（43.26）：/api/ai-feedback（GET + POST :id/verify）/ ai-errors / ai-improvements（GET + approve / reject）/ prompts（+ :id/versions）/ models / experiments（GET + POST）/ knowledge/review / ai-quality（+ trends）；写操作统一 RELEASE_APPROVE 门禁（QA 403，禁止 AI 自批），未认证 401。CLI（43.25）：agent:ai-quality / feedback list·verify / eval errors·improve / prompt list·compare / model list·compare / improvement list·approve·reject / knowledge review / canary status·promote·rollback。Web Dashboard（43.18/43.22）：「AI 改进」页 7 Tab（待核验反馈 / 错误聚类 / 改进提案 / Prompt·Model 版本 / Shadow·Canary 实验 / 知识 Review / AI 质量），审批仅 RELEASE_MANAGER / ADMIN 可执行（非审批角色只读）。测试：**86 新用例全绿**（单元 8 文件 68 + 集成 10 + E2E 8，含核心闭环 S1-S8）。验收：`npm run agent:ai-quality`；报告见 `docs/phase46-summary.md`，详见 `docs/ai-quality/`。

**Web「AI 质量 / AI 改进」页真实浏览器 E2E 覆盖**（v4.22.0 / Phase 47）：修复复扫发现的「AI 改进」页可达性缺陷（`web/src/App.tsx` 曾缺 `/ai-improvement` 路由导致导航落 NotFound，现补 Route 正常可达）。E2E 种子注入（`tests/e2e/web/e2e-server.ts`）：`seedAiQuality()` 确定性注入 AI 质量闭环数据（未核验 INCORRECT 反馈 / 自动提案 → Gate PASS 可审批 + APPROVED / Prompt risk v1·v2 / Model deepseek v3·v4 / Shadow COMPLETED + Canary RUNNING@5% / 知识候选 PENDING_REVIEW），经 `createPlatformServer({ aiQuality })` 注入；`WebE2eSeed` 新增 `aiQuality` 清单字段。真实浏览器 Playwright E2E（`tests/e2e/web/ai-improvement.spec.ts`，**11 新用例**）：未认证重定向 / 导航 + 7 Tab + QA 只读横幅 / 待核验反馈（QA 核验禁用）/ 错误聚类 / 改进提案（Gate PASS + 已审批）/ Prompt·Model 版本 / Shadow·Canary 实验（QA 创建禁用）/ 知识 Review / AI 质量聚合指标 / **RBAC 人工门禁：RELEASE_MANAGER 批准 → 成功横幅 + APPROVED** / Phase 45 AI 质量页可达。脚本：`web:e2e:ai` + `phase47:test`。验收：**Web E2E 98 用例全绿**（87 存量 + 11 新增）、`npm test` **1736 通过 / 0 失败**、`platform:integration` 94 / `platform:e2e` 16。报告见 `docs/phase47-summary.md`。

**Continuous Evaluation 落地**（v4.23.0 / Phase 48）：把 Phase 46 的 `ContinuousEvalSchedule` 常量升级为**真正可运行的定时评测闭环**（43.20）。新增 `src/ai-quality/continuous-eval.ts`：`ContinuousEvalStore`（历史存储，latest / 按 schedule 过滤 / snapshot·import 快照持久化）+ `runContinuousEvaluation`（真实运行 `runAllEvaluation` 全量 8 领域或定向领域 → Compare 最近 baseline → `detectRegression` 回归判定：**Critical 指标上升（P0 Miss / False Pass / Unsafe Healing）→ verdict BLOCK + alertSent + releaseBlocked；普通 Overall 下降 → REVIEW；无回归 → PASS**；首次运行只记录基线不判回归）。回归判定记录逐条 reasons（可回答「为什么判回归」）。调度常量：nightly `0 2 * * *` / weekly `0 3 * * 1` / release `release-trigger`（发布前强制门禁）。集成：`AIAQualityService` 新增 `continuousEval` store + `runContinuousEval`（审计记录 + 持久化）；API（43.26）`GET /api/ai-quality/continuous-evals`（列表 + schedules）+ `GET .../:id` + `POST .../run`（手动触发，RELEASE_APPROVE 人工门禁，QA 403）；CLI（43.25）`agent:continuous:run|list|status`；Web「AI 改进」页新增第 8 个「持续评测」Tab（历史表格 Schedule/Overall/verdict/Alert/Block + 指标卡最近 Overall/最近判定/Alert/Block Release + 手动触发按钮，非审批角色禁用）。测试：**单元 11（含 Critical Regression → BLOCK+Alert+BlockRelease / 普通下降 → REVIEW / 定向领域 / 快照往返）+ 集成 7（含 POST run 真实运行 + RBAC）+ E2E 2（持续评测 Tab 历史渲染 + RELEASE_MANAGER 手动触发）**，AI 改进页 E2E 13 用例全绿；`npm test` **1754 通过 / 0 失败**；Overall 93.6%、关键安全指标（P0 Miss / False Pass / Unsafe Healing / Skipped Critical）为 0。报告见 `docs/phase48-summary.md`。

**Eval → Feedback 桥接 + Benchmark 自动扩充候选**（v4.24.0 / Phase 49）：打通「Benchmark Failure → Feedback → 聚类 → 提案」自动链路（43.2 / 43.21）。新增 `src/ai-quality/eval-bridge.ts`：`extractEvalFailures`（只提取 **tracked 失败用例**，跳过 passed 与未 tracked——未追踪无 Ground Truth 绝不虚构反馈）+ `bridgeEvalReport`（每条 tracked 失败 → BENCHMARK_FAILURE 渠道反馈：EVALUATION 来源 / INCORRECT / prediction=actual / actual=expected / verified=false 待人工核验 + PENDING_REVIEW 候选；**幂等去重**：同 caseId+期望/实际已在库则跳过）+ `BenchmarkCandidateStore`（Review 状态机 approve→APPROVED / reject→REJECTED，记录 reviewer/reviewedAt/reason；已处理不可重复操作）。Service：`bridgeEvaluation` / `bridgeEvaluationNow` / `reviewBenchmarkCandidate`（审计）；**`runContinuousEval` 重构**：同一份真实报告同时用于回归判定 + 失败桥接（不虚构、不重复计分），Continuous Evaluation 每次运行自动沉淀真实失败为待审候选。API（43.26）：`GET /api/ai-quality/benchmark-candidates` + `POST .../bridge` + `POST .../:id/approve|reject`（RELEASE_APPROVE 人工门禁，禁止 AI 自批）。CLI（43.25）：`agent:benchmark:list|bridge|approve|reject`。Web「AI 改进」页新增第 9 个「Benchmark 扩充」Tab（指标卡 + 桥接按钮 + 候选表格 + 批准/驳回操作）。测试：**单元 14 + 集成 7 + E2E 2**，AI 改进页 E2E 15 用例全绿；`npm test` **1775 通过 / 0 失败**；`npm run web:e2e:test` **102 全绿**；`agent:benchmark:bridge` 真实桥接 **31 个失败候选**（Overall 93.6%、关键安全指标为 0）。报告见 `docs/phase49-summary.md`。

**Benchmark 候选并入（Review → Benchmark）**（v4.25.0 / Phase 50）：完成 43.21 闭环终点。新增 `src/ai-quality/benchmark-merge.ts`，只把人工 `APPROVED` 候选并入当前领域 Benchmark；真实源用例缺失即跳过，绝不伪造 input / Ground Truth / Accuracy。`BenchmarkRegistry.extendWithCases` 以 v2/v3 新版本落地并按 case id 去重；并入用例登记 HUMAN Ground Truth；候选状态机新增 MERGED 与 `mergedCaseId` / `mergedBenchmark`；Service 快照持久化 Registry/Ground Truth 并兼容 Phase 49 旧快照。新增 `POST /api/ai-quality/benchmark-candidates/merge`（RELEASE_APPROVE 门禁）、CLI `benchmark merge --by <human>`、Web“已并入”指标/并入按钮/凭据列。测试新增单元 8 + 集成 5 + 非浏览器 E2E S9 + 浏览器闭环；`web:e2e:ai` 16/16、`web:e2e:test` 103/103。报告见 `docs/phase50-summary.md`。

**AI Evaluation 生产规模化与长期运营**（v4.26.0 / Phase 51）：Evaluation 全状态按 Project 物理隔离；新增 10/50/100 并发 Runner、带 lease/requeue/exactly-once terminal result 的 1/2/5/10 Worker Pool（覆盖 500 jobs）、HOT/WARM/COLD/ARCHIVED 生命周期与 checksum Archive/Restore、内容寻址 Benchmark/GT 存储与完整性 BLOCK/rollback、Hourly/Daily/Project/Model/Benchmark 增量聚合、Score/Benchmark/Model/Prompt/Latency/Cost Drift、case checkpoint crash recovery 与 Ground Truth unavailable PAUSED。新增 project-scoped JWT/RBAC API、CLI 和 Web `Scale` Dashboard（过滤、聚合历史、Archive/Restore、Integrity、Drift、Recovery）。生产规模 LOAD TEST 覆盖 5 Projects / 20 Users / 500 real Benchmark case refs / 100 jobs / 10 workers / 3 rounds；报告见 `docs/phase51-summary.md`。


## 七、AI Test Platform 平台层

v4.0 新增 `src/platform/` 平台层，以 **Modular Monolith** 方式与既有 AI Test Engine 共存（不拆微服务、不引入 Kafka / Kubernetes），实现多 Project / Environment 管理、Run 全生命周期、Worker 调度、RBAC / 审批门禁、事件通知、审计与运维指标。

| 子模块 | 职责 |
|---|---|
| `projects/` | Project 实体 + Environment 分层 + 单一环境安全策略源（dev/test/staging/preprod/production） |
| `storage/` | `Repository<T>` 抽象，Memory / JSON / **SQLite / PostgreSQL** 四实现可替换（25.1/25.2） |
| `runs/` | TestRun 状态机（QUEUED/RUNNING/PAUSED/COMPLETED/FAILED/CANCELLED）+ Checkpoint 恢复 |
| `scheduler/` | TestJob 队列：优先级 / 重试 / 超时 / 幂等消费 / 定时触发 |
| `workers/` | Worker 注册 / 心跳 / 健康评估 / 四维调度（环境+能力+并发+健康）/ 崩溃回收 |
| `rbac/` | 6 角色 + 11 权限点 + 访问链路（RBAC → 环境策略），ADMIN 亦不可绕过生产安全 |
| `approval-center/` | 持久化审批中心：request（幂等）/ approve / reject / 审批权限校验 |
| `events/` | In-Process EventBus（24 种事件，单监听器异常隔离） |
| `notifications/` | Feishu / DingTalk / Email / Webhook / Console 五类通道 + 事件路由 |
| `audit/` | 审计日志：actor / role / action / runId / traceId / approvalId，敏感脱敏 |
| `auth/` | JWT 认证（25.3）：登录 / 刷新 / 登出 / 用户管理 / 资源作用域隔离 |
| `telemetry/` | 真实遥测（25.4/25.5）：8 类事件流 + 成本账本 + RCA 真值 + Flaky/Healing/Release + 指标自动激活（tracked=false → 真实数据激活） |
| `operations/` | 平台指标 14 项 + SLO 6 项（可计算指标真实统计，缺失遥测返回 null 不虚构） |
| `ops/` | 生产运维（25.8/31）：schema 迁移与回滚（down）/ 备份恢复 / 冒烟 / Preflight |
| `service/` | **统一 Service Layer**：API / CLI / Scheduler 共用 `PlatformService`，禁止两套业务逻辑 |
| `api/` | HTTP API（node:http）：Bearer Token / RBAC 头 / 限流 / 幂等 / 审计 / 链路追踪 / 统一错误契约 / 分页 / Web Dashboard 静态托管 / 公开分享落地页（share token 校验） |
| `test-assets/` | 测试资产库（26.2）：真实 Test Case 资产（查询 / 统计 / 导入 / 种子目录） |
| `workflow/` | QA 工作流（Phase 39/40）：Test Suite / Test Plan / Run Template / Asset Versioning / Collaboration / Run Report（含公开分享）/ QA Home 聚合（TTL 缓存，按用户 scopes 隔离）/ Defect 缺陷管理（状态机 + severity + 指派 + DefectCreated 事件 + audit） |
| `eval/` | AI 测试质量评测（Phase 45）：统一评测契约 + Ground Truth Registry（来源 HUMAN / REAL_PRODUCTION / REAL_RUN / CURATED / GENERATED，无 GT 则 tracked=false 且 score=null）+ 8 领域 Benchmark（Requirement / Test Design / Risk / Selection / RCA / Defect / Healing / Release，版本化）+ 确定性规则评测 + 指标（Precision / Recall / F1 / Coverage / Miss Rate）+ 版本对比 / 回归门禁（P0 Miss / False Pass / Unsafe Healing / Skipped Critical 四安全指标为 0）+ 决策 Replay（read-only）+ 成本跟踪 |
| `ai-quality/` | AI 质量优化闭环（Phase 46/48）：统一 AI Feedback（8 渠道）/ Error Taxonomy + 聚类 / Improvement Proposal（离线评测 + Gate）/ Prompt·Model 版本管理 / A/B 对比 / 多目标评分 / Shadow·Canary·自动回滚 / Knowledge Learning·Quality·Decay / Continuous Evaluation（48：Nightly·Weekly·Release 定时评测真正可运行，回归判定 BLOCK→Alert+Block Release，含 CLI/API/Web「持续评测」Tab）·Benchmark 自动扩充·Change Impact·AI Release Gate·Audit / 状态持久化（persistToFile / loadFromFile） |

**统一入口**：`createPlatformService()` 一次性装配全部依赖（`storage: memory | json | sqlite | postgres`，CLI 默认 sqlite 跨进程持久化，启动自动应用 schema 迁移）；HTTP 服务由 `createPlatformServer()` 提供，CLI 由 `bin/platform-cli.ts` 提供，二者共用同一 Service Layer。

**8 个核心 E2E Scenario**（`npm run platform:e2e` 全部通过）：

| Scenario | 覆盖能力 |
|---|---|
| S1 创建 Run | POST /runs → QUEUED → Scheduler → RUNNING |
| S2 Worker 执行 | Scheduler → Worker → 流水线 → COMPLETED |
| S3 Worker 崩溃 | Worker DOWN → 回收 → RETRY → 其他 Worker 完成，Run 不丢失 |
| S4 Pause / Resume | Checkpoint 恢复，不重复执行已完成 Case |
| S5 Production Dangerous | 任何角色 → DENY，不可绕过生产安全 |
| S6 Risky + Approval | PENDING → APPROVED → 执行；Reject → REJECTED |
| S7 Idempotency | 相同 Key 两次 → 只创建 1 个 Run |
| S8 Audit | runId / traceId / approvalId / actor 完整还原全链路 |

**最终验收指标（11 项全部达成）**：Project Management / Environment Isolation / Scheduler / Worker Retry / Checkpoint-Resume / RBAC / Production Safety / Approval Flow / Idempotency / Audit Trace / API-CLI Consistency，详见 [docs/phase24-final-acceptance-report.md](docs/phase24-final-acceptance-report.md)。

## 八、报告与通知

报告层采用工厂模式，实现 `Reporter` 接口（`name/write`）即可登记多格式输出。

| 通道 | 实现 | 内容要点 |
|---|---|---|
| HTML | `html-reporter.ts` | 执行概览、用例结果、接口响应摘要、数据隔离/影响分析、素材使用、问题卡点、人工待办、断言详情（按 assertionType 分组）、并发调整历史 |
| JSON | `json-reporter.ts` | 结构化执行数据，供下游消费与趋势分析 |
| JUnit XML | `junit-reporter.ts` | 标准 JUnit 格式，可直接接入 CI 平台 |
| Allure | `allure-reporter.ts` | Allure 报告数据生成，配套 `ci:allure` 脚本 |
| 飞书通知 | `notifiers/feishu.ts` | 失败断言详情块（`path | operator | expected | actual`） |

输出强制归档到 `output/<YYYY-MM-DD>/<功能名>/`；并发模式下报告写入 `<功能名>/<caseId>/` 子目录，日志带 `[caseId]` 前缀隔离。

## 九、CLI 参数

入口为 `bin/run-test.ts`（编译为 `dist/bin/run-test.js`），运行 `node dist/bin/run-test.js --help` 查看全部帮助。

| 参数 | 说明 |
|---|---|
| `--task` | 任务定义路径：功能子目录 / 根目录全量递归 / 单个文件（.json 或 TS 编译 .js） |
| `--env` | 执行环境，默认 `test`，可选 `preonline` |
| `--func` | 功能名，决定归档目录 `output/<日期>/<功能名>/` |
| `--reporter` | 报告格式，默认 `html`，支持 `html,json,junit` 逗号组合 |
| `--concurrency` | 并发数（默认 1 = 串行），组内串行 + 组间并行 |
| `--parallel` | 自动并发，取 CPU 核心数（上限 4），优先于 `--concurrency` |
| `--dynamic-concurrency` | 启用动态并发（滑动窗口 + 成功率自适应） |
| `--concurrency-min/max` | 动态并发的上下界 |
| `--auto-setup` | 启用数据工厂（setup 准备 / teardown 清理），默认关闭 |
| `--record` / `--replay` | Mock 录制 / 回放（互斥校验） |
| `--case-timeout` / `--no-retry` | 单用例超时 / 关闭重试 |
| `--grep` / `--filter` / `--scene` | 按名称 / 过滤条件 / 场景筛选用例 |
| `--watch` / `--watch-delay` | 文件监听模式（chokidar），变更自动重跑 |
| `--dry-run` | 演练模式，不真实执行 / 不扣积分 |
| `--ci` / `--upload-reports` | CI 模式 / 上传报告到 OSS |
| `--debug` / `--debug-level` / `--timeout` | 调试开关与全局超时 |

**平台 CLI**（v4.0 / v4.1，`bin/platform-cli.ts`，与 HTTP API 共用 Service Layer）：

| 命令 | 说明 |
|---|---|
| `node dist/bin/platform-cli.js project list / create <id> --name <name>` | 项目管理 |
| `node dist/bin/platform-cli.js run create --project wan3 --environment test --trigger manual` | 创建并执行 Run（自动进入 COMPLETED） |
| `node dist/bin/platform-cli.js run list / get <id> / detail <id>` | Run 查询（detail 含 Checkpoint / Trace / Approvals） |
| `node dist/bin/platform-cli.js run pause / resume / cancel / retry <id>` | 生命周期控制 |
| `node dist/bin/platform-cli.js worker list / approval list` | Worker 与审批查询 |
| `node dist/bin/platform-cli.js auth login/refresh/logout/info/users` | JWT 认证与用户管理 |
| `node dist/bin/platform-cli.js telemetry events/cost/metrics/activation [--period 7d]` | 真实遥测：事件 / 成本 / 指标 / 激活状态 |
| `node dist/bin/platform-cli.js platform health / dashboard / metrics` | 运维视图与指标（health 含遥测/审计连通性） |
| `node dist/bin/platform-cli.js serve [--port 8787] [--web web/dist]` | 启动 API + Web Dashboard（自动派发 Worker） |
| `node dist/bin/platform-cli.js migrate sqlite / postgres / check` | schema 迁移执行与状态检查（幂等） |
| `node dist/bin/platform-cli.js backup save <file> / restore <file> / summary` | 15 集合全量备份 / 恢复 / 统计 |
| `node dist/bin/platform-cli.js preflight [--json] [--check-postgres]` | 上线前环境自检（Node/存储/迁移/密钥/敏感信息） |
| `node dist/bin/platform-cli.js smoke` | 真实运营闭环冒烟（独立数据目录，Run→派发→遥测断言） |

身份通过 `PLATFORM_ACTOR` / `PLATFORM_ROLE` 环境变量注入；存储后端 `STORAGE_BACKEND=memory|json|sqlite|postgres`（默认 sqlite，CLI 跨进程持久化）；数据库 `DATABASE_URL` 可覆盖 PostgreSQL 连接。

## 十、CI/CD 与安全

项目内置完整的发布与安全流水线：Docker 镜像化、GitHub Actions、GitLab CI、husky 提交门禁与五类安全扫描。

| 设施 | 路径 | 能力 |
|---|---|---|
| Docker | `Dockerfile` `docker-compose.yml` | 镜像构建、`docker:build/run/test` 脚本、配置外部化（.env） |
| GitHub Actions | `.github/workflows/` | `test.yml`（含缓存）、`release.yml`、`security.yml` + Dependabot |
| GitLab CI | `.gitlab-ci.yml` | 多平台 CI 兼容 |
| 提交门禁 | `.husky/` `lint-staged` | pre-commit 安全扫描、commit-msg 校验 |
| 安全扫描 | `scripts/security/` `semgrep.yml` `.gitleaks.toml` | Semgrep 静态分析、Gitleaks 密钥检测、npm audit 依赖审计、License 合规、本地扫描，产物落 `security-reports/` |
| 报告归档 | `oss-uploader.ts` | 基于 ali-oss 上传报告 |

配套脚本：`deploy:smoke`（本地冒烟）、`deploy:notify`（飞书通知）、`ci:summary`（GitHub Summary）。

## 十一、扩展指南

### 六个架构扩展点

1. **场景处理器**：新建 `src/plugins/scenes/<name>.ts`，实现 `SceneHandler`（`match/submit/detail/status/analyzeBilling`），在 `engine.ts` 的 `SCENES` 注册表登记。
2. **用例定义**：JSON 放 `tasks/`（迁移源），TS 脚本放 `src/cases/<功能>/`（`defineCase` 包裹，编译期类型检查）。
3. **迁移**：`node scripts/migrate-json-to-ts.ts` 按文件名前缀自动建子文件夹，幂等可重复。
4. **钩子**：7 标准钩子 `beforeAll/beforeScene/beforeStep/afterStep/afterScene/afterAll/beforeReport`，按需挂载。
5. **断言**：`registerAssertion(name, fn)` 注册自定义核验项。
6. **报告器**：实现 `Reporter` 接口，在 `reports/factory.ts` 登记即多格式输出。

### 三步接入新业务（以 user 为例）

1. **建目录**：在 `src/cases/` 下新建 `user/` 子文件夹；
2. **放用例**：在 `tasks/` 放入 `user-login.json`，执行迁移脚本自动生成 `src/cases/user/login.ts`（或手写 TS 用例）；
3. **执行**：`npm run test:user`，报告自动归档到 `output/<日期>/user/`。

全程无需改动 loader / engine / 任何框架代码——框架按目录结构自动识别新功能。`order`、`payment` 等业务同理。

## 十二、版本历史

| 版本 | 日期 | 里程碑 |
|---|---|---|
| v1.0 | 2026-08-12 | 交付包初始化 |
| v1.1 | 2026-08-15 | 输出归档规则升级为 `output/<日期>/<功能名>/`，脚本支持 `--func` |
| v1.2 | 2026-08-15 | 新增「项目说明格式规范」，四场景验证表更新 |
| v1.3 | 2026-08-15 | 文档去重合并、代码层重构（素材函数 / 步骤编号） |
| v2.0 | 2026-08-15 | 插件式重构：场景处理器、按 scene 路由、模板通用化 |
| v3.0 | 2026-08-15 | TypeScript 重构：模块化分层 + 7 钩子 + 断言注册表 + 三格式报告 |
| v3.2 | 2026-08-16 | 多功能模块化：按功能分子文件夹、loader 递归扫描、迁移脚本分目录 |
| v3.3 | 2026-08-16 | 并发执行：`--concurrency` / `--parallel`，p-limit 并发池，caseId 归档 |
| v3.4 | 2026-08-17 | 数据工厂（`--auto-setup`）+ 环境一致性检测（基线对比 + 断言注入） |
| v3.5 | 2026-08-17 | Agent 化与能力沉淀（Phase 10-19）：RCA/Flaky 治理、自愈、缺陷生命周期、审批状态机、可观测性、评估体系、通用断言引擎、数据生成 / Mock 回放 / 动态并发、断言可视化 |
| v4.0 | 2026-08-18 | AI Test Platform 平台化（Phase 20-24）：多业务接入、测试资产管理、持续回归、知识 / 成本 / 质量优化、智能排序与风险预测、自治回归流水线、统一追踪、发布决策与生产验收，以及全新 `src/platform` 平台层（13 模块 + HTTP API + CLI + 运维指标） |
| v4.1 | 2026-08-18 | AI Test Platform 生产化（Phase 25）：SQLite / PostgreSQL 持久化、JWT 认证与用户体系、真实遥测（成本 / RCA / Flaky / Healing / Release）、指标自动激活、React Web Dashboard（15+ 页面）、API 加固（链路追踪 / 限流 / 错误契约 / 分页）、生产运维（迁移 / 备份恢复 / 冒烟 / Preflight） |
| v4.2.0 | 2026-08-19 | 生产验证闭环（Phase 26）：版本溯源与部署验收链、50 真实 TestCase 接入、四形态真实 Run 执行、故障恢复演练（S1/S2/S3 + 恢复指标）、统一发布门禁（PASS/REVIEW/BLOCK + Agent 防绕过）、备份恢复三一致校验 + 禁止自动重触发、六类可观测告警、30 Run 生产试运行（KPI + 10 条人工 QA 对照） |
| v4.3.0 | 2026-08-19 | 生产安全加固（Phase 27）：生产/预发模式强制非默认 JWT_SECRET（缺失即拒启）、生产模式禁用默认种子口令与静态 X-Actor/X-Role 身份伪造、运维只读端点 RBAC（OPS_READ，审计/遥测成本/Job/Worker）、审批职责分离（禁止自提自批）+ 安全随机审批 ID、decodeJwt 加固、Preflight 安全策略检查（模式/JWT/口令/身份来源） |
| v4.4.0 | 2026-08-19 | 工程治理（Phase 28）：共享脱敏模块上移 `src/core/redact.ts`（消除平台层对 agents 域反向依赖 + 修复连字符变体漏脱敏）、配置模块单一来源（删除重复 `env.ts`，`env-loader.ts` 统一 TESTFLOW_* 覆盖）、删除死代码、技术债登记（`docs/TECH-DEBT.md`）、README 目录结构同步 |
| v4.5.0 | 2026-08-19 | 性能与容量基线（Phase 29）：10/50/100/500 Runs 生命周期吞吐/延迟基线与回归门禁（`perf:baseline` / `perf:gate` / `perf:test`）、Scheduler / Audit / Telemetry 写入吞吐、内存稳定性；性能基准暴露并修复高吞吐下 ID 碰撞缺陷（`core/id.ts` 统一 crypto.randomUUID） |
| v4.6.0 | 2026-08-19 | 覆盖率补齐（Phase 30）：`src/platform/**` 纳入 vitest coverage 统计，平台层全子模块满足行/函数/语句 ≥ 80、分支 ≥ 75 门禁；新增 `tests/unit/platform-coverage-gap.test.ts`（15 项）补齐 events / notifications / migrations(Postgres) / environment-policy / scheduler / workers / checkpoint 缺口；全量覆盖率 Statements 90.45 / Branch 79.77 / Functions 91.51 / Lines 92.03 |
| v4.7.0 | 2026-08-19 | 迁移 down / 回滚（Phase 31，DEBT-09）：`Migration.revert` 回滚实现、`resolveRevertTarget` 防跳级语义、SQLite / Postgres 回滚函数、CLI `migrate down` 子命令，并验证 backup→migrate→rollback→restore 完整闭环（三一致）——只要升级前有备份，迁移回滚不会造成数据永久丢失 |
| v4.8.0 | 2026-08-19 | 变异测试（Phase 32，DEBT-07）：Stryker + vitest-runner 聚焦平台 Critical 决策逻辑 7 个源文件，变异分数门禁 high=80 / low=70 / break=60；首次变异 85.49% → 补测 18 项 → 总体变异分数 98.96%（191 杀死 / 2 存活 / 0 无覆盖），security / approval-center 100%、rbac 98.44%、runs 96.55% |
| v4.9.0 | 2026-08-19 | 环境策略职责边界与跨层一致性（Phase 33，DEBT-01）：三层环境策略模型（agent 层启用守卫 / 平台层动作分级 / 安全模块运行模式加固）职责边界文档化；新增 `environmentTypeToTier` / `environmentTypeToMode` 跨层互操作契约与 15 项一致性校验（5 条不变量）；修复 agent 层不识别平台层 `preprod` 环境名的跨层漂移缺口（归入 preonline 档，危险动作拒绝） |
| v4.10.0 | 2026-08-19 | 断言可视化接入 HTML 报告（Phase 34，DEBT-05）：将此前仅被自身测试引用的 `utils/assertion-visualizer.ts` 断言可视化引擎接入 `reports/html-reporter.ts`（变废为用），报告新增 4.4 断言可视化节——失败断言 Diff 视图（JSON/TEXT/NUMERIC/BOOLEAN/SCHEMA 节点级差异）+ 断言热力图（权重 0 绿 / 1-3 黄橙 / 4-5 红 + Flakiness Index）；新增 `tests/unit/html-reporter-visualization.test.ts`（4 项） |
| v4.11.0 | 2026-08-19 | 类型级反向依赖上移 core（Phase 35，DEBT-11）：失败分类共享模型（`FailureCategory` / `FAILURE_CATEGORIES` / `isFailureCategory`）上移至 core 层唯一权威来源 `core/failure-category.ts`，agents 域 re-export 兼容；平台层 3 处（telemetry-types / telemetry-service / real-run）改从 core 导入——平台层对 agents 域零依赖；新增 `tests/unit/core-failure-category.test.ts`（6 项）含结构性依赖守护 |
| v4.12.0 | 2026-08-19 | 身份解析统一（Phase 36，DEBT-12）：审计确认 `resolvePrincipal` 唯一实现；静态身份来源守卫+解析收敛到 security 模块新增 `resolveStaticIdentity`（production 返回 null 防伪造不可绕过，其余模式解析 X-Actor/X-Role 默认 api/VIEWER）；`api/server.ts` 改调该函数——平台层 X-Actor/X-Role 头读取仅存在于 security 模块；新增 `tests/unit/identity-resolution-guard.test.ts`（8 项）含结构性不可绕过守护 |
| v4.13.0 | 2026-08-19 | E2E 时序卫生治理（Phase 37，DEBT-13，**技术债清零**）：审计确认 E2E/集成已普遍采用健壮模式（随机端口 / `FIXED_ISO` 固定时钟注入 / `Date.now()` 唯一 ID / 轮询+超时），无硬编码端口、固定时间戳断言、固定长 sleep 残留；新增 `tests/unit/e2e-timing-hygiene.test.ts`（4 项）结构性守护固化 |
| v4.14.0 | 2026-08-19 | QA 工作流产品化（Phase 39）：新增 `src/platform/workflow/`（Test Suite / Test Plan / Run Template / Asset Versioning / Collaboration / Run Report / QA Home），复用既有 PlatformService / Repository / RBAC / Notification / Audit / Telemetry，零新增基础设施；QA Workflow API（`/test-suites`、`/test-plans`、`/run-templates`、`/assets/:id/versions|compare`、`/runs/:id/share|comments|assign|rerun|clone|template`、`/qa-home`）+ CLI 命令组（suite / plan / template / run rerun|clone / report）+ Web QA Workbench 页面（Action Center + 快速操作 + Suite/Plan/Template 管理 + Run Detail 报告摘要与复用/分享/协作）；权限错误语义化为 403 |
| v4.15.0 | 2026-08-19 | Phase 40 工程化收尾：单资源读端点 Project Scope 加固（getSuite/getPlan/planCases/getTemplate/assetVersions/listApprovals 六处 + resolveAssetProject 解析 + 审批 runId 过滤）；Defect 缺陷平台化（`workflow/defects.ts` 真实实体 + 状态机 + severity + 指派 + DefectCreated 事件 + Web/CLI 页面 + QA Home recentDefects 真实数据）；前端断点修复（share 改 POST、Settings 双前缀、公开分享落地页无 JWT + share token 校验 + 导出直链、无 Token 跳登录、RCA 死链）；报告数据真实性（failures 由真实遥测 execution/RCA 事件聚合、decisionTrace 可读化）；QAHome / run-report TTL 聚合缓存（按 scopes 隔离） |
| v4.16.0 | 2026-08-20 | Phase 41 Web 真实浏览器 E2E 与体验质量：Playwright + Chromium 真实浏览器测试基础设施（`tests/e2e/web/` 内存态服务器 + 种子数据 + 共享助手 + `web:e2e:test` / `web:e2e:server` 脚本）；**14 个 E2E 套件覆盖 17 项关键功能验收**（auth / project / workflow / run / defect / report / share / approval / project-isolation / error-state / accessibility / keyboard / responsive / performance）——登录→项目→QA Home→Plan→Run→Run Detail→Failure/RCA→Defect→Report→Share→Release/Approval 全流程真实浏览器验证；可访问性 axe-core 逐页扫描无 critical/serious（对比度 / 下划线链接 / h1 / 表单可访问名 / 焦点可见）；五档视口响应式无溢出；性能与轮询治理（无 429 风暴、JS 包 < 1MB、无 console error）；API 客户端统一错误处理。同阶段修复真实缺陷：登录 token 字段对齐、RunDetail 死循环刷爆限流、QA Home Runs/Approvals 项目作用域泄漏、分享页路由与只读渲染、文本块链接仅靠颜色区分、按钮/徽标对比度、登录页无 h1、表单控件无可访问名、焦点不可见、窄屏导航溢出、长 ID 断行 |
| v4.17.0 | 2026-08-20 | Phase 42 Web 前端工程化：单元/组件测试 + CI 接入 + 跨浏览器回归。单元/组件测试：Vitest 4.1 + jsdom + React Testing Library，6 个测试文件 37 条用例，v8 覆盖率语句 94.96% / 行 96.09%（`ui.tsx`、`usePolling.ts`、`Login.tsx` 语句 100%）；修复 Node ≥22 实验性 `localStorage` 测试环境问题（`MemoryStorage` 兜底）。CI 接入：新增 `.github/workflows/web-e2e.yml` 三档分级（`web-unit` / `web-e2e-chromium` 门禁 + `web-e2e-cross-browser` Nightly 跨浏览器全量），新增脚本 `web:test` / `web:test:coverage` / `web:e2e:cross`。跨浏览器回归：`playwright.config.ts` 增加 `WEB_E2E_BROWSERS` 门控（默认仅 Chromium / `all` 三浏览器 / 逗号列表子集），Chromium 全量 74 passed；firefox / webkit 冒烟验证通过 |
| v4.18.0 | 2026-08-20 | Phase 43 Web 交互正确性与平台能力暴露：写操作统一错误反馈（Defects + RunDetail `runAction` 包装 + 错误 banner，失败不再静默 unhandled rejection）；**评论契约修复**（服务端读 `c.body.body`，前端由 `{ text }` 改 `{ body }`）；`api.ts` 补 `del`（DELETE）；`Runs.tsx` 支持 `?project=` 过滤。Run 全生命周期 Web 呈现：新建 Run 页 `/runs/new`（全参数创建）/ Cancel（仅 QUEUED/RUNNING）/ Assign（逗号分隔多用户）；测试资产暴露 `/assets`（TestAssets 统计+列表）+ `/assets/:id`（AssetVersions 版本历史+字段级对比），零后端改动。测试覆盖补强：RunDetail 回归测试 14 用例 → 行覆盖 100%（评论契约 / Cancel / Clone / Template / Share / Assign / guard / 错误 banner / 降级 / 报告渲染 / @badge / 审批），新增 RunCreate（3）/ TestAssets（2）/ AssetVersions（2）；全量 59 用例 / 行覆盖 95.12%，`tsc -b` 通过 |
| v4.19.0 | 2026-08-20 | Phase 44 真实浏览器 E2E 覆盖收口 + 单元覆盖缺口闭合：新增 RunCreate / Run 操作（Cancel/Assign/Retry）/ TestAssets / AssetVersions 4 个 Playwright 套件（登录→项目→QA Home→Plan→Run→Run Detail→Defect→Report→Share→Approval→项目隔离→错误态→可访问性→键盘→响应式→性能 16+ 套件）；可访问性 / 键盘 / 响应式扩展新页面（RunCreate、TestAssets、AssetVersions、Run Detail 全生命周期控件）；单元覆盖缺口闭合（api.test 登出契约 + RunCreate 全参数 + AssetVersions 单版本分支，68 用例 / 行覆盖 99.67%）；`/assets/:id` SPA 路由冲突修复；测试资产 `{ items }` 契约对齐；Chromium 87 E2E 全绿 |
| v4.20.0 | 2026-08-20 | Phase 45 AI 测试质量评测：建立「AI 测得好不好」的可量化、可比较、可回归、可证明闭环。统一评测契约（8 领域 + tracked/score 语义，无 Ground Truth 则 tracked=false 且 score=null，禁止虚构准确率）；Ground Truth Registry（来源 HUMAN / REAL_PRODUCTION / REAL_RUN / CURATED / GENERATED + 置信度 + 校验）；8 领域版本化 Benchmark（Requirement 36 / Test Design 22 / Risk 32 / Selection 30 / RCA 38 / Defect 30 / Healing 20 / Release 30，共 238 条 tracked 用例）；确定性规则评测器（模型 model=rules，零外部依赖零 token 消耗）；指标体系（Completeness / Precision / Recall / F1 / Coverage Score / Redundancy / Executability / Critical Miss Rate / Recall@TopK / Top-1/Top-3 Accuracy / Healing Success / Unsafe Healing Rate / False Pass Rate 等）；版本对比与回归门禁（compare / regression，Critical 指标下降 → BLOCK）；**关键安全指标达标：P0 Miss=0 / False Pass=0 / Unsafe Healing=0 / Skipped Critical=0**；Overall 93.6%（238 条 tracked）；决策 Replay（read-only，确定性模块 same input→same output）；成本跟踪（model / modelVersion / promptVersion / toolVersion / agentVersion + tokens / latency / cost）；Web AI Quality Dashboard（/ai-quality 页：8 领域分数 + Baseline/Current + 逐条 Case 明细 Expected/Actual/Errors + 四安全指标）；CLI（agent:eval:run / report / compare / regression）；API（GET /api/eval/report[/:domain]）；测试（单元 57 + 集成 4 + E2E 3 + AIQuality 组件测试全绿） |
| v4.21.0 | 2026-08-20 | Phase 46 AI 质量优化、反馈学习与持续改进闭环：让 AI Test Platform 形成「测试 AI 本身」的持续优化闭环。统一 AI Feedback（`src/ai-quality/`，43.1/43.2）：AIFeedback 契约 + 8 渠道（Human Correction / RCA Verification / Defect Review / Release Review / Healing Review / Benchmark Failure / Production Incident / Flaky Confirmation），AI 预测 vs 人工真值自动记 INCORRECT，人工核验门禁；错误分类与聚类（43.3/43.4）：统一 Error Taxonomy（WRONG / MISSING / OVER_PREDICTION / UNDER_PREDICTION / DUPLICATE / UNSAFE / INCONSISTENT / LOW_VALUE）+ 确定性聚类（domain+category，id 恒定 → 提案幂等去重）；改进提案（43.5/43.6/43.11）：autoProposals 自动生成 + 离线评测 baseline vs candidate → gateVerdict（PASS/REVIEW/BLOCK）+ 状态机；Prompt / Model 版本管理（43.7/43.8）+ A/B 对比（Accuracy / Latency / Cost / Failure Rate / Safety 五维，43.9）+ 多目标评分（Quality / Safety / Latency / Cost，保留原始指标，43.10）；Shadow（只读）/ Canary（5%→20%→50%→100%，异常自动停止、严重自动回滚）/ 自动回滚恢复基线（43.12-43.14）；Knowledge 学习 / 质量 / 衰减（43.15-43.17，EffectiveWeight 综合 usage/success/failure/age）；运营能力（43.19-43.24）：Continuous Evaluation / Benchmark 自动扩充 / Change Impact（Targeted Evaluation）/ AI Release Gate / Improvement Audit；持久化（snapshot/restore + persistToFile/loadFromFile，跨重启保留）；API（43.26）：/api/ai-feedback|ai-errors|ai-improvements|prompts|models|experiments|knowledge/review|ai-quality(+trends)，写操作 RELEASE_APPROVE 门禁（QA 403，禁止 AI 自批）；CLI（43.25）：agent:ai-quality / feedback list·verify / eval errors·improve / prompt·model list·compare / improvement list·approve·reject / knowledge review / canary status·promote·rollback；Web「AI 改进」Dashboard（43.18/43.22：7 Tab，审批仅 RELEASE_MANAGER/ADMIN）；测试 86 新用例全绿（单元 68 + 集成 10 + E2E 8，含核心闭环 S1-S8）；关键安全指标（falsePass / p0Miss / unsafeHealing）为 0 |
| v4.22.0 | 2026-08-20 | Phase 47 Web「AI 质量 / AI 改进」页真实浏览器 E2E 覆盖：修复「AI 改进」页可达性缺陷（`web/src/App.tsx` 补 `/ai-improvement` Route，导航曾落 NotFound）；E2E 种子注入 `seedAiQuality()`（未核验 INCORRECT 反馈 / 自动提案 Gate PASS 可审批 + APPROVED / Prompt risk v1·v2 / Model deepseek v3·v4 / Shadow COMPLETED + Canary RUNNING@5% / 知识候选 PENDING_REVIEW）；真实浏览器 Playwright E2E **11 新用例**（未认证重定向 / 7 Tab 渲染 / 错误聚类 / 改进提案 / Prompt·Model 版本 / Shadow·Canary / 知识 Review / AI 质量聚合 / RBAC 人工门禁 RELEASE_MANAGER 批准 / AI 质量页可达）；`web:e2e:ai` + `phase47:test` 脚本；Web E2E 98 全绿 + 全量 1736 通过 |
| v4.23.0 | 2026-08-20 | Phase 48 Continuous Evaluation 落地（43.20）：把 Phase 46 的 `ContinuousEvalSchedule` 常量升级为真正可运行的定时评测闭环。新增 `src/ai-quality/continuous-eval.ts`：`ContinuousEvalStore`（latest / 按 schedule 过滤 / snapshot·import 持久化）+ `runContinuousEvaluation`（真实运行 `runAllEvaluation` → Compare baseline → `detectRegression`：**Critical 指标上升 → BLOCK + Alert + Block Release；普通 Overall 下降 → REVIEW；无回归 → PASS**；首次只记录基线）。调度 nightly `0 2 * * *` / weekly `0 3 * * 1` / release 发布前门禁；`AIAQualityService.runContinuousEval`（审计 + 持久化）；API `GET /api/ai-quality/continuous-evals`（+ :id + POST run 手动触发 RELEASE_APPROVE 门禁）；CLI `agent:continuous:run|list|status`；Web「AI 改进」第 8 个「持续评测」Tab（历史 + 指标 + 手动触发，非审批角色禁用）；测试 单元 11 + 集成 7 + E2E 2（AI 改进页 E2E 13 全绿）；`npm test` 1754 通过 / 0 失败；Overall 93.6%、关键安全指标为 0 |
| v4.24.0 | 2026-08-20 | Phase 49 Eval → Feedback 桥接 + Benchmark 自动扩充候选（43.2 / 43.21）：Evaluation 失败自动进入 Feedback Registry（BENCHMARK_FAILURE 渠道：EVALUATION 来源 / INCORRECT / prediction=actual / actual=expected / 待人工核验）+ 自动生成 Benchmark 扩充候选（PENDING_REVIEW，禁止自动并库）+ 幂等去重。新增 `src/ai-quality/eval-bridge.ts`（`extractEvalFailures` 只提取 tracked 失败 / `bridgeEvalReport` 幂等桥接 + `BenchmarkCandidateStore` Review 状态机 approve/reject 记录 reviewer·reviewedAt·reason）；Service `bridgeEvaluation` / `bridgeEvaluationNow` / `reviewBenchmarkCandidate`（审计）+ `runContinuousEval` 重构（同一份真实报告同时回归判定 + 失败桥接）；API `GET /api/ai-quality/benchmark-candidates` + `POST .../bridge` + `POST .../:id/approve|reject`（RELEASE_APPROVE 人工门禁）；CLI `agent:benchmark:list|bridge|approve|reject`；Web「AI 改进」第 9 个「Benchmark 扩充」Tab；测试 单元 14 + 集成 7 + E2E 2（AI 改进页 E2E 15 全绿）；`npm test` 1775 通过 / 0 失败；`web:e2e:test` 102 全绿；真实桥接 31 个失败候选；Overall 93.6%、关键安全指标为 0 |
| v4.25.0 | 2026-08-20 | Phase 50 Benchmark 候选并入（Review → Benchmark，43.21）：仅并入人工 APPROVED 候选；复用真实源 input/Ground Truth，无源即跳过；Registry v2/v3 升版与 case id 去重；HUMAN Ground Truth 登记；MERGED 状态机与并入凭据；Service/API/CLI/Web 完整落地；单元 8 + 集成 5 + E2E S9 + Web 闭环，`web:e2e:ai` 16/16、`web:e2e:test` 103/103 |
| v4.26.0 | 2026-08-21 | Phase 51 AI Evaluation 生产规模化：多项目隔离、并发/租约队列/Worker scaling、生命周期 Archive/Restore、内容寻址 Benchmark integrity、Telemetry aggregation + Drift、checkpoint disaster recovery、Scale API/CLI/Web；5 Projects / 20 Users / 500 real case refs / 100 jobs / 10 workers / 3 rounds LOAD TEST |

在 v3.4 之上，后续迭代进一步沉淀了通用断言引擎、数据生成 / Mock 录制回放 / 动态并发三大能力，以及断言可视化引擎，均以独立 commit 演进：`e554843` → `4c8b52b` → `4c1581d` → `ee83ebe`。Phase 20-24 各阶段报告见 `docs/`（`phase20-final-acceptance-report.md` → `phase24-final-acceptance-report.md`）；Phase 25 各阶段报告见 `docs/phase25.0-production-analysis.md` → `docs/phase25.8-production-readiness-report.md`；Phase 26 各阶段报告见 `docs/phase26.1-production-deployment-report.md` → `docs/phase26.8-production-pilot-report.md` 与 `docs/phase26-final-acceptance-report.md`；Phase 27 报告见 `docs/phase27-summary.md`；Phase 28 报告见 `docs/phase28-summary.md`；Phase 29 报告见 `docs/phase29-summary.md`；Phase 30 报告见 `docs/phase30-summary.md`，性能基线与门禁结果落 `perf/baseline.json` 与 `perf/latest.json`；Phase 31 报告见 `docs/phase31-summary.md`；Phase 32 报告见 `docs/phase32-summary.md`；Phase 33 报告见 `docs/phase33-summary.md`（含 `docs/environment-policy-boundaries.md` 职责边界文档）；Phase 34 报告见 `docs/phase34-summary.md`；Phase 35 报告见 `docs/phase35-summary.md`；Phase 36 报告见 `docs/phase36-summary.md`；Phase 37 报告见 `docs/phase37-summary.md`；最终项目验收报告见 `docs/FINAL-PROJECT-ACCEPTANCE-REPORT.md`（七大类 A-G 全部满足，判定 **PROJECT COMPLETE**，v4.13.0）；Phase 39 报告见 `docs/phase39-summary.md`（QA 工作流产品化）；Phase 40 报告见 `docs/phase40-summary.md`（工程化收尾，v4.15.0）；Phase 41 报告见 `docs/phase41-web-e2e-report.md`（E2E 测试）与 `docs/phase41-frontend-quality.md`（可访问性/响应式/性能/API 治理）与 `docs/phase41-acceptance-report.md`（17 项验收，v4.16.0）；Phase 42 报告见 `docs/phase42-web-engineering-report.md`（Web 前端工程化：单元/组件测试 + CI 接入 + 跨浏览器回归，v4.17.0）；Phase 43 报告见 `docs/phase43-summary.md`（Web 交互正确性 + Run 全生命周期 + 测试资产暴露，v4.18.0）；Phase 44 报告见 `docs/phase44-summary.md`（真实浏览器 E2E 覆盖收口 + 单元覆盖缺口闭合，v4.19.0）；Phase 45 报告见 `docs/phase45-summary.md`（AI 测试质量评测，v4.20.0），评测框架详见 `docs/evaluation/overview.md`（总览）/ `docs/evaluation/benchmark.md`（Benchmark）/ `docs/evaluation/ground-truth.md`（Ground Truth）/ `docs/evaluation/metrics.md`（指标）/ `docs/evaluation/regression-gate.md`（回归门禁）；Phase 46 报告见 `docs/phase46-summary.md`（AI 质量优化与持续改进闭环，v4.21.0），AI 质量框架详见 `docs/ai-quality/`（feedback / error-analysis / improvement / prompt-versioning / model-versioning / shadow-canary / knowledge-learning / rollback）；Phase 47 报告见 `docs/phase47-summary.md`（Web「AI 质量 / AI 改进」页真实浏览器 E2E 覆盖，v4.22.0）；Phase 48 报告见 `docs/phase48-summary.md`（Continuous Evaluation 落地，v4.23.0）；Phase 49 报告见 `docs/phase49-summary.md`（Eval → Feedback 桥接 + Benchmark 自动扩充候选，v4.24.0）；Phase 50 报告见 `docs/phase50-summary.md`（Benchmark 候选并入 Review → Benchmark，v4.25.0）；Phase 51 报告见 `docs/phase51-summary.md`（生产规模化与长期运营，v4.26.0）。

## 十三、目录结构

```
test-flow/
├── README.md                    # 本文件（完整项目说明）
├── docs/                        # 流程与模板文档
│   ├── 01-测试流程SOP.md        # 完整流程规范（含「新模块接入指引」）
│   ├── 02-模板合集.md           # 测试用例 / 数据需求清单 / 启动检查清单 三合一模板
│   ├── 02-测试用例模板.md       # 测试用例模板（独立版）
│   ├── 03-数据需求清单模板.md   # 数据需求清单模板
│   ├── 04-新任务启动检查清单模板.md  # 新任务启动检查清单模板
│   ├── 05-项目说明模板.md       # 项目说明统一格式模板（通用）
│   ├── assertion-dsl.md         # 断言 DSL 语法文档
│   ├── FINAL-PROJECT-ACCEPTANCE-REPORT.md  # 最终项目验收报告（七大类 A-G，判定 PROJECT COMPLETE）
│   ├── phase39-summary.md / phase40-summary.md / phase41-*.md  # QA 工作流产品化 / 工程化收尾 / Web E2E 与体验质量总结
│   ├── product/                 # 产品文档：test-suite / test-plan / run-template / asset-versioning / report-sharing / qa-workflow
│   └── phase*.summary.md        # 各阶段总结（phase13-37）
├── src/                         # ★ TypeScript 源码（模块化分层）
│   ├── core/                    # 核心引擎：types / engine / pipeline / hooks / scene-handler / data-factory / env-checker / teardown / redact（共享脱敏）
│   ├── cases/                   # 用例层：define / registry / loader（多功能模块化）
│   │   ├── {feature}/           # ★ 功能模块：每个子文件夹 = 一个独立业务功能（wan3 / user / order / payment ...）
│   │   └── (新功能)              # 新增功能只需在 src/cases/ 下新建子文件夹即可即插即用
│   ├── assertions/              # 断言库：db-check / billing-check / isolation-check / account-check / impact / security-check / chaos-check / status-flow-check + adapters/wan3-adapter
│   ├── reports/                 # 报告器：html / json / junit + factory
│   ├── integrations/            # 外部集成：http / billing / assets / notifiers
│   ├── plugins/scenes/          # ★ 场景处理器（插件式，新模块在此新增）
│   │   └── video.ts             # 视频场景处理器（文生/图生/全能参考/首尾帧）
│   ├── config/                  # 配置：environments.json + config.ts（schema 校验）+ env-loader.ts（TESTFLOW_* 环境变量覆盖单一来源）
│   ├── platform/                # ★ AI Test Platform 平台层（v4.0-v4.21）：projects / storage / runs / scheduler / workers / rbac / approval-center / events / notifications / audit / auth / telemetry / operations / ops / service / api / security / test-assets / workflow
│   ├── ai-quality/              # ★ AI 质量优化闭环（v4.21.0/Phase 46 + v4.23.0/Phase 48 + v4.24.0/Phase 49 + v4.25.0/Phase 50）：feedback / error-analysis / improvement / versioning / experiment / knowledge-learning / ops / continuous-eval（Phase 48：Nightly·Weekly·Release 定时评测，回归判定 BLOCK→Alert+Block Release）/ eval-bridge（Phase 49：Eval→Feedback 桥接 + Benchmark 扩充候选 BenchmarkCandidateStore，PENDING_REVIEW 人工 Review 才可并入）/ benchmark-merge（Phase 50：APPROVED 候选→版本化 Benchmark + HUMAN Ground Truth，禁止伪造）/ service（Feedback → 聚类 → 提案 → 离线评测 → 审批 → Shadow/Canary → 回滚 → 审计 → 持续评测 → 失败桥接，持久化跨重启保留）
│   ├── web/                     # Web Dashboard 前端（React + Vite，v4.1/Phase 25.6；Vitest 单元/组件测试 v4.17.0/Phase 42.1 + 交互正确性/全生命周期 v4.18.0/Phase 43 + AI 质量/改进页 v4.21.0/Phase 46 + 持续评测 Tab v4.23.0/Phase 48 + Benchmark 扩充 Tab v4.24.0/Phase 49 + 候选并入 v4.25.0/Phase 50）
│   └── utils/                   # 工具：logger / metrics / retry / data-generator / mock-recorder / concurrency-controller / assertion-visualizer / exit-code / fs-utils / trace / allure-reporter / junit-reporter / oss-uploader
├── tests/                       # Vitest 测试：unit/（单元） + integration/ + e2e/（155 文件 / 1736 用例，全量回归全绿）+ tests/e2e/web/（14 个 Playwright 真实浏览器 E2E 套件，Chromium v4.16.0 / 跨浏览器 v4.17.0）
├── tests/unit/                  # Vitest 单元测试（含平台 35 文件）
├── bin/run-test.ts              # 执行 CLI 入口（编译为 dist/bin/run-test.js）
├── bin/platform-cli.ts          # 平台 CLI（v4.0/v4.3，与 API 共用 Service Layer）
├── scripts/                     # 构建/迁移/安全/CI 工具
├── tasks/                       # JSON 任务定义（迁移源，保留）
│   ├── _template.json           # 新任务定义模板
│   └── {功能}-{任务名}.json     # 按「功能-任务名」命名，如 wan3-wensheng / user-login / order-create
├── dist/                        # tsc 编译产物（npm run build 生成，可独立运行）
├── package.json / tsconfig.json # 工程配置（ESM + NodeNext + strict）
├── CHANGELOG.md                 # 版本变更记录（Keep a Changelog）
└── output/                      # 旧版报告目录（已停用；新报告输出到 /Users/mac/agents/output/<日期>/<功能名>/）
```

测试素材库（固定）：`/Users/mac/agents/Test-panqu/`（`audio/` `photo/` `txt/` `video/`）。

## 十四、强制约定

1. **所有任务**（视频生成、剧本分镜、账单调整、模型接入、其他 AI 能力等）都必须走本流程，无例外。
2. 每个新任务开始前，**必须先输出《新任务启动检查清单》并确认**，确认后才进入用例编写与执行。
3. 任务定义放 `tasks/{功能}-{任务名}.json`（见 `tasks/_template.json`）或 `src/cases/{功能}/{任务名}.ts`（TS 脚本，类型安全）。
4. **素材来源**：上传文件默认从测试素材库 `/Users/mac/agents/Test-panqu/` 取用；任务定义中用相对路径引用，脚本自动扫描并解析。
5. **输出位置（强制）**：所有输出文件按 `output/<YYYY-MM-DD>/<功能名>/` 结构存放，执行脚本用 `--func <功能名>` 指定并自动创建目录，禁止输出到其他位置。
6. **项目说明格式**：所有功能交付包的 `README-项目说明.md` 必须按 `docs/05-项目说明模板.md`（v2.1）编写。

## 十五、快速开始

```bash
# 0. 首次：安装依赖 + 编译
cd /Users/mac/agents/test-flow
npm install
npm run build

# 1. 你提供需求 → 我输出《启动检查清单》+ 任务定义，你确认
# 2. 一键执行（--task 支持：功能子目录 / 根目录全量 / 单文件）
node dist/bin/run-test.js --task tasks/wan3-wensheng.json --func wan3   # 单文件
node dist/bin/run-test.js --task src/cases/wan3                        # 单功能模块
node dist/bin/run-test.js --task src/cases                             # 全量递归

# 3. 切换环境 / 多格式报告 / 并发（可叠加）
node dist/bin/run-test.js --task src/cases/wan3 --env=preonline --func wan3
node dist/bin/run-test.js --task src/cases/wan3 --func wan3 --reporter html,json,junit
node dist/bin/run-test.js --task src/cases --func wan3 --parallel

# 4. 查看全部参数
node dist/bin/run-test.js --help
```

**常用命令**

| 命令 | 说明 |
|---|---|
| `npm run build` | 编译 TS 到 `dist/` 并复制非 TS 资源（environments.json） |
| `npm run test` | Vitest 单元测试 |
| `npm run test:coverage` | 覆盖率（行/函数 80%、分支 75%、语句 80%） |
| `npm run test:all` | 编译 + 校验 JSON 源与 TS 用例一致性（离线，不扣积分） |
| `npm run test:wan3` | 真机执行 wan3 功能全部用例（`user` 请替换为 `npm run test:user`） |
| `npm run test:regression` | 全量回归：编译 + 执行所有功能模块（CI 模式） |
| `npm run migrate -- [--force]` | 将 `tasks/*.json` 迁移为 `src/cases/<功能>/*.ts`（幂等） |
| `npm run security:full` | 五类安全扫描全量执行 |
| `npm run platform -- run create --project wan3 --environment test` | 平台 Run 创建并执行（自动进入 COMPLETED） |
| `npm run platform -- platform health / dashboard / metrics` | 平台运维视图与指标 |
| `npm run platform -- telemetry cost / metrics` | 真实遥测成本与指标 |
| `npm run platform -- serve` | 启动 API + Web Dashboard（`npm run build:web` 先行构建前端） |
| `npm run platform -- migrate check` / `backup save <file>` / `preflight` / `smoke` | 迁移检查 / 备份 / 上线自检 / 冒烟 |
| `npm run platform:test` / `platform:integration` / `platform:e2e` | 平台单元 / 集成 / 核心 E2E 测试 |
| `npm run build:web` | 构建 Web Dashboard 前端（React + Vite） |
| `node dist/bin/run-test.js --help` | 查看执行参数 |

**依赖**：Node.js ≥ 20.11（内置 fetch）、TypeScript；运行时依赖 `ali-oss`、`chokidar`、`p-limit`；登录态文件 `/Users/mac/agents/test-Configuration/session-cookies.json`（已有 test / preonline 两环境）。
