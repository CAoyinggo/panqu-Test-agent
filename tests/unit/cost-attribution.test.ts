import { describe, expect, it } from 'vitest';
import { CostAttributionLedger } from '../../src/cost/governance.js';

describe('Phase 52 Cost Attribution', () => {
  it('按 Run / Project / Evaluation / Model / Benchmark 精确归属且幂等', () => {
    const ledger = new CostAttributionLedger();
    const base = { projectId: 'a', category: 'LLM' as const, provider: 'openai', model: 'cheap', quantity: 10, unitCost: 0.1, currency: 'USD', timestamp: '2026-08-21T01:00:00.000Z' };
    ledger.record({ ...base, id: '1', runId: 'r1', evaluationId: 'e1', benchmarkId: 'b1' });
    ledger.record({ ...base, id: '1', runId: 'r1', evaluationId: 'e1', benchmarkId: 'b1' });
    ledger.record({ ...base, id: '2', projectId: 'b', model: 'strong', quantity: 20, runId: 'r2' });
    expect(ledger.summarize().totalCost).toBe(3);
    expect(ledger.summarize({ projectId: 'a' }).byRun).toEqual({ r1: 1 });
    expect(ledger.summarize({ projectId: 'a' }).byEvaluation).toEqual({ e1: 1 });
    expect(ledger.summarize({ projectId: 'a' }).byBenchmark).toEqual({ b1: 1 });
    expect(ledger.summarize().byModel).toEqual({ cheap: 1, strong: 2 });
  });
  it('拒绝非法分类、跨币种混算和冲突幂等键', () => {
    const ledger = new CostAttributionLedger();
    ledger.record({ id: 'x', projectId: 'a', category: 'LLM', quantity: 1, unitCost: 1, currency: 'CNY' });
    expect(() => ledger.record({ projectId: 'a', category: 'INVALID' as 'LLM', quantity: 1, unitCost: 1, currency: 'CNY' })).toThrow('category');
    expect(() => ledger.record({ projectId: 'a', category: 'LLM', quantity: 1, unitCost: 1, currency: 'USD' })).toThrow('币种不一致');
    expect(() => ledger.record({ id: 'x', projectId: 'b', category: 'LLM', quantity: 1, unitCost: 1, currency: 'CNY' })).toThrow('id 冲突');
  });
});
