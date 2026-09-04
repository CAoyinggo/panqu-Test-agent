import { createHash } from 'node:crypto';
import type { AssertionDefinition, TestCase } from '../agents/test-design/testcase-schema.js';
import { redactSensitive, redactSensitiveText } from '../core/redact.js';
import { ApiProcessor, type ApiProcessorOptions } from './api-processor.js';
import type {
  BlockedReason,
  EvidenceEnvelope,
  Scenario,
  ScenarioAssertion,
  ScenarioEvidenceKind,
  ScenarioHook,
  ScenarioOperation,
  ScenarioOperationResult,
  ScenarioResult,
  ScenarioResultStatus,
} from './scenario-contract.js';
import {
  evaluateScenarioExecutability,
  type ScenarioExecutabilityGateResult,
  type ScenarioExecutionCapabilities,
} from './scenario-executability-gate.js';
import {
  evidenceForAssertion,
  findEvidenceForRequirement,
} from './scenario-evidence.js';
import { validateDependencies } from '../contracts/dependency-index.js';
import type { ContractResolverLike } from '../contracts/resolver.js';

export interface ScenarioProcessorContext {
  runId: string;
  scenario: Scenario;
  variables: Record<string, unknown>;
  signal: AbortSignal;
}

export interface ScenarioProcessorExecution {
  status: ScenarioResultStatus;
  executed: boolean;
  output?: unknown;
  evidence: EvidenceEnvelope[];
  blockedReasons?: BlockedReason[];
  error?: string;
}

/** Processor 必须明确声明 Operation 支持范围和 Abort 能力。 */
export interface ScenarioProcessor {
  name: string;
  supportsAbort: true;
  supportedEvidenceKinds: readonly ScenarioEvidenceKind[];
  supports(operation: ScenarioOperation): boolean;
  supportsEvidence?(operation: ScenarioOperation, kind: ScenarioEvidenceKind): boolean;
  execute(operation: ScenarioOperation, context: ScenarioProcessorContext): Promise<ScenarioProcessorExecution>;
}

export interface ScenarioHookResult {
  variables?: Record<string, unknown>;
  evidence?: EvidenceEnvelope[];
}

export interface ScenarioHookContext extends ScenarioProcessorContext {
  hook: ScenarioHook;
  operationResults: ScenarioOperationResult[];
}

export type ScenarioHookHandler = (context: ScenarioHookContext) => Promise<ScenarioHookResult | void>;

export interface ScenarioRunnerOptions {
  runId?: string;
  processors: readonly ScenarioProcessor[];
  prepareHooks?: ReadonlyMap<string, ScenarioHookHandler>;
  cleanupHooks?: ReadonlyMap<string, ScenarioHookHandler>;
  variables?: Record<string, unknown>;
  signal?: AbortSignal;
  environmentAvailable: boolean;
  policyAllowed: boolean;
  availableDependencies?: ReadonlySet<string>;
  /** 非 Processor 证据通道（例如 DB Probe/Billing Ledger Provider）。 */
  additionalEvidenceKinds?: ReadonlySet<ScenarioEvidenceKind>;
  /** Phase 1 Contract 前置层；存在时必须在任何 Hook/Processor 之前通过。 */
  contractResolver?: ContractResolverLike;
  requireContractDependencies?: boolean;
  /** 仅可信上层可声明；普通 Scenario 调用默认仍要求 Cleanup。 */
  sideEffectFreeProbe?: (operation: ScenarioOperation) => boolean;
}

export interface ScenarioRunOutcome {
  gate: ScenarioExecutabilityGateResult;
  result: ScenarioResult;
  variables: Record<string, unknown>;
}

function blocked(code: BlockedReason['code'], stage: BlockedReason['stage'], message: string, details: Record<string, unknown> = {}): BlockedReason {
  return { code, stage, message, details, recoverable: true };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
}

interface NormalizedEvidence {
  /** 仅限本次 run 的断言求值使用，禁止进入 Result / Report / Artifact。 */
  observation: EvidenceEnvelope;
  /** 可持久化、可返回调用方的脱敏证据。 */
  artifact: EvidenceEnvelope;
}

function normalizeEvidence(evidence: EvidenceEnvelope, scenario: Scenario, operationId?: string): NormalizedEvidence {
  const observationDigest = digest(evidence.data);
  const identityValid = evidence.scenarioId === scenario.id
    && (!evidence.operationId || !operationId || evidence.operationId === operationId);
  const verified = evidence.verified === true
    && identityValid
    && (!evidence.digest || evidence.digest === observationDigest);
  const observation: EvidenceEnvelope = {
    ...evidence,
    scenarioId: scenario.id,
    operationId: evidence.operationId ?? operationId,
    acceptanceCriteriaIds: [...evidence.acceptanceCriteriaIds],
    verified,
    digest: observationDigest,
  };
  const artifactData = redactSensitive(evidence.data);
  const artifactDigest = digest(artifactData);
  return {
    observation,
    artifact: {
      ...observation,
      data: artifactData,
      redacted: artifactDigest !== observationDigest ? true : evidence.redacted,
      digest: artifactDigest,
    },
  };
}

function redactVariables(variables: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSensitive(variables);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as Record<string, unknown> : {};
}

function valueAtPath(root: unknown, path: string | undefined): unknown {
  if (!path) return root;
  const normalized = path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1');
  let value = root;
  for (const part of normalized.split('.').filter(Boolean)) {
    if (value === null || value === undefined || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function interpolateString(value: string, variables: Record<string, unknown>): unknown {
  const exact = value.match(/^\$\{([^}]+)\}$/);
  if (exact) {
    const resolved = valueAtPath(variables, exact[1]);
    if (resolved === undefined) throw new Error(`UNRESOLVED_SCENARIO_REFERENCE：${exact[1]}`);
    return resolved;
  }
  return value.replace(/\$\{([^}]+)\}/g, (_match, reference: string) => {
    const resolved = valueAtPath(variables, reference);
    if (resolved === undefined) throw new Error(`UNRESOLVED_SCENARIO_REFERENCE：${reference}`);
    return String(resolved);
  });
}

function interpolate(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === 'string') return interpolateString(value, variables);
  if (Array.isArray(value)) return value.map((item) => interpolate(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, interpolate(child, variables)]));
  }
  return value;
}

function resolveOperation(operation: ScenarioOperation, variables: Record<string, unknown>): ScenarioOperation {
  return {
    ...operation,
    path: operation.path ? String(interpolateString(operation.path, variables)) : undefined,
    input: interpolate(operation.input, variables),
    headers: operation.headers ? interpolate(operation.headers, variables) as Record<string, string> : undefined,
    pathParams: operation.pathParams ? interpolate(operation.pathParams, variables) as Record<string, unknown> : undefined,
    query: operation.query ? interpolate(operation.query, variables) as Record<string, unknown> : undefined,
  };
}

interface AssertionObservation {
  observed: boolean;
  value: unknown;
}

function assertionActual(
  scenario: Scenario,
  assertion: ScenarioAssertion,
  evidence: readonly EvidenceEnvelope[],
): AssertionObservation {
  const boundEvidence = evidenceForAssertion(scenario, assertion, evidence);
  if (!boundEvidence.length) return { observed: false, value: undefined };
  for (const item of [...boundEvidence].reverse()) {
    const actual = valueAtPath(item.data, assertion.target);
    if (actual !== undefined) return { observed: true, value: actual };
  }
  // NOT_EXISTS 需要证明观察源确实存在；“没有任何证据”与“字段不存在”不可混淆。
  return { observed: boundEvidence.some((item) => item.data !== undefined), value: undefined };
}

function equals(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function evaluateAssertion(assertion: ScenarioAssertion, actual: unknown, expected: unknown): boolean {
  switch (assertion.operator) {
    case 'EQUALS': case 'UNCHANGED': case 'TRANSITIONED_TO': return equals(actual, expected);
    case 'NOT_EQUALS': return !equals(actual, expected);
    case 'EXISTS': return actual !== undefined && actual !== null;
    case 'NOT_EXISTS': return actual === undefined || actual === null;
    case 'CONTAINS': return typeof actual === 'string'
      ? actual.includes(String(expected)) : Array.isArray(actual) && actual.some((item) => equals(item, expected));
    case 'NOT_CONTAINS': return typeof actual === 'string'
      ? !actual.includes(String(expected)) : Array.isArray(actual) && actual.every((item) => !equals(item, expected));
    case 'GREATER_THAN': return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'GREATER_THAN_OR_EQUAL': return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'LESS_THAN': return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'LESS_THAN_OR_EQUAL': return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'MATCHES': return typeof actual === 'string' && new RegExp(String(expected)).test(actual);
    case 'TYPE_IS': {
      const type = actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual;
      return type === expected;
    }
    case 'COUNT_EQUALS': return (Array.isArray(actual) || typeof actual === 'string')
      ? actual.length === expected : typeof actual === 'number' && actual === expected;
    case 'CUSTOM': return false;
  }
}

function expectedValue(
  assertion: ScenarioAssertion,
  variables: Record<string, unknown>,
  evidence: readonly EvidenceEnvelope[],
): { resolved: boolean; value: unknown } {
  if (assertion.expectedFrom === undefined) {
    if (assertion.expected === undefined && !['EXISTS', 'NOT_EXISTS'].includes(assertion.operator)) {
      return { resolved: false, value: undefined };
    }
    try {
      return { resolved: true, value: interpolate(assertion.expected, variables) };
    } catch {
      return { resolved: false, value: undefined };
    }
  }
  if (typeof assertion.expectedFrom === 'string') {
    const reference = assertion.expectedFrom.replace(/^\$\{/, '').replace(/\}$/, '');
    const resolved = valueAtPath(variables, reference);
    // `input.X` 是 Markdown Oracle 的稳定命名空间；Prepare Hook 可选择返回
    // `{ input: { X } }`，也可为兼容旧 Hook 返回扁平 `{ X }`。
    const value = resolved === undefined && reference.startsWith('input.')
      ? valueAtPath(variables, reference.slice('input.'.length))
      : resolved;
    return { resolved: value !== undefined, value };
  }
  const reference = assertion.expectedFrom;
  let value: unknown;
  if (reference.operationId) value = valueAtPath(variables, `${reference.operationId}${reference.path ? `.${reference.path}` : ''}`);
  else if (reference.testDataId) value = valueAtPath(variables, `testData.${reference.testDataId}${reference.path ? `.${reference.path}` : ''}`);
  else if (reference.evidenceId) {
    const item = evidence.find((candidate) => candidate.id === reference.evidenceId && candidate.verified === true);
    value = valueAtPath(item?.data, reference.path);
  }
  return { resolved: value !== undefined, value };
}

function assertionEvidence(
  scenario: Scenario,
  assertion: ScenarioAssertion,
  actual: unknown,
  expected: unknown,
  pass: boolean,
): EvidenceEnvelope {
  const data = redactSensitive({ operator: assertion.operator, target: assertion.target, expected, actual, pass });
  return {
    id: `ASSERTION-${assertion.id}`,
    scenarioId: scenario.id,
    operationId: assertion.operationId,
    assertionId: assertion.id,
    acceptanceCriteriaIds: assertion.acceptanceCriteriaIds,
    kind: 'OTHER',
    channel: assertion.channel,
    source: 'scenario-runner/assertion-engine',
    observedAt: new Date().toISOString(),
    data,
    verified: true,
    digest: digest(data),
  };
}

function createCapabilities(options: ScenarioRunnerOptions): ScenarioExecutionCapabilities {
  const processorByName = new Map(options.processors.map((processor) => [processor.name, processor]));
  const evidenceKinds = new Set<ScenarioEvidenceKind>(options.additionalEvidenceKinds ?? []);
  for (const processor of options.processors) processor.supportedEvidenceKinds.forEach((kind) => evidenceKinds.add(kind));
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
    sideEffectFreeProbe: options.sideEffectFreeProbe,
  };
}

function terminalResult(
  scenario: Scenario,
  runId: string,
  status: ScenarioResultStatus,
  reasons: BlockedReason[],
  startedAt: string,
  operationResults: ScenarioOperationResult[] = [],
  evidence: EvidenceEnvelope[] = [],
): ScenarioResult {
  const finishedAt = new Date().toISOString();
  return {
    scenarioId: scenario.id,
    runId,
    status,
    executionMode: scenario.executionMode,
    executed: operationResults.some((result) => result.executed),
    processorInvoked: operationResults.some((result) => result.processorInvoked),
    processors: [...new Set(operationResults.flatMap((result) => result.processor ? [result.processor] : []))],
    assertions: scenario.assertions.length,
    passedAssertions: 0,
    failedAssertions: 0,
    evidence,
    blockedReasons: reasons,
    operationResults,
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    summary: `${status}：${reasons.map((item) => item.code).join(', ') || 'no assertion result'}`,
  };
}

function linkedAbort(parent: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs ? setTimeout(() => {
    timeout = true;
    controller.abort(new Error(`SCENARIO_OPERATION_TIMEOUT：${timeoutMs}ms`));
  }, Math.max(1, timeoutMs)) : undefined;
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

async function invokeProcessor(
  processor: ScenarioProcessor,
  operation: ScenarioOperation,
  context: Omit<ScenarioProcessorContext, 'signal'>,
  parentSignal?: AbortSignal,
): Promise<ScenarioProcessorExecution & { timedOut: boolean }> {
  const linked = linkedAbort(parentSignal, operation.timeoutMs);
  const abortPromise = new Promise<ScenarioProcessorExecution>((resolve) => {
    linked.signal.addEventListener('abort', () => resolve({
      status: linked.timedOut() ? 'TIMEOUT' : 'CANCELLED',
      executed: false,
      evidence: [],
      error: String(linked.signal.reason ?? 'aborted'),
    }), { once: true });
  });
  try {
    const execution = await Promise.race([
      processor.execute(operation, { ...context, signal: linked.signal }),
      abortPromise,
    ]);
    return { ...execution, timedOut: linked.timedOut() };
  } catch (error) {
    return {
      status: linked.timedOut() ? 'TIMEOUT' : parentSignal?.aborted ? 'CANCELLED' : 'BLOCKED',
      executed: false,
      evidence: [],
      error: redactSensitiveText((error as Error).message),
      timedOut: linked.timedOut(),
    };
  } finally {
    linked.cleanup();
  }
}

function orderOperations(operations: readonly ScenarioOperation[]): ScenarioOperation[] {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const pending = new Map(operations.map((operation) => [operation.id, new Set(operation.dependsOn ?? [])]));
  const ordered: ScenarioOperation[] = [];
  while (pending.size) {
    // 每轮只选择原始资产顺序中第一个 ready Operation。若一次批量取出全部
    // ready 节点，排在依赖链末尾的独立 Observer 会被提前执行，得到陈旧状态。
    const operation = operations.find((item) => pending.has(item.id) && pending.get(item.id)!.size === 0);
    if (!operation) return [...operations]; // Gate 会把循环依赖阻断；这里只保留确定性兜底。
    ordered.push(operation);
    pending.delete(operation.id);
    for (const dependencies of pending.values()) dependencies.delete(operation.id);
  }
  return ordered.filter((operation) => byId.has(operation.id));
}

function unresolvedStaticOracle(
  assertion: ScenarioAssertion,
  scenario: Scenario,
  variables: Record<string, unknown>,
): string | undefined {
  const reference = assertion.expectedFrom;
  if (reference === undefined) return undefined;
  if (typeof reference === 'object') {
    if (reference.operationId || reference.evidenceId) return undefined;
    if (reference.testDataId) {
      const value = valueAtPath(variables, `testData.${reference.testDataId}${reference.path ? `.${reference.path}` : ''}`);
      return value === undefined ? `testData.${reference.testDataId}${reference.path ? `.${reference.path}` : ''}` : undefined;
    }
    return 'empty expectedFrom';
  }
  const path = reference.replace(/^\$\{/, '').replace(/\}$/, '');
  if (scenario.operations.some((operation) => path === operation.id || path.startsWith(`${operation.id}.`))) return undefined;
  const value = valueAtPath(variables, path);
  const compatibleInput = value === undefined && path.startsWith('input.')
    ? valueAtPath(variables, path.slice('input.'.length)) : value;
  return compatibleInput === undefined ? path : undefined;
}

/**
 * Gate → Prepare → ordered Operations → Assertions/Evidence → Cleanup。
 * Gate 未通过时，任何 Hook 或 Processor 都不会被调用。
 */
export async function runScenario(scenario: Scenario, options: ScenarioRunnerOptions): Promise<ScenarioRunOutcome> {
  const runId = options.runId ?? `SCENARIO-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const variables: Record<string, unknown> = { ...(options.variables ?? {}) };
  const configuredTestData = variables.testData && typeof variables.testData === 'object'
    ? variables.testData as Record<string, unknown> : {};
  variables.testData = {
    ...Object.fromEntries(scenario.testData.filter((item) => item.value !== undefined).map((item) => [item.id, item.value])),
    ...configuredTestData,
  };
  if (options.contractResolver || options.requireContractDependencies) {
    if (!options.contractResolver) {
      const reason = blocked('MISSING_CONTRACT', 'GATE', 'Contract Resolver 未配置，禁止执行 Scenario');
      return {
        gate: { allowed: false, disposition: 'BLOCKED', declaredMode: scenario.executionMode, reasons: [reason], checkedAt: new Date().toISOString(), obligations: [] },
        variables: redactVariables(variables),
        result: terminalResult(scenario, runId, 'BLOCKED', [reason], startedAt),
      };
    }
    const contractValidation = validateDependencies(scenario.contractDependencies ?? [], options.contractResolver);
    if (contractValidation.status !== 'VALID') {
      const status: ScenarioResultStatus = contractValidation.status === 'STALE' ? 'STALE'
        : contractValidation.status === 'CONTRACT_DRIFT' ? 'CONTRACT_DRIFT' : 'BLOCKED';
      const code: BlockedReason['code'] = contractValidation.status === 'STALE' ? 'CONTRACT_STALE'
        : contractValidation.status === 'CONTRACT_DRIFT' ? 'CONTRACT_DRIFT'
          : contractValidation.dependencies.some((item) => item.resolution.status === 'CONFLICT')
            ? 'CONTRACT_CONFLICT' : 'MISSING_CONTRACT';
      const reason = blocked(code, 'GATE', `Contract Gate=${contractValidation.status}：${contractValidation.reasons.join('；')}`, {
        contractDependencies: scenario.contractDependencies ?? [],
      });
      return {
        gate: { allowed: false, disposition: 'BLOCKED', declaredMode: scenario.executionMode, reasons: [reason], checkedAt: new Date().toISOString(), obligations: [] },
        variables: redactVariables(variables),
        result: terminalResult(scenario, runId, status, [reason], startedAt),
      };
    }
  }
  const processors = new Map(options.processors.map((processor) => [processor.name, processor]));
  const gate = evaluateScenarioExecutability(scenario, createCapabilities(options));
  if (!gate.allowed) {
    const status: ScenarioResultStatus = gate.disposition === 'DESIGNED_ONLY' || gate.disposition === 'NOT_EXECUTED'
      ? 'NOT_EXECUTED' : 'BLOCKED';
    return { gate, variables: redactVariables(variables), result: terminalResult(scenario, runId, status, gate.reasons, startedAt) };
  }

  const operationResults: ScenarioOperationResult[] = [];
  const outputs = new Map<string, unknown>();
  const evidence: EvidenceEnvelope[] = [];
  // 原始证据只存在于本函数作用域，用于确定性断言；任何返回值和持久化路径
  // 都只接收上面的脱敏 evidence，避免为可比较性牺牲 PII/Secret 安全。
  const observationEvidence: EvidenceEnvelope[] = [];
  const runtimeReasons: BlockedReason[] = [];
  let prepareEntered = false;
  let status: ScenarioResultStatus = 'BLOCKED';
  let passedAssertions = 0;
  let failedAssertions = 0;

  const hookContext = (hook: ScenarioHook): ScenarioHookContext => ({
    runId, scenario, variables, hook, operationResults,
    signal: options.signal ?? new AbortController().signal,
  });
  try {
    prepareEntered = true;
    for (const hook of scenario.prepare) {
      const handler = options.prepareHooks?.get(hook.handler);
      if (!handler) throw new Error(`MISSING_PREPARE：${hook.handler}`);
      const hookResult = await handler(hookContext(hook));
      if (hookResult?.variables) Object.assign(variables, hookResult.variables);
      for (const item of hookResult?.evidence ?? []) {
        const normalized = normalizeEvidence(item, scenario);
        observationEvidence.push(normalized.observation);
        evidence.push(normalized.artifact);
      }
    }

    const unresolvedOracles = scenario.assertions.flatMap((assertion) => {
      const reference = unresolvedStaticOracle(assertion, scenario, variables);
      return reference ? [{ assertion, reference }] : [];
    });
    if (unresolvedOracles.length) {
      status = 'BLOCKED';
      runtimeReasons.push(...unresolvedOracles.map(({ assertion, reference }) => blocked(
        'AMBIGUOUS_ORACLE', 'ASSERTION', `${assertion.id} 的 expectedFrom 无法解析：${reference}`,
        { assertionId: assertion.id, expectedFrom: reference },
      )));
    }

    for (const operation of status === 'BLOCKED' && unresolvedOracles.length ? [] : orderOperations(scenario.operations)) {
      if (options.signal?.aborted) {
        status = 'CANCELLED';
        runtimeReasons.push(blocked('EXECUTION_ABORTED', 'EXECUTION', 'Scenario AbortSignal 已取消后续 Operation'));
        break;
      }
      let resolved: ScenarioOperation;
      try {
        resolved = resolveOperation(operation, variables);
      } catch (error) {
        status = 'BLOCKED';
        runtimeReasons.push(blocked('MISSING_TEST_DATA', 'EXECUTION', (error as Error).message, { operationId: operation.id }));
        break;
      }
      const processor = processors.get(resolved.processor!);
      if (!processor) {
        status = 'BLOCKED';
        runtimeReasons.push(blocked('MISSING_PROCESSOR', 'EXECUTION', `${resolved.id} 的 Processor 不存在`, { operationId: resolved.id }));
        break;
      }
      const operationStarted = new Date().toISOString();
      const execution = await invokeProcessor(processor, resolved, { runId, scenario, variables }, options.signal);
      const normalizedEvidence = execution.evidence.map((item) => normalizeEvidence(item, scenario, resolved.id));
      const operationEvidence = normalizedEvidence.map((item) => item.artifact);
      observationEvidence.push(...normalizedEvidence.map((item) => item.observation));
      evidence.push(...operationEvidence);
      const operationFinished = new Date().toISOString();
      const operationStatus = execution.executed === true && execution.status === 'PASS' ? 'PASS'
        : execution.status === 'FAIL' ? 'FAIL'
          : execution.status === 'TIMEOUT' ? 'TIMEOUT'
            : execution.status === 'CANCELLED' ? 'CANCELLED' : 'BLOCKED';
      const operationReason = execution.blockedReasons ?? (operationStatus === 'BLOCKED'
        ? [blocked('INVALID_SCENARIO', 'EXECUTION', execution.error ?? `${resolved.id} 未完成`, { operationId: resolved.id })] : []);
      operationResults.push({
        operationId: resolved.id,
        status: operationStatus,
        executed: execution.executed === true,
        processor: processor.name,
        processorInvoked: true,
        startedAt: operationStarted,
        finishedAt: operationFinished,
        durationMs: new Date(operationFinished).getTime() - new Date(operationStarted).getTime(),
        evidence: operationEvidence,
        blockedReasons: operationReason,
        error: execution.error,
      });
      if (execution.output !== undefined) {
        outputs.set(resolved.id, execution.output);
        const captures = resolved.capture && !Array.isArray(resolved.capture) ? resolved.capture : {};
        const captured = Object.fromEntries(Object.entries(captures).map(([name, path]) => [name, valueAtPath(execution.output, path)]));
        variables[resolved.id] = { output: execution.output, ...captured };
      }
      if (operationStatus !== 'PASS') {
        status = operationStatus;
        runtimeReasons.push(...operationReason);
        break;
      }
    }

    if (operationResults.length < scenario.operations.length) {
      const completed = new Set(operationResults.map((item) => item.operationId));
      for (const operation of scenario.operations.filter((item) => !completed.has(item.id))) {
        operationResults.push({
          operationId: operation.id,
          status: 'NOT_EXECUTED',
          executed: false,
          processor: operation.processor,
          processorInvoked: false,
          evidence: [],
          blockedReasons: [blocked('EXECUTION_ABORTED', 'EXECUTION', '前序 Operation 未成功，未调度本 Operation', { operationId: operation.id })],
        });
      }
    } else if (operationResults.every((item) => item.status === 'PASS')) {
      const missingEvidence = scenario.evidenceRequirements.filter((requirement) => requirement.requiredForPass
        && !findEvidenceForRequirement(scenario, requirement, evidence));
      if (missingEvidence.length) {
        status = 'BLOCKED';
        runtimeReasons.push(...missingEvidence.map((item) => blocked('MISSING_EVIDENCE', 'EVIDENCE',
          `未采集到 ${item.id} (${item.kind})`, { evidenceRequirementId: item.id })));
      } else {
        let observationMissing = false;
        for (const assertion of scenario.assertions) {
          const observation = assertionActual(scenario, assertion, observationEvidence);
          const expected = expectedValue(assertion, variables, observationEvidence);
          if (!observation.observed) {
            observationMissing = true;
            runtimeReasons.push(blocked('MISSING_EVIDENCE', 'ASSERTION', `${assertion.id} 无法取得 ${assertion.target} 的实际值`, { assertionId: assertion.id }));
            continue;
          }
          if (!expected.resolved) {
            observationMissing = true;
            runtimeReasons.push(blocked('AMBIGUOUS_ORACLE', 'ASSERTION', `${assertion.id} 的 Expected/Expected From 无法解析`, { assertionId: assertion.id }));
            continue;
          }
          const pass = evaluateAssertion(assertion, observation.value, expected.value);
          if (pass) passedAssertions++;
          else failedAssertions++;
          evidence.push(assertionEvidence(scenario, assertion, observation.value, expected.value, pass));
        }
        status = observationMissing ? 'BLOCKED' : failedAssertions > 0 ? 'FAIL' : 'PASS';
      }
    }

    // Processor 可以提前报告 FAIL，但 Scenario 的 FAIL 仍必须由已执行 Operation 上的
    // 确定性业务断言支撑。仅凭 Processor status 字符串不能制造产品失败。
    if (status === 'FAIL' && failedAssertions === 0) {
      const completedOperationIds = new Set(operationResults
        .filter((item) => item.executed && item.processorInvoked)
        .map((item) => item.operationId));
      const completedAssertions = scenario.assertions.filter((assertion) => (
        assertion.operationId && completedOperationIds.has(assertion.operationId)
      ));
      for (const assertion of completedAssertions) {
        const observation = assertionActual(scenario, assertion, observationEvidence);
        const expected = expectedValue(assertion, variables, observationEvidence);
        if (!observation.observed) {
          runtimeReasons.push(blocked('MISSING_EVIDENCE', 'ASSERTION',
            `${assertion.id} 无法取得 ${assertion.target} 的实际值`, { assertionId: assertion.id }));
          continue;
        }
        if (!expected.resolved) {
          runtimeReasons.push(blocked('AMBIGUOUS_ORACLE', 'ASSERTION',
            `${assertion.id} 的 Expected/Expected From 无法解析`, { assertionId: assertion.id }));
          continue;
        }
        const pass = evaluateAssertion(assertion, observation.value, expected.value);
        if (pass) passedAssertions++;
        else failedAssertions++;
        evidence.push(assertionEvidence(scenario, assertion, observation.value, expected.value, pass));
      }
      if (failedAssertions === 0) {
        status = 'BLOCKED';
        runtimeReasons.push(blocked('INVALID_SCENARIO', 'ASSERTION',
          'Processor 报告 FAIL，但没有任何已验证失败的 Scenario 业务断言'));
      }
    }
  } catch (error) {
    status = options.signal?.aborted ? 'CANCELLED' : 'BLOCKED';
    runtimeReasons.push(blocked(options.signal?.aborted ? 'EXECUTION_ABORTED' : 'INVALID_SCENARIO',
      operationResults.length ? 'EXECUTION' : 'PREPARE', redactSensitiveText((error as Error).message)));
  } finally {
    if (prepareEntered) {
      for (const hook of [...scenario.cleanup].reverse()) {
        try {
          const handler = options.cleanupHooks?.get(hook.handler);
          if (!handler) throw new Error(`MISSING_CLEANUP：${hook.handler}`);
          const hookResult = await handler(hookContext(hook));
          if (hookResult?.variables) Object.assign(variables, hookResult.variables);
          for (const item of hookResult?.evidence ?? []) {
            const normalized = normalizeEvidence(item, scenario);
            observationEvidence.push(normalized.observation);
            evidence.push(normalized.artifact);
          }
        } catch (error) {
          runtimeReasons.push(blocked('MISSING_CLEANUP', 'CLEANUP', redactSensitiveText((error as Error).message), { hook: hook.handler }));
          if (status !== 'TIMEOUT' && status !== 'CANCELLED') status = 'BLOCKED';
        }
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const allOperationsExecuted = operationResults.length === scenario.operations.length
    && operationResults.every((item) => item.executed && item.processorInvoked && item.status === 'PASS');
  const requiredEvidenceComplete = scenario.evidenceRequirements.filter((item) => item.requiredForPass)
    .every((requirement) => Boolean(findEvidenceForRequirement(scenario, requirement, evidence)));
  if (status === 'PASS' && (!allOperationsExecuted || !scenario.assertions.length
    || passedAssertions !== scenario.assertions.length || !requiredEvidenceComplete)) {
    status = 'BLOCKED';
    runtimeReasons.push(blocked('MISSING_EVIDENCE', 'REPORT', 'PASS 完整性门禁未满足 Executed + Processor + Assertions + Evidence'));
  }
  const result: ScenarioResult = {
    scenarioId: scenario.id,
    runId,
    status,
    executionMode: scenario.executionMode,
    executed: operationResults.some((item) => item.executed),
    processorInvoked: operationResults.some((item) => item.processorInvoked),
    processors: [...new Set(operationResults.flatMap((item) => item.processor ? [item.processor] : []))],
    assertions: scenario.assertions.length,
    passedAssertions,
    failedAssertions,
    evidence,
    blockedReasons: runtimeReasons,
    operationResults,
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    summary: `${status}：Operations ${operationResults.filter((item) => item.executed).length}/${scenario.operations.length}；Assertions ${passedAssertions}/${scenario.assertions.length}；Evidence ${evidence.length}`,
  };
  return { gate, result, variables: redactVariables(variables) };
}

function adapterAssertion(assertion: ScenarioAssertion): AssertionDefinition | undefined {
  if (!['RESPONSE', 'API'].includes(assertion.channel) || assertion.expectedFrom !== undefined) return undefined;
  if (assertion.target === 'status' && assertion.operator === 'EQUALS') return { type: 'STATUS_CODE', expected: assertion.expected };
  if (assertion.target.startsWith('headers.') && assertion.operator === 'EQUALS') {
    return { type: 'RESPONSE_HEADER', header: assertion.target.slice('headers.'.length), expected: assertion.expected };
  }
  const path = assertion.target.replace(/^body\.?/, '');
  if (assertion.operator === 'EQUALS') return { type: 'JSON_VALUE', path, expected: assertion.expected };
  if (assertion.operator === 'EXISTS') return { type: 'JSON_PATH', path };
  if (assertion.operator === 'CONTAINS') return { type: 'CONTAINS', path, expected: assertion.expected };
  if (assertion.operator === 'TYPE_IS') return { type: 'TYPE', path, expected: assertion.expected };
  return undefined;
}

/** 将现有单 HTTP ApiProcessor 复用为 Scenario 原子 Operation Processor。 */
export function createAcceptanceHttpScenarioProcessor(
  options: Omit<ApiProcessorOptions, 'signal' | 'timeoutMs'> & { apiProcessor?: ApiProcessor },
): ScenarioProcessor {
  const apiProcessor = options.apiProcessor ?? new ApiProcessor();
  return {
    name: 'api',
    supportsAbort: true,
    // A distinct read Operation can act as an API state observer. A mutation response
    // can never satisfy state/resource evidence.
    supportedEvidenceKinds: ['REQUEST', 'RESPONSE', 'RESOURCE', 'STATE_BEFORE', 'STATE_AFTER'],
    supports: (operation) => operation.channel === 'API' && Boolean(operation.method && operation.path),
    supportsEvidence: (operation, kind) => ['REQUEST', 'RESPONSE'].includes(kind)
      || ['GET', 'HEAD', 'OPTIONS'].includes(operation.method ?? '')
        && ['RESOURCE', 'STATE_BEFORE', 'STATE_AFTER'].includes(kind),
    execute: async (operation, context) => {
      const candidates = (options.apiSpecs ?? []).filter((apiSpec) => (
        operation.apiSpecId ? apiSpec.id === operation.apiSpecId : true
      ) && apiSpec.method === operation.method && apiSpec.path === operation.path);
      if (candidates.length !== 1) {
        const code: BlockedReason['code'] = candidates.length > 1
          ? 'AMBIGUOUS_OPERATION_BINDING' : 'MISSING_API_CONTRACT';
        return {
          status: 'BLOCKED', executed: false, evidence: [],
          error: candidates.length > 1
            ? `${code}：${operation.id} 匹配到多个 ApiSpec`
            : `${code}：${operation.id} 没有精确匹配的 ApiSpec`,
          blockedReasons: [blocked(code, 'BINDING', `${operation.id} 无法建立唯一 ApiSpec Binding`, {
            operationId: operation.id,
            apiSpecId: operation.apiSpecId,
            method: operation.method,
            path: operation.path,
            candidateIds: candidates.map((item) => item.id),
          })],
        };
      }
      const apiSpec = candidates[0];
      const scenarioAssertions = context.scenario.assertions.filter((assertion) => assertion.operationId === operation.id);
      const assertions = scenarioAssertions.map(adapterAssertion).filter((item): item is AssertionDefinition => Boolean(item));
      const actor = context.scenario.actor ? {
        id: context.scenario.actor.id,
        role: context.scenario.actor.role,
        userId: context.scenario.actor.userId,
        tenantId: context.scenario.actor.tenantId,
        tokenRef: context.scenario.actor.credentialRef,
      } : undefined;
      const apiDependency = context.scenario.contractDependencies?.find((dependency) =>
        dependency.contractId === apiSpec.id
        || dependency.contractId.toLowerCase() === `api.${apiSpec.id.toLowerCase()}`);
      const testCase: TestCase = {
        id: `${context.scenario.id}:${operation.id}`,
        feature: context.scenario.domain ?? 'scenario',
        name: operation.description,
        priority: context.scenario.priority,
        testType: 'API',
        executionMode: 'EXECUTABLE',
        protocol: 'HTTP',
        source: {
          requirementId: context.scenario.sources[0]?.requirementId ?? context.scenario.id,
          testPointId: operation.id,
          acceptanceCriteriaIds: operation.acceptanceCriteriaIds,
          apiSpecId: apiSpec.id,
          apiOperationKey: apiSpec.operationKey,
          contractRef: apiDependency?.contractId,
          contractVersion: apiDependency?.version,
          contractFingerprint: apiDependency?.fingerprint,
        },
        actor,
        tags: ['scenario-asset'],
        negativeContractIntent: context.scenario.metadata?.negativeContractIntent
          && typeof context.scenario.metadata.negativeContractIntent === 'object'
          ? context.scenario.metadata.negativeContractIntent as TestCase['negativeContractIntent']
          : undefined,
        steps: [{
          type: 'HTTP_REQUEST',
          method: operation.method,
          url: operation.path,
          headers: operation.headers,
          pathParams: operation.pathParams,
          query: operation.query,
          body: operation.input,
          actor,
        }],
        assertions,
      };
      const result = await apiProcessor.execute(testCase, {
        ...options,
        signal: context.signal,
        timeoutMs: operation.timeoutMs,
        runId: context.runId,
      });
      const observedAt = new Date().toISOString();
      const evidence: EvidenceEnvelope[] = [];
      for (const requirement of context.scenario.evidenceRequirements.filter((item) => item.operationId === operation.id)) {
        const requestKind = requirement.kind === 'REQUEST';
        const safeObserverRead = ['GET', 'HEAD', 'OPTIONS'].includes(operation.method ?? '');
        const observable = requestKind ? result.evidence.request
          : requirement.kind === 'RESPONSE' || safeObserverRead && ['RESOURCE', 'STATE_BEFORE', 'STATE_AFTER'].includes(requirement.kind)
            ? result.evidence.response : undefined;
        if (observable === undefined) continue;
        evidence.push({
          id: requirement.id,
          requirementId: requirement.id,
          scenarioId: context.scenario.id,
          operationId: operation.id,
          acceptanceCriteriaIds: [...new Set(requirement.assertionIds.flatMap((assertionId) => (
            context.scenario.assertions.find((assertion) => assertion.id === assertionId)?.acceptanceCriteriaIds ?? []
          )))],
          kind: requirement.kind,
          channel: requirement.channel,
          source: requestKind ? 'ApiProcessor.request' : 'ApiProcessor.response-observer',
          observedAt,
          data: observable,
          verified: true,
        });
      }
      // ApiProcessor 的 FAIL 表示 HTTP 断言不匹配，不表示传输失败。Scenario
      // Oracle 必须在 State/Side-effect Observer 完成后统一判定，故传输与
      // Response 已取得时把原子 Operation 视为完成，不能提前中断后续观察。
      const transportCompleted = result.executed === true && result.evidence.response !== undefined;
      return {
        status: transportCompleted ? 'PASS' : result.status ?? 'BLOCKED',
        executed: result.executed === true,
        output: result.evidence.response,
        evidence,
        error: transportCompleted ? undefined : result.error,
        blockedReasons: !transportCompleted && result.blockedReason && typeof result.blockedReason === 'object'
          ? [result.blockedReason as BlockedReason] : undefined,
      };
    },
  };
}
