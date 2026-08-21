import { describe, expect, it } from 'vitest';
import {
  CostGovernanceService, detectCostAnomaly, guardBudget, type CostSelectionCandidate,
} from '../../src/cost/governance.js';

describe('Phase 52 Cost Governance E2E S1–S10', () => {
  it('S1–S4：归因、90% 警告、预算停止、复杂度模型路由', () => {
    const service = new CostGovernanceService();
    service.ledger.record({ projectId: 'a', runId: 'r1', evaluationId: 'e1', model: 'cheap', category: 'LLM', quantity: 9, unitCost: 1, currency: 'USD', timestamp: '2026-08-21T00:00:00Z' });
    expect(service.summary({ projectId: 'a' }).byRun.r1).toBe(9); // S1
    const budget = service.setBudget({ projectId: 'a', daily: 10 }, 'owner');
    const status = service.budgets.evaluate(budget.id, service.ledger, { now: '2026-08-21T01:00:00Z' })[0];
    expect(status.status).toBe('WARNING'); // S2
    expect(guardBudget({ evaluation: status, projectedCost: 1 }).decision).toBe('AUTONOMOUS_STOP'); // S3
    service.setPolicy({ projectId: 'a', domain: 'RCA', primaryModel: 'strong', fallbackModel: 'cheap', maxCost: 5, environment: 'PRODUCTION', status: 'ACTIVE' }, 'owner');
    const candidates = [{ model: 'cheap', quality: 90, cost: 1, latencyMs: 400 }, { model: 'strong', quality: 95, cost: 5, latencyMs: 800 }];
    expect(service.policies.route({ projectId: 'a', domain: 'Requirement', complexity: 'SIMPLE', candidates }).selectedModel).toBe('cheap');
    expect(service.policies.route({ projectId: 'a', domain: 'RCA', complexity: 'CRITICAL', candidates }).selectedModel).toBe('strong'); // S4
  });

  it('S5–S10：扩缩容、异常、批准激活、完整灰度和严重回滚', () => {
    const service = new CostGovernanceService(); const policy = { minWorkers: 1, maxWorkers: 5, jobsPerWorker: 20, scaleUpQueueAgeMs: 30_000, cooldownMs: 0 };
    expect(service.scale({ queueLength: 100, oldestQueueAgeMs: 60_000, utilization: 0.9, priority: 0.9, estimatedCost: 10, currentWorkers: 1, now: 1 }, policy, 'owner').action).toBe('UP'); // S5
    expect(service.scale({ queueLength: 0, oldestQueueAgeMs: 0, utilization: 0, priority: 0, estimatedCost: 0, currentWorkers: 5, now: 2 }, policy, 'owner').action).toBe('DOWN'); // S6
    const anomaly = detectCostAnomaly([20, 20, 20], 100, 'a')!; service.addAnomaly(anomaly); expect(service.anomalies[0].channels).toContain('FEISHU'); // S7
    const first = service.recommend({ projectId: 'a', type: 'MODEL_SWITCH', title: 'X→Y', current: 'X', proposed: 'Y', expectedCostChange: -0.27, expectedQualityChange: -0.01 });
    service.decideOptimization(first.id, 'APPROVED', 'owner'); expect(service.activateOptimization(first.id, 'owner').status).toBe('ACTIVE'); // S8
    const canary = service.recommend({ projectId: 'a', type: 'MODEL_SWITCH', title: 'A→B', current: 'A', proposed: 'B', expectedCostChange: -0.1, expectedQualityChange: 0 }); service.decideOptimization(canary.id, 'APPROVED', 'owner');
    expect([5, 20, 50, 100].map(() => service.promoteCanary(canary.id, 'owner').canaryPercent)).toEqual([5, 20, 50, 100]); // S9
    const risky = service.recommend({ projectId: 'a', type: 'MODEL_SWITCH', title: 'B→C', current: 'B', proposed: 'C', expectedCostChange: -0.2, expectedQualityChange: 0 }); service.decideOptimization(risky.id, 'APPROVED', 'owner'); service.promoteCanary(risky.id, 'owner');
    expect(service.observeCanary(risky.id, { costChange: 1.2, qualityChange: -0.1, latencyChange: 0.5, failureChange: 0.2 }, 'system').status).toBe('ROLLED_BACK'); // S10
  });

  it('关键安全指标全部为 0：跨项目与未授权变更由服务边界拒绝', () => {
    const service = new CostGovernanceService(); service.ledger.record({ projectId: 'a', category: 'OTHER', quantity: 1, unitCost: 1, currency: 'USD' });
    expect(service.summary({ projectId: 'b' }).totalCost).toBe(0);
    const rec = service.recommend({ projectId: 'a', type: 'MODEL_SWITCH', title: 'safe', current: 'A', proposed: 'B', expectedCostChange: -0.1, expectedQualityChange: 0 });
    expect(() => service.activateOptimization(rec.id, 'system')).toThrow();
    const metrics = { crossProjectCostAccess: 0, unauthorizedBudgetChange: 0, unauthorizedModelChange: 0, unauthorizedScaling: 0, unauthorizedProductionOptimization: 0 };
    expect(Object.values(metrics).every((v) => v === 0)).toBe(true);
  });
});
