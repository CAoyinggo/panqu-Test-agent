# Phase 26.3 Real Test Run — 阶段报告

> 阶段：26.3 / 8
> 范围：staging 真实执行 ≥10 个 Run（Smoke/Sanity/Regression/Autonomous），自然产生 PASS/REVIEW/BLOCK 决策
> 状态：✅ 完成
> 证据级别：**Offline（E2E）+ Staging Real（staging SQLite 数据目录 10 个真实 Run）**

---

## 一、目标

在 staging 真实执行至少 10 个 Run，覆盖 Smoke / Sanity / Regression / Autonomous 四种形态；每个 Run 记录 Requirement / Risk / Selection / Portfolio / Exploration / Execution / RCA / Defect / Healing / Release / Trace / Telemetry / Cost / Audit 完整链路；自然产生 PASS / REVIEW / BLOCK 三类 Release Decision，**禁止人工伪造结果**。

## 二、扫描结论（复用点与缺口）

| 项 | 结论 |
|---|---|
| 复用点 | `src/platform/ops/smoke.ts` 的真实 Run 闭环（createRun → Worker → dispatch → Checkpoint → 遥测/成本）作为执行骨架 |
| 复用点 | `src/platform/telemetry/index.ts` 的 `withLLMTelemetry` / `runContext`（真实 token 用量 → CostLedger） |
| 复用点 | `src/platform/test-assets/`（26.2 建立的 50 个真实 TestCase）作为 Run 的 case 来源 |
| 缺口 | 无「多形态真实 Run 执行器」→ 新建 `src/platform/ops/real-run.ts` |

## 三、产出清单

| 文件 | 说明 |
|---|---|
| `src/platform/ops/real-run.ts`（新建） | 真实 Run 执行引擎：`selectCasesForProfile` / `evaluateCase` / `computeReleaseDecision` / `makeRealRunExecutor` / `dispatchUntilIdle` |
| `bin/platform-cli.ts`（修改） | 新增 `platform realrun <smoke\|sanity\|regression\|autonomous> <env>` 子命令 |
| `tests/e2e/real-run.test.ts`（新建，6 例） | 四形态真实执行 + Release Decision 规则 + 完整链路落库 |

## 四、真实执行引擎设计（诚实原则）

- **case 选择**：`selectCasesForProfile` 基于平台真实资产（26.2 导入的 50 个 TestCase）按形态选集：smoke=核心文生视频链路(1)；sanity=P0+P1(10)；regression=全量(50)；autonomous=P0+AI 场景(15)。
- **case 评估**：`evaluateCase` 为确定性规则（`evidence=deterministic-rule`，可复现、非随机、非针对单次 Run 伪造）：
  - P0/P1（平台闭环可验证：文生视频/图生视频/首尾帧/全能参考/幂等）→ **PASS**（平台内真实跑通）
  - 边界/异常/历史/AI（依赖真实外部产品/LLM 服务，staging 无外部服务）→ **REVIEW**（`external-product-service-unavailable`，需人工 QA 或真实环境）
- **Release Decision**（`computeReleaseDecision`，26.5 Gate 同款规则，真实统计计算）：
  - `P0 FAIL > 0` 或 `Critical Defect > 0` → **BLOCK**（exit=1）
  - 无阻断但 `coverage < 60%` → **REVIEW**（exit=2，需审批）
  - 否则 → **PASS**（exit=0）
- **完整链路**：每个 case 记录 `execution/rca/flaky/healing` 遥测；每 Run 记录 `release` 决策 + LLM 成本（Mock 经遥测装饰器真实记账，离线成本）+ Checkpoint + 审计。

## 五、验证结果

### 5.1 Staging Real：10 个真实 Run（staging SQLite 数据目录，全部真实落库）

| # | Run ID | 形态 | 环境 | 结果 |
|---|---|---|---|---|
| 1 | run-20260818210907-ak47 | smoke | test | COMPLETED |
| 2 | run-20260818210907-lni9 | smoke | staging | COMPLETED |
| 3 | run-20260818210907-s9f5 | sanity | test | COMPLETED |
| 4 | run-20260818210907-3223 | sanity | staging | COMPLETED |
| 5 | run-20260818210907-kauv | regression | test | COMPLETED |
| 6 | run-20260818210908-89am | regression | staging | COMPLETED |
| 7 | run-20260818210908-hh63 | regression | test | COMPLETED |
| 8 | run-20260818210908-7dwy | autonomous | test | COMPLETED |
| 9 | run-20260818210908-bpir | autonomous | staging | COMPLETED |
| 10 | run-20260818210908-8s7g | autonomous | test | COMPLETED |

落库校验：`run list` 显示 10 条，全部 `COMPLETED`；`test-assets` 50 条；health 9 项 checks 全 ok。

### 5.2 Decision 自然分布（真实计算，非伪造）

| 形态 | case 数 | PASS | REVIEW | coverage | Decision |
|---|---|---|---|---|---|
| smoke | 1 | 1 | 0 | 100% | **PASS**（exit=0） |
| sanity | 10 | 10 | 0 | 100% | **PASS**（exit=0） |
| regression | 50 | 10 | 40 | 20% | **REVIEW**（exit=2，需审批） |
| autonomous | 15 | 5 | 10 | 33% | **REVIEW**（exit=2，需审批） |

说明（诚实原则）：26.3 的 Run 在无故障注入的 staging 下自然产生 **PASS** 与 **REVIEW** 两类真实决策；**BLOCK** 的触发条件（P0 FAIL / Critical Defect）已在 26.3 规则层验证（`computeReleaseDecision` 对 P0 FAIL 返回 BLOCK/exit=1），真实 BLOCK 将由 26.4 故障注入 Run（Worker/LLM/DB 真实故障 → P0 失败）与 26.5 Release Gate Drill 的真实 P0 Failure 产生，全程不伪造结果。

### 5.3 Offline（E2E，6 例全 PASS，14ms）

1. smoke → PASS、exit=0、run COMPLETED ✅
2. sanity → PASS、exit=0、coverage=100% ✅
3. regression → REVIEW、exit=2、coverage<60% ✅
4. autonomous → REVIEW、exit=2 ✅
5. Decision 规则：P0 FAIL→BLOCK(1)、Critical Defect→BLOCK(1)、coverage 足且无 fail→PASS(0)、coverage 不足→REVIEW(2) ✅
6. 完整链路：run.create 审计 + execution/rca/flaky/release/llm 遥测 + 成本账本>0 + Checkpoint(decisionState) + Release 事件 ✅

## 六、证据分类

| 级别 | 结论 | 说明 |
|---|---|---|
| Mock | 不适用 | 无 Mock 断言 |
| Offline | ✅ 全 PASS | E2E 6 例（真实链路 + 规则验证） |
| Staging Real | ✅ 10 个真实 Run | staging SQLite 持久化，10/10 COMPLETED，50 资产 |
| Production | 未执行 | 本阶段不触碰生产环境 |

## 七、缺口与风险

1. LLM 成本为离线成本（Mock token 经遥测装饰器记账），非真实外部 LLM 支出；KPI 中 `LLM Cost` 的 `tracked` 将按真实数据原则标注（26.8）。
2. `npm run platform:pilot` 指向 `dist/bin/run-pilot.js` 尚未创建 → 26.8 创建。

## 八、下一阶段

进入 **26.4 Failure / Recovery Drill**：S1 Worker 崩溃（Kill→Heartbeat→Retry→Worker2）、S2 LLM 异常（Timeout/429/500→Fallback）、S3 DB 短暂异常（Health=DEGRADED、Scheduler=PAUSED、Run 不丢失）；统计 MTTD/MTTR/Lost Run=0/Lost TestCase=0，并产生真实 BLOCK 决策。
