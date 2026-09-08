import {
  checkDslExecutable,
  isDesignedOnlyCase,
  type AssertionDefinition,
  type TestCase,
} from '../agents/test-design/testcase-schema.js';
import {
  acceptanceCaseSemanticDigest,
  assignStableAcceptanceCaseIds,
} from './acceptance-execution-plan.js';
import type { AcceptanceRequirement } from './requirement-ir.js';
import type { TestDimension, TestObjective } from './test-objective.js';
import { buildBusinessModelProjection } from './business-model.js';
import { checkTestCaseStandardization } from './standardization-gate.js';

export type TestCaseQualityIssueCode =
  | 'SOURCE_FACT_MISSING'
  | 'SOURCE_OBJECTIVE_MISSING'
  | 'EXPECTED_OUTCOME_UNKNOWN'
  | 'EXECUTION_CONTRACT_INCOMPLETE'
  | 'ACTOR_CONTEXT_MISSING'
  | 'TARGET_CONTEXT_MISSING'
  | 'EXECUTOR_UNAVAILABLE'
  | 'HEURISTIC_EXECUTION_FORBIDDEN'
  | 'SOURCE_AUTHORITY_INVALID'
  | 'TEMPLATE_FIELD_MISSING'
  | 'EXECUTABLE_STEP_INCOMPLETE'
  | 'ORACLE_INCOMPLETE'
  | 'EXPECTED_ORACLE_MISMATCH'
  | 'EXPECTED_PROOF_MISSING'
  | 'EVIDENCE_TRACE_INCOMPLETE'
  | 'CLEANUP_PLAN_MISSING'
  | 'DUPLICATE_SEMANTICS'
  | 'BUSINESS_RELEVANCE_MISSING'
  | 'DETERMINISM_MISSING'
  | 'EVIDENCE_BACKING_MISSING'
  | 'BUSINESS_RISK_DUPLICATE'
  | 'BUSINESS_RISK_UNCOVERED'
  | 'SCENARIO_COVERAGE_MISSING'
  | 'BUSINESS_RELATIONSHIP_INVALID'
  | 'RISK_JUSTIFICATION_MISSING'
  | 'UNKNOWN_HANDLING_INVALID'
  | 'STANDARDIZATION_VIOLATION';

export interface TestCaseQualityIssue {
  code: TestCaseQualityIssueCode;
  disposition: 'BLOCKED' | 'DESIGNED_ONLY' | 'DEDUPLICATED';
  message: string;
}

export interface TestCaseQualityAssessment {
  caseId: string;
  status: 'READY' | 'DESIGNED_ONLY' | 'BLOCKED';
  issues: TestCaseQualityIssue[];
  traceable: boolean;
  expectedOutcomeKnown: boolean;
  executable: boolean;
  dimensions: {
    traceable: boolean;
    businessRelevant: boolean;
    executable: boolean;
    deterministic: boolean;
    evidenceBacked: boolean;
    nonDuplicate: boolean;
    riskJustified: boolean;
  };
}

export interface TestCaseQualityGateResult {
  testCases: TestCase[];
  assessments: TestCaseQualityAssessment[];
  generatedCount: number;
  deduplicatedCount: number;
  businessChecks: TestCaseQualityIssue[];
}

const mergeUnique = <T>(left: T[] = [], right: T[] = []): T[] => [...new Set([...left, ...right])];

function mergeDuplicateTrace(target: TestCase, duplicate: TestCase): void {
  if (target.source && duplicate.source) {
    target.source.factIds = mergeUnique(target.source.factIds, duplicate.source.factIds);
    target.source.objectiveIds = mergeUnique(target.source.objectiveIds, duplicate.source.objectiveIds);
    target.source.acceptanceCriteriaIds = mergeUnique(
      target.source.acceptanceCriteriaIds,
      duplicate.source.acceptanceCriteriaIds,
    );
  }
  for (const assertion of duplicate.assertions) {
    const existing = target.assertions.find((candidate) => candidate.type === assertion.type
      && candidate.path === assertion.path
      && candidate.header === assertion.header
      && JSON.stringify(candidate.expected) === JSON.stringify(assertion.expected));
    if (!existing) target.assertions.push(assertion);
    else {
      existing.factIds = mergeUnique(existing.factIds, assertion.factIds);
      existing.objectiveIds = mergeUnique(
        existing.objectiveIds ?? (existing.objectiveId ? [existing.objectiveId] : []),
        assertion.objectiveIds ?? (assertion.objectiveId ? [assertion.objectiveId] : []),
      );
    }
  }
  for (const requirement of duplicate.evidenceRequirements ?? []) {
    const existing = (target.evidenceRequirements ??= []).find((candidate) =>
      candidate.channel === requirement.channel && candidate.phase === requirement.phase
      && (candidate.expectation ?? 'PRESENT') === (requirement.expectation ?? 'PRESENT'));
    if (!existing) target.evidenceRequirements.push({ ...requirement, factIds: [...requirement.factIds] });
    else {
      existing.required = existing.required || requirement.required;
      existing.factIds = mergeUnique(existing.factIds, requirement.factIds);
      if (!existing.description.includes(requirement.description)) {
        existing.description = `${existing.description}；${requirement.description}`;
      }
    }
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

/**
 * DESIGNED_ONLY 的 TestType/阻断原因描述的是能力处置，不是测试意图。
 * 同一动作、oracle 与输入从多个 Objective 投影出来时合并 trace，避免把
 * UI/STATE/ERROR 或 BUSINESS_RULE/SIDE_EFFECT 的同一设计重复展示为多个 Case。
 * EXECUTABLE Case 仍使用严格的执行计划 identity，绝不与设计态跨层合并。
 */
function designedCaseSemanticDigest(testCase: TestCase): string {
  return JSON.stringify(canonical({
    actor: testCase.actor && {
      id: testCase.actor.id,
      userId: testCase.actor.userId,
      role: testCase.actor.role,
      tenantId: testCase.actor.tenantId,
    },
    data: testCase.data,
    steps: testCase.steps.map((step) => ({
      action: step.action,
      type: step.type,
      method: step.method,
      url: step.url,
      pathParams: step.pathParams,
      query: step.query,
      body: step.body,
    })),
    assertions: testCase.assertions.map((assertion) => ({
      type: assertion.type,
      target: assertion.target,
      path: assertion.path,
      operator: assertion.operator,
      expected: assertion.expected,
      description: assertion.description,
    })),
    parameter: testCase.parameterContext && {
      parameter: testCase.parameterContext.parameter,
      testData: testCase.parameterContext.testData,
      expectedResponse: testCase.parameterContext.expectedResponse,
    },
    expectedOutcome: testCase.design?.expectedOutcome ?? testCase.expected?.description,
    actions: testCase.design?.actions,
  }));
}

function deduplicate(testCases: TestCase[]): { cases: TestCase[]; count: number } {
  const cases: TestCase[] = [];
  const byDigest = new Map<string, TestCase>();
  let count = 0;
  for (const testCase of testCases) {
    const digest = isDesignedOnlyCase(testCase)
      ? designedCaseSemanticDigest(testCase)
      : acceptanceCaseSemanticDigest(testCase);
    const existing = byDigest.get(digest);
    if (!existing) {
      byDigest.set(digest, testCase);
      cases.push(testCase);
      continue;
    }
    mergeDuplicateTrace(existing, testCase);
    count++;
  }
  return { cases, count };
}

function dimensionsFor(testCase: TestCase, objectiveById: Map<string, TestObjective>): Set<TestDimension> {
  return new Set((testCase.source?.objectiveIds ?? [])
    .map((id) => objectiveById.get(id)?.dimension)
    .filter((dimension): dimension is TestDimension => Boolean(dimension)));
}

function hasTarget(testCase: TestCase): boolean {
  if (testCase.data?.targetId !== undefined && testCase.data.targetId !== null) return true;
  return testCase.steps.some((step) => step.type === 'HTTP_REQUEST'
    && Boolean(step.pathParams)
    && Object.values(step.pathParams ?? {}).some((value) => value !== undefined && value !== null));
}

function hasKnownExpected(testCase: TestCase, objectives: TestObjective[]): boolean {
  const knownObjectiveIds = new Set(objectives
    .filter((objective) => objective.outcomeStatus === 'KNOWN')
    .map((objective) => objective.id));
  const hasSourcedDeterministicOracle = testCase.assertions.some((assertion) => {
    if (assertion.type === 'DESIGN_EXPECTATION' || assertion.expected === undefined) return false;
    const assertionObjectiveIds = assertion.objectiveIds
      ?? (assertion.objectiveId ? [assertion.objectiveId] : []);
    return assertionObjectiveIds.some((id) => knownObjectiveIds.has(id));
  });
  if (hasSourcedDeterministicOracle) return true;
  // A human-readable design expectation is sufficient only when every source
  // Objective has a known oracle. One UNKNOWN auxiliary Objective must not
  // poison a separately traced deterministic assertion, but it also cannot be
  // used to justify an invented default result.
  if (!objectives.length || objectives.some((objective) => objective.outcomeStatus === 'UNKNOWN')) return false;
  if (testCase.design?.expectedOutcome?.trim()) return true;
  return Boolean(testCase.expected?.description?.trim()
    || testCase.expected?.status !== undefined
    || Object.keys(testCase.expected?.fields ?? {}).length > 0);
}

function designAssertion(testCase: TestCase, reason: string): AssertionDefinition {
  return {
    id: 'AS-DESIGN-EXPECTATION',
    channel: 'SYSTEM',
    type: 'DESIGN_EXPECTATION',
    expected: testCase.design?.expectedOutcome ?? testCase.expected?.description ?? reason,
    description: reason,
    severity: testCase.priority === 'P3' ? 'P2' : testCase.priority,
    acceptanceCriteriaIds: testCase.source?.acceptanceCriteriaIds ?? [],
    evidenceRequirementIds: [],
    factIds: testCase.source?.factIds,
    objectiveIds: testCase.source?.objectiveIds,
    objectiveId: testCase.source?.objectiveIds?.[0],
    sourceType: testCase.source?.sourceType,
    provenance: testCase.source?.provenance,
  };
}

function applyDisposition(
  testCase: TestCase,
  status: TestCaseQualityAssessment['status'],
  issues: TestCaseQualityIssue[],
): void {
  const reason = issues.map((issue) => `${issue.code}：${issue.message}`).join('；');
  testCase.metadata = {
    ...testCase.metadata,
    reason: testCase.metadata?.reason ?? (reason || undefined),
    caseQuality: { status, issues },
  };
  if (status === 'READY' || status === 'DESIGNED_ONLY' && issues.length === 0) return;
  testCase.executionMode = 'DESIGNED_ONLY';
  testCase.protocol = undefined;
  if (testCase.design) {
    testCase.design.executability = 'DESIGNED_ONLY';
    testCase.design.reason = testCase.design.reason ?? reason;
  }
  testCase.steps = testCase.schemaVersion === 'TEST_CASE_V2'
    ? testCase.steps.map((step, index) => ({
      ...step,
      id: step.id ?? `STEP-${String(index + 1).padStart(3, '0')}`,
      channel: step.channel ?? (step.type === 'HTTP_REQUEST' ? 'API' : 'FUNCTIONAL'),
      action: step.action ?? 'PLAN',
      description: step.description ?? (step.type === 'HTTP_REQUEST'
        ? `${step.method ?? 'UNKNOWN'} ${step.url ?? 'UNKNOWN'}` : step.action ?? '待补充执行动作'),
      execution: 'PLANNED',
      dependsOn: step.dependsOn ?? [],
      acceptanceCriteriaIds: step.acceptanceCriteriaIds ?? testCase.source?.acceptanceCriteriaIds ?? [],
      factIds: step.factIds ?? testCase.source?.factIds ?? [],
    }))
    : [];
  if (testCase.schemaVersion !== 'TEST_CASE_V2') testCase.assertions = [designAssertion(testCase, reason)];
  if (testCase.oracle) {
    testCase.oracle.status = testCase.requirementStatus === 'CONFIRMED' ? 'BLOCKED' : 'NEED_CONFIRMATION';
    // BLOCKED describes runtime capability, not absence of a designed Oracle.
    // Keep the Case-level contract synchronized so reports can show exactly
    // what remains unverified instead of erasing the proof obligation.
    testCase.oracle.assertionIds = testCase.assertions
      .filter((assertion) => assertion.type !== 'DESIGN_EXPECTATION')
      .map((assertion) => assertion.id!)
      .filter(Boolean);
    testCase.oracle.evidenceRequirementIds = (testCase.evidenceRequirements ?? [])
      .filter((evidence) => evidence.required)
      .map((evidence) => evidence.id!)
      .filter(Boolean);
    testCase.oracle.reason = reason;
  }
  if (testCase.readiness) {
    testCase.readiness.status = testCase.requirementStatus === 'CONFIRMED' ? 'BLOCKED' : 'NEED_CONFIRMATION';
    testCase.readiness.reasons = [...new Set([...testCase.readiness.reasons, reason])];
    const contractGaps = [
      ...(testCase.executionContract?.executor.status === 'AVAILABLE'
        ? [] : testCase.executionContract ? [testCase.executionContract.executor.ref] : ['executionContract']),
      ...(testCase.executionContract?.observers ?? [])
        .filter((observer) => observer.required && observer.status !== 'AVAILABLE')
        .map((observer) => observer.ref),
      ...(testCase.dependencies ?? [])
        .filter((dependency) => dependency.required && dependency.resolution === 'UNRESOLVED')
        .map((dependency) => dependency.ref),
      ...(testCase.preconditionPlan ?? [])
        .filter((precondition) => precondition.required && !precondition.checkRef)
        .map((precondition) => `preflight.${precondition.id}`),
    ];
    testCase.readiness.missingCapabilities = [...new Set([
      ...testCase.readiness.missingCapabilities,
      ...contractGaps,
    ])];
  }
}

function validateV2Template(testCase: TestCase): TestCaseQualityIssue[] {
  if (testCase.schemaVersion !== 'TEST_CASE_V2') return [];
  const issues: TestCaseQualityIssue[] = [];
  const missing = [
    !testCase.businessScenario?.goal && 'businessScenario.goal',
    !testCase.businessScenario?.kind && 'businessScenario.kind',
    !Array.isArray(testCase.businessScenario?.actors) && 'businessScenario.actors',
    !testCase.businessScenario?.resourceContext && 'businessScenario.resourceContext',
    !testCase.businessScenario?.ownership && 'businessScenario.ownership',
    !testCase.businessScenario?.state && 'businessScenario.state',
    !testCase.businessScenario?.permission && 'businessScenario.permission',
    !testCase.businessScenario?.flow?.steps?.length && 'businessScenario.flow.steps',
    !Array.isArray(testCase.businessScenario?.dependencies) && 'businessScenario.dependencies',
    !Array.isArray(testCase.businessScenario?.risks) && 'businessScenario.risks',
    !testCase.source?.requirementId && 'source.requirementId',
    !testCase.testType && 'testType',
    !(testCase.testAspects?.length) && 'testAspects',
    !testCase.requirementStatus && 'requirementStatus',
    testCase.data === undefined && 'data',
    !Array.isArray(testCase.preconditionPlan) && 'preconditionPlan',
    !Array.isArray(testCase.testData) && 'testData',
    !testCase.expected && 'expected',
    !Array.isArray(testCase.evidenceRequirements) && 'evidenceRequirements',
    !testCase.oracle && 'oracle',
    !Array.isArray(testCase.prepare) && 'prepare',
    !Array.isArray(testCase.cleanup) && 'cleanup',
    !Array.isArray(testCase.dependencies) && 'dependencies',
    !testCase.readiness && 'readiness',
    !testCase.executionContract && 'executionContract',
  ].filter((item): item is string => Boolean(item));
  if (missing.length) issues.push({
    code: 'TEMPLATE_FIELD_MISSING', disposition: 'BLOCKED',
    message: `TEST_CASE_V2 缺少字段：${missing.join(', ')}`,
  });
  if (!testCase.steps.length || testCase.steps.some((step) => !step.id || !step.channel
    || !step.description || !step.execution || !step.factIds?.length)
    || testCase.executionMode === 'EXECUTABLE'
      && testCase.steps.some((step) => step.execution !== 'EXECUTABLE')) issues.push({
    code: 'EXECUTABLE_STEP_INCOMPLETE', disposition: 'DESIGNED_ONLY',
    message: 'Step 必须具有 id/channel/description/execution/factIds；设计态 Step 必须显式标记 PLANNED',
  });
  const stepIds = new Set(testCase.steps.map((item) => item.id).filter(Boolean));
  const assertionIds = new Set(testCase.assertions.map((item) => item.id).filter(Boolean));
  const evidenceIds = new Set((testCase.evidenceRequirements ?? []).map((item) => item.id).filter(Boolean));
  const duplicateIds = stepIds.size !== testCase.steps.length || assertionIds.size !== testCase.assertions.length
    || evidenceIds.size !== (testCase.evidenceRequirements ?? []).length;
  const evidenceBroken = duplicateIds
    || (testCase.evidenceRequirements ?? []).some((item) => !item.id || !item.factIds.length
      || !item.sourceStepId || !stepIds.has(item.sourceStepId)
      || item.assertionIds?.some((id) => !assertionIds.has(id)))
    || testCase.assertions.some((assertion) => assertion.type !== 'DESIGN_EXPECTATION'
      && (!assertion.id || !assertion.factIds?.length
        || !assertion.evidenceRequirementIds?.length
        || assertion.evidenceRequirementIds.some((id) => !evidenceIds.has(id))))
    || Boolean(testCase.oracle && (testCase.oracle.assertionIds.some((id) => !assertionIds.has(id))
      || testCase.oracle.evidenceRequirementIds.some((id) => !evidenceIds.has(id))));
  if (evidenceBroken) issues.push({
    code: 'EVIDENCE_TRACE_INCOMPLETE', disposition: 'DESIGNED_ONLY',
    message: 'Runtime Assertion 必须通过稳定 ID 关联 Fact 与 Evidence Requirement',
  });
  if (testCase.executionMode === 'EXECUTABLE'
    && (testCase.requirementStatus !== 'CONFIRMED' || testCase.readiness?.status !== 'READY'
      || testCase.oracle?.status !== 'READY' || !testCase.oracle.assertionIds.length
      || !testCase.oracle.evidenceRequirementIds.length
      || !sameStringSet(testCase.oracle.assertionIds, testCase.assertions
        .filter((assertion) => assertion.type !== 'DESIGN_EXPECTATION').map((assertion) => assertion.id!).filter(Boolean))
      || !sameStringSet(testCase.oracle.evidenceRequirementIds, (testCase.evidenceRequirements ?? [])
        .filter((evidence) => evidence.required).map((evidence) => evidence.id!).filter(Boolean)))) issues.push({
    code: 'ORACLE_INCOMPLETE', disposition: 'DESIGNED_ONLY',
    message: 'EXECUTABLE Case 必须具有 READY 的确定性 Oracle、Assertion 与 required Evidence',
  });
  const unsupportedEvidence = (testCase.evidenceRequirements ?? []).filter((evidence) => {
    if (!evidence.required || ['API_REQUEST', 'API_RESPONSE'].includes(evidence.channel)) return false;
    return !testCase.executionContract?.observers.some((observer) => observer.required
      && observer.channel === evidence.channel && observer.phase === evidence.phase
      && observer.status === 'AVAILABLE');
  });
  if (testCase.executionMode === 'EXECUTABLE' && unsupportedEvidence.length) issues.push({
    code: 'EXECUTOR_UNAVAILABLE', disposition: 'DESIGNED_ONLY',
    message: `required Observer 未就绪：${[...new Set(unsupportedEvidence.map((item) => item.channel))].join(', ')}`,
  });
  if (testCase.executionMode === 'EXECUTABLE'
    && testCase.executionContract?.executor.status !== 'AVAILABLE') issues.push({
    code: 'EXECUTOR_UNAVAILABLE', disposition: 'DESIGNED_ONLY',
    message: `Executor 未就绪：${testCase.executionContract?.executor.ref ?? 'executionContract missing'}`,
  });
  const unresolvedDependencies = (testCase.dependencies ?? []).filter((dependency) => dependency.required
    && dependency.resolution === 'UNRESOLVED');
  const uncheckedPreconditions = (testCase.preconditionPlan ?? []).filter((precondition) => precondition.required
    && !precondition.checkRef);
  if (testCase.executionMode === 'EXECUTABLE' && (unresolvedDependencies.length || uncheckedPreconditions.length)) issues.push({
    code: 'EXECUTION_CONTRACT_INCOMPLETE', disposition: 'BLOCKED',
    message: `required 前置/依赖未解析：${[
      ...unresolvedDependencies.map((item) => item.ref),
      ...uncheckedPreconditions.map((item) => item.id),
    ].join(', ')}`,
  });
  const mutates = testCase.steps.some((step) => step.type === 'HTTP_REQUEST'
    && Boolean(step.method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(step.method)));
  if (mutates && !testCase.cleanup?.some((hook) => hook.required && hook.handler)) issues.push({
    code: 'CLEANUP_PLAN_MISSING', disposition: 'BLOCKED',
    message: '写操作必须声明 required Cleanup Hook；运行时未解析仍由 SAFE Policy 阻断',
  });
  return issues;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length
    && left.every((value) => right.includes(value));
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) return Number(value);
  return undefined;
}

function validateExpectedOracleConsistency(testCase: TestCase): TestCaseQualityIssue[] {
  if (testCase.schemaVersion !== 'TEST_CASE_V2' || testCase.executionMode !== 'EXECUTABLE') return [];
  const issues: TestCaseQualityIssue[] = [];
  const runtimeAssertions = testCase.assertions.filter((assertion) => assertion.type !== 'DESIGN_EXPECTATION');
  const expectedStatus = numericStatus(testCase.expected?.response?.status ?? testCase.expected?.status);
  if (expectedStatus !== undefined) {
    const assertedStatuses = runtimeAssertions
      .filter((assertion) => assertion.type === 'STATUS_CODE')
      .map((assertion) => numericStatus(assertion.expected))
      .filter((status): status is number => status !== undefined);
    if (assertedStatuses.length !== 1 || assertedStatuses[0] !== expectedStatus) issues.push({
      code: 'EXPECTED_ORACLE_MISMATCH', disposition: 'BLOCKED',
      message: `Expected response status ${expectedStatus} 与 STATUS_CODE Oracle ${assertedStatuses.join('/') || 'MISSING'} 不一致`,
    });
  }

  const expectedFields = testCase.expected?.response?.fields ?? testCase.expected?.fields;
  for (const [path, value] of Object.entries(expectedFields ?? {})) {
    const assertion = runtimeAssertions.find((candidate) =>
      (candidate.type === 'JSON_VALUE' || candidate.type === 'JSON_PATH')
      && candidate.path === path && Object.is(candidate.expected, value));
    if (!assertion) issues.push({
      code: 'EXPECTED_ORACLE_MISMATCH', disposition: 'BLOCKED',
      message: `Expected response field ${path} 没有值一致的 JSON Oracle`,
    });
  }

  const evidenceById = new Map((testCase.evidenceRequirements ?? []).map((evidence) => [evidence.id, evidence]));
  const matchingProof = (
    assertionChannels: ReadonlySet<NonNullable<AssertionDefinition['channel']>>,
    evidenceChannels: ReadonlySet<NonNullable<TestCase['evidenceRequirements']>[number]['channel']>,
    expectations: ReadonlySet<NonNullable<NonNullable<TestCase['evidenceRequirements']>[number]['expectation']>>,
    matchesAssertion: (assertion: AssertionDefinition) => boolean = () => true,
  ): boolean => runtimeAssertions.some((assertion) => assertion.channel && assertionChannels.has(assertion.channel)
    && matchesAssertion(assertion) && assertion.evidenceRequirementIds?.some((id) => {
      const evidence = evidenceById.get(id);
      return Boolean(evidence?.required && evidenceChannels.has(evidence.channel)
        && evidence.expectation && expectations.has(evidence.expectation)
        && evidence.assertionIds?.includes(assertion.id!));
    }));

  const stateExpectation = testCase.expected?.state?.expectation;
  if (stateExpectation && stateExpectation !== 'UNKNOWN'
    && !matchingProof(
      new Set(['STATE', 'DATA']),
      new Set(['DATABASE_STATE', 'STATE_CHANGE', 'DATA_DIFF']),
      new Set([stateExpectation]),
    )) issues.push({
      code: 'EXPECTED_PROOF_MISSING', disposition: 'BLOCKED',
      message: `Expected state=${stateExpectation} 缺少语义一致的 State Assertion 与 required Evidence`,
    });
  for (const effect of testCase.expected?.sideEffects ?? []) {
    if (effect.expectation === 'UNKNOWN') continue;
    const expectedEvidence = effect.expectation === 'REQUIRED'
      ? new Set<NonNullable<NonNullable<TestCase['evidenceRequirements']>[number]['expectation']>>(['PRESENT', 'CHANGED'])
      : new Set<NonNullable<NonNullable<TestCase['evidenceRequirements']>[number]['expectation']>>(['UNCHANGED']);
    const tokens = [effect.kind, effect.action].map((item) => item.toLowerCase());
    const proven = matchingProof(
      new Set(['SIDE_EFFECT', 'AUDIT', 'QUEUE', 'PROVIDER']),
      new Set([
        'EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD',
        'LOG', 'DATABASE_STATE', 'STATE_CHANGE', 'DATA_DIFF',
      ]),
      expectedEvidence,
      (assertion) => {
        const text = [assertion.target, assertion.path, assertion.message, assertion.description]
          .filter(Boolean).join(' ').toLowerCase();
        return tokens.some((token) => text.includes(token));
      },
    );
    if (!proven) issues.push({
      code: 'EXPECTED_PROOF_MISSING', disposition: 'BLOCKED',
      message: `Expected side effect ${effect.kind}/${effect.action}/${effect.expectation} 缺少逐项语义一致的 Assertion/Evidence`,
    });
  }
  return issues;
}

/**
 * Generator 后、Execution Plan 前的统一质量门。
 * 它只消费 Fact/Objective/Case 结构，不重新解析 Requirement 文本。
 */
export function applyTestCaseQualityGate(input: {
  requirement: AcceptanceRequirement;
  objectives: TestObjective[];
  testCases: TestCase[];
}): TestCaseQualityGateResult {
  const generatedCount = input.testCases.length;
  const deduplicated = deduplicate(input.testCases);
  const factIds = new Set(input.requirement.factLedger.map((fact) => fact.id));
  const factById = new Map(input.requirement.factLedger.map((fact) => [fact.id, fact]));
  const objectiveById = new Map(input.objectives.map((objective) => [objective.id, objective]));
  const businessModel = buildBusinessModelProjection(input.requirement);
  const assessments: TestCaseQualityAssessment[] = [];

  for (const testCase of deduplicated.cases) {
    const issues: TestCaseQualityIssue[] = [
      ...validateV2Template(testCase),
      ...validateExpectedOracleConsistency(testCase),
      ...checkTestCaseStandardization(testCase).map((violation): TestCaseQualityIssue => ({
        code: 'STANDARDIZATION_VIOLATION',
        disposition: 'BLOCKED',
        message: `${violation.kind}：${violation.message}`,
      })),
    ];
    const sourceFacts = testCase.source?.factIds ?? [];
    const sourceObjectives = testCase.source?.objectiveIds ?? [];
    if (!sourceFacts.length || sourceFacts.some((id) => !factIds.has(id))) issues.push({
      code: 'SOURCE_FACT_MISSING', disposition: 'BLOCKED',
      message: 'Case 没有完整、有效的 Requirement Fact 来源',
    });
    if (!sourceObjectives.length || sourceObjectives.some((id) => !objectiveById.has(id))) issues.push({
      code: 'SOURCE_OBJECTIVE_MISSING', disposition: 'BLOCKED',
      message: 'Case 没有完整、有效的 Test Objective 来源',
    });
    const linkedObjectives = sourceObjectives
      .map((id) => objectiveById.get(id))
      .filter((objective): objective is TestObjective => Boolean(objective));
    const linkedFacts = sourceFacts.map((id) => factById.get(id)).filter(Boolean);
    const businessFlow = businessModel.flows.find((flow) => flow.factIds.some((id) => sourceFacts.includes(id)));
    const scenarioResources = new Set(testCase.businessScenario?.resources?.map((resource) => resource.id) ?? []);
    const scenarioActors = new Set(testCase.businessScenario?.actors.map((actor) => actor.id).filter(Boolean) ?? []);
    const relationshipProblems = (testCase.businessScenario?.ownerships ?? []).flatMap((ownership) => [
      !scenarioResources.has(ownership.resourceId) && `resource=${ownership.resourceId}`,
      ownership.ownerActorId && !scenarioActors.has(ownership.ownerActorId) && `owner=${ownership.ownerActorId}`,
      ownership.tenantId && ownership.ownerActorId
        && businessModel.actors.find((actor) => actor.id === ownership.ownerActorId)?.tenantId !== ownership.tenantId
        && `tenant=${ownership.tenantId}`,
    ].filter((item): item is string => Boolean(item)));
    if (testCase.schemaVersion === 'TEST_CASE_V2'
      && (!businessFlow || !testCase.businessScenario?.factIds.some((id) => sourceFacts.includes(id)))) issues.push({
      code: 'BUSINESS_RELEVANCE_MISSING', disposition: 'BLOCKED',
      message: 'Case 没有从 Business Model Flow 派生出可追溯 Business Scenario',
    });
    if (testCase.schemaVersion === 'TEST_CASE_V2'
      && (!testCase.source?.scenarioId || testCase.businessScenario?.flow.id === undefined)) issues.push({
      code: 'SCENARIO_COVERAGE_MISSING', disposition: 'DESIGNED_ONLY',
      message: 'Case 没有闭合到 Business Scenario/Test Scenario',
    });
    if (testCase.schemaVersion === 'TEST_CASE_V2' && relationshipProblems.length) issues.push({
      code: 'BUSINESS_RELATIONSHIP_INVALID', disposition: 'BLOCKED',
      message: `Actor/Owner/Tenant/Resource 关系错误：${relationshipProblems.join(', ')}`,
    });
    const invalidAuthorityFacts = linkedFacts.filter((fact) => fact
      && (fact.epistemicType !== 'FACT' || fact.provenance === 'INFERRED' || fact.provenance === 'UNKNOWN'));
    const forgedRequirementAuthority = testCase.source?.sourceType === 'REQUIREMENT'
      && !linkedFacts.some((fact) => fact?.provenance === 'EXPLICIT');
    const forgedExplicitProvenance = (testCase.source?.provenance === 'EXPLICIT'
      || testCase.businessScenario?.provenance === 'EXPLICIT')
      && !linkedFacts.some((fact) => fact?.provenance === 'EXPLICIT');
    if (testCase.executionMode === 'EXECUTABLE' && (invalidAuthorityFacts.length
      || linkedObjectives.some((objective) => objective.sourceType === 'HEURISTIC')
      || forgedRequirementAuthority || forgedExplicitProvenance)) issues.push({
      code: 'SOURCE_AUTHORITY_INVALID', disposition: 'BLOCKED',
      message: `Case 执行授权与权威 Fact/Objective 不一致：${invalidAuthorityFacts.map((fact) => fact?.id).filter(Boolean).join(', ') || 'source projection mismatch'}`,
    });
    const dimensions = dimensionsFor(testCase, objectiveById);
    const expectedOutcomeKnown = hasKnownExpected(testCase, linkedObjectives);
    const riskJustified = typeof testCase.metadata?.riskJustification === 'string'
      && testCase.metadata.riskJustification.trim().length > 0;
    if (testCase.schemaVersion === 'TEST_CASE_V2' && !riskJustified) issues.push({
      code: 'RISK_JUSTIFICATION_MISSING', disposition: 'BLOCKED',
      message: 'TEST_CASE_V2 缺少 Test Strategy/Risk 推导依据',
    });
    if (testCase.schemaVersion === 'TEST_CASE_V2'
      && testCase.requirementStatus !== 'CONFIRMED'
      && (!isDesignedOnlyCase(testCase) || testCase.oracle?.status === 'READY')) issues.push({
      code: 'UNKNOWN_HANDLING_INVALID', disposition: 'BLOCKED',
      message: 'UNKNOWN/NEED_CONFIRMATION Case 被错误标记为可执行或 Oracle READY',
    });
    const designReason = `${String(testCase.design?.reason ?? '')}；${String(testCase.metadata?.reason ?? '')}`;
    const proofRequirements = testCase.evidenceRequirements ?? [];
    const proofAssertions = testCase.assertions.filter((assertion) => assertion.type !== 'DESIGN_EXPECTATION');
    const hasDeclaredNonMutationProof = proofAssertions.some((assertion) => assertion.expectedFrom !== undefined
      || /unchanged|未修改|未变化|一致/i.test(assertion.description ?? assertion.message ?? ''))
      && proofRequirements.some((evidence) => evidence.required && evidence.phase === 'BEFORE'
        && ['DATABASE_STATE', 'STATE_CHANGE', 'DATA_DIFF', 'RESOURCE_STATE'].includes(evidence.channel))
      && proofRequirements.some((evidence) => evidence.required && evidence.phase === 'AFTER'
        && ['DATABASE_STATE', 'STATE_CHANGE', 'DATA_DIFF', 'RESOURCE_STATE'].includes(evidence.channel))
      && proofAssertions.some((assertion) => ['SIDE_EFFECT', 'AUDIT', 'QUEUE', 'PROVIDER'].includes(assertion.channel ?? ''))
      && proofRequirements.some((evidence) => evidence.required
        && ['EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD', 'LOG'].includes(evidence.channel));
    if (testCase.schemaVersion === 'TEST_CASE_V2'
      && designReason.includes('NON_MUTATION_EVIDENCE_UNAVAILABLE')
      && !hasDeclaredNonMutationProof) issues.push({
      code: 'EVIDENCE_BACKING_MISSING', disposition: 'BLOCKED',
      message: 'Operation Contract 的负向写路径缺少 Non-Mutation/Side Effect Evidence，不能只验证拒绝响应',
    });
    if (!expectedOutcomeKnown) issues.push({
      code: 'EXPECTED_OUTCOME_UNKNOWN', disposition: 'DESIGNED_ONLY',
      message: '来源 Fact/Objectives 没有可判定 Expected Outcome，禁止自动补默认结果',
    });
    if ((dimensions.has('PERMISSION') || dimensions.has('DATA_ISOLATION')) && !testCase.actor) issues.push({
      code: 'ACTOR_CONTEXT_MISSING', disposition: 'BLOCKED',
      message: '权限或隔离 Case 缺少明确 Actor',
    });
    if (dimensions.has('DATA_ISOLATION') && !hasTarget(testCase)) issues.push({
      code: 'TARGET_CONTEXT_MISSING', disposition: 'BLOCKED',
      message: '数据隔离 Case 缺少明确 Target/Resource 归属',
    });
    if (testCase.source?.sourceType === 'HEURISTIC' && !isDesignedOnlyCase(testCase)) issues.push({
      code: 'HEURISTIC_EXECUTION_FORBIDDEN', disposition: 'DESIGNED_ONLY',
      message: 'Heuristic Case 未获得显式/契约执行授权',
    });
    const hasHttpExecutorContract = testCase.protocol === 'HTTP'
      && testCase.steps.some((step) => step.type === 'HTTP_REQUEST');
    if (!isDesignedOnlyCase(testCase) && !hasHttpExecutorContract) issues.push({
      code: 'EXECUTOR_UNAVAILABLE', disposition: 'DESIGNED_ONLY',
      message: '当前没有与该 Case ExecutionStep 匹配的 Executor',
    });
    if (!isDesignedOnlyCase(testCase) && hasHttpExecutorContract) {
      const dsl = checkDslExecutable(testCase);
      if (!dsl.executable) issues.push({
        code: 'EXECUTION_CONTRACT_INCOMPLETE', disposition: 'DESIGNED_ONLY',
        message: dsl.problems.join('；'),
      });
    }

    const status: TestCaseQualityAssessment['status'] = issues.some((issue) => issue.disposition === 'BLOCKED')
      ? 'BLOCKED'
      : issues.length || isDesignedOnlyCase(testCase) ? 'DESIGNED_ONLY' : 'READY';
    applyDisposition(testCase, status, issues);
    const traceable = !issues.some((issue) => issue.code === 'SOURCE_FACT_MISSING' || issue.code === 'SOURCE_OBJECTIVE_MISSING');
    const deterministic = testCase.oracle?.deterministic === true && expectedOutcomeKnown
      && testCase.assertions.some((assertion) => assertion.type !== 'DESIGN_EXPECTATION');
    const evidenceBacked = (testCase.evidenceRequirements ?? []).some((evidence) => evidence.required)
      && testCase.assertions.filter((assertion) => assertion.type !== 'DESIGN_EXPECTATION')
        .every((assertion) => Boolean(assertion.evidenceRequirementIds?.length));
    assessments.push({
      caseId: testCase.id,
      status,
      issues,
      traceable,
      expectedOutcomeKnown,
      executable: status === 'READY',
      dimensions: {
        traceable,
        businessRelevant: testCase.schemaVersion !== 'TEST_CASE_V2'
          || Boolean(businessFlow) && !issues.some((issue) => issue.code === 'BUSINESS_RELATIONSHIP_INVALID'),
        executable: status === 'READY',
        deterministic,
        evidenceBacked,
        nonDuplicate: true,
        riskJustified,
      },
    });
  }

  const businessChecks: TestCaseQualityIssue[] = [];
  const riskKeys = new Map<string, string>();
  for (const testCase of deduplicated.cases) {
    for (const risk of testCase.businessScenario?.risks ?? []) {
      const key = JSON.stringify({ category: risk.category, description: risk.description, factIds: [...(testCase.source?.factIds ?? [])].sort() });
      const existing = riskKeys.get(key);
      if (existing && existing !== testCase.id) businessChecks.push({
        code: 'BUSINESS_RISK_DUPLICATE', disposition: 'DEDUPLICATED',
        message: `业务风险 ${risk.category} 在 ${existing} 与 ${testCase.id} 重复`,
      });
      else riskKeys.set(key, testCase.id);
    }
  }
  for (const risk of businessModel.risks) {
    const covered = deduplicated.cases.some((testCase) => testCase.source?.factIds?.some((id) => risk.factIds.includes(id))
      && testCase.businessScenario?.risks.some((candidate) => candidate.category === risk.category));
    if (!covered) businessChecks.push({
      code: 'BUSINESS_RISK_UNCOVERED', disposition: 'BLOCKED',
      message: `Business Risk ${risk.id}/${risk.category} 缺少可追溯 Case 覆盖`,
    });
  }

  assignStableAcceptanceCaseIds(deduplicated.cases);
  for (let index = 0; index < assessments.length; index++) assessments[index].caseId = deduplicated.cases[index].id;
  return {
    testCases: deduplicated.cases,
    assessments,
    generatedCount,
    deduplicatedCount: deduplicated.count,
    businessChecks,
  };
}
