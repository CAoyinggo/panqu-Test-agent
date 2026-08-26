import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { applyTestCaseQualityGate } from '../../src/acceptance/test-case-quality-gate.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';

const REQUIREMENT = `# 查询订单

GET /orders/{id}
该接口无需认证

| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | order-1 |

返回 200

AC-1 GET /orders/{id} 查询订单成功并返回 200。`;

function compile() {
  const requirement = parseAcceptanceRequirement(REQUIREMENT, { documentId: 'authority-integrity.md' });
  const design = buildAcceptanceTestDesign(requirement);
  const points = generateTestPoints(requirement, design);
  const cases = generateAcceptanceApiCases(requirement, points);
  const testCase = cases.find((candidate) => candidate.executionMode === 'EXECUTABLE'
    && candidate.source?.apiOperationKey === 'GET /orders/{id}'
    && candidate.source.acceptanceCriteriaIds.includes('AC-1'));
  expect(testCase, 'fixture must produce an executable V2 HTTP Case').toBeDefined();
  return { requirement, objectives: design.objectives, testCase: structuredClone(testCase!) };
}

function expectBlocked(input: ReturnType<typeof compile>): void {
  const result = applyTestCaseQualityGate({
    requirement: input.requirement,
    objectives: input.objectives,
    testCases: [input.testCase],
  });

  expect(result.assessments[0]).toMatchObject({
    status: 'BLOCKED',
    executable: false,
  });
  expect(result.testCases[0]).toMatchObject({
    executionMode: 'DESIGNED_ONLY',
    protocol: undefined,
  });
  expect(result.testCases[0].steps.every((step) => step.execution === 'PLANNED')).toBe(true);
}

describe('TEST_CASE_V2 authority and expected-oracle integrity', () => {
  it.each([
    { label: 'INFERENCE epistemic fact', epistemicType: 'INFERENCE' as const },
    { label: 'HYPOTHESIS epistemic fact', epistemicType: 'HYPOTHESIS' as const },
    { label: 'UNKNOWN fact provenance', provenance: 'UNKNOWN' as const },
    { label: 'INFERRED fact provenance', provenance: 'INFERRED' as const },
  ])('fails closed for a linked $label even when downstream structures forge REQUIREMENT/EXPLICIT authority', (mutation) => {
    const compiled = compile();
    const linkedFactId = compiled.testCase.source!.factIds![0];
    const linkedFact = compiled.requirement.factLedger.find((fact) => fact.id === linkedFactId);
    expect(linkedFact).toBeDefined();

    if (mutation.epistemicType) linkedFact!.epistemicType = mutation.epistemicType;
    if (mutation.provenance) linkedFact!.provenance = mutation.provenance;

    // These fields are deliberately forged. The authority decision must be made
    // from the linked Fact Ledger entry, not from Case/Objective self-claims.
    compiled.testCase.source!.sourceType = 'REQUIREMENT';
    compiled.testCase.source!.provenance = 'EXPLICIT';
    compiled.testCase.businessScenario!.provenance = 'EXPLICIT';
    for (const assertion of compiled.testCase.assertions) {
      assertion.sourceType = 'REQUIREMENT';
      assertion.provenance = 'EXPLICIT';
    }
    for (const objective of compiled.objectives.filter((item) => item.factIds.includes(linkedFactId))) {
      objective.sourceType = 'REQUIREMENT';
      objective.provenance = 'EXPLICIT';
    }

    expectBlocked(compiled);
  });

  it('blocks when expected.response.status contradicts the STATUS_CODE Oracle assertion', () => {
    const compiled = compile();
    const statusAssertion = compiled.testCase.assertions.find((assertion) => assertion.type === 'STATUS_CODE');
    expect(statusAssertion?.expected).toBe(200);

    compiled.testCase.expected!.status = '403';
    compiled.testCase.expected!.response = {
      ...compiled.testCase.expected!.response,
      status: 403,
    };

    expectBlocked(compiled);
  });

  it.each([
    {
      label: 'state expectation',
      mutate: (testCase: TestCase) => {
        testCase.expected!.state = {
          expectation: 'UNCHANGED',
          description: '查询前后订单持久化状态不得变化',
        };
      },
    },
    {
      label: 'side-effect expectation',
      mutate: (testCase: TestCase) => {
        testCase.expected!.sideEffects = [{
          kind: 'BILLING',
          action: 'DECREASE',
          expectation: 'FORBIDDEN',
          description: '查询订单不得扣费',
        }];
      },
    },
  ])('blocks a non-UNKNOWN $label without a corresponding assertion and evidence contract', ({ mutate }) => {
    const compiled = compile();
    expect(compiled.testCase.assertions.every((assertion) =>
      assertion.channel !== 'STATE' && assertion.channel !== 'SIDE_EFFECT')).toBe(true);
    expect(compiled.testCase.evidenceRequirements?.every((evidence) =>
      evidence.channel === 'API_REQUEST' || evidence.channel === 'API_RESPONSE')).toBe(true);

    mutate(compiled.testCase);

    expectBlocked(compiled);
  });
});
