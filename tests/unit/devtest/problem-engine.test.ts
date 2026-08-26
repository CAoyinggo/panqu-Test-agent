import { describe, expect, it } from 'vitest';
import type { AcceptanceReport } from '../../../src/acceptance/acceptance-report.js';
import type { ContractPreflight } from '../../../src/contracts/contract-gate.js';
import { buildDevTestProblems, deriveDevTestConclusion } from '../../../src/devtest/problem-engine.js';

function reportOf(input: {
  statuses?: Array<{ id: string; type: string; priority?: string; status: string; executed?: boolean }>;
} = {}): AcceptanceReport {
  const statuses = input.statuses ?? [
    { id: 'API-1', type: 'API', priority: 'P0', status: 'PASS', executed: true },
    { id: 'PARAM-1', type: 'PARAMETER', priority: 'P1', status: 'BLOCKED', executed: false },
    { id: 'UI-1', type: 'UI', priority: 'P1', status: 'NOT_EXECUTED', executed: false },
  ];
  const count = (status: string) => statuses.filter((item) => item.status === status).length;
  return {
    conclusion: count('FAIL') ? 'FAIL' : count('BLOCKED') || count('NOT_EXECUTED') ? 'PARTIAL' : 'PASS',
    summary: {
      total: statuses.length, designed: statuses.length, executable: statuses.length,
      designedOnly: 0, executed: statuses.filter((item) => item.executed).length,
      passed: count('PASS'), failed: count('FAIL'), blocked: count('BLOCKED'),
      notExecuted: count('NOT_EXECUTED'), timedOut: 0, cancelled: 0, unverified: 0,
    },
    cases: statuses.map((item) => ({
      caseId: item.id, testType: item.type, priority: item.priority ?? 'P1',
      executionStatus: item.status, executionMode: 'EXECUTABLE', evidence: { acceptanceCriteriaIds: [] },
      qualityIssues: [], sourceFactIds: [], sourceObjectiveIds: [],
    })),
    executions: statuses.map((item) => ({
      caseId: item.id, status: item.status, executed: item.executed === true,
      evidence: item.status === 'PASS' ? { request: {}, response: {}, assertions: [{ pass: true }] } : { assertions: [] },
    })),
    defects: [], observationGaps: [], bindingIssues: [],
    coverage: { unverifiedFacts: [], uncoveredFacts: [] }, warnings: [],
  } as unknown as AcceptanceReport;
}

function contracts(status: 'VALID' | 'STALE' | 'CONTRACT_DRIFT' | 'BLOCKED', resolutionStatus = 'RESOLVED'): ContractPreflight {
  return {
    validation: { status, dependencies: [], reasons: status === 'VALID' ? [] : [`api.demo=${resolutionStatus}`] },
    dependencies: [],
    resolutions: [{
      status: resolutionStatus, query: { id: 'api.demo' }, candidates: [], conflicts: [], sources: [],
      reason: resolutionStatus === 'RESOLVED' ? undefined : '没有可靠 Contract',
    }],
  } as unknown as ContractPreflight;
}

describe('DevTest problem aggregation', () => {
  it.each([
    ['UNKNOWN', 'UNKNOWN_CONTRACT'], ['CONFLICT', 'REQUIREMENT_CONFLICT'], ['STALE', 'STALE_CONTRACT'],
  ])('Contract %s 形成统一根因 %s', (resolutionStatus, expectedType) => {
    const { problems } = buildDevTestProblems({
      report: reportOf(), contracts: contracts(resolutionStatus === 'STALE' ? 'STALE' : 'BLOCKED', resolutionStatus),
      results: [], requirementWarnings: [],
    });
    expect(problems.some((problem) => problem.type === expectedType)).toBe(true);
  });

  it('Contract Gate 汇总不重复创建同一个 UNKNOWN 根因', () => {
    const report = reportOf();
    const { problems } = buildDevTestProblems({
      report, contracts: contracts('BLOCKED', 'UNKNOWN'), results: [], requirementWarnings: [],
    });
    const roots = problems.filter((problem) => problem.type === 'UNKNOWN_CONTRACT');
    expect(roots).toHaveLength(1);
    expect(roots[0].affectedCases).toEqual(report.cases.map((item) => item.caseId));
  });

  it('Contract fingerprint drift 为 CRITICAL，禁止被 PASS 平均', () => {
    const report = reportOf({ statuses: [{ id: 'API-1', type: 'API', priority: 'P0', status: 'PASS', executed: true }] });
    const { problems } = buildDevTestProblems({
      report, contracts: contracts('CONTRACT_DRIFT'), results: [], requirementWarnings: [],
    });
    expect(problems.find((problem) => problem.type === 'CONTRACT_DRIFT')?.severity).toBe('CRITICAL');
    expect(deriveDevTestConclusion(report, problems)).toBe('BLOCKED');
  });

  it('同一 SAFE 根因只生成一个 Problem 并关联多个 Case', () => {
    const report = reportOf({ statuses: [
      { id: 'A', type: 'FUNCTIONAL', priority: 'P0', status: 'BLOCKED' },
      { id: 'B', type: 'FUNCTIONAL', priority: 'P1', status: 'BLOCKED' },
    ] });
    const { problems } = buildDevTestProblems({
      report, contracts: contracts('VALID'), requirementWarnings: [],
      results: ['A', 'B'].map((caseId) => ({ caseId, status: 'BLOCKED', attribution: { reason: 'SAFE_MODE_MUTATION_HOLD：写路径不安全' } })),
    });
    const root = problems.filter((problem) => problem.type === 'SAFE_BLOCKED');
    expect(root).toHaveLength(1);
    expect(root[0].affectedCases).toEqual(['A', 'B']);
    expect(deriveDevTestConclusion(report, problems)).toBe('BLOCKED');
  });

  it('跳过 BLOCKED/NOT_EXECUTED 状态前缀，按真实 reasonCode 分离根因', () => {
    const report = reportOf({ statuses: [
      { id: 'A', type: 'API', status: 'BLOCKED' },
      { id: 'B', type: 'API', status: 'NOT_EXECUTED' },
    ] });
    const { problems } = buildDevTestProblems({
      report, contracts: contracts('VALID'), requirementWarnings: [],
      results: [
        { caseId: 'A', status: 'BLOCKED', error: 'BLOCKED：MUTATION_POLICY_BLOCKED：BILLABLE' },
        { caseId: 'B', status: 'NOT_EXECUTED', error: 'NOT_EXECUTED：AUTH_MISSING：无 Actor' },
      ],
    });
    expect(problems.find((problem) => problem.type === 'SAFE_BLOCKED')?.reasonCode).toBe('MUTATION_POLICY_BLOCKED');
    expect(problems.find((problem) => problem.type === 'AUTH_MISSING')?.reasonCode).toBe('AUTH_MISSING');
  });

  it('原始 PASS 缺 Processor/Assertion/Evidence 会产生三个高风险根因', () => {
    const report = reportOf({ statuses: [{ id: 'A', type: 'API', priority: 'P0', status: 'BLOCKED' }] });
    const { problems } = buildDevTestProblems({
      report, contracts: contracts('VALID'), requirementWarnings: [],
      results: [{ caseId: 'A', status: 'PASS', executed: false, processorInvoked: false, assertions: 0, evidence: { assertions: [] } }],
    });
    expect(problems.map((problem) => problem.type)).toEqual(expect.arrayContaining([
      'PROCESSOR_MISSING', 'ASSERTION_MISSING', 'EVIDENCE_MISSING',
    ]));
  });

  it('Connection refused 归为 ENVIRONMENT_ISSUE，绝不当 PRODUCT_BUG', () => {
    const report = reportOf({ statuses: [{ id: 'A', type: 'API', priority: 'P0', status: 'BLOCKED' }] });
    const { problems } = buildDevTestProblems({
      report, contracts: contracts('VALID'), requirementWarnings: [],
      results: [{ caseId: 'A', status: 'BLOCKED', error: 'BLOCKED：fetch failed ECONNREFUSED' }],
      environment: { name: 'local', baseUrl: 'http://127.0.0.1:3000' },
    });
    expect(problems[0]).toEqual(expect.objectContaining({
      type: 'ENVIRONMENT_MISSING', failureClass: 'ENVIRONMENT_ISSUE', reproducible: false,
    }));
    expect(problems.some((problem) => problem.failureClass === 'PRODUCT_BUG')).toBe(false);
  });

  it('HTTP 500 没有确定性断言与完整 Evidence 时不自动判为 Bug', () => {
    const report = reportOf({ statuses: [{ id: 'A', type: 'API', priority: 'P0', status: 'FAIL', executed: true }] });
    const { problems } = buildDevTestProblems({
      report, contracts: contracts('VALID'), requirementWarnings: [],
      results: [{ caseId: 'A', status: 'FAIL', executed: true, error: 'HTTP 500', evidence: { assertions: [] } }],
    });
    expect(problems[0]).toEqual(expect.objectContaining({
      failureClass: 'TEST_ISSUE', judgement: 'TEST_ISSUE', confidenceFactors: expect.any(Object),
    }));
    expect(problems.some((problem) => problem.judgement === 'CONFIRMED_BUG')).toBe(false);
  });

  it('多个授权 Case 的同一根因聚类，并且只有复现运行才可 CONFIRMED_BUG', () => {
    const report = reportOf({ statuses: [
      { id: 'AUTH-A', type: 'PERMISSION', priority: 'P0', status: 'FAIL', executed: true },
      { id: 'AUTH-B', type: 'PERMISSION', priority: 'P0', status: 'FAIL', executed: true },
    ] });
    const results = ['AUTH-A', 'AUTH-B'].map((caseId) => ({
      caseId, status: 'FAIL', executed: true, priority: 'P0', error: 'FAIL：授权策略未拒绝请求',
      evidence: { request: { method: 'GET' }, response: { status: 200 },
        assertions: [{ pass: false, detail: 'STATUS_CODE：expected=403 actual=200' }] },
    }));
    const first = buildDevTestProblems({ report, contracts: contracts('VALID'), results, requirementWarnings: [] });
    const root = first.problems.find((problem) => problem.failureClass === 'PRODUCT_BUG');
    expect(root).toEqual(expect.objectContaining({
      rootCause: 'AUTHORIZATION_POLICY', affectedCases: ['AUTH-A', 'AUTH-B'], judgement: 'LIKELY_BUG', reproducible: false,
    }));
    const reproduced = buildDevTestProblems({ report, contracts: contracts('VALID'), results,
      requirementWarnings: [], reproductionRun: true,
      environmentPreflight: { status: 'READY' } as never });
    expect(reproduced.problems.find((problem) => problem.failureClass === 'PRODUCT_BUG')?.judgement).toBe('CONFIRMED_BUG');
  });

  it('五维统计把 AUTH 归 API、BOUNDARY 归参数校验', () => {
    const report = reportOf({ statuses: [
      { id: 'AUTH', type: 'AUTH', status: 'NOT_EXECUTED' },
      { id: 'BOUNDARY', type: 'BOUNDARY', status: 'NOT_EXECUTED' },
      { id: 'DATA', type: 'DATA_ISOLATION', status: 'NOT_EXECUTED' },
    ] });
    const { dimensionStats } = buildDevTestProblems({ report, results: [], requirementWarnings: [] });
    expect(dimensionStats.find((item) => item.dimension === 'API')?.total).toBe(1);
    expect(dimensionStats.find((item) => item.dimension === 'PARAMETER_VALIDATION')?.total).toBe(1);
    expect(dimensionStats).toHaveLength(5);
  });

  it('P0 真实 FAIL => NOT_READY；全部 P0 PASS 且无 blocker => READY', () => {
    const failed = reportOf({ statuses: [{ id: 'P0', type: 'API', priority: 'P0', status: 'FAIL', executed: true }] });
    expect(deriveDevTestConclusion(failed)).toBe('NOT_READY');
    const ready = reportOf({ statuses: [{ id: 'P0', type: 'API', priority: 'P0', status: 'PASS', executed: true }] });
    expect(deriveDevTestConclusion(ready)).toBe('READY');
  });
});
