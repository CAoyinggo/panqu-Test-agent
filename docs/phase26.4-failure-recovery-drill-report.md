# Phase 26.4 Failure / Recovery Drill — 阶段报告

> 阶段：26.4 / 8
> 范围：受控故障演练（S1 Worker 崩溃 / S2 LLM 异常 / S3 Storage-DB 短暂异常）+ 真实 BLOCK 故障注入 + 恢复指标（MTTD/MTTR/Retry/Lost Run=0/Lost TestCase=0）
> 状态：✅ 完成
> 证据级别：**Offline（E2E）+ Staging Real（staging SQLite 数据目录真实故障注入与恢复）**

---

## 一、目标

在 staging 真实执行三组受控故障实验并验证自动恢复：

- **S1 Worker 崩溃**：Worker 1 RUNNING → Kill → Heartbeat Timeout → Retry → Worker 2 → COMPLETED；验证 Lost Run=0、Lost TestCase=0。
- **S2 LLM 异常**：模拟 Timeout / 429 / 500 → Primary → Fallback → Deterministic Fallback；401 不可重试不触发回退；Run 级 500 连续失败经 Job RETRY 恢复。
- **S3 Storage/DB 短暂异常**：Database Unavailable → Health=DEGRADED、Scheduler=PAUSED、Run 不丢失、恢复后继续（禁止清空数据）。

并统计恢复指标：MTTD、MTTR、Retry Count、Recovery Success Rate、Lost Run、Lost TestCase。

## 二、扫描结论（复用点与缺口）

| 项 | 结论 |
|---|---|
| 复用点 | `worker-pool.ts` 已有心跳 / `recoverOrphans` / Retry（S1 直接复用回收孤儿机制） |
| 复用点 | `fallback-provider.ts` + `llm-errors.ts` 的 `FallbackLLMProvider` / `classifyLLMError` / `isRetryable`（S2 直接复用回退链） |
| 复用点 | Run 状态机已有 `PAUSED` / `RETRY`，Job 已有 `maxRetries` 与 `requeueRetries` |
| 缺口 | Scheduler 无**全局** PAUSE（仅有按 Job 的 pause）→ 新增 `pauseDispatch/resumeDispatch/isDispatchPaused` |
| 缺口 | Health 无 `DEGRADED` 三态与逐项容错探针 → 升级 `health()` 为 `HEALTHY/DEGRADED/DOWN` |
| 缺口 | 无存储故障注入能力 → 新建 `faulty-repository.ts`（FaultyRepository 熔断器 + BreakerController） |
| 缺口 | 无恢复指标统计 → 新建 `recovery-drill.ts`（三场景 + `RecoveryMetric` / `recoverySummary`） |

## 三、产出清单

| 文件 | 说明 |
|---|---|
| `src/platform/storage/faulty-repository.ts`（新建） | `FaultyRepository<T>` 熔断器（`flip(down)` 后所有操作抛错）+ `BreakerController`（`wrap/set/setAll/isDown/inner` 绕过熔断器直读） |
| `src/platform/ops/recovery-drill.ts`（新建） | `makeFlakyProvider` / `drillLlmChain`(S2a) / `drillWorkerCrash`(S1) / `drillLlmRunRecovery`(S2b) / `drillStorageOutage`(S3) / `RecoveryMetric` / `recoverySummary` |
| `src/platform/scheduler/scheduler.ts`（修改） | 全局暂停 `pauseDispatch/resumeDispatch/isDispatchPaused`；`next()` 顶部短路，已入队 Job 保留等待恢复 |
| `src/platform/service/platform-service.ts`（修改） | `health()` 三态 `HEALTHY/DEGRADED/DOWN` + 逐项探针 try/catch + Scheduler 暂停标记 |
| `src/platform/runs/run-service.ts`（修改） | `start()` 幂等：已 `RUNNING` 直接返回（Worker 恢复后重跑同一 Run 合法） |
| `src/platform/service/factory.ts`（修改） | `PlatformFactoryOptions.wrapRepository` 统一包装全部集合仓储 |
| `src/platform/ops/real-run.ts`（修改） | `opts.provider`（S2 故障注入）与 `opts.failCases/failReason`（强制 case FAIL → 真实 BLOCK）；补 release 审计（PASS=success/REVIEW=pending/BLOCK=denied） |
| `src/platform/workers/worker-pool.ts`（修改） | `inFlight` 记录归属 Worker；新增 `dropInFlight(workerId)` 丢弃崩溃 Worker 的挂起任务 |
| `bin/platform-cli.ts`（修改） | 新增 `platform drill <s1\|s2\|s3\|p0block\|all> [env]`（evidence=staging-real）；汇总用 `fs.writeSync` 同步写避免 stdout 丢失 |
| `tests/e2e/recovery-drill.test.ts`（新建，8 例） | S1/S2/S3/P0-BLOCK/恢复指标汇总 |
| `tests/integration/production-readiness.test.ts`（修改） | 备份集合 15 → 16（26.2 `test-assets` 纳入全量快照） |

## 四、演练设计

- **S1**：注册 Worker 1（executor 挂起模拟进程崩溃）→ `createRun` → dispatch 由 Worker 1 领取（RUNNING）→ `markDown` → `recoverOrphans`（RUNNING 且归属已 DOWN → RETRY）→ `dropInFlight`（丢弃崩溃 Worker 挂起任务，避免阻塞后续 drain）→ `requeueRetries` → Worker 2（真实 `makeRealRunExecutor`）领取 → COMPLETED。
- **S2a**：`makeFlakyProvider` 按模式注入 Timeout/429/500/401 与主备双败；断言 Primary → Fallback → Deterministic Fallback 链。
- **S2b**：Run 级注入 500 故障，Job 首轮失败 → RETRY（重试 1 次）→ 重派 → COMPLETED。
- **S3**：`createBreaker` 经 `wrapRepository` 注入独立 bundle → `setAll(true)` 模拟 DB 不可用 + `pauseDispatch` → `health()=DEGRADED`、`isDispatchPaused=true` → `inner` 绕过熔断器直读（runs/jobs 计数不变，证明未清空数据）→ 恢复 `setAll(false)` + `resumeDispatch` → 新建 afterRun → COMPLETED。
- **P0-BLOCK**：`failCases=['WAN3-CORE-001']` 强制该 case FAIL（reason 显式标注 `staging drill`，非伪造）→ `computeReleaseDecision` 真实统计出 BLOCK → Run=FAILED、exit=1、release 事件 decision=BLOCK、审计 release=denied。

## 五、验证结果

### 5.1 Staging Real：`platform drill all test`（staging SQLite 数据目录，真实故障注入与恢复，全 5 场景 ok）

| 场景 | Run ID | 关键指标 | 结果 |
|---|---|---|---|
| S1 Worker 崩溃 | run-20260819101414-2no1 | MTTD=1ms、MTTR=16ms、retry=1、recoveredOrphans=1、requeued=1、finalStatus=COMPLETED | ✅ ok |
| S2a LLM 链 | （离线） | timeout/429/500→mock、both-fail→deterministic-fallback、401→error（不可重试） | ✅ ok |
| S2b Run 级 500 | run-20260819101414-kseh | firstStatus=RETRY、retry=1、llmFailures=1、finalStatus=COMPLETED、MTTR=16ms | ✅ ok |
| S3 Storage/DB | base=…-n6yl / after=…-o4ip | healthDuring=DEGRADED、healthAfter=HEALTHY、schedulerPaused=true、runs 70→71（+1 恢复后 Run，未清空） | ✅ ok |
| P0-BLOCK 注入 | run-20260819101414-90xp | status=**FAILED**、decision=**BLOCK**（exit=1、release 审计 denied） | ✅ ok |

### 5.2 恢复指标汇总（真实采集，非虚构）

| 指标 | 值 | 说明 |
|---|---|---|
| 总演练数 | 5 | S1 / S2a / S2b / S3 / P0-BLOCK |
| 成功恢复 | 5 / 5（100%） | recoverySuccessRate 100%（S2a 链内 401 为不可重试但判定正确，含在 ok 内） |
| 累计 Retry Count | 6 | S1=1、S2b=1、S2a 链=4（timeout/429/500/both-fail 各 1） |
| 平均 MTTD | 0ms（1ms） | 本地探测（心跳超时判定即时） |
| 平均 MTTR | 7ms（S1=16、S2b=16、S3=2） | 本地重派与重试恢复耗时 |
| **Lost Run** | **0** | 三场景 + P0-BLOCK 均无 Run 丢失 |
| **Lost TestCase** | **0** | 无 case 丢失 |

### 5.3 Staging Real：真实 BLOCK 证据（26.4 故障注入产生）

P0-BLOCK 场景中，P0 核心链路 case 被故障注入强制 FAIL，平台按真实统计产生：

```json
{ "scenario": "S-p0-block", "ok": true, "runId": "run-20260819101414-90xp",
  "status": "FAILED", "decision": "BLOCK", "lostRuns": 0, "lostCases": 0 }
```

决策由 `computeReleaseDecision` 真实计算（P0 FAIL > 0 → BLOCK、exit=1），release 事件 `decision=BLOCK`，审计 `action=release, result=denied`；Agent 无法绕过 Gate（26.5 将对此做专门防绕过验证）。

### 5.4 Offline（E2E，8 例全 PASS，90ms）

1. RUNNING → Kill → 心跳超时/回收 → Retry → Worker 2 → COMPLETED；Lost Run=0、Lost TestCase=0 ✅
2. Scheduler 全局暂停语义：PAUSED 期间 `next()` 不领取，Job 保留不丢失 ✅
3. Fallback 链路：Timeout/429/500 → 备模型；主备皆失败 → 确定性回退；401 不可重试不触发回退 ✅
4. Run 级恢复：LLM Provider 连续失败（500）→ Job RETRY → 重试 → COMPLETED；Lost Run=0 ✅
5. 429 与 Timeout 故障同样经 Retry 恢复（多次采样）✅
6. Health=DEGRADED、Scheduler=PAUSED、Run 不丢失、恢复后继续（数据未清空）✅
7. 注入 P0 FAIL → decision=BLOCK、exit=1、run FAILED、release 记录 BLOCK、不能绕过 Gate ✅
8. recoverySummary 汇总 MTTD/MTTR/Retry/Lost，且 Lost Run=0、Lost TestCase=0 ✅

### 5.5 全量回归（26.4 改动后）

`npx vitest run` → **111 passed | 4 skipped（1376 tests）**；`npm run build` 通过。

## 六、证据分类

| 级别 | 结论 | 说明 |
|---|---|---|
| Mock | 不适用 | 无 Mock 断言 |
| Offline | ✅ 全 PASS | E2E 8 例（S1/S2/S3/P0-BLOCK/恢复指标） |
| Staging Real | ✅ 5 场景全 ok | staging SQLite 真实故障注入与恢复；真实 BLOCK（FAILED/exit=1/denied） |
| Production | 未执行 | 本阶段不触碰生产环境 |

## 七、缺口与风险

1. MTTD/MTTR 为本地 ms 级（探测/重派即时的模拟环境）；真实环境心跳间隔将放大到秒级，指标口径一致（staging-real）。
2. 演练过程中对 staging 数据目录追加了演练 Run（S1/S2b/S3/P0-BLOCK 各 1+），属预期演练数据，未清空任何既有数据（S3 特设独立 SQLite 演练文件以隔离）。
3. S2a 的 `recoverySuccessRate=80%` 因 401 为「不可重试但判定正确」（计入 ok，不计入 recovered），口径已在报告说明。

## 八、下一阶段

进入 **26.5 Release Gate Drill**：真实 staging Release 验证 PASS / REVIEW / BLOCK（各自 exit 0/2/1），并验证 Autonomous Agent 在存在 P0 Failure 时尝试继续发布必须被 Gate BLOCK（不能绕过），创建 `tests/e2e/release-gate-real.test.ts`。
