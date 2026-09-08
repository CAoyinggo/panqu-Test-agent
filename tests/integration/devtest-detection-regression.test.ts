import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { runDevTest } from '../../src/devtest/devtest-runner.js';
import { EFFECTIVENESS_REQUIREMENT, EFFECTIVENESS_SAMPLES, startEffectivenessFixture } from '../fixtures/devtest-detection-fixture.js';

describe('DevTest detects independent seeded HTTP defects without healthy/environment false alerts', () => {
  it('retains actual binding evidence for a healthy built-in Scenario read instead of falsely blocking it', async () => {
    const fixture = await startEffectivenessFixture('none');
    const output = await mkdtemp(path.join(os.tmpdir(), 'devtest-binding-'));
    try {
      const result = await runDevTest({ markdown: EFFECTIVENESS_REQUIREMENT, documentId: 'binding-contract',
        project: 'binding-regression', baseUrl: fixture.baseUrl, environment: 'local', mode: 'SAFE',
        discoverProject: false, failFast: false, outDir: output, scenarioRuntime: { processors: [] } });
      expect(result.pipeline.report.executions.length).toBeGreaterThan(0);
      const bound = result.pipeline.report.executions.filter((execution) => execution.evidence.acceptanceCriteriaIds.includes('AC-1'));
      expect(bound.length).toBeGreaterThan(0);
      expect(bound.every((execution) => execution.status === 'PASS')).toBe(true);
      expect(bound.every((execution) => execution.evidence.binding?.valid === true)).toBe(true);
      // A separate source fact without an AC must still fail closed at the Scenario Gate.
      expect(result.pipeline.report.executions.filter((execution) => !execution.evidence.acceptanceCriteriaIds.length)
        .every((execution) => execution.status === 'BLOCKED' && !execution.executed)).toBe(true);
      expect(result.deliveryCoverage.cases.verified).toBeGreaterThan(0);
      expect(result.problems.some((problem) => problem.failureClass === 'PRODUCT_BUG')).toBe(false);
    } finally { await fixture.close(); await rm(output, { recursive: true, force: true }); }
  });

  it.each([false, true])('a failed read followed by PASS stays unverified (Scenario runtime=%s)', async (scenarioRuntime) => {
    let calls = 0;
    const server = createServer((request, response) => {
      // First read is environment preflight; the next real test read fails, its repeat succeeds.
      response.statusCode = request.url !== '/resources' ? 200 : ++calls === 2 ? 201 : 200;
      response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const output = await mkdtemp(path.join(os.tmpdir(), 'devtest-inconsistent-'));
    try {
      const result = await runDevTest({ markdown: '# 资源查询\n## API\nGET /resources\n无需认证。\n返回 200。\n## Acceptance Criteria\nAC-1 GET /resources 查询资源返回 HTTP 200。\n',
        documentId: 'unstable-read', project: 'unstable-read', mode: 'SAFE', environment: 'local',
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, discoverProject: false,
        outDir: output, timeoutMs: 1000, ...(scenarioRuntime ? { scenarioRuntime: { processors: [] } } : {}) });
      expect(calls, JSON.stringify(result.pipeline.report.executions)).toBe(3);
      expect(result.pipeline.report.executions[0].status, JSON.stringify(result.pipeline.report.executions)).toBe('FAIL');
      expect(result.pipeline.report.executions[0].evidence.response?.status).toBe(201);
      expect(result.pipeline.report.executions[0].evidence.readFailureConfirmation?.repeat.response?.status).toBe(200);
      expect(result.oracleResults[0]).toMatchObject({ verdict: 'UNKNOWN', transientSignal: 'READ_RESULT_INCONSISTENT' });
      expect(result.deliveryCoverage.cases.verified).toBe(0);
      expect(result.problems.some((problem) => problem.type === 'FLAKY_TEST')).toBe(true);
      expect(result.problems.some((problem) => problem.failureClass === 'PRODUCT_BUG')).toBe(false);
      expect(result.conclusion).not.toBe('READY');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(output, { recursive: true, force: true });
    }
  });

  it.each(EFFECTIVENESS_SAMPLES)('$id', async (sample) => {
    const fixture = await startEffectivenessFixture(sample.fault);
    const output = await mkdtemp(path.join(os.tmpdir(), 'devtest-detection-'));
    try {
      const result = await runDevTest({ markdown: EFFECTIVENESS_REQUIREMENT, documentId: 'resource-contract',
        project: 'detection-regression', baseUrl: fixture.baseUrl, environment: 'local', mode: 'SAFE',
        discoverProject: false, failFast: false, timeoutMs: 1000, maxCases: 50, deep: true, outDir: output });
      const bugs = result.problems.filter((problem) => problem.failureClass === 'PRODUCT_BUG');
      if (sample.target) {
        expect(bugs.length).toBeGreaterThan(0);
        expect(bugs.some((problem) => result.pipeline.report.executions.some((execution) =>
          problem.affectedCases.includes(execution.caseId) && execution.executed
          && execution.evidence.assertions.some((assertion) => !assertion.pass
            && (sample.target === 'STATUS_CODE' ? assertion.type === 'STATUS_CODE' : assertion.path === sample.target))))).toBe(true);
        expect(bugs.some((problem) => problem.reproducible)).toBe(true);
        expect(result.pipeline.report.executions.some((execution) => execution.evidence.readFailureConfirmation?.status === 'REPRODUCED')).toBe(true);
      } else {
        expect(bugs).toEqual([]);
        if (['gateway', 'disconnect'].includes(sample.fault)) {
          expect(result.oracleResults.every((oracle) => oracle.verdict !== 'PASS')).toBe(true);
        } else {
          expect(result.oracleResults.every((oracle) => oracle.verdict === 'PASS')).toBe(true);
          expect(result.pipeline.report.executions.every((execution) => !execution.evidence.readFailureConfirmation)).toBe(true);
        }
      }
      expect(result.executionEstimate.readFailureConfirmation?.enabled).toBe(true);
    } finally { await fixture.close(); await rm(output, { recursive: true, force: true }); }
  });
});
