# Panqu AI DevTest

面向 Panqu 图片和视频链路的轻量测试副驾。源码当前为 **v4.39.0**，只有一套 TypeScript 内核，并以同一逻辑提供本地 CLI 与 TRAE MCP。

| 项目 | 当前状态 |
| --- | --- |
| 包名 | `test-flow@4.39.0` |
| 运行时 | Node.js `>=20`、TypeScript、ESM |
| 入口 | `devtest` CLI、`devtest-mcp` stdio MCP |
| 核心动作 | `probe`、`plan`、`execute`、`verify` |
| 发布方式 | GitHub 提交固定；不代表已发布 npm 或已完成真实业务验收 |

## 快速开始

```bash
git clone https://github.com/CAoyinggo/panqu-Test-agent.git
cd panqu-Test-agent
npm ci
npm run build
node dist/bin/devtest-cli.js --help
```

从源码生成安装包并安装到业务项目：

```bash
npm pack
npm install --save-dev ./test-flow-4.39.0.tgz
npx --no-install devtest --version
```

安装包并不包含仓库历史、旧平台界面或过去的并行 Agent 实现；它只包含当前 CLI/MCP 所需的运行时文件。

## 四个核心动作

| 动作 | 做什么 | 不代表什么 |
| --- | --- | --- |
| `probe` | 探测主站、网关及会话配置状态 | 探活通过不代表业务生成通过 |
| `plan` | 根据模型、媒体类型和规格推导 Direct / NewAPI 分流与基准积分 | 规划不会提交任务 |
| `execute` | 运行 mock，或在显式 real 模式下提交媒体任务 | 任务 ID 不代表媒体、路由或结算均已验收 |
| `verify` | 检查媒体容器结构，并按提供的流水核对重复扣费、失败净扣和退款幂等 | 容器检查和输入流水不能代替独立的生产账务审计 |

## CLI

```bash
# 受控探活：不会读取或猜测默认会话文件
npx --no-install devtest probe --env test --mock

# 只做本地分流与积分推导，不发网络请求
npx --no-install devtest plan --model 84 --media video --resolution 720p --duration 4

# 受控仿真执行
npx --no-install devtest execute --model 84 --media video --mode mock

# 对已有任务 ID、媒体数据和积分流水执行验真
npx --no-install devtest verify --task 12345 --model 84 --media video --expected-points 56
```

`execute --mode real` 会产生真实 HTTP 提交，必须显式给出会话文件并获得独立的业务与费用授权。没有会话文件时，real 模式应安全失败。请不要把 Cookie、Token、会话文件内容写进命令、报告或 Git。

## TRAE MCP

构建后以 stdio 启动：

```bash
node /absolute/path/to/test-flow/dist/bin/devtest-mcp.js --project-root /absolute/path/to/project
```

MCP 只提供一个 `devtest` 工具，`action` 可为 `probe`、`plan`、`execute` 或 `verify`。字段名称优先使用 MCP 形式，例如 `model_id`、`media_type`、`session_file`、`expected_points`。MCP 的版本握手必须与安装包版本一致。

每个项目的 `.trae/devtest-runtime` 是独立安装。更新 GitHub 或全局 MCP 不会自动更新它；升级时必须从同一 Git 提交重新构建、安装，并分别重启 MCP 会话。

## 安全与证据边界

- `plan` 与 mock 执行是受控推导或仿真，不会证明生产业务通过。
- 真实执行仅适用于获得授权的测试环境；不自动启动真实生成、扣费、退款、发布或通知。
- 会话文件必须显式传入 `--session-file` 或 `PANQU_SESSION_COOKIES_FILE`；缺失、无效或环境不匹配时应阻断。
- `verify` 分别报告媒体结构和账务不变量。没有实际路由、可播放媒体、最终账务流水或独立证据时，不能升级为端到端通过。
- 报告和配置中不得保存明文凭据。TRAE 全局配置与项目配置要分别核对，避免一个旧安装包遮蔽另一个新版本。

## 开发与验证

```bash
npm run build
npm test
node dist/bin/devtest-cli.js --version
printf '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n' \
  | node dist/bin/devtest-mcp.js --project-root "$PWD"
```

默认测试覆盖当前纯净内核及 CLI/MCP 契约，不触发真实媒体生成或扣费。提交前还应检查打包内容、安装后的 CLI 版本与 MCP 初始化版本。

## 当前版本变更

### v4.39.0 — 2026-09-15

- 将仓库收敛为单一双模内核：CLI 与 TRAE MCP 共享 `probe`、`plan`、`execute`、`verify`。
- 移除旧的并行 Agent、平台界面、历史报告与重复入口，避免多个实现或文档描述相互冲突。
- 保留环境探活、分流推导、媒体任务提交、媒体结构检查与积分流水不变量核对。
- 更新 README、版本握手和打包说明，仅描述当前存在的源文件与接口。

旧版 v4.37 / v4.38 的预览页、报告或已安装 runtime 是历史产物；它们不会随着 GitHub 更新自动替换。

## 源码结构

| 路径 | 内容 |
| --- | --- |
| `src/devtest/core-kernel.ts` | 四个核心动作及组合结果 |
| `src/devtest/env-probe.ts` | 环境与会话探测 |
| `src/devtest/routing.ts` | 主站与网关分流推导 |
| `src/devtest/media-flow.ts` | 媒体提交与任务轮询 |
| `src/devtest/media-inspector.ts` | MP4 / 图片容器结构检查 |
| `src/devtest/billing.ts` | 积分流水与三项账务不变量 |
| `src/devtest/mcp-service.ts` | MCP 工具适配 |
| `bin/` | CLI 与 stdio MCP 入口 |
| `tests/unit/devtest/` | 当前核心回归测试 |
