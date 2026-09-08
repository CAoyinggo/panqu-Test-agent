import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';
import { deduplicateDevTestCases, selectDevTestCases, tierOf } from '../../../src/devtest/dimension-selector.js';

function sample(id: string): TestCase {
  return { id, name: id, feature: 'input contract', priority: 'P2', testType: 'API',
    protocol: 'HTTP', executionMode: 'EXECUTABLE', tags: [],
    steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/items', query: { value: 'Alpha' } }],
    assertions: [{ type: 'STATUS_CODE', expected: 200 }] };
}

describe('input-sensitive case identity', () => {
  it.each([
    ['case', 'Alpha', 'alpha'], ['sign', -1, 1], ['punctuation', 'a-b', 'a b'],
    ['type', 1, '1'], ['order', ['a', 'b'], ['b', 'a']], ['multiplicity', ['a'], ['a', 'a']],
  ])('retains inputs differing in %s', (_label, left, right) => {
    const a = sample('A'); const b = sample('B');
    a.steps[0].query = { value: left }; b.steps[0].query = { value: right };
    expect(deduplicateDevTestCases([a, b]).retained.map((item) => item.id)).toEqual(['A', 'B']);
  });

  it.each(['headers', 'pathParams'] as const)('retains different request %s', (field) => {
    const a = sample('A'); const b = sample('B');
    a.steps[0][field] = { tenant: 'a' }; b.steps[0][field] = { tenant: 'b' };
    expect(deduplicateDevTestCases([a, b]).retained).toHaveLength(2);
  });

  it('retains different assertion values and contract fingerprints', () => {
    const a = sample('A'); const b = sample('B');
    a.assertions = [{ type: 'JSON_PATH', path: '$.state', expected: 'READY' }];
    b.assertions = [{ type: 'JSON_PATH', path: '$.state', expected: 'ready' }];
    expect(deduplicateDevTestCases([a, b]).retained).toHaveLength(2);
    b.assertions = structuredClone(a.assertions);
    a.contractDependencies = [{ contractId: 'items', version: '1', fingerprint: 'first' }];
    b.contractDependencies = [{ contractId: 'items', version: '1', fingerprint: 'second' }];
    expect(deduplicateDevTestCases([a, b]).retained).toHaveLength(2);
  });

  it('merges only true equivalents, keeps higher priority and never changes input cases', () => {
    const cases = [sample('A'), sample('B'), sample('C')];
    cases[1].priority = 'P0';
    for (const item of cases) item.source = { requirementId: 'R', testPointId: 'P', acceptanceCriteriaIds: ['AC-1'] };
    cases[0].steps[0].query = { a: 1, b: 2 };
    cases[1].steps[0].query = { b: 2, a: 1 };
    cases[2].steps[0].query = { a: 1, b: 2 };
    const before = structuredClone(cases);
    const result = deduplicateDevTestCases(cases);
    expect(result.retained.map((item) => item.id)).toEqual(['B']);
    expect(result.groups).toEqual([{ kept: 'B', removed: ['A', 'C'] }]);
    expect(cases).toEqual(before);
  });
});

function boundary(id: string, kind: string, value: unknown): TestCase {
  return { ...sample(id), testType: 'BOUNDARY', schemaVersion: 'TEST_CASE_V2', requirementStatus: 'CONFIRMED',
    source: { requirementId: 'R', testPointId: 'P', acceptanceCriteriaIds: ['AC-1'], factIds: ['F-1'] },
    parameterContext: { parameter: 'value', constraint: 'minimum=1;maximum=3', testData: value,
      expectedResponse: kind === 'MAX_PLUS' ? 400 : 200, expectedOutcome: kind === 'MAX_PLUS' ? 'REJECT' : 'ACCEPT', boundaryVector: kind } };
}

describe('default contract-boundary selection', () => {
  it('keeps confirmed min/max/one-past boundaries without requiring deep mode', () => {
    const cases = [boundary('min', 'MIN', 1), boundary('max', 'MAX', 3), boundary('over', 'MAX_PLUS', 4)];
    expect(selectDevTestCases(cases, { maxCases: 10 }).selected.map((item) => item.id).sort()).toEqual(['max', 'min', 'over']);
    expect(tierOf(cases[0])).toBe('TIER_1');
  });

  it('does not promote unconfirmed or generic extreme cases, and preserves explicit budgets', () => {
    const confirmed = boundary('max', 'MAX', 3);
    const unconfirmed = { ...boundary('unknown', 'MAX_PLUS', 4), requirementStatus: 'UNKNOWN' } as TestCase;
    const extreme = boundary('extreme', 'EXTREME', Number.MAX_SAFE_INTEGER);
    const result = selectDevTestCases([confirmed, unconfirmed, extreme], { maxCases: 1 });
    expect(result.selected.map((item) => item.id)).toEqual(['max']);
    expect(result.unselected).toEqual(expect.arrayContaining([
      { caseId: 'unknown', reason: 'TIER_2_REQUIRES_DEEP' }, { caseId: 'extreme', reason: 'TIER_2_REQUIRES_DEEP' },
    ]));
    expect(selectDevTestCases([confirmed], { maxCases: 5, enabledDimensions: { PARAMETER_VALIDATION: false } }).selected).toEqual([]);
  });
});
