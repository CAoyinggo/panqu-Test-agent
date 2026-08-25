import type {
  BlockedReason,
  BlockedReasonCode,
  EvidenceRequirement,
  Scenario,
  ScenarioEvidenceKind,
  ScenarioExecutionMode,
  ScenarioOperation,
} from './scenario-contract.js';
import {
  TEST_PATTERN_REGISTRY,
  type PatternProofObligation,
  type TestPatternId,
} from './test-pattern-registry.js';

export interface ScenarioExecutionCapabilities {
  /** Processor 名称 allowlist；名称匹配不代表支持所有 Operation，可再提供 supportsOperation。 */
  processors: ReadonlySet<string>;
  evidenceKinds: ReadonlySet<ScenarioEvidenceKind>;
  prepareHooks: ReadonlySet<string>;
  cleanupHooks: ReadonlySet<string>;
  availableDependencies?: ReadonlySet<string>;
  executorAvailable: boolean;
  environmentAvailable: boolean;
  policyAllowed: boolean;
  supportsOperation?: (processor: string, operation: ScenarioOperation) => boolean;
  supportsEvidence?: (processor: string, operation: ScenarioOperation, kind: ScenarioEvidenceKind) => boolean;
  /** Trusted Runner may exempt an explicitly verified reject-only probe from Cleanup. */
  sideEffectFreeProbe?: (operation: ScenarioOperation) => boolean;
}

export type ScenarioGateDisposition = 'EXECUTABLE' | 'DESIGNED_ONLY' | 'BLOCKED' | 'NOT_EXECUTED';

export interface ScenarioExecutabilityGateResult {
  allowed: boolean;
  disposition: ScenarioGateDisposition;
  declaredMode: ScenarioExecutionMode;
  reasons: BlockedReason[];
  checkedAt: string;
  obligations: Array<{ id: string; satisfied: boolean; detail: string }>;
}

const STATE_PATTERNS = new Set(['PERSISTENCE', 'NON_MUTATION', 'ATOMICITY', 'STATE_MACHINE', 'ASYNC']);
const SIDE_EFFECT_PATTERNS = new Set(['IDEMPOTENCY', 'BILLING', 'PROVIDER_FAILURE', 'CALLBACK', 'AUDIT']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function reason(code: BlockedReasonCode, message: string, details: Record<string, unknown> = {}): BlockedReason {
  return { code, stage: 'GATE', message, details, recoverable: true };
}

function hasStateAssertion(scenario: Scenario): boolean {
  return scenario.assertions.some((assertion) => assertion.channel === 'STATE' || assertion.channel === 'DATA'
    || assertion.operator === 'UNCHANGED' || assertion.operator === 'TRANSITIONED_TO');
}

function hasSideEffectAssertion(scenario: Scenario): boolean {
  return scenario.assertions.some((assertion) => ['SIDE_EFFECT', 'AUDIT', 'PROVIDER', 'QUEUE'].includes(assertion.channel)
    || assertion.operator === 'COUNT_EQUALS');
}

function hasEvidence(scenario: Scenario, kinds: readonly ScenarioEvidenceKind[]): boolean {
  return scenario.evidenceRequirements.some((evidence) => kinds.includes(evidence.kind));
}

function evidenceSourceExists(evidence: EvidenceRequirement, operationIds: ReadonlySet<string>): boolean {
  const source = evidence.operationId ?? evidence.sourceRef;
  return Boolean(source && (operationIds.has(source) || !/^STEP-/i.test(source)));
}

function addUnique(reasons: BlockedReason[], next: BlockedReason): void {
  if (!reasons.some((existing) => existing.code === next.code && existing.message === next.message)) reasons.push(next);
}

function dependencyCycle(operations: readonly ScenarioOperation[]): string[] | undefined {
  const graph = new Map(operations.map((operation) => [operation.id, operation.dependsOn ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return undefined;
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id) ?? []) {
      if (!graph.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const operation of operations) {
    const cycle = visit(operation.id);
    if (cycle) return cycle;
  }
  return undefined;
}

function patternProof(
  scenario: Scenario,
  patternId: TestPatternId,
  obligation: PatternProofObligation,
): { satisfied: boolean; code: BlockedReasonCode; detail: string } {
  const assertions = scenario.assertions;
  const evidence = scenario.evidenceRequirements.filter((item) => item.requiredForPass);
  const hasAllowedEvidence = obligation.evidenceKinds.length === 0
    || evidence.some((item) => obligation.evidenceKinds.includes(item.kind));
  const hasAllowedAssertion = obligation.channels.length === 0
    || assertions.some((item) => obligation.channels.includes(item.channel));
  const stateAfterEvidence = evidence.some((item) => ['STATE_AFTER', 'DATABASE', 'RESOURCE'].includes(item.kind));
  const stateBeforeEvidence = evidence.some((item) => item.kind === 'STATE_BEFORE');
  const asyncInitialResponse = scenario.patternIds.includes('ASYNC') && evidence.some((item) => {
    if (item.kind !== 'RESPONSE' || !item.operationId) return false;
    const operation = scenario.operations.find((candidate) => candidate.id === item.operationId);
    return operation?.channel === 'API' && operation.method !== undefined && MUTATING_METHODS.has(operation.method);
  });
  const sideEffectEvidence = evidence.some((item) => ['EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD'].includes(item.kind));
  const countAssertion = assertions.some((item) => item.operator === 'COUNT_EQUALS');
  let satisfied = hasAllowedEvidence && hasAllowedAssertion;
  let code: BlockedReasonCode = hasAllowedEvidence ? 'MISSING_ASSERTION' : 'MISSING_EVIDENCE';
  switch (obligation.kind) {
    case 'OPERATION_BINDING':
      satisfied = scenario.operations.filter((item) => item.channel === 'API')
        .every((item) => Boolean(item.method && item.path));
      code = 'MISSING_OPERATION_BINDING';
      break;
    case 'RESPONSE_ASSERTION':
      code = hasAllowedAssertion ? 'MISSING_EVIDENCE' : 'MISSING_RESPONSE_ASSERTION';
      break;
    case 'IDENTITY_CONTEXT':
      satisfied = Boolean(scenario.actor?.id && scenario.authentication) && hasAllowedEvidence;
      code = scenario.actor?.id ? 'MISSING_AUTHENTICATION' : 'MISSING_ACTOR';
      break;
    case 'SCOPE_CONTEXT':
      satisfied = Boolean(scenario.scope.resourceOwnerId
        && (scenario.scope.tenantId || scenario.scope.projectId || scenario.scope.workspaceId || scenario.scope.organizationId))
        && hasAllowedEvidence;
      code = 'MISSING_RESOURCE_OWNER';
      break;
    case 'STATE_BEFORE':
      // Async creation responses can establish the protocol-level initial state;
      // persistence still requires a later independent STATE_AFTER observation.
      satisfied = stateBeforeEvidence || asyncInitialResponse;
      code = 'MISSING_STATE_OBSERVER';
      break;
    case 'STATE_AFTER':
      satisfied = stateAfterEvidence && hasAllowedAssertion;
      code = 'MISSING_STATE_OBSERVER';
      break;
    case 'STATE_TRANSITION':
      satisfied = stateAfterEvidence && assertions.some((item) => ['TRANSITIONED_TO', 'UNCHANGED'].includes(item.operator));
      code = stateAfterEvidence ? 'MISSING_STATE_ASSERTION' : 'MISSING_STATE_OBSERVER';
      break;
    case 'NON_MUTATION':
      satisfied = stateBeforeEvidence && stateAfterEvidence && assertions.some((item) => item.operator === 'UNCHANGED');
      code = stateBeforeEvidence && stateAfterEvidence ? 'MISSING_STATE_ASSERTION' : 'MISSING_STATE_OBSERVER';
      break;
    case 'ENTITY_COUNT':
      satisfied = stateAfterEvidence && assertions.some((item) => item.operator === 'COUNT_EQUALS'
        && ['STATE', 'DATA', 'API'].includes(item.channel));
      code = stateAfterEvidence ? 'MISSING_STATE_ASSERTION' : 'MISSING_STATE_OBSERVER';
      break;
    case 'SIDE_EFFECT_COUNT':
      satisfied = sideEffectEvidence && countAssertion;
      code = sideEffectEvidence ? 'MISSING_SIDE_EFFECT_ASSERTION' : 'MISSING_SIDE_EFFECT_OBSERVER';
      break;
    case 'ATOMIC_ROLLBACK':
      satisfied = stateBeforeEvidence && stateAfterEvidence && hasStateAssertion(scenario);
      code = stateBeforeEvidence && stateAfterEvidence ? 'MISSING_STATE_ASSERTION' : 'MISSING_STATE_OBSERVER';
      break;
    case 'TERMINAL_STATE':
      satisfied = stateAfterEvidence && assertions.some((item) => item.operator === 'TRANSITIONED_TO'
        || item.channel === 'STATE' && item.operator === 'EQUALS');
      code = stateAfterEvidence ? 'MISSING_STATE_ASSERTION' : 'MISSING_STATE_OBSERVER';
      break;
    case 'CORRELATION':
      satisfied = hasAllowedEvidence && scenario.operations.some((item) => Boolean(item.capture)
        || Boolean(item.dependsOn?.length));
      code = 'MISSING_OPERATION_BINDING';
      break;
    case 'BILLING_DELTA':
      satisfied = evidence.some((item) => ['BILLING_RECORD', 'STATE_AFTER'].includes(item.kind))
        && assertions.some((item) => ['STATE', 'SIDE_EFFECT', 'PROVIDER', 'DATA'].includes(item.channel));
      code = 'MISSING_SIDE_EFFECT_OBSERVER';
      break;
    case 'EXTERNAL_CALL':
      satisfied = evidence.some((item) => ['PROVIDER_CALL', 'TRACE'].includes(item.kind));
      code = 'MISSING_SIDE_EFFECT_OBSERVER';
      break;
    case 'AUDIT_RECORD':
      satisfied = evidence.some((item) => ['AUDIT_RECORD', 'DATABASE'].includes(item.kind))
        && assertions.some((item) => item.channel === 'AUDIT');
      code = 'MISSING_SIDE_EFFECT_OBSERVER';
      break;
    case 'BOUNDARY_VECTOR':
      satisfied = scenario.testData.length > 0 && hasAllowedEvidence;
      code = 'MISSING_TEST_DATA';
      break;
    case 'NO_INFORMATION_LEAKAGE':
      satisfied = hasAllowedEvidence && assertions.some((item) => ['NOT_EXISTS', 'NOT_CONTAINS'].includes(item.operator));
      code = hasAllowedEvidence ? 'MISSING_ASSERTION' : 'MISSING_EVIDENCE';
      break;
  }
  return { satisfied, code, detail: `${patternId}/${obligation.id}：${obligation.description}` };
}

/**
 * Scenario 级执行前门禁。它只评估，不删除或改写设计资产；任何失败都发生在
 * Prepare、Processor 或真实副作用之前。
 */
export function evaluateScenarioExecutability(
  scenario: Scenario,
  capabilities: ScenarioExecutionCapabilities,
): ScenarioExecutabilityGateResult {
  const reasons = [...scenario.blockedReasons];
  const obligations: ScenarioExecutabilityGateResult['obligations'] = [];
  const check = (id: string, satisfied: boolean, detail: string, failure?: BlockedReason): void => {
    obligations.push({ id, satisfied, detail });
    if (!satisfied && failure) addUnique(reasons, failure);
  };

  if (scenario.executionMode === 'DESIGNED_ONLY') {
    return {
      allowed: false, disposition: 'DESIGNED_ONLY', declaredMode: scenario.executionMode,
      reasons, checkedAt: new Date().toISOString(), obligations,
    };
  }
  if (scenario.executionMode === 'NOT_EXECUTED' || scenario.executionMode === 'TIMEOUT' || scenario.executionMode === 'CANCELLED') {
    return {
      allowed: false, disposition: 'NOT_EXECUTED', declaredMode: scenario.executionMode,
      reasons, checkedAt: new Date().toISOString(), obligations,
    };
  }
  if (scenario.executionMode === 'BLOCKED') {
    if (!reasons.length) reasons.push(reason('INVALID_SCENARIO', 'BLOCKED Scenario 缺少结构化 Blocked Reason'));
    return {
      allowed: false, disposition: 'BLOCKED', declaredMode: scenario.executionMode,
      reasons, checkedAt: new Date().toISOString(), obligations,
    };
  }

  check('acceptance-criteria', scenario.acceptanceCriteriaIds.length > 0, '至少一个 Acceptance Criterion',
    reason('MISSING_ACCEPTANCE_CRITERIA', 'Scenario 没有 Acceptance Criteria'));
  check('operations', scenario.operations.length > 0, '至少一个原子 Operation',
    reason('MISSING_API_CONTRACT', 'Scenario 没有可执行 Operation'));
  check('executor', capabilities.executorAvailable, 'Runner/Executor 可用',
    reason('MISSING_EXECUTOR', 'Scenario Runner/Executor 不可用'));
  check('environment', capabilities.environmentAvailable, '执行环境可用',
    reason('MISSING_ENVIRONMENT', '执行环境未明确可用'));
  check('policy', capabilities.policyAllowed, '执行 Policy 允许真实运行',
    reason('POLICY_BLOCKED', '执行 Policy 禁止运行本场景'));

  const operationIds = new Set(scenario.operations.map((operation) => operation.id));
  const criterionIds = new Set(scenario.acceptanceCriteriaIds);
  const scenarioAssertionIds = new Set(scenario.assertions.map((assertion) => assertion.id));
  const evidenceRequirementIds = new Set(scenario.evidenceRequirements.map((evidence) => evidence.id));
  check('unique-criterion-ids', criterionIds.size === scenario.acceptanceCriteriaIds.length,
    'Acceptance Criterion ID 唯一', reason('INVALID_SCENARIO', 'Scenario 存在重复 Acceptance Criterion ID'));
  check('unique-operation-ids', operationIds.size === scenario.operations.length, 'Operation ID 唯一',
    reason('AMBIGUOUS_OPERATION_BINDING', 'Scenario 存在重复 Operation ID'));
  check('unique-assertion-ids', scenarioAssertionIds.size === scenario.assertions.length, 'Assertion ID 唯一',
    reason('INVALID_SCENARIO', 'Scenario 存在重复 Assertion ID'));
  check('unique-evidence-ids', evidenceRequirementIds.size === scenario.evidenceRequirements.length,
    'Evidence Requirement ID 唯一', reason('INVALID_SCENARIO', 'Scenario 存在重复 Evidence Requirement ID'));
  for (const operation of scenario.operations) {
    if (operation.channel === 'API') {
      check(`method:${operation.id}`, Boolean(operation.method), `${operation.id} Method 明确`,
        reason('MISSING_METHOD', `${operation.id} 缺少 HTTP Method`, { operationId: operation.id }));
      check(`path:${operation.id}`, Boolean(operation.path?.trim()), `${operation.id} Path 明确`,
        reason('MISSING_PATH', `${operation.id} 缺少 API Path`, { operationId: operation.id }));
    }
    check(`processor:${operation.id}`, Boolean(operation.processor), `${operation.id} 声明 Processor`,
      reason('MISSING_PROCESSOR', `${operation.id} 未声明 Processor`, { operationId: operation.id }));
    if (operation.processor) {
      const registered = capabilities.processors.has(operation.processor);
      check(`processor-registered:${operation.id}`, registered, `${operation.processor} 已注册`,
        reason('MISSING_PROCESSOR', `${operation.id} 的 Processor ${operation.processor} 未注册`, { operationId: operation.id, processor: operation.processor }));
      const supported = registered && (capabilities.supportsOperation?.(operation.processor, operation) ?? true);
      check(`processor-support:${operation.id}`, supported, `${operation.processor} 支持 ${operation.channel} Operation`,
        reason('UNSUPPORTED_OPERATION', `${operation.processor} 不支持 ${operation.id}`, { operationId: operation.id, processor: operation.processor }));
    }
    check(`operation-ac:${operation.id}`, operation.acceptanceCriteriaIds.length > 0
      && operation.acceptanceCriteriaIds.every((id) => criterionIds.has(id)), `${operation.id} 精确绑定 AC`,
    reason('MISSING_OPERATION_BINDING', `${operation.id} 未绑定有效 Acceptance Criterion`, { operationId: operation.id }));
    for (const dependency of operation.dependsOn ?? []) {
      check(`dependency:${operation.id}:${dependency}`, operationIds.has(dependency), `${operation.id} 依赖 ${dependency} 存在`,
        reason('MISSING_DEPENDENCY', `${operation.id} 引用了不存在的 Operation ${dependency}`, { operationId: operation.id, dependency }));
    }
    const directAssertions = scenario.assertions.filter((assertion) => assertion.operationId === operation.id);
    check(`operation-assertion:${operation.id}`, directAssertions.length > 0,
      `${operation.id} 至少绑定一个直接业务断言`, reason('MISSING_ASSERTION', `${operation.id} 没有直接业务断言，禁止调用 Processor`, { operationId: operation.id }));
    const directAssertionIds = new Set(directAssertions.map((assertion) => assertion.id));
    const directEvidence = scenario.evidenceRequirements.filter((evidence) => evidence.requiredForPass
      && evidence.operationId === operation.id
      && evidence.assertionIds.some((assertionId) => directAssertionIds.has(assertionId)));
    check(`operation-evidence:${operation.id}`, directEvidence.length > 0,
      `${operation.id} 至少绑定一个 Required Evidence`, reason('MISSING_EVIDENCE', `${operation.id} 没有与直接断言闭合的 Required Evidence`, { operationId: operation.id }));
  }
  const cycle = dependencyCycle(scenario.operations);
  check('operation-dependency-dag', !cycle, 'Operation dependsOn 构成有向无环图',
    cycle ? reason('AMBIGUOUS_OPERATION_BINDING', `Operation dependsOn 存在循环：${cycle.join(' -> ')}`, { cycle }) : undefined);

  check('assertions', scenario.assertions.length > 0, '至少一个有效业务断言',
    reason('MISSING_ASSERTION', 'Scenario 没有有效业务断言'));
  check('response-assertion', scenario.assertions.some((assertion) => ['RESPONSE', 'API', 'UI'].includes(assertion.channel)),
    '至少一个 Response/UI 结果断言', reason('MISSING_RESPONSE_ASSERTION', 'Scenario 缺少 Response/UI 结果断言'));
  for (const assertion of scenario.assertions) {
    check(`assertion-ac:${assertion.id}`, assertion.acceptanceCriteriaIds.length > 0
      && assertion.acceptanceCriteriaIds.every((id) => criterionIds.has(id)), `${assertion.id} 绑定有效 AC`,
    reason('MISSING_ASSERTION', `${assertion.id} 未绑定有效 Acceptance Criterion`, { assertionId: assertion.id }));
    check(`assertion-operation:${assertion.id}`, !assertion.operationId || operationIds.has(assertion.operationId),
      `${assertion.id} 的 Operation 引用有效`, reason('MISSING_OPERATION_BINDING', `${assertion.id} 引用了不存在的 Operation`, { assertionId: assertion.id, operationId: assertion.operationId }));
    check(`assertion-oracle:${assertion.id}`, assertion.expected !== undefined || assertion.expectedFrom !== undefined
      || ['EXISTS', 'NOT_EXISTS', 'UNCHANGED'].includes(assertion.operator), `${assertion.id} 具有确定性 Oracle`,
    reason('AMBIGUOUS_ORACLE', `${assertion.id} 缺少 Expected/Expected From`, { assertionId: assertion.id }));
    const linkedEvidence = scenario.evidenceRequirements.filter((evidence) => assertion.evidenceRequirementIds.includes(evidence.id)
      && evidence.assertionIds.includes(assertion.id)
      && (!assertion.operationId || evidence.operationId === assertion.operationId));
    check(`assertion-evidence:${assertion.id}`, assertion.evidenceRequirementIds.length > 0 && linkedEvidence.length > 0,
      `${assertion.id} 双向绑定同 Operation Evidence`, reason('MISSING_EVIDENCE', `${assertion.id} 没有闭合到同 Operation 的 Evidence Requirement`, { assertionId: assertion.id }));
  }
  for (const criterionId of scenario.acceptanceCriteriaIds) {
    check(`criterion-trace:${criterionId}`, scenario.operations.some((operation) => operation.acceptanceCriteriaIds.includes(criterionId))
      && scenario.assertions.some((assertion) => assertion.acceptanceCriteriaIds.includes(criterionId)), `${criterionId} 可追溯到 Operation + Assertion`,
    reason('MISSING_OPERATION_BINDING', `${criterionId} 未闭合到 Operation 和 Assertion`, { acceptanceCriterionId: criterionId }));
  }

  const assertionIds = scenarioAssertionIds;
  for (const evidence of scenario.evidenceRequirements.filter((item) => item.requiredForPass)) {
    check(`evidence-source:${evidence.id}`, evidenceSourceExists(evidence, operationIds), `${evidence.id} 有明确采集源`,
      reason('MISSING_EVIDENCE', `${evidence.id} 缺少可解析的证据源`, { evidenceId: evidence.id }));
    check(`evidence-assertion:${evidence.id}`, evidence.assertionIds.length > 0
      && evidence.assertionIds.every((id) => assertionIds.has(id)), `${evidence.id} 绑定有效 Assertion`,
    reason('MISSING_EVIDENCE', `${evidence.id} 没有绑定有效 Assertion`, { evidenceId: evidence.id }));
    const evidenceOperation = evidence.operationId ? scenario.operations.find((operation) => operation.id === evidence.operationId) : undefined;
    const evidenceSupported = evidenceOperation?.processor && capabilities.supportsEvidence
      ? capabilities.supportsEvidence(evidenceOperation.processor, evidenceOperation, evidence.kind)
      : capabilities.evidenceKinds.has(evidence.kind);
    check(`evidence-provider:${evidence.id}`, evidenceSupported,
      `${evidence.kind} Evidence Provider 可用`, reason('MISSING_EVIDENCE', `${evidence.id} 所需 ${evidence.kind} Evidence Provider 不可用`, { evidenceId: evidence.id, kind: evidence.kind }));
  }

  for (const patternId of scenario.patternIds) {
    const definition = TEST_PATTERN_REGISTRY[patternId as TestPatternId];
    if (!definition) {
      check(`pattern:${patternId}`, false, `Pattern ${patternId} 已注册`,
        reason('INVALID_SCENARIO', `未知 Test Pattern：${patternId}`, { patternId }));
      continue;
    }
    for (const obligation of definition.proofObligations) {
      const proof = patternProof(scenario, definition.id, obligation);
      check(`pattern-proof:${definition.id}:${obligation.id}`, proof.satisfied, proof.detail,
        reason(proof.code, `Pattern Proof Obligation 未满足：${proof.detail}`, { patternId: definition.id, obligationId: obligation.id }));
    }
  }

  const patterns = new Set(scenario.patternIds);
  if ([...patterns].some((pattern) => STATE_PATTERNS.has(pattern))) {
    check('state-assertion', hasStateAssertion(scenario), '状态型 Pattern 具有状态断言',
      reason('MISSING_STATE_ASSERTION', '状态型 Pattern 缺少 State/Non-Mutation/Transition Assertion'));
    check('state-evidence', hasEvidence(scenario, ['STATE_BEFORE', 'STATE_AFTER', 'DATABASE', 'RESOURCE']), '状态型 Pattern 具有独立状态证据',
      reason('MISSING_STATE_OBSERVER', '状态型 Pattern 缺少 State/Database/Resource Evidence'));
  }
  if (patterns.has('NON_MUTATION')) {
    check('non-mutation-before-after', hasEvidence(scenario, ['STATE_BEFORE']) && hasEvidence(scenario, ['STATE_AFTER']),
      'Non-Mutation 同时具有 Before/After Evidence', reason('MISSING_STATE_OBSERVER', 'Non-Mutation 必须同时采集 Before 和 After 状态'));
  }
  if ([...patterns].some((pattern) => SIDE_EFFECT_PATTERNS.has(pattern))) {
    check('side-effect-assertion', hasSideEffectAssertion(scenario), '副作用型 Pattern 具有副作用断言',
      reason('MISSING_SIDE_EFFECT_ASSERTION', '副作用型 Pattern 缺少次数、账单、Provider、Queue 或 Audit Assertion'));
    check('side-effect-evidence', hasEvidence(scenario, ['EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD']),
      '副作用型 Pattern 具有外部证据', reason('MISSING_SIDE_EFFECT_OBSERVER', '副作用型 Pattern 缺少可观察的外部 Evidence'));
  }
  if (patterns.has('TENANT_ISOLATION')) {
    check('tenant-context', Boolean(scenario.scope.tenantId && scenario.scope.resourceOwnerId), 'Tenant 与 Resource Owner 明确',
      reason('MISSING_RESOURCE_OWNER', 'Tenant Isolation 必须明确 tenantId 与 resourceOwnerId'));
  }
  if (patterns.has('PROJECT_ISOLATION')) {
    check('project-context', Boolean(scenario.scope.projectId && scenario.scope.resourceOwnerId), 'Project 与 Resource Owner 明确',
      reason('MISSING_RESOURCE_OWNER', 'Project Isolation 必须明确 projectId 与 resourceOwnerId'));
  }
  if (patterns.has('AUTHORIZATION')) {
    const authentication = scenario.authentication;
    check('actor', Boolean(scenario.actor?.id), 'Authorization Actor 明确', reason('MISSING_ACTOR', 'Authorization 场景缺少 Actor'));
    check('authentication', Boolean(authentication)
      && (authentication?.required === false || Boolean(authentication?.credentialRef)), 'Authentication 凭据引用明确',
    reason('MISSING_AUTHENTICATION', 'Authorization 场景缺少 Authentication 或 credentialRef'));
  }

  for (const hook of scenario.prepare.filter((item) => item.required)) {
    check(`prepare:${hook.handler}`, capabilities.prepareHooks.has(hook.handler), `Prepare Hook ${hook.handler} 可用`,
      reason('MISSING_PREPARE', `Prepare Hook ${hook.handler} 未注册`, { hook: hook.handler }));
  }
  const mutates = scenario.operations.some((operation) => (operation.channel === 'DATA'
    || operation.channel === 'API' && operation.method && MUTATING_METHODS.has(operation.method))
    && capabilities.sideEffectFreeProbe?.(operation) !== true);
  if (mutates) check('cleanup-declared', scenario.cleanup.length > 0, '写场景声明 Cleanup', reason('MISSING_CLEANUP', '可能产生数据变更的 Scenario 必须声明 Cleanup'));
  for (const hook of scenario.cleanup.filter((item) => item.required)) {
    check(`cleanup:${hook.handler}`, capabilities.cleanupHooks.has(hook.handler), `Cleanup Hook ${hook.handler} 可用`,
      reason('MISSING_CLEANUP', `Cleanup Hook ${hook.handler} 未注册`, { hook: hook.handler }));
  }
  for (const dependency of scenario.dependencies) {
    check(`scenario-dependency:${dependency}`, capabilities.availableDependencies?.has(dependency) === true,
      `Dependency ${dependency} 可用`, reason('MISSING_DEPENDENCY', `依赖 ${dependency} 未确认可用`, { dependency }));
  }

  return {
    allowed: reasons.length === 0,
    disposition: reasons.length ? 'BLOCKED' : 'EXECUTABLE',
    declaredMode: scenario.executionMode,
    reasons,
    checkedAt: new Date().toISOString(),
    obligations,
  };
}
