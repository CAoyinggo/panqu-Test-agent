import { describe, expect, it } from 'vitest';
import { DataLifecycleStore, type LifecycleDataKind } from '../../src/eval/lifecycle/index.js';

const NOW = new Date('2026-08-21T00:00:00.000Z');
const created = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

describe('Phase 51.4 data retention', () => {
  it('按年龄推进 HOT → WARM → COLD → ARCHIVED', () => {
    const store = new DataLifecycleStore();
    for (const [id, days] of [['hot', 10], ['warm', 30], ['cold', 60], ['archive', 100]] as const) {
      store.add({ id, projectId: 'p1', kind: 'Telemetry', createdAt: created(days), payload: { days } });
    }
    expect(store.applyRetention({ telemetryDays: 90, evaluationDays: 180, auditDays: 365, benchmarkDays: 365, groundTruthDays: 365 }, NOW))
      .toEqual({ HOT: 1, WARM: 1, COLD: 1, ARCHIVED: 1 });
  });

  it('Audit / Benchmark / GroundTruth 普通清理不可删除', () => {
    const store = new DataLifecycleStore();
    for (const kind of ['Audit', 'Benchmark', 'GroundTruth'] as LifecycleDataKind[]) {
      store.add({ id: kind, projectId: 'p1', kind, createdAt: created(4000), tier: 'ARCHIVED', payload: { kind } });
    }
    expect(store.purgeArchived(['Audit', 'Benchmark', 'GroundTruth']))
      .toEqual({ purged: [], protected: ['Audit', 'Benchmark', 'GroundTruth'] });
    expect(store.list()).toHaveLength(3);
  });

  it('可再生成的 archived telemetry 可由显式 purge 清理', () => {
    const store = new DataLifecycleStore();
    store.add({ id: 't1', projectId: 'p1', kind: 'Telemetry', createdAt: created(100), tier: 'ARCHIVED', payload: {} });
    expect(store.purgeArchived(['t1'])).toEqual({ purged: ['t1'], protected: [] });
  });

  it('拒绝非法 retention policy', () => {
    const store = new DataLifecycleStore();
    expect(() => store.applyRetention({ telemetryDays: 0, evaluationDays: 1, auditDays: 1, benchmarkDays: 1, groundTruthDays: 1 }, NOW)).toThrow('大于 0');
  });
});
