# Phase 51.2：Concurrent Evaluation

> 日期：2026-08-21｜数据分类：LOAD TEST（本机进程内确定性 Evaluation，不代表生产流量）

## Audit

Phase 51.1 以前 `evaluationReport()` 是同步直调，没有并发上限、统一任务 ID、重试计数、资源观测或完整性前后探针。直接 `Promise.all` 无法回答任务是否丢失、是否重复、实际活跃数和 Benchmark/GT 是否被意外修改。

## Implement

- 新增受控并发 Runner，以唯一 job ID、项目 ID 和目标领域作为不可变输入。
- 支持并发上限、失败重试、每任务单一终态，以及 submitted/completed/failed/lost 守恒校验。
- 采集 Queue Latency、Execution P50/P95/P99、wall time、throughput、max active、worker utilization、CPU user/system、heap delta/peak、retry。
- `integrityProbe` 在整批执行前后生成 Benchmark + Ground Truth SHA-256 指纹；任何意外变异都会令 `integrityPreserved=false`。
- 负载覆盖 Requirement、Risk、RCA、Release；Benchmark Registry 与 HUMAN Ground Truth 是这些真实规则评测的输入源和完整性保护对象。

## Capacity Result

| 场景 | 类型 | 结果 |
| --- | --- | --- |
| 10 concurrent evaluations | LOAD TEST | 10 completed / 0 failed / 0 lost / 0 retry / integrity preserved |
| 50 concurrent evaluations | LOAD TEST | 50 completed / 0 failed / 0 lost / 0 retry / integrity preserved |
| 100 concurrent evaluations | LOAD TEST | 100 completed / 0 failed / 0 lost / 0 retry / integrity preserved |
| transient failure × 10 | SIMULATED failure | 10 recovered / 10 retry / exactly one terminal result per job |
| 3 projects × 100 jobs | LOAD TEST integration | 100 completed / 0 failed / 0 lost；project-a/b/c 分区保持独立 |

上述指标由 Runner 真实采集并在测试中检查为有限非负值；不同机器的绝对延迟和吞吐不写成固定生产基线，避免把 CI 噪声伪装成容量承诺。

## Verification

- Unit：`tests/unit/evaluation-concurrency.test.ts`，5 项覆盖 10/50/100、retry、重复 ID拒绝。
- Integration：`tests/integration/evaluation-scale.test.ts`，1 项覆盖多项目 100 并发。
- TypeScript：`npx tsc --noEmit` PASS。
- 定向测试：6/6 PASS。
- Full Regression：`npm test` 1801 PASS / 18 SKIP / 0 FAIL。

## Acceptance

Run Loss = 0；Evaluation Loss = 0；Duplicate Terminal Result = 0；Benchmark Corruption = 0；Ground Truth Corruption = 0。该阶段仍是单进程并发执行；多 Worker 租约、worker down requeue 和 500 job 容量属于 51.3。
