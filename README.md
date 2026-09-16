# Panqu AI DevTest

面向 Panqu AI 图片与视频链路的轻量纯净测试副驾。源码版本为 **v5.1.0**，统一由一套纯 TypeScript 内核驱动，以完全同源逻辑提供本地 CLI 与 TRAE MCP 双入口。

| 核心属性 | 当前规范 |
| --- | --- |
| **版本 / 包名** | `test-flow@5.1.0` |
| **运行时要求** | Node.js `>=20`、TypeScript `>=5.9`、ESM 纯模块 |
| **双模入口** | 本地终端 `devtest` CLI · IDE 辅助 `devtest-mcp` (stdio MCP) |
| **四大核心动作** | `probe()` · `plan()` · `execute()` · `verify()` |
| **架构规范** | 遵守 [`docs/ARCHITECTURE_FREEZE.md`](docs/ARCHITECTURE_FREEZE.md) 永久冻结原则，严禁上帝类与报告大盘幽灵 |
| **发布形式** | GitHub 提交固定快照；不代表已发布 npm 或生产全量验收 |

---

## 1. 架构原则与拓扑

系统严格遵循永久架构冻结契约，核心拓扑如下：

```text
       ┌──────────────┐         ┌──────────────┐
       │ devtest CLI  │         │  TRAE MCP    │
       └──────┬───────┘         └──────┬───────┘
              │                        │
              └───────────┬────────────┘
                          ▼
                 ┌─────────────────┐
                 │   core-kernel   │
                 └────────┬────────┘
                          │
       ┌──────────┬───────┴───────┬──────────┐
       ▼          ▼               ▼          ▼
    probe()    plan()         execute()   verify()
       │          │               │          │
   env-probe   routing        media-flow  media-inspector
                                          billing
```

### 永久冻结守则
- **单核双模**：CLI 与 TRAE MCP 必须直接调用 `core-kernel`，禁止在两者间插入冗余中间层或包装纸。
- **事实第一，绝不谎报**：无真实凭据输出 `UNVERIFIED` / `BLOCKED`，未提供流水输出 `SKIPPED_NO_LOGS`，绝对禁止默认伪造 `PASS`。
- **杜绝大盘与幽灵**：彻底铲除所有“固定七章报告”、“大盘报表”等冗余平台代码，全域统一采用极简 3 段式实战输出。
- **读写隔离**：`probe`、`plan`、`verify` 保证 100% 只读与幂等，严禁产生网络提交或状态副作用；仅 `execute` 在显式 `mode=real` 且提供合法会话时发起业务提交。

---

## 2. 四大核心动作说明

| 核心动作 | 核心职责 | 依赖领域模块 | 边界与约束 |
|---|---|---|---|
| **`probe`** | 探测测试/生产环境主站状态、网关连通性、候选渠道与会话有效性 | `env-probe` | 仅检查连通性与配置，探活通过不代表业务生成成功 |
| **`plan`** | 动态推导模型契约、Direct / NewAPI 分流策略、预期基准积分与测试用例清单 | `routing`, `env-probe` | 纯推导与用例编排，不产生任何真实网络请求或任务提交 |
| **`execute`** | 仿真执行（mock）或提交真实媒体任务（real，需授权凭据） | `media-flow` | 获得任务 ID 不代表产物可用、路由正确或账单核销成功 |
| **`verify`** | 严格按 4D 证据链核验任务终态、产物容器结构、账单对账与三大金融安全不变量 | `media-inspector`, `billing` | 流水与容器检查无法替代人工业务与法务审计 |

---

## 3. 快速上手

### 源码安装与编译
```bash
# 1. 克隆官方仓库
git clone https://github.com/CAoyinggo/panqu-Test-agent.git
cd panqu-Test-agent

# 2. 安装依赖并编译构建
npm ci
npm run build

# 3. 查看 CLI 帮助
node dist/bin/devtest-cli.js --help
```

### 项目依赖分发
```bash
# 生成独立打包 tarball
npm pack

# 业务项目引入
npm install --save-dev ./test-flow-5.1.0.tgz
npx --no-install devtest --help
```

---

## 4. CLI 命令参考

### 1. 环境与配置探活 (`probe`)
```bash
# 受控仿真探活（不产生外网连接）
npx --no-install devtest probe --env test --mock

# 真实环境探活（需传入有效会话文件）
npx --no-install devtest probe --env test --session-file /path/to/session.json
```

### 2. 动态规划与契约推导 (`plan`)
```bash
# 图片生成规划（推导 Direct / NewAPI 分流与基准扣费）
npx --no-install devtest plan --model 25 --media image

# 视频生成规划（含分辨率与时长规格）
npx --no-install devtest plan --model 84 --media video --resolution 720p --duration 4

# 输出纯净 JSON 格式
npx --no-install devtest plan --model 84 --media video --json
```

### 3. 任务执行与提交 (`execute`)
```bash
# 本地 Mock 仿真执行
npx --no-install devtest execute --model 84 --media video --mode mock

# 真实环境执行（必须显式提供 session-file 与获得费用授权）
npx --no-install devtest execute --model 84 --media video --mode real --session-file /path/to/session.json
```

### 4. 4D 证据验真与对账 (`verify`)
```bash
# 验证已有任务的产物完整性与账务流水
npx --no-install devtest verify \
  --task 12345 \
  --model 84 \
  --media video \
  --expected-points 56 \
  --session-file /path/to/session.json
```

---

## 5. TRAE MCP 实战接入

### 启动配置
构建产物后，以标准 stdio 协议启动：
```bash
node /absolute/path/to/dist/bin/devtest-mcp.js --project-root /absolute/path/to/project
```

### IDE MCP 注册 (`.trae/mcp.json`)
```json
{
  "mcpServers": {
    "devtest": {
      "command": "node",
      "args": [
        "${workspaceFolder}/dist/bin/devtest-mcp.js",
        "--project-root",
        "${workspaceFolder}"
      ]
    }
  }
}
```

### 极简 3 行实战流响应规范
MCP 单一工具 `devtest` 执行后，统一输出结构化、可直接复现的 3 行精简摘要：
```text
🎯 概况：动作 <verify> · 目标 <video:84> · 模式 <real>
🔍 验真：最终裁决 <ALL PASS> · 生产验收 <ACCEPTED> · 任务状态 <SUCCESS> · 产物结构 <VALID> · 账单对账 <PASSED> · 失败净扣归零 <TRUE> · 防重复扣费 <TRUE>
💻 复现：npm run devtest -- verify --task 12345 --model 84 --media video
```

---

## 6. 4D 证据验真与安全约束

`verify` 建立在四维确定性证据基础之上，缺一不可：

1. **第一维：任务终态凭据**
   - 必须到达服务端合法终态（`SUCCESS` / `FAILED`）。排队中返回 `PROCESSING`，严禁提前裁定通过。
2. **第二维：二进制产物物理验真**
   - 真实读取媒体文件头部二进制流（首 64KB）。
   - MP4：严格遍历 ISO-14496 原子 Box（`ftyp`、`moov`、`mvhd`、`trak`），核验时长、尺寸与编码。
   - 图片：严格解析 PNG/JPEG/WEBP 头部签名与尺寸信息。非标准容器阻断并报错。
3. **第三维：账单流水精确对账**
   - 读取任务关联账单流水，核对初始预扣、最终结算积分是否与基准配置完全吻合。
4. **第四维：三大金融安全不变量**
   - **防重复扣费 (Anti-Double Billing)**：单个任务扣费记录条数严格等于 1。
   - **失败净扣归零 (Net Charge Zero)**：任务执行失败时，净扣除积分必须严格归零。
   - **退款幂等核销 (Refund Idempotency)**：退款记录不得重复生成。

---

## 7. 开发、测试与回归验证

```bash
# 1. 编译构建
npm run build

# 2. 运行核心单元测试套件（136 项核心单测，必须 100% 通过）
npm test

# 3. CLI 快速自测
node dist/bin/devtest-cli.js plan --model 84 --media video --json

# 4. MCP stdio 握手测试
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n' \
  | node dist/bin/devtest-mcp.js --project-root "$PWD"
```

---

## 8. 源码文件清单

```text
src/devtest/
├── core-kernel.ts         # 四大核心动作调度器（probe, plan, execute, verify）
├── mcp-service.ts         # MCP stdio 服务封装与 3 行流格式化
├── env-probe.ts           # 环境与会话探活、动态契约发现
├── routing.ts             # Direct 与 NewAPI 分流决策与渠道映射
├── media-flow.ts          # 真实媒体任务提交与状态轮询
├── media-inspector.ts     # MP4 / 图片物理二进制结构解码器
├── billing.ts             # 账单流水审计与三大金融安全不变量
├── types.ts               # 统一契约、事实模型与事实源定义
├── version.ts             # 统一版本常量导出（v5.1.0）
└── index.ts               # 模块公共导出

bin/
├── devtest-cli.ts         # 本地命令行主入口
└── devtest-mcp.ts         # stdio MCP 服务启动入口

docs/
└── ARCHITECTURE_FREEZE.md # 架构永久冻结规范
```
