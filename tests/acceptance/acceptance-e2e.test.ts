import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isDesignedOnlyCase } from '../../src/agents/test-design/testcase-schema.js';
import { writeAcceptanceReports } from '../../src/acceptance/acceptance-report.js';
import { runAcceptancePipeline } from '../../src/acceptance/acceptance-pipeline.js';
import { startFakeApiServer, type FakeApiServer } from './helpers/fake-api-server.js';
import { localAcceptanceSafetyPolicy } from './helpers/acceptance-safety.js';

const fixture = fs.readFileSync(fileURLToPath(new URL('./fixtures/user-profile.md', import.meta.url)), 'utf8');
let server: FakeApiServer | undefined;
let outputDir: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
  outputDir = undefined;
});

describe('development acceptance full E2E', () => {
  it('runs Markdown → IR → AC → TestPoint → Case → real HTTP → assertion → outcome → report', async () => {
    server = await startFakeApiServer();
    const execution = await runAcceptancePipeline({
      markdown: fixture,
      project: 'test-flow',
      documentId: 'user-profile.md',
      baseUrl: server.baseUrl,
      safetyPolicy: localAcceptanceSafetyPolicy(['PUT /api/users/{id}']),
      actorHeaders: {
        'user-a': { Authorization: 'Bearer token-user-a' },
        'user-b': { Authorization: 'Bearer token-user-b' },
        admin: { Authorization: 'Bearer token-admin' },
        'tenant-b-user': { Authorization: 'Bearer token-tenant-b-user' },
      },
      environment: 'local',
    });

    expect(execution.requirement.acceptanceCriteria.map((criterion) => criterion.criterionId)).toEqual([
      'AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7',
    ]);
    expect(execution.objectives.length).toBeGreaterThan(0);
    expect(execution.scenarios.length).toBeGreaterThan(0);
    expect(execution.testPoints.length).toBeGreaterThan(0);
    expect(execution.testPoints.length).toBeLessThanOrEqual(execution.objectives.length);

    const factIds = new Set(execution.requirement.factLedger.map((fact) => fact.id));
    const objectiveIds = new Set(execution.objectives.map((objective) => objective.id));
    const pointIds = new Set(execution.testPoints.map((point) => point.id));
    expect(execution.testCases.every((testCase) => testCase.source?.requirementId === execution.requirement.id)).toBe(true);
    expect(execution.testCases.every((testCase) => pointIds.has(testCase.source?.testPointId ?? ''))).toBe(true);
    expect(execution.testCases.every((testCase) => testCase.source?.factIds?.length
      && testCase.source.factIds.every((id) => factIds.has(id)))).toBe(true);
    expect(execution.testCases.every((testCase) => testCase.source?.objectiveIds?.length
      && testCase.source.objectiveIds.every((id) => objectiveIds.has(id)))).toBe(true);

    const executableCases = execution.testCases.filter((testCase) => !isDesignedOnlyCase(testCase));
    const designedOnlyCases = execution.testCases.filter(isDesignedOnlyCase);
    const qualityBlockedCases = designedOnlyCases.filter((testCase) =>
      (testCase.metadata?.caseQuality as { status?: string } | undefined)?.status === 'BLOCKED');
    const qualityDesignedOnlyCases = designedOnlyCases.filter((testCase) => !qualityBlockedCases.includes(testCase));
    const resultByCase = new Map(execution.results.map((result) => [result.caseId, result]));
    expect(executableCases.length).toBeGreaterThan(0);
    expect(designedOnlyCases.length).toBeGreaterThan(0);
    expect(execution.results).toHaveLength(execution.testCases.length);
    expect(server.requests).toHaveLength(executableCases.length);
    expect(executableCases.every((testCase) => {
      const result = resultByCase.get(testCase.id);
      return result?.executed === true
        && result.processorInvoked === true
        && result.status === 'PASS'
        && result.pass === true
        && Boolean(result.evidence.request)
        && Boolean(result.evidence.response)
        && result.evidence.assertions.length > 0
        && result.evidence.assertions.every((assertion) => assertion.pass === true);
    })).toBe(true);
    expect(designedOnlyCases.every((testCase) => {
      const result = resultByCase.get(testCase.id);
      const expectedStatus = qualityBlockedCases.includes(testCase) ? 'BLOCKED' : 'NOT_EXECUTED';
      return result?.executed === false
        && result.processorInvoked === false
        && result.status === expectedStatus
        && result.pass === false
        && !result.evidence.request
        && !result.evidence.response
        && result.evidence.assertions.length === 0;
    })).toBe(true);
    expect(execution.outcome).toMatchObject({
      total: execution.testCases.length,
      passed: executableCases.length,
      executed: false,
    });
    expect(execution.defects).toHaveLength(0);
    expect(execution.report.summary).toMatchObject({
      total: execution.testCases.length,
      designed: execution.testCases.length,
      executable: executableCases.length,
      designedOnly: designedOnlyCases.length,
      executed: executableCases.length,
      passed: executableCases.length,
      failed: 0,
      blocked: qualityBlockedCases.length,
      notExecuted: qualityDesignedOnlyCases.length,
    });
    const initialExecutionCoverage = Math.round((executableCases.length / execution.testCases.length) * 1000) / 10;
    expect(execution.report.coverage).toMatchObject({
      objectiveCoverage: 100,
      caseCoverage: 100,
      executionCoverage: initialExecutionCoverage,
      evidenceCoverage: initialExecutionCoverage,
      operationContractEvidenceCoverage: 100,
    });
    expect(execution.report.coverage.factCoverage).not.toBe('NOT_AVAILABLE');
    expect(execution.report.coverage.uncoveredFacts.length).toBeGreaterThan(0);
    expect(execution.report.coverage.unverifiedFacts.length).toBeGreaterThan(0);
    expect(execution.report.validationStage).toBe('INITIAL_VALIDATION');
    expect(execution.report.operationContractConclusion).toBe('PASS');
    expect(execution.report.conclusion).toBe(qualityBlockedCases.length ? 'BLOCKED' : 'PARTIAL');
    expect(execution.rendered.markdown).toContain('AC-7');
    expect(execution.rendered.markdown).toContain('## 9. 测试覆盖');
    expect(execution.rendered.markdown).toContain('Requirement Fact Design Coverage');
    expect(execution.rendered.markdown).toContain('Requirement Fact Verification Coverage');
    expect(execution.rendered.markdown).toContain('## 11. 回归建议');
    expect(execution.rendered.html).toContain('<h1>智能测试报告</h1>');
    expect(execution.rendered.html).toContain(`INITIAL_VALIDATION：${qualityBlockedCases.length ? 'BLOCKED' : 'PARTIAL'}`);
    expect(JSON.parse(execution.rendered.json)).toMatchObject({
      validationStage: 'INITIAL_VALIDATION',
      conclusion: qualityBlockedCases.length ? 'BLOCKED' : 'PARTIAL',
      operationContractConclusion: 'PASS',
    });

    for (const criterionId of ['AC-2', 'AC-3', 'AC-4']) {
      const criterionCases = execution.testCases.filter((testCase) => testCase.source?.acceptanceCriteriaIds.includes(criterionId));
      expect(criterionCases.length).toBeGreaterThan(0);
      expect(criterionCases.every(isDesignedOnlyCase)).toBe(true);
      // DESIGNED_ONLY may retain a sourced deterministic oracle (for example
      // an explicit 400/401 status) as design intent, but it must also carry a
      // human-readable design expectation and must never expose runtime evidence.
      expect(criterionCases.every((testCase) =>
        testCase.assertions.some((assertion) => assertion.type === 'DESIGN_EXPECTATION'))).toBe(true);
      expect(criterionCases.every((testCase) => resultByCase.get(testCase.id)?.status === 'NOT_EXECUTED')).toBe(true);
    }

    const uiCases = execution.testCases.filter((testCase) => testCase.testType === 'UI');
    expect(uiCases.length).toBeGreaterThan(0);
    expect(uiCases.every(isDesignedOnlyCase)).toBe(true);
    expect(uiCases.every((testCase) => resultByCase.get(testCase.id)?.status === 'NOT_EXECUTED')).toBe(true);

    const ownUserCase = executableCases.find((testCase) => testCase.source?.acceptanceCriteriaIds.includes('AC-1'));
    expect(ownUserCase).toMatchObject({ actor: { userId: 'user-a', tenantId: 'tenant-a' }, data: { targetId: 'user-a' } });
    expect(resultByCase.get(ownUserCase!.id)?.evidence.response?.status).toBe(200);
    const adminCase = executableCases.find((testCase) => testCase.source?.acceptanceCriteriaIds.includes('AC-6'));
    expect(adminCase).toMatchObject({ actor: { userId: 'admin', role: 'ADMIN' } });
    expect(adminCase?.data?.targetId).not.toBe(adminCase?.actor?.userId);
    expect(resultByCase.get(adminCase!.id)?.evidence.response?.status).toBe(200);

    // A rejected mutation is not proven by HTTP 403 alone: it also needs
    // post-condition evidence that no cross-user/cross-tenant write occurred.
    for (const criterionId of ['AC-5', 'AC-7']) {
      const deniedMutationCases = execution.testCases.filter((testCase) =>
        testCase.source?.acceptanceCriteriaIds.includes(criterionId));
      expect(deniedMutationCases.length).toBeGreaterThan(0);
      expect(deniedMutationCases.every(isDesignedOnlyCase)).toBe(true);
      expect(deniedMutationCases.some((testCase) =>
        String(testCase.design?.reason).includes('NON_MUTATION_EVIDENCE_UNAVAILABLE'))).toBe(true);
      expect(deniedMutationCases.every((testCase) => {
        const result = resultByCase.get(testCase.id);
        return result?.status === 'NOT_EXECUTED'
          && result.executed === false
          && result.processorInvoked === false
          && !result.evidence.request;
      })).toBe(true);
    }

    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-flow-acceptance-'));
    const files = await writeAcceptanceReports(execution.report, outputDir, 'user-profile');
    expect(Object.values(files).every((file) => fs.existsSync(file))).toBe(true);
  });
});
