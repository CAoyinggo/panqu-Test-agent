# Trae 入口与 DevTest 执行内核

本入口使用 npm 包中的 `devtest-mcp`。它只接受需求路径和计划控制参数，调用现有 DevTest、TEST_CASE_V2、Quality Gate、Scenario Adapter、Evidence、Oracle 和报告实现。模型不再提交另一种格式的测试 Case。

## 安装与使用

每次执行强制应用 `NO_SILENT_REQUIREMENT_GAPS_V1`：未理解、未确认、未覆盖的要求必须保留原文和来源，不得静默丢弃或记作通过。执行前阻断未澄清规则对应的用例；执行后核对完整需求清单，包括过滤、数量限制、重跑未选中的要求。清晰且不受影响的部分可以执行，但有缺口时整体不能 READY/PASS。

`plan`、`execute`、`status` 返回 `requirement_assurance`。其中 `entries` 保留状态、原文、来源、关联用例和澄清问题，`unresolvedIds` 保留未闭环要求。执行授权不是业务确认；取得真实业务答复后更新需求、重新计划并确认执行。此策略升级前的计划失效。已有安装需要更新内核包；初始化会保留已编辑的团队 Skill，需人工合并对应门禁说明。

先在 test-flow 运行 `npm ci`、`npm run build`、`npm pack`。在目标业务 Git 仓库安装生成的 tarball：

```bash
npm install --save-dev /path/to/test-flow-4.29.2.tgz
npx --no-install devtest init --github --trae
npx --no-install devtest doctor
```

初始化产生 `.devtest.json`、`.github/workflows/devtest.yml`、`.trae/mcp.json` 和 `.trae/skills/` 下的 `devtest`、`panqu-canvas`、`panqu-video-models`、`panqu-image-models`。三个专项 Skill 各含 `references/code-map.md`，用于定位当前宿主的真实实现。保留已有其他 MCP 配置和团队修改过的 Skill（含参考文件）。相同名字但内容不同的 MCP 配置需要先处理冲突。npm 公共发布不属于本次交付；不能假设同名 npm 包就是本项目。

Panqu 任务在计划前按功能语义读取所有相关专项 Skill：画布组件更新读取画布，视频/图片模型接入读取对应媒体，画布媒体节点变更组合读取。新模型不依赖封闭名称名单；普通图片展示不触发图片生成检查。专项指导不会改变内核门禁，也不代表已执行付费生成或通过业务验收。已有主 Skill 被保留时，需要人工合并新版的“Panqu 功能专项路由”；若单独打开某个子仓库，在那个根目录执行初始化。自动发现及实际读取依赖 Trae 配置和入口模型，安装测试不证明模型每次都会正确选用。

在 Trae 启用项目 `devtest` MCP 和生成的 Skill，输入：

> 根据 requirements/feature.md 生成测试计划，说明关键风险和 UNKNOWN，先不要执行。

工具名称为 `devtest`，完整 JSON Schema 由 `tools/list` 返回：

| Action | 输入 | 结果 |
| --- | --- | --- |
| doctor | 无额外参数 | 配置、需求和环境变量检查；READY 不代表业务可执行 |
| plan | requirement：仓库内相对文档路径 | Generator + Quality Gate 生成计划；返回 plan_id、plan_hash、风险、UNKNOWN、报告路径；不发网络请求 |
| execute | plan_id、expected_plan_hash、idempotency_key | 校验确认计划并调用现有内核；返回执行统计、Oracle、证据及报告路径 |
| status | plan_id | 从持久化记录读取 NOT_EXECUTED、RUNNING、COMPLETED 或 BLOCKED 及业务结论 |

`ok` 表示工具调用是否完成，不是测试 PASS。业务结果看 `conclusion`、`counts`、`oracle` 和 Evidence。报告路径相对于目标仓库，格式与 CLI 一致。

### 输入限制不能只写“参数正常”

三个专项 Skill 各含 `references/input-constraints.md`，涉及相关输入时必须读取并在计划前建立逐项约束表：字段/模型/模式/入口、需求原文和位置、类型/必填/范围/单位/开闭区间、默认值及生效时机、超限行为和副作用、代码现状、边界检查及实际用例/证据。

清单区分单文件和整批大小、单次和累计上传数量、提示词条数和字符/字节/token 长度、输入值和处理后值、上传数和生成数；覆盖首尾帧/混合素材、上游合并、模型切换、旧值恢复及参数联动。具体限额只来自本次已确认需求，不能从常见值、现有代码或旧模型猜出；未写不等于无限制，缺失/冲突集中澄清，不适用需有范围理由。

边界要关联内核实际用例和证据，没生成/未执行继续列为缺口；不能编造 ID、转换成无关 GET 或自行调用生成服务绕过内核。Skill 指导不等于内核新增上传/媒体执行能力，也未证明具体 Trae 模型一定遵循。新版初始化补齐缺失的参考文件并保留现有团队文件，旧主/专项 Skill 仍需合并新版的输入检查入口。

### 降低入口模型的判断负担

新版 Skill 使用中文分支流程：定位需求、规划、集中澄清、展示最终计划、确认后直接执行、查询/交付。明确的信息不重问，业务确认与执行授权分开；最终计划未变时，不重复确认、不无故重新规划、不能只说“马上执行”而不调用工具。

MCP 返回 `next_action`：`CLARIFY_REQUIREMENTS` 附原文问题，`CONFIRM_EXECUTION` 附真实计划生成的 `execute_arguments` 与稳定幂等键，`WAIT_FOR_RESULT` 附原计划查询参数，其他情况进入 `RESOLVE_BLOCKER` 或 `REVIEW_RESULT`。未闭环原文继续保留在 `requirement_assurance`，`remaining_gap_ids` 引用它而不重复复制全文。参数可直接传回 MCP；同键重放不重新发请求。

`next_action` 是确定性交互指引，不是可信的人类授权凭证。Skill 约束模型在用户确认后调用；内核仍独立强制需求、执行安全、计划漂移和幂等门禁。未在具体 Trae 模型上进行行为实测，不能把接口集成测试等同于模型遵循率保证。现有团队 Skill 不会被初始化命令覆盖，升级需合并新版 Skill 并更新包。

## 确认、重试与隔离

计划绑定现有 Acceptance Execution Plan Identity、需求摘要、配置、Git 索引内及未跟踪的源码内容摘要，以及操作员选择的目标环境和 Runtime 模块内容摘要。摘要记录不保存环境地址或凭证明文。执行前发生变化会返回 STALE_PLAN；生成的 Case 语义和执行范围还会在 DevTest 中再次校验。运行时 Readiness 在每次执行前重新计算。

计划也绑定执行策略版本；升级到有界只读复核后，旧策略生成的计划必须重新生成、确认，不会在旧计划上静默增加请求。

同一个计划重复使用相同幂等键只返回已保存结果。换一个幂等键不会重新执行该计划，需要重新生成计划。项目级排他锁防止多个 MCP 进程并发污染数据。异常退出留下 RUNNING 或锁时，先核查实际业务状态和运行进程；工具不自动重复未知结果的业务操作。

本地 MCP 当前只执行 SAFE 只读用例。写操作由目标仓库的 GitHub `workflow_dispatch` 在明确的 test/sandbox 环境中显式启用；运行时通过 GitHub Secrets 和受审查的 Runtime 模块提供。Fork PR 不得执行写操作。此版本 MCP 不提供远程 Workflow dispatch，也不把本地调用自动转成 GitHub 写操作。

SAFE 内置 HTTP 执行器对完整响应的确定性失败，最多自动复核一次单步骤 GET/HEAD/OPTIONS。复核计入计划 `execution_estimate` 的请求数、耗时与成本估算；两次请求共用原 Case 超时预算和取消信号。成功请求、5xx/网络错误、写操作、状态观察/多步骤流程及自定义 Processor 不自动重试。快照 Observer 启用时也不自动复核，避免重复执行准备或清理。

首轮失败永远保留。相同输入、相同失败断言与实际值再次出现才标记 `REPRODUCED`，供既有完整证据门禁确认可复现；两次不一致或复核未完成保持 UNKNOWN，并保留两次证据，不能用第二次 PASS 洗掉第一次失败，也不能将间歇性问题直接认定为稳定产品缺陷。幂等键重放与这个有界复核不同：重新调用已执行计划仍不会再发请求。

完整 JSON 缺失契约必需字段（包括预期为 `false`/`0` 的字段）是明确断言失败；不可观察/解析的响应仍保留 UNKNOWN。问题归因不再把业务实际值中的 `timeout`、`network` 等词当作环境故障。最小复现包含字段路径、Expected/Actual 和缺字段标记；不同接口或不同预期不会仅因同属一种错误而合并。

缺少鉴权、Observer、状态预期或副作用证据时保持 BLOCKED / DESIGNED_ONLY / NOT_EXECUTED。不能通过放宽 Gate 获取 PASS。

## 运行层级与证据

- MCP 回归启动独立本机 HTTP 服务，验证实际请求、错误响应 FAIL、证据、重试、计划漂移和路径隔离。这是受控服务集成测试，不是客户环境验收。
- `p0-reference-scenarios.test.ts` 中按期望值构造观察结果的处理器仅验证模拟合约串接；指标标记 SIMULATED_CONTRACT_ONLY，不能当作三类业务实际通过。
- 真实业务验收需要目标 test/sandbox、对应需求、测试身份、实际数据/日志/队列 Observer 和 Cleanup。条件不具备时不能报告实际业务通过。

## 维护

```bash
npm run build
npm run test:standardization
npm run acceptance:test
npm run test:devtest-v8
npm run test:mcp-kernel
npm run test:npm-acceptance
npm test
```

同步维护 `src/devtest/mcp-service.ts` 控制 Schema、`src/devtest/assets/devtest/SKILL.md`、CLI 初始化、打包白名单和集成测试。旧 mcp-bridge 保留作兼容资产，不再是项目默认入口。
