import { describe, expect, it } from 'vitest';
import { CostGovernanceService, compareShadowRouting } from '../../src/cost/governance.js';

describe('Phase 52 Resource Optimization', () => {
  it('建议默认不生效，批准后按 5/20/50/100 灰度', () => {
    const service = new CostGovernanceService();
    const rec = service.recommend({ projectId: 'a', type: 'MODEL_SWITCH', title: 'X → Y', current: 'X', proposed: 'Y', expectedCostChange: -0.27, expectedQualityChange: -0.01 });
    expect(rec.status).toBe('RECOMMENDED');
    service.decideOptimization(rec.id, 'APPROVED', 'owner');
    expect([5, 20, 50, 100].map(() => service.promoteCanary(rec.id, 'owner').canaryPercent)).toEqual([5, 20, 50, 100]);
  });
  it('灰度质量/故障严重回归自动回滚', () => {
    const service = new CostGovernanceService();
    const rec = service.recommend({ projectId: 'a', type: 'MODEL_SWITCH', title: 'X → Y', current: 'X', proposed: 'Y', expectedCostChange: -0.2, expectedQualityChange: 0 });
    service.decideOptimization(rec.id, 'APPROVED', 'owner'); service.promoteCanary(rec.id, 'owner');
    expect(service.observeCanary(rec.id, { costChange: 0, qualityChange: -0.1, latencyChange: 0, failureChange: 0.2 }, 'system')).toMatchObject({ status: 'ROLLED_BACK', canaryPercent: 0 });
  });
  it('自动建议同等质量的低成本模型，Shadow 对比不影响 Release', () => {
    const service = new CostGovernanceService();
    const rec = service.recommendModelOptimization('a', [{ id: 'X', quality: 95, cost: 10, latencyMs: 800 }, { id: 'Y', quality: 94.5, cost: 5, latencyMs: 500 }]);
    expect(rec).toMatchObject({ status: 'RECOMMENDED', current: 'X', proposed: 'Y', expectedCostChange: -0.5 });
    expect(compareShadowRouting({ id: 'X', quality: 95, cost: 10, latencyMs: 800 }, { id: 'Y', quality: 94.5, cost: 5, latencyMs: 500 })).toMatchObject({ releaseImpact: false, decision: 'PASS' });
  });
  it('异常、审计和治理状态可以原子快照恢复', () => {
    const service = new CostGovernanceService();
    service.addAnomaly({ id: 'a1', projectId: 'a', type: 'COST_ANOMALY', current: 10, baseline: 2, ratio: 5, severity: 'CRITICAL', message: 'spike', channels: ['DASHBOARD', 'AUDIT', 'FEISHU'], timestamp: '2026-08-21T00:00:00Z' });
    const restored = new CostGovernanceService(service.snapshot());
    expect(restored.anomalies).toHaveLength(1); expect(restored.listAudit()).toHaveLength(1);
  });
});
