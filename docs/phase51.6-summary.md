# Phase 51.6：Telemetry / Metrics Aggregation / Drift

> 日期：2026-08-21｜100-record correctness sample 为 SIMULATED deterministic telemetry

## Audit

Evaluation Dashboard 的历史指标缺少预聚合层；随着事件增长，按项目/模型/Benchmark/时间范围计算会反复扫描原始记录。Phase 50 也没有统一区分 score、benchmark、model、prompt、latency、cost drift。

## Implement

- 写入时增量建立 Hourly、Daily、Project、Model、Benchmark 五类聚合桶。
- 每个桶维护 count、score sum、cost sum、failures 和加权 latency histogram；查询直接从聚合桶得到 Average、P95、Cost、Failure Rate，不读取 raw telemetry。
- telemetry ID 幂等，重复消费不会重复计数。
- drift 比较 Baseline → Current：Score、Benchmark、Model、Prompt、Latency、Cost 六类 signal。
- version/content 变化或中等 score/latency/cost 变化进入 REVIEW；score drop ≥ 0.1、latency/cost increase ≥ 50% 或 Benchmark integrity invalid 进入 BLOCK。

## Metrics Correctness

100 条 deterministic sample 的 Raw vs Aggregated 对比：

- Count error = 0
- Average score error = 0（统一 6 位归一化）
- P95 latency error = 0（weighted exact histogram）
- Failure count/rate error = 0
- Cost error = 0（统一 6 位归一化）

两小时、一天、两个项目、两个模型、两个 Benchmark 的 bucket 数量均与原始数据一致。

## Drift Acceptance

- Score + Latency + Cost critical change → BLOCK。
- healthy Benchmark checksum、Model version、Prompt version change → REVIEW。
- Benchmark unhealthy → unconditional BLOCK。
- 无变化 → 各 signal PASS。

## Verification

- Unit `metrics-aggregation.test.ts`：6/6 PASS。
- TypeScript PASS。
- Full Regression：`npm test` 1828 PASS / 18 SKIP / 0 FAIL。

该聚合器是可嵌入的增量核心；51.8 会把聚合查询和 drift 暴露到 project-scoped API/CLI/Web Scale 页面。
