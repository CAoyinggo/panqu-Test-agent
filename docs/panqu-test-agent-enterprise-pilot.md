# panqu-Test-agent 企业一期试点

本文档描述把「盘古测试智能体（panqu-Test-agent）」作为企业试点资产纳入 test-flow 仓库的最小落地方式。
一期只覆盖「本地 TraeCode + 本地 stdio MCP」，不做集中式远程 MCP、不引入内网 HTTP 服务。

---

## 一、成员安装步骤

1. `git clone` test-flow 仓库到本机。
2. 安装项目要求的 Node 版本（见 `package.json` 的 `engines.node`）。
3. 在仓库根目录执行 `npm ci`。
4. 执行 `npm run build`，产出 `dist/bin/run-plan.js`（stdio MCP 启动时会校验其存在，缺失则 fail-closed）。
5. 用 Trae 打开 test-flow 仓库根目录。
6. 「设置 → MCP → 启用项目级 MCP」。
7. 确认 MCP 工具列表里 **只出现** `execute_test_plan`。
8. 创建自定义智能体 panqu-Test-agent。
9. 该智能体的 Prompt 使用仓库内 `mcp-bridge/PANQU_TRAE_AGENT_PROMPT.md`。
10. 该智能体只绑定 `execute_test_plan` 一个工具。

> 项目级 MCP 配置位于仓库根 `.trae/mcp.json`，命令为 `node`，入口为 `${workspaceFolder}/mcp-bridge/trae-test-mcp-stdio.js`。

---

## 二、一期限制（能力边界）

- 仅支持本地 TraeCode 客户端。
- 报告与结果文件保存在成员本机（`output/` 目录）。
- 仅 `test` 环境可真实执行；`preonline` / `prod` 依然被 Policy Gate BLOCK。
- 仅 `GET` / `HEAD` / `OPTIONS` 可真实执行；`POST` / `PUT` / `PATCH` / `DELETE` 为 DESIGNED_ONLY。
- `credential_ref` / `auth_ref` 仍为 DESIGNED_ONLY（当前无凭据解析器，未实现真实鉴权）。
- 每个成员、每个 MCP 进程最大并发为 2（MAX_CONCURRENCY=2）。
- 不支持集中审计、集中报告、租户隔离、任务队列或全局配额。
- `action=execute` 前必须用户确认，且绑定 `plan_id` / `expected_plan_hash` / `idempotency_key`。

---

## 三、管理员事项

- 在 Trae 企业控制台配置企业智能体权限（谁能使用 panqu-Test-agent）。
- 如启用「企业 MCP 白名单」，需将本 stdio MCP 配置（`.trae/mcp.json` 中的 `panqu-test-mcp`）加入白名单。
- 说明：MCP 白名单只控制「允许使用哪些 MCP」，它不是密钥下发系统，也不用于动态下发环境变量；`TESTFLOW_ALLOWED_TARGET_ORIGINS` 目前由项目级 `.trae/mcp.json` 静态提供，成员各自保守维护。

---

## 四、治理要求（启用前必须遵守）

- 只从已受审（code review）通过的 commit/tag 启用项目级 MCP，不得启用任意工作区草稿。
- `.trae/mcp.json` 与 `mcp-bridge/*` 的任何变更必须经过 code review 才能合入。
- 项目 `env`（如 `TESTFLOW_ALLOWED_TARGET_ORIGINS`）可由成员在本地 `.trae/mcp.json` 修改，它不是管理员不可绕过的集中策略；它是本地约束，不构成服务端强制。
- Trae GUI 的 `PATH` 必须能解析到 `node`，且版本 >= `24.11.0`（见 `package.json` 的 `engines.node`），否则 `command: "node"` 启动失败。
- 仓库内 `mcp-bridge/` 是 canonical 实现，是唯一被支持的入口。
- 仓库外 MCP（如历史 `/Users/mac/agents/mcp-bridge` 或 global/user-local 安装）是 legacy，不得作为启用入口。
- 启用项目级 MCP 前，必须手动禁用旧的同名 global / user-local `panqu-test-mcp`，避免与项目级配置冲突或混淆来源。

---

## 五、待二期评估（不在一期范围内）

- 企业集中式远程 MCP（HTTP / Streamable HTTP）。
- 认证、租户隔离、任务队列、审计日志、配额、集中报告存储。
- 成员 / 租户 / 团队 / 审批人 / 审计事件字段的持久化。