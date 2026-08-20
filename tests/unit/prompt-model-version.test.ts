// Phase 46 / 43.7 + 43.8 + 43.9 + 43.10：Prompt/Model Versioning + A/B + Multi-objective 单元测试
import { describe, it, expect } from 'vitest';
import { PromptStore, ModelStore, compareAb, multiObjectiveScore } from '../../src/ai-quality/versioning.js';
import type { AbMetric } from '../../src/ai-quality/contract.js';

describe('Prompt Versioning（43.7）', () => {
  it('同名 key 自动递增版本 v1 → v2 → v3', () => {
    const store = new PromptStore(() => '2026-08-20T00:00:00.000Z');
    store.add({ promptKey: 'risk', content: 'v1 content', createdBy: 'ai-team' });
    store.add({ promptKey: 'risk', content: 'v2 content', createdBy: 'ai-team' });
    store.add({ promptKey: 'risk', content: 'v3 content', createdBy: 'ai-team' });
    const versions = store.list('risk');
    expect(versions.map((v) => v.version)).toEqual(['v1', 'v2', 'v3']);
    expect(versions[0].status).toBe('ACTIVE');
    expect(versions[1].status).toBe('DRAFT');
    expect(versions[1].parentVersion).toBe('v1');
  });

  it('记录 Benchmark 得分 + 切换 ACTIVE', () => {
    const store = new PromptStore();
    const v1 = store.add({ promptKey: 'risk', content: 'v1', createdBy: 'ai-team' });
    const v2 = store.add({ promptKey: 'risk', content: 'v2', createdBy: 'ai-team' });
    store.recordScore(v1.id, 0.91);
    store.recordScore(v2.id, 0.94);
    store.setActive(v2.id);
    expect(v2.status).toBe('ACTIVE');
    expect(v1.status).toBe('DISABLED');
    expect(v2.benchmarkScore).toBe(0.94);
  });
});

describe('Model Versioning（43.8）', () => {
  it('同一模型多版本可公平比较', () => {
    const store = new ModelStore();
    store.add({ provider: 'deepseek', model: 'deepseek-chat', modelVersion: 'v3', createdBy: 'ai-team' });
    store.add({ provider: 'deepseek', model: 'deepseek-chat', modelVersion: 'v4', configuration: { temperature: 0.2 }, createdBy: 'ai-team' });
    const list = store.list();
    expect(list.length).toBe(2);
    expect(list[0].modelVersion).toBe('v3');
    store.setActive(list[1].id);
    expect(list[1].status).toBe('ACTIVE');
  });
});

describe('Multi-objective Score（43.10）', () => {
  it('保留原始指标并计算加权综合分', () => {
    const m: AbMetric = { accuracy: 0.94, latencyMs: 500, cost: 0.001, failureRate: 0.02, safety: 0 };
    const r = multiObjectiveScore(m);
    expect(r.components.accuracy).toBe(0.94);
    expect(r.components.safetyScore).toBe(1);
    expect(r.components.latencyScore).toBe(0.75); // 1 - 500/2000
    expect(r.qualityScore).toBeGreaterThan(0.8);
    expect(r.qualityScore).toBeLessThanOrEqual(1);
  });
});

describe('A/B Evaluation（43.9）', () => {
  const baseline: AbMetric = { accuracy: 0.91, latencyMs: 500, cost: 0.001, failureRate: 0.03, safety: 0 };
  const candidate: AbMetric = { accuracy: 0.94, latencyMs: 620, cost: 0.0015, failureRate: 0.01, safety: 0 };

  it('对比 Accuracy / Latency / Cost / Failure / Safety 逐维胜者', () => {
    const cmp = compareAb(baseline, candidate);
    expect(cmp.winners.accuracy).toBe('candidate');
    expect(cmp.winners.latencyMs).toBe('baseline'); // candidate 更慢
    expect(cmp.winners.cost).toBe('baseline'); // candidate 更贵
    expect(cmp.winners.failureRate).toBe('candidate');
    expect(cmp.winners.safety).toBe('tie');
    expect(cmp.deltas.accuracy).toBeCloseTo(0.03, 5);
  });

  it('不要只看 Accuracy：成本与延迟计入 Quality 综合分', () => {
    const fast: AbMetric = { accuracy: 0.9, latencyMs: 300, cost: 0.0005, failureRate: 0.05, safety: 0 };
    const slow: AbMetric = { accuracy: 0.9, latencyMs: 1800, cost: 0.009, failureRate: 0.05, safety: 0 };
    const cmp = compareAb(fast, slow);
    expect(cmp.baselineQuality).toBeGreaterThan(cmp.candidateQuality);
  });
});
