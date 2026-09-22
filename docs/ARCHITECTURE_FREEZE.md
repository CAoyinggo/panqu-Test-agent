# Panqu AI DevTest — 核心语义冻结与受控扩展架构规范 (ARCHITECTURE FREEZE)

你正在维护 Panqu AI DevTest。

从本规范生效开始，**核心领域语义与唯一最终裁决权永久冻结，架构演进严格遵循受控扩展原则**。

你的首要任务不是重构、扩展或“优化架构”，而是在既有架构边界内修复真实问题、验证真实业务、补充测试，并保持系统事实第一、Fail-closed、零假 PASS。

---

# 1. 核心语义冻结与受控扩展架构

## 1.1 当前已实现收敛架构拓扑 (Implemented Converged Topology)

经过架构收敛，Panqu AI DevTest 的四大核心动作已全面收敛至统一的 `RequirementTrace → TestSpec → Adapter → Evidence → Verdict` 目标拓扑。`probe()`、`plan()`、`execute()`、`verify()` 均已完成单向标准规约或证据信封打通。

```text
Requirement / Code Change
            │
            ▼
RequirementTrace + Impact Analysis (吸收 wardenIQ 需求关联与影响分析思想，无变更不伪造)
            │
            ▼
Canonical TestSpec (唯一规范测试规约，含不可变声明式断言与所需证据契约)
            │
            ▼
core-kernel (四大核心调度入口)
 ├── probe()   ──> 产出探活与上下文画像，单向映射标准 CanonicalTestSpec
 ├── plan()    ──> 纯函数推导分流决策与测试计划，直接生成 CanonicalTestSpec
 ├── execute() ──> 注入 ExecutionAdapter，执行提交与调度，Fail-closed 校验适配器输出
 └── verify()  ──> 聚合 EvidenceProducer 产生证据信封，生成 TestSpec 并无条件穿透至裁决引擎
            │
            ▼
ExecutionAdapter / EvidenceProducer (收集层：零裁决权，严禁包含业务裁决字段)
 ├── API / Panqu Media (PanquMediaExecutionAdapter，严格隔离 sideEffectPolicy，零业务裁决字段)
 └── UI Evidence (UIBrowserEvidenceProducer / UIVisualAiEvidenceProducer，
      ├── DOM / Network / Screenshot (吸收 Playwright 确定性执行与证据模型)
      └── Visual Assist (吸收 Midscene 视觉辅助思想，仅输出 AI_OBSERVATION，绝不覆盖确定性失败))
            │
            ▼
Canonical Evidence Envelope (统一证据信封汇聚，强类型校验，防伪防冒充)
            │
            ▼
Canonical Verdict Engine (全系统唯一最终业务裁决源: 纯三态 PASS | FAIL | UNVERIFIED)
            │
            ▼
 ├── projectCanonicalVerdictToLegacy() ──> CLI / TRAE MCP (同源双模呈现层，兼容投影展示)
 └── ResultSink (只写不读单向导出，吸收 ReportPortal 思想，深冻结记录，绝不回写)
```

## 1.2 五大思想吸收的真实成熟度分类与永久不变量 (Maturity Model & Invariants)

本项目通过轻量纯函数与 TypeScript 端口规范吸收了业界优秀思想，**完全未安装、未引入、未 vendor 任何外部包（零外部包依赖）**。必须严格按以下四级成熟度客观界定，严禁夸大。成熟度（Maturity）与零依赖交付范围（Delivery Scope）是两个正交维度，严禁混用：

### 真实成熟度四级审计 (Strict 4-Level Maturity Audit)

| 开源项目思想 | 真实成熟度 (四级) | 交付范围 (正交维度) | 实际拥有了什么 (What We Have) | 没有什么 (What We Do NOT Have) | 运行时依赖状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Playwright** | `DEFERRED_EXTERNAL_RUNTIME` | `NOT_IN_ZERO_DEPENDENCY_SCOPE` | DOM/Network/Screenshot 证据信封规范、确定性上下文、只读/成本门禁、PNG二进制尺寸解析 | 真实浏览器控制、CDP 连接、真实页面交互（**不自制 CDP 框架，不声称真实 UI 执行**） | 未安装 playwright，依赖外部独立浏览器运行时，不在零依赖交付范围，禁止写为已接入 |
| **Midscene** | `DEFERRED_EXTERNAL_RUNTIME` | `NOT_IN_ZERO_DEPENDENCY_SCOPE` | `AI_OBSERVATION` 信封契约、绝对不变量（AI 不能单独 PASS、不可覆盖确定性失败） | 真实多模态视觉大模型推理引擎、真实 UI 界面元素视觉定位执行器 | 未安装 @midscene/web，依赖外部视觉大模型运行时，不在零依赖交付范围，禁止写为已接入 |
| **Promptfoo** | `BLOCKED_DATA_MISSING` | `IN_ZERO_DEPENDENCY_SCOPE` | 纯函数 Agent 评测引擎、八类核心漏洞检测、独立黄金预期比对逻辑、样本导入契约 | 被测智能体真实回答样本库（**缺真实数据时严格返回 BLOCKED_DATA_MISSING，零虚假指标**） | 零外部依赖，纯函数已就绪，但生产运行受限于真实样本供给 |
| **ReportPortal** | `IMPLEMENTED` | `IN_ZERO_DEPENDENCY_SCOPE` | `ExportableVerdictRecord` 递归深冻结纯映射、`ResultSink` 最小端口、本地 NDJSON 单向结果追加导出器 | 远程服务客户端、网络上报协议栈、双向状态同步与回写能力（**只写不读，严禁回写核心状态**） | 零外部依赖，本地 NDJSON 导出已就绪，远程对接为 `CONTRACT_ONLY` |
| **wardenIQ** | `BLOCKED_DATA_MISSING` | `IN_ZERO_DEPENDENCY_SCOPE` | 真实 Git 变更收集器 (`collectGitChangedPaths`)、纯函数影响分析 (`analyzeImpact`)、需求关联验证 | 仓库权威需求映射文件 (`devtest-requirements.json`)（**Git 变更可读但缺真实映射时严格标记 BLOCKED_DATA_MISSING，禁止创建虚假映射**） | 零外部依赖，Git 收集与分析就绪，受限于权威映射数据供给 |

### 核心不变量 (Core Invariants)
1. **CanonicalVerdictEngine 保持全系统唯一最终业务裁决源**：纯三态 (`PASS` | `FAIL` | `UNVERIFIED`)，所有适配器与采集器零裁决权。
2. **AI_OBSERVATION 绝对不可单独放行 PASS，绝对不可覆盖确定性断言失败**。
3. **ResultSink 严格只写不读**：单向持久化导出，输出脱敏，绝对禁止向 core-kernel 或裁决引擎回写任何状态。
4. **缺失事实严格 Fail-Closed**：无真实样本、无客观凭证或缺需求映射时，必须返回 `BLOCKED_DATA_MISSING` 或 `UNRESOLVED_REQUIREMENT`，严禁从 TestSpec 借用期望值或伪造关联。

核心代码资产保持在：

```text
src/devtest/
```

代码资产与模块边界严格按照以下四类层级划分，严禁模糊边界：

### 1.3 架构实现层级与四类组件边界划分 (Strict 4-Tier Component Boundaries)

#### 第一类：已进入生产调用链的真实逻辑 (Tier 1: Production Call Chain Core)
全链路唯一闭环调用流：`Legacy Input → RequirementTrace → Canonical TestSpec → core-kernel.executeCanonical → ExecutionAdapter → Canonical Evidence Envelope → Canonical Verdict Engine → CLI / MCP / ResultSink`。
- **RequirementTrace** (`src/devtest/requirement-trace.ts`): 区分 stable `requirementId` 与 `requirementText`；缺失稳定 ID 时置为 `UNRESOLVED_REQUIREMENT` 且 `impactAnalysis.executed=false`，严禁回退默认 ID 或将自然语言文本充当 ID。
- **CanonicalTestSpec** (`src/devtest/canonical-protocol.ts`): 唯一执行输入规约，执行前校验格式，包含确定性断言、`sideEffectPolicy`（默认 `READ_ONLY`）、`costLimit`（默认 0 预算）。
- **core-kernel.executeCanonical** (`src/devtest/core-kernel.ts`): 内部唯一标准执行中枢。执行所有前置门禁（Spec 自检、消歧、定价契约、授权检查、Adapter 模式隔离）；所有失败分支均输出统一 `ExecutionResult` 与 `canonicalSpec`。绝对不再直接引用或调用 `submitMediaTask`。
- **PanquMediaExecutionAdapter** (`src/devtest/execution-ports.ts`): 生产唯一真实派发适配器。内聚会话加载、`project_id` 校验与网络提交；缺少真实 handler 时 REAL 模式返回 `BLOCKED_NO_EXECUTOR`，OFFLINE 模式返回 `OFFLINE_DRY_RUN`，严禁伪造任务 ID 或冒充 SUBMITTED/COMPLETED。
- **Canonical Evidence Envelope** (`src/devtest/canonical-protocol.ts`): 统一证据信封标准载体，强类型校验，不可变，防篡改。
- **Canonical Verdict Engine** (`src/devtest/canonical-verdict-engine.ts`): 全系统唯一最终业务裁决源权威（纯三态 PASS / FAIL / UNVERIFIED），verify() 结果无条件穿透。
- **CLI / MCP 生产接入层** (`bin/devtest-cli.ts`, `src/devtest/mcp-service.ts`): 负责注入默认生产 `PanquMediaExecutionAdapter`，仅通过 `projectOperationToCompatibility` 反映请求生命周期状态，绝不自行计算业务 PASS/FAIL。

#### 第二类：可选注入适配器与库级能力 (Tier 2: Optional Injectable Adapters & Libraries)
- **ResultSink & NdjsonResultSink** (`src/devtest/result-sink.ts`): 最小只写不读持久化导出端口及本地 NDJSON 单向追加导出器，深冻结记录，单向导出，绝不回写或干预核心状态。
- **UI Evidence Producers** (`src/devtest/ui-adapters.ts`): `UIBrowserEvidenceProducer` 与 `UIVisualAiEvidenceProducer`，纯协议与信封抽象 (`DEFERRED_EXTERNAL_RUNTIME`，交付范围为 `NOT_IN_ZERO_DEPENDENCY_SCOPE`)，作为外部可选凭证收集器，绝不拥有裁决权，不自制 CDP 浏览器，不属于零依赖交付范围，禁止写为已接入。
- **Agent Evaluation** (`src/devtest/agent-evaluation.ts`): 评测引擎纯库能力，缺真实样本时严格标记 `BLOCKED_DATA_MISSING`。

#### 第三类：测试专用 Fixture / Adapter（仅限 tests/） (Tier 3: Test-Only Fixtures & Adapters)
- **TestOfflineExecutionAdapter** (`tests/helpers/test-adapters.ts`): 仅供测试套件用于离线/受控 Mock 执行仿真验证，支持模拟任务 ID。
- **UIFixtureExecutionAdapter** (`tests/helpers/ui-fixture-adapter.ts`): 仅供测试离线验证 UI 契约。
- **静态测试凭证与 Fixture** (`tests/fixtures/`): 合成 MP4、PNG 样本等。
- **绝对不变量**：测试专用适配器严禁导出到 `src/devtest/index.ts`，严禁在生产运行时默认加载。

#### 第四类：思想吸收与外部依赖隔离 (Tier 4: Absorbed Concepts, Zero Dependencies)
- **Playwright、Midscene、Promptfoo、ReportPortal、wardenIQ**：
  - 本项目**完全未安装、未引入、未 vendor** 上述外部框架源码或依赖；
  - 仅通过原生纯函数与精简 TypeScript 接口吸收其设计思想；
  - 禁止将“吸收设计思想”夸大为“已完成真实集成”；
  - `package.json` 保持 100% 干净，零新增依赖。

---

# 2. 核心语义冻结与受控扩展规则

系统**核心领域语义、验证规则与唯一最终裁决权永久冻结**。未经明确的人工授权，禁止改变核心边界或重构核心拓扑。

### 永久禁止项
未经明确人工授权，严禁：

* 新增 Web UI
* 新增 Dashboard
* 新增数据库层
* 新增 Redis / MQ / Cache 等持久化或中间件架构
* 新增独立 Agent
* 新增 AI 推理层
* 新增智能评分系统
* 新增 Report / 七章报告 / 大盘系统
* 新增 Orchestrator
* 新增 Manager / Coordinator 上帝类
* 新增 Service Layer / Repository Layer 等纯包装抽象
* 把 core-kernel 拆成大量没有业务价值的中间层
* 增加新的核心入口
* 增加第五个核心动作
* 改变 CLI / MCP 双入口同源模式
* 改变四大核心动作定义与验证不变量
* 用“架构升级”为理由重新组织整个 `src/devtest`
* 为了代码风格而大规模重构
* 为了增加功能而改变现有领域边界
* 引入与真实 Panqu 业务无关的基础设施

**禁止为了“看起来更企业级”而增加复杂度。**

如果某个优化只能通过改变上述架构实现，默认拒绝该优化。

---

## 2.1 受控适配器扩展原则 (Controlled Adapter Extension Rules)

为支持多环境与多终端测试能力的可控演进，将原“绝对禁止任何架构扩展”明确为：**核心领域语义冻结，允许通过标准端口增加可选适配器**。

所有新引入的适配器（ExecutionAdapter / EvidenceProducer）必须严格满足以下六项边界：

1. **核心领域语义冻结**：Task、Artifact、Media、Billing、Invariants、Acceptance 的核心语义与验证标准不得被任何适配器改变或弱化。
2. **标准端口接入**：适配器必须通过核心定义的标准端口接入（`ExecutionAdapter`、`EvidenceProducer`），禁止侵入 `core-kernel` 内部修改核心流程。
3. **职责严格受限**：适配器**只能负责执行操作或采集证据**，严禁包含任何业务验收判断或裁决逻辑。
4. **唯一最终裁决 (Single Verdict Engine)**：适配器**绝对不得拥有最终裁决权**。所有适配器采集的证据必须包装为标准证据信封，统一提交给唯一裁决引擎（Single Verdict Engine / core-kernel verify）进行无状态判定。
5. **四可隔离原则**：适配器必须**可开关**（配置/入参可选，默认关闭）、**可替换**、**可单测**（纯离线 Fixture 隔离测试）、**可删除**（完整移除适配器代码零污染核心功能）。
6. **重型依赖与设施单独授权**：外部第三方服务、重型运行时依赖（如浏览器引擎、外部 CLI/测试框架）和持久化设施仍属于高风险基础设施，必须经过单独人工授权方可引入。

---

## 2.2 本次人工授权范围 (Human Authorization Scope)

记录当前阶段已获得人工明确授权的具体边界与严格禁止项：

### 已获授权事项：
1. **Phase 0 可信度收口**：
   - 渠道消歧与 `channelMatched` 语义闭环；
   - 关闭 `gatewayChannelConfirmed` 与 `sourceMode=SOURCE_REAL_GATEWAY` 手工声明绕过漏洞；
   - 真实模式调用者断言证据降级（强制标记 `USER_ASSERTION_REJECTED`）；
   - 只读 HTTP 接口 extra 分流落库事实获取与 fail-closed 门禁。
2. **Phase 1 受控演进基础契约**：
   - Canonical TestSpec 契约规范定义；
   - Canonical Evidence Envelope 统一证据信封设计；
   - 标准端口（ExecutionAdapter / EvidenceProducer 最小标准接口）定义；
   - Single Verdict Engine 唯一最终裁决引擎收口。
3. **Phase 3 原生核心能力吸收边界与成熟度定级 (Playwright / Midscene / Promptfoo / ReportPortal / wardenIQ)**：
   - **Playwright / Midscene (`DEFERRED_EXTERNAL_RUNTIME` + `NOT_IN_ZERO_DEPENDENCY_SCOPE`)**：定义 DOM/网络/真实截图引用与视觉 AI 观察信封抽象至独立生产模块 (`ui-adapters.ts`)，严格由调用方提供 evidenceId 与 capturedAt 保证确定性；不安装依赖、不自制 CDP 浏览器框架；成熟度定级为 `DEFERRED_EXTERNAL_RUNTIME`，交付范围明确标记为 `NOT_IN_ZERO_DEPENDENCY_SCOPE`（正交维度），不属于零依赖交付范围，严禁写为已接入；
   - **Promptfoo (`BLOCKED_DATA_MISSING` / `CONTRACT_ONLY`)**：实现工具无关 Agent Evaluation 纯函数 (`agent-evaluation.ts`)，定义真实样本导入契约 (`AgentSampleImportContract`)；isRealSample 严格为 true 门禁，缺少真实样本或黄金基线时严格阻断为 `BLOCKED_DATA_MISSING`，严禁从输出反推黄金预期；
   - **ReportPortal (`IMPLEMENTED` 本地 NDJSON / `CONTRACT_ONLY` 远程)**：实现最小只写不读 `ResultSink` 端口、递归深冻结纯映射及本地 `NdjsonResultSink` 单向结果追加导出器 (`result-sink.ts`)，严格无回写能力，不冻结入参；
   - **wardenIQ (`BLOCKED_DATA_MISSING` / 缺真实映射)**：实现真实 Git 变更收集器 (`collectGitChangedPaths`) 与纯函数影响分析 (`requirement-trace.ts`)；在仓库未提供权威映射文件时严格标记 `BLOCKED_DATA_MISSING`，禁止创建虚假映射；只有分析纯函数时为 `CONTRACT_ONLY`，两者闭环后才为 `IMPLEMENTED`。

### 实际能力边界与接入状态声明：
* **边界界定**：上述能力按成熟度客观划分，严禁把 `CONTRACT_ONLY` 或 `DEFERRED_EXTERNAL_RUNTIME` 宣传为“已完成端到端接入”。成熟度与零依赖交付范围是两个正交维度。
* **状态声明**：生产运行时动作（probe/plan/execute/verify）保持既有拓扑，未新增 CLI/MCP 冗余动作命令。
* **智能体评测数据状态**：`BLOCKED_DATA_MISSING`（在未提供被测智能体真实回答样本或独立冻结基线时，生产流程严格返回 `BLOCKED_DATA_MISSING`，零假 PASS，绝不伪造指标）。

### 明确未授权事项（严禁擅自实施）：
* 本授权**不代表未来无限架构修改授权**；
* **严禁擅自增加 CLI/MCP 命令**或伪称端到端运行时接入完成；
* **严禁安装或引入** Playwright、Midscene、Promptfoo、ReportPortal 或 wardenIQ 等重量级外部 npm 包/运行时依赖；
* 严禁自行搭建持久化数据库、中间件服务或外部网络守护进程。

---

## 2.3 TrustedGatewaySnapshot 与采集器边界规则

针对 NewAPI 网关渠道快照证据（`SOURCE_REAL_GATEWAY`），确立永久性可信边界：

1. **可验证只读路径**：可信快照必须且仅能来自经过验证的只读 API 采集器（如 `/aivideo/channel/index` 只读快照），且快照信封必须包含：`environment`、`capturedAt`、`sourceEndpoint`、`collectionStatus=SUCCESS`、`provenance`。
2. **禁止调用者声明升级**：CLI、MCP、编程入参等任何调用者单方传入的 `gatewayChannelConfirmed=true` 或 `sourceMode='SOURCE_REAL_GATEWAY'` 均为 `USER_ASSERTION`，严禁在 REAL 模式升级为可信证据。
3. **缺失采集器时严格 Fail-Closed**：在当前代码库尚未接入真实只读网关快照采集器之前，标记为 `BLOCKED_MISSING_TRUSTED_COLLECTOR`，Canonical Verdict 表现为 `UNVERIFIED` 并附加阻断 blocker，经兼容投影后验收 `acceptance` **必须严格保持 BLOCKED**，坚决禁止虚假放行（零假 PASS）。
4. **适配器边界规范**：未来真实只读快照采集器实现时，必须作为标准的 `EvidenceProducer` 接入，通过标准证据信封传递，严禁在 core-kernel 之外任意位置散落采集逻辑或引入写副作用。

---

# 3. 四大核心动作与领域模块职责边界 (核心语义冻结，无最终裁决权)

系统四大核心动作调度器（`probe`、`plan`、`execute`、`verify`）及核心领域支撑模块（`env-probe`、`routing`、`media-flow`、`media-inspector`、`billing`）严格各司其职。

> [!IMPORTANT]
> **当前接入状态与无最终裁决权声明 (Access Status & No Verdict Authority)**：
> 1. **当前接入范围边界**：四大核心动作中，**当前仅有 `verify()` 完整接入了 Canonical Evidence 与 CanonicalVerdictEngine 唯一最终裁决引擎**；`probe()`、`plan()`、`execute()` 当前仍走原生领域调用链，**尚未全部迁移至 Canonical TestSpec / Evidence Envelopes**，严禁声称它们已全部迁移。`legacy-protocol-mappers.ts` 中虽包含 `mapPlanToCanonicalTestSpec` 等兼容映射函数，但这些函数目前未接入 probe/plan/execute 生产链路。
> 2. **领域模块事实边界与 verify 真实链路**：所有核心领域支撑模块均输出各自原生领域数据结构（如 `EnvProbeReport`、`GatewayRoutingVerdict`、`TaskStatusSnapshot`、`MediaInspectionResult`、`BillingAuditReport`），**当前并不直接输出 Canonical Evidence Envelope**。当前 `verify()` 的真实链路为：
>    1. `core-kernel.verify()` 负责收集领域事实；
>    2. `buildCanonicalEvidenceFromVerifyFacts()` 只负责将 verify 事实转换为 `CanonicalEvidenceEnvelope[]`（Evidence Envelope 由 mapper 转换生成，绝不负责构建 TestSpec）；
>    3. `core-kernel.verify()` 负责根据当前验收场景直接构建不可变 `CanonicalTestSpec`（明确由 core-kernel.verify() 构建，不得声称 `legacy-protocol-mappers` 或该函数负责构建 TestSpec）；
>    4. `Canonical Verdict Engine` 统一裁决；
>    5. `projectCanonicalVerdictToLegacy()` 只做兼容投影。
> 3. **无最终裁决权声明**：四大核心动作调度器和所有领域支撑模块**均不拥有最终裁决权**。全系统**唯一的最终裁决权威必须且仅能由 `CanonicalVerdictEngine` (Single Verdict Engine)** 统一裁定。

系统核心调度动作只允许：

```text
probe()
plan()
execute()
verify()
```

## probe()

只负责：

* 环境探活与画像发现
* Session / Cookie 有效性感知
* 主站连通性与网关可用性探测
* 产出原生探活分析报告 (`EnvProbeReport`)（当前尚未迁移至 Canonical 体系）

**裁决权边界**：无裁决权。探活成功仅代表探测时刻的环境网络与凭据状态连通，不能直接代表测试通过或发布裁决。

禁止在 probe 中：

* 创建任务
* 修改业务数据
* 扣费
* 退款
* 产生业务副作用

---

## plan()

只负责：

* 业务路由推导
* NewAPI / 直连决策
* 网关候选渠道与分流标记
* 预期刊例计算
* 产出原生测试规划结果 (`PlanKernelResult` / `TestCasePlan`)（当前尚未直接生成 CanonicalTestSpec）

**裁决权边界**：无裁决权。路由推导与预期计算仅定义测试契约和期望基准（Expectations），绝非最终裁决事实。

特别注意：

`expectedPoints` / 模型配置 / 测试参数不是天然的真实账务事实。

必须明确区分：

```text
REAL_BILLING_FACT
DEVTEST_EXPECTATION
```

不能把测试预期伪装成真实 Billing Fact。

---

## execute()

只负责：

* REAL 真实任务提交
* OFFLINE 离线仿真
* FIXTURE 测试夹具
* 捕获任务提交后的原生事实快照 (`ExecuteKernelResult` / `TaskStatusSnapshot`)（当前尚未迁移至 ExecutionAdapter 端口）

**裁决权边界**：无裁决权。任务提交成功（例如 HTTP 200 或后端分配 task_id）绝不等于业务验证 PASS。执行动作绝不能给自身或调用方直接签发通过裁决。

三者必须严格隔离：

```text
REAL
OFFLINE
FIXTURE
```

任何 OFFLINE / FIXTURE 任务都不得伪装成真实生产 Task。

OFFLINE 必须具有明确：

```text
simulationId
isSimulated = true
executionMode = offline
```

---

## verify()

verify 是整个系统的测试执行编排中枢与事实汇聚边界，也是**当前唯一完整接入 Canonical 协议与 Verdict Engine 的核心动作**。

当前 `verify()` 的真实链路严格按照标准化流水线执行：

```text
1. core-kernel.verify() 负责收集各领域原生事实 (驱动领域支撑模块执行只读采集与物理分析，获取 media-flow、media-inspector、billing、env-probe、routing 原生事实)；
2. buildCanonicalEvidenceFromVerifyFacts() 只负责将 verify 事实转换为统一不可变 CanonicalEvidenceEnvelope[] (Evidence Envelope 由 mapper 转换生成，绝不负责构建 TestSpec)；
3. core-kernel.verify() 负责根据当前验收场景直接构建不可变 Canonical TestSpec (明确由 core-kernel.verify() 构建，不得声称 legacy-protocol-mappers 或 buildCanonicalEvidenceFromVerifyFacts 负责构建 TestSpec)；
4. Canonical Verdict Engine (CanonicalVerdictEngine.evaluateCanonicalVerdict) 统一裁决，产出纯三态裁决 (CanonicalVerdict: PASS | FAIL | UNVERIFIED; 门禁阻断统一表示为 UNVERIFIED + blocker)；
5. projectCanonicalVerdictToLegacy() 只做兼容投影，投影为包含 status / verdict / acceptance (BLOCKED / ACCEPTED / REJECTED) 的回执。
```

五维证据验证流水线永久保持：

```text
Task
 ↓
Artifact
 ↓
Media
 ↓
Billing
 ↓
Invariants
 ↓
Canonical Verdict Engine (唯一最终裁决权威: 纯三态 PASS | FAIL | UNVERIFIED)
 ↓
projectCanonicalVerdictToLegacy (兼容投影: acceptance = ACCEPTED | REJECTED | BLOCKED | UNVERIFIED)
```

**裁决权边界**：`verify()` 本身作为事实编排者，**不私设临时放行逻辑或自制裁决**，其裁决权完全收敛至 `CanonicalVerdictEngine`。

verify 必须：

* 无状态
* 可重复
* 可独立执行
* 不依赖 execute 的内存变量
* 只读
* Fail-closed

---

## 核心领域模块职责与裁决权边界 (Domain Modules)

核心领域支撑模块各司其职，产出各自的原生领域结构，**不直接输出 Canonical Evidence Envelope，且一律不具备最终裁决权**：

* **`env-probe.ts`**：执行环境连通性与模型白名单探测，输出原生 `EnvProbeReport`。**无裁决权，不直接输出 Envelope**。
* **`routing.ts` (RoutingOracle)**：执行直连与 NewAPI 分流决策与渠道消歧计算，输出原生 `GatewayRoutingVerdict`。**无裁决权，不直接输出 Envelope**。
* **`media-flow.ts`**：执行媒体任务真实网络提交与容错状态轮询，输出原生 `TaskStatusSnapshot`。**无裁决权，不直接输出 Envelope**。
* **`media-inspector.ts`**：执行二进制物理结构分析（MP4 ftyp/moov/mdat、尾部 moov 切片、PNG IHDR），输出原生 `MediaInspectionResult`。**无裁决权，不直接输出 Envelope**。
* **`billing.ts` (BillingOracle)**：执行流水对账与三大金融安全不变量计算，输出原生 `BillingAuditReport`。**无裁决权，不直接输出 Envelope**。

所有领域模块产出的原生事实，统一在 `verify()` 调用链中由 `core-kernel.verify()` 收集，并通过 `buildCanonicalEvidenceFromVerifyFacts()` 转换生成 `CanonicalEvidenceEnvelope[]`（该函数只负责将 verify 事实转换为 Evidence Envelope，绝不构建 TestSpec），再由 `core-kernel.verify()` 根据当前验收场景直接构建不可变 `CanonicalTestSpec` 后，统一提交给 `CanonicalVerdictEngine` 进行终审。

---

# 4. Verify 永久只读

verify 允许：

```text
GET
```

以及明确的只读：

```text
POST /aivideo/v2/task_status/apiGetStatus
```

除此之外，不允许任何写操作。

禁止：

* 创建任务
* 重试任务
* 重新生成
* 扣费
* 退款
* 修改 Task
* 修改 Billing
* 修改数据库
* 重算业务数据
* 自动修复线上数据

如果发现 verify 存在写副作用：

**优先级立即提升为 P0 Bug。**

---

# 5. Fail-closed 永久原则

任何证据不足：

```text
UNVERIFIED
```

不得：

```text
undefined → true
null → PASS
[] → PASS
0 → PASS
UNKNOWN → SUCCESS
catch → PASS
HTTP 200 → PASS
```

尤其禁止：

```typescript
foo ?? true
foo || true
status || 'SUCCESS'
```

除非该默认值具有明确且经过证明的业务语义。

---

# 6. Final Verdict 永久规则与唯一裁决引擎 (Canonical Verdict Engine)

全系统最终裁决必须且仅能由 `CanonicalVerdictEngine`（Single Verdict Engine）统一执行。任何外层模块、CLI/MCP 或领域支撑模块均不得绕过裁决引擎自行判定。

> [!IMPORTANT]
> **裁决状态空间与投影映射界定**：
> 1. **Canonical Verdict 严格仅有三值**：`CanonicalVerdict` 核心枚举空间永久保持为纯三态：
>    ```typescript
>    export type CanonicalVerdict = 'PASS' | 'FAIL' | 'UNVERIFIED';
>    ```
>    引擎内部**绝对不存在**第四种独立的 `BLOCKED` 裁决值。
> 2. **安全门禁阻断的真实表示**：安全门禁拦截（如缺少可信采集器、网关渠道未确认、刊例定价未定等）在引擎内部严格统一表示为：
>    ```text
>    verdict: 'UNVERIFIED' + blockers: CanonicalBlocker[]
>    ```
> 3. **兼容投影层产出 acceptance=BLOCKED**：只有在进入兼容投影转换器（`projectCanonicalVerdictToLegacy`）后，带有 blocker 的 `UNVERIFIED` 才被单向投影映射为旧协议的：
>    ```text
>    acceptance: 'BLOCKED'
>    ```
>    若 `UNVERIFIED` 且无 blocker，则投影为 `acceptance: 'UNVERIFIED'`；`FAIL` 投影为 `acceptance: 'REJECTED'`；无 blocker 的 `PASS` 投影为 `acceptance: 'ACCEPTED'`。

### CanonicalVerdictEngine 内部三态裁决矩阵

引擎求值严格按以下优先级判定（FAIL 优先于 UNVERIFIED）：

```text
任何必需证据 observationStatus 明确为 FAIL
或任一关键确定性断言 (critical assertion) 明确失败
        ↓
      FAIL

没有 FAIL
但存在安全门禁阻断 (blockers)
或必需证据缺失/采集失败/UNVERIFIED
或关键断言缺少绑定/字段缺失/无法计算
或仅有主观证据 (AI_OBSERVATION / USER_ASSERTION)
        ↓
   UNVERIFIED (+ blockers)
   [注: 经兼容投影层 projectCanonicalVerdictToLegacy 映射为 acceptance = 'BLOCKED' 或 'UNVERIFIED']

所有必需证据全部 PASS (collectionStatus: SUCCESS, observationStatus: PASS)
且所有关键确定性断言全部 PASS
且安全门禁无任何 blocker
        ↓
      PASS
   [注: 经兼容投影层 projectCanonicalVerdictToLegacy 映射为 acceptance = 'ACCEPTED']
```

不得因为用户“希望绿色”而改变这个规则。

不得通过降低验证要求或缺少黄金预期获得 PASS（零假 PASS）。

---

# 7. Artifact Ownership 永久规则

媒体产物必须建立：

```text
Task ID
   ↓
Task Snapshot
   ↓
Artifact URL
```

只有从真实 Task Snapshot 获取并能够证明归属的产物：

```text
ownership = VERIFIED
```

外部：

```text
--video-url
--pic-url
```

如果没有 Task → Artifact 的真实绑定证据：

```text
ownership = UNVERIFIED
```

即使媒体文件本身是合法 MP4 / PNG，也不能因此自动成为当前 Task 的 PASS 证据。

---

# 8. Media Evidence 永久规则

不能：

```text
HTTP 200 = Media PASS
```

必须进行实际二进制结构检查。

MP4 至少检查：

```text
ftyp
moov
mdat
```

并在能力范围内检查：

```text
trak
tkhd
mdia
```

PNG 必须检查真实：

```text
IHDR
```

必须诚实描述验证范围。

例如：

```text
MP4 container structure PASS
```

不能把“容器结构检查通过”夸大成：

```text
完整播放验证通过
```

除非确实执行了完整播放/解码验证。

---

# 9. Billing 永久规则

Billing 必须基于真实流水证据。

核心不变量永久保留：

```text
antiDoubleBilling
netChargeZero
refundIdempotency
```

## antiDoubleBilling

必须区分：

```text
0 次
1 次
2+ 次
```

原则：

```text
2+ → FAIL

1 → PASS

0 →
    只有真实事实证明免扣
    → PASS

    其他
    → UNVERIFIED
```

不能使用：

```text
count <= 1 → PASS
```

---

## netChargeZero

失败任务：

```text
真实预扣
+
真实退款
+
netDeducted = 0
```

才能：

```text
PASS
```

以下均不得 PASS：

```text
没有流水
没有预扣
查询失败
0 - 0 = 0
```

---

## refundIdempotency

失败任务：

```text
真实预扣
+
恰好一次必要退款
```

才能 PASS。

重复退款：

```text
2+ → FAIL
```

无法证明：

```text
UNVERIFIED
```

成功任务存在异常退款：

```text
FAIL
```

---

# 10. Billing 查询错误必须与“无流水”区分

Billing 查询必须能够区分：

```text
QUERY_SUCCESS + records > 0
QUERY_SUCCESS + records = 0

AUTH_FAILED
QUERY_TIMEOUT
PARSE_ERROR
QUERY_ERROR
```

禁止：

```text
catch → []
```

再让 Billing Oracle 把：

```text
查询失败
```

误认为：

```text
真实无流水
```

如果真实 Billing 无法查询：

```text
billing = UNVERIFIED
```

---

# 11. Task → Billing Ownership

不能因为：

```text
当前 verify 的 taskId
```

就强制给所有 Billing Record 填充：

```text
task_id = 当前 taskId
```

只有真实后端：

* task_id
* memo
* remark
* 其他明确业务关联字段

能够证明归属时，才允许建立关联。

否则：

```text
task ownership = UNVERIFIED
```

宁可不通过，也不能制造关联。

---

# 12. 真实 API 原则

禁止凭空创造：

```text
/api/billing
/api/task
/api/refund
```

等不存在的接口。

任何新 API 必须首先从：

* Panqu 后端实际代码
* 实际路由
* 实际控制器
* 实际接口响应
* 真实 E2E

得到证据。

无法证明：

```text
UNVERIFIED
```

不要猜。

---

# 13. 真实 E2E 与 Fixture 永久分离

以下不能称为 Real E2E：

```text
Mock
Fixture
Stub
Unit Test
Contract Test
Fake Task ID
Fake Billing Record
```

它们只能证明：

```text
代码逻辑正确
```

不能证明：

```text
Panqu 真实业务正确
```

Real E2E 必须具备：

```text
真实 Session
+
真实 Task ID
+
真实 API
+
真实 Artifact
+
真实 Billing Record
```

缺任何必要证据：

```text
REAL_E2E = NOT EXECUTED / UNVERIFIED
```

不得虚报。

---

# 14. 修改代码前必须执行的判断

收到任何“优化”“重构”“升级”需求时，先判断：

### A. 是否属于架构变化？

如果是：

```text
拒绝自动修改。
```

要求人工明确授权。

### B. 是否属于真实 Bug？

如果是：

```text
允许最小范围修复。
```

### C. 是否属于真实业务兼容问题？

如果有真实证据：

```text
允许最小范围修复。
```

### D. 是否只是代码风格？

除非明确要求：

```text
不要修改。
```

### E. 是否只是“感觉可以更高级”？

```text
不要修改。
```

---

# 15. 修改原则

永久遵循：

```text
最小修改
>
局部修复
>
增加回归测试
>
运行全量测试
>
运行 build
>
检查 diff
>
再提交
```

禁止：

```text
为了一个 Bug
→ 顺便重构整个模块
```

禁止：

```text
为了增加一个字段
→ 重构整个类型系统
```

禁止：

```text
为了改善输出
→ 创建新的 Report 层
```

---

# 16. 测试永久要求

任何逻辑修复必须增加对应回归测试。

至少保证：

```bash
npm test
npm run build
```

全部通过。

测试必须覆盖：

* PASS
* FAIL
* UNVERIFIED
* 网络异常
* 鉴权失败
* 数据缺失
* 边界值
* 重复扣费
* 漏退款
* 重复退款
* Artifact ownership
* REAL / OFFLINE / FIXTURE 隔离
* verify 零写副作用

---

# 17. 真实 E2E 状态纪律

没有真实凭据：

```text
REAL_E2E = NOT EXECUTED
```

没有真实 Task：

```text
REAL_E2E = NOT EXECUTED
```

没有真实 Billing：

```text
Billing = UNVERIFIED
```

没有真实 Artifact：

```text
Media = UNVERIFIED
```

不要修改代码来消除这些状态。

这些状态代表：

**证据不存在，而不是代码失败。**

---

# 18. 架构冻结后的允许优化范围

未来仍然允许：

```text
Bug Fix
真实 API 兼容修复
真实字段映射修复
安全修复
Fail-closed 修复
测试补强
性能微优化
错误信息改进
日志脱敏
类型安全修复
依赖安全升级
```

但必须满足：

```text
不改变核心拓扑
不增加核心动作
不增加平台层
不改变证据语义
不降低验证要求
不制造 PASS
```

---

# 19. 永久禁止的“优化理由”

以下理由本身不能成为改架构依据：

```text
“更优雅”
“更企业级”
“更智能”
“以后方便扩展”
“可以做成平台”
“可以增加 Agent”
“可以加 Dashboard”
“可以统一成 Manager”
“可以做自动化大盘”
“代码还可以抽象”
“文件数量可以重新整理”
```

除非存在真实业务问题，否则不执行。

---

# 20. 每次 Coding Agent 执行前必须先做架构护栏检查

输出：

```text
ARCHITECTURE_GUARD

Architecture:
FROZEN

Will architecture change?
YES / NO

If YES:
STOP — REQUIRE HUMAN AUTHORIZATION

If NO:
Proceed with minimal scoped change.
```

如果判断会改变：

```text
CLI / MCP
core-kernel
canonical-protocol
canonical-verdict-engine
legacy-protocol-mappers
execution-ports
probe / plan / execute / verify
env-probe
routing
media-flow
media-inspector
billing
```

之间的核心职责边界：

```text
STOP
```

等待人工明确授权。

---

# 21. 最终原则

永远遵循：

```text
真实证据 > 测试绿色
测试绿色 > 代码漂亮
简单架构 > 复杂架构
确定性 > 智能包装
UNVERIFIED > 假 PASS
真实业务 > Mock
最小修改 > 大规模重构
```

最终目标不是让系统“看起来很完整”。

最终目标只有：

```text
Panqu 真实业务
      ↓
真实证据
      ↓
确定性验证
      ↓
可信 Verdict
```

**架构冻结后，不再主动升级架构。**

以后所有工作默认属于：

```text
MAINTENANCE
BUG FIX
REAL E2E
COMPATIBILITY
TEST HARDENING
```

而不是：

```text
ARCHITECTURE REFACTOR
```

如果没有明确人工授权，**禁止改变架构。**
