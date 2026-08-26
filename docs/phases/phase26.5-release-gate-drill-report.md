# Phase 26.5 Release Gate Drill — 阶段报告

> 阶段：26.5 / 8
> 范围：真实发布门禁演练（PASS / REVIEW / BLOCK）+ Autonomous Agent 防绕过验证
> 状态：✅ 完成
> 证据级别：**Offline（E2E）+ Staging Real（staging SQLite 数据目录真实执行与决策）**

---

## 一、目标

在 staging 真实执行发布门禁并验证三类决策与防绕过：

- **PASS（exit=0）**：P0 全 PASS、无 Critical Defect、coverage ≥ 60% → 允许部署（Deployment EXECUTED）。
- **REVIEW（exit=2）**：coverage < 门槛存在风险 → 创建人工审批（Approval Required），未批准不部署；批准后才允许部署。
- **BLOCK（exit=1）**：P0 FAIL / Critical Defect → CI FAILED、Deployment NOT EXECUTED。
- **防绕过验证**：Autonomous Agent 在存在 P0 Failure 时尝试继续发布 → Release Gate 必须拦截（不能绕过），审计记录 denied。

决策由真实执行统计（`computeReleaseDecision` 同款规则，evidence=deterministic-rule）计算；BLOCK 由故障注入真实触发（reason 显式标注 drill，非伪造）。

## 二、扫描结论（复用点与缺口）

| 项 | 结论 |
|---|---|
| 复用点 | `real-run.ts` 已有 `computeReleaseDecision` / `makeRealRunExecutor` / `RELEASE_COVERAGE_THRESHOLD=0.6`（26.3 产出，Gate 规则同源） |
| 复用点 | `approval-center.ts` 已有 `request/approve/reject` 审批流（REVIEW 场景复用） |
| 复用点 | `real-run.ts` 已记录 release 审计（PASS=success/REVIEW=pending/BLOCK=denied，26.4 补齐） |
| 缺口 | 无统一发布门禁入口 → 新建 `enforceReleaseGate`（Agent / 用户 / 平台统一走此入口，不可绕过） |
| 缺口 | 无真实 Gate 演练编排与汇总 → 新建 `release-gate-drill.ts`（`runReleaseGateDrill` + `gateDrillSummary`） |
| 缺口 | CLI 无 Gate 演练命令 → 新增 `platform gate <pass\|review\|block\|all> [env]` |

## 三、产出清单

| 文件 | 说明 |
|---|---|
| `src/platform/ops/release-gate-drill.ts`（新建） | `enforceReleaseGate`（统一 Gate 入口）、`runReleaseGateDrill`（真实 Run → 真实决策 → 执行 Gate/审批/部署）、`gateDrillSummary` |
| `src/platform/ops/index.ts`（修改） | 导出 `./release-gate-drill.js` |
| `bin/platform-cli.ts`（修改） | 新增 `platform gate <pass\|review\|block\|all> [env]`（evidence=staging-real；汇总 `fs.writeSync` 同步写） |
| `tests/e2e/release-gate-real.test.ts`（新建，8 例） | GATE-PASS / GATE-REVIEW / GATE-REVIEW-APPROVED / GATE-BLOCK / 规则层 / 汇总 |

## 四、演练设计

- **GATE-PASS**：sanity 形态真实 Run（P0+P1 平台闭环 10 case 全 PASS）→ coverage=1 ≥ 60% → decision=PASS、exit=0 → Gate 允许 → Deployment EXECUTED。
- **GATE-REVIEW**：regression 形态真实 Run（全量 50 case，10 闭环 PASS + 40 外部依赖 REVIEW）→ coverage=0.2 < 60% → decision=REVIEW、exit=2 → 创建人工审批（PENDING）→ 未批准不部署；Agent 绕过被拦截。附加 `approveReview=true` 分支验证「批准后可部署」。
- **GATE-BLOCK**：sanity + `failCases=['WAN3-CORE-001']` 故障注入强制 P0 核心链路 FAIL（reason 显式标注 drill）→ `computeReleaseDecision` 真实统计 P0 FAIL=1 → decision=BLOCK、exit=1 → CI FAILED、Deployment NOT EXECUTED；Autonomous Agent 尝试绕过仍被 Gate 拦截，审计 record release=denied（bypassAttempted=true）。
- **防绕过**：所有决策都经过同一 `enforceReleaseGate` 入口；BLOCK / 未批准 REVIEW 均 `allowed=false`，无论调用方身份（agent / user / 平台）。

## 五、验证结果

### 5.1 Staging Real：`platform gate all test`（staging SQLite 数据目录，真实执行与决策）

| 场景 | Run ID | 决策/Exit | 统计 | 审批 | 部署 | 防绕过 |
|---|---|---|---|---|---|---|
| GATE-sanity | run-20260819102226-w4jn | PASS / 0 | pass=10、coverage=1、p0Fail=0 | 无需 | ✅ EXECUTED | 不适用（PASS） |
| GATE-regression | run-20260819102226-mwo1 | REVIEW / 2 | pass=10、review=40、coverage=0.2 | approval-mszguw3g-x6ew（PENDING） | ❌ NOT EXECUTED（未批准） | ✅ 拦截（deniedCount=1） |
| GATE-sanity-BLOCK | run-20260819102226-b8gk | BLOCK / 1 | pass=9、fail=1、p0Fail=1 | 无需 | ❌ CI FAILED / NOT EXECUTED | ✅ 拦截（deniedCount=2） |

### 5.2 Staging Real：汇总（真实采集，非虚构）

```json
{ "ok": true, "summary": {
  "total": 3, "pass": 1, "review": 1, "block": 1,
  "deploymentNotExecuted": 2, "bypassBlocked": 2, "allPass": true } }
```

### 5.3 Staging Real：真实 BLOCK 证据

P0 核心链路 case 故障注入强制 FAIL → 平台按真实统计产生 BLOCK，且 **Autonomous Agent 尝试绕过被 Gate 拦截**：

```json
{ "scenario": "GATE-sanity-BLOCK", "decision": "BLOCK", "exitCode": 1,
  "p0Fail": 1, "deployment": { "executed": false,
    "reason": "Release Gate：decision=BLOCK（exit=1）→ CI FAILED，Deployment NOT EXECUTED（test）" },
  "bypassBlocked": true, "audit": { "result": "denied", "deniedCount": 2 } }
```

denied 审计含两层：`real-run` 的 release=denied（决策拒绝）与 `autonomous-agent` 绕过尝试的 release=denied（bypassAttempted=true），共同证明 Agent 不能绕过 Gate。

### 5.4 Offline（E2E，8 例全 PASS，27ms）

1. GATE-PASS：sanity → PASS、exit=0、Deployment EXECUTED、无审批、bypass 不适用 ✅
2. GATE-REVIEW：regression → REVIEW、exit=2、Approval PENDING、未批准不部署、Agent 不能绕过 ✅
3. GATE-REVIEW-APPROVED：批准后 → Deployment EXECUTED（人工审批通过才能发布）✅
4. GATE-BLOCK：故障注入 P0 FAIL → BLOCK、exit=1、CI FAILED、Deployment NOT EXECUTED、Agent 不能绕过、deniedCount≥2 ✅
5. 规则层：BLOCK 无论审批状态都禁止；REVIEW 仅 APPROVED 允许；PASS 允许 ✅
6. gateDrillSummary：PASS/REVIEW/BLOCK 组合 → 计数正确、allPass=true ✅

### 5.5 全量回归（26.5 改动后）

`npx vitest run` → **111 passed | 4 skipped（1376 tests）**；`npm run build` 通过。

## 六、证据分类

| 级别 | 结论 | 说明 |
|---|---|---|
| Mock | 不适用 | 无 Mock 断言 |
| Offline | ✅ 全 PASS | E2E 8 例（PASS/REVIEW/REVIEW-APPROVED/BLOCK/规则/汇总） |
| Staging Real | ✅ 3 场景全 ok | staging SQLite 真实 Run → 真实决策 → 审批/部署/拦截；真实 BLOCK（FAILED/exit=1/NOT EXECUTED） |
| Production | 未执行 | 本阶段不触碰生产环境 |

## 七、缺口与风险

1. REVIEW 的审批为「人工审批流程已接通」，批准动作在演练中由 `approveReview` 触发（qa-lead）；真实环境应由人工在 Approval Center 决策，流程一致。
2. BLOCK 由故障注入（failCases 强制 case FAIL）驱动，reason 显式标注 `release gate drill` 保证可审计；正常无注入时 sanity 决策为 PASS。
3. 演练对 staging 数据目录追加了 3 个 Gate Run 与 1 个 PENDING 审批，属预期演练数据（后续 26.8 Pilot 前的临时数据清理阶段一并处理）。

## 八、下一阶段

进入 **26.6 Backup / Restore Drill**：真实演练备份（Count/Checksum/Key ID 一致）与恢复（Restore 后禁止自动重触发），创建 `tests/e2e/backup-restore-real.test.ts`。
