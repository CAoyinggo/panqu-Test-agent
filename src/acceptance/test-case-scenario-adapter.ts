import type {
  AssertionDefinition,
  TestCase,
  TestEvidenceChannel,
  TestRuntimeCapabilityResolution,
  TestRuntimeReadiness,
  TestStep,
} from '../agents/test-design/testcase-schema.js';
import type {
  BlockedReason,
  EvidenceRequirement,
  Scenario,
  ScenarioAssertion,
  ScenarioAssertionChannel,
  ScenarioAssertionOperator,
  ScenarioEvidenceKind,
  ScenarioOperation,
} from './scenario-contract.js';
import { runScenario, type ScenarioRunOutcome, type ScenarioRunnerOptions } from './scenario-runner.js';
import type { ScenarioProcessor, ScenarioProcessorExecution } from './scenario-runner.js';
import {
  evaluateScenarioExecutability,
  type ScenarioExecutionCapabilities,
} from './scenario-executability-gate.js';

export interface TestCaseScenarioAdapterOptions extends ScenarioRunnerOptions {
  /** 除 Runner 内建检查外，可用的 State/Identity/Resource Preflight 引用。 */
  availablePreflights?: ReadonlySet<string>;
  /** 运行时提供、但未内嵌在 Case 的测试数据引用。 */
  availableTestData?: ReadonlySet<string>;
}

export interface AdaptedTestCaseScenario {
  testCase: TestCase;
  scenario: Scenario;
  generatedReadiness: NonNullable<TestCase['readiness']>['generated'];
  runtimeReadiness: TestRuntimeReadiness;
  effectiveReadiness: TestRuntimeReadiness;
}

export interface TestCaseScenarioExecution {
  adapted: AdaptedTestCaseScenario;
  outcome: ScenarioRunOutcome;
  oracleVerdict: 'PASS' | 'FAIL' | 'NOT_VERIFIED';
  issueClassification: 'PRODUCT_FAILURE' | 'RUNTIME_BLOCKED' | 'NOT_EXECUTED' | 'NONE';
}

function concurrentChildren(operation: ScenarioOperation): ScenarioOperation[] | undefined {
  if (!operation.input || typeof operation.input !== 'object' || Array.isArray(operation.input)) return undefined;
  const children = (operation.input as Record<string, unknown>).$caseOperations;
  return Array.isArray(children) && children.length > 1 ? children as ScenarioOperation[] : undefined;
}

/**
 * 以普通 ScenarioProcessor 承担并发组，不扩展 Scenario/Runner 协议。
 * 每个 child 由已注册 delegate 真正并发执行，Evidence 再收敛到组 Operation。
 */
export function createConcurrentScenarioProcessor(
  delegates: readonly ScenarioProcessor[],
  name = 'devtest.concurrent',
): ScenarioProcessor {
  const delegateFor = (operation: ScenarioOperation): ScenarioProcessor | undefined => delegates.find((delegate) => {
    try { return delegate.name !== name && delegate.supports(operation); } catch { return false; }
  });
  return {
    name,
    supportsAbort: true,
    supportedEvidenceKinds: [...new Set(delegates.flatMap((delegate) => [...delegate.supportedEvidenceKinds]))],
    supports: (operation) => Boolean(concurrentChildren(operation)?.every((child) => delegateFor(child))),
    supportsEvidence: (operation, kind) => concurrentChildren(operation)?.every((child) => {
      const delegate = delegateFor(child);
      return Boolean(delegate && (delegate.supportsEvidence?.(child, kind) ?? delegate.supportedEvidenceKinds.includes(kind)));
    }) === true,
    execute: async (operation, context): Promise<ScenarioProcessorExecution> => {
      const children = concurrentChildren(operation);
      if (!children) return { status: 'BLOCKED', executed: false, evidence: [], error: 'INVALID_CONCURRENCY_GROUP' };
      const results = await Promise.all(children.map(async (child) => {
        const delegate = delegateFor(child);
        if (!delegate) return { child, execution: { status: 'BLOCKED', executed: false, evidence: [], error: 'MISSING_CONCURRENT_DELEGATE' } as ScenarioProcessorExecution };
        return { child, execution: await delegate.execute(child, context) };
      }));
      const status = results.some((item) => item.execution.status === 'FAIL') ? 'FAIL'
        : results.some((item) => item.execution.status !== 'PASS' || item.execution.executed !== true) ? 'BLOCKED' : 'PASS';
      const requirements = context.scenario.evidenceRequirements.filter((requirement) => requirement.operationId === operation.id);
      const evidence = requirements.flatMap((requirement) => {
        const sourceStepId = requirement.sourceRef;
        const source = results.find((item) => item.child.id === sourceStepId)?.execution.evidence
          .find((item) => item.kind === requirement.kind)
          ?? results.flatMap((item) => item.execution.evidence).find((item) => item.kind === requirement.kind);
        if (!source) return [];
        return [{ ...source, id: requirement.id, requirementId: requirement.id, operationId: operation.id }];
      });
      return {
        status,
        executed: results.every((item) => item.execution.executed),
        output: Object.fromEntries(results.map((item) => [item.child.id, item.execution.output])),
        evidence,
        blockedReasons: results.flatMap((item) => item.execution.blockedReasons ?? []),
        error: results.map((item) => item.execution.error).filter(Boolean).join('；') || undefined,
      };
    },
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function reason(code: BlockedReason['code'], message: string, details: Record<string, unknown> = {}): BlockedReason {
  return { code, stage: 'GATE', message, details, recoverable: true };
}

function runtimeReference(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, '${$1}');
  if (Array.isArray(value)) return value.map(runtimeReference);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, runtimeReference(child)]));
  }
  return value;
}

function operationChannel(step: TestStep): ScenarioOperation['channel'] {
  if (step.channel === 'UI') return 'UI';
  if (step.channel === 'DATA' || step.channel === 'FUNCTIONAL') return 'DATA';
  if (step.channel === 'QUEUE') return 'QUEUE';
  if (step.channel === 'PROVIDER') return 'PROVIDER';
  return 'API';
}

function candidateOperation(testCase: TestCase, step: TestStep, index: number): ScenarioOperation {
  return {
    id: step.id ?? `STEP-${String(index + 1).padStart(3, '0')}`,
    channel: operationChannel(step),
    description: step.description ?? step.action ?? (`${step.method ?? ''} ${step.url ?? ''}`.trim() || 'Case operation'),
    apiSpecId: testCase.source?.apiSpecId,
    method: step.method,
    path: runtimeReference(step.url) as string | undefined,
    input: runtimeReference(step.body ?? step.input),
    headers: runtimeReference(step.headers) as Record<string, string> | undefined,
    pathParams: runtimeReference(step.pathParams) as Record<string, unknown> | undefined,
    query: runtimeReference(step.query) as Record<string, unknown> | undefined,
    capture: step.capture,
    acceptanceCriteriaIds: step.acceptanceCriteriaIds ?? testCase.source?.acceptanceCriteriaIds ?? [],
    factIds: step.factIds ?? testCase.source?.factIds ?? [],
    dependsOn: step.dependsOn ?? [],
    actorRef: step.actor?.id ?? testCase.actor?.id,
  };
}

function compileOperations(testCase: TestCase): { operations: ScenarioOperation[]; stepToOperation: Map<string, string>; operationSteps: TestStep[] } {
  const operations: ScenarioOperation[] = [];
  const operationSteps: TestStep[] = [];
  const stepToOperation = new Map<string, string>();
  const grouped = new Set<string>();
  for (let index = 0; index < testCase.steps.length; index++) {
    const step = testCase.steps[index];
    const stepId = step.id ?? `STEP-${String(index + 1).padStart(3, '0')}`;
    if (!step.concurrencyGroup) {
      const operation = candidateOperation(testCase, step, index);
      operations.push(operation);
      operationSteps.push(step);
      stepToOperation.set(stepId, operation.id);
      continue;
    }
    if (grouped.has(step.concurrencyGroup)) continue;
    grouped.add(step.concurrencyGroup);
    const children = testCase.steps.map((candidate, childIndex) => ({ candidate, childIndex }))
      .filter(({ candidate }) => candidate.concurrencyGroup === step.concurrencyGroup)
      .map(({ candidate, childIndex }) => candidateOperation(testCase, candidate, childIndex));
    const childIds = new Set(children.map((child) => child.id));
    const id = `CONCURRENT-${step.concurrencyGroup}`;
    for (const child of children) stepToOperation.set(child.id, id);
    operations.push({
      id,
      // 并发组由 Adapter Processor 承担；使用现有 DATA Operation 避免伪造一个并不存在的单 HTTP Method/Path。
      channel: 'DATA',
      description: `并发执行 ${step.concurrencyGroup}：${children.map((child) => child.description).join('；')}`,
      input: { $caseOperations: children },
      acceptanceCriteriaIds: [...new Set(children.flatMap((child) => child.acceptanceCriteriaIds))],
      factIds: [...new Set(children.flatMap((child) => child.factIds ?? []))],
      dependsOn: [...new Set(children.flatMap((child) => child.dependsOn ?? [])
        .filter((dependency) => !childIds.has(dependency))
        .map((dependency) => stepToOperation.get(dependency) ?? dependency))],
    });
    operationSteps.push(step);
  }
  for (const operation of operations) operation.dependsOn = [...new Set((operation.dependsOn ?? [])
    .map((dependency) => stepToOperation.get(dependency) ?? dependency)
    .filter((dependency) => dependency !== operation.id))];
  return { operations, stepToOperation, operationSteps };
}

function selectProcessor(operation: ScenarioOperation, step: TestStep, options: TestCaseScenarioAdapterOptions): string | undefined {
  const explicit = step.scene ? options.processors.find((processor) => processor.name === step.scene) : undefined;
  if (explicit?.supports(operation)) return explicit.name;
  return options.processors.find((processor) => {
    try { return processor.supportsAbort === true && processor.supports(operation); } catch { return false; }
  })?.name;
}

function operator(assertion: AssertionDefinition): ScenarioAssertionOperator | undefined {
  if (assertion.type === 'STATUS_CODE' || assertion.type === 'RESPONSE_HEADER' || assertion.type === 'JSON_VALUE') return 'EQUALS';
  if (assertion.type === 'JSON_PATH') return 'EXISTS';
  if (assertion.type === 'CONTAINS') return 'CONTAINS';
  if (assertion.type === 'TYPE') return 'TYPE_IS';
  const map: Partial<Record<NonNullable<AssertionDefinition['operator']>, ScenarioAssertionOperator>> = {
    equals: 'EQUALS', notEquals: 'NOT_EQUALS', contains: 'CONTAINS', notContains: 'NOT_CONTAINS',
    exists: 'EXISTS', notExists: 'NOT_EXISTS', gt: 'GREATER_THAN', gte: 'GREATER_THAN_OR_EQUAL',
    lt: 'LESS_THAN', lte: 'LESS_THAN_OR_EQUAL', regex: 'MATCHES', type: 'TYPE_IS', length: 'COUNT_EQUALS',
  };
  return assertion.operator ? map[assertion.operator] : undefined;
}

function assertionTarget(assertion: AssertionDefinition): string {
  if (assertion.type === 'STATUS_CODE') return 'status';
  if (assertion.type === 'RESPONSE_HEADER') return `headers.${assertion.header ?? ''}`;
  if (assertion.path) return assertion.channel === 'RESPONSE' || assertion.channel === 'API'
    ? `body.${assertion.path}` : assertion.path;
  return assertion.target ?? 'body';
}

function defaultAssertionChannel(assertion: AssertionDefinition): ScenarioAssertionChannel {
  if (assertion.channel) return assertion.channel;
  if (assertion.type) return 'RESPONSE';
  return 'SYSTEM';
}

function operationForAssertion(
  assertion: AssertionDefinition,
  testCase: TestCase,
  operationIds: ReadonlySet<string>,
  stepToOperation: ReadonlyMap<string, string>,
): string | undefined {
  const evidenceId = assertion.evidenceRequirementIds?.[0];
  const sourceStep = testCase.evidenceRequirements?.find((item) => item.id === evidenceId)?.sourceStepId;
  if (sourceStep && stepToOperation.has(sourceStep)) return stepToOperation.get(sourceStep);
  const responseOperation = [...testCase.steps].reverse().find((step) => stepToOperation.has(step.id ?? '')
    && (assertion.channel ? operationChannel(step) === assertion.channel || assertion.channel === 'RESPONSE' : step.type === 'HTTP_REQUEST'));
  return responseOperation?.id ? stepToOperation.get(responseOperation.id) : [...operationIds][0];
}

function toScenarioAssertions(testCase: TestCase, operations: readonly ScenarioOperation[], stepToOperation: ReadonlyMap<string, string>): ScenarioAssertion[] {
  const operationIds = new Set(operations.map((operation) => operation.id));
  return testCase.assertions.flatMap((assertion, index) => {
    if (assertion.type === 'DESIGN_EXPECTATION') return [];
    let resolvedOperator = operator(assertion);
    if (!resolvedOperator) return [];
    if (assertion.channel === 'STATE' && assertion.expectedFrom) resolvedOperator = 'UNCHANGED';
    else if (assertion.channel === 'STATE' && resolvedOperator === 'EQUALS'
      && assertion.evidenceRequirementIds?.some((id) => testCase.evidenceRequirements?.some((evidence) => (
        evidence.id === id && evidence.phase === 'AFTER'
      )))) resolvedOperator = 'TRANSITIONED_TO';
    else if (assertion.path === 'count' && resolvedOperator === 'EQUALS') resolvedOperator = 'COUNT_EQUALS';
    const operationId = operationForAssertion(assertion, testCase, operationIds, stepToOperation);
    return [{
      id: assertion.id ?? `AS-${String(index + 1).padStart(3, '0')}`,
      channel: defaultAssertionChannel(assertion),
      target: assertionTarget(assertion),
      operator: resolvedOperator,
      expected: assertion.expected,
      expectedFrom: assertion.expectedFrom,
      acceptanceCriteriaIds: assertion.acceptanceCriteriaIds ?? testCase.source?.acceptanceCriteriaIds ?? [],
      factIds: assertion.factIds ?? testCase.source?.factIds ?? [],
      operationId,
      evidenceRequirementIds: assertion.evidenceRequirementIds ?? [],
      severity: assertion.severity,
      description: assertion.description ?? assertion.message,
    }];
  });
}

function evidenceMapping(channel: TestEvidenceChannel, phase: 'BEFORE' | 'DURING' | 'AFTER'): { kind: ScenarioEvidenceKind; channel: ScenarioAssertionChannel } {
  switch (channel) {
    case 'API_REQUEST': return { kind: 'REQUEST', channel: 'API' };
    case 'API_RESPONSE': return { kind: 'RESPONSE', channel: 'RESPONSE' };
    case 'UI_STATE': return { kind: 'OTHER', channel: 'UI' };
    case 'UI_SCREENSHOT': return { kind: 'SCREENSHOT', channel: 'UI' };
    case 'DATABASE_STATE': return { kind: phase === 'BEFORE' ? 'STATE_BEFORE' : 'DATABASE', channel: 'DATA' };
    case 'RESOURCE_STATE': return { kind: 'RESOURCE', channel: 'STATE' };
    case 'STATE_CHANGE': return { kind: phase === 'BEFORE' ? 'STATE_BEFORE' : 'STATE_AFTER', channel: 'STATE' };
    case 'DATA_DIFF': return { kind: phase === 'BEFORE' ? 'STATE_BEFORE' : 'STATE_AFTER', channel: 'DATA' };
    case 'EVENT': return { kind: 'EVENT', channel: 'SIDE_EFFECT' };
    case 'QUEUE_MESSAGE': return { kind: 'QUEUE_MESSAGE', channel: 'QUEUE' };
    case 'PROVIDER_CALL': return { kind: 'PROVIDER_CALL', channel: 'PROVIDER' };
    case 'BILLING_RECORD': return { kind: 'BILLING_RECORD', channel: 'SIDE_EFFECT' };
    case 'AUDIT_RECORD': return { kind: 'AUDIT_RECORD', channel: 'AUDIT' };
    case 'LOG': return { kind: 'LOG', channel: 'SYSTEM' };
    case 'LIFECYCLE_HOOK': return { kind: 'OTHER', channel: 'SYSTEM' };
  }
}

function toEvidenceRequirements(testCase: TestCase, assertions: readonly ScenarioAssertion[], stepToOperation: ReadonlyMap<string, string>): EvidenceRequirement[] {
  const assertionIds = new Set(assertions.map((assertion) => assertion.id));
  return (testCase.evidenceRequirements ?? []).map((requirement, index) => {
    const mapped = evidenceMapping(requirement.channel, requirement.phase);
    const linked = (requirement.assertionIds ?? []).filter((id) => assertionIds.has(id));
    return {
      id: requirement.id ?? `EV-${String(index + 1).padStart(3, '0')}`,
      kind: mapped.kind,
      channel: mapped.channel,
      description: requirement.description,
      requiredForPass: requirement.required,
      sourceRef: requirement.sourceStepId,
      operationId: requirement.sourceStepId ? stepToOperation.get(requirement.sourceStepId) : undefined,
      assertionIds: linked,
      retention: 'RUN',
    };
  });
}

function patternIds(testCase: TestCase): Scenario['patternIds'] {
  const aspects = new Set(testCase.testAspects ?? []);
  const output = new Set<string>();
  if (testCase.steps.some((step) => step.type === 'HTTP_REQUEST')) output.add('API_CONTRACT');
  else output.add('FUNCTIONAL');
  if (aspects.has('PRE_POST_CONDITION')) output.add('PERSISTENCE');
  if (aspects.has('STATE_TRANSITION')) output.add('STATE_MACHINE');
  if (aspects.has('IDEMPOTENCY') || aspects.has('DUPLICATE_SUBMISSION')) output.add('IDEMPOTENCY');
  if (aspects.has('ROLE_PERMISSION')) output.add('AUTHORIZATION');
  if (aspects.has('TENANT_ISOLATION')) output.add('TENANT_ISOLATION');
  if (aspects.has('PROJECT_ISOLATION')) output.add('PROJECT_ISOLATION');
  if (aspects.has('ROLLBACK_RECOVERY')) output.add('ATOMICITY');
  if (aspects.has('BOUNDARY_VALUE')) output.add('BOUNDARY');
  return [...output];
}

function negativeProofGaps(testCase: TestCase): string[] {
  const expectedStatus = Number(testCase.expected?.response?.status ?? testCase.expected?.status);
  const negative = testCase.testAspects?.includes('NEGATIVE_PATH')
    || testCase.businessScenario?.permission.decision === 'DENY'
    || Number.isInteger(expectedStatus) && expectedStatus >= 400;
  if (!negative) return [];
  const requirements = testCase.evidenceRequirements ?? [];
  const runtimeAssertions = testCase.assertions.filter((assertion) => assertion.type !== 'DESIGN_EXPECTATION');
  const gaps: string[] = [];
  if (!runtimeAssertions.some((assertion) => assertion.type === 'STATUS_CODE' || ['RESPONSE', 'API'].includes(assertion.channel ?? ''))) gaps.push('NEGATIVE_RESPONSE_ORACLE_MISSING');
  const mutating = testCase.steps.some((step) => step.method && MUTATING.has(step.method));
  if (mutating) {
    const unchangedAssertion = runtimeAssertions.some((assertion) => assertion.operator === 'equals'
      && assertion.expectedFrom !== undefined || /unchanged|未修改|未变化|non.?mutation/i.test(assertion.description ?? assertion.message ?? ''));
    const before = requirements.some((item) => item.required && ['STATE_CHANGE', 'DATA_DIFF', 'DATABASE_STATE', 'RESOURCE_STATE'].includes(item.channel) && item.phase === 'BEFORE');
    const after = requirements.some((item) => item.required && ['STATE_CHANGE', 'DATA_DIFF', 'DATABASE_STATE', 'RESOURCE_STATE'].includes(item.channel) && item.phase === 'AFTER');
    if (!unchangedAssertion || !before || !after) gaps.push('NEGATIVE_NON_MUTATION_PROOF_MISSING');
    const declaredEffects = testCase.expected?.sideEffects ?? [];
    const effectAssertions = runtimeAssertions.some((assertion) => ['SIDE_EFFECT', 'AUDIT', 'QUEUE', 'PROVIDER'].includes(assertion.channel ?? ''));
    const effectEvidence = requirements.some((item) => item.required
      && ['EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD', 'LOG'].includes(item.channel));
    if (!declaredEffects.length || declaredEffects.some((effect) => !['FORBIDDEN', 'UNCHANGED'].includes(effect.expectation))
      || !effectAssertions || !effectEvidence) gaps.push('NEGATIVE_SIDE_EFFECT_PROOF_MISSING');
  }
  return gaps;
}

function structuralGaps(testCase: TestCase, scenario: Scenario): string[] {
  const gaps: string[] = [];
  if (testCase.schemaVersion !== 'TEST_CASE_V2') gaps.push('TEST_CASE_V2_REQUIRED');
  if (testCase.requirementStatus !== 'CONFIRMED') gaps.push('REQUIREMENT_NOT_CONFIRMED');
  if (!scenario.operations.length) gaps.push('OPERATION_MISSING');
  if (!scenario.assertions.length) gaps.push('DETERMINISTIC_ASSERTION_MISSING');
  if (!scenario.evidenceRequirements.filter((item) => item.requiredForPass).length) gaps.push('REQUIRED_EVIDENCE_MISSING');
  if (testCase.oracle?.deterministic !== true) gaps.push('DETERMINISTIC_ORACLE_MISSING');
  gaps.push(...negativeProofGaps(testCase));
  return [...new Set(gaps)];
}

function capability(
  capabilities: TestRuntimeCapabilityResolution[],
  kind: TestRuntimeCapabilityResolution['kind'],
  ref: string,
  required: boolean,
  available: boolean,
  reasonText?: string,
): void {
  const existing = capabilities.find((item) => item.kind === kind && item.ref === ref);
  if (existing) {
    existing.required ||= required;
    existing.available &&= available;
    existing.reason ??= reasonText;
  } else capabilities.push({ kind, ref, required, available, reason: reasonText });
}

function resolveCapabilities(testCase: TestCase, scenario: Scenario, options: TestCaseScenarioAdapterOptions): TestRuntimeCapabilityResolution[] {
  const capabilities: TestRuntimeCapabilityResolution[] = [];
  capability(capabilities, 'EXECUTOR', testCase.executionContract?.executor.ref ?? 'acceptance.scenarioRunner', true, true);
  capability(capabilities, 'ENVIRONMENT', 'runtime.environment', true, options.environmentAvailable, '目标环境不可用');
  for (const operation of scenario.operations) {
    const processor = options.processors.find((item) => item.name === operation.processor);
    const available = Boolean(processor && (() => { try { return processor.supports(operation); } catch { return false; } })());
    capability(capabilities, 'PROCESSOR', operation.processor ?? `operation.${operation.id}`, true, available, `${operation.id} 缺少匹配 Processor`);
  }
  for (const requirement of scenario.evidenceRequirements.filter((item) => item.requiredForPass)) {
    const operation = scenario.operations.find((item) => item.id === requirement.operationId);
    const processor = options.processors.find((item) => item.name === operation?.processor);
    const processorEvidence = Boolean(operation && processor
      && (processor.supportsEvidence?.(operation, requirement.kind) ?? processor.supportedEvidenceKinds.includes(requirement.kind)));
    const available = processorEvidence || options.additionalEvidenceKinds?.has(requirement.kind) === true;
    capability(capabilities, 'OBSERVER', `${requirement.kind}:${requirement.id}`, true, available, `${requirement.kind} Observer 不可用`);
  }
  for (const hook of scenario.prepare) capability(capabilities, 'HOOK', hook.handler, hook.required,
    options.prepareHooks?.has(hook.handler) === true, 'Prepare Hook 未注册');
  for (const hook of scenario.cleanup) capability(capabilities, 'HOOK', hook.handler, hook.required,
    options.cleanupHooks?.has(hook.handler) === true, 'Cleanup Hook 未注册');
  for (const data of testCase.testData ?? []) {
    const available = data.value !== undefined || Boolean(data.valueRef && (options.availableTestData?.has(data.valueRef)
      || options.variables && data.valueRef in options.variables));
    capability(capabilities, 'TEST_DATA', data.valueRef ?? data.id, data.mutable === true || data.valueRef !== undefined, available, 'Test Data 未解析');
  }
  for (const dependency of testCase.dependencies ?? []) {
    const available = dependency.resolution === 'STATIC'
      || dependency.kind === 'ENVIRONMENT' && options.environmentAvailable
      || dependency.kind === 'CONTRACT' && Boolean(testCase.contractDependencies?.length || testCase.source?.apiSpecId)
      || dependency.kind === 'IDENTITY' && Boolean(testCase.actor?.id)
      || dependency.kind === 'TEST_DATA' && Boolean(testCase.testData?.length)
      || dependency.kind === 'OBSERVER' && capabilities.some((item) => item.kind === 'OBSERVER' && item.available)
      || dependency.kind === 'LIFECYCLE' && (options.prepareHooks?.has(dependency.ref) === true || options.cleanupHooks?.has(dependency.ref) === true)
      || options.availableDependencies?.has(dependency.ref) === true;
    capability(capabilities, 'DEPENDENCY', dependency.ref, dependency.required, available, 'Case Dependency 未解析');
  }
  for (const preflight of testCase.executionContract?.preflight ?? []) {
    const available = preflight.kind === 'ENVIRONMENT' ? options.environmentAvailable
      : preflight.kind === 'CONTRACT' ? Boolean(testCase.contractDependencies?.length || testCase.source?.apiSpecId)
        : preflight.kind === 'IDENTITY' ? Boolean(testCase.actor?.id && (testCase.actor.tokenRef || testCase.actor.provenance === 'CONFIGURED'))
          : options.availablePreflights?.has(preflight.ref) === true
            || options.availableDependencies?.has(preflight.ref) === true;
    capability(capabilities, 'PREFLIGHT', preflight.ref, preflight.required, available, `${preflight.kind} Preflight 未解析`);
  }
  return capabilities;
}

function runtimeReadiness(capabilities: TestRuntimeCapabilityResolution[], structural: readonly string[]): TestRuntimeReadiness {
  const missing = capabilities.filter((item) => item.required && !item.available);
  const requirementGap = structural.includes('REQUIREMENT_NOT_CONFIRMED');
  const designGaps = structural.filter((gap) => gap !== 'REQUIREMENT_NOT_CONFIRMED');
  const status: TestRuntimeReadiness['status'] = requirementGap || designGaps.length ? 'DESIGNED_ONLY'
    : missing.length ? 'BLOCKED' : 'EXECUTABLE';
  return {
    status,
    reasons: [...structural, ...missing.map((item) => `${item.kind}:${item.ref}:${item.reason ?? 'unavailable'}`)],
    missingCapabilities: missing.map((item) => item.ref),
    capabilities,
    resolvedAt: new Date().toISOString(),
  };
}

function observerProbe(operation: ScenarioOperation): boolean {
  return operation.channel === 'DATA'
    && /(?:采集|观察|验证|observe|verify|snapshot)/i.test(operation.description);
}

/** 与 Scenario Runner 内部门禁使用同一组实际能力，不扩展 Runner 协议。 */
function scenarioGateCapabilities(options: TestCaseScenarioAdapterOptions): ScenarioExecutionCapabilities {
  const processorByName = new Map(options.processors.map((processor) => [processor.name, processor]));
  const evidenceKinds = new Set<ScenarioEvidenceKind>(options.additionalEvidenceKinds ?? []);
  for (const processor of options.processors) {
    for (const kind of processor.supportedEvidenceKinds) evidenceKinds.add(kind);
  }
  return {
    processors: new Set(processorByName.keys()),
    evidenceKinds,
    prepareHooks: new Set(options.prepareHooks?.keys() ?? []),
    cleanupHooks: new Set(options.cleanupHooks?.keys() ?? []),
    availableDependencies: options.availableDependencies,
    executorAvailable: true,
    environmentAvailable: options.environmentAvailable,
    policyAllowed: options.policyAllowed,
    supportsOperation: (name, operation) => {
      const processor = processorByName.get(name);
      if (processor?.supportsAbort !== true) return false;
      try { return processor.supports(operation); } catch { return false; }
    },
    supportsEvidence: (name, operation, kind) => {
      const processor = processorByName.get(name);
      if (!processor) return false;
      return processor.supportsEvidence?.(operation, kind) ?? processor.supportedEvidenceKinds.includes(kind);
    },
    sideEffectFreeProbe: options.sideEffectFreeProbe ?? observerProbe,
  };
}

/** TEST_CASE_V2 → canonical Scenario；不改变 Scenario Runner 协议。 */
export function adaptTestCaseV2ToScenario(testCase: TestCase, options: TestCaseScenarioAdapterOptions): AdaptedTestCaseScenario {
  const compiled = compileOperations(testCase);
  const operations = compiled.operations;
  for (let index = 0; index < operations.length; index++) operations[index].processor = selectProcessor(operations[index], compiled.operationSteps[index], options);
  const assertions = toScenarioAssertions(testCase, operations, compiled.stepToOperation);
  const evidenceRequirements = toEvidenceRequirements(testCase, assertions, compiled.stepToOperation);
  const primaryOwnership = testCase.businessScenario?.ownership;
  const scenario: Scenario = {
    schemaVersion: 'SCENARIO_V1',
    id: `SCN-${testCase.id}`,
    title: testCase.businessScenario?.title ?? testCase.name,
    domain: testCase.feature,
    requirement: testCase.source?.requirementId ?? testCase.name,
    sources: [{
      documentId: testCase.source?.documentId,
      section: testCase.source?.section,
      lineStart: testCase.source?.line,
      lineEnd: testCase.source?.line,
      requirementId: testCase.source?.requirementId,
      factIds: testCase.source?.factIds,
      objectiveIds: testCase.source?.objectiveIds,
      acceptanceCriteriaIds: testCase.source?.acceptanceCriteriaIds,
    }],
    acceptanceCriteriaIds: testCase.source?.acceptanceCriteriaIds ?? [],
    patternIds: patternIds(testCase),
    actor: testCase.actor?.id ? {
      id: testCase.actor.id,
      kind: testCase.actor.role?.toUpperCase() === 'ADMIN' ? 'ADMIN' : 'USER',
      role: testCase.actor.role,
      userId: testCase.actor.userId,
      tenantId: testCase.actor.tenantId,
      projectId: testCase.actor.projectId,
      credentialRef: testCase.actor.tokenRef,
      provenance: testCase.actor.provenance,
    } : undefined,
    role: testCase.actor?.role,
    scope: {
      tenantId: primaryOwnership?.tenantId,
      projectId: primaryOwnership?.projectId,
      resourceId: testCase.businessScenario?.resourceContext.idRef,
      resourceOwnerId: primaryOwnership?.ownerActorId,
      relation: primaryOwnership?.relation === 'SELF' ? 'SELF'
        : primaryOwnership?.relation === 'OTHER_USER' ? 'OTHER'
          : primaryOwnership?.relation === 'CROSS_TENANT' ? 'CROSS'
            : primaryOwnership?.relation === 'SAME_TENANT' ? 'SAME' : 'UNKNOWN',
    },
    authentication: testCase.actor ? {
      type: testCase.actor.tokenRef ? 'TOKEN' : 'NONE',
      required: Boolean(testCase.actor.tokenRef),
      credentialRef: testCase.actor.tokenRef,
    } : undefined,
    preconditions: testCase.preconditionPlan ?? [],
    testData: testCase.testData ?? [],
    operations,
    assertions,
    evidenceRequirements,
    prepare: testCase.prepare ?? [],
    cleanup: testCase.cleanup ?? [],
    executionMode: 'DESIGNED_ONLY',
    blockedReasons: [],
    risks: (testCase.businessScenario?.risks ?? []).map((risk) => ({
      id: risk.id,
      level: risk.level === 'P0' ? 'CRITICAL' : risk.level === 'P1' ? 'HIGH' : 'MEDIUM',
      category: risk.category,
      description: risk.description,
    })),
    priority: testCase.priority,
    dependencies: (testCase.dependencies ?? []).filter((item) => item.required && item.kind === 'CASE').map((item) => item.ref),
    contractDependencies: testCase.contractDependencies,
    tags: testCase.tags,
    metadata: {
      testCaseId: testCase.id,
      businessScenario: testCase.businessScenario,
      // Scenario 协议保留开放 metadata；Adapter 只携带 Binding Gate 需要的
      // 原始负向意图，避免“缺字段/非法值”在真实请求前被误判为 Case 错误。
      negativeContractIntent: testCase.negativeContractIntent,
      parameterContext: testCase.parameterContext,
    },
  };
  const structural = structuralGaps(testCase, scenario);
  const capabilities = resolveCapabilities(testCase, scenario, options);
  let runtime = runtimeReadiness(capabilities, structural);
  const generated = testCase.readiness?.generated ?? {
    status: testCase.readiness?.status ?? 'BLOCKED',
    reasons: [...(testCase.readiness?.reasons ?? ['GENERATED_READINESS_MISSING'])],
    missingCapabilities: [...(testCase.readiness?.missingCapabilities ?? [])],
  };
  if (runtime.status === 'EXECUTABLE') {
    scenario.executionMode = 'EXECUTABLE';
    const gate = evaluateScenarioExecutability(scenario, scenarioGateCapabilities(options));
    if (!gate.allowed) {
      const status: TestRuntimeReadiness['status'] = gate.disposition === 'DESIGNED_ONLY'
        ? 'DESIGNED_ONLY' : 'BLOCKED';
      runtime = {
        ...runtime,
        status,
        reasons: gate.reasons.map((item) => `${item.code}:${item.message}`),
        missingCapabilities: [...new Set(gate.reasons.map((item) => `SCENARIO_GATE:${item.code}`))],
      };
      scenario.executionMode = status === 'DESIGNED_ONLY' ? 'DESIGNED_ONLY' : 'BLOCKED';
      scenario.blockedReasons = [...gate.reasons];
    }
  }
  const effective: TestRuntimeReadiness = { ...runtime, capabilities: [...runtime.capabilities] };
  if (effective.status === 'EXECUTABLE') {
    testCase.executionMode = 'EXECUTABLE';
    testCase.protocol = operations.every((operation) => operation.channel === 'API') ? 'HTTP' : undefined;
    testCase.oracle!.status = 'READY';
    testCase.oracle!.reason = undefined;
    testCase.executionContract!.executor.status = 'AVAILABLE';
    testCase.executionContract!.observers = testCase.executionContract!.observers.map((observer) => ({
      ...observer,
      status: capabilities.some((item) => item.kind === 'OBSERVER' && item.available
        && item.ref.startsWith(evidenceMapping(observer.channel, observer.phase).kind)) ? 'AVAILABLE' : 'UNAVAILABLE',
    }));
    testCase.steps = testCase.steps.map((step) => ({ ...step, execution: 'EXECUTABLE' }));
  } else if (effective.status === 'BLOCKED') {
    scenario.executionMode = 'BLOCKED';
    if (!scenario.blockedReasons.length) {
      scenario.blockedReasons = effective.reasons.map((message) => reason('MISSING_EXECUTOR', message));
    }
  }
  testCase.readiness ??= { status: 'BLOCKED', reasons: [], missingCapabilities: [] };
  testCase.readiness.generated = generated;
  testCase.readiness.runtime = runtime;
  testCase.readiness.effective = effective;
  testCase.readiness.status = effective.status === 'EXECUTABLE' ? 'READY'
    : effective.status === 'DESIGNED_ONLY' ? 'NEED_CONFIRMATION' : 'BLOCKED';
  testCase.readiness.reasons = [...effective.reasons];
  testCase.readiness.missingCapabilities = [...effective.missingCapabilities];
  return { testCase, scenario, generatedReadiness: generated, runtimeReadiness: runtime, effectiveReadiness: effective };
}

/** Adapter + 现有 Scenario Runner 的唯一执行入口。 */
export async function runTestCaseV2WithScenarioRunner(
  testCase: TestCase,
  options: TestCaseScenarioAdapterOptions,
): Promise<TestCaseScenarioExecution> {
  const adapted = adaptTestCaseV2ToScenario(testCase, options);
  const wrapHooks = (
    handlers: ReadonlyMap<string, NonNullable<TestCaseScenarioAdapterOptions['prepareHooks']> extends ReadonlyMap<string, infer H> ? H : never> | undefined,
    phase: 'PREPARE' | 'CLEANUP',
  ): ReadonlyMap<string, NonNullable<TestCaseScenarioAdapterOptions['prepareHooks']> extends ReadonlyMap<string, infer H> ? H : never> | undefined => {
    if (!handlers) return undefined;
    return new Map([...handlers.entries()].map(([name, handler]) => [name, async (context: Parameters<typeof handler>[0]) => {
      const result = await handler(context);
      const requirement = testCase.evidenceRequirements?.find((item) => item.channel === 'LIFECYCLE_HOOK'
        && item.sourceStepId === context.hook.id);
      return {
        ...result,
        evidence: [
          ...(result?.evidence ?? []),
          {
            id: requirement?.id ?? `LIFECYCLE-${context.hook.id}-${phase}`,
            requirementId: requirement?.id,
            scenarioId: context.scenario.id,
            acceptanceCriteriaIds: context.scenario.acceptanceCriteriaIds,
            kind: 'OTHER' as const,
            channel: 'SYSTEM' as const,
            source: `test-case-adapter/${phase.toLowerCase()}`,
            observedAt: new Date().toISOString(),
            data: { hookId: context.hook.id, handler: context.hook.handler, phase, status: 'SUCCEEDED' },
            verified: true,
          },
        ],
      };
    }])) as ReadonlyMap<string, NonNullable<TestCaseScenarioAdapterOptions['prepareHooks']> extends ReadonlyMap<string, infer H> ? H : never>;
  };
  const outcome = await runScenario(adapted.scenario, {
    ...options,
    sideEffectFreeProbe: options.sideEffectFreeProbe ?? observerProbe,
    prepareHooks: wrapHooks(options.prepareHooks, 'PREPARE'),
    cleanupHooks: wrapHooks(options.cleanupHooks, 'CLEANUP'),
  });
  const oracleVerdict = outcome.result.status === 'PASS' ? 'PASS'
    : outcome.result.status === 'FAIL' ? 'FAIL' : 'NOT_VERIFIED';
  return {
    adapted,
    outcome,
    oracleVerdict,
    issueClassification: oracleVerdict === 'FAIL' ? 'PRODUCT_FAILURE'
      : outcome.result.status === 'NOT_EXECUTED' ? 'NOT_EXECUTED'
        : oracleVerdict === 'NOT_VERIFIED' ? 'RUNTIME_BLOCKED' : 'NONE',
  };
}
