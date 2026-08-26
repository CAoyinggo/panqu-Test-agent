import type { TestCase } from '../agents/test-design/testcase-schema.js';
import type { AcceptanceRequirement } from '../acceptance/requirement-ir.js';
import type { DevTestBaselineSnapshot } from './baseline.js';
import { scoreDevTestCase, tierOf } from './dimension-selector.js';
import type { DevTestAdaptiveTestScore, DevTestFeatureModel, DevTestNegativeCheck,
  DevTestPermissionMatrixRow, DevTestRequirementCoverageMatrix, DevTestRequirementQuality, DevTestRootCauseNode,
  DevTestProblem, DevTestBusinessFlowGraph } from './types.js';

export function adaptiveScore(input: {
  testCase: TestCase;
  baseline?: DevTestBaselineSnapshot;
  changedCaseIds?: readonly string[];
  contractDrift?: boolean;
}): DevTestAdaptiveTestScore {
  const base = scoreDevTestCase(input.testCase);
  const prior = input.baseline?.cases.find((item) => item.caseId === input.testCase.id);
  const history = prior?.history ?? [];
  const failures = history.filter((item) => item.status === 'FAIL').length;
  const bugDensity = (input.baseline?.problems ?? []).filter((item) => item.affectedCases.includes(input.testCase.id)
    && item.failureClass === 'PRODUCT_BUG').length;
  const changed = input.changedCaseIds?.includes(input.testCase.id) ? 1 : 0;
  const drift = input.contractDrift ? 1 : 0;
  const regression = input.baseline?.regressionCaseIds?.includes(input.testCase.id) ? 1 : 0;
  const score = Math.max(0, Math.min(100, Math.round(base.total * 0.6 + Math.min(15, failures * 5)
    + Math.min(10, bugDensity * 5) + changed * 5 + drift * 5 + regression * 10 - base.executionCost * 2)));
  return { caseId: input.testCase.id, tier: tierOf(input.testCase), score, baseValue: base.total,
    historicalFailures: failures, bugDensity, codeChangeFrequency: changed, contractDrift: drift,
    recentRegression: regression, executionCost: base.executionCost,
    reason: `value=${base.total}, failures=${failures}, bugs=${bugDensity}, changed=${changed}, drift=${drift}, regression=${regression}, cost=${base.executionCost}` };
}

function matchedCases(cases: readonly TestCase[], pattern: RegExp): TestCase[] {
  return cases.filter((item) => pattern.test(`${item.name} ${item.testType} ${item.tags.join(' ')} ${JSON.stringify(item.parameterContext ?? {})}`));
}

export function buildNegativeIntelligence(input: {
  requirementText: string;
  testCases: readonly TestCase[];
  mutationSafe: boolean;
  observerAvailable: boolean;
}): DevTestNegativeCheck[] {
  const text = input.requirementText;
  const operation = input.testCases.map((item) => item.source?.apiOperationKey).find(Boolean);
  const definitions: Array<[DevTestNegativeCheck['kind'], RegExp, boolean]> = [
    ['MISSING_REQUIRED_FIELD', /missing|required|必填|缺失/i, /required|必填|参数|字段|field/i.test(text)],
    ['WRONG_TYPE', /wrong.type|类型|type/i, /类型|type|参数|字段|field/i.test(text)],
    ['UNAUTHORIZED', /unauthorized|认证|未登录|401/i, /auth|认证|登录|token/i.test(text)],
    ['CROSS_USER', /cross.user|其他用户|越权/i, /用户|owner|user/i.test(text)],
    ['CROSS_TENANT', /cross.tenant|tenant|租户|隔离/i, /tenant|租户|隔离/i.test(text)],
    ['INVALID_STATE', /invalid.state|状态非法|状态机/i, /状态|state/i.test(text)],
    ['STALE_RESOURCE', /stale|过期|已删除|不存在/i, /删除|资源|resource/i.test(text)],
    ['DUPLICATE_REQUEST', /duplicate|重复|幂等/i, /创建|提交|支付|发送|任务|状态更新|create|submit|pay|send|task|idempoten/i.test(text)],
    ['REPLAY', /replay|重放|重试/i, /创建|提交|支付|发送|任务|状态更新|retry|重试/i.test(text)],
    ['CONCURRENT_REQUEST', /concurr|并发/i, /创建|提交|支付|发送|任务|状态更新|concurr|并发/i.test(text)],
  ];
  return definitions.map(([kind, pattern, applicable]) => {
    const matched = matchedCases(input.testCases, pattern);
    const caseIds = matched.map((item) => item.id);
    const highRiskMutation = ['DUPLICATE_REQUEST', 'REPLAY', 'CONCURRENT_REQUEST'].includes(kind);
    if (matched.some((item) => item.executionMode === 'EXECUTABLE')) return { kind, operation, relatedCaseIds: caseIds,
      status: 'COVERED', reason: '已有 Requirement/Contract 可追溯且可执行 Case' };
    if (!applicable) return { kind, operation, relatedCaseIds: [], status: 'NOT_APPLICABLE', reason: 'Requirement/Contract 未表明该风险' };
    return { kind, operation, relatedCaseIds: caseIds, status: 'BLOCKED', reason: highRiskMutation && (!input.mutationSafe || !input.observerAvailable)
      ? '风险适用，但缺少 Sandbox/Cleanup 与实体/副作用 Observer，禁止执行重复或并发写请求'
      : '风险适用，但 Requirement/Contract 缺少可判定 Expected；禁止猜测 Oracle' };
  });
}

export function buildPermissionMatrix(testCases: readonly TestCase[], model: DevTestFeatureModel): DevTestPermissionMatrixRow[] {
  const rows = new Map<string, DevTestPermissionMatrixRow>();
  for (const testCase of testCases) {
    const operation = testCase.source?.apiOperationKey ?? testCase.steps.find((item) => item.type === 'HTTP_REQUEST')?.action ?? 'UNKNOWN';
    const resource = model.resources[0] ?? String(testCase.data?.targetId ?? 'UNKNOWN');
    const actor = testCase.actor?.id ?? testCase.actor?.userId ?? testCase.actor?.role ?? 'ANONYMOUS';
    const negative = ['PERMISSION', 'DATA_ISOLATION', 'AUTH', 'SECURITY'].includes(testCase.testType ?? '')
      || testCase.assertions.some((item) => item.type === 'STATUS_CODE' && [401, 403, 404].includes(Number(item.expected)));
    const project = typeof testCase.data?.projectId === 'string' ? testCase.data.projectId : model.projects[0];
    const row = { actor, tenant: testCase.actor?.tenantId, project, role: testCase.actor?.role, resource, operation,
      expectedAccess: negative ? 'DENY' as const : 'ALLOW' as const, caseIds: [testCase.id] };
    const key = `${actor}|${row.tenant}|${resource}|${operation}|${row.expectedAccess}`;
    const existing = rows.get(key);
    if (existing) existing.caseIds.push(testCase.id); else rows.set(key, row);
  }
  return [...rows.values()];
}

export function assessRequirementQuality(input: {
  requirement: AcceptanceRequirement;
  matrix: DevTestRequirementCoverageMatrix;
  model: DevTestFeatureModel;
}): DevTestRequirementQuality {
  const issues: DevTestRequirementQuality['issues'] = [];
  const requirementText = input.requirement.factLedger.map((fact) => fact.statement).join('\n');
  for (const behavior of input.matrix.behaviors) {
    if (!behavior.actor || /未指定|unknown/i.test(behavior.actor)) issues.push({ acId: behavior.acId, code: 'ACTOR_MISSING', message: `${behavior.acId} 缺 Actor` });
    if (!behavior.expectedResponse && !behavior.expectedState && !behavior.expectedSideEffects.length) issues.push({ acId: behavior.acId, code: 'EXPECTED_MISSING', message: `${behavior.acId} 缺少成功/失败条件` });
  }
  if (!input.requirement.apis.length && !input.model.ui.length) issues.push({ code: 'API_MISSING', message: '缺少可执行 API 或 UI 入口' });
  if (/状态|state/i.test(requirementText) && !input.model.states.length) issues.push({ code: 'STATE_MISSING', message: '需求涉及状态但未定义可判定状态' });
  if (input.requirement.apis.some((api) => [...api.body, ...api.query, ...api.pathParams].some((parameter) => parameter.required))
    && !input.requirement.factLedger.some((fact) => fact.category === 'VALIDATION' || fact.category === 'BOUNDARY')) issues.push({ code: 'BOUNDARY_MISSING', message: '存在参数约束但 AC 未描述关键边界' });
  const score = Math.max(0, 100 - issues.length * 12 - input.matrix.ambiguousAc.length * 8);
  const testability = Math.max(0, Math.round(input.matrix.coreCoverage * 0.6 + (input.model.apis.length ? 25 : 0)
    + (input.model.states.length || !/状态|state/i.test(requirementText) ? 15 : 0) - issues.length * 5));
  return { score, testability: Math.min(100, testability), needsClarification: score < 60 || testability < 60, issues };
}

export function buildRequirementQualityProblems(quality: DevTestRequirementQuality): DevTestProblem[] {
  if (!quality.issues.length) return [];
  return [{
    id: 'P000', type: 'REQUIREMENT_QUALITY', severity: quality.needsClarification ? 'MEDIUM' : 'LOW',
    dimension: 'EXECUTION', message: `Requirement Quality ${quality.score}/100，Testability ${quality.testability}/100`,
    affectedCases: [], reasonCode: 'REQUIREMENT_QUALITY', category: 'Requirement Quality',
    failureClass: 'REQUIREMENT_ISSUE', judgement: 'REQUIREMENT_ISSUE', reproducible: true,
    confidence: 1, confidenceLabel: 'CONFIRMED', evidence: quality.issues,
    rootCause: 'REQUIREMENT_INCOMPLETE', remediation: '补齐 Actor、Expected、API/页面入口、状态与关键边界；已有可验证 Case 仍继续执行。',
  }];
}

export function buildRootCauseGraph(problems: readonly DevTestProblem[], testCases: readonly TestCase[], graph: DevTestBusinessFlowGraph): DevTestRootCauseNode[] {
  const byRoot = new Map<string, DevTestProblem[]>();
  for (const problem of problems) {
    const root = problem.rootCause ?? `${problem.failureClass}:${problem.reasonCode ?? problem.type}`;
    byRoot.set(root, [...(byRoot.get(root) ?? []), problem]);
  }
  const severity = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
  return [...byRoot].map(([rootCause, grouped], index) => {
    const affectedCases = [...new Set(grouped.flatMap((item) => item.affectedCases))];
    const affected = testCases.filter((item) => affectedCases.includes(item.id));
    const confidence = Math.max(...grouped.map((item) => item.confidence ?? 0));
    const reproducible = grouped.some((item) => item.reproducible) ? 1 : 0.5;
    const impact = Math.min(5, affectedCases.length || 1);
    const maxSeverity = Math.max(...grouped.map((item) => severity[item.severity]));
    return { id: `RC${String(index + 1).padStart(3, '0')}`, rootCause,
      problemIds: grouped.map((item) => item.id), affectedCases,
      affectedContracts: [...new Set(affected.flatMap((item) => (item.contractDependencies ?? []).map((dependency) => dependency.contractId)))],
      affectedScenarios: [...new Set(affected.map((item) => item.source?.scenarioId).filter((item): item is string => Boolean(item)))],
      affectedBusinessFlows: graph.flows.filter((flow) => flow.steps.some((step) => step.caseIds.some((id) => affectedCases.includes(id)))).map((flow) => flow.id),
      benefitScore: Math.round(maxSeverity * confidence * impact * reproducible * 10) / 10 };
  }).sort((left, right) => right.benefitScore - left.benefitScore);
}
