import { describe, expect, it } from 'vitest';
import {
  ContractRegistry,
  ContractResolver,
  DEFAULT_SOURCE_PRIORITY,
  DriftDetector,
  contractDependency,
  contractFingerprint,
  contractSource,
  createContract,
  nextContractVersion,
  validateDependencies,
} from '../../../src/contracts/index.js';

const NOW = '2026-08-24T00:00:00.000Z';

function candidate(value: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: 'model.demo', kind: 'model' as const, subject: 'demo', version: 'v1', status: 'ACTIVE' as const,
    value, sources: [contractSource('requirement', 'tests:requirement')], createdAt: NOW, ...overrides,
  };
}

describe('Canonical Contract model', () => {
  it('normalizes object key order into a stable fingerprint', () => {
    expect(contractFingerprint({ b: 2, a: { y: 2, x: 1 } }))
      .toBe(contractFingerprint({ a: { x: 1, y: 2 }, b: 2 }));
    expect(contractFingerprint({ modelId: 84, workflow: 'qnck' }))
      .not.toBe(contractFingerprint({ workflow: 'qntk', modelId: 84 }));
  });

  it('rejects invalid contracts and fingerprints', () => {
    expect(() => createContract({ ...candidate({ ok: true }), id: '' })).toThrow(/id/);
    expect(() => createContract({ ...candidate({ ok: true }), confidence: 2 })).toThrow(/0~1/);
    expect(() => createContract({ ...candidate({ ok: true }), fingerprint: 'forged' })).toThrow(/fingerprint/);
  });

  it('creates deterministic semantic versions', () => {
    expect(nextContractVersion(['v1', 'v3', 'legacy'])).toBe('v4');
    expect(nextContractVersion([])).toBe('v1');
  });

  it('marks the previous ACTIVE version STALE when a newer version is registered', () => {
    const registry = new ContractRegistry([candidate({ value: 1 })]);
    registry.register({ ...candidate({ value: 2 }), version: 'v2', supersedes: 'model.demo@v1' });
    expect(registry.list({ id: 'model.demo', status: 'STALE' }).map((item) => item.version)).toEqual(['v1']);
    expect(registry.get('model.demo')?.version).toBe('v2');
  });

  it('uses the configured source order without changing a fact', () => {
    expect(DEFAULT_SOURCE_PRIORITY.runtime).toBeGreaterThan(DEFAULT_SOURCE_PRIORITY.backend);
    expect(DEFAULT_SOURCE_PRIORITY.backend).toBeGreaterThan(DEFAULT_SOURCE_PRIORITY.frontend);
    expect(DEFAULT_SOURCE_PRIORITY.frontend).toBeGreaterThan(DEFAULT_SOURCE_PRIORITY.requirement);
    expect(DEFAULT_SOURCE_PRIORITY.requirement).toBeGreaterThan(DEFAULT_SOURCE_PRIORITY['test-fixture']);
  });
});

describe('Contract Resolver', () => {
  it('resolves one source and merges multiple equal sources', () => {
    const registry = new ContractRegistry();
    registry.register(candidate({ maxLength: 20_000 }));
    registry.register({ ...candidate({ maxLength: 20_000 }), sources: [contractSource('backend', 'backend:model')] });
    const result = new ContractResolver(registry).resolve({ id: 'model.demo' });
    expect(result.status).toBe('RESOLVED');
    expect(result.contract?.sources).toHaveLength(2);
    expect(result.contract?.value).toEqual({ maxLength: 20_000 });
  });

  it('never lets source priority overwrite a conflicting requirement', () => {
    const registry = new ContractRegistry();
    registry.register(candidate({ maxLength: 5_000 }));
    registry.register({
      ...candidate({ maxLength: 20_000 }),
      sources: [contractSource('runtime', 'runtime:observation')],
    });
    const result = new ContractResolver(registry).resolve({ id: 'model.demo' });
    expect(result.status).toBe('CONFLICT');
    expect(result.contract).toBeUndefined();
    expect(result.conflicts[0].values).toHaveLength(2);
  });

  it.each([
    ['UNKNOWN', 'UNKNOWN'],
    ['STALE', 'STALE'],
    ['EXPIRED', 'STALE'],
    ['CONFLICT', 'CONFLICT'],
  ] as const)('maps %s contract to %s resolution', (contractStatus, resolutionStatus) => {
    const registry = new ContractRegistry([candidate({}, { status: contractStatus })]);
    expect(new ContractResolver(registry).resolve({ id: 'model.demo' }).status).toBe(resolutionStatus);
  });

  it('returns UNKNOWN when no Contract exists', () => {
    expect(new ContractResolver(new ContractRegistry()).resolve({ id: 'missing' }).status).toBe('UNKNOWN');
  });
});

describe('Contract Drift', () => {
  const detector = new DriftDetector();
  const make = (value: unknown, version: string) => createContract({ ...candidate(value), version });

  it('detects no drift independent of object key order', () => {
    expect(detector.compare(make({ a: 1, b: 2 }, 'v1'), make({ b: 2, a: 1 }, 'v2')).status).toBe('NO_DRIFT');
  });

  it('classifies add/remove/type/enum/behavior changes with field paths', () => {
    const result = detector.compare(
      make({ removed: true, type: 6, workflow_type: 'qntk', enum: ['a', 'b'] }, 'v1'),
      make({ added: true, type: 'qnck_to_video', workflow_type: 'qnck', enum: ['a', 'c'] }, 'v2'),
    );
    expect(result.status).toBe('DRIFT');
    expect(result.changedFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$.added', classification: 'ADDED' }),
      expect.objectContaining({ path: '$.removed', classification: 'REMOVED' }),
      expect.objectContaining({ path: '$.type', classification: 'TYPE_CHANGED', severity: 'CRITICAL' }),
      expect.objectContaining({ path: '$.workflow_type', classification: 'BEHAVIOR_CHANGED' }),
      expect.objectContaining({ path: '$.enum', classification: 'ENUM_CHANGED' }),
    ]));
    expect(result.severity).toBe('CRITICAL');
  });
});

describe('Scenario Contract dependency gate', () => {
  it('maps ACTIVE/STALE/version mismatch/CONFLICT/UNKNOWN fail-closed', () => {
    const registry = new ContractRegistry([candidate({ value: 1 })]);
    const resolver = new ContractResolver(registry);
    const active = registry.get('model.demo')!;
    expect(validateDependencies([contractDependency(active)], resolver).status).toBe('VALID');
    expect(validateDependencies([{ contractId: 'model.demo', version: 'v0' }], resolver).status).toBe('CONTRACT_DRIFT');
    expect(validateDependencies([{ contractId: 'missing', version: 'v1' }], resolver).status).toBe('BLOCKED');
    expect(validateDependencies([], resolver).status).toBe('BLOCKED');

    registry.invalidate('model.demo', 'test');
    expect(validateDependencies([{ contractId: 'model.demo', version: 'v1' }], resolver).status).toBe('STALE');
  });
});
