# 盼趣AI 测试执行流程（test-flow）

> 版本：v3.3（并发执行版）｜ 更新：2026-08-16 ｜ 维护：AI 测试智能体
> 标准化、可一键执行的功能测试流程交付包。**所有 AI 功能测试任务强制按此流程执行**。
> 本流程为**多业务、即插即用的测试智能体框架**：每个业务功能在 `src/cases/{feature}/` 下独占一个子文件夹即可独立接入。当前内置 `wan3`（视频生成）作为示例模块，实际使用时可将任意业务（如 `user`、`order`、`payment`）替换接入，无需改动框架代码。

流程：`[0 启动清单] → [1 需求输入] → [2 编写用例] → [3 代码核对] → [4 数据隔离分析] → [5 数据需求清单] → [6 脚本执行] → [7 输出报告]`

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v3.3 | 2026-08-16 | 并发执行：新增 `--concurrency <N>` / `--parallel` 参数；按 feature 分组（组内串行 + 组间并行）；`p-limit` 并发池；并发模式下报告写入 caseId 子目录 `output/<日期>/<功能名>/<caseId>/`；日志增加 `[caseId]` 前缀隔离；串行模式（默认）完全向后兼容 |
| v3.2 | 2026-08-16 | 多功能模块化：用例目录按功能分子文件夹 `src/cases/<功能>/`（wan3-*.ts 去前缀移入 `wan3/`）；loader 递归扫描全部功能模块 + ignore 配置（common/base/shared）；`--task` 支持功能子目录 / 根目录全量 / 单文件（向后兼容）；迁移脚本按 JSON 文件名前缀自动建子文件夹；新增 `test:wan3/test:user/test:order` 脚本；真机回归 4 个 Wan3.0 任务报告与改动前完全一致（passRate 86%、步骤数、检查项结构） |
| v3.0 | 2026-08-15 | TypeScript 重构：模块化分层 `src/`（core 引擎 / cases 用例 / assertions 断言 / reports 报告 / integrations 集成 / utils 工具 / plugins 场景 / config 配置）；插件式场景处理器 + 7 标准钩子 + 断言注册表；三格式报告（HTML/JSON/JUnit）；`--task` 支持文件或目录批量；渐进式迁移（旧 `scripts/` 保留） |
| v2.0 | 2026-08-15 | 插件式重构：新增 `lib/scenes/` 场景处理器（video.js），run-test.js 通用化按 scene 路由；docs/05 模板通用化（去 Wan3.0 专属）；SOP 新增「新模块接入指引」；README 去 Wan3.0 化 |
| v1.3 | 2026-08-15 | 优化去重：删除与 docs/05 模板完全重复的章节；合并 docs/02+03+04 为模板合集；代码层重构（素材函数迁入 assets.js、修复步骤编号、删除未用方法） |
| v1.2 | 2026-08-15 | 新增「项目说明格式规范」等章节；四场景验证表更新为最新任务 ID |
| v1.1 | 2026-08-15 | 输出归档规则升级为 `output/<日期>/<功能名>/`，脚本支持 `--func` |
| v1.0 | 2026-08-12 | 交付包初始化 |

## ⚠ 强制约定

1. **所有任务**（视频生成、剧本分镜、账单调整、模型接入、其他 AI 能力等）都必须走本流程，无例外。
2. 每个新任务开始前，**必须先输出《新任务启动检查清单》并等你确认**，确认后才进入用例编写与执行。
3. 任务定义放 `tasks/{功能}-{任务名}.json`（JSON 格式，见 `tasks/_template.json`）或 `src/cases/{功能}/{任务名}.ts`（TS 脚本，类型安全，按功能分子文件夹；示例见 `src/cases/wan3/wensheng.ts`）。
4. **素材来源**：上传文件（图片/音频/视频）默认从测试素材库 `/Users/mac/agents/Test-panqu/` 取用；任务定义中用相对路径引用，脚本自动扫描并解析。
5. **输出位置（强制）**：所有输出文件按 `output/<YYYY-MM-DD>/<功能名>/` 结构存放，执行脚本用 `--func <功能名>` 指定功能名并自动创建目录写入，禁止输出到其他位置。
6. **项目说明格式**：所有功能交付包的 `README-项目说明.md` 必须按 `docs/05-项目说明模板.md`（v2.1，通用格式）编写。

## 目录结构

```
test-flow/
├── README.md                    # 本文件（流程说明）
├── docs/                        # 流程与模板文档
│   ├── 01-测试流程SOP.md        # 完整流程规范（含「新模块接入指引」）
│   ├── 02-模板合集.md           # 测试用例 / 数据需求清单 / 启动检查清单 三合一模板
│   ├── 02-测试用例模板.md       # 测试用例模板（独立版）
│   ├── 03-数据需求清单模板.md   # 数据需求清单模板
│   ├── 04-新任务启动检查清单模板.md  # 新任务启动检查清单模板
│   └── 05-项目说明模板.md       # 项目说明统一格式模板（通用）
├── src/                         # ★ TypeScript 源码（模块化分层）
│   ├── core/                    # 核心引擎：types / engine / pipeline / hooks / scene-handler
│   ├── cases/                   # 用例层：define / registry / loader（多功能模块化）
│   │   ├── {feature}/           # ★ 功能模块：每个子文件夹 = 一个独立业务功能（wan3 / user / order / payment ...）
│   │   │   └── {任务名}.ts      # 功能内用例脚本（如 wan3 下：wensheng / tusheng / quanneng / shouwei）
│   │   └── (新功能)              # 新增功能只需在 src/cases/ 下新建子文件夹即可即插即用
│   ├── assertions/              # 断言库：db-check / billing-check / isolation-check / account-check / impact
│   ├── reports/                 # 报告器：html / json / junit + factory
│   ├── integrations/            # 外部集成：http / billing / assets / isolation
│   ├── plugins/scenes/          # ★ 场景处理器（插件式，新模块在此新增）
│   │   └── video.ts             # 视频场景处理器（文生/图生/全能参考/首尾帧）
│   ├── config/                  # 配置：environments.json + config.ts（schema 校验）
│   └── utils/                   # 工具：logger / fs-utils / time
├── bin/run-test.ts              # CLI 入口（编译为 dist/bin/run-test.js）
├── scripts/                     # 构建/迁移工具（copy-assets / migrate-json-to-ts / verify-migration）
│   └── _legacy/                 # 旧版 v2.0 JS 运行时归档（已停用，仅备查）
├── tasks/                       # JSON 任务定义（迁移源，保留）
│   ├── _template.json           # 新任务定义模板
│   └── {功能}-{任务名}.json     # 按「功能-任务名」命名，如 wan3-wensheng / user-login / order-create
├── dist/                        # tsc 编译产物（npm run build 生成，可独立运行）
├── package.json / tsconfig.json # 工程配置（ESM + NodeNext + strict）
└── output/                      # 旧版报告目录（已停用；新报告输出到 /Users/mac/agents/output/<日期>/<功能名>/）
```

测试素材库（固定）：
`/Users/mac/agents/Test-panqu/`（`audio/` `photo/` `txt/` `video/`）

> **功能模块约定**：`src/cases/` 下每个子文件夹 `{feature}/` 对应一个**独立业务功能**（如 `wan3` 视频生成、`user` 用户体系、`order` 订单、`payment` 支付），加载器自动递归扫描并识别，归档到 `output/<日期>/{功能名}/`。**新增功能只需新建一个子文件夹并放入用例脚本，无需改动任何框架代码**。

## 快速开始

```bash
# 0. 首次：安装依赖 + 编译
cd /Users/mac/agents/test-flow
npm install
npm run build

# 1. 你提供需求 → 我输出《启动检查清单》+ 任务定义，你确认
# 2. 一键执行（--task 支持：功能子目录 / 根目录全量 / 单文件）
#    ⚠ 以下以 wan3 为例：如果您的功能名为 user，则将 wan3 替换为 user（命令同理）
node dist/bin/run-test.js --task tasks/wan3-wensheng.json --func wan3      # 单文件执行（user 示例：--task tasks/user-login.json --func user）
node dist/bin/run-test.js --task src/cases/wan3                            # 单功能模块执行（user 示例：--task src/cases/user）
node dist/bin/run-test.js --task src/cases                                 # 递归全量执行所有功能模块

# 3. 切换到 preonline 环境 / 多格式报告（可叠加）
node dist/bin/run-test.js --task src/cases/wan3 --env=preonline --func wan3
node dist/bin/run-test.js --task src/cases/wan3 --func wan3 --reporter html,json,junit

# 4. 查看可用参数
node dist/bin/run-test.js --help
```

参数说明：

| 参数 | 必填 | 说明 |
|---|---|---|
| `--task` | 是 | 任务定义路径：功能子目录 `src/cases/{功能}`（如 `src/cases/wan3`，单功能）、根目录 `src/cases`（全量递归）、或单个文件（`.json` / TS 编译的 `.js`，向后兼容） |
| `--env` | 否 | 执行环境，默认 `test`，可选 `preonline` |
| `--func` | 否 | 功能名称，用于归档目录 `output/<日期>/<功能名>/`（强制约定） |
| `--reporter` | 否 | 报告格式，默认 `html`，可选 `html,json,junit`（逗号分隔多份） |
| `--concurrency` | 否 | 并发数（默认 1 = 串行）。同一 feature 内用例串行，不同 feature 间并行 |
| `--parallel` | 否 | 自动并发，并发数取 CPU 核心数（上限 4）。优先于 `--concurrency` |
| `--help` | 否 | 显示帮助 |

## 依赖

- Node.js ≥ 18（内置 fetch）、TypeScript（`npm run build` 编译）
- 登录态文件：`/Users/mac/agents/test-Configuration/session-cookies.json`（已有 test / preonline 两环境）

## 首次使用前置准备

1. **登录态**：确认 `session-cookies.json` 存在且包含所需环境（test / preonline）的 `cookie_string` 与 `project_id`。过期或缺失时由用户重新提供浏览器会话更新。
2. **脚本配置**：`src/config/environments.json` 已预置两环境接口地址与状态文本；新增环境需补全 `base_url/submit_url/status_url/detail_url/billing_url/csrf_page`（schema 校验自动检查）。
3. **素材库**：确认 `/Users/mac/agents/Test-panqu/` 存在，任务引用的素材相对路径能解析到实际文件。

## 每次执行的约定

1. **你提供**：任务名 / 场景类型 / 提示词 / 参数。素材无需特别提供，默认从测试素材库取用。
2. **我输出**：启动检查清单 + 任务定义（JSON 或 TS 用例，素材用相对路径引用）。
3. **你确认**：启动清单逐项确认后，我写用例 → 执行脚本 → 生成报告（**输出到 `/Users/mac/agents/output/<日期>/<功能名>/`**）。
4. **素材取用**：脚本自动扫描素材库，按任务定义中的相对路径解析文件并上传；长文本从 `txt/` 读取。
5. **浏览器用例**：脚本标记为「待人工实测」，你按报告中的操作步骤在页面验证并反馈。

## 场景接入状态

| 场景 | 脚本接入 | 处理器 |
|---|---|---|
| 文生视频 / 图生视频 / 全能参考 / 首尾帧 | 已接入 | `src/plugins/scenes/video.ts` |
| 剧本分镜 | 待接入 | 新增 `src/plugins/scenes/juben.ts`（见接入指引） |
| 账单 / 计费调整 | 待接入 | 新增 `src/plugins/scenes/billing.ts`（见接入指引） |
| 其他 AI 能力 | 待接入 | 新增对应 `src/plugins/scenes/<name>.ts` |

> 半自动模式：场景未接入处理器时，脚本仍会执行通用骨架（登录态/素材/影响分析/计费/报告），并将提交/状态标记为「待人工」，不影响出报告。

## 架构扩展点（新模块接入）

1. **场景处理器**：新建 `src/plugins/scenes/<name>.ts`，实现 `SceneHandler`（`match/submit/detail/status/analyzeBilling`），在 `src/core/engine.ts` 的 `SCENES` 注册表登记。
2. **用例定义**：JSON 放 `tasks/`（迁移源，见 `tasks/_template.json`），TS 脚本放 `src/cases/<功能>/`（`defineCase` 包裹，编译期类型检查；每个子文件夹 = 一个功能模块，新增功能在 `src/cases/` 下新建子文件夹即可）。
3. **迁移**：`node scripts/migrate-json-to-ts.ts` 按文件名前缀自动建子文件夹（如 `{功能}-xxx.json` → `src/cases/{功能}/xxx.ts`，例：`wan3-wensheng.json` → `src/cases/wan3/wensheng.ts`）。
4. **钩子（Hook）**：7 标准钩子 `beforeAll/beforeScene/beforeStep/afterStep/afterScene/afterAll/beforeReport`，按需挂载自定义逻辑。
5. **断言**：用 `registerAssertion(name, fn)` 注册自定义核验项。
6. **报告器**：实现 `Reporter` 接口（`name/write`），在 `src/reports/factory.ts` 登记即可多格式输出。

## 新增业务功能（三步即插即用）

以新增 `user`（用户体系）功能为例：

1. **建目录**：在 `src/cases/` 下新建 `user/` 子文件夹；
2. **放用例**：在 `tasks/` 放入 `user-login.json` 后执行迁移 `node scripts/migrate-json-to-ts.ts`，自动生成 `src/cases/user/login.ts`（或手写 TS 用例）；
3. **执行**：`npm run test:user`（等价于 `node dist/bin/run-test.js --task src/cases/user`），报告自动归档到 `output/<日期>/user/`。

> 全程无需改动 loader / engine / 任何框架代码——框架按目录结构自动识别新功能。其余业务（`order`、`payment` 等）同理。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 编译 TS 到 `dist/` 并复制非 TS 资源（environments.json） |
| `npm run test:all` | 编译 + 校验 JSON 源与 TS 用例一致性（离线，不扣积分） |
| `npm run test:wan3` | 示例：真机执行 wan3 功能全部用例（归档到 `output/<日期>/wan3/`）。**如果您的功能名为 `user`，请替换为 `npm run test:user`**——每个功能对应一条 `test:<功能名>` 脚本 |
| `npm run test:regression` | 全量回归：编译 + 执行所有功能模块（CI 模式，归档到各自功能目录） |
| `npm run migrate -- [--force]` | 将 `tasks/*.json` 迁移为 `src/cases/<功能>/*.ts`（按前缀自动分目录，幂等） |
| `node dist/bin/run-test.js --help` | 查看执行参数 |

> **并发执行**：`--parallel` 或 `--concurrency <N>` 开启并发模式。按 feature 分组（组内串行避免积分冲突，组间并行缩短回归时间）。并发模式下报告写入 `<功能名>/<caseId>/` 子目录，日志加 `[caseId]` 前缀。不传参数时默认串行，行为与改造前完全一致。

## 项目说明格式规范

每个功能交付包应包含以下文件，全部存放在 `output/<日期>/<功能名>/`：

| 文件 | 必填 | 说明 |
|---|---|---|
| `README-项目说明.md` | 是 | 项目说明，必须按 `docs/05-项目说明模板.md`（v2.1）编写 |
| `{任务名}_*.html` | 是 | 单场景测试报告（每场景 1 份，脚本自动生成） |
| `{功能名}汇总_*.html` | 是 | 多场景整合汇总报告 |

docs/ 文档索引：

| 文档 | 使用时机 |
|---|---|
| `01-测试流程SOP.md` | 完整流程规范 + 新模块接入指引，所有任务执行依据 |
| `02-模板合集.md` | 测试用例 / 数据需求清单 / 启动检查清单三合一模板 |
| `02-测试用例模板.md` | 单份测试用例模板 |
| `03-数据需求清单模板.md` | 编写数据需求清单时参考 |
| `04-新任务启动检查清单模板.md` | 新任务启动前输出检查清单时参考 |
| `05-项目说明模板.md` | 编写交付包 `README-项目说明.md` 时参考（通用格式） |

报告内容章节（脚本自动生成的 HTML 报告包含）：

1. 执行概览（任务状态、任务 ID、模型、环境、积分净消耗、用例通过率）
2. 测试用例结果（PASS / FAIL / 待人工）
3. 接口响应摘要（各环节 HTTP 状态与业务码）
4. 数据隔离 / 影响分析（表与模块影响清单、数据正确性核验）
5. 素材库使用（引用的素材与解析结果）
6. 问题卡点（阻塞 / 数据异常 / 待人工验证）
7. 浏览器人工待办
