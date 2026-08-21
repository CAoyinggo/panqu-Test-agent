import { describe, expect, it } from 'vitest';
import { aggregateRaw, detectEvaluationDrift, EvaluationMetricsAggregator, type EvaluationTelemetryRecord } from '../../src/eval/metrics/index.js';

function records(): EvaluationTelemetryRecord[] {
  return Array.from({ length: 100 }, (_, index) => ({
    id: `metric-${index}`,
    timestamp: `2026-08-21T${String(index % 2).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
    projectId: index % 2 ? 'project-b' : 'project-a',
    model: index % 2 ? 'model-v2' : 'model-v1',
    benchmark: index % 4 ? 'RISK_v1' : 'RCA_v1',
    score: (80 + (index % 20)) / 100,
    latencyMs: index + 1,
    cost: (index + 1) / 10_000,
    success: index % 10 !== 0,
  }));
}

describe('Phase 51.6 metrics aggregation', () => {
  it('100 raw vs daily aggregate：Count/Average/P95/Failure/Cost 零误差', () => {
    const raw = records();
    const metric = aggregateRaw(raw).query('daily', '2026-08-21')[0];
    expect(metric.count).toBe(raw.length);
    expect(metric.averageScore).toBe(Math.round((raw.reduce((sum, row) => sum + row.score, 0) / raw.length) * 1_000_000) / 1_000_000);
    expect(metric.p95LatencyMs).toBe(95);
    expect(metric.failures).toBe(10);
    expect(metric.failureRate).toBe(0.1);
    expect(metric.cost).toBe(Math.round(raw.reduce((sum, row) => sum + row.cost, 0) * 1_000_000) / 1_000_000);
  });

  it('建立 hourly/daily/project/model/benchmark 五类桶', () => {
    const aggregator = aggregateRaw(records());
    expect(aggregator.query('hourly')).toHaveLength(2);
    expect(aggregator.query('daily')).toHaveLength(1);
    expect(aggregator.query('project')).toHaveLength(2);
    expect(aggregator.query('model')).toHaveLength(2);
    expect(aggregator.query('benchmark')).toHaveLength(2);
  });

  it('相同 telemetry id 增量写入幂等', () => {
    const aggregator = new EvaluationMetricsAggregator();
    expect(aggregator.ingest(records()[0])).toBe(true);
    expect(aggregator.ingest(records()[0])).toBe(false);
    expect(aggregator.recordCount).toBe(1);
    expect(aggregator.query('daily')[0].count).toBe(1);
  });

  it('Score/Latency/Cost critical drift → BLOCK', () => {
    const baseline = { score: 0.95, benchmarkChecksum: 'a', benchmarkHealthy: true, modelVersion: 'm1', promptVersion: 'p1', latencyMs: 100, cost: 1 };
    const report = detectEvaluationDrift(baseline, { ...baseline, score: 0.8, latencyMs: 160, cost: 1.6 });
    expect(report.verdict).toBe('BLOCK');
    expect(report.signals.filter((signal) => signal.verdict === 'BLOCK').map((signal) => signal.type)).toEqual(['SCORE', 'LATENCY', 'COST']);
  });

  it('Model/Prompt/healthy Benchmark change → REVIEW', () => {
    const baseline = { score: 0.95, benchmarkChecksum: 'a', benchmarkHealthy: true, modelVersion: 'm1', promptVersion: 'p1', latencyMs: 100, cost: 1 };
    const report = detectEvaluationDrift(baseline, { ...baseline, benchmarkChecksum: 'b', modelVersion: 'm2', promptVersion: 'p2' });
    expect(report.verdict).toBe('REVIEW');
    expect(report.signals.filter((signal) => signal.verdict === 'REVIEW')).toHaveLength(3);
  });

  it('Benchmark integrity drift 无条件 BLOCK', () => {
    const baseline = { score: 0.95, benchmarkChecksum: 'a', benchmarkHealthy: true, modelVersion: 'm1', promptVersion: 'p1', latencyMs: 100, cost: 1 };
    expect(detectEvaluationDrift(baseline, { ...baseline, benchmarkHealthy: false }).verdict).toBe('BLOCK');
  });
});
