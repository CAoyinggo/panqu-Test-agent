import { describe, expect, it } from 'vitest';
import { DataLifecycleStore } from '../../src/eval/lifecycle/index.js';

describe('Phase 51.4 archive / restore integration', () => {
  it('六类数据归档可见统计，恢复后 ID / Trace / Audit / payload 不变', () => {
    const store = new DataLifecycleStore();
    const kinds = ['Telemetry', 'EvaluationResult', 'DecisionTrace', 'Audit', 'Benchmark', 'GroundTruth'] as const;
    for (const [index, kind] of kinds.entries()) {
      store.add({
        id: `record-${index}`, projectId: 'project-a', kind,
        traceId: `trace-${index}`, createdAt: '2025-01-01T00:00:00.000Z', payload: { kind, sequence: index },
      });
    }
    const artifact = store.archive({ projectId: 'project-a' }, new Date('2026-08-21T00:00:00.000Z'));
    expect(artifact.records).toHaveLength(6);
    expect(store.stats()).toEqual({ HOT: 0, WARM: 0, COLD: 0, ARCHIVED: 6 });
    expect(store.get('record-0')).toMatchObject({ tier: 'ARCHIVED', traceId: 'trace-0' });
    expect(store.get('record-0')).not.toHaveProperty('payload');

    const result = store.restore(artifact);
    expect(result).toEqual({ restored: 6, unchanged: 0 });
    for (const [index, kind] of kinds.entries()) {
      expect(store.get(`record-${index}`)).toMatchObject({
        id: `record-${index}`, traceId: `trace-${index}`, tier: 'HOT', payload: { kind, sequence: index },
      });
    }
  });

  it('篡改 archive payload 后 checksum 阻止恢复', () => {
    const store = new DataLifecycleStore();
    store.add({ id: 'e1', projectId: 'p1', kind: 'EvaluationResult', createdAt: '2025-01-01T00:00:00.000Z', payload: { score: 1 } });
    const artifact = store.archive();
    artifact.records[0].payload = { score: 0 };
    expect(() => store.restore(artifact)).toThrow('checksum');
  });
});
