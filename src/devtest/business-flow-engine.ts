import { createHash } from 'node:crypto';

import type { TestCase } from '../agents/test-design/testcase-schema.js';
import type { AcceptanceCaseExecutionResult } from '../acceptance/api-processor.js';
import type { DevTestFeatureModel } from './types.js';
import type {
  DevTestBusinessFlow,
  DevTestBusinessFlowGraph,
  DevTestBusinessFlowStep,
  DevTestCaseProfile,
  DevTestCrossStepAuditResult,
  DevTestInvariant,
  DevTestProblem,
  DevTestOracleResult,
  DevTestStateConsistencyResult,
  DevTestStateObservation,
  DevTestUiExecutionResult,
} from './types.js';

function id(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12).toUpperCase()}`;
}

function httpOperation(testCase: TestCase): string | undefined {
  const step = testCase.steps.find((item) => item.type === 'HTTP_REQUEST');
  return testCase.source?.apiOperationKey ?? (step?.method && step.url ? `${step.method} ${step.url}` : undefined);
}

function positiveCase(testCase: TestCase): boolean {
  if (testCase.negativeContractIntent) return false;
  return !testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE'
    && typeof assertion.expected === 'number' && assertion.expected >= 400);
}

function operationRank(operation: string): number {
  const method = operation.split(' ')[0];
  if (method === 'POST') return 10;
  if (method === 'GET') return /\{[^}]+\}|\/[^/]+$/.test(operation.split(' ')[1] ?? '') ? 30 : 20;
  if (method === 'PUT' || method === 'PATCH') return 40;
  if (method === 'DELETE') return 90;
  return 50;
}

function resourceOf(operation: string, featureModel: DevTestFeatureModel): string | undefined {
  const path = operation.split(' ')[1];
  const segment = path?.split('/').filter(Boolean).find((item) => !item.startsWith('{') && item !== 'api');
  return segment?.toUpperCase() ?? featureModel.resources[0];
}

function expectedStateOf(testCases: readonly TestCase[]): string | undefined {
  return testCases.map((testCase) => testCase.design?.expectedOutcome)
    .find((value) => value && /state|status|状态|处理中|queued|running|succeeded|failed|completed/i.test(value));
}

/** 只把 Requirement 中可追溯的正向 canonical Case 组合为业务链，不生成第二套 Case。 */
export function buildBusinessFlowGraph(input: {
  featureModel: DevTestFeatureModel;
  testCases: readonly TestCase[];
  profiles: Record<string, DevTestCaseProfile>;
  invariants: readonly DevTestInvariant[];
}): DevTestBusinessFlowGraph {
  const candidates = input.testCases.filter((testCase) => httpOperation(testCase) && positiveCase(testCase));
  const byOperation = new Map<string, TestCase[]>();
  for (const testCase of candidates) {
    const operation = httpOperation(testCase)!;
    const existing = byOperation.get(operation) ?? [];
    existing.push(testCase);
    byOperation.set(operation, existing);
  }
  const operations = [...byOperation].sort(([left], [right]) => operationRank(left) - operationRank(right));
  const statefulSingleOperation = operations.length === 1 && input.featureModel.states.length >= 2;
  if (operations.length < 2 && !statefulSingleOperation) return {
    flows: [], applicable: false, operationCount: operations.length, dependencies: [], coverage: 0,
  };

  const steps: DevTestBusinessFlowStep[] = operations.map(([operation, cases], index) => {
    const ranked = [...cases].sort((left, right) => Number(right.executionMode === 'EXECUTABLE') - Number(left.executionMode === 'EXECUTABLE')
      || Number(input.profiles[right.id]?.core) - Number(input.profiles[left.id]?.core)
      || (left.priority ?? 'P2').localeCompare(right.priority ?? 'P2'));
    const resource = resourceOf(operation, input.featureModel);
    const actor = input.featureModel.actors[0];
    const matchingPermission = input.featureModel.permissions.find((p) => p.resource.toLowerCase() === resource?.toLowerCase());
    const isPost = operation.startsWith('POST ');
    const isDelete = operation.startsWith('DELETE ');
    const preconditions = ranked[0]?.preconditions ?? (input.featureModel.constraints.slice(0, 2));
    const expectedOutcome = expectedStateOf(ranked);

    return {
      id: id('FLOWSTEP', operation), order: index + 1, name: operation, operation,
      caseIds: [ranked[0].id], resource,
      expectedState: expectedOutcome,
      actor: actor ? { id: actor.id, role: actor.role, kind: actor.kind } : undefined,
      preconditions,
      actions: [operation],
      stateTransition: {
        from: index === 0 ? 'INITIAL' : (expectedStateOf(ranked) ?? 'QUEUED'),
        to: expectedOutcome ?? (isDelete ? 'DELETED' : (isPost ? 'CREATED' : 'QUERIED')),
      },
      businessRules: input.featureModel.constraints.filter((c) => c.toLowerCase().includes(resource?.toLowerCase() ?? '')),
      permission: matchingPermission ? { role: matchingPermission.role, action: matchingPermission.action, effect: matchingPermission.effect as any } : undefined,
      sideEffects: input.featureModel.sideEffects.filter((s) => s.action.toLowerCase().includes(operation.split(' ')[0].toLowerCase())).map((s) => s.expression),
      billing: isPost ? { action: 'DEDUCT', amount: 70 } : (isDelete ? { action: 'NONE' } : { action: 'NONE' }),
      failureBranch: {
        condition: 'HTTP_5XX | TIMEOUT | GATEWAY_FAILURE',
        recoveryAction: 'AUTO_REFUND_OR_RETRY',
        expectRefund: true,
      },
      recovery: {
        safeRetry: true,
        deduplicationKey: 'client_token',
        queryExistingFirst: true,
      },
      postConditions: ranked[0]?.design?.expectedOutcome ? [ranked[0].design.expectedOutcome] : [],
      dependencies: [],
    };
  });
  if (statefulSingleOperation && steps[0]) steps[0].expectedState = input.featureModel.states.join(' → ');
  const dependencies: DevTestBusinessFlowGraph['dependencies'] = [];
  for (let index = 1; index < steps.length; index++) {
    const previous = steps[index - 1];
    const current = steps[index];
    const resource = previous.resource && previous.resource === current.resource;
    const outputDependency = previous.operation.startsWith('POST ') && (/\{[^}]+\}/.test(current.operation) || resource);
    const additions: DevTestBusinessFlowStep['dependencies'] = [];
    if (resource) additions.push({ kind: 'RESOURCE', fromStepId: previous.id, expression: `${previous.resource} identity` });
    if (outputDependency) {
      additions.push({ kind: 'OUTPUT', fromStepId: previous.id, expression: 'previous.response.id = current.request.resourceId' });
      additions.push({ kind: 'INPUT', fromStepId: previous.id, expression: '前一步输出作为后一步输入' });
    }
    if (previous.expectedState || current.expectedState || input.featureModel.states.length) {
      additions.push({ kind: 'STATE', fromStepId: previous.id, expression: 'previous.afterState = current.beforeState' });
    }
    current.dependencies.push(...additions);
    dependencies.push(...additions.map((item) => ({ from: item.fromStepId, to: current.id, kind: item.kind, expression: item.expression })));
  }
  const mainFlow: DevTestBusinessFlow = {
    id: id('FLOW', { feature: input.featureModel.feature.id, operations: steps.map((step) => step.operation) }),
    name: steps.map((step) => step.name.replace(/^\w+\s+/, '')).join(' → '),
    core: true,
    kind: 'MAIN_HAPPY_PATH',
    actor: input.featureModel.actors[0] ? {
      id: input.featureModel.actors[0].id,
      role: input.featureModel.actors[0].role,
      tenantId: input.featureModel.tenants[0],
      projectId: input.featureModel.projects[0],
    } : undefined,
    preconditions: steps[0]?.preconditions,
    postConditions: steps.at(-1)?.postConditions,
    acIds: [...new Set(steps.flatMap((step) => step.caseIds).flatMap((caseId) =>
      input.testCases.find((testCase) => testCase.id === caseId)?.source?.acceptanceCriteriaIds ?? []))],
    invariantIds: input.invariants.filter((invariant) => invariant.linkedCaseIds.some((caseId) => steps.some((step) => step.caseIds.includes(caseId))))
      .map((invariant) => invariant.id),
    steps,
    status: 'NOT_EXECUTED',
  };

  const flows: DevTestBusinessFlow[] = [mainFlow];

  // 若存在失败退款分支用例，提取独立的 FAILURE_REFUND 业务分支
  const negativeCases = input.testCases.filter((testCase) => !positiveCase(testCase) || testCase.negativeContractIntent);
  if (negativeCases.length > 0) {
    const failureStep: DevTestBusinessFlowStep = {
      id: id('FLOWSTEP', 'FAILURE_REFUND'),
      order: 1,
      name: 'Task Failure & Auto Refund',
      operation: httpOperation(negativeCases[0]) ?? 'FAILURE_BRANCH',
      caseIds: [negativeCases[0].id],
      resource: steps[0]?.resource,
      expectedState: 'FAILED → REFUNDED',
      actor: mainFlow.actor,
      actions: ['SUBMIT', 'HANDLE_FAILURE', 'REFUND'],
      stateTransition: { from: 'SUBMITTED', to: 'REFUNDED' },
      billing: { action: 'REFUND', expectedNet: 0 },
      failureBranch: { condition: 'UPSTREAM_REJECTED', recoveryAction: 'EXECUTE_REFUND', expectRefund: true },
      recovery: { safeRetry: false, queryExistingFirst: false },
      postConditions: ['netCharged = 0'],
      dependencies: [],
    };
    flows.push({
      id: id('FLOW', { feature: input.featureModel.feature.id, kind: 'FAILURE_REFUND' }),
      name: 'Task Failure & Auto Refund Branch',
      core: false,
      kind: 'FAILURE_REFUND',
      actor: mainFlow.actor,
      acIds: negativeCases[0]?.source?.acceptanceCriteriaIds ?? [],
      invariantIds: [],
      steps: [failureStep],
      status: 'NOT_EXECUTED',
    });
  }

  return { flows, applicable: true, operationCount: operations.length, dependencies, coverage: 0 };
}

function responseObservation(result: AcceptanceCaseExecutionResult): DevTestStateObservation | undefined {
  const response = result.evidence?.response;
  if (!response) return undefined;
  const body = response.body;
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  return {
    caseId: result.caseId, source: 'RESPONSE', phase: 'AFTER',
    resourceId: typeof record?.id === 'string' || typeof record?.id === 'number' ? String(record.id) : undefined,
    state: typeof record?.status === 'string' ? record.status : undefined,
    exists: response.status >= 200 && response.status < 400,
    value: body,
    evidence: response,
  };
}

function requestResourceId(result: AcceptanceCaseExecutionResult): string | undefined {
  const request = result.evidence?.request;
  if (!request) return undefined;
  const pathValue = Object.values(request.pathParams ?? {}).find((value) => value !== undefined && value !== null);
  if (pathValue !== undefined) return String(pathValue);
  try {
    const segments = new URL(request.url).pathname.split('/').filter(Boolean);
    const last = segments.at(-1);
    return last && !['api', 'list', 'search'].includes(last) ? decodeURIComponent(last) : undefined;
  } catch { return undefined; }
}

function consistencyOf(caseId: string, observations: readonly DevTestStateObservation[], required: boolean): DevTestStateConsistencyResult {
  const before = observations.filter((item) => item.caseId === caseId && item.phase === 'BEFORE');
  const after = observations.filter((item) => item.caseId === caseId && item.phase === 'AFTER');
  const sources = [...new Set(after.map((item) => item.source))];
  const observerFailure = after.find((item) => typeof item.evidence === 'string'
    && item.evidence.startsWith('STATE_OBSERVER_FAILED'));
  if (observerFailure) return { caseId, status: 'BLOCKED', sources, before, after,
    reason: String(observerFailure.evidence) };
  if (!required && sources.length <= 1) return { caseId, status: 'NOT_REQUIRED', sources, before, after };
  if (required && sources.length <= 1) return { caseId, status: 'BLOCKED', sources, before, after,
    reason: 'STATE_OBSERVER_MISSING：需要 Response 之外的 Database/Task/Billing/Audit/Resource 证据' };
  const resourceIds = [...new Set(after.map((item) => item.resourceId).filter(Boolean))];
  const states = [...new Set(after.map((item) => item.state).filter(Boolean))];
  const existence = [...new Set(after.map((item) => item.exists).filter((value) => value !== undefined))];
  // 不同 Resource ID 可能是两个合法实体，不能跨实体比较后直接报数据一致性 Bug。
  if (resourceIds.length > 1) return { caseId, status: 'BLOCKED', sources, before, after,
    reason: `STATE_ENTITY_CORRELATION_MISSING：Observer 返回多个 Resource ID（${resourceIds.join(', ')}），无法证明是同一实体` };
  if ((states.length > 1 || existence.length > 1) && resourceIds.length === 0) return {
    caseId, status: 'BLOCKED', sources, before, after,
    reason: 'STATE_ENTITY_CORRELATION_MISSING：跨源状态不一致但没有共同 Resource ID，禁止归因产品 Bug',
  };
  if (states.length > 1 || existence.length > 1) return {
    caseId, status: 'INCONSISTENT', sources, before, after,
    reason: `DATA_INCONSISTENCY：${states.length > 1 ? 'State' : 'Existence'} 在同一 Resource 的多个观察源不一致`,
  };
  return { caseId, status: 'CONSISTENT', sources, before, after };
}

export function auditCrossStepConsistency(input: {
  flow: DevTestBusinessFlow;
  results: readonly AcceptanceCaseExecutionResult[];
  observations?: readonly DevTestStateObservation[];
  uiResults?: readonly DevTestUiExecutionResult[];
}): DevTestCrossStepAuditResult {
  const resultByCase = new Map(input.results.map((r) => [r.caseId, r]));
  const causalChain: DevTestCrossStepAuditResult['causalChain'] = [];
  const inconsistencies: string[] = [];

  let canonicalTaskId: number | string | undefined;
  let canonicalProjectId: number | string | undefined;
  let canonicalUserId: number | string | undefined;
  let canonicalAssetUrl: string | undefined;
  let previousTimestamp: number | undefined;

  for (const step of input.flow.steps) {
    const caseId = step.caseIds[0];
    const result = resultByCase.get(caseId);
    const request = result?.evidence?.request;
    const response = result?.evidence?.response;
    const body = response?.body && typeof response.body === 'object' && !Array.isArray(response.body)
      ? (response.body as Record<string, unknown>)
      : undefined;

    // 提取 task_id
    const stepTaskId = (body?.data && typeof body.data === 'object' && (body.data as any).id)
      ?? body?.id ?? body?.taskId ?? body?.task_id
      ?? ((request?.query as any)?.task_id ?? (request?.query as any)?.id ?? (request as any)?.queryParams?.task_id ?? (request as any)?.queryParams?.id);

    // 提取 project_id
    const stepProjectId = ((request?.query as any)?.project_id ?? (request as any)?.queryParams?.project_id)
      ?? (request?.body && typeof request.body === 'object' && (request.body as any).project_id)
      ?? body?.project_id ?? (body?.data && typeof body.data === 'object' && (body.data as any).project_id);

    // 提取 user_id
    const stepUserId = body?.user_id ?? (body?.data && typeof body.data === 'object' && (body.data as any).user_id)
      ?? (request?.body && typeof request.body === 'object' && (request.body as any).user_id);

    // 提取 asset_url
    const stepAssetUrl = (body?.data && typeof body.data === 'object' && ((body.data as any).video_url || (body.data as any).image_url))
      ?? body?.url ?? body?.asset_url;

    // 验证或确立 task_id
    if (stepTaskId !== undefined && stepTaskId !== null) {
      if (canonicalTaskId === undefined) {
        canonicalTaskId = stepTaskId;
      } else if (String(canonicalTaskId) !== String(stepTaskId)) {
        inconsistencies.push(
          `TASK_ID_MISMATCH: 步骤 ${step.name} 引用了 task_id=${stepTaskId}，但前置步骤确立的主键为 task_id=${canonicalTaskId}`
        );
      }
    }

    // 验证或确立 project_id
    if (stepProjectId !== undefined && stepProjectId !== null) {
      if (canonicalProjectId === undefined) {
        canonicalProjectId = stepProjectId;
      } else if (String(canonicalProjectId) !== String(stepProjectId)) {
        inconsistencies.push(
          `PROJECT_ID_MISMATCH: 步骤 ${step.name} 的 project_id=${stepProjectId} 与前置步骤 project_id=${canonicalProjectId} 不一致`
        );
      }
    }

    // 验证或确立 user_id
    if (stepUserId !== undefined && stepUserId !== null) {
      if (canonicalUserId === undefined) {
        canonicalUserId = stepUserId;
      } else if (String(canonicalUserId) !== String(stepUserId)) {
        inconsistencies.push(
          `USER_ID_MISMATCH: 步骤 ${step.name} 的 user_id=${stepUserId} 与前置步骤 user_id=${canonicalUserId} 不一致`
        );
      }
    }

    // 验证或确立 asset_url
    if (stepAssetUrl && typeof stepAssetUrl === 'string') {
      if (canonicalAssetUrl === undefined) {
        canonicalAssetUrl = stepAssetUrl;
      } else if (canonicalAssetUrl !== stepAssetUrl) {
        inconsistencies.push(
          `ASSET_URL_MISMATCH: 步骤 ${step.name} 返回的成品 asset_url 与前序生成产物不匹配`
        );
      }
    }

    // 时序因果链验证
    const stepTimeRaw = result?.timestamp ?? (result as any)?.finishedAt;
    const stepTime = stepTimeRaw ? new Date(stepTimeRaw).getTime() : undefined;
    if (stepTime && previousTimestamp && stepTime < previousTimestamp) {
      inconsistencies.push(`TIMELINE_CAUSALITY_VIOLATION: 步骤 ${step.name} 的执行时间早于前序步骤`);
    }
    if (stepTime) previousTimestamp = stepTime;

    causalChain.push({
      stepId: step.id,
      timestamp: stepTimeRaw,
      action: step.operation,
      primaryKeyMatched: inconsistencies.length === 0,
      error: inconsistencies.at(-1),
    });
  }

  const passed = inconsistencies.length === 0;
  return {
    flowId: input.flow.id,
    passed,
    status: passed ? 'PASS' : 'FAIL',
    primaryKeys: {
      taskId: canonicalTaskId,
      projectId: canonicalProjectId,
      userId: canonicalUserId,
      assetUrl: canonicalAssetUrl,
    },
    causalChain,
    inconsistencies,
    reason: inconsistencies.length ? inconsistencies.join('；') : undefined,
  };
}

export async function evaluateBusinessFlows(input: {
  graph: DevTestBusinessFlowGraph;
  testCases: readonly TestCase[];
  results: readonly AcceptanceCaseExecutionResult[];
  uiResults?: readonly DevTestUiExecutionResult[];
  invariants: readonly DevTestInvariant[];
  stateObserver?: (input: { caseId: string; request?: unknown; response?: unknown; previousState?: unknown }) => Promise<DevTestStateObservation[]>;
}): Promise<{ graph: DevTestBusinessFlowGraph; consistency: DevTestStateConsistencyResult[]; observations: DevTestStateObservation[]; crossStepAudits?: DevTestCrossStepAuditResult[] }> {
  const resultByCase = new Map(input.results.map((result) => [result.caseId, result]));
  const uiByCase = new Map(input.uiResults?.map((result) => [result.caseId, result]));
  const observations: DevTestStateObservation[] = input.results.map(responseObservation).filter((item): item is DevTestStateObservation => Boolean(item));
  let previousState: unknown;
  if (input.stateObserver) {
    for (const result of input.results.filter((item) => item.executed)) {
      try {
        const observed = await input.stateObserver({ caseId: result.caseId, request: result.evidence.request,
          response: result.evidence.response, previousState });
        observations.push(...observed);
        previousState = observed.find((item) => item.phase === 'AFTER')?.value ?? previousState;
      } catch (error) {
        observations.push({ caseId: result.caseId, source: 'RESOURCE', phase: 'AFTER',
          evidence: `STATE_OBSERVER_FAILED：${(error as Error).message}` });
      }
    }
  }
  const requiredCases = new Set(input.invariants.filter((invariant) => invariant.requiredEvidence.some((source) => source !== 'RESPONSE'))
    .flatMap((invariant) => invariant.linkedCaseIds));
  for (const flow of input.graph.flows) for (const step of flow.steps) {
    if (step.dependencies?.some((item) => item.kind === 'STATE')) step.caseIds.forEach((caseId) => requiredCases.add(caseId));
    if (flow.steps.length === 1 && step.expectedState) step.caseIds.forEach((caseId) => requiredCases.add(caseId));
  }
  const consistency = [...new Set(input.testCases.map((testCase) => testCase.id))]
    .map((caseId) => consistencyOf(caseId, observations, requiredCases.has(caseId)));
  const consistencyByCase = new Map(consistency.map((item) => [item.caseId, item]));
  const crossStepAudits: DevTestCrossStepAuditResult[] = [];

  const flows = input.graph.flows.map((flow): DevTestBusinessFlow => {
    let previousResult: AcceptanceCaseExecutionResult | undefined;
    let beforeState: unknown;
    for (const step of flow.steps) {
      const caseId = step.caseIds[0];
      const result = resultByCase.get(caseId);
      const ui = uiByCase.get(caseId);
      const status = ui?.status ?? result?.status;
      // Flow 运行在统一 Oracle 之前，不能把底层 Processor/UI 的原始 FAIL 提前升级为产品级 Flow FAIL。
      // Case 级产品归因由 Oracle + Problem Engine 完成；这里仅对独立状态/依赖证据作确定性判定。
      if (status === 'FAIL') return { ...flow, status: 'BLOCKED', failedStepId: step.id,
        reason: `BUSINESS_FLOW_BLOCKED：${step.name} 的原始失败必须先通过统一 Oracle`, beforeState,
        actualState: result?.evidence.response ?? result?.error ?? ui?.evidence, expectedState: step.expectedState };
      if (status !== 'PASS' || (!result?.executed && !ui?.executed)) return { ...flow, status: 'BLOCKED', failedStepId: step.id,
        reason: `BUSINESS_FLOW_BLOCKED：${step.name} 未获得真实 PASS Evidence`, beforeState,
        actualState: status, expectedState: step.expectedState };
      if (!result) return { ...flow, status: 'BLOCKED', failedStepId: step.id,
        reason: `BUSINESS_FLOW_BLOCKED：${step.name} 缺少 API Request/Response Evidence`, beforeState,
        actualState: ui?.evidence, expectedState: step.expectedState };
      const state = consistencyByCase.get(caseId);
      if (state?.status === 'INCONSISTENT') return { ...flow, status: 'FAIL', failedStepId: step.id,
        reason: state.reason, beforeState: state.before, actualState: state.after, expectedState: step.expectedState };
      if (state?.status === 'BLOCKED') return { ...flow, status: 'BLOCKED', failedStepId: step.id,
        reason: state.reason, beforeState: state.before, actualState: state.after, expectedState: step.expectedState };
      if (previousResult && step.dependencies?.some((item) => item.kind === 'OUTPUT')) {
        const outputId = responseObservation(previousResult)?.resourceId;
        const inputId = requestResourceId(result);
        if (!outputId || !inputId) return { ...flow, status: 'BLOCKED', failedStepId: step.id,
          reason: 'FLOW_DEPENDENCY_UNOBSERVABLE：无法证明前一步输出已成为后一步输入', beforeState,
          actualState: { outputId, inputId }, expectedState: 'previous.response.id = current.request.resourceId' };
        if (outputId !== inputId) return { ...flow, status: 'FAIL', failedStepId: step.id,
          reason: `BUSINESS_FLOW_FAILED：输出资源 ${outputId} 未传递给后一步输入 ${inputId}`, beforeState,
          actualState: { outputId, inputId }, expectedState: '相同 Resource ID' };
      }
      previousResult = result;
      beforeState = responseObservation(result);
    }

    // 跨步骤主键与因果时序强校验
    const crossStepAudit = auditCrossStepConsistency({
      flow,
      results: input.results,
      observations,
      uiResults: input.uiResults,
    });
    crossStepAudits.push(crossStepAudit);

    if (!crossStepAudit.passed) {
      return {
        ...flow,
        status: 'FAIL',
        failedStepId: flow.steps[0]?.id,
        reason: `BUSINESS_FLOW_FAILED：${crossStepAudit.reason}`,
        crossStepAudit,
        beforeState: flow.steps.length ? observations.filter((item) => item.caseId === flow.steps[0].caseIds[0] && item.phase === 'BEFORE') : undefined,
        actualState: crossStepAudit.inconsistencies,
        expectedState: '跨步骤主键与因果一致',
      };
    }

    return {
      ...flow,
      status: 'PASS',
      crossStepAudit,
      beforeState: flow.steps.length ? observations.filter((item) => item.caseId === flow.steps[0].caseIds[0] && item.phase === 'BEFORE') : undefined,
      actualState: previousResult ? responseObservation(previousResult) : undefined,
      expectedState: flow.steps.at(-1)?.expectedState,
    };
  });
  const passed = flows.filter((flow) => flow.status === 'PASS').length;
  return { graph: { ...input.graph, applicable: flows.length > 0,
    flows, coverage: flows.length ? Math.round(passed / flows.length * 100) : 0 }, consistency, observations, crossStepAudits };
}

export function evaluateCrossCaseInvariants(input: {
  invariants: readonly DevTestInvariant[];
  testCases: readonly TestCase[];
  results: readonly AcceptanceCaseExecutionResult[];
  consistency: readonly DevTestStateConsistencyResult[];
  oracleResults?: readonly DevTestOracleResult[];
}): DevTestInvariant[] {
  const resultByCase = new Map(input.results.map((result) => [result.caseId, result]));
  const consistencyByCase = new Map(input.consistency.map((item) => [item.caseId, item]));
  const oracleByCase = new Map((input.oracleResults ?? []).map((item) => [item.caseId, item]));
  return input.invariants.map((invariant) => {
    const expanded = input.testCases.filter((testCase) => invariant.kind === 'ISOLATION'
      ? ['PERMISSION', 'DATA_ISOLATION', 'AUTH'].includes(testCase.testType ?? '')
      : invariant.linkedCaseIds.includes(testCase.id));
    const entryPointCaseIds = [...new Set([...invariant.linkedCaseIds, ...expanded.map((item) => item.id)])];
    const failedCaseIds = entryPointCaseIds.filter((caseId) => {
      const result = resultByCase.get(caseId);
      const oracle = oracleByCase.get(caseId);
      const assertionViolation = result?.status === 'FAIL' && result.evidence.assertions.some((assertion) => !assertion.pass
        && (assertion.factIds ?? []).some((factId) => invariant.sourceFactIds.includes(factId)));
      const evidenceViolation = input.testCases.find((item) => item.id === caseId)?.evidenceRequirements
        ?.some((item) => item.factIds.some((factId) => invariant.sourceFactIds.includes(factId))) === true;
      return oracle?.verdict === 'FAIL' && oracle.evidence.complete
        && (assertionViolation || (consistencyByCase.get(caseId)?.status === 'INCONSISTENT') || evidenceViolation);
    });
    const passedCaseIds = entryPointCaseIds.filter((caseId) => {
      const result = resultByCase.get(caseId);
      const oracle = oracleByCase.get(caseId);
      if (result?.status !== 'PASS' || oracle?.verdict !== 'PASS' || !oracle.evidence.complete) return false;
      const hasBoundAssertion = result.evidence.assertions.some((assertion) => assertion.pass
        && (assertion.factIds ?? []).some((factId) => invariant.sourceFactIds.includes(factId)));
      if (!hasBoundAssertion) return false;
      const requiresState = invariant.requiredEvidence.some((item) => item !== 'RESPONSE');
      return requiresState ? consistencyByCase.get(caseId)?.status === 'CONSISTENT'
        : !['INCONSISTENT', 'BLOCKED'].includes(consistencyByCase.get(caseId)?.status ?? 'NOT_REQUIRED');
    });
    const blockedCaseIds = entryPointCaseIds.filter((caseId) => !failedCaseIds.includes(caseId) && !passedCaseIds.includes(caseId));
    const status: DevTestInvariant['status'] = failedCaseIds.length ? 'FAILED'
      : blockedCaseIds.length || !entryPointCaseIds.length ? 'BLOCKED' : 'VERIFIED';
    return { ...invariant, linkedCaseIds: entryPointCaseIds, entryPointCaseIds, failedCaseIds, passedCaseIds, blockedCaseIds, status };
  });
}

export function buildBusinessLevelProblems(input: {
  graph: DevTestBusinessFlowGraph;
  invariants: readonly DevTestInvariant[];
  consistency: readonly DevTestStateConsistencyResult[];
  reproductionRun: boolean;
}): DevTestProblem[] {
  const problems: DevTestProblem[] = [];
  for (const flow of input.graph.flows.filter((item) => item.status === 'FAIL')) {
    const isCrossStep = Boolean(flow.crossStepAudit && !flow.crossStepAudit.passed);
    problems.push({
      id: 'P000',
      type: isCrossStep ? 'DATA_CONSISTENCY_BUG' : 'FEATURE_BUG',
      severity: 'CRITICAL',
      dimension: 'FUNCTIONAL',
      scope: isCrossStep ? 'DATA_CONSISTENCY' : 'FEATURE',
      businessFlowId: flow.id,
      message: flow.reason ?? 'BUSINESS_FLOW_FAILED',
      reasonCode: isCrossStep ? 'CROSS_STEP_CORRELATION_ERROR' : 'BUSINESS_FLOW_FAILED',
      affectedCases: flow.steps.flatMap((step) => step.caseIds),
      rootCause: isCrossStep ? `CROSS_STEP:${flow.id}` : `BUSINESS_FLOW:${flow.id}`,
      failureClass: 'PRODUCT_BUG',
      judgement: input.reproductionRun ? 'CONFIRMED_BUG' : 'LIKELY_BUG',
      reproducible: input.reproductionRun,
      confidence: input.reproductionRun ? 1 : 0.9,
      confidenceLabel: input.reproductionRun ? 'CONFIRMED' : 'LIKELY',
      evidence: {
        failedStepId: flow.failedStepId,
        crossStepAudit: flow.crossStepAudit,
        before: flow.beforeState,
        actual: flow.actualState,
        expected: flow.expectedState,
      },
      expected: JSON.stringify(flow.expectedState),
      actual: JSON.stringify(flow.actualState),
      remediation: isCrossStep
        ? '修复前后步骤的主键传递（task_id, project_id, user_id, asset_url）与时序一致性。'
        : '修复失败步骤及其输入输出/状态依赖，然后运行 Regression Guard。',
    });
  }
  for (const item of input.consistency.filter((result) => result.status === 'INCONSISTENT')) problems.push({
    id: 'P000', type: 'DATA_CONSISTENCY_BUG', severity: 'CRITICAL', dimension: 'FUNCTIONAL', scope: 'DATA_CONSISTENCY',
    message: item.reason ?? 'DATA_INCONSISTENCY', reasonCode: 'DATA_INCONSISTENCY', affectedCases: [item.caseId],
    rootCause: `DATA_CONSISTENCY:${item.caseId}`, failureClass: 'PRODUCT_BUG',
    judgement: input.reproductionRun ? 'CONFIRMED_BUG' : 'LIKELY_BUG', reproducible: input.reproductionRun,
    confidence: input.reproductionRun ? 1 : 0.9, confidenceLabel: input.reproductionRun ? 'CONFIRMED' : 'LIKELY',
    evidence: { before: item.before, after: item.after, sources: item.sources },
    remediation: '核对 Response 与 Database/Task/Billing/Audit/Resource 的提交边界和一致性。',
  });
  for (const invariant of input.invariants.filter((item) => item.status === 'FAILED')) problems.push({
    id: 'P000', type: 'BUSINESS_RULE_BUG', severity: 'CRITICAL', dimension: invariant.kind === 'ISOLATION' ? 'DATA_ISOLATION' : 'FUNCTIONAL',
    scope: 'BUSINESS_RULE', message: `业务不变量被违反：${invariant.statement}`, reasonCode: 'BUSINESS_INVARIANT_VIOLATED',
    affectedCases: invariant.failedCaseIds ?? invariant.linkedCaseIds, rootCause: `INVARIANT:${invariant.id}`,
    failureClass: 'PRODUCT_BUG', judgement: input.reproductionRun ? 'CONFIRMED_BUG' : 'LIKELY_BUG',
    reproducible: input.reproductionRun, confidence: input.reproductionRun ? 1 : 0.9,
    confidenceLabel: input.reproductionRun ? 'CONFIRMED' : 'LIKELY',
    evidence: { invariant, failedCaseIds: invariant.failedCaseIds }, remediation: '修复所有入口共享的业务规则实现，并重跑同一 Invariant 的全部 Case。',
  });
  return problems;
}
