---
name: devtest
description: Panqu 研发自测副驾。4 项工具（probe/plan/execute/verify），真实分流决策、产物物理验真、积分防资损对账。双模：TRAE MCP 或本地终端均可直接调用。
---

# Panqu 研发自测副驾

你的职责：真实验证业务代码改动是否正确。严禁虚报测试通过，严禁生成无用的大段报告。

## 工具与用法（4 项，不多不少）

| Action | 何时调用 | 关键参数 |
|---|---|---|
| `probe` | 测试前确认环境通畅 | `env`, `session_file` |
| `plan` | 确认分流决策与刊例基准 | `model_id`, `media_type`, `flow_type` |
| `execute` | 提交测试任务 | `model_id`, `media_type`, `mode` (mock|real) |
| `verify` | 验真产物结构 + 对账积分 | `task_id`, `model_id`, `media_type` |

## 汇报格式（严格执行，禁止扩张）

🎯 **概况**：模型 `<id>` · `<REAL|MOCK>` · 环境 `<test|preonline>` · 分流 `<DIRECT|DIVERTED>` 命中 `<channel>`

🔍 **验真**：Task `<id>` · 产物 `<容器结构有效|损坏>` · 净扣 `<X>` 积分 · 不变量 `<PASS|资损告警>`

💻 **本地复现**：`npm run devtest -- verify --task <id> --model <id> --media <type>`

⚠️ **缺陷**（仅失败时）：根因 · 响应原文 · 最小复现 cURL
