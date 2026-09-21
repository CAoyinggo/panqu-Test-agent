# Panqu AI DevTest — PERMANENT ARCHITECTURE FREEZE

你正在维护 Panqu AI DevTest。

从本规范生效开始，**核心架构永久冻结**。

你的首要任务不是重构、扩展或“优化架构”，而是在既有架构边界内修复真实问题、验证真实业务、补充测试，并保持系统事实第一、Fail-closed、零假 PASS。

---

# 1. 永久架构定义

系统唯一允许的核心拓扑：

```text
CLI / TRAE MCP
      │
      ▼
core-kernel
      │
      ├── probe()
      ├── plan()
      ├── execute()
      └── verify()
      │
      ├── env-probe
      ├── routing
      ├── media-flow
      ├── media-inspector
      └── billing
```

核心代码资产保持在：

```text
src/devtest/
```

核心领域模块：

```text
core-kernel.ts
mcp-service.ts
media-flow.ts
media-inspector.ts
billing.ts
routing.ts
env-probe.ts
types.ts
index.ts
version.ts
```

CLI 与 TRAE MCP 必须继续共享同一个 `core-kernel`。

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

所有新引入的适配器（Execution Adapters / Evidence Producers）必须严格满足以下六项边界：

1. **核心领域语义冻结**：Task、Artifact、Media、Billing、Invariants、Acceptance 的核心语义与验证标准不得被任何适配器改变或弱化。
2. **标准端口接入**：适配器必须通过核心定义的标准端口接入（如 Canonical TestSpec、Canonical Evidence Envelope），禁止侵入 `core-kernel` 内部修改核心流程。
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
   - 标准端口（Execution Adapter / Evidence Producer 最小接口）定义；
   - Single Verdict Engine 唯一最终裁决引擎收口。

### 明确未授权事项（严禁擅自实施）：
* 本授权**不代表未来无限架构修改授权**；
* **严禁一次性或未经授权接入** Playwright、Midscene、Promptfoo、ReportPortal 或 wardenIQ 等重量级外部框架/运行时依赖；
* 严禁自行搭建持久化数据库、中间件服务或外部网络守护进程。

---

## 2.3 TrustedGatewaySnapshot 与采集器边界规则

针对 NewAPI 网关渠道快照证据（`SOURCE_REAL_GATEWAY`），确立永久性可信边界：

1. **可验证只读路径**：可信快照必须且仅能来自经过验证的只读 API 采集器（`API_READONLY_COLLECTOR`，如 `/aivideo/channel/index` 只读快照），且快照信封必须包含：`environment`、`capturedAt`、`sourceEndpoint`、`collectionStatus=SUCCESS`、`provenance`。
2. **禁止调用者声明升级**：CLI、MCP、编程入参等任何调用者单方传入的 `gatewayChannelConfirmed=true` 或 `sourceMode='SOURCE_REAL_GATEWAY'` 均为 `USER_ASSERTION`，严禁在 REAL 模式升级为可信证据。
3. **缺失采集器时严格 Fail-Closed**：在当前代码库尚未接入真实只读网关快照采集器之前，标记为 `BLOCKED_MISSING_TRUSTED_COLLECTOR`，REAL 模式验收**必须严格保持 BLOCKED**，坚决禁止虚假放行（零假 PASS）。
4. **适配器边界规范**：未来真实只读快照采集器实现时，必须作为标准的 `EvidenceProducer` / `API Adapter` 接入，通过标准证据信封传递，严禁在 core-kernel 之外任意位置散落采集逻辑或引入写副作用。

---

# 3. 四大核心动作永久冻结

系统只允许：

```text
probe()
plan()
execute()
verify()
```

## probe()

只负责：

* 环境探活
* Session / Cookie 有效性感知
* 主站连通性
* 网关可用性

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
* 网关候选渠道
* 预期刊例计算

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

verify 是整个系统最重要的可信边界。

必须保持：

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
Final Verdict
```

verify 必须：

* 无状态
* 可重复
* 可独立执行
* 不依赖 execute 的内存变量
* 只读
* Fail-closed

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

# 6. Final Verdict 永久规则

最终裁决必须遵循：

```text
任何核心证据 FAIL
        ↓
      FAIL

没有 FAIL
但存在任意 UNVERIFIED
        ↓
    UNVERIFIED

Task
+
Artifact
+
Media
+
Billing
+
Invariants
全部 PASS
        ↓
      PASS
```

不得因为用户“希望绿色”而改变这个规则。

不得通过降低验证要求获得 PASS。

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
