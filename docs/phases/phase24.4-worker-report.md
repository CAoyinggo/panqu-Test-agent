# Phase 24.4：Worker 报告

## 1. 目标

建立多 Worker 执行层：环境 + 能力 + 并发 + 健康 四维调度，支持注册 / 心跳 / 优雅停机 / 重试 / 崩溃恢复（Scenario 3：Worker DOWN → Job RETRY → 其他 Worker 完成，Run 不丢失）。

## 2. 新增模块

| 文件 | 职责 |
| --- | --- |
| `src/platform/workers/worker.ts` | `WorkerRegistration` / `TestWorker` / `WorkerExecutor` 类型定义 |
| `src/platform/workers/worker-registry.ts` | 注册 / 注销 / 心跳 / 健康评估 / 并发槽位 / 优雅停机 |
| `src/platform/workers/worker-pool.ts` | dispatch 调度 + recoverOrphans 崩溃回收 |
| `src/platform/workers/index.ts` | 导出 |

## 3. 关键设计

- **Worker 选择依据**：Environment + Capability + Concurrency + Health。`claimForWorker` 按 Worker 的 environments 与 capabilities 过滤领取；`scheduler.next()` 支持 `capability` / `environment` / `claimedBy` 过滤。
- **原子领取**：`next()` 将 Job 从 QUEUED 原子置为 RUNNING 并写 `claimedBy`，保证同一 Job 不被多 Worker 同时消费。
- **崩溃恢复**：`recoverOrphans()` 扫描 RUNNING 但归属 Worker 已 down / 注销的 Job → `fail()` 置 RETRY → `requeueRetries()` 重入队 → 其他健康 Worker 领取。
- **重试**：`fail()` 未达 `maxRetries` → RETRY 并计数，达上限 → FAILED。
- **单一时钟源**：WorkerRegistry 的 ISO 时间戳由 `nowMs` 派生，避免两套时钟不一致导致健康误判。

## 4. 验收结果

| 检查项 | 结果 |
| --- | --- |
| Build（`tsc -p tsconfig.json --noEmit`） | ✅ 通过 |
| 单元测试 `tests/unit/worker.test.ts` | ✅ 10 / 10 PASS |
| `npm test` | ✅ 80 文件 / 1119 用例 PASS（含旧用例，无回归） |
| `npm run agent:test` | ✅ 450 / 450 PASS（Phase 1-23 行为保持） |

单元测试覆盖：注册 / 心跳 / 健康超时 / 并发槽位 / dispatch 执行 / 环境路由 / 能力路由 / maxConcurrency / 失败重试 / 崩溃恢复（Scenario 3）。

## 5. 与任务书对应

- 任务书 8（Worker）：✅ register / unregister / heartbeat / health / graceful shutdown / retry / timeout 均已实现或可组合使用。
- Worker 选择依据：✅ Environment + Capability + Concurrency + Health（AI Video → GPU Worker；API Test → General Worker 的路由由 capability 表达，生产只读由 environment 过滤 + 环境安全策略约束）。
- 任务书 21 Scenario 3（Worker 崩溃）：✅ `recoverOrphans` 测试通过。

## 6. 风险与后续

- 超时（timeoutMs）能力已在 Scheduler 的 `sweepTimeouts` 实现，由生产运维循环周期性调用。
- 多 Worker 并发执行的真实集成（scheduler + worker + run 生命周期）在 `tests/integration/scheduler-worker.test.ts`（Phase 24 集成测试）验证。

下一阶段：24.5 RBAC / Approval。
