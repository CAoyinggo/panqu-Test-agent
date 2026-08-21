import { describe, expect, it } from 'vitest';
import { compareCostRegression, detectCostAnomaly, paretoFrontier } from '../../src/cost/governance.js';

describe('Phase 52 Cost Anomaly / Regression / Frontier', () => {
  it('成本尖峰触发 Feishu、Dashboard、Audit 通知', () => {
    const anomaly = detectCostAnomaly([18, 20, 22], 100, 'a');
    expect(anomaly).toMatchObject({ type: 'COST_ANOMALY', severity: 'CRITICAL', channels: ['DASHBOARD', 'AUDIT', 'FEISHU'] });
  });
  it('成本上涨 50% 且质量无提升进入 REVIEW，并移除被支配模型', () => {
    expect(compareCostRegression({ id: 'v4.25', quality: 90, cost: 10, latencyMs: 100 }, { id: 'v4.26', quality: 90, cost: 15, latencyMs: 100 }).decision).toBe('REVIEW');
    expect(paretoFrontier([{ id: 'A', quality: 90, cost: 1, latencyMs: 100 }, { id: 'B', quality: 89, cost: 2, latencyMs: 90 }, { id: 'C', quality: 95, cost: 5, latencyMs: 200 }]).map((v) => v.id)).toEqual(['A', 'C']);
  });
});
