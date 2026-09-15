# 盼趣 AI 测试平台

需求驱动的测试设计、受控执行、证据核验与研发自测工具链，支持通用 API 验收及 Panqu 图片、视频、画布流程。

| 项目 | 当前约定 |
| --- | --- |
| 源码 / 安装包 | `test-flow@4.38.0` |
| 运行时 | Node.js `>=24.11.0`，TypeScript / ESM |
| 界面 | CLI、MCP、React / Vite 平台 |
| 测试 | Vitest、Playwright |
| 发布边界 | GitHub、TRAE 本地运行时、远程 Worker 分别更新和验证；本版本不表示已发布 npm |

## 导航

[快速开始](#快速开始) · [本次更新](#本次更新) · [能力边界](#能力边界) · [入口与-trae](#入口与-trae) · [状态与证据](#状态与证据) · [报告](#报告) · [测试与发布](#测试与发布) · [安全](#安全) · [文档](#文档)

## 快速开始

### 源码构建

```bash
git clone https://github.com/CAoyinggo/panqu-Test-agent.git
cd panqu-Test-agent
npm ci
npm run build
node dist/bin/run-devtest.js --help
```

### 在业务项目中使用

先在源码目录运行 `npm pack`，将生成的 tarball 放入目标项目：

```bash
npm install --save-dev ./test-flow-4.38.0.tgz
npx --no-install devtest init --github --trae
npx --no-install devtest doctor
# 先准备需求文件；dry-run 不发送 HTTP 请求。
npx --no-install devtest run --requirement requirements/new-feature.md --env test --mode dry-run
```

`init` 会写入项目配置及所选集成文件，已有配置请先核对差异。缺少有效环境时保留设计结果，不把未执行项算作通过。

执行前检查计划、目标、身份、预算与副作用范围：

```bash
npx --no-install devtest run --requirement requirements/new-feature.md --env test --plan
npx --no-install devtest run --requirement requirements/new-feature.md --env test
npx --no-install devtest status --run RUN-<id>
```

默认 SAFE 并非完全离线：配置完整时可能发送允许的只读请求。只有 `dry-run` 保证零 HTTP 请求。真实写操作需要显式确认及隔离/清理条件；通用自测授权不等于供应商生成或付费授权。

## 本次更新

v4.38.0（2026-09-15）：

- 新增统一执行结果契约与 DevTest 覆盖台账，运行生命周期和用例结果分开表达。
- 报告与 MCP 摘要区分确认产品缺陷、测试阻断、未测试、通过项，并补充数据使用与统计对账。
- 计划与状态查询不再把未执行计划表示为已完成测试；发现的本地候选与本次正式计划分开统计。
- 执行提示区分全局阻断、单用例阻断及未选用例，保留确认计划绑定和幂等控制。
- 新增 Acceptance、Agent、Platform 结果适配模块，但不代表所有平台入口已完成迁移。
- 收紧媒体、画布和门禁报告措辞：快照、地址或局部检查通过不等于完整业务验收。
- 重组 README，历史版本细节见 [CHANGELOG](docs/CHANGELOG.md)。

## 能力边界

| 能力 | 当前范围 | 不应推断的能力 |
| --- | --- | --- |
| 需求与用例设计 | 需求解析、AC 关联、动态维度、TEST_CASE_V2、风险优先选择 | 自动消除需求歧义或覆盖全部业务规则 |
| 通用 DevTest | SAFE / dry-run、确认执行、覆盖台账、Oracle、问题聚类与复测 | 未执行项通过，或环境故障自动定性为产品缺陷 |
| 自主验证 | `verify --mock` 编排影响分析、场景与受控证据 | 真实端到端生成、在线自主学习 |
| Panqu 流程 | 图片、视频、画布提交和任务/分流快照，部分媒体及账务 Oracle | 仅凭任务 ID、状态码或 URL 完成路由、解码和结算验收 |
| Mission | 持久化计划、审批、幂等提交、恢复与分阶段证据 | 任意模型、PHP 自动准备、参考输入、UI 与语义质量全面覆盖 |
| 规划与诊断 | 模型矩阵、Git 影响、执行 DAG、环境探针、复现包 | 无权限读取外部需求或业务环境 |
| 韧性与漂移 | 任务监视、混沌及跨环境漂移的受控仿真 | 已连接真实故障注入和生产监控；未实现的真实模式会阻断 |
| GitHub 协作 | 审查、Check Run、评论命令和发布动作载荷 | 生成载荷即已写 GitHub 或完成发布 |
| 平台与扩展 | 场景处理器、断言、调度、评测、成本治理和 Web 界面 | 精简 npm 包包含完整平台源码与部署资源 |

## 入口与 TRAE

### 通用 CLI

```bash
npx --no-install devtest run --requirement requirements/new-feature.md --env test --repro P001
npx --no-install devtest run --requirement requirements/new-feature.md --env test --rerun P001
npx --no-install devtest verify --requirement requirements/new-feature.md --mock --env test
```

`verify` 当前仅支持受控 Mock。`READY` 是当前输入和门禁下的结论，不是生产发布批准。

### Panqu 扩展入口

以下命令在源码构建后运行：

```bash
node dist/src/devtest/run-playwright-cli.js --self-test-plan --requirement "验证视频模型分流变更"
node dist/src/devtest/run-playwright-cli.js --ci-gate --mock
node dist/src/devtest/run-playwright-cli.js --export-ci-workflow
```

此 CLI 包含真实执行入口，不能假设省略参数就一定是 Mock。真实模式需阅读对应帮助并确认会话、环境、费用与副作用。

### TRAE 接入与同步

| 入口 | 核对方式 |
| --- | --- |
| 项目 `devtest` MCP | 核对项目配置的命令、运行时及 `--project-root`；由内核管理计划、确认、执行与报告 |
| 完整 TRAE MCP | 本地 Native CLI 与远程能力分别验证；适配器版本不同于引擎版本 |
| 项目隔离运行时 | 每个 `.trae/devtest-runtime` 独立安装，更新全局 MCP 不会自动更新它 |

升级时从 GitHub 同一完整提交重新构建，不复用旧 `dist`。逐项核对 GitHub SHA、本地快照 SHA、Native catalog `engineSha` 与远程 capabilities；再验证 MCP 初始化、工具清单、无副作用计划及报告链路。历史任务保留历史 SHA，不能改写。

[TRAE 内核](docs/testing/trae-devtest-kernel.md) · [Mission](docs/testing/panqu-mission.md) · [自主准备](docs/testing/panqu-mission-preparation.md) · [业务证据](docs/testing/panqu-mission-business-evidence.md)

## 状态与证据

| 层级 | 状态 / 统计 | 含义 |
| --- | --- | --- |
| 用例结果 | `PASS / FAIL / BLOCKED / NOT_EXECUTED` | 通过、失败、受阻、未执行，互不替代 |
| 运行生命周期 | `NOT_STARTED / RUNNING / COMPLETED / BLOCKED / FAILED` | 编排进度；完成不等于全部业务断言通过 |
| 旧交付结论 | `READY / NOT_READY / BLOCKED` | 兼容旧入口，不是统一用例状态 |
| 覆盖台账 | 已执行、受阻、未执行及需求关联 | 对账正式计划；发现候选不自动进入覆盖分母 |
| 问题清单 | 产品缺陷、测试阻断、未测试、通过 | 无根因或定位证据时保留未知，不虚构代码行 |

统一契约当前主要接入 DevTest 报告链路，独立适配器仍需调用方使用；不代表历史数据已无损迁移。

接口响应、任务状态、消费者实际路由、媒体可访问/可解码、最终账务结算分别取证。用户积分和供应商成本分开核算；估算不是账单，退款不等于供应商成本归零。

## 报告

通用 DevTest 默认输出到 `devtest-results/<runId>/`：

| 产物 | 用途 |
| --- | --- |
| `测试用例.md` | 用例范围、预期及执行状态 |
| `开发自测测试报告.md` | 固定结构的开发交付报告 |
| `report.json` / `report.html` | 结构化数据与浏览报告 |
| `cases.csv` / `problems.md` | 用例导出与问题清单 |
| `acceptance-summary.md` / `evidence.json` | 验收摘要和审计证据 |
| `source-sync.json` | 执行模式源码溯源 |

其他入口可能生成自己的产物，不保证附件完全相同。Mock、跳过、阻断、证据缺失和不适用必须如实保留。格式校验通过不等于业务验收通过。

[DevTest 使用说明](docs/devtest.md) · [报告与发布检查清单](docs/testing/developer-handoff-release-checklist.md)

## 测试与发布

```bash
npm run build
npx --no-install vitest run --maxWorkers=2
npx --no-install vitest run tests/integration/npm-package-acceptance.test.ts --maxWorkers=1
node --test integrations/trae-mcp/native-cli.test.mjs
```

默认 Vitest 排除独立性能基准。发布受控回归应关闭 `RUN_REAL_E2E` / `REAL_E2E_SUBMIT`；源码快照检查仅在显式设置 `PANQU_SOURCE_FIXTURE_ROOT` 且满足前提时运行。跳过不计为通过。

发布记录必须使用当轮实际测试数、跳过原因、安装包验收及 SHA，不沿用历史数字。tarball 使用运行时白名单，必须检验解包内容及安装后入口。GitHub 推送、Worker 部署、MCP 重载与项目安装分别验证。

2026-09-15 受控回归：TypeScript 构建通过；全仓 Vitest 3382 项通过、21 项跳过（真实环境或显式源码快照前提未开启），包含安装包验收；Native MCP 8 项通过。报告定位边界另作专项复测。以上不构成真实生成、路由、账务或生产发布验收。

## 安全

- 环境地址来自配置引用的环境变量，不猜测本机地址。凭据只通过受控环境变量或会话文件加载。
- 项目 MCP 会话文件必须符合项目相对路径约束；Native CLI 的显式文件路径和环境变量约定不能照搬到云端输入。
- 写请求需要明确确认和隔离/清理条件。真实生成、扣费、供应商调用、发布与通知需单独授权。
- 校验输出、仓库、工作流路径的穿越及符号链接；不要将凭据写入命令示例、Git、报告或 tarball。
- 幂等与恢复仅在受支持入口提供；超时应先查已有任务，不直接重发付费请求。

[配置手册](docs/operations/configuration.md) · [部署指南](docs/operations/deployment.md) · [最低成本真实执行](docs/testing/panqu-low-cost-real-execution.md)

## 文档

| 路径 | 内容 |
| --- | --- |
| `src/devtest/` | 自测内核、业务流程、证据与报告 |
| `src/acceptance/` / `src/contracts/` | API 验收与共享契约 |
| `src/agents/` / `src/platform/` | 智能体与平台 |
| `packages/panqu-agent-cli/` | Agent CLI |
| `integrations/trae-mcp/` | TRAE 本地适配 |
| `tests/` | 单元、集成、契约、E2E |
| `docs/` | 标准、指南与版本记录 |

[文档索引](docs/README.md) · [CHANGELOG](docs/CHANGELOG.md) · [TEST_CASE_V2](docs/testing/testcase-v2-schema.md) · [Developer Self-Test](docs/testing/developer-self-test.md) · [开发验收](docs/developer-acceptance.md) · [断言 DSL](docs/assertion-dsl.md)
