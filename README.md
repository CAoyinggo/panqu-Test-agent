# Panqu AI DevTest

面向 Panqu AI 图片与视频链路的轻量纯净测试副驾。源码版本为 **v5.3.0**，统一由一套纯 TypeScript 内核驱动，以完全同源逻辑提供本地终端 CLI 与 IDE 辅助 TRAE MCP 双入口。

| 核心属性 | 当前规范 |
| --- | --- |
| **版本 / 包名** | `test-flow@5.3.0` |
| **运行时要求** | Node.js `>=20` · TypeScript `>=5.9` · ESM 纯模块 |
| **双模同源入口** | 本地终端 `devtest` CLI · IDE 辅助 `devtest-mcp` (stdio MCP) |
| **四大核心动作** | `probe()` 环境探活 · `plan()` 分流推导 · `execute()` 任务派发 · `verify()` 验真对账 |
| **测试验证矩阵** | 13 个测试套件 · **201 项单元测试全部通过 (100% PASS)** |
| **架构规范** | 严格遵守 [`docs/ARCHITECTURE_FREEZE.md`](docs/ARCHITECTURE_FREEZE.md) 永久冻结原则，零中心上帝类，零虚假报告大盘 |
| **发布形式** | GitHub 提交固定快照；不代表已发布 npm 或生产全量验收 |

---

## 1. 架构原则与拓扑

系统严格遵循永久架构冻结契约，核心拓扑直通调度内核：

```text
       ┌──────────────┐         ┌──────────────────────────────┐
       │ devtest CLI  │         │          TRAE MCP            │
       └──────┬───────┘         ├──────────────┬───────────────┤
              │                 │ devtest (4A) │ record_cand   │
              │                 └──────┬───────┴───────┬───────┘
              └───────────┬────────────┘               │
                          ▼                            ▼
                 ┌─────────────────┐          ┌────────────────┐
                 │   core-kernel   │          │ shared-memory  │
                 └────────┬────────┘          │ inbox.md [ ]   │
                          │                   └────────────────┘
       ┌──────────┬───────┴───────┬──────────┐
       ▼          ▼               ▼          ▼
    probe()    plan()         execute()   verify()
       │          │               │          │
   env-probe   routing        media-flow  media-inspector
                  │                          billing
           domain-knowledge
```

### 永久冻结核心准则
1. **单核双模**：CLI 终端与 TRAE MCP 服务完全同源，直接调用 `core-kernel.ts`，禁止在两者间插入冗余中间层、胶水层或中心化编排类。
2. **事实第一，绝不谎报**：无真实凭据输出 `UNVERIFIED` / `BLOCKED`，未提供流水输出 `SKIPPED_NO_LOGS`，绝对禁止默认伪造 `PASS`。
3. **彻底杜绝幽灵大盘**：铲除所有“固定七章报告”、“大盘报表”等冗余平台代码，全域统一采用极简 3 段式实战输出（概况 / 验真 / 复现）。
4. **严格读写隔离**：`probe`、`plan`、`verify` 保证 100% 只读与幂等，严禁产生外网写请求或状态副作用；仅 `execute` 在显式 `mode=real` 且提供合法授权会话时发起真实任务提交。
5. **受控经验收敛**：外部代理审查出的业务经验通过独立工具受控录入待审收件箱（严格标记为未审 `[ ]`），绝不侵蚀核心测试动作内核。

---

## 2. 四大核心动作说明

| 核心动作 | 核心职责 | 依赖领域模块 | 边界与安全约束 |
|---|---|---|---|
| **`probe`** | 探测测试/预发/生产环境主站健康度、网关连通性、候选渠道状态与用户鉴权凭据 | `env-probe` | 仅检查网络与配置连通性，探活通过不代表业务生成成功 |
| **`plan`** | 动态推导模型契约、Direct / NewAPI 分流策略、预期基准积分与用例编排清单 | `routing`, `domain-knowledge` | 纯内存推导与用例生成，不产生任何网络请求或实际扣费 |
| **`execute`** | 受控仿真执行（mock）或提交真实媒体任务（real，需显式授权会话） | `media-flow` | 获得任务 ID 不代表产物可用、路由正确或账单核销成功 |
| **`verify`** | 严格按 4D 证据链核验任务终态、产物容器物理结构、账单对账与三大金融安全不变量 | `media-inspector`, `billing` | 流水与容器检查无法替代人工业务与法务审计 |

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

# 3. 运行全量测试验证（201 项全绿通过）
npm test

# 4. 查看 CLI 帮助
node dist/bin/devtest-cli.js --help
```

### 项目依赖与打包分发
```bash
# 生成独立打包 tarball
npm pack

# 业务项目引入
npm install --save-dev ./test-flow-5.3.0.tgz
npx --no-install devtest --help
```

---

## 4. 本地 CLI 命令参考

### 1. 环境探活 (`probe`)
```bash
# 受控仿真探活（离线模式，不产生外网连接）
npx --no-install devtest probe --env test --mock

# 真实环境探活（需传入有效会话凭据文件）
npx --no-install devtest probe --env test --session-file /path/to/session.json

# 自定义超时时间（毫秒）
npx --no-install devtest probe --env preonline --timeout-ms 8000
```

### 2. 动态规划与契约推导 (`plan`)
```bash
# 图片模型分流推导与扣费基准计算
npx --no-install devtest plan --model 25 --media image

# 视频模型生成规划（显式指定分辨率与时长）
npx --no-install devtest plan --model 84 --media video --resolution 720p --duration 4

# 输出纯净结构化 JSON（供 CI 自动化脚本消费）
npx --no-install devtest plan --model 84 --media video --json
```

### 3. 任务执行与提交 (`execute`)
```bash
# 本地受控 Mock 仿真执行
npx --no-install devtest execute --model 84 --media video --mode mock

# 真实环境执行（必须显式传入 session-file 并确认产生实际扣费）
npx --no-install devtest execute --model 84 --media video --mode real --session-file /path/to/session.json --resolution 720p --duration 4
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

# 直接传入产物 URL 进行深度二进制物理验真（支持尾部 moov 范围切片）
npx --no-install devtest verify \
  --task 12345 \
  --model 84 \
  --media video \
  --video-url "https://cdn.example.com/outputs/task12345.mp4"
```

---

## 5. TRAE MCP 智能体深度接入

DevTest 原生提供符合 Model Context Protocol (MCP 2024-11-05) 标准的 stdio 通讯服务。

### 启动服务
```bash
node /absolute/path/to/dist/bin/devtest-mcp.js --project-root /absolute/path/to/project
```

### 工作区配置 (`.trae/mcp.json`)
在代码仓库根目录创建 `.trae/mcp.json`，Trae 打开项目时将自动加载：
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
    },
    "panqu-test-mcp": {
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

### 全局用户配置 (`mcp.json`)
在 Trae 用户配置目录（macOS: `~/Library/Application Support/Trae CN/User/mcp.json`）中挂载：
```json
{
  "mcpServers": {
    "panqu-test-mcp": {
      "command": "node",
      "args": [
        "/path/to/panqu-Test-agent/dist/bin/devtest-mcp.js",
        "--project-root",
        "/path/to/panqu-Test-agent"
      ],
      "env": {
        "NODE_OPTIONS": "",
        "NODE_USE_ENV_PROXY": "1",
        "PANQU_MCP_INTEGRATION_VERSION": "5.3.0"
      }
    }
  }
}
```

### MCP 暴露工具列表

| 工具名称 | 工具职责 | 参数与特性 |
|---|---|---|
| **`devtest`** | **唯一核心测试副驾入口**（直接驱动 `core-kernel.ts`） | 4 项 Action：`probe`, `plan`, `execute`, `verify`<br>支持 `video_url`, `timeout_ms`, `db_extra_confirmed` 等全量契约参数 |
| **`devtest_record_candidate`** | **受控知识候选录入入口**（专用于外部代理/GitHub 审查） | 录入业务发现到 `shared-memory/candidates/inbox.md`<br>状态严格为待审 `[ ]`，需人工审核后晋升，绝不入侵核心测试逻辑 |

### 极简 3 行实战流响应规范
MCP 核心工具 `devtest` 执行后直接输出结构化、可直接复现的 3 行精炼回执：
```text
🎯 概况：动作 <verify> · 目标 <video:84> · 模式 <real> · 任务 #12345
🔍 验真：最终裁决 <ALL PASS> · 生产验收 <ACCEPTED> · 任务状态 <SUCCESS> · 产物结构 <PASS (MP4)> · 账单对账 <PASS> · 失败净扣归零 <PASS> · 防重复扣费 <PASS>
💻 复现：npm run devtest -- verify --task 12345 --model 84 --media video
```

---

## 6. 4D 证据验真与三大金融安全不变量

`verify` 严格基于四维确定性物理证据链进行多重裁决，绝无预设虚假 PASS：

1. **第一维：任务终态凭据 (Task Terminal Status)**
   - 必须到达真实服务端合法终态（`SUCCESS` / `FAILED` / `TIMEOUT`）。排队或进行中返回 `UNVERIFIED`，严禁提前预设通过。
2. **第二维：二进制产物物理验真 (Binary Artifact Inspection)**
   - 真实读取媒体文件头部或切片二进制流。
   - **MP4 视频**：不仅支持标准头部 Faststart (`moov` 在前)，还通过 HTTP Range 切片解析支持万相 Wan3.0 等模型将 `moov` 元数据块置于文件尾部的真实工业级结构；严格校验 `ftyp`、`mvhd`、`trak`（视频轨/音频轨）与时长尺寸。
   - **图片**：严格解析 PNG/JPEG/WEBP 头部 Magic 签名与尺寸。结构破损一票否决。
3. **第三维：账单流水精确对账 (Ledger Reconciliation)**
   - 读取任务关联账单流水，核对初始预扣、最终结算积分是否与基准配置完全吻合。
4. **第四维：三大金融安全不变量 (Financial Invariants)**
   - **防重复扣费 (Anti-Double Billing)**：单个任务扣费流水记录条数严格等于 1。
   - **失败净扣归零 (Net Charge Zero on Failure)**：任务执行失败时，净扣除积分必须严格等于 0（已扣必退）。
   - **退款幂等核销 (Refund Idempotency)**：退款记录不得重复生成。

---

## 7. 自演化经验与知识闭环

系统内建解耦的领域知识与经验沉淀机制（`domain-knowledge.ts`）：
- **历史失效模式库**：结构化沉淀高频问题（如 FP-001 扣费单价污染、FP-004 尾部 moov 误报、FP-005 任务失败未退款资损缺陷）。
- **动态测试增强**：在 `plan()` 阶段自适应召回相关经验，动态注入专项检验用例与预期判定逻辑。
- **经验晋升机制**：支持将经过实战验证的候选模式晋升为已确认经验规则，实现测试知识持续演化。

---

## 8. 开发、测试与回归验证

```bash
# 1. 编译构建
npm run build

# 2. 运行全量单元测试（13 套件，201 项单测，必须 100% 通过）
npm test

# 3. CLI 快速自测
node dist/bin/devtest-cli.js plan --model 84 --media video --json

# 4. MCP stdio 协议握手自测
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n' \
  | node dist/bin/devtest-mcp.js --project-root "$PWD"
```

---

## 9. 源码文件清单

```text
src/devtest/
├── core-kernel.ts         # 四大核心动作统一调度器（probe, plan, execute, verify）
├── mcp-service.ts         # MCP stdio 服务封装、全参数 Schema 与候选录入入口
├── env-probe.ts           # 环境与会话探活、动态模型契约发现
├── routing.ts             # Direct 与 NewAPI 分流决策与渠道映射
├── domain-knowledge.ts    # 动态经验库、失效模式召回与自演化知识闭环
├── media-flow.ts          # 真实媒体任务提交与状态流水轮询
├── media-inspector.ts     # MP4（头部/尾部 moov）与图片物理二进制结构解码器
├── billing.ts             # 账单流水对账与三大金融安全不变量审计
├── types.ts               # 统一契约、事实模型与事实源类型定义
├── version.ts             # 统一平台版本常量导出（v5.3.0）
└── index.ts               # 模块公共入口导出

bin/
├── devtest-cli.ts         # 本地命令行主入口
└── devtest-mcp.ts         # stdio MCP 服务启动入口

tests/unit/devtest/
├── core-kernel-and-cli.test.ts  # 核心内核与 CLI 统一契约回归
├── dynamic-plan.test.ts         # 动态规划与用例生成测试
├── mcp-high-level-tools.test.ts # MCP Schema 与服务调用测试
├── mcp-candidate-record.test.ts # 受控候选知识录入测试
├── media-inspector.test.ts      # 媒体物理结构（含尾部 moov）解码测试
├── domain-knowledge.test.ts     # 领域知识召回测试
├── knowledge-decoupling.test.ts # 知识解耦架构测试
├── knowledge-promotion.test.ts  # 候选经验晋升测试
└── ...                          # 其余专项测试（共 13 套件，201 项测试通过）

docs/
└── ARCHITECTURE_FREEZE.md       # 架构永久冻结规范
```
