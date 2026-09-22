# Panqu AI DevTest — 命令行工具参考手册 (CLI Reference)

本地终端命令行工具 `devtest` (`bin/devtest-cli.ts`) 与 IDE 辅助 MCP 服务共享底层纯 TypeScript 内核，保证 CLI 命令行与 IDE 智能体调用具有 100% 相同的数据流和判定逻辑。

---

## 1. 安装与执行入口

```bash
# 查看全局版本与帮助
node dist/bin/devtest-cli.js --version
node dist/bin/devtest-cli.js --help

# 或通过 npm script 快捷执行
npm run devtest -- --help
```

---

## 2. 四大核心动作命令

### 2.1 `probe` 环境探活
用于探测测试环境网关健康度、会话有效性与模型契约发现。

```bash
# 受控仿真离线探活 (不发起外部网络调用)
node dist/bin/devtest-cli.js probe --env test --mock

# 真实环境探活 (加载真实 Cookie / Session 凭据)
node dist/bin/devtest-cli.js probe --env test --session-file /path/to/session.json

# 纯净 JSON 格式输出 (专用于 CI/CD 自动化流水线)
node dist/bin/devtest-cli.js probe --env test --mock --json
```

**常用参数**：
- `--env <test|preonline>`：测试目标环境（默认 `test`）。
- `--session-file <path>`：会话文件路径（未指定时自动按优先级寻找 `session.json`）。
- `--mock`：受控离线仿真标志。
- `--timeout <ms>`：网络请求超时毫秒数（默认 5000ms）。
- `--json`：启用纯净 JSON 输出。

---

### 2.2 `plan` 契约推导与路由消歧
用于在生成前计算路由分流决策（Direct / NewAPI）、推导刊例积分预算、检查 Prompt 风险及消歧目标。

```bash
# 图片模型分流规划
node dist/bin/devtest-cli.js plan --model 25 --media image

# 视频模型规划 (指定分辨率与生成时长)
node dist/bin/devtest-cli.js plan --model 84 --media video --resolution 720p --duration 4

# 基于自然语言需求动态解析规划
node dist/bin/devtest-cli.js plan --requirement "接入 960 视频模型" --json

# 渠道级目标消歧推导
node dist/bin/devtest-cli.js plan --channel 54 --channel-name "TD_国际" --media video
```

**常用参数**：
- `--model <id>`：模型 ID（如 84, 88, 201）。
- `--media <video|image>`：媒体类型。
- `--resolution <720p|1080p|...>`：分辨率规格。
- `--duration <sec>`：视频时长秒数。
- `--prompt <text>`：提示词。
- `--requirement <text>`：自然语言需求描述。
- `--channel <id>`：网关渠道 ID。
- `--json`：输出结构化 JSON 测试计划。

---

### 2.3 `execute` 任务派发与提交
受控向后端派发生成任务。支持受控离线仿真与真实环境提交，并支持 `--wait` 自动进入闭环验真。

```bash
# 受控仿真派发 (生成模拟任务 ID，零外部请求)
node dist/bin/devtest-cli.js execute --model 84 --media video --mode mock

# 真实环境提交 (需有效 sessionFile)
node dist/bin/devtest-cli.js execute \
  --model 84 \
  --media video \
  --mode real \
  --session-file ./session.json \
  --resolution 720p \
  --duration 4

# 全链路 E2E 闭环模式 (--wait: 自动轮询终态并串联 verify 对账与裁决)
node dist/bin/devtest-cli.js execute \
  --model 84 \
  --media video \
  --mode real \
  --session-file ./session.json \
  --resolution 720p \
  --duration 4 \
  --wait \
  --poll-timeout 180
```

**常用参数**：
- `--mode <mock|real>`：执行模式（必需项）。
- `--wait`：启用全链路闭环（提交后自动进入轮询、切片物理验真与计费对账）。
- `--poll-timeout <sec>`：轮询超时秒数（视频默认 180s，图片默认 60s）。
- `--side-effect-policy <READ_ONLY|ALLOW_SUBMIT|ALLOW_PAID>`：副作用门禁策略。

---

### 2.4 `verify` 物理验真与唯一裁决
用于对已有任务执行 5 维客观事实验真，调用 `CanonicalVerdictEngine` 进行终审并输出验收结论。

```bash
# 依据任务上下文与任务 ID 验真
node dist/bin/devtest-cli.js verify \
  --task 12345 \
  --model 84 \
  --media video \
  --session-file ./session.json

# 结合产物 URL 进行直接物理切片验真 (无需重新轮询)
node dist/bin/devtest-cli.js verify \
  --task 12345 \
  --model 84 \
  --media video \
  --video-url "https://cdn.example.com/outputs/task12345.mp4" \
  --session-file ./session.json
```

**常用参数**：
- `--task <id>`：待核验的服务端任务 ID（必需项）。
- `--model <id>`：原任务绑定的模型 ID。
- `--media <video|image>`：原任务媒体类型。
- `--video-url <url>`：产物视频直链（用于 ISO-14496 容器与尾部 moov 范围解析）。
- `--image-url <url>`：产物图片直链（用于 PNG/JPEG/WebP 物理结构提取）。
- `--poll-timeout <sec>`：轮询窗口时间限制。
