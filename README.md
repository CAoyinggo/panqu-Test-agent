# 盼趣AI 测试执行流程（test-flow）

> 版本：v3.4（数据工厂与环境检测版）｜ 更新：2026-08-17 ｜ 维护：AI 测试智能体

标准化、可一键执行的多业务 AI 功能测试智能体框架。**所有 AI 功能测试任务强制按此流程执行**。每个业务功能在 `src/cases/{feature}/` 下独占一个子文件夹即可独立接入，当前内置 `wan3`（视频生成）作为示例模块，实际使用时可将任意业务（如 `user`、`order`、`payment`）替换接入，无需改动框架代码。

📄 **[查看交互式 HTML 项目完整说明](file:///Users/mac/agents/test-flow-project-overview/test-flow-project-overview.html)**（含架构图与数据图表，本地打开）

流程：`[0 启动清单] → [1 需求输入] → [2 编写用例] → [3 代码核对] → [4 数据隔离分析] → [5 数据需求清单] → [6 脚本执行] → [7 输出报告]`

---

## 一、项目概述

test-flow 覆盖从用例定义、脚本执行、断言核验、数据生成、并发调度到多格式报告输出的完整链路，核心思想是**目录即模块**：新增业务只需在 `src/cases/` 下新建子文件夹并放入用例脚本，加载器自动递归扫描识别，无需改动任何框架代码。

**关键指标**

| 指标 | 数值 |
|---|---|
| 单元测试用例 | 225 条（8 个测试文件） |
| 断言操作符 | 17 个 |
| 核心引擎模块 | 13 个文件 |
| 标准生命周期钩子 | 7 个 |
| 版本演进 | v1.0 → v3.4（8 个里程碑） |
| 运行时 | Node.js ≥ 20.11 |

**技术栈**：TypeScript + ESM（NodeNext 严格模式）、Vitest + v8 覆盖率、ajv JSON Schema 校验、p-limit 并发池、chokidar 文件监听、Docker 镜像化。

## 二、架构总览

源码按职责划分为八层，各层通过标准接口解耦，插件式扩展点在每一层都预留了登记入口。

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

数据流：`CLI 入口 → 核心引擎 → 场景处理器 / 7 钩子 → 执行流水线 → 断言系统 / 数据工厂 / 环境检测 / 并发控制 → 报告四通道 + 飞书通知`。

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

基于 Vitest（含 v8 覆盖率），`tests/unit/` 下共 8 个测试文件、**225 条用例**。

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

覆盖率门禁配置于 `vitest.config.ts`：行覆盖 ≥ 80%、函数覆盖 ≥ 80%、分支覆盖 ≥ 75%、语句覆盖 ≥ 80%。

## 七、报告与通知

报告层采用工厂模式，实现 `Reporter` 接口（`name/write`）即可登记多格式输出。

| 通道 | 实现 | 内容要点 |
|---|---|---|
| HTML | `html-reporter.ts` | 执行概览、用例结果、接口响应摘要、数据隔离/影响分析、素材使用、问题卡点、人工待办、断言详情（按 assertionType 分组）、并发调整历史 |
| JSON | `json-reporter.ts` | 结构化执行数据，供下游消费与趋势分析 |
| JUnit XML | `junit-reporter.ts` | 标准 JUnit 格式，可直接接入 CI 平台 |
| Allure | `allure-reporter.ts` | Allure 报告数据生成，配套 `ci:allure` 脚本 |
| 飞书通知 | `notifiers/feishu.ts` | 失败断言详情块（`path | operator | expected | actual`） |

输出强制归档到 `output/<YYYY-MM-DD>/<功能名>/`；并发模式下报告写入 `<功能名>/<caseId>/` 子目录，日志带 `[caseId]` 前缀隔离。

## 八、CLI 参数

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

## 九、CI/CD 与安全

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

## 十、扩展指南

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

## 十一、版本历史

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

在 v3.4 之上，后续迭代进一步沉淀了通用断言引擎、数据生成 / Mock 录制回放 / 动态并发三大能力，以及断言可视化引擎，均以独立 commit 演进：`e554843` → `4c8b52b` → `4c1581d` → `ee83ebe`。

## 十二、目录结构

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
│   └── assertion-dsl.md         # 断言 DSL 语法文档
├── src/                         # ★ TypeScript 源码（模块化分层）
│   ├── core/                    # 核心引擎：types / engine / pipeline / hooks / scene-handler / data-factory / env-checker / teardown
│   ├── cases/                   # 用例层：define / registry / loader（多功能模块化）
│   │   ├── {feature}/           # ★ 功能模块：每个子文件夹 = 一个独立业务功能（wan3 / user / order / payment ...）
│   │   └── (新功能)              # 新增功能只需在 src/cases/ 下新建子文件夹即可即插即用
│   ├── assertions/              # 断言库：db-check / billing-check / isolation-check / account-check / impact / security-check / chaos-check / status-flow-check + adapters/wan3-adapter
│   ├── reports/                 # 报告器：html / json / junit + factory
│   ├── integrations/            # 外部集成：http / billing / assets / notifiers
│   ├── plugins/scenes/          # ★ 场景处理器（插件式，新模块在此新增）
│   │   └── video.ts             # 视频场景处理器（文生/图生/全能参考/首尾帧）
│   ├── config/                  # 配置：environments.json + config.ts（schema 校验）
│   └── utils/                   # 工具：logger / metrics / retry / data-generator / mock-recorder / concurrency-controller / assertion-visualizer / exit-code / fs-utils / time / trace / allure-reporter / junit-reporter / oss-uploader
├── tests/unit/                  # Vitest 单元测试（8 个文件，225 条用例）
├── bin/run-test.ts              # CLI 入口（编译为 dist/bin/run-test.js）
├── scripts/                     # 构建/迁移/安全/CI 工具
├── tasks/                       # JSON 任务定义（迁移源，保留）
│   ├── _template.json           # 新任务定义模板
│   └── {功能}-{任务名}.json     # 按「功能-任务名」命名，如 wan3-wensheng / user-login / order-create
├── dist/                        # tsc 编译产物（npm run build 生成，可独立运行）
├── package.json / tsconfig.json # 工程配置（ESM + NodeNext + strict）
└── output/                      # 旧版报告目录（已停用；新报告输出到 /Users/mac/agents/output/<日期>/<功能名>/）
```

测试素材库（固定）：`/Users/mac/agents/Test-panqu/`（`audio/` `photo/` `txt/` `video/`）。

## 十三、强制约定

1. **所有任务**（视频生成、剧本分镜、账单调整、模型接入、其他 AI 能力等）都必须走本流程，无例外。
2. 每个新任务开始前，**必须先输出《新任务启动检查清单》并确认**，确认后才进入用例编写与执行。
3. 任务定义放 `tasks/{功能}-{任务名}.json`（见 `tasks/_template.json`）或 `src/cases/{功能}/{任务名}.ts`（TS 脚本，类型安全）。
4. **素材来源**：上传文件默认从测试素材库 `/Users/mac/agents/Test-panqu/` 取用；任务定义中用相对路径引用，脚本自动扫描并解析。
5. **输出位置（强制）**：所有输出文件按 `output/<YYYY-MM-DD>/<功能名>/` 结构存放，执行脚本用 `--func <功能名>` 指定并自动创建目录，禁止输出到其他位置。
6. **项目说明格式**：所有功能交付包的 `README-项目说明.md` 必须按 `docs/05-项目说明模板.md`（v2.1）编写。

## 十四、快速开始

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
| `node dist/bin/run-test.js --help` | 查看执行参数 |

**依赖**：Node.js ≥ 20.11（内置 fetch）、TypeScript；运行时依赖 `ali-oss`、`chokidar`、`p-limit`；登录态文件 `/Users/mac/agents/test-Configuration/session-cookies.json`（已有 test / preonline 两环境）。
