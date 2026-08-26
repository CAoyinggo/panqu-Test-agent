# Phase 51.3：Evaluation Queue / Worker Scaling

> 日期：2026-08-21｜数据分类：LOAD TEST；worker-down 为 SIMULATED failure

## Audit

51.2 Runner 可限制单批并发，但没有持久状态机和 worker ownership。若进程在执行中断开，任务归属、重试和迟到结果无法判定，不能安全扩展到多个 Worker。

## Implement

- `EvaluationQueue` 状态机：`QUEUED → RUNNING → COMPLETED|FAILED`，唯一 job ID 的 enqueue 幂等。
- `claim` 返回不可伪造 lease token 和过期时间；heartbeat 只能延长当前 lease。
- worker down 后 `recoverExpired` 原地 requeue 同一 job；attempt 超限才进入 FAILED。
- `complete/fail` 必须携带当前 token；过期 worker 的迟到完成被拒绝，杜绝 duplicate terminal evaluation。
- `EvaluationWorkerPool` 支持 1/2/5/10 workers，采集 throughput、queue delay P50/P95/P99、execution P50/P95/P99、retry 和 utilization。

## Scaling Result

| Jobs | Workers | 类型 | 结果 |
| ---: | ---: | --- | --- |
| 10 | 1 | LOAD TEST | 10 completed，0 lost，0 duplicate |
| 50 | 2 | LOAD TEST | 50 completed，0 lost，0 duplicate |
| 100 | 5 | LOAD TEST | 100 completed，0 lost，0 duplicate |
| 500 | 10 | LOAD TEST | 500 completed，0 lost，0 duplicate |
| 100 real-rule jobs / 5 projects | 10 | E2E LOAD TEST | 100 completed，真实 Benchmark/GT 运行，critical=0 |

绝对性能值随硬件和并行测试调度变化，Runner 返回实测数值但本阶段不把本机值冒充生产 SLA。队列守恒与正确性指标是确定性门禁。

## Failure / Recovery

SIMULATED worker failure：worker-1 claim 后 lease 到期，job 原 ID requeue；worker-2 以 attempt=2 获取并完成；worker-1 旧 token 的 late completion 被拒绝。最终 `COMPLETED=1`，没有第二份 Evaluation。

## Verification

- Unit：`evaluation-queue.test.ts` 7 项，覆盖容量矩阵、租约恢复、幂等和 transient retry。
- Integration + E2E：`evaluation-scale.test.ts`，多项目真实规则评测。
- 定向：9/9 PASS；TypeScript PASS。
- Full Regression：`npm test` 1809 PASS / 18 SKIP / 0 FAIL。

队列当前是进程内实现；51.7 将增加快照/恢复与 failure coordinator。生产多节点可将同一租约状态机映射到支持 compare-and-set 的数据库存储。
