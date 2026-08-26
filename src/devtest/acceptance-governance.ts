import type { TestCase } from '../agents/test-design/testcase-schema.js';
import type { DevTestBaselineSnapshot } from './baseline.js';
import type {
  DevTestBusinessFlowGraph,
  DevTestExecutionEstimate,
  DevTestInvariant,
  DevTestProblem,
  DevTestRegressionGuard,
} from './types.js';

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }

function dependenciesOf(testCase: TestCase): string[] {
  return (testCase.contractDependencies ?? []).map((item) => item.contractId);
}

export function relatedRegressionCaseIds(input: {
  seedCaseIds: readonly string[];
  testCases: readonly TestCase[];
  graph: DevTestBusinessFlowGraph;
  invariants: readonly DevTestInvariant[];
}): { sameContract: string[]; sameInvariant: string[]; sameFlow: string[]; all: string[] } {
  const seeds = new Set(input.seedCaseIds);
  const contractIds = new Set(input.testCases.filter((item) => seeds.has(item.id)).flatMap(dependenciesOf));
  const sameContract = input.testCases.filter((item) => dependenciesOf(item).some((id) => contractIds.has(id))).map((item) => item.id);
  const sameInvariant = input.invariants.filter((item) => item.linkedCaseIds.some((id) => seeds.has(id))).flatMap((item) => item.linkedCaseIds);
  const sameFlow = input.graph.flows.filter((flow) => flow.steps.some((step) => step.caseIds.some((id) => seeds.has(id))))
    .flatMap((flow) => flow.steps.flatMap((step) => step.caseIds));
  return { sameContract: unique(sameContract), sameInvariant: unique(sameInvariant), sameFlow: unique(sameFlow),
    all: unique([...input.seedCaseIds, ...sameContract, ...sameInvariant, ...sameFlow]) };
}

export function buildRegressionGuard(input: {
  target?: string;
  baseline?: DevTestBaselineSnapshot;
  testCases: readonly TestCase[];
  graph: DevTestBusinessFlowGraph;
  invariants: readonly DevTestInvariant[];
}): DevTestRegressionGuard {
  const fixedCaseIds = input.target && /^P\d+$/i.test(input.target)
    ? input.baseline?.problems.find((problem) => problem.id.toUpperCase() === input.target!.toUpperCase())?.affectedCases ?? [] : [];
  if (!fixedCaseIds.length) return { enabled: false, target: input.target, fixedCaseIds: [], affectedCaseIds: [],
    sameContractCaseIds: [], sameInvariantCaseIds: [], sameFlowCaseIds: [], selectedCaseIds: [], status: 'NOT_REQUIRED',
    reason: input.target ? '目标不是 Baseline 中可解析的问题，Regression Guard 无法建立' : '非问题修复复测' };
  const related = relatedRegressionCaseIds({ seedCaseIds: fixedCaseIds, testCases: input.testCases,
    graph: input.graph, invariants: input.invariants });
  return { enabled: true, target: input.target, fixedCaseIds: [...fixedCaseIds], affectedCaseIds: related.all,
    sameContractCaseIds: related.sameContract, sameInvariantCaseIds: related.sameInvariant, sameFlowCaseIds: related.sameFlow,
    selectedCaseIds: related.all, status: 'BLOCKED', reason: '等待 Fixed + Contract + Invariant + Business Flow 回归执行' };
}

export function evaluateRegressionGuard(
  guard: DevTestRegressionGuard,
  statuses: readonly { caseId: string; status: string; verified?: boolean; evidenceComplete?: boolean }[],
): DevTestRegressionGuard {
  if (!guard.enabled) return guard;
  const byCase = new Map(statuses.map((item) => [item.caseId, item]));
  const selected = guard.selectedCaseIds.map((caseId) => ({ caseId, ...byCase.get(caseId) }));
  const failed = selected.filter((item) => item.status === 'FAIL' && item.verified === true && item.evidenceComplete === true);
  const blocked = selected.filter((item) => !item.status || item.verified !== true || item.evidenceComplete !== true
    || ['BLOCKED', 'NOT_EXECUTED', 'TIMEOUT', 'CANCELLED'].includes(item.status));
  if (failed.length) return { ...guard, status: 'FAIL', reason: `REGRESSION_DETECTED：${failed.map((item) => item.caseId).join(', ')}` };
  if (blocked.length) return { ...guard, status: 'BLOCKED', reason: `REGRESSION_GUARD_BLOCKED：${blocked.map((item) => item.caseId).join(', ')}` };
  return { ...guard, status: 'PASS', reason: 'Fixed Case、同 Contract、同 Invariant 与同 Business Flow 均已通过' };
}

export function buildRegressionProblem(guard: DevTestRegressionGuard): DevTestProblem | undefined {
  if (guard.status !== 'FAIL') return undefined;
  return {
    id: 'P000', type: 'REGRESSION_BUG', severity: 'CRITICAL', dimension: 'FUNCTIONAL', scope: 'REGRESSION',
    message: guard.reason, reasonCode: 'REGRESSION_DETECTED', affectedCases: guard.selectedCaseIds,
    rootCause: `REGRESSION:${guard.target ?? 'UNKNOWN'}`, failureClass: 'PRODUCT_BUG', judgement: 'CONFIRMED_BUG',
    reproducible: true, confidence: 1, confidenceLabel: 'CONFIRMED', evidence: guard,
    remediation: '修复回归 Case；在同 Contract、Invariant、Business Flow 全部通过前禁止 READY。',
  };
}

export function buildExecutionEstimate(input: {
  testCases: readonly TestCase[];
  timeoutMs: number;
  maxRuntimeMs?: number;
  budget?: number;
}): DevTestExecutionEstimate {
  const executable = input.testCases.filter((testCase) => testCase.executionMode === 'EXECUTABLE');
  const requestCases = executable.filter((testCase) => testCase.steps.some((step) => step.type === 'HTTP_REQUEST'));
  const estimatedRuntimeMs = executable.reduce((sum, testCase) => {
    if (testCase.testType === 'UI') return sum + 1_500;
    const method = testCase.steps.find((step) => step.type === 'HTTP_REQUEST')?.method;
    return sum + (['GET', 'HEAD', 'OPTIONS'].includes(method ?? '') ? 250 : 500);
  }, 0);
  const estimatedCost = Math.round(executable.reduce((sum, testCase) => {
    const method = testCase.steps.find((step) => step.type === 'HTTP_REQUEST')?.method;
    const text = `${testCase.name} ${testCase.tags?.join(' ')}`;
    if (/billing|charge|provider|扣费|计费|供应商/i.test(text)) return sum + 1;
    if (testCase.testType === 'UI') return sum + 0.01;
    return sum + (['GET', 'HEAD', 'OPTIONS'].includes(method ?? '') ? 0.001 : 0.005);
  }, 0) * 1000) / 1000;
  const exceeded: DevTestExecutionEstimate['exceeded'] = [];
  if (input.maxRuntimeMs !== undefined && estimatedRuntimeMs > input.maxRuntimeMs) exceeded.push('MAX_RUNTIME');
  if (input.budget !== undefined && estimatedCost > input.budget) exceeded.push('BUDGET');
  return { estimatedCases: input.testCases.length, estimatedRequests: requestCases.length, estimatedRuntimeMs,
    estimatedCost, costUnit: 'DEVTEST_UNIT', limits: { timeoutMs: input.timeoutMs, maxRuntimeMs: input.maxRuntimeMs,
      budget: input.budget }, exceeded };
}
