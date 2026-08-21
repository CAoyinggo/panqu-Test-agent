import { describe, expect, it } from 'vitest';
import { CostAttributionLedger, CostBudgetRegistry, guardBudget } from '../../src/cost/governance.js';

describe('Phase 52 Cost Budget', () => {
  it('90% WARNING，100% AUTONOMOUS_STOP 并保留完整 trace', () => {
    const ledger = new CostAttributionLedger();
    ledger.record({ projectId: 'a', runId: 'r', category: 'COMPUTE', quantity: 9, unitCost: 1, currency: 'USD', timestamp: '2026-08-21T01:00:00.000Z' });
    const budgets = new CostBudgetRegistry();
    const budget = budgets.set({ projectId: 'a', daily: 10, perRun: 10 }, '2026-08-21T00:00:00.000Z');
    const warning = budgets.evaluate(budget.id, ledger, { now: '2026-08-21T02:00:00.000Z', runId: 'r' });
    expect(warning.every((v) => v.status === 'WARNING')).toBe(true);
    const stopped = guardBudget({ evaluation: warning[0], projectedCost: 1 });
    expect(stopped).toMatchObject({ allowed: false, decision: 'AUTONOMOUS_STOP', budget: 10, used: 10, remaining: 0 });
    expect(stopped.trace).toContain('remaining=0');
  });
});
