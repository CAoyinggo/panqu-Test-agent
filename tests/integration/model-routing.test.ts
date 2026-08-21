import { describe, expect, it } from 'vitest';
import { CostGovernanceService } from '../../src/cost/governance.js';

describe('Phase 52 Model Policy → Approval → Routing integration', () => {
  it('生产模型变更不自动激活，审批后可灰度并保留路由解释', () => {
    const service = new CostGovernanceService();
    service.setPolicy({ projectId: 'a', domain: 'RCA', primaryModel: 'strong', fallbackModel: 'cheap', maxCost: 5, maxLatencyMs: 1000, environment: 'SHADOW', status: 'ACTIVE' }, 'owner');
    const decision = service.policies.route({ projectId: 'a', domain: 'RCA', complexity: 'CRITICAL', candidates: [{ model: 'cheap', quality: 90, cost: 1, latencyMs: 400 }, { model: 'strong', quality: 95, cost: 5, latencyMs: 800 }] });
    expect(decision.selectedModel).toBe('strong'); expect(decision.trace).toHaveLength(6);
    const rec = service.recommend({ projectId: 'a', type: 'MODEL_SWITCH', title: 'promote shadow', current: 'cheap', proposed: 'strong', expectedCostChange: 0.1, expectedQualityChange: 0.05 });
    expect(() => service.activateOptimization(rec.id, 'owner')).toThrow('必须先获批准');
    service.decideOptimization(rec.id, 'APPROVED', 'owner');
    expect(service.activateOptimization(rec.id, 'owner').status).toBe('ACTIVE');
  });
});
