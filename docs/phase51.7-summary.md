# Phase 51.7：Disaster / Recovery

> 日期：2026-08-21｜所有故障均为明确标注的 SIMULATED failure；恢复逻辑执行为 REAL code path

## Audit

51.3 lease 能处理单个 worker down，但 Evaluation 内部没有按 case checkpoint；进程终止后只能重跑整个报告。Ground Truth 或 Benchmark 不可用时也缺少统一 PAUSED/BLOCKED 语义。

## Implement

- `RecoveryCoordinator` 统一 STORAGE、WORKER、QUEUE、TELEMETRY、BENCHMARK、GROUND_TRUTH 的 Detect → Alert → Recover 状态和 recovery rate。
- `EvaluationCheckpoint` 固定 job/project、all/completed/remaining cases、Benchmark checksum、Ground Truth version 和状态。
- 每完成一个 case 即保存 checkpoint；恢复只遍历 remaining，完成 case 不重复执行。
- Ground Truth unavailable → PAUSED，明确禁止 stale fallback；恢复后继续。
- Benchmark unhealthy → BLOCKED；v11 corruption 可定位最近健康 v10 rollback target。
- 恢复期间 Benchmark checksum 或 GT version 改变 → BLOCK，避免同一个 Evaluation 混用两份真值。
- Queue snapshot 中的 RUNNING lease 恢复时失效，原 job ID requeue；旧 worker late completion 继续被拒绝。

## Recovery Matrix

| Failure | Detect/Alert | Safe state | Recover/Resume |
| --- | --- | --- | --- |
| Storage | yes | PAUSED | yes |
| Worker / process kill | yes | PAUSED + checkpoint | resume remaining only |
| Queue | yes | PAUSED / RUNNING requeue | yes |
| Telemetry | yes | PAUSED | yes |
| Benchmark corruption | yes | BLOCKED | rollback healthy version |
| Ground Truth unavailable | yes | PAUSED, no fallback | yes |

## Scale Recovery Result

SIMULATED 500-case Evaluation 在 Case #201 前发生 process kill：checkpoint 已完成 200；重建 CheckpointStore 后从 #201 恢复；最终 500 completed，500 个 case 各执行恰好一次，recovery rate=100%。该结果是恢复演练，不代表生产事故统计。

## Verification

- Unit `recovery.test.ts`：8 项（含 parameterized failure matrix）。
- E2E `recovery-scale.test.ts`：1 项 500-case crash/resume。
- Queue + Benchmark integrity 回归：13 项。
- 定向合计 22/22 PASS；TypeScript PASS。
- Full Regression：`npm test` 1837 PASS / 18 SKIP / 0 FAIL。
