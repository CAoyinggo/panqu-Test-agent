# 盼趣 AI 测试平台

> 面向多业务 AI 功能的测试执行与质量治理平台，覆盖用例定义、场景执行、断言、报告、调度、评测和成本治理。

| 项目 | 当前状态 |
| --- | --- |
| 版本 | `v4.35.0` |
| 运行时 | Node.js `>= 24.11.0` |
| 后端 | TypeScript + ESM + NodeNext |
| Web | React + Vite |
| 测试 | Vitest + Playwright |
| 架构 | Modular Monolith + 插件式场景处理器 |

[文档索引](docs/README.md) · [版本记录](docs/CHANGELOG.md)

[DevTest TestCase V2](docs/testing/testcase-v2-schema.md) · [Developer Self-Test](docs/testing/developer-self-test.md) · [交接/发布检查清单](docs/testing/developer-handoff-release-checklist.md) · [Legacy 断言 DSL](docs/assertion-dsl.md) · [开发验收使用指南](docs/developer-acceptance.md) · [部署指南](docs/operations/deployment.md)

## 本次更新：v4.35.0 业务一致性与质量门禁

本版新增以下组件。版本号表示源码版本；是否安装、部署成功需核对实际入口，不能仅凭 README 判断。未发布 npm，也不代表所有成员的 TRAE 已升级。

| 能力 | 已接入范围与限制 |
| --- | --- |
| 跨步骤审计 | 业务流完成步骤核验后检查 task/project/user/asset 关联及因果时序，冲突进入业务问题；未执行或提前阻断的流程不能据此宣称审计通过 |
| 八项质量门禁 | `runDevTest` 聚合需求覆盖、流程完整性、证据、跨步骤、幂等、数据隔离、清理和 Oracle 结果，影响最终 READY/BLOCKED/NOT_READY；判断依赖已有输入，不自动补采数据库、账单或租户证据 |
| 幂等 Oracle | 提供提交恢复、超时防重、重复扣费/任务、并发、回调和最终状态检查；主流程目前在多次尝试或退款/重试流程时接入账单与任务记录，不等于自动执行全部七类真实故障注入 |
| 数据生命周期 | 导出 `TestDataLifecycleManager`，支持登记实体、清理钩子、隔离检查与失败记录；目前是独立接口，主流程仍使用原生命周期钩子，不会自动删除业务数据 |
| 需求溯源 | 导出 `TraceabilityMatrixBuilder`，关联验收追踪、流程步骤及问题；需调用方显式调用，尚未自动输出单独的溯源矩阵附件 |
| 报告 | JSON 与 HTML 接入 `crossStepAudits`、`idempotencyChecks`、`qualityGates`；没有采集到的证据不得解读为真实业务已验证 |

特别注意：部分门禁在没有适用事件或异常记录时返回 PASS，只能解释为当前输入未发现问题，不是已完成并发、跨租户、退款或清理的真实验收。无可验证业务流且未明确标记不适用时，流程门禁会阻断。门禁失败不会单独将未知证据升级为产品缺陷；已有业务失败仍为 NOT_READY，其余未达标情况阻断交付。上线前仍需配置真实证据源和明确业务授权。

可复现验证（单元、受控集成与安装包验证，不触发供应商生成）：

```bash
npm ci
npm run build
npx --no-install vitest run tests/unit/devtest tests/integration/devtest-mode.test.ts tests/integration/devtest-mcp-kernel.test.ts tests/integration/devtest-detection-regression.test.ts tests/integration/npm-package-acceptance.test.ts --maxWorkers=1
node --test integrations/trae-mcp/native-cli.test.mjs
```

两项依赖真实业务源码快照的分流检查默认跳过；仅在显式设置 `PANQU_SOURCE_FIXTURE_ROOT` 且快照匹配其测试前提时运行，不将跳过项计为通过。会话文件必须显式传入或配置 `PANQU_SESSION_COOKIES_FILE`，无配置时拒绝执行，不读取机器专属默认路径。

2026-09-11 本轮结果：构建通过，上述 41 个 Vitest 文件中 423 项通过、2 项源码快照检查跳过；本地 MCP 8 项通过，包含版本握手、真实执行确认与跨进程报告恢复。安装包验收通过。这不是全仓测试或真实供应商业务验收。

TRAE 同步验收：GitHub `main` 的完整提交 SHA、本地固定快照 `git rev-parse HEAD`、`panqu_native_cli` 的 catalog `engineSha`、`panqu_capabilities` 的云端及本地 SHA 必须相同。每次更新都应从该提交重新安装依赖并构建，重启 MCP 后检查工具和报告链路；历史任务仍保留历史 SHA，不应改写。云端 Actions 固定引用与 Worker 能力声明也必须同步，不能只改版本字符串。凭据仅保留在原受控配置中，禁止写入仓库。

## v4.34.0 更新：Playwright 执行与独立证据核验

本次新增浏览器/API 执行组件、媒体检查器、计费与供应商成本 Oracle、分流决策与跨系统证据采集器，并接入 CLI、业务综合套件和本地 Trae MCP。源码包版本已更新为 `4.34.0`；这不代表已经公开发布 npm 包或更新成员电脑上的 MCP。

| 组件 | 功能与边界 |
| --- | --- |
| `panqu-playwright-engine.ts` / `panqu-playwright-fixture.ts` | 区分 `MOCK`、`API_INTEGRATION` 和 `UI_E2E`；浏览器不可用时阻断 UI 模式。当前页面模式仍含 API 提交逻辑，不等于已覆盖真实表单点击和上传交互 |
| `media-inspector.ts` | 检查 MP4 容器和 PNG/JPEG/WebP 元数据；合成文件和容器解析通过不等于真实媒体可解码，像素/播放验证单独记录 |
| `billing-oracle.ts` | 按任务关联积分流水，检查预扣、结算、退款及重复/缺失记录；默认模型价格是代码规则，不代表实时刊例价 |
| `supplier-cost-oracle.ts` | 将用户积分与供应商成本分离，支持充值批次与多次上游调用；估算、真实账单和证据缺失分开记录，退款不等于供应商成本为零 |
| `routing-oracle.ts` / `routing-evidence-collector.ts` | 区分主站分流与网关选路，按 task/request/trace 标识关联证据；默认渠道配置需在真实运行前核对 |
| 图片/视频详情关联 | 移除“找不到指定任务时取列表第一条”的兜底，避免把其他任务结果当成本次证据 |

### 本地离线验证

```bash
npm ci
npm run build
npx --no-install vitest run tests/unit/devtest/billing-oracle.test.ts tests/unit/devtest/media-inspector.test.ts tests/unit/devtest/panqu-playwright-engine.test.ts tests/unit/devtest/routing-evidence-collector.test.ts tests/unit/devtest/routing-oracle.test.ts tests/unit/panqu-playwright-flow.test.ts
```

本次上述 6 个测试文件的 79 项测试通过，构建通过；这是本地受控/Mock 验证，不是测试站真实生成、NewAPI 路由或最终结算验收，也不是 GitHub CI 结果。

以下入口明确使用 Mock，不用于证明真实业务通过：

```bash
npm run panqu:playwright -- --mock --media video
npm run panqu:playwright -- --mock --media image
npm run panqu:playwright -- --mock --media video --expect-failure
```

独立 CLI 写入 Markdown 报告，执行引擎写入结构化证据。必须核对报告中的 `executionMode`、`testAssertionStatus`、`businessTaskStatus` 与证据等级，不能只用进程退出码判定业务通过。

### Playwright 完整 CLI 与本地 MCP

`devtest playwright --help` 与 `npm run panqu:playwright -- --help` 是无业务请求的帮助入口。
完整参数包括 `--mode api|browser|mock`、`--media video|image`、`--task-id`、`--model`、
`--task-type`、`--prompt`、`--duration`、`--resolution`、`--aspect`、`--serviceline`、
`--env test|preonline`、`--timeout`、`--session-file <绝对路径>`、`--output` 和 `--expect-failure`。
未知参数或缺少参数值会拒绝执行；`--mock` 不会被后面的 `--mode api` 覆盖。
执行完成后，只有 `testAssertionStatus=PASS` 返回退出码 0，FAIL/BLOCKED 返回 1。

已配置混合适配器的 TRAE 使用 `panqu_native_cli` 的 `program: playwright`；这不是
通用 `devtest-mcp` 自动新增的工具。先 `args: ["--help"]`，离线验证明确传 `--mock`。
真实操作需用户逐次授权并传 `confirm_real_execution: true`，此字段不能代替费用/环境确认。
会话只通过顶层 `session_file` 绝对路径、CLI `--session-file`，或白名单环境变量
`PANQU_SESSION_COOKIES_FILE` 传递，禁止把 Cookie/API Key 内容放入参数或聊天。

本地任务返回 `jobId`；`panqu_report` 传 `local_job_id` 列文件，再传 `file`、`offset`、
`limit`（最多 65536 字符）读取脱敏全文。`panqu_cases` 传 `local_job_id` 列出证据文件，
协议标记为 `PLAYWRIGHT_FLOW_EVIDENCE`，不冒充 TEST_CASE_V2。`local_job_id` 与云端
`submission_id` 互斥；没有指定本地 ID 时，旧云端报告接口保持原语义。
本地输出位于专属 `mcp-<jobId>` 子目录（提供 `--output` 时以该目录为父目录），不读取原始 Trace。
任务索引以 0600 权限原子保存，不保存命令参数、stdout、环境变量或会话路径。
重启后可继续用原 `jobId` 查询状态、报告和证据；历史任务保留其原始引擎 SHA。
未记录终态的任务返回 `UNKNOWN_AFTER_RESTART`，不会自动重跑或伪造成功。
旧版从未持久化的索引不能凭空恢复，旧报告文件仍保留。

`real-video`、`real-image`、`real-canvas` 及对应 `flow real-*-submit` 入口同样要求
`confirm_real_execution: true`，其 Markdown/JSON 报告接入上述本地读取机制。
旧 `flow playwright-diversion` 和 `flow api-diversion --playwright` 复用完整参数解析器，
兼容 `--model-id`、`--model-type`、`--poll-timeout`、`--aspect-ratio` 别名。
旧入口仍默认 Mock；明确 `--mode api|browser` 或 `--real-submit` 才请求真实执行，显式 `--mock` 优先。
未知参数会拒绝；以前未生效的 Playwright `--project-root` 不再静默忽略，应使用工作目录或 MCP 的 `project_root`。

仓库内的 `integrations/trae-mcp/` 保存本地适配实现；部署端必须指定已构建的固定提交目录及 SHA。
完整 Playwright 入口属于 LOCAL_MAC；云端 `panqu_run` 仍按自己的 schema 提供 DevTest/agent 动作，
升级内核 SHA 不等于自动增加云端浏览器、模型凭据、数据库或多账号配置。

### 真实执行与 TRAE 接入边界

- `devtest flow api-diversion --playwright`、`devtest flow business-suite --module playwright` 以及不带 `--mock` 的独立 Playwright CLI 可能提交真实任务并消耗积分。综合套件的 `all` 现在包含 Playwright 模块，不应当作无副作用的健康检查。
- 本轮没有运行真实生图/视频、队列、数据库写入或部署。运行前必须另行确认账号、环境、模型、次数、费用及清理范围。
- **NewAPI 只能使用环境明确为“测试”的资源，禁止操作正式数据。** `--env test`、测试站域名或 `devtest_` 名称前缀不能单独证明网关资源隔离；需核对真实资源归属，无法确认时不要运行。
- Trace 可能包含请求头、页面内容和业务信息，不能假定原始 Trace 已脱敏；真实运行的 Trace、会话文件、Cookie 和 Token 禁止提交或公开上传。
- 更新 GitHub 源码不会自动更新 TRAE 中的本地 MCP、远程 Worker 或 Actions 固定 SHA。管理员需按各入口的安装方式更新版本，再在 TRAE 新会话核验实际工具、版本和完整执行/报告链路。
- GitHub 同步不代表 npm 发布、远程部署或所有成员已升级。

## 目录

- [项目简介](#项目简介)
- [快速开始](#快速开始)
- [智能体 v2](#智能体-v2)
- [Developer Self-Test](#developer-self-test)
- [执行链路](#执行链路)
- [核心能力](#核心能力)
- [系统架构](#系统架构)
- [测试与质量门禁](#测试与质量门禁)
- [CLI 使用](#cli-使用)
- [配置与部署](#配置与部署)
- [扩展新业务](#扩展新业务)
- [仓库结构](#仓库结构)
- [工程约定](#工程约定)
- [文档与版本历史](#文档与版本历史)

## 项目简介

test-flow 是一套标准化、可自动执行的 AI 测试平台。每个业务功能在 `src/cases/{feature}/` 中独立维护，用例加载器会递归发现测试，无需修改核心框架。

平台包含三条相互衔接的主链路：

1. **测试执行链路**：需求与 DSL → Canonical Scene → Processor
   → Runner → Assertion → Result → Report。
2. **质量治理链路**：真实执行结果 → AI Evaluation → Feedback
   → Improvement → Shadow / Canary → Release Gate。
3. **智能体认知链路**：Requirement Agent v2 → Risk / Test Design v2
   → Runtime / Evidence → Analysis Agent v2；LLM 负责理解和解释，确定性代码负责执行状态、Oracle 与发布结论。

> [!IMPORTANT]
> 执行结果采用 fail-closed 语义：未匹配 Processor、`executed=false`、
> 实际执行未完成或没有有效断言时，均不得产生 `PASS`，
> 统一进入 `BLOCKED / NOT_EXECUTED`。

需求闭环硬规则（每次执行强制）：任何未理解、未确认、未覆盖的要求都必须保留原文、来源和缺口状态，不能消失，也不能算通过。内核执行前阻断未澄清规则，执行后核对完整需求与证据；部分用例成功、过滤或重跑均不能让整体越过门禁。执行授权不等于业务规则确认。

Trae 入口使用“集中澄清 → 展示最终计划 → 一次确认 → 立即执行”的中文 Skill。MCP 的 `next_action` 返回下一步与可直接调用的真实计划参数，降低模型自行判断和拼接参数的负担；同一计划确认后不反复询问，内容变化才重新确认。Skill 和交互提示不替代内核安全门禁，也不保证任意模型都能正确理解所有业务。

`init --trae` 同时安装 Panqu 的六个专属业务 Skill 及代码索引：
- `panqu-canvas`（画布组件与节点）
- `panqu-video-models`（视频模型与参数约束）
- `panqu-image-models`（图片模型与参数约束）
- `panqu-billing`（计费扣费、积分预估、19个端点与归档表对账）
- `panqu-newapi-diversion`（主站与 NewAPI 两级分流决策、全量开关与权重调度）
- `panqu-newapi-model-onboarding`（**深度专项**：NewAPI 新模型与新渠道接入七步 SOP、两级分流决策树全量/分组状态机、渠道参数与能力配置、组织密钥绑定、SD 重试兜底、计费对账、[场景测试矩阵](src/devtest/assets/panqu-newapi-model-onboarding/references/test-scenarios.md) 与 [故障排查手册](src/devtest/assets/panqu-newapi-model-onboarding/references/troubleshooting.md)）

主 Skill 按功能语义组合读取，已有团队 Skill 不覆盖。
各专项含 `references/input-constraints.md` 与 `references/code-map.md`：逐项提取需求中的格式、大小、数量、提示词、默认值、计费阶梯、分流条件和违规行为，派生边界并关联真实计划用例；未知规则不能自行补值，未覆盖不能算通过。

### Panqu 项目发现与业务流程

`devtest inspect-project` 从指定项目识别复合仓库、路由及回归候选，输出源码位置和缺口。候选为 NOT_EXECUTED，不自动调度子仓库测试；路由数量和模型配置随实际源码变化，不以固定数量作为验收标准。

| CLI 入口 | 行为及证据边界 |
| --- | --- |
| `devtest flow api-diversion` | 执行源码/契约检查与受控分流规则计算，支持 `--project-root`、`--model-id`、`--model-type`；诊断分数不证明真实渠道可用或最终结算正确 |
| `devtest flow real-video-submit` / `devtest real-video` | 使用显式会话向主站提交视频任务，检查任务详情、分流快照并轮询；会写入业务任务并可能扣费 |
| `devtest flow real-image-submit` / `devtest real-image` | 提交生图任务并核验关联结果；具体模型、服务线路、尺寸和参考图限制以已确认契约为准 |
| `devtest flow real-canvas-submit` / `devtest real-canvas` | 执行画布任务提交与状态核验；不等于浏览器中所有节点编辑、上传及连线交互已覆盖 |
| `devtest flow business-suite` | 编排指定模块；`all` 含真实提交模块和 Playwright，不能作为无副作用的健康检查 |
| `devtest playwright` | 独立 Mock/API/浏览器执行入口；完整参数与 MCP 读取方式见前文 |

源码/模拟分流通过不等于生产级端到端验收；提交成功、HTTP 200、任务 ID、快照通过均不能代替真实媒体、供应商记录和最终扣退费证据。报告需逐项检查执行模式、断言结果和证据缺失。功能入口不会自动提供账号权限、数据库连接或模型凭据。

本仓库不承诺业务仓库存在 `test-diversion.sh` 或 `test-business.sh` 等快捷脚本。以本仓库 CLI 和实际 `--help` 为准；真实执行需事先确认环境、账号、模型、次数、预算和清理范围，TRAE MCP 还须传 `confirm_real_execution: true`。

### Panqu Mission：持久化的真实生成任务控制器

v4.30.0 新增独立于模型推理的 `devtest mission` 执行闭环：从操作员核对的合法参数/报价组合中选择最低成本方案，修正昂贵或换错模型的建议，持久化提交意图，只提交一次，恢复原任务，解码结果媒体并核对任务级扣费证据。返回 HTTP 200、生成任务 ID、服务器成功状态或模型声称 PASS 都不能单独使任务通过。源码、素材、参数、报价和预算绑定在同一个计划 hash 中。

具备 PHP 视频 multipart/CSRF 与 Nuxt 单节点 JSON 两个项目协议适配，支持指定目录素材识别及生成小型合成视频素材。此命令仅验证声明的生成冒烟范围（媒体结构与任务扣费），不覆盖 UI、视觉语义、完整画布回归或所有模型。现有 MCP 保持只读。真实业务调用必须具备操作员配置、真实报价与能力、测试环境/身份、明确的同计划预算授权；未配置时阻断，不使用默认生产地址或伪造价格。参考文件上传仍需明确的资产上传适配器。

[Mission 使用与边界](docs/testing/panqu-mission.md) · [最低积分与素材规则](docs/testing/panqu-low-cost-real-execution.md)

v4.31.0 新增 `mission readiness/prepare`：在 Nuxt 文生视频单节点范围，内核读取当前能力和已保存节点、枚举确认范围内的合法组合、逐一询价并编译最低成本计划，不再要求模型手写 catalog、执行 payload 或 JSON 指针。提交前重新核对能力、节点和全部候选价格，漂移即阻断。同一逻辑任务重规划与执行共享持久化锁；已提交任务只恢复，不重新生成。读取授权和付费执行审批分离。PHP 自动准备、参考输入、UI 和语义质量仍未覆盖。详见 [自主任务准备](docs/testing/panqu-mission-preparation.md)。

### 历史验证基线（不代表 v4.35.0 本轮全量结果）

v4.33.0 明确[代码、校验与页面联合测试](src/devtest/assets/devtest/references/combined-validation.md)：每条规则串联代码/边界/API/页面/真实结果；允许审查后运行已有安全本地测试并单独记录，不冒充 MCP 执行结果。代码回归候选未执行会出现在报告缺口。沿用[固定七章单表格式](src/devtest/assets/devtest/references/markdown-handoff.md)，内核写文件前校验章节、表头、用例 ID/状态、统计、证据行和发布建议一致性。格式校验不是业务 Oracle，也没有新增自动运行任意仓库脚本的权限。

v4.32.0 新增[业务证据协调器](docs/testing/panqu-mission-business-evidence.md)：任务、媒体、最终结算分别持久化，只补查缺失阶段；任务失败仍继续对账，账单迟到不重新下载已验证视频。Nuxt requestId 与节点关联、来源时间戳和终态冲突进入硬校验。首次生成前必须有明确的最终结算/金额含义契约，历史终态不自动升级为新策略通过。已经提交的任务可以在前端代码变化后继续定向读取证据，但环境、身份、精确计划和有效审批仍需匹配。

全量测试、Panqu Mission、Acceptance、P0 与 Agent Eval 已于 2026-09-09 复核；其余历史专项统计保留原基线。不代表客户业务环境验收通过。全量使用 `--maxWorkers=2`；默认并发首轮出现超时/取消时序失败，不能隐去该结果或推断为业务缺陷：

| 检查项 | 结果 |
| --- | --- |
| TypeScript 构建 | `npm run build` 通过 |
| 全量 Vitest | 298 个测试文件通过，4 个跳过 |
| 全量测试用例 | 3046 项通过，19 项跳过 |
| 4.33.0 联合验证与报告门禁 | 新增 28 项通过；CLI、源码候选展示和 npm 打包复核共 54 项通过；不是 Panqu 业务代码验收 |
| 4.31.0 自主准备 | 新增 47 项通过，含独立 HTTP、提交前漂移校验和 CLI 完整链路 |
| 4.32.0 业务证据协调 | 新增 39 项通过，含结算延迟、退款、账务故障、真实解码及跨进程阶段恢复 |
| Panqu Mission | 新增 29 项通过，含双协议、跨进程恢复、断线隔离及真实媒体解码 |
| 4.30.0 Mission 与 npm 安装复核 | 2 个测试文件、30 项通过 |
| Panqu 专属观察/门禁 | 新增 17 项通过，含独立 HTTP 健康与异常对照 |
| 4.29.3 打包与关键链路历史基线 | 4 个测试文件、54 项通过 |
| MCP 内核与兼容入口 | 2 个测试文件、29 项测试通过 |
| Acceptance 回归 | 40 个测试文件、362 项测试通过 |
| DevTest 回归 | 21 个测试文件、202 项测试通过 |
| 输入缺陷真实 HTTP 回归 | 4 项通过，覆盖上限多放行 1、大小写/负号损坏及健康对照 |
| P0 安全契约 | 98 项通过、1 项跳过 |
| npm 安装验收 | tarball 安装、三个命令入口、初始化和结果查询通过 |
| GitHub 原有 CLI / 部署契约 | 104 项 / 21 项通过 |
| Agent Eval | 检查 8 项通过；离线评分不作真实业务准确率承诺 |

## 快速开始

### 需求驱动开发自测

需要从需求文档直接完成“风险驱动设计 → SAFE 初步执行 → 问题分级 → 固定报告”时，
使用 DevTest 入口：

```bash
# 发布前先使用 npm pack 生成的 tarball 做项目内安装验收
npm install --save-dev ./test-flow-4.35.0.tgz

# 初始化通用配置及 GitHub Actions；不会生成项目专属 Case 或新协议
npx devtest init --github --trae
npx devtest doctor
npx devtest run --requirement requirements/new-feature.md --env test
npx devtest status --run RUN-<id>

# 可选：计划预览、单问题复现、精准复测
npx devtest run --requirement requirements/new-feature.md --env test --plan
npx devtest run --requirement requirements/new-feature.md --env test --repro P001
npx devtest run --requirement requirements/new-feature.md --env test --rerun P001
npx devtest run --requirement requirements/new-feature.md --env test --final
npx devtest run --requirement requirements/new-feature.md --env test --summary
npx devtest run --requirement requirements/new-feature.md --env test --deep
```

Trae 用户可启用初始化生成的 `devtest` MCP 和 Skill。模型提交需求路径，DevTest 生成并核验
TEST_CASE_V2；执行绑定确认计划，重试复用已保存结果。能力与限制见
[Trae 与 DevTest 执行内核](docs/testing/trae-devtest-kernel.md)。

默认 `mode=SAFE`、最多 20 条风险优先 Case，仅允许 `test` / `sandbox`。目标地址只来自配置引用的
环境变量（默认 `DEVTEST_BASE_URL`）；没有候选地址时进入静态设计模式，不猜测本机地址，也不发送网络请求。
POST/PUT/PATCH/DELETE 即使是预期被拒绝的负向探针，
也只有显式传入 `--confirm-mutations`，且目标为隔离 Sandbox 或具备 Cleanup/Rollback 时
才可能执行；DELETE、真实扣费、Provider、发布和消息副作用仍默认阻断。
使用 `--mode dry-run` 可保证零 HTTP 请求。

DevTest 在当前项目工作区直接运行，不会重置、清理或同步 Git 仓库。运行时地址、账号、Token、
Cookie 和数据库连接只能通过配置中的环境变量名引用；报告和 Evidence 会在落盘前统一脱敏。
Fork PR 默认只允许设计和只读探测，真实写操作必须在明确的 `test` / `sandbox` 环境中显式开启，
并具备可验证的 Cleanup/Rollback。

DevTest 会先建立 AC Coverage Matrix、提取业务不变量，再构建 Business Flow Graph，校验
Response/Database/Task/Billing/Audit/Resource 状态一致性，并做 Case 去重与核心 Case 识别；
问题按接口与断言预期保守聚类，未经复现的异常为 LIKELY，完整证据且复现后才可 CONFIRMED。
SAFE 内置单步骤只读失败最多自动复核一次，两次共用超时预算；不一致保持 UNKNOWN，不用第二次 PASS 覆盖失败。
写操作、多步骤/状态流程和自定义 Processor 不自动重试。最小复现直接列出字段路径、Expected/Actual 与缺失字段。
问题 ID 与生命周期跨 Baseline 保持稳定，
修复后通过 Regression Guard 扩展验证相关 Contract/Invariant/Flow，并输出
`FIXED / STILL_FAIL / REGRESSION / BLOCKED`。默认 fail-fast；可用 `--no-fail-fast` 调试。
v8 使用 Requirement + Contract + Invariant + Observed State + Historical Baseline 组成确定性
Oracle，并以历史失败、Bug 密度、代码变化、Contract Drift、回归和成本做自适应选择。日常默认
Tier 0 + Tier 1；已确认、有来源和明确预期的基础输入边界属于 Tier 1，不必额外开启 `--deep`，但仍受预算、维度开关和安全门禁限制；`--deep` 才执行 Tier 2。Flaky、环境错误与 Test Pollution 会进入独立可靠性分类，
不会伪装成产品 Bug。
输入去重使用结构化精确比较，不合并大小写、正负号、类型、数组顺序或断言等不同的用例。
数值/布尔正例须满足完整显式约束；不能构造单故障负例时保留设计缺口，不把其他规则造成的拒绝冒充为目标校验通过。
固定产物写入 `devtest-results/<runId>/`：面向开发者的 `测试用例.md`、
`开发自测测试报告.md`，以及 `report.html`、`report.json`、`cases.csv`、`problems.md`、
`acceptance-summary.md`、`evidence.json` 审计附件；执行模式还会生成 `source-sync.json`。完整说明见 [DevTest Mode](docs/devtest.md)。

### 开发需求一键验收

开发团队使用 Markdown/纯文本需求执行 API 验收时，先按[开发验收使用指南](docs/developer-acceptance.md)准备 `acceptance.config.json`，随后只需：

```bash
npm run acceptance -- --requirement ./tests/acceptance/fixtures/user-profile.md
```

每次运行都会生成独立的 `reports/YYYY-MM-DD/RUN-*/report.md`、`report.html` 和完整追溯资产；失败 Case 可使用 `--run-id + --case-id` 单独重跑。

### 1. 安装与构建

```bash
npm ci
npm run build
```

如需本地环境配置：

```bash
cp config/env/.env.example .env
```

敏感配置只应写入本地 `.env` 或 CI Secrets，不得提交到仓库。

### 2. 校验用例定义

```bash
node dist/bin/run-test.js \
  --task src/cases \
  --dry-run \
  --ci
```

`--dry-run` 只解析和校验用例，不执行真实 HTTP 请求，也不会把未执行用例标记为通过。

### 3. 执行测试

```bash
# 单个任务文件
node dist/bin/run-test.js \
  --task tasks/wan3-wensheng.json \
  --func wan3

# 单个业务模块
node dist/bin/run-test.js \
  --task src/cases/wan3 \
  --func wan3

# 全量业务模块
node dist/bin/run-test.js \
  --task src/cases \
  --parallel \
  --ci
```

### 4. 启动平台与 Web Dashboard

```bash
npm run build:web
npm run platform -- serve
```

查看所有执行参数：

```bash
node dist/bin/run-test.js --help
```

## 智能体 v2

最新智能体采用“认知边界 + 证据优先”的统一约束：

| 智能体/能力 | 当前行为 |
| --- | --- |
| Requirement Agent v2 | 将事实标记为 `EXPLICIT / INFERRED / UNKNOWN`，保留原文来源、置信度、歧义问题和未知项；缺失信息不再按常见规则补全 |
| Test Design Agent v2 | 生成 `TEST_CASE_V2`，按需求、契约和风险动态选择维度；用例回链 Fact、Step、Assertion、Oracle 与 Evidence，不追求固定数量 |
| Business Runtime P0 | 在 Requirement/Fact Ledger 上投影统一 Business Model；V2 Case 通过轻量 Adapter 接入既有 Scenario Runner，并在执行前动态计算 Generated/Runtime/Effective Readiness |
| Runtime Claim Gate | 设计模型无权声明 Executor/Observer 已就绪；所有用例先回收为设计态，再由确定性 Preflight 绑定真实能力 |
| Analysis Agent v2 | LLM 只解释逐 Case 证据；统计、`PASS/FAIL/BLOCKED/NOT_EXECUTED`、缺陷分类和最终建议由确定性分析器重建 |
| Prompt Registry | Requirement、Test Design、Analysis 同时保留 v1 回放版本和 v2 默认版本，便于审计、比较和回滚 |

关键原则：HTTP 500、超时、空响应或浏览器错误不会直接成为产品缺陷；只有真实执行、明确 Expected、
失败的确定性业务断言和完整 Evidence 同时成立时，才允许输出高置信产品问题。

## Developer Self-Test

开发人员可以用“需求 + 代码变更 + 环境”直接生成并执行 3—8 个风险驱动的
P0 场景，无需先手工编写完整测试套件：

```bash
npm run self-test -- \
  --requirement requirements/new-feature.md \
  --changed HEAD~1..HEAD \
  --env test
```

自测链路为：

```text
Change / Requirement
  → Discovery Candidate
  → Contract Registry / Resolver
  → Operation Graph / Risk
  → P0 Scenario Pack
  → Execution Guard
  → Processor + Observer
  → Assertion + Evidence
  → READY / NOT_READY / BLOCKED
```

默认使用 `SAFE` 模式。`DRY_RUN` 只发现和规划，不调用 Processor；`SAFE`
只允许只读操作和显式无副作用的拒绝探针；`LIVE` 必须同时满足审批、预算、
项目策略、Cleanup/Rollback 与 Evidence Gate。Route、OpenAPI、Controller、
Frontend Network 和 Runtime Discovery 只产生候选契约，只有 Resolver 返回
`RESOLVED` 的 Operation 才能进入执行链。

结论仍遵循 fail-closed：缺少 Processor、Observer、断言或 Required Evidence 时，
场景只能是 `BLOCKED / NOT_EXECUTED`，Feature 只能是 `BLOCKED`，
不能生成 `PASS / READY`。完整参数、模式边界和证据规则见
[Developer Self-Test 指南](docs/testing/developer-self-test.md)。报告交付与发布前还必须逐项完成
[开发交接、发布与报告输出检查清单](docs/testing/developer-handoff-release-checklist.md)，确保章节、状态、统计、证据和发布判定一致。
每次推送 GitHub 还必须执行该清单的“GitHub 推送前全量同步（每次必做）”：核对全仓修改时间、内容差异、未跟踪文件和远端哈希，不能只提交点名文件。

## 执行链路

Agent 从自然语言需求发起真实执行时，先经过执行前门禁：

```text
Requirement
  → Test Design
  → Risk / Constraint Analysis
  → Policy Gate
      ├─ BLOCK / APPROVAL_REQUIRED → 不准备数据，不调用 Runner
      └─ ALLOW → Data Prepare → execution.run → Result
```

Policy Gate 检查环境、真实执行/扣费限制、高风险操作、数据隔离、
`recommendedSkip`、人工审批和项目级策略。`production + risky` 默认不执行；
获得人工审批后方可继续。CLI 可通过 `--execution-approval=<approval-id>`
提交外部审批凭据，`--auto-approve` 不会绕过执行前门禁。

单用例通过统一流水线执行：

```text
Case DSL
  → Canonical Scene 归一化
  → Processor 能力匹配
  → DataFactory setup
  → Runner 实际执行
  → 默认断言
  → 通用断言 DSL
  → 业务断言适配器
  → DataFactory teardown
  → Result 状态收敛
  → HTML / JSON / JUnit / Allure / 通知
```

核心规则：

- Scene 必须先转换为统一的 canonical scene ID。
- Processor 必须显式声明支持的 Scene。
- Runner 必须返回明确的 `executed` 状态。
- `execution.run` 权限级别固定为 `risky`。
- Policy Gate 未放行时，Data Prepare 与 Runner 都不得启动。
- 没有执行证据或有效断言时禁止进入 `PASS`。
- setup、执行、断言和 teardown 的异常都会保留在最终结果中。
- 串行模式下保持兼容；并行模式按 feature 分组，组内串行、组间并行。

## 核心能力

### 测试执行

| 能力 | 说明 | 主要位置 |
| --- | --- | --- |
| 契约治理 | 统一 Contract Registry、Resolver、版本/冲突/漂移门禁 | `src/contracts/` |
| 变更发现 | Route、Controller、OpenAPI、Frontend、Runtime 候选发现 | `src/discovery/` |
| 源码同步 | 工蜂仓库两阶段 fetch/覆盖同步、SHA 校验与 `source-sync.json` 审计 | `src/devtest/source-sync.ts` |
| 开发自测 | 变更分析、P0 Pack、执行门禁、证据收敛与报告 | `src/self-test/` |
| 证据观察 | State、Database、Task、Billing、Audit、Browser Observer | `src/observers/` |
| 场景路由 | Canonical Scene、Processor 能力声明与插件加载 | `src/core/`、`src/plugins/` |
| 用例管理 | TypeScript / JSON 用例、递归加载、标签与场景筛选 | `src/cases/`、`tasks/` |
| 数据工厂 | setup / teardown、隔离数据和边界值生成 | `src/core/data-factory.ts` |
| 并发控制 | 固定并发、自动并发、动态并发 | `src/utils/concurrency-controller.ts` |
| Mock 能力 | HTTP 录制与回放、fixture 缺失策略 | `src/utils/mock-recorder.ts` |
| 环境检测 | 环境基线、配置差异和异常降级 | `src/core/env-checker.ts` |
| 报告输出 | HTML、JSON、JUnit、Allure、飞书通知 | `src/reports/`、`src/integrations/` |

### 断言系统

通用断言引擎与业务断言适配器共享同一份执行上下文。

| 类别 | 操作符 |
| --- | --- |
| 比较 | `equals`、`notEquals`、`gt`、`gte`、`lt`、`lte`、`deepEquals` |
| 集合 | `contains`、`notContains`、`in`、`notIn` |
| 存在性 | `exists`、`notExists` |
| 结构与类型 | `type`、`length`、`jsonSchema` |
| 文本 | `regex` |

规则组合支持：

- `assertAll`：全部规则通过。
- `assertAny`：至少一条规则通过。
- `assertSoft`：收集失败，不中断后续规则。
- `rule`：定义单条规则。

完整语法见 [断言 DSL 文档](docs/assertion-dsl.md)。

### AI Evaluation 与持续改进

平台内置可追溯的 AI 质量闭环：

- 8 个评测领域和版本化 Benchmark。
- HUMAN、REAL_PRODUCTION、REAL_RUN、CURATED 等 Ground Truth 来源。
- Precision、Recall、F1、Coverage、Critical Miss、False Pass 等指标。
- Nightly、Weekly、Release 持续评测。
- Evaluation → Feedback → Benchmark Candidate 桥接。
- 人工审批后的 Prompt / Model / Benchmark 版本变更。
- Shadow、Canary、自动回滚和发布门禁。
- 成本归因、预算守卫、模型路由和容量预测。

相关设计见 [AI 质量治理](docs/ai-quality/) 和 [评测体系](docs/evaluation/)。

## 系统架构

### 模块边界

| 模块 | 职责 |
| --- | --- |
| `src/contracts` | 统一契约注册、解析、版本、冲突与漂移门禁 |
| `src/discovery` | 从代码、OpenAPI、前端和运行时产生候选 Operation |
| `src/self-test` | Developer Self-Test 编排、风险场景、门禁与结果收敛 |
| `src/observers` | 状态、数据库、任务、计费、审计和浏览器证据采集 |
| `src/core` | 执行引擎、流水线、状态语义、断言、环境检测 |
| `src/cases` | 测试用例定义、注册和递归加载 |
| `src/plugins` | Scene Processor 与插件加载 |
| `src/assertions` | 业务断言和适配器 |
| `src/integrations` | HTTP、计费、素材、通知等外部集成 |
| `src/reports` | HTML、JSON、JUnit 报告器 |
| `src/agents` | Requirement/Test Design/Analysis v2、执行、覆盖率、RCA 与版本化 Prompt |
| `src/platform` | Project、Run、Scheduler、Worker、RBAC、API 与运维能力 |
| `src/ai-quality` | Evaluation、Feedback、改进提案与持续评测 |
| `src/cost` | 成本归因、预算、模型路由和容量治理 |
| `web` | React Web Dashboard |

### 平台调用关系

```text
API / CLI / Scheduler
  → PlatformService
  → Project / Run 状态机
  → TestJob Queue
  → Worker
  → Test Execution Pipeline
  → Checkpoint / Audit / EventBus / Telemetry
  → Notification / Dashboard / Release Gate
```

API、CLI 与 Scheduler 共用 `PlatformService`，避免出现多套业务逻辑。

### 平台子系统

| 子系统 | 能力 |
| --- | --- |
| Project / Storage | 多项目隔离；Memory、JSON、SQLite、PostgreSQL 存储 |
| Run / Scheduler | 状态机、优先级、重试、超时、幂等、暂停与恢复 |
| Worker | 心跳、健康度、租约、能力匹配、动态扩缩容 |
| RBAC / Approval | 权限控制、环境策略、审批职责分离 |
| Audit / Telemetry | 审计链路、成本账本、RCA、Flaky、Healing 指标 |
| Workflow | Test Suite、Test Plan、Run Template、Defect、Report |
| Operations | 迁移、备份恢复、Preflight、冒烟与灾备恢复 |

Agent Memory 的 JSON 后端采用 UUID 临时文件、跨实例文件锁和内容哈希 CAS，
用于兼容本地轻量运行；单机长期运行应切换 SQLite WAL，多节点部署应迁移 PostgreSQL。
迁移边界与操作步骤见 [Memory 存储与迁移](docs/operations/memory-storage.md)。

## 测试与质量门禁

### 常用测试命令

| 命令 | 用途 |
| --- | --- |
| `npx devtest run --requirement ... --env test` | 需求驱动的五维开发自测与问题清单 |
| `npm run devtest:test` | DevTest CLI、五维、SAFE、问题与报告专项回归 |
| `npm run self-test -- ...` | 需求与代码变更驱动的开发自测 |
| `npm run self-test:test` | Developer Self-Test 专项回归 |
| `npm test` | 完整 Vitest 测试 |
| `npm run test:coverage` | 覆盖率门禁 |
| `npm run test:all` | 构建并校验迁移一致性 |
| `npm run web:test` | Web 单元 / 组件测试 |
| `npm run web:e2e:test` | Chromium E2E |
| `npm run perf:test` | 性能 sanity 测试 |
| `npm run perf:gate` | 性能基线回归门禁 |
| `npm run mutation:dry` | Stryker 变异测试干跑 |
| `npm run platform:test` | 平台单元测试 |
| `npm run platform:integration` | 平台集成测试 |
| `npm run platform:e2e` | 平台核心 E2E |

Vitest 覆盖率阈值：

| 指标 | 最低要求 |
| --- | ---: |
| Lines | 80% |
| Functions | 80% |
| Statements | 80% |
| Branches | 75% |

### CI 与安全

| 设施 | 位置 | 说明 |
| --- | --- | --- |
| GitHub Actions | `.github/workflows/` | 构建、单元测试、E2E、发布与安全扫描 |
| GitLab CI | `.gitlab-ci.yml` | GitLab 流水线兼容入口 |
| 提交门禁 | `.husky/`、`lint-staged` | 提交前安全扫描和消息校验 |
| SAST | `config/security/semgrep.yml` | Semgrep 静态分析 |
| Secret Scan | `config/security/gitleaks.toml` | Gitleaks 密钥检测 |
| Container Scan | `.github/workflows/security.yml` | Trivy 配置与镜像扫描 |
| Dependency Scan | `scripts/security/` | npm audit 与许可证检查 |

## CLI 使用

### Test Runner 参数

| 参数 | 说明 |
| --- | --- |
| `--task` | 用例目录、单个 TypeScript 用例或 JSON 任务文件 |
| `--env` | 执行环境，默认 `test` |
| `--func` | 功能名和报告归档目录名 |
| `--reporter` | `html`、`json`、`junit`，支持逗号组合 |
| `--grep` | 按标签筛选 |
| `--filter` | 按名称筛选 |
| `--scene` | 按 canonical scene 筛选 |
| `--concurrency` | 固定并发数 |
| `--parallel` | 自动并发，默认上限为 4 |
| `--dynamic-concurrency` | 启用自适应并发 |
| `--record` / `--replay` | HTTP Mock 录制 / 回放 |
| `--auto-setup` | 启用数据工厂 setup / teardown |
| `--dry-run` | 仅校验定义，不执行请求 |
| `--ci` | CI 输出和严格退出码 |
| `--debug-level` | `basic`、`verbose`、`full` |
| `--timeout` / `--case-timeout` | 全局 / 单用例超时 |

### Platform CLI 示例

```bash
# 项目与 Run
npm run platform -- project list
npm run platform -- run create \
  --project wan3 \
  --environment test \
  --trigger manual

# 生命周期控制
npm run platform -- run pause <run-id>
npm run platform -- run resume <run-id>
npm run platform -- run retry <run-id>

# 运维
npm run platform -- platform health
npm run platform -- telemetry metrics
npm run platform -- migrate check
npm run platform -- preflight --json
```

## 配置与部署

### 环境配置

环境变量模板位于 `config/env/`：

| 文件 | 用途 |
| --- | --- |
| `.env.example` | 本地开发模板 |
| `.env.staging.example` | Staging 模板 |
| `.env.production.example` | Production 模板 |

常用变量：

- `TESTFLOW_OUTPUT_DIR`：报告输出根目录，默认 `./output`。
- `TESTFLOW_SESSION_COOKIES_PATH`：登录态文件路径。
- `TESTFLOW_COOKIE`：CI 或临时会话覆盖。
- `TESTFLOW_PROJECT_ID`：目标项目 ID。
- `TESTFLOW_BASE_URL`：目标环境基础地址。

完整说明见 [配置手册](docs/operations/configuration.md)。

### Docker

```bash
# 构建镜像
npm run docker:build

# 使用 Compose 启动
docker compose \
  --env-file .env \
  -f deploy/docker-compose.yml \
  up --build
```

容器配置位于：

- `deploy/docker/Dockerfile`
- `deploy/docker/Dockerfile.dockerignore`
- `deploy/docker-compose.yml`

生产运行镜像仅保留 Node.js 和应用运行依赖，不包含开发依赖与 npm CLI。

## 扩展新业务

以 `user` 功能为例：

1. 在 `src/cases/user/` 中创建用例。
2. 如果需要新场景，在 `src/plugins/scenes/` 中实现 Processor。
3. Processor 显式声明支持的 canonical scene ID。
4. 在 `src/assertions/adapters/` 中添加业务断言适配器。
5. 在 `tests/unit/` 中补充路由、执行状态和断言契约测试。
6. 先执行 `--dry-run`，再执行真实环境测试。

推荐从现有 `wan3` 模块和 `tasks/_template.json` 开始复制最小结构。

## 仓库结构

```text
test-flow/
├── .github/                 # GitHub Actions
├── bin/                     # CLI 入口
├── config/
│   ├── env/                 # 环境变量模板
│   ├── security/            # Semgrep / Gitleaks
│   └── test/                # 性能与变异测试配置
├── deploy/                  # Docker 与 Compose
├── docs/                    # 设计、操作手册和历史报告
├── perf/                    # 性能基线与结果
├── scripts/                 # CI、安全、部署和迁移脚本
├── src/
│   ├── agents/              # 测试智能体
│   ├── ai-quality/          # AI 质量闭环
│   ├── assertions/          # 业务断言
│   ├── cases/               # 测试用例
│   ├── contracts/           # 契约注册、解析与漂移门禁
│   ├── core/                # 执行引擎与状态语义
│   ├── discovery/           # 代码、API、前端与运行时发现
│   ├── integrations/        # 外部集成
│   ├── observers/           # 状态与副作用证据观察器
│   ├── platform/            # AI Test Platform
│   ├── plugins/             # Scene Processor
│   ├── reports/             # 报告器
│   ├── self-test/           # Developer Self-Test 编排
│   └── utils/               # 通用工具
├── tasks/                   # JSON 任务定义
├── tests/                   # Unit / Integration / E2E / Perf
├── web/                     # React Dashboard
├── package.json             # npm 脚本与依赖
├── tsconfig.json            # TypeScript 配置
└── vitest.config.ts         # 默认测试配置
```

构建产物写入 `dist/`；Test Runner 报告写入 `output/<YYYY-MM-DD>/<feature>/`，
Acceptance 报告写入 `reports/`，DevTest 报告、Baseline 与缓存写入 `devtest-results/`。
这些运行产物均不提交到 Git。

## 工程约定

1. 新任务先完成[启动检查清单](docs/04-新任务启动检查清单模板.md)，确认后再编写和执行用例。
2. 任务定义放在 `src/cases/{feature}/` 或 `tasks/{feature}-{task}.json`。
3. 新 Scene 必须使用 canonical scene ID，并提供 Processor 能力声明。
4. 任意未实际执行的用例都不能产生 `PASS`。
5. 用例必须包含有效断言；无断言结果不能视为通过。
6. 报告按入口分别写入 `output/`、`reports/` 或 `devtest-results/`，不要提交运行产物。
7. 密钥、Cookie、数据库凭据只通过环境变量或 Secret Manager 注入。
8. 生产危险操作必须经过 RBAC、环境策略和人工审批门禁。
9. 新功能需补充单元测试，并按风险增加集成或 E2E 测试。
10. 功能交付说明遵循[项目说明模板](docs/05-项目说明模板.md)。

## 文档与版本历史

README 只保留当前架构、使用方式和工程约定。详细设计与历史记录统一维护在 `docs/`：

- [项目文档索引](docs/README.md)
- [版本变更记录](docs/CHANGELOG.md)
- [运维与部署](docs/operations/)
- [产品工作流](docs/product/)
- [AI 质量治理](docs/ai-quality/)
- [评测体系](docs/evaluation/)
- [成本与容量治理](docs/cost/)
- [阶段验收报告](docs/phases/)

Phase 13—52 的详细里程碑、验收数据和演练结果可在 `docs/phases/phase*.md` 中按编号检索。
