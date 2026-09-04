import { describe, expect, it } from 'vitest';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { applyTestCaseQualityGate } from '../../src/acceptance/test-case-quality-gate.js';
import { checkTestCaseStandardization } from '../../src/acceptance/standardization-gate.js';
import { buildAcceptanceTestDesign, type TestDimension } from '../../src/acceptance/test-objective.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';

const requirements = [
  {
    id: 'USER-RESOURCE-CRUD',
    markdown: `# User Resource
## Actor
- ID: user-a
## Role
USER
## Tenant
- ID: tenant-a
## API
POST /resources
GET /resources/{resourceId}
PUT /resources/{resourceId}
DELETE /resources/{resourceId}
## Acceptance Criteria
AC-1 user-a 创建自己拥有的 Resource 返回 HTTP 201。
AC-2 user-a 查询并修改 Resource 返回 HTTP 200。
AC-3 user-a 删除 Resource 返回 HTTP 204，之后查询返回 HTTP 404。
AC-4 其他用户不得修改该 Resource，拒绝后 Resource 和关联副作用保持不变。`,
    expected: ['FUNCTIONAL', 'API', 'PERMISSION'] as TestDimension[],
  },
  {
    id: 'ORDER-STATE',
    markdown: `# Order State
## Actor
- ID: user-a
## Role
USER
## API
POST /orders
POST /orders/{orderId}/transition
GET /orders/{orderId}
## Acceptance Criteria
AC-1 创建 Order 返回 HTTP 201，状态从 NEW 变为 PENDING。
AC-2 状态操作使 Order 从 PENDING 变为 COMPLETED，并产生一次审计记录。
AC-3 重复状态操作必须幂等，不重复产生审计记录。
AC-4 并发状态操作只能形成一次有效状态流转。
AC-5 失败时恢复到 PENDING，禁止产生未声明副作用。`,
    expected: ['API', 'STATE', 'BUSINESS_RULE', 'SIDE_EFFECT'] as TestDimension[],
  },
  {
    id: 'MULTI-TENANT-ROLE',
    markdown: `# Multi Tenant Resource
## Actors
| actorId | userId | role | tenantId | projectId | tokenRef |
| --- | --- | --- | --- | --- | --- |
| user-a | user-a | USER | tenant-a | project-a | actor-a-ref |
| admin-a | admin-a | ADMIN | tenant-a | project-a | admin-a-ref |
| user-b | user-b | USER | tenant-b | project-b | actor-b-ref |
## API
POST /resources
GET /resources/{resourceId}
PUT /resources/{resourceId}
## Acceptance Criteria
AC-1 user-a 在 tenant-a/project-a 创建并拥有 Resource，返回 HTTP 201。
AC-2 admin-a 可按 Role 读取同 Tenant 和 Project 的 Resource，返回 HTTP 200。
AC-3 user-b 跨 Tenant 和 Project 访问必须拒绝，返回 HTTP 403。
AC-4 拒绝修改后 Resource、Owner 和关联资源均保持不变。`,
    expected: ['API', 'PERMISSION', 'DATA_ISOLATION'] as TestDimension[],
  },
] as const;

describe('同一通用标准复用三类完全不同的 Requirement', () => {
  for (const sample of requirements) {
    it(`${sample.id}: Template Reusability / Business Neutrality / Traceability / No Leakage`, () => {
      const requirement = parseAcceptanceRequirement(sample.markdown, { documentId: `${sample.id}.md` });
      const design = buildAcceptanceTestDesign(requirement);
      const cases = generateAcceptanceApiCases(requirement, generateTestPoints(requirement, design));
      const gate = applyTestCaseQualityGate({ requirement, objectives: design.objectives, testCases: cases });
      const selected = new Set(design.dimensionDecisions
        .filter((decision) => decision.applicability === 'REQUIRED').map((decision) => decision.dimension));

      expect(sample.expected.every((dimension) => selected.has(dimension)), [...selected].join(',')).toBe(true);
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.every((testCase) => testCase.schemaVersion === 'TEST_CASE_V2')).toBe(true);
      expect(cases.every((testCase) => Boolean(testCase.source?.factIds?.length && testCase.source?.objectiveIds?.length))).toBe(true);
      expect(cases.every((testCase) => testCase.businessScenario?.flow.steps.length)).toBe(true);
      expect(cases.flatMap(checkTestCaseStandardization)).toEqual([]);
      expect(gate.assessments.every((assessment) => assessment.dimensions.traceable && assessment.dimensions.businessRelevant)).toBe(true);
    });
  }

  it('Generator 根据 Requirement 选择不同能力集合，而不是套固定功能模板', () => {
    const selections = requirements.map((sample) => {
      const requirement = parseAcceptanceRequirement(sample.markdown);
      const design = buildAcceptanceTestDesign(requirement);
      return [...new Set(design.dimensionDecisions.filter((item) => item.applicability === 'REQUIRED')
        .map((item) => item.dimension))].sort();
    });
    expect(new Set(selections.map((item) => item.join('|'))).size).toBe(3);
  });

  it('STANDARDIZATION_VIOLATION 会阻断被标记为单功能模板来源的 Case', () => {
    const requirement = parseAcceptanceRequirement(requirements[0].markdown);
    const design = buildAcceptanceTestDesign(requirement);
    const candidate = generateAcceptanceApiCases(requirement, generateTestPoints(requirement, design))[0];
    candidate.metadata = { ...candidate.metadata, templateClassification: 'SINGLE_FEATURE' };
    const gate = applyTestCaseQualityGate({ requirement, objectives: design.objectives, testCases: [candidate] });
    expect(gate.assessments[0]).toMatchObject({ status: 'BLOCKED' });
    expect(gate.assessments[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'STANDARDIZATION_VIOLATION', disposition: 'BLOCKED' }),
    ]));
  });
});
