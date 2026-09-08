import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDslExecutable, toTaskDef, validateTestCase } from '../../src/agents/test-design/testcase-schema.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';

const fixture = fs.readFileSync(fileURLToPath(new URL('./fixtures/user-profile.md', import.meta.url)), 'utf8');

describe('Acceptance Test Point / API DSL', () => {
  it('将 AC 去重转换为可追溯 Test Point', () => {
    const requirement = parseAcceptanceRequirement(fixture, { documentId: 'user-profile.md' });
    const originalCriteria = requirement.acceptanceCriteria.map((criterion) => criterion.criterionId);
    const duplicatedCriterion = requirement.acceptanceCriteria.find((criterion) => criterion.criterionId === 'AC-1');
    expect(duplicatedCriterion).toBeDefined();
    requirement.acceptanceCriteria.push({ ...duplicatedCriterion! });
    const points = generateTestPoints(requirement);
    expect(points.every((point) => point.requirementId === requirement.id && point.factIds.length > 0)).toBe(true);
    for (const criterionId of originalCriteria) {
      const traced = points.filter((point) => point.acceptanceCriteriaIds.includes(criterionId));
      expect(traced.length, `${criterionId} must trace to at least one Objective`).toBeGreaterThan(0);
      expect(new Set(traced.map((point) => point.objectiveId)).size).toBe(traced.length);
    }
    const isolation = points.find((point) =>
      point.acceptanceCriteriaIds.includes('AC-7') && point.category === 'DATA_ISOLATION');
    expect(isolation).toBeDefined();
  });

  it('无 AC 时从 API 契约保留基础 Test Point', () => {
    const requirement = parseAcceptanceRequirement('# Ping\n## API\nGET /api/ping');
    const points = generateTestPoints(requirement);
    const contractPoint = points.find((point) =>
      point.category === 'API' && point.apiBinding?.operationKey === 'GET /api/ping');
    expect(contractPoint).toMatchObject({
      requirementId: requirement.id,
      category: 'API',
      acceptanceCriteriaIds: [],
      objective: 'GET /api/ping',
      sourceType: 'CONTRACT',
    });
    expect(contractPoint?.factIds.length).toBeGreaterThan(0);
  });

  it('生成 API、参数、权限、隔离用例并保留 Requirement→TP→AC 追溯', () => {
    const requirement = parseAcceptanceRequirement(fixture, { documentId: 'user-profile.md' });
    const points = generateTestPoints(requirement);
    const cases = generateAcceptanceApiCases(requirement, points);

    expect(cases.some((testCase) => testCase.testType === 'PARAMETER')).toBe(true);
    expect(cases.some((testCase) => testCase.testType === 'PERMISSION')).toBe(true);
    expect(cases.some((testCase) => testCase.testType === 'DATA_ISOLATION')).toBe(true);
    expect(cases.every((testCase) => testCase.source?.requirementId === requirement.id)).toBe(true);
    expect(cases.every((testCase) => (testCase.source?.objectiveIds?.length ?? 0) > 0
      && (testCase.source?.factIds?.length ?? 0) > 0)).toBe(true);
    for (const criterion of requirement.acceptanceCriteria) {
      expect(cases.some((testCase) => testCase.source?.acceptanceCriteriaIds.includes(criterion.criterionId))).toBe(true);
    }

    const executableCases = cases.filter((testCase) => testCase.executionMode === 'EXECUTABLE');
    const designedOnlyCases = cases.filter((testCase) => testCase.executionMode === 'DESIGNED_ONLY');
    expect(executableCases.length).toBeGreaterThan(0);
    expect(designedOnlyCases.length).toBeGreaterThan(0);
    expect(executableCases.every((testCase) => checkDslExecutable(testCase).executable)).toBe(true);
    expect(executableCases.every((testCase) => toTaskDef(testCase).scene === 'api')).toBe(true);
    expect(designedOnlyCases.every((testCase) => {
      const check = checkDslExecutable(testCase);
      return check.executable === false && check.problems.some((problem) => problem.includes('DESIGNED_ONLY'));
    })).toBe(true);

    for (const parameterName of ['age', 'nickname']) {
      const parameterPoints = points.filter((point) => point.parameterNames.includes(parameterName)
        && (point.dimension === 'PARAMETER_VALIDATION' || point.dimension === 'BOUNDARY'));
      expect(parameterPoints.length, `missing Objective for ${parameterName}`).toBeGreaterThan(0);
      const objectiveIds = new Set(parameterPoints.map((point) => point.objectiveId));
      const parameterCases = cases.filter((testCase) =>
        (testCase.testType === 'PARAMETER' || testCase.testType === 'BOUNDARY')
        && testCase.source?.objectiveIds?.some((objectiveId) => objectiveIds.has(objectiveId)));
      expect(parameterCases.length, `missing Case for ${parameterName}`).toBeGreaterThan(0);
      const designedOnly = parameterCases.filter((testCase) => testCase.executionMode === 'DESIGNED_ONLY');
      const executable = parameterCases.filter((testCase) => testCase.executionMode === 'EXECUTABLE');
      expect(designedOnly.every((testCase) =>
        /ACTOR_CONTEXT_INCOMPLETE|NON_MUTATION_EVIDENCE_UNAVAILABLE/.test(String(testCase.design?.reason)))).toBe(true);
      expect(executable.every((testCase) =>
        testCase.actor?.provenance === 'CONFIGURED'
        && testCase.actor.id === testCase.data?.targetId
        && checkDslExecutable(testCase).executable)).toBe(true);
      if (parameterName === 'nickname') expect(executable.length).toBeGreaterThan(0);
      else expect(designedOnly.length).toBeGreaterThan(0);
    }
  });

  it('协议 Schema 接受 API Case，并拒绝将设计态 Case 当成可执行', async () => {
    const apiCase = await validateTestCase({
      id: 'API-X', feature: 'profile', name: 'GET', priority: 'P0', tags: [],
      testType: 'API', executionMode: 'EXECUTABLE', protocol: 'HTTP',
      steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/api/profile', query: { verbose: true } }],
      assertions: [{ type: 'STATUS_CODE', expected: 200 }],
    });
    expect(checkDslExecutable(apiCase)).toEqual({ executable: true, problems: [] });
    for (const executionMode of ['DESIGNED_ONLY', 'DESCRIPTIVE_ONLY'] as const) {
      expect(checkDslExecutable({ ...apiCase, executionMode })).toEqual({
        executable: false, problems: [`用例明确标记为 ${executionMode}`],
      });
    }
  });
});
