import { describe, expect, it } from 'vitest';
import type { TestCase, TestType } from '../../src/agents/test-design/testcase-schema.js';
import {
  AcceptanceRegressionError,
  buildFactBasedRegressionPlan,
} from '../../src/acceptance/acceptance-regression.js';

function regressionCase(
  id: string,
  testType: TestType,
  factIds: string[],
  objectiveIds: string[],
  priority: TestCase['priority'] = 'P1',
): TestCase {
  return {
    id,
    feature: 'developer feedback',
    name: id,
    priority,
    testType,
    executionMode: 'EXECUTABLE',
    protocol: 'HTTP',
    source: {
      requirementId: 'REQ-1',
      testPointId: `TP-${id}`,
      acceptanceCriteriaIds: ['AC-1'],
      factIds,
      objectiveIds,
      apiSpecId: 'API-1',
      apiOperationKey: 'GET /resource',
    },
    tags: [],
    steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/resource' }],
    assertions: [{ type: 'STATUS_CODE', expected: 200, factIds, objectiveIds }],
  };
}

describe('Fact-based acceptance regression', () => {
  it('selects the original failure, same Fact Cases and same policy Cases without unrelated expansion', () => {
    const cases = [
      regressionCase('CASE-FAILED', 'PERMISSION', ['FACT-ACCESS'], ['OBJ-DENY'], 'P0'),
      regressionCase('CASE-SAME-FACT', 'API', ['FACT-ACCESS'], ['OBJ-HTTP']),
      regressionCase('CASE-SAME-POLICY', 'AUTH', ['FACT-AUTH'], ['OBJ-AUTH']),
      regressionCase('CASE-ISOLATION-POLICY', 'DATA_ISOLATION', ['FACT-TENANT'], ['OBJ-TENANT'], 'P0'),
      regressionCase('CASE-UNRELATED', 'BUSINESS_RULE', ['FACT-ORDER'], ['OBJ-ORDER']),
    ];

    const plan = buildFactBasedRegressionPlan({
      testCases: cases,
      failedCaseIds: ['CASE-FAILED'],
      authorizedCaseIds: cases.map((testCase) => testCase.id),
    });

    expect(plan).toMatchObject({
      strategy: 'FACT_BASED_REGRESSION_V1',
      seedCaseIds: ['CASE-FAILED'],
      seedFactIds: ['FACT-ACCESS'],
      policies: ['ACCESS_CONTROL'],
      affectedFactIds: ['FACT-ACCESS', 'FACT-AUTH', 'FACT-TENANT'],
      affectedObjectiveIds: ['OBJ-AUTH', 'OBJ-DENY', 'OBJ-HTTP', 'OBJ-TENANT'],
    });
    expect(plan.affectedCaseIds).toEqual([
      'CASE-FAILED', 'CASE-ISOLATION-POLICY', 'CASE-SAME-FACT', 'CASE-SAME-POLICY',
    ]);
    expect(plan.selections.find((item) => item.caseId === 'CASE-FAILED')?.reasons)
      .toEqual(['ORIGINAL_FAILURE', 'SAME_FACT', 'SAME_POLICY']);
    expect(plan.selections.find((item) => item.caseId === 'CASE-SAME-FACT')?.reasons).toEqual(['SAME_FACT']);
    expect(plan.affectedCaseIds).not.toContain('CASE-UNRELATED');
  });

  it('fails closed for missing failure evidence, missing Fact trace and scope expansion', () => {
    const traced = regressionCase('CASE-FAILED', 'PERMISSION', ['FACT-ACCESS'], ['OBJ-DENY']);
    expect(() => buildFactBasedRegressionPlan({ testCases: [traced], failedCaseIds: [] }))
      .toThrow('REGRESSION_SEED_MISSING');
    expect(() => buildFactBasedRegressionPlan({
      testCases: [regressionCase('CASE-NO-FACT', 'PERMISSION', [], ['OBJ-DENY'])],
      failedCaseIds: ['CASE-NO-FACT'],
    })).toThrow('REGRESSION_TRACE_INCOMPLETE');
    expect(() => buildFactBasedRegressionPlan({
      testCases: [traced, regressionCase('CASE-RELATED', 'AUTH', ['FACT-AUTH'], ['OBJ-AUTH'])],
      failedCaseIds: ['CASE-FAILED'],
      authorizedCaseIds: ['CASE-FAILED'],
    })).toThrow(AcceptanceRegressionError);
    expect(() => buildFactBasedRegressionPlan({
      testCases: [traced], failedCaseIds: ['CASE-UNKNOWN'],
    })).toThrow('REGRESSION_TRACE_INVALID');
  });
});
