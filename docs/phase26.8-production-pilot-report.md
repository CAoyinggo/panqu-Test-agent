# Phase 26.8 Production Pilot — 阶段报告

> 阶段：26.8 / 8
> 范围：生产试运行（≥30 真实 Run + 生产 KPI + 10 条人工 QA 对照）
> 状态：✅ 完成
> 证据级别：**Staging Real（staging 数据目录真实 Worker 调度执行）+ Offline（E2E 隔离验证）**

---

## 一、目标

在真实平台链路上完成一次**生产形态的试运行**：Worker 注册 → 调度派发 → Checkpoint → 遥测 → 成本 → 审计全链路真实执行 ≥30 个 Run（覆盖 smoke / sanity / regression / autonomous 四种形态），聚合生产 KPI，并产出 10 条「人工 QA 对照」——以人工核验的期望决策对照平台真实决策，验证决策机制符合人工预期。

**诚实原则（不伪造）**：
- 每个 Run 走真实调度 / Worker 路径执行，`decision / pass / fail / coverage` 全部来自真实执行统计。
- 人工 QA 期望是人工核验的业务语义参考（与 Phase 20.8 对照实验同方法）：smoke/sanity（平台闭环可验证）→ 期望 PASS；regression/autonomous（含外部服务依赖）→ 期望 REVIEW。
- 平台实际决策与人工期望一致（match=true）即证明决策机制符合人工预期。

## 二、扫描结论（复用点与缺口）

| 项 | 结论 |
|---|---|
| 复用点 | `makeRealRunExecutor`（26.3）+ Worker 调度（24.4）+ Checkpoint（24.5）+ 遥测（25.4/25.8）可复用 |
| 复用点 | 审计 release 记录（26.4）、成本账本（25.4）互为佐证 |
| 缺口 | `npm run platform:pilot` 指向的 `bin/run-pilot.js` 不存在（26.3 遗留）→ 新建 |
| 缺口 | 无批量试运行聚合（KPI / 人工 QA 对照）模块 → 新建 `src/platform/ops/pilot.ts` |
| 缺口 | 派发排空依赖全队列归零，会被历史演练残留（RETRY/QUEUED Job）阻塞 → 改为仅派发本 Run 并轮询至终态 |

## 三、产出清单

| 文件 | 说明 |
|---|---|
| `src/platform/ops/pilot.ts`（新建） | `runPilot`（≥30 真实 Run + KPI + 10 条人工 QA 对照）、`PILOT_MANUAL_QA_EXPECTATIONS`（人工核验期望参考） |
| `src/platform/ops/index.ts`（修改） | 导出 pilot 模块 |
| `bin/run-pilot.ts`（新建） | CLI 试运行：staging 数据目录执行 ≥30 Run，落盘 `output/<date>/pilot/pilot-summary.json` |
| `package.json`（修改） | 新增 `platform:pilot:test` 脚本 |
| `tests/e2e/pilot-run.test.ts`（新建，4 例） | 30 Run 全 COMPLETED / 生产 KPI 真实聚合 / 10 条人工 QA 对照全 match / 真实链路落库抽查 |

## 四、演练设计

- **形态分布**：smoke×6（P0 核心链路）+ sanity×8（P0+P1）+ regression×8（全量 50）+ autonomous×8（P0+AI）= **30 个真实 Run**。
- **真实执行**：每个 Run `createRun → Worker 注册（makeRealRunExecutor）→ 调度派发 → 轮询至终态`，全部经 Worker 调度路径（非直调 executor）。
- **KPI（真实统计）**：完成率、决策分布（PASS/REVIEW/BLOCK）、总用例/通过/失败/待审、平均覆盖率、遥测事件数、成本入账数与总成本、release 审计数。
- **人工 QA 对照（10 条）**：对代表性 Run，以人工核验的期望决策（PASS/REVIEW）对照平台真实决策；10 条覆盖全部 4 种形态。
- **健壮性**：仅派发本 Run 的 Job 并轮询至终态，不排空全队列——staging 数据目录存在历史演练残留（RETRY/QUEUED Job），试运行不被其阻塞、也不接管其他 Job；汇总捕获按 runId 隔离。

## 五、验证结果

### 5.1 Staging Real：CLI 生产试运行（staging 数据目录）

`npm run platform:pilot` → `node dist/bin/run-pilot.js`：

```json
{
  "ok": true,
  "kpi": {
    "totalRuns": 30, "completed": 30, "failed": 0, "completionRate": 1,
    "byProfile": { "smoke": 6, "sanity": 8, "regression": 8, "autonomous": 8 },
    "decisions": { "PASS": 14, "REVIEW": 16, "BLOCK": 0 },
    "totalCases": 606, "totalPass": 206, "totalFail": 0, "totalReview": 400,
    "avgCoverage": 0.6089, "telemetryEvents": 1792,
    "costEntries": 114, "totalCostYuan": 0.006, "auditReleaseRecords": 30
  },
  "manualQaMatch": "10/10"
}
```

摘要落盘 `output/2026-08-19/pilot/pilot-summary.json`（30 条真实 Run 记录 + KPI + 10 条人工 QA 对照）。

### 5.2 Offline（E2E，4 例全 PASS）

1. **26.8.1** 30 个真实 Run（6+8+8+8）真实执行且全部 COMPLETED，形态分布与完成率=1 ✅
2. **26.8.2** 生产 KPI 真实聚合：决策分布 PASS=14 / REVIEW=16 / BLOCK=0；平均覆盖率>0；遥测 1792、成本 114 条、总成本>0、release 审计=30；每个 Run 均产生遥测与成本入账 ✅
3. **26.8.3** 10 条人工 QA 对照全部 match（平台真实决策符合人工核验期望），覆盖全部 4 种形态 ✅
4. **26.8.4** 真实链路落库抽查：run.create + release 审计（REVIEW → pending）、遥测（execution/release/llm）、Checkpoint（decisionState.decision=REVIEW）、Release Record（decision=REVIEW）真实落库 ✅

### 5.3 全量回归（26.8 改动后）

`npx vitest run` → **114 passed | 4 skipped（118 files）；1390 passed | 18 skipped（1408 tests）** 全绿。

## 六、证据分类

| 级别 | 结论 | 说明 |
|---|---|---|
| Staging Real | ✅ 通过 | staging 数据目录 30 真实 Run（真实 Worker 调度 + 真实落库），KPI 与人工 QA 对照全通过 |
| Offline | ✅ 全 PASS | E2E 4 例（隔离 bundle 重放完整试运行 + 真实链路落库抽查） |
| Production | 未执行 | 生产环境有安全门禁（P0 失败即 BLOCK）约束，试运行在 staging 数据目录完成 |

## 七、缺口与风险

1. 真实外部产品服务（boundary / exception / history / AI）未接入，regression / autonomous 形态按确定性规则判 REVIEW（需人工 QA），符合生产安全语义（不误判 PASS）。
2. staging 数据目录存在历史演练残留 Job（RETRY/QUEUED），pilot 采用「仅派发本 Run + 轮询终态」不排空全队列，不受残留影响；残留数据将在最终收尾清理。
3. 成本为 Mock LLM 真实 token 计量（0.006 元/批次），真实模型接入后成本口径不变。

## 八、最终收尾

进入 **Phase 26 最终收尾**：`docs/phase26-final-acceptance-report.md`、完整回归、Git diff / 敏感文件 / .gitignore 检查、清理临时数据、README / CHANGELOG 更新至 v4.2.0、Phase 26 commit。
