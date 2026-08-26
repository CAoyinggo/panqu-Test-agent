# Phase 29 总结：性能与容量基线（Performance & Capacity Baseline）

> 版本：v4.5.0 ｜ 日期：2026-08-19 ｜ 模式：持续自主开发（CONTINUOUS AUTONOMOUS DEVELOPMENT）

## 一、目标

建立平台性能与容量基线，满足任务书第 19 节硬性要求（DEBT-06，P0）：

1. 10/50/100/500 Runs 批量下 Run 生命周期（createRun → Scheduler → Worker → startRun/completeRun）的**吞吐与延迟**基线。
2. Scheduler / Audit / Telemetry 子系统**写入吞吐**基线。
3. **内存稳定性**（全程 heap 增长）观测。
4. **回归门禁**：相对基线检测退化（延迟 > 2× / 吞吐 < 50% 即失败），可接入 CI。

## 二、扫描发现

| 项 | 说明 | 处置 |
|---|---|---|
| 无性能基线 | 平台仅有功能测试，无吞吐/延迟基线（DEBT-06） | 本阶段建立 |
| **ID 碰撞缺陷（DEBT-14，P0）** | 基准首次运行即在 `audit.record` 高吞吐写入（10 万+ ops/s）下抛出「实体已存在」——`Date.now().toString(36) + Math.random().toString(36).slice()` 同毫秒 + 短随机尾碰撞 | 本阶段修复 |
| 计时分辨率 | 原 `Date.now()` 毫秒分辨率下，单批 <15ms 的测量吞吐剧烈抖动（5000↔12500 ops/s），无法作为门禁 | 改 `performance.now()`（µs）+ min-of-3 |

## 三、实施内容

### 29.1 测量模块（唯一测量源）

`src/platform/ops/perf-harness.ts`：

- `BATCH_SIZES = [10, 50, 100, 500]`（任务书第 19 节）。
- `benchRunLifecycle`：批量 createRun（RBAC + 审计 + 事件 + 入队）测 p50/p95/p99/max 延迟与吞吐；注册 `perf-worker` 执行器（真实 startRun/completeRun 状态机推进），Worker 池持续 dispatch/drain 直至队列清空，测生命周期吞吐与队列收敛（guard 防死循环）。
- `benchSchedulerOps` / `benchAuditOps`（含脱敏）/ `benchTelemetryOps`：各 2000 次写入测吞吐。
- 内存：全程 heapUsed 前后对比。
- 计时统一 `performance.now()`；每项 min-of-3（最快一次）滤除 GC/调度抖动。
- `evaluatePerfGate(current, baseline)`：逐项判定（延迟 > 基线 ×2 → FAIL；吞吐 < 基线 ×0.5 → FAIL；内存增长 > 基线 ×3 → FAIL）。

### 29.2 CLI 门禁

`scripts/perf/run-perf.mjs`：

- `--baseline [file]`：运行并固化 `perf/baseline.json`（权威基线）。
- `--gate`：运行并与基线比对，输出逐项比值，回归即退出码 1。
- `--json`：输出完整 JSON。
- 结果同时落 `perf/latest.json` 供趋势追踪。

### 29.3 ID 碰撞修复（性能基准暴露的真实缺陷）

新增 `src/core/id.ts`（`generateId(prefix)`：`<prefix>-<timestamp36>-<uuid hex 32>`，crypto.randomUUID 128 bit 熵），统一替换 5 处生成器：

| 文件 | 原实现 | 新实现 |
|---|---|---|
| `audit/audit-log.ts` entryId | `audit-<ts36>-<rand4>` | `generateId('audit')` |
| `scheduler/scheduler.ts` jobId | `job-<runId>-<ts36>-<rand8>` | `generateId('job')` |
| `telemetry/telemetry-store.ts` newId | `<prefix>-<ts36>-<rand8>` | `generateId(prefix)` |
| `storage/repository.ts` generateEntityId | `<prefix>-<ts36>-<rand6>` | `generateId(prefix)` |
| `runs/run-schema.ts` generatePlatformRunId | `run-<14位ts>-<rand4 base36>` | `run-<14位ts>-<uuid hex 32>` |

`checkpoint.test.ts` 的 runId 格式断言同步更新为 `/^run-\d{14}-[0-9a-f]{32}$/`。

### 29.4 测试与配置

- 新增 `tests/unit/id.test.ts`（4 项）：格式、同一毫秒 10000 个 ID 无重复（碰撞回归守卫）、前缀隔离、`generatePlatformRunId` 5000 个无重复。
- 新增 `tests/perf/platform-perf.test.ts`（2 项）：批量规模断言 + sanity 门禁断言（吞吐下限 / p95 上限 / 队列清空 / 内存上限），并持久化 `perf/latest.json`。
- 新增 `vitest.perf.config.ts`；`vitest.config.ts` exclude `tests/perf/**`（默认 `npm test` 不受影响）。

## 四、修改 / 新增 / 删除文件

- 新增：`src/core/id.ts`、`src/platform/ops/perf-harness.ts`、`tests/unit/id.test.ts`、`tests/perf/platform-perf.test.ts`、`vitest.perf.config.ts`、`scripts/perf/run-perf.mjs`、`docs/phases/phase29-summary.md`、`perf/baseline.json`（基线产物）。
- 修改：`audit/audit-log.ts`、`scheduler/scheduler.ts`、`telemetry/telemetry-store.ts`、`storage/repository.ts`、`runs/run-schema.ts`、`tests/unit/checkpoint.test.ts`、`package.json`（v4.5.0 + 5 个 perf 脚本）、`src/platform/version.ts`（4.5.0）、`package-lock.json`、`README.md`、`CHANGELOG.md`、`docs/TECH-DEBT.md`、`vitest.config.ts`。

## 五、基线数据（本机，memory 存储）

| 批量 | create ops/s | create p95 | 生命周期 ops/s | 生命周期总耗时 |
|---|---|---|---|---|
| 10 | ~58k | <2ms | ~58k | ~0.2ms |
| 50 | ~27k | <3ms | ~18k | ~3ms |
| 100 | ~18k | <3ms | ~14k | ~7ms |
| 500 | ~15k | <3ms | ~11k | ~45ms |

- Scheduler：~4.5k ops/s ｜ Audit：~101k ops/s ｜ Telemetry：~115k ops/s
- 内存：heap 增长 < 25MB（远低于 150MB 上限）
- 完整基准总耗时：~1.8s

## 六、测试与验收

| 项 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | 通过 |
| Phase 29 套件 | `npm run phase29:test` | 2 项通过 |
| ID 回归守卫 | `npx vitest run tests/unit/id.test.ts` | 4 项通过 |
| ID 影响回归 | checkpoint/storage/scheduler/telemetry 等 | 49 项通过 |
| 性能门禁 | `node scripts/perf/run-perf.mjs --gate` | 连续 3 轮 PASS（exit=0） |
| 全量回归 | `npm test` | 见下（1430 passed / 18 skipped） |

## 七、性能 / 安全 / 兼容性

- **性能**：建立可重复、抗抖动的吞吐/延迟基线；门禁可接入 CI。
- **安全**：ID 碰撞修复消除「实体已存在」引发的数据写入失败与潜在状态不一致；无新攻击面。
- **兼容性**：ID 格式仅内部使用，除 `checkpoint.test.ts` 格式断言外无外部契约；`server.ts` 的 `randomBytes(6)`（48-bit）本身碰撞安全，未改动。

## 八、遗留问题与下一阶段建议

1. **Phase 30 覆盖率补齐（DEBT-08，P1）**：将 `src/platform/**` 纳入 vitest coverage include 并补分支，校验行/函数/分支/语句 ≥ 80/80/75/80 门禁在平台层也成立。
2. **Phase 31 迁移 down/回滚（DEBT-09，P1）**：为 schema 迁移补 down/回滚路径并验证 backup→migrate→restore→rollback 链。
3. 持续开放：DEBT-01（双环境策略源）、DEBT-05（assertion-visualizer）、DEBT-07（变异测试）、DEBT-11/12/13。
4. 性能基线建议后续在 CI 每周跑一次 `perf:gate`（比对上周基线），防性能回归漏检。
