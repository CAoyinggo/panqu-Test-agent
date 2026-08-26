import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';
import { buildBaselineDiff, loadDevTestBaseline, reconcileDevTestProblems, rerunCaseIds, saveDevTestBaseline,
  type DevTestBaselineSnapshot } from '../../../src/devtest/baseline.js';

function testCase(fingerprint: string): TestCase {
  return {
    id: 'CASE-1', feature: 'demo', name: 'read', priority: 'P0', testType: 'API',
    executionMode: 'EXECUTABLE', protocol: 'HTTP', tags: [], steps: [], assertions: [],
    contractDependencies: [{ contractId: 'api.demo', version: 'v1', fingerprint }],
  };
}

const baseline: DevTestBaselineSnapshot = {
  runId: 'RUN-1', requirementHash: 'hash',
  problems: [{ signature: 'sig', id: 'P001', affectedCases: ['CASE-1'] }],
  cases: [{ caseId: 'CASE-1', status: 'PASS', contracts: [{ contractId: 'api.demo', fingerprint: 'fp-1' }] }],
  regressionCaseIds: ['CASE-1'],
};

const recurringProblem = {
  id: 'P000', type: 'TEST_FAILED' as const, severity: 'HIGH' as const, dimension: 'API' as const,
  message: 'authorization failed again', affectedCases: ['CASE-1'], reasonCode: 'TEST_FAILED',
  rootCause: 'AUTHORIZATION_POLICY', failureClass: 'PRODUCT_BUG' as const,
};

describe('DevTest precise rerun', () => {
  it('全部 PASS 且 Contract 未变时不回退重跑全量', () => {
    const noProblems = { ...baseline, problems: [] };
    expect(rerunCaseIds(noProblems, [testCase('fp-1')])).toEqual([]);
  });

  it('Contract Fingerprint 变化时只加入受影响 Case', () => {
    expect(rerunCaseIds(baseline, [testCase('fp-2')])).toEqual(['CASE-1']);
  });

  it('支持问题 ID、失败、阻断和回归筛选', () => {
    expect(rerunCaseIds(baseline, [testCase('fp-1')], 'P001')).toEqual(['CASE-1']);
    expect(rerunCaseIds(baseline, [testCase('fp-1')], 'regression')).toEqual(['CASE-1']);
    expect(rerunCaseIds(baseline, [testCase('fp-1')], 'blocked')).toEqual([]);
  });

  it('同一 Requirement 文件路径跨内容版本保留可比较 Baseline', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'devtest-baseline-source-'));
    await saveDevTestBaseline({ outDir, markdown: '# v1', sourceKey: '/requirements/demo.md', runId: 'RUN-V1',
      cases: [{ caseId: 'CASE-1', status: 'PASS' }], problems: [], requirementAcIds: ['AC-1'] });
    const loaded = await loadDevTestBaseline(outDir, '# v2', '/requirements/demo.md');
    expect(loaded).toEqual(expect.objectContaining({ runId: 'RUN-V1', requirementAcIds: ['AC-1'] }));
  });

  it('FIXED 根因再次出现时复用问题 ID 并标记 REOPENED', () => {
    const fixed: DevTestBaselineSnapshot = { ...baseline,
      cases: [{ caseId: 'CASE-1', status: 'PASS', verified: true, evidenceComplete: true }],
      problems: [{ signature: 'TEST_FAILED|TEST_FAILED|API|AUTHORIZATION_POLICY',
      id: 'P007', affectedCases: ['CASE-1'], lifecycle: 'FIXED', failureClass: 'PRODUCT_BUG', rootCause: 'AUTHORIZATION_POLICY' }] };
    const [reopened] = reconcileDevTestProblems([recurringProblem], fixed);
    expect(reopened).toEqual(expect.objectContaining({ id: 'P007', lifecycle: 'REOPENED' }));
  });

  it.each([
    ['legacy PASS without verified', { caseId: 'CASE-1', status: 'PASS' }],
    ['PASS with incomplete Evidence', { caseId: 'CASE-1', status: 'PASS', verified: true, evidenceComplete: false }],
  ])('%s 不得触发 REGRESSION 或 REOPENED', (_name, previousCase) => {
    const snapshot: DevTestBaselineSnapshot = { ...baseline, cases: [previousCase], problems: [{
      signature: 'TEST_FAILED|TEST_FAILED|API|AUTHORIZATION_POLICY', id: 'P007', affectedCases: ['CASE-1'],
      lifecycle: 'FIXED', failureClass: 'PRODUCT_BUG', rootCause: 'AUTHORIZATION_POLICY',
    }] };
    const [problem] = reconcileDevTestProblems([recurringProblem], snapshot);
    expect(problem.lifecycle).not.toBe('REOPENED');
    expect(problem.lifecycle).not.toBe('REGRESSION');

    const diff = buildBaselineDiff({ baseline: snapshot, currentRunId: 'RUN-2',
      cases: [{ caseId: 'CASE-1', status: 'FAIL', verified: true, evidenceComplete: true }], problems: [problem] });
    expect(diff.regressions).toEqual([]);
  });

  it.each([
    ['legacy PASS without verified', { caseId: 'CASE-1', status: 'PASS' }],
    ['PASS with incomplete Evidence', { caseId: 'CASE-1', status: 'PASS', verified: true, evidenceComplete: false }],
  ])('%s 不得把历史问题标记 FIXED', (_name, currentCase) => {
    const diff = buildBaselineDiff({ baseline, currentRunId: 'RUN-2', cases: [currentCase], problems: [] });
    expect(diff.resolvedProblems).toEqual([]);
    expect(diff.problemLifecycle).not.toContainEqual(expect.objectContaining({ problemId: 'P001', status: 'FIXED' }));
  });

  it('verified=true + evidenceComplete=true 的 PASS 才能作为 Regression/FIXED 权威基线', () => {
    const authoritative: DevTestBaselineSnapshot = { ...baseline,
      cases: [{ caseId: 'CASE-1', status: 'PASS', verified: true, evidenceComplete: true }], problems: [] };
    const [regression] = reconcileDevTestProblems([recurringProblem], authoritative);
    expect(regression.lifecycle).toBe('REGRESSION');
    const regressionDiff = buildBaselineDiff({ baseline: authoritative, currentRunId: 'RUN-2',
      cases: [{ caseId: 'CASE-1', status: 'FAIL', verified: true, evidenceComplete: true }], problems: [regression] });
    expect(regressionDiff.regressions).toEqual(['CASE-1']);

    const fixedDiff = buildBaselineDiff({ baseline, currentRunId: 'RUN-2',
      cases: [{ caseId: 'CASE-1', status: 'PASS', verified: true, evidenceComplete: true }], problems: [] });
    expect(fixedDiff.resolvedProblems).toEqual(['P001']);
    expect(fixedDiff.problemLifecycle).toContainEqual({ problemId: 'P001', status: 'FIXED' });
  });
});
