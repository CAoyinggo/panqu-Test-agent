import { describe, expect, it, vi } from 'vitest';
import { ObserverRegistry } from '../../../src/observers/registry.js';
import { StateObserver } from '../../../src/observers/callback-observers.js';
import { observeProcessor } from '../../../src/observers/processor-observer.js';
import type { Scenario } from '../../../src/acceptance/scenario-contract.js';
import type { ScenarioProcessor } from '../../../src/acceptance/scenario-runner.js';

const context = {
  runId: 'run-1', scenarioId: 'scenario-1', operationId: 'op-1', environment: 'test',
  variables: {}, signal: new AbortController().signal,
};

describe('Phase 2 Observer framework', () => {
  it('captures before/after and computes a real diff', async () => {
    let value = { count: 1 };
    const observer = new StateObserver(async (_context, phase) => {
      if (phase === 'after') value = { count: 2 };
      return value;
    });
    const before = await observer.before(context);
    const after = await observer.after(context);
    expect(await observer.diff(before, after)).toMatchObject({ changed: true, before: { count: 1 }, after: { count: 2 } });
  });

  it('reports an unavailable observer instead of fabricating data', async () => {
    const observer = new StateObserver();
    expect(observer.available(context)).toBe(false);
    await expect(observer.before(context)).rejects.toThrow('OBSERVER_UNAVAILABLE');
  });

  it('blocks before invoking a side-effecting delegate when required Observer is missing', async () => {
    const execute = vi.fn(async () => ({ status: 'PASS' as const, executed: true, evidence: [] }));
    const delegate: ScenarioProcessor = {
      name: 'api', supportsAbort: true, supportedEvidenceKinds: ['RESPONSE'], supports: () => true, execute,
    };
    const scenario = {
      id: 'scenario-1', evidenceRequirements: [{
        id: 'state-after', kind: 'STATE_AFTER', channel: 'STATE', requiredForPass: true,
        operationId: 'op-1', assertionIds: ['assert-state'], description: 'state',
      }], assertions: [{ id: 'assert-state', acceptanceCriteriaIds: ['AC-1'] }],
    } as unknown as Scenario;
    const wrapped = observeProcessor(delegate, new ObserverRegistry(), 'test');
    const result = await wrapped.execute({ id: 'op-1' } as never, {
      runId: 'run-1', scenario, variables: {}, signal: context.signal,
    });
    expect(result).toMatchObject({ status: 'BLOCKED', executed: false });
    expect(execute).not.toHaveBeenCalled();
  });
});
