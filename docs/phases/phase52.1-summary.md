# Phase 52.1：Durable Evaluation Operations State

> Phase 51 后复扫首个高风险修复｜日期：2026-08-21

## Scan Finding

Phase 51 的隔离、Queue、Metrics、Recovery 与 Scale API 均可工作，但 `EvaluationScaleService` 默认状态只在进程内。服务重启会丢失 queue ownership、aggregate buckets、recovery alerts、lifecycle、benchmark integrity manifests 与运维 audit。这是生产可靠性高风险，不能用“测试通过”掩盖。

## Implement

- Queue snapshot 恢复时使所有 RUNNING lease 失效并以原 job ID requeue，避免重启前 worker 的 late completion。
- Metrics 保存幂等 ID、五维 buckets 与 latency histogram；恢复后 Count/Average/P95/Cost/Failure 不变。
- Recovery 保存六组件健康状态和 alert/recoveredAt。
- Evaluation Scale 聚合快照覆盖 Queue、Workers、Capacity、Lifecycle、Archive artifact、Metrics、Drift、Recovery、Content-addressed Benchmark 和 Audit。
- `persistToFile` 使用同目录临时文件 + atomic rename；`loadFromFile` 不存在时返回真正空服务，不生成项目或业务数据。
- API Server 新增 `evaluationScaleStateFile`；Archive/Restore 成功后原子持久化，重启加载。

## Verification

- `evaluation-scale-persistence.test.ts`：完整状态 round-trip；RUNNING → QUEUED recovery；archive restore；empty-file behavior。
- 原子落盘后 `.tmp` 不残留。
- 定向 23/23 PASS；Full Vitest 1840 PASS / 18 SKIP / 0 FAIL。

## Remaining Architecture Boundary

文件快照解决单实例重启耐久性，但多实例共享 Queue 仍需要数据库 compare-and-set lease/fencing token；Archive 仍应迁移到带版本/WORM 的对象存储。这两项进入后续 Phase 52 扫描，当前不宣称 PROJECT_COMPLETE。
