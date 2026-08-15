# 盼趣AI 测试执行流程（test-flow）

> 版本：v3.0（TypeScript 重构版）｜ 更新：2026-08-15 ｜ 维护：AI 测试智能体
> 标准化、可一键执行的功能测试流程交付包。**所有 AI 功能测试任务强制按此流程执行**。
> 本流程为**多模块通用框架**：视频生成、剧本分镜、账单、其他 AI 能力等模块均可接入（见 `docs/01-测试流程SOP.md` 的「新模块接入指引」）。

流程：`[0 启动清单] → [1 需求输入] → [2 编写用例] → [3 代码核对] → [4 数据隔离分析] → [5 数据需求清单] → [6 脚本执行] → [7 输出报告]`

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v3.0 | 2026-08-15 | TypeScript 重构：模块化分层 `src/`（core 引擎 / cases 用例 / assertions 断言 / reports 报告 / integrations 集成 / utils 工具 / plugins 场景 / config 配置）；插件式场景处理器 + 7 标准钩子 + 断言注册表；三格式报告（HTML/JSON/JUnit）；`--task` 支持文件或目录批量；渐进式迁移（旧 `scripts/` 保留） |
| v2.0 | 2026-08-15 | 插件式重构：新增 `lib/scenes/` 场景处理器（video.js），run-test.js 通用化按 scene 路由；docs/05 模板通用化（去 Wan3.0 专属）；SOP 新增「新模块接入指引」；README 去 Wan3.0 化 |
| v1.3 | 2026-08-15 | 优化去重：删除与 docs/05 模板完全重复的章节；合并 docs/02+03+04 为模板合集；代码层重构（素材函数迁入 assets.js、修复步骤编号、删除未用方法） |
| v1.2 | 2026-08-15 | 新增「项目说明格式规范」等章节；四场景验证表更新为最新任务 ID |
| v1.1 | 2026-08-15 | 输出归档规则升级为 `output/<日期>/<功能名>/`，脚本支持 `--func` |
| v1.0 | 2026-08-12 | 交付包初始化 |

## ⚠ 强制约定

1. **所有任务**（视频生成、剧本分镜、账单调整、模型接入、其他 AI 能力等）都必须走本流程，无例外。
2. 每个新任务开始前，**必须先输出《新任务启动检查清单》并等你确认**，确认后才进入用例编写与执行。
3. 任务定义放 `tasks/<任务名>.json`（JSON 格式，见 `tasks/_template.json`）或 `src/cases/tasks/<任务名>.ts`（TS 脚本，类型安全，见 `src/cases/tasks/wan3-wensheng.ts`）。
4. **素材来源**：上传文件（图片/音频/视频）默认从测试素材库 `/Users/mac/agents/Test-panqu/` 取用；任务定义中用相对路径引用，脚本自动扫描并解析。
5. **输出位置（强制）**：所有输出文件按 `output/<YYYY-MM-DD>/<功能名>/` 结构存放，执行脚本用 `--func <功能名>` 指定功能名并自动创建目录写入，禁止输出到其他位置。
6. **项目说明格式**：所有功能交付包的 `README-项目说明.md` 必须按 `docs/05-项目说明模板.md`（v2.1，通用格式）编写。

## 目录结构

```
test-flow/
├── README.md                    # 本文件（流程说明）
├── docs/
│   ├── 01-测试流程SOP.md        # 完整流程规范（含「新模块接入指引」）
│   ├── 02-模板合集.md           # 测试用例 / 数据需求清单 / 启动检查清单 三合一模板
│   └── 05-项目说明模板.md       # 项目说明统一格式模板（通用）
├── src/                         # ★ TypeScript 源码（模块化分层）
│   ├── core/                    # 核心引擎：types / engine / pipeline / hooks / scene-handler
│   ├── cases/                   # 用例层：define / registry / loader + tasks/（TS 用例脚本）
│   ├── assertions/              # 断言库：db-check / billing-check / isolation-check / account-check / impact
│   ├── reports/                 # 报告器：html / json / junit + factory
│   ├── integrations/            # 外部集成：http / billing / assets
│   ├── plugins/scenes/          # ★ 场景处理器（插件式，新模块在此新增）
│   │   └── video.ts             # 视频场景处理器（文生/图生/全能参考/首尾帧）
│   ├── config/                  # 配置：environments.json + config.ts（schema 校验）
│   └── utils/                   # 工具：logger / fs-utils / time
├── bin/run-test.ts              # CLI 入口（编译为 dist/bin/run-test.js）
├── scripts/                     # 旧版 JS 脚本（渐进迁移保留；新架构见 src/）
├── tasks/                       # JSON 任务定义（渐进迁移保留）
│   ├── _template.json           # 新任务定义模板
│   ├── wan3-wensheng.json       # Wan3.0 文生视频
│   ├── wan3-tusheng.json        # Wan3.0 图生视频
│   ├── wan3-quanneng.json       # Wan3.0 全能参考
│   └── wan3-shouwei.json        # Wan3.0 首尾帧
├── dist/                        # tsc 编译产物（npm run build 生成，可独立运行）
├── package.json / tsconfig.json # 工程配置（ESM + NodeNext + strict）
└── output/                      # 旧版报告目录（已停用；新报告输出到 /Users/mac/agents/output/<日期>/<功能名>/）
```

测试素材库（固定）：
`/Users/mac/agents/Test-panqu/`（`audio/` `photo/` `txt/` `video/`）

## 快速开始

```bash
# 0. 首次：安装依赖 + 编译
cd /Users/mac/agents/test-flow
npm install
npm run build

# 1. 你提供需求 → 我输出《启动检查清单》+ 任务定义，你确认
# 2. 一键执行（默认 test 环境；--task 支持文件或目录批量）
node dist/bin/run-test.js --task tasks/<任务名>.json --func <功能名>
node dist/bin/run-test.js --task tasks --func <功能名>                # 批量执行 tasks/ 下全部用例
node dist/bin/run-test.js --task src/cases/tasks --func <功能名>       # 批量执行 TS 用例（编译后走 dist/src/cases/tasks）

# 3. 切换到 preonline 环境 / 多格式报告（可叠加）
node dist/bin/run-test.js --task tasks/<任务名>.json --env=preonline --func <功能名>
node dist/bin/run-test.js --task tasks/<任务名>.json --func <功能名> --reporter html,json,junit

# 4. 查看可用参数
node dist/bin/run-test.js --help
```

参数说明：

| 参数 | 必填 | 说明 |
|---|---|---|
| `--task` | 是 | 任务定义路径：单个文件（`.json` 或 TS 编译的 `.js`）或目录（批量执行全部用例） |
| `--env` | 否 | 执行环境，默认 `test`，可选 `preonline` |
| `--func` | 否 | 功能名称，用于归档目录 `output/<日期>/<功能名>/`（强制约定） |
| `--reporter` | 否 | 报告格式，默认 `html`，可选 `html,json,junit`（逗号分隔多份） |
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
2. **用例定义**：JSON 放 `tasks/`，TS 脚本放 `src/cases/tasks/`（`defineCase` 包裹，编译期类型检查）。
3. **钩子（Hook）**：7 标准钩子 `beforeAll/beforeScene/beforeStep/afterStep/afterScene/afterAll/beforeReport`，按需挂载自定义逻辑。
4. **断言**：用 `registerAssertion(name, fn)` 注册自定义核验项。
5. **报告器**：实现 `Reporter` 接口（`name/write`），在 `src/reports/factory.ts` 登记即可多格式输出。

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
| `05-项目说明模板.md` | 编写交付包 `README-项目说明.md` 时参考（通用格式） |

报告内容章节（脚本自动生成的 HTML 报告包含）：

1. 执行概览（任务状态、任务 ID、模型、环境、积分净消耗、用例通过率）
2. 测试用例结果（PASS / FAIL / 待人工）
3. 接口响应摘要（各环节 HTTP 状态与业务码）
4. 数据隔离 / 影响分析（表与模块影响清单、数据正确性核验）
5. 素材库使用（引用的素材与解析结果）
6. 问题卡点（阻塞 / 数据异常 / 待人工验证）
7. 浏览器人工待办
