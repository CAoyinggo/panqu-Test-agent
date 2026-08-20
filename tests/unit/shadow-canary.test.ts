// Phase 46 / 43.12 + 43.13 + 43.14：Improvement Gate + Shadow + Canary + Rollback 单元测试
import { describe, it, expect } from 'vitest';
import { ExperimentStore } from '../../src/ai-quality/experiment.js';
import type { AbMetric } from '../../src/ai-quality/contract.js';

const metric: (acc: number, opts?: Partial<AbMetric>) => AbMetric = (accuracy, opts) => ({
  accuracy, latencyMs: 500, cost: 0.001, failureRate: 0.02, safety: 0, ...opts,
});

describe('Shadow Mode（43.13）', () => {
  it('Shadow 只读：候选不劣于基线 → 通过可进 Canary', () => {
    const store = new ExperimentStore({ now: () => '2026-08-20T00:00:00.000Z' });
    const exp = store.createShadow({ proposalId: 'imp-1', candidateRef: 'prompt-xxx' });
    expect(exp.type).toBe('SHADOW');
    const r = store.recordShadowObservation(exp.id, { baseline: metric(0.9), candidate: metric(0.94) });
    expect(r.passed).toBe(true);
    expect(store.get(exp.id)?.status).toBe('COMPLETED');
  });

  it('Shadow 候选劣于基线 → PAUSED', () => {
    const store = new ExperimentStore();
    const exp = store.createShadow({ proposalId: 'imp-1', candidateRef: 'prompt-xxx' });
    const r = store.recordShadowObservation(exp.id, { baseline: metric(0.9), candidate: metric(0.85) });
    expect(r.passed).toBe(false);
    expect(store.get(exp.id)?.status).toBe('PAUSED');
  });
});

describe('Canary（43.14）', () => {
  it('5% → 20% → 50% → 100% 渐进，指标达标 → PROMOTED', () => {
    const store = new ExperimentStore({ now: () => '2026-08-20T00:00:00.000Z' });
    const exp = store.createCanary({ proposalId: 'imp-1', candidateRef: 'prompt-xxx' });
    expect(exp.canaryStage).toBe('5%');

    const s1 = store.canaryPromote(exp.id, { metrics: metric(0.94) });
    expect(s1.stage).toBe('20%');
    expect(s1.passed).toBe(true);

    const s2 = store.canaryPromote(exp.id, { metrics: metric(0.95) });
    expect(s2.stage).toBe('50%');

    const s3 = store.canaryPromote(exp.id, { metrics: metric(0.93) });
    expect(s3.stage).toBe('100%');

    const s4 = store.canaryPromote(exp.id, { metrics: metric(0.94) });
    expect(s4.stage).toBe('100%');
    expect(s4.passed).toBe(true);
    expect(store.get(exp.id)?.status).toBe('PROMOTED');
  });

  it('异常（Unsafe 上升 / Accuracy 骤降）→ 自动停止扩展并回滚', () => {
    const store = new ExperimentStore();
    const exp = store.createCanary({ proposalId: 'imp-1', candidateRef: 'prompt-xxx' });
    const r = store.canaryPromote(exp.id, { metrics: metric(0.94, { safety: 0.1 }), thresholdAccuracyDrop: 0.03 });
    expect(r.passed).toBe(false);
    expect(store.get(exp.id)?.status).toBe('ROLLED_BACK');
    expect(store.get(exp.id)?.rollbackReason).toContain('Unsafe');
  });

  it('手动暂停（异常停止扩展）', () => {
    const store = new ExperimentStore();
    const exp = store.createCanary({ proposalId: 'imp-1', candidateRef: 'm' });
    store.pause(exp.id, '人工介入');
    expect(store.get(exp.id)?.status).toBe('PAUSED');
    // PAUSED 后不可继续推进
    const r = store.canaryPromote(exp.id, { metrics: metric(0.94) });
    expect(r.passed).toBe(false);
  });
});

describe('Rollback（43.12）', () => {
  it('回滚记录 fromRef/toRef/reason/metrics', () => {
    const store = new ExperimentStore({ now: () => '2026-08-20T00:00:00.000Z' });
    const exp = store.createCanary({ proposalId: 'imp-1', candidateRef: 'prompt-cand-v2' });
    const rb = store.rollback(exp.id, { reason: 'Accuracy 下降', metrics: { accuracy: 0.85 } });
    expect(rb.kind).toBe('PROMPT');
    expect(rb.fromRef).toBe('prompt-cand-v2');
    expect(rb.toRef).toBe('baseline');
    expect(rb.metrics.accuracy).toBe(0.85);
    expect(store.get(exp.id)?.status).toBe('ROLLED_BACK');
  });
});
