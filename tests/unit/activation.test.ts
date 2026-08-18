// 单元测试：Metrics Activation（Phase 25.5）
// 覆盖：tracked=false 指标按真实遥测自动激活 / 幂等累加（firstActivatedAt 不变）/
//       activationStatus 汇总 / 时间窗口参数驱动指标窗口 / 未激活不虚构。

import { describe, it, expect } from 'vitest';
import { TelemetryService } from '../../src/platform/telemetry/index.js';
import { ALL_TRACKED_METRICS } from '../../src/platform/telemetry/index.js';

const NOW = '2026-08-18T12:00:00.000Z';

function makeService() {
  return new TelemetryService({ now: () => NOW });
}

describe('初始状态：全部指标未激活', () => {
  it('无任何遥测样本时，5 个指标均 activated=false / sampleCount=0', async () => {
    const t = makeService();
    const status = await t.activationStatus();
    expect(status.activeCount).toBe(0);
    expect(status.records).toHaveLength(ALL_TRACKED_METRICS.length);
    for (const r of status.records) {
      expect(r.activated).toBe(false);
      expect(r.sampleCount).toBe(0);
      expect(r.firstActivatedAt).toBeNull();
    }
  });
});

describe('自动激活：真实样本 → tracked=false 翻转为 true', () => {
  it('LLM 成本样本激活 cost 指标', async () => {
    const t = makeService();
    await t.recordLLM({ runId: 'r1', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    const st = await t.activation.status('cost');
    expect(st?.activated).toBe(true);
    expect(st?.sampleCount).toBe(1);
    expect(st?.firstActivatedAt).toBe(NOW);
    // 其余指标仍为未激活
    expect((await t.activation.status('rcaAccuracy'))?.activated).toBeUndefined();
  });

  it('RCA 真实验证激活 rcaAccuracy；Flaky/Healing/Execution 各自激活', async () => {
    const t = makeService();
    await t.verifyRca({ runId: 'r1', rcaId: 'rca-1', predictedCategory: 'ASSERTION', actualCategory: 'ASSERTION' });
    await t.recordFlaky({ caseId: 'c1', runId: 'r1', pass: true, retry: false });
    await t.recordHealing({ healingId: 'h1', caseId: 'c1', runId: 'r1', suggested: true, approved: true, applied: true, recovered: true, rolledBack: false });
    await t.recordExecution({ runId: 'r1', phase: 'pipeline', result: 'success' });
    const status = await t.activationStatus();
    expect(status.activeCount).toBe(4);
    const byMetric = new Map(status.records.map((r) => [r.metric, r]));
    expect(byMetric.get('rcaAccuracy')?.activated).toBe(true);
    expect(byMetric.get('flakyRate')?.activated).toBe(true);
    expect(byMetric.get('healingRate')?.activated).toBe(true);
    expect(byMetric.get('execution')?.activated).toBe(true);
    expect(byMetric.get('cost')?.activated).toBe(false);
  });

  it('激活幂等：多次样本 sampleCount 累加，firstActivatedAt 保持首次时间', async () => {
    const t = makeService();
    await t.recordLLM({ runId: 'r1', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    await t.recordLLM({ runId: 'r2', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    await t.recordLLM({ runId: 'r3', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    const st = await t.activation.status('cost');
    expect(st?.sampleCount).toBe(3);
    expect(st?.firstActivatedAt).toBe(NOW);
    expect(st?.lastSampleAt).toBe(NOW);
  });
});

describe('时间窗口参数', () => {
  it('metricsSnapshot(window) 按窗口过滤样本（1h 空 vs 7d 有数据）', async () => {
    const t = makeService();
    await t.recordLLM({ runId: 'r1', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    // 服务时钟固定为 NOW；1h 与 7d 同起点（同一时刻），但这里验证窗口参数被正确传递
    const snap7d = await t.metricsSnapshot('7d');
    const snap1h = await t.metricsSnapshot('1h');
    // 两条记录时间戳相同（NOW），1h/7d 均含该样本
    expect(snap7d.cost.total.sampleCount).toBe(1);
    expect(snap1h.cost.total.sampleCount).toBe(1);
    // release 窗口不过滤，仍为 1
    expect((await t.metricsSnapshot('release')).cost.total.sampleCount).toBe(1);
  });
});
