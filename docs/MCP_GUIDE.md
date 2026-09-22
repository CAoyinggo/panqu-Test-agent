# Panqu AI DevTest — MCP 集成指南 (Model Context Protocol)

DevTest 原生提供符合 Model Context Protocol (2024-11-05) 标准的 stdio 通讯服务，专为 Trae、Cursor 等 IDE 辅助智能体打造，帮助智能体形成确定性的测试动作心智模型。

---

## 1. 为什么保持四大核心 Action

DevTest MCP 严格只对外暴露以 `devtest` 为核心的测试副驾工具，封装四个标准 Action：
- `probe`：环境可用性与会话感知
- `plan`：契约推导与消歧规约
- `execute`：任务提交派发（支持 `wait: true` 闭环）
- `verify`：事实验真与单裁决权威

**不拆解为零散碎片工具、不增设第 5 个核心 Action**，确保大语言模型的心智状态收敛，防止智能体在执行测试时出现幻觉、跳过安全门禁或自制业务 PASS。

---

## 2. 工具定义与调用契约

### 2.1 核心工具：`devtest`

**输入参数示例**：
```json
{
  "action": "execute",
  "model_id": 84,
  "media_type": "video",
  "mode": "real",
  "resolution": "720p",
  "duration": 4,
  "wait": true,
  "poll_timeout_sec": 180
}
```

**E2E 闭环回执结构**：
```text
### 🚀 Panqu E2E 任务执行与验真闭环 [REAL]
- **任务概况**: 模型 #84 (video) · 任务 #12345
- **技术裁决**: <ALL PASS (任务成功 + 物理产物结构有效 + 账务不变量全部通过)>
- **生产验收**: <ACCEPTED> · 证据完整度 <4/4 COMPLETE>
- **证据明细**:
  - 任务执行 (Task): <SUCCESS>
  - 产物结构 (Media): <PASS (MP4 container structure PASS)>
  - 积分账务 (Billing): <PASS>
  - 失败净扣归零: <PASS>
  - 防重复扣费: <PASS>
- **本地复现**: npm run devtest -- verify --task 12345 --model 84 --media video
```

### 2.2 辅助工具：`devtest_record_candidate`
专用于将分析代码库（如 GitHub Repository）提炼出的可复用认知存入 `shared-memory/candidates/inbox.md` 待审缓冲池。
- 状态严格为待审 `[ ]`；
- 需人工审核后晋升，严禁绕过审核直接修改长期规则库。

---

## 3. IDE 客户端配置指南

### 3.1 工作区配置 (`.trae/mcp.json`)
```json
{
  "mcpServers": {
    "devtest": {
      "command": "node",
      "args": [
        "${workspaceFolder}/dist/bin/devtest-mcp.js",
        "--project-root",
        "${workspaceFolder}"
      ],
      "env": {
        "NODE_OPTIONS": "",
        "NODE_USE_ENV_PROXY": "1"
      }
    }
  }
}
```

### 3.2 全局用户配置 (`~/Library/Application Support/Trae CN/User/mcp.json`)
```json
{
  "mcpServers": {
    "devtest": {
      "command": "/usr/local/bin/node",
      "args": [
        "/path/to/engine-snapshot/dist/bin/devtest-mcp.js",
        "--project-root",
        "/path/to/panqu-Test-agent"
      ],
      "env": {
        "NODE_OPTIONS": "",
        "NODE_USE_ENV_PROXY": "1",
        "PANQU_MCP_INTEGRATION_VERSION": "6.0.0"
      }
    }
  }
}
```
