# Phase 19 集成收尾报告：Memory 知识系统 + Pipeline/CLI 集成 + 安全边界

> 承接 Phase 14-18（Defect / Self-Healing / Approval / State Machine / Observability / Evaluation），
> 本次完成剩余收尾：Memory 知识系统升级、Pipeline 全链路集成、CLI 增强、Tool 安全边界，并通过最终端到端 15 步闭环验收。

---

## 1. Memory 知识系统升级（Knowledge System）

在原有 `TestMemory` 接口（save / query / getSimilarFailures）基础上，新增 4 个知识查询接口，使记忆层从「存储」升级为「可检索的知识系统」，供各 Agent 在流程中复用历史经验。

### 接口（`src/agents/memory/memory-store.ts`）

| 方法 | 用途 | 匹配依据 |
| --- | --- | --- |
| `querySimilarCase(caseId, limit=20)` | 检索某用例的全部历史（执行/失败/根因/flaky） | `data.caseId` 精确 / `caseIds` 数组 / 标签命中 |
| `queryHistoricalRisk(feature, limit=20)` | 检索某功能的历史风险 | type ∈ {failure, root-cause, flaky} + feature/module/tags |
| `queryKnownIssue(feature?, limit=20)` | 检索已知问题 | type ∈ {defect, root-cause} + feature 过滤 |
| `queryCoverageGap(feature?, limit=50)` | 检索测试覆盖缺口 | type = coverage-gap + feature 过滤 |

- `MemoryRecordType` 新增 `'coverage-gap'` 类型。
- `JsonMemoryStore` 实现 4 个查询，公共 `sortByTime` 按 `createdAt` 倒序（无时间戳排末尾）。
- `NoopMemory` 兜底实现带下划线参数（`_caseId/_feature/_limit`），保证 Memory 不可用时流程不中断。
- 测试：`tests/unit/memory-knowledge.test.ts`（7 用例：4 查询 + NoopMemory 兜底），已验证 caseIds 数组安全守卫（`Array.isArray`）、类型过滤、feature 过滤、倒序排序。

---

## 2. Pipeline 全链路集成（`src/agents/orchestration/agent-pipeline.ts`）

将 Phase 10-18 全部新 Agent 接入统一流水线，形成 12 阶段闭环：

```
核心阶段：Requirement → TestDesign → Risk → Data → Execution → Analysis → Memory 写入
增强阶段：Selection → Coverage → RCA → Defect → Healing → Approval
横切能力：AgentTracer（观测）+ AgentBudget（预算）
```

### 新增阶段与接入位置

| 阶段 | 位置 | Agent | 产物 |
| --- | --- | --- | --- |
| Selection（智能选择） | Risk 之后 | `TestSelectionAgent` | 选中/跳过用例集（默认仅记录，`useSelection` 时按选中集执行） |
| Coverage（覆盖缺口） | Selection 之后 | `CoverageAgent` | 各维度覆盖率 + 缺口列表 |
| RCA（根因） | Analysis 之后 | `RootCauseAgent` | 每个失败用例的证据链根因（`maxRca` 上限） |
| Defect（缺陷草稿） | RCA 之后 | `DefectAgent` | DRAFT 草稿（`maxDefects` 上限，绝不提交） |
| Healing（自愈建议） | Defect 之后 | `SelfHealingAgent` | SUGGESTED 建议（绝不自动改码） |
| Approval（分级审批） | Healing 之后 | `evaluateApproval` + `ApprovalAuditLog` | 审批请求 + 结论 + 审计日志 |

### `AgentPipelineResult` 扩展字段

`selection` / `coverage` / `rcas` / `defects` / `healing` / `approvals` / `approvalResults` / `audit` / `trace` / `budgetStatus`（全部可选，保持原有字段向后兼容）。

### 设计要点

- **确定性优先 + 增强阶段失败不中断主流程**：核心阶段（requirement→analysis）失败向上抛出；增强阶段失败/预算超限自动跳过（`stages[key]=false`），主流程继续。
- **安全边界内嵌**：Defect 仅 DRAFT、Healing 仅 SUGGESTED；Approval 按 `evaluateApproval` 分级（生产危险操作 DENY），REVIEW/MANUAL 默认 `pending` 待人工，`autoApprove` 可显式放行。
- **Trace/Budget 横切**：每阶段 `startSpan`/`endSpan` 记录观测；每阶段前 `budget.check()`，核心阶段超限告警继续、增强阶段超限跳过。
- **修复缺陷 Agent 空输出回退**：`DefectAgent.execute` 在 LLM 成功响应但解析出 0 条合法草稿（且有失败用例）时，视为无效输出并回退确定性规则生成（此前会静默返回空）。

### 测试

`tests/unit/agent-pipeline.test.ts` 新增 5 个增强阶段用例：完整链路产物、增强阶段全关、autoApprove 审计、预算超限跳过增强阶段、useSelection 执行。现共 10 个用例。

---

## 3. CLI 集成（`bin/run-agent.ts`）

新增参数与增强报告输出：

```
--use-selection       用智能选择选中的用例集执行
--auto-approve        自动批准 REVIEW 级审批（默认保持 pending）
--no-selection/--no-coverage/--no-rca/--no-defect/--no-healing/--no-approval/--no-trace  逐阶段开关
--max-rca=<n> / --max-defects=<n>   上限
--budget-tokens/--budget-llm/--budget-agents/--budget-tools/--budget-cases/--budget-concurrency/--budget-duration  预算参数
```

人类可读报告新增：测试选择 / 覆盖分析 / 根因分析 / 缺陷草稿（DRAFT）/ 自愈建议（SUGGESTED）/ 审批决策 / 观测摘要 / 预算状态。

---

## 4. 安全边界（Tool 权限层 + 脱敏）

### 权限等级（`src/agents/tools/tool.ts`）

`AgentTool` 新增 `permission?: 'read' | 'safe' | 'risky' | 'dangerous'` 与 `deniedInProduction?: boolean`。

| 等级 | 含义 | 生产环境行为 |
| --- | --- | --- |
| read | 只读查询 | 放行 |
| safe | 安全执行（现有 `execution.run` / `data.prepare`） | 放行 |
| risky | 风险操作（真实扣费/大并发/删除数据） | 需审批，无审批默认拒绝 |
| dangerous | 生产危险（真实扣费/删库/系统命令） | 拒绝（strict） |
| deniedInProduction | 显式禁止 | 一律拒绝 |

### 注册表强制（`src/agents/tools/tool-registry.ts`）

- `ToolRegistryOptions` 新增 `environment` / `permissionPolicy`（strict 默认 / permissive）/ `onApproval`。
- `call()` 执行前 `enforcePermission()`：生产环境 risky/dangerous 无审批 → 返回结构化失败（不抛异常），并写审计。
- **脱敏**：审计日志中的输入统一经 `redactSensitive()` 递归掩码敏感字段（token/password/secret/authorization/cookie/apiKey/cvv/card 等 → `***`），敏感信息不落明文。
- 测试：`tests/unit/tool-registry.test.ts` 新增 9 个安全边界用例（脱敏、prod/preonline 拒绝 dangerous、risky 默认拒绝 + onApproval 放行/拒绝、deniedInProduction、test 放行、permissive 告警放行、被拦截写入审计且脱敏）。

---

## 5. 端到端 15 步闭环验收（`tests/e2e/agent-e2e.test.ts`）

场景：**测试 WAN3 文生视频功能，覆盖正常、边界、异常、积分、并发和模型异常**（MockLLM + mock 执行引擎，第 2/3/6 条失败：超时 / 路径失效 / 积分扣费）。

| # | 闭环步骤 | 断言 |
| --- | --- | --- |
| 1 | 需求解析 | `requirement.feature === 'wan3'` |
| 2 | 测试设计 | `testCases.length >= 6` |
| 3 | 风险评估 | `risk.risks.length > 0` |
| 4 | 智能选择 | `selection.selectedCases > 0` |
| 5 | 覆盖分析 | `coverage.dimensions.length > 0` |
| 6 | 数据准备 | `dataPlan` 已定义 |
| 7 | 执行 | `outcome.executed === true`，`failed >= 3` |
| 8 | 结果分析 | `report.findings.length > 0` |
| 9 | 根因分析 | `rcas.length >= 3`，含 TIMEOUT / BILLING_ERROR，confidence > 0 |
| 10 | 缺陷草稿 | `defects.length >= 3`，全部 DRAFT |
| 11 | 自愈建议 | SUGGESTED，`data.videos.list → data.videos.items` |
| 12 | 分级审批 | `approvals.length >= 3`，审计日志完整 |
| 13 | 记忆写入 | 持久化：execution + 3 条 failure |
| 14 | 观测 Trace | `spans.length >= 10`，含 root-cause / approval |
| 15 | 预算控制 | `budgetStatus.exceededAny === false`，退出码 = 3（含超时） |

另含安全联动用例：生产环境拒绝 `sys.exec`（dangerous）。

---

## 6. 测试与验收汇总

| 验收项 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `npm run build` | 通过（NodeNext ESM，0 错误） |
| 单元/集成 | `npm test` | 36 文件 587 用例全部通过 |
| 覆盖率 | `npm run test:coverage` | 语句 88.61% / 分支 76.3% / 函数 91.53% / 行 90.44% |
| Agent 测试 | `npm run agent:test` | 26 文件 352 用例全部通过 |
| 评测 | `npm run agent:eval` | Requirement 88 / RCA 100 / Healing 100 / Defect 100 / Risk 100 / **Overall 97**，回退率 0.5，幻觉率 0 |
| 端到端 | `npm run agent:e2e` | 15 步闭环全部通过（含安全边界联动） |

### 测试数量演进

556（Phase 13 末）→ 564（Phase 18 +8）→ 571（Memory 知识 +7）→ 576（Pipeline 增强 +5）→ 585（安全边界 +9）→ **587**（e2e +2）。

---

## 7. 与任务书约束对照

- 不推翻 Phase 1-9，增量扩展：核心流水线 7 阶段原样保留，新能力以可选增强阶段注入。
- 禁止重新实现 Assertion/Data Factory/Execution Engine/Report：全部复用 Core/Pipeline/Tool Registry。
- LLM 安全边界：不直接执行系统命令（Tool 权限层拦截）、默认修改源码/创建正式缺陷/生产高风险测试均经 Approval（DRAFT/SUGGESTED/pending）。
- 统一 JSON Schema + MockLLM + Deterministic Fallback + Approval/Audit/Resume/Memory/Evaluation/Trace/Budget：全部落地并通过验收。
- 确定性优先：规则引擎负责确定性结果（分类/严重度/审批分级），AI 负责复杂解释，LLM 空输出自动回退规则。
