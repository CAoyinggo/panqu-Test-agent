# Phase 51.5：Benchmark Storage Scaling / Integrity

> 日期：2026-08-21｜默认 Benchmark 数据为 REAL CURATED repository dataset；损坏场景为 SIMULATED

## Audit

Phase 50 `BenchmarkRegistry.extendWithCases` 通过复制“前一版本全部 cases + 新 cases”保留历史，正确但存储量随版本近似线性重复。定义也没有持久 checksum；快照被突变、缺 blob 或重复 case 时，Evaluation 无法在运行前统一阻断。

## Implement

- 内容寻址 Case Blob：hash 输入严格为 `domain + input + groundTruth + metadata`，case ID 留在 manifest；相同内容跨 ID/版本只保存一次。
- Benchmark Manifest 包含 checksum、version、createdAt、source、caseCount、Ground Truth version、Dataset Metadata 和 case refs。
- 完整性检测：Checksum Mismatch、Unexpected Mutation、Missing Case、Blob Corruption、Duplicate Case、Case Count Mismatch。
- `materialize()` 前强制 `assertHealthy()`；任何 integrity issue 返回 `EVALUATION_BLOCKED BENCHMARK_INTEGRITY`，禁止带错数据继续算分。
- rollback 只选择同领域低于损坏版本的最近健康版本；损坏版本保留以便审计，不被静默覆盖。

## Storage Capacity

默认真实仓库 Benchmark：8 domains、238 logical cases。建立 v1/v2 两个逻辑版本后：

- Version manifests：16
- Logical case references：476
- Unique content blobs：237（原始 238 cases 内已有一对内容相同）
- Deduplicated references：239
- Dedup ratio：50.21%

该数据来自真实默认 Benchmark 的内容寻址导入，不是生成的生产使用量。

## Integrity / Recovery

- Manifest source 突变 → CHECKSUM_MISMATCH → Evaluation BLOCK。
- Blob 删除 → MISSING_CASE；blob 内容突变 → BLOB_CORRUPTION。
- v11 caseCount 被破坏 → 检测并选择健康 v10 rollback target。
- 写入时同版本重复 case ID 直接拒绝。

## Verification

- Unit `benchmark-integrity.test.ts`：6 项。
- Integration `benchmark-storage.test.ts`：1 项真实 238-case × 2 version 导入。
- 既有 Benchmark Registry / Merge 回归：19 项。
- 定向合计 26/26 PASS；TypeScript PASS。
- Full Regression：`npm test` 1822 PASS / 18 SKIP / 0 FAIL。
