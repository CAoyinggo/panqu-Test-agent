import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import { applyTestCaseQualityGate } from '../../src/acceptance/test-case-quality-gate.js';
import type { AcceptanceRequirement, RequirementFact } from '../../src/acceptance/requirement-ir.js';
import type { TestObjective } from '../../src/acceptance/test-objective.js';

const fact = (id: string): RequirementFact => ({
  id, statement: id, category: 'FUNCTIONAL', epistemicType: 'FACT', provenance: 'EXPLICIT',
  normativity: 'NORMATIVE', status: 'UNVERIFIED', entityRefs: { items: [], apiSpecIds: [], parameterNames: [] },
  canonical: {
    resource: { kind: 'RESOURCE', identifiers: {} },
    action: { kind: 'READ' },
    conditions: [],
    constraints: [],
    expected: { kind: 'SUCCESS', explicit: true },
    scopes: [],
    sideEffects: [],
    normalizationStatus: 'COMPLETE',
    unresolved: [],
  },
  source: { line: 1, lineStart: 1, lineEnd: 1, text: id }, linkedObjectiveIds: [],
});

const requirement = (facts: RequirementFact[]): AcceptanceRequirement => ({
  id: 'REQ-Q', title: 'quality', source: { line: 1, content: 'quality' },
  features: [], actors: [], pages: [], apis: [], dataModels: [], permissions: [], isolationRules: [], businessRules: [], stateRules: [],
  acceptanceCriteria: [], warnings: [], factLedger: facts,
});

const objective = (id: string, factId: string, dimension: TestObjective['dimension'], known = true): TestObjective => ({
  id, requirementId: 'REQ-Q', factIds: [factId], dimension, scenario: id,
  expectedOutcome: known ? '明确预期' : '未知', outcomeStatus: known ? 'KNOWN' : 'UNKNOWN',
  sourceType: 'REQUIREMENT', provenance: 'EXPLICIT', priority: 'P0', source: { line: 1 },
  apiSpecIds: [], parameterNames: [], executionTarget: dimension === 'UI' ? 'UI' : 'API',
  strategyIds: [`TEST-${dimension}`],
  strategies: dimension === 'UI' ? ['UI_BEHAVIOR'] : ['API_CONTRACT'],
  canonicalFact: fact(factId).canonical,
});

const testCase = (factId = 'FACT-1', objectiveId = 'OBJ-1'): TestCase => ({
  id: 'TEMP', feature: 'quality', name: 'quality case', priority: 'P0', testType: 'API',
  executionMode: 'EXECUTABLE', protocol: 'HTTP', tags: [],
  source: { requirementId: 'REQ-Q', testPointId: 'TP-1', acceptanceCriteriaIds: [], factIds: [factId], objectiveIds: [objectiveId] },
  steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/resource' }],
  assertions: [{ type: 'STATUS_CODE', expected: 200, factIds: [factId], objectiveIds: [objectiveId] }],
  expected: { status: '200' },
});

describe('Test Case Quality Gate', () => {
  it('keeps a traced deterministic HTTP Case ready', () => {
    const f = fact('FACT-1');
    const o = objective('OBJ-1', f.id, 'API');
    const result = applyTestCaseQualityGate({ requirement: requirement([f]), objectives: [o], testCases: [testCase()] });
    expect(result.assessments[0]).toMatchObject({ status: 'READY', traceable: true, executable: true, issues: [] });
    expect(result.testCases[0].id).toMatch(/^CASE-[A-F0-9]{24}$/);
  });

  it('blocks a Case with no valid Fact/Objective source', () => {
    const result = applyTestCaseQualityGate({ requirement: requirement([]), objectives: [], testCases: [testCase()] });
    expect(result.assessments[0].status).toBe('BLOCKED');
    expect(result.assessments[0].issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'SOURCE_FACT_MISSING', 'SOURCE_OBJECTIVE_MISSING',
    ]));
    expect(result.testCases[0]).toMatchObject({ executionMode: 'DESIGNED_ONLY', protocol: undefined, steps: [] });
  });

  it('keeps unknown expected outcomes designed-only instead of inventing an oracle', () => {
    const f = fact('FACT-1');
    const o = objective('OBJ-1', f.id, 'API', false);
    const result = applyTestCaseQualityGate({ requirement: requirement([f]), objectives: [o], testCases: [testCase()] });
    expect(result.assessments[0]).toMatchObject({ status: 'DESIGNED_ONLY', expectedOutcomeKnown: false, executable: false });
    expect(result.assessments[0].issues).toContainEqual(expect.objectContaining({ code: 'EXPECTED_OUTCOME_UNKNOWN' }));
  });

  it('keeps a deterministic assertion ready when an unrelated merged Objective is unknown', () => {
    const f = fact('FACT-1');
    const known = objective('OBJ-KNOWN', f.id, 'API');
    const unknown = objective('OBJ-UNKNOWN', f.id, 'AUTH', false);
    const candidate = testCase(f.id, known.id);
    candidate.source!.objectiveIds = [known.id, unknown.id];
    candidate.assertions[0].objectiveIds = [known.id];
    const result = applyTestCaseQualityGate({
      requirement: requirement([f]), objectives: [known, unknown], testCases: [candidate],
    });
    expect(result.assessments[0]).toMatchObject({ status: 'READY', expectedOutcomeKnown: true, executable: true });
  });

  it.each([
    { dimension: 'PERMISSION' as const, expectedIssue: 'ACTOR_CONTEXT_MISSING' },
    { dimension: 'DATA_ISOLATION' as const, expectedIssue: 'TARGET_CONTEXT_MISSING' },
  ])('blocks incomplete $dimension identity context', ({ dimension, expectedIssue }) => {
    const f = fact('FACT-1');
    const o = objective('OBJ-1', f.id, dimension);
    const candidate = testCase();
    if (dimension === 'DATA_ISOLATION') candidate.actor = { id: 'actor-a', userId: 'actor-a', role: 'USER' };
    const result = applyTestCaseQualityGate({ requirement: requirement([f]), objectives: [o], testCases: [candidate] });
    expect(result.assessments[0].status).toBe('BLOCKED');
    expect(result.assessments[0].issues).toContainEqual(expect.objectContaining({ code: expectedIssue }));
  });

  it('downgrades UI without an Executor and merges duplicate HTTP semantics', () => {
    const f = fact('FACT-1');
    const api = objective('OBJ-1', f.id, 'API');
    const ui = objective('OBJ-UI', f.id, 'UI');
    const first = testCase();
    const duplicate = testCase();
    duplicate.id = 'TEMP-2';
    const uiCase = testCase(f.id, ui.id);
    uiCase.id = 'TEMP-UI';
    uiCase.testType = 'UI';
    uiCase.protocol = undefined;
    uiCase.steps = [{ action: 'click save' }];
    const result = applyTestCaseQualityGate({
      requirement: requirement([f]), objectives: [api, ui], testCases: [first, duplicate, uiCase],
    });
    expect(result.deduplicatedCount).toBe(1);
    expect(result.testCases).toHaveLength(2);
    expect(result.assessments.find((item) => item.caseId === result.testCases[1].id)).toMatchObject({ status: 'DESIGNED_ONLY' });
  });
});
