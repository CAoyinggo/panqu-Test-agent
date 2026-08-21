# Phase 51.4：Data Lifecycle / Retention / Archive / Restore

> 日期：2026-08-21｜测试记录为 SIMULATED；CLI 空仓演练为 REAL command execution

## Audit

AI Evaluation JSON 快照原先没有时间分层和保留策略；Telemetry、EvaluationResult、DecisionTrace、Audit、Benchmark、GroundTruth 会长期停留在线存储。清理与合规保留之间也没有代码级安全边界。

## Implement

- 落地任务书指定的 `RetentionPolicy`，六类数据统一进入 `HOT → WARM → COLD → ARCHIVED`。
- 在线 Archive 记录继续保留 ID、project、kind、trace、createdAt、tier、checksum 等统计 metadata；详情可明确显示 `ARCHIVED`，payload 进入 archive artifact。
- artifact 对完整记录集合计算 SHA-256；任何 payload 篡改都会阻止 restore。
- restore 恢复原 ID、trace、payload 与 protected 属性，且不覆盖已恢复的在线记录。
- `Audit`、`Benchmark`、`GroundTruth` 为 protected；普通 `purgeArchived` 永不删除它们。
- CLI：`npm run platform:data:archive -- ...` 与 `npm run platform:data:restore -- ...`，原子写入 state/archive 文件，不生成虚假业务数据。

## Data Lifecycle Acceptance

- 六类数据均可归档/恢复；HOT/WARM/COLD/ARCHIVED 统计可供 Dashboard 读取。
- Archive → Restore 后 ID、Trace、Audit 语义与 payload 不变。
- checksum corruption 检测后恢复被拒绝。
- 默认保留：Telemetry 90d、Evaluation 180d；Audit/Benchmark/GroundTruth 2555d 且普通清理永久 protected。部署方可显式配置更长周期。

## Verification

- Unit `data-retention.test.ts`：4 项。
- Integration `data-lifecycle.test.ts`：2 项。
- 定向 6/6 PASS；TypeScript PASS。
- CLI empty-store archive + restore 两条真实命令 exit 0，archived/restored 均为 0（没有把空仓伪报为生产归档）。
- Full Regression：`npm test` 1815 PASS / 18 SKIP / 0 FAIL。

Archive artifact 当前为 JSON 文件接口，便于本地和对象存储适配；生产部署应把 artifact 放入启用版本化、WORM/访问审计和独立备份域的对象存储。
