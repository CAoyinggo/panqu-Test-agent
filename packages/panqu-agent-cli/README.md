# panqu-test-agent-cli

panqu-Test-agent 的单命令本地代码验证 CLI：用 **TraeCode CLI（`traecli`）内置模型**做项目结构 /
变更 / 风险 / 推荐测试范围分析，用**确定性执行器**运行 `typecheck / lint / test / build`，
每次验证输出 **Markdown + JSON 测试报告**。

> 分发源是 GitHub 仓库 `CAoyinggo/panqu-Test-agent`，**推理运行时是本地已登录的 TraeCode CLI**。
> 本工具不包含、不安装、不读取任何外部 LLM SDK 或 API Key。

## 安装 / 使用

```bash
# 从本地 tgz（或未来 GitHub Release tgz）执行
npm exec --yes --package=<本地 tgz 绝对路径> -- \
  panqu-test-agent validate \
  --workspace "$PWD" \
  --checks typecheck,lint,test,build
```

### 可选参数

| 参数 | 说明 |
| --- | --- |
| `--workspace <path>` | 被测项目路径（必须是 Git 工作区，默认当前目录） |
| `--checks <list>` | 逗号分隔，白名单：`typecheck,lint,test,build` |
| `--report-dir <path>` | 报告输出目录（默认 `~/.panqu-test-agent/reports/<ws-hash>/<run-id>/`） |
| `--timeout-ms <int>` | 每项检查超时（默认 120000） |
| `--api-origin <origin>` | 候选 API 黑盒测试 origin（必须 http/https 且在允许列表内） |
| `--execute-api` | 显式请求 API 黑盒测试（默认关闭；MVP 仅 plan-only，不发起 HTTP） |
| `--dry-run` | 只做参数校验 + 快照规划 + 脚本发现，不执行检查/模型/API |
| `--json` | 额外把 report.json 打印到 stdout |
| `--help` / `--version` | 帮助 / 版本 |

## 工作方式

1. **隔离快照**：对 Git 工作区创建 detached worktree，应用 `git diff HEAD` 补丁，
   复制安全未跟踪源码；`.env` / 私钥 / 敏感文件 / 大文件 / 构建产物默认排除（写入报告 limitations）。
2. **确定性检查**：只执行白名单脚本（`npm run <script>`，`shell:false`，参数数组），
   带超时（终止进程组）与 stdout/stderr 字节上限；缺失脚本为 SKIPPED；
   依赖已声明但 `node_modules` 缺失 → BLOCKED。
3. **Trae 分析**：`traecli exec -C <快照> --sandbox read-only --ephemeral
   --output-schema <schema> --output-last-message <analysis.json> --json`。
   模型只读分析，不修改文件、不运行命令、不发起请求。未登录/未安装 → BLOCKED。
4. **API 黑盒**：默认关闭；MVP 只做 plan-only 与允许列表校验，**不发起任何 HTTP 请求**。
5. **报告**：`report.json` / `report.md` / `analysis.json` / `logs/*.log`。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | PASSED |
| 1 | FAILED |
| 2 | ERROR / 用法错误 |
| 3 | BLOCKED |
| 4 | SKIPPED（含 --dry-run） |

## 安全说明

- 命令仅适用于开发者信任的本地仓库：package.json 中的受信任脚本本身仍可能执行任意项目代码。
- 不自动安装依赖；不执行 deploy / publish / docker / migration / 数据库写入等脚本。
- 原始工作区不被构建、测试或写入；所有产物只留在隔离快照与报告目录。
- 快照临时目录在结束后清理，仅清理本次创建且经过路径验证的目录。
