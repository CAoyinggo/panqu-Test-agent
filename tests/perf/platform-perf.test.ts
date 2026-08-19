// Phase 29 性能与容量基线 — Vitest 套件
// 通过 npm run phase29:test / perf:test 运行（默认全量回归已排除 tests/perf）。
// 断言：10/50/100/500 Runs 生命周期吞吐/延迟、Scheduler/Audit/Telemetry 吞吐、内存稳定性
//       满足绝对 sanity 门禁（PERF_THRESHOLDS），并把结果落盘 perf/latest.json 供追踪。
// 相对回归（相对基线的退化）由 scripts/perf/run-perf.mjs --gate 判定（perf:gate）。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runPlatformPerf, PERF_THRESHOLDS, BATCH_SIZES } from '../../src/platform/ops/perf-harness.js';

const latestFile = path.join(process.cwd(), 'perf', 'latest.json');

describe('Phase 29 性能与容量基线', () => {
  it('批量规模覆盖 10/50/100/500 Runs（任务书第 19 节）', () => {
    expect(BATCH_SIZES).toEqual([10, 50, 100, 500]);
  });

  it('Run 生命周期吞吐/延迟满足 sanity 门禁', async () => {
    const report = await runPlatformPerf();
    // 持久化当前结果（供门禁与趋势追踪）
    fs.mkdirSync(path.dirname(latestFile), { recursive: true });
    fs.writeFileSync(latestFile, JSON.stringify(report, null, 2));

    // 生命周期：队列必须全部清空，吞吐/延迟满足绝对下限
    for (const m of report.runLifecycle) {
      expect(m.jobsPendingAfter, `batch=${m.batchSize} 队列未清空`).toBe(0);
      expect(m.createP95Ms, `batch=${m.batchSize} createP95 超限`).toBeLessThan(PERF_THRESHOLDS.maxCreateP95Ms);
      expect(m.createOpsPerSec, `batch=${m.batchSize} create 吞吐过低`).toBeGreaterThan(PERF_THRESHOLDS.minCreateOpsPerSec);
      expect(m.lifecycleOpsPerSec, `batch=${m.batchSize} 生命周期吞吐过低`).toBeGreaterThan(PERF_THRESHOLDS.minLifecycleOpsPerSec);
    }

    // 子系统吞吐下限
    expect(report.schedulerOpsPerSec).toBeGreaterThan(PERF_THRESHOLDS.minSchedulerOpsPerSec);
    expect(report.auditOpsPerSec).toBeGreaterThan(PERF_THRESHOLDS.minAuditOpsPerSec);
    expect(report.telemetryOpsPerSec).toBeGreaterThan(PERF_THRESHOLDS.minTelemetryOpsPerSec);

    // 内存稳定性
    expect(report.memory.growthMb).toBeLessThan(PERF_THRESHOLDS.maxMemoryGrowthMb);

    // 报告完整性
    expect(report.runLifecycle.length).toBe(BATCH_SIZES.length);
    expect(report.version).toBeTruthy();
    expect(report.totalMs).toBeGreaterThan(0);
  });
});
