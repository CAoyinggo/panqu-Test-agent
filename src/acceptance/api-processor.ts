import type { CaseExecutionResult, ExecutionOutcome } from '../agents/execution/execution-schema.js';
import { computeOutcome } from '../agents/execution/execution-schema.js';
import type { DefectDraft } from '../agents/defect/defect-schema.js';
import type { AssertionDefinition, TestActor, TestCase, TestCaseSourceType, TestStep } from '../agents/test-design/testcase-schema.js';
import { checkDslExecutable, isDesignedOnlyCase } from '../agents/test-design/testcase-schema.js';
import type { CanonicalSceneId } from '../core/canonical-scene.js';
import { redactSensitive, redactSensitiveText } from '../core/redact.js';
import type { ApiSpec } from './requirement-ir.js';
import { validateApiBindingGate } from './api-binding-gate.js';
import type { ContractResolverLike } from '../contracts/resolver.js';

export interface HttpRequestEvidence {
  method: string;
  url: string;
  headers: Record<string, string>;
  pathParams: Record<string, unknown>;
  query: Record<string, unknown>;
  body?: unknown;
  actor?: TestActor;
}

export interface HttpResponseEvidence {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface AcceptanceAssertionEvidence {
  type: string;
  path?: string;
  factIds?: string[];
  objectiveIds?: string[];
  sourceType?: TestCaseSourceType;
  provenance?: string;
  expected?: unknown;
  actual?: unknown;
  pass: boolean;
  detail: string;
}

export interface AcceptanceExecutionEvidence {
  requirementId?: string;
  acceptanceCriteriaIds: string[];
  factIds?: string[];
  objectiveIds?: string[];
  scenarioId?: string;
  sourceType?: TestCaseSourceType;
  testPointId?: string;
  request?: HttpRequestEvidence;
  response?: HttpResponseEvidence;
  assertions: AcceptanceAssertionEvidence[];
  /**
   * Transport truth is kept separate from `executed`: a client abort can stop
   * observation without proving that the server did not commit a mutation.
   */
  transport?: {
    requestDispatched: boolean;
    responseCompleted: boolean;
    outcome: 'CONFIRMED' | 'UNKNOWN';
    sideEffect: 'NOT_APPLICABLE' | 'POSSIBLY_COMMITTED';
  };
  binding?: {
    valid: boolean;
    apiSpecId?: string;
    operationKey?: string;
    code?: string;
    message?: string;
  };
}

export interface AcceptanceCaseExecutionResult extends CaseExecutionResult {
  runId?: string;
  classification: AcceptanceExecutionClassification;
  attribution: AcceptanceErrorAttribution;
  evidence: AcceptanceExecutionEvidence;
}

export interface AcceptanceErrorAttribution {
  classification: AcceptanceExecutionClassification;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reason: string;
  evidenceSources: string[];
}

export type AcceptanceExecutionClassification =
  | 'SUCCESS'
  | 'PRODUCT_FAILURE'
  | 'ENVIRONMENT_FAILURE'
  | 'EXECUTION_BLOCKED'
  | 'NOT_EXECUTED'
  | 'SYSTEM_ERROR'
  | 'DEPENDENCY_FAILURE'
  | 'AUTHENTICATION_FAILURE'
  | 'GATEWAY_FAILURE'
  | 'UNCONFIRMED';

export interface ApiProcessorOptions {
  baseUrl: string;
  /** actor.id/tokenRef/userId → 本次请求要使用的真实 Session/Header。 */
  actorHeaders?: Record<string, Record<string, string>>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  runId?: string;
  executionEnabled?: boolean;
  blockedReason?: string;
  blockedClassification?: AcceptanceExecutionClassification;
  /** Binding Gate 使用的原始 Requirement API 契约。 */
  apiSpecs?: ApiSpec[];
  /** Acceptance 入口注入；存在时 Case 必须携带可解析 Contract Ref。 */
  contractResolver?: ContractResolverLike;
}

function caseQualityBlockReason(testCase: TestCase): string | undefined {
  const quality = testCase.metadata?.caseQuality as { status?: string; issues?: Array<{ code?: string; message?: string }> } | undefined;
  if (quality?.status !== 'BLOCKED') return undefined;
  return quality.issues?.map((issue) => `${issue.code ?? 'CASE_QUALITY_BLOCKED'}：${issue.message ?? 'Case Quality Gate 未通过'}`).join('；')
    ?? 'CASE_QUALITY_BLOCKED';
}

function resultBase(testCase: TestCase, runId?: string): Pick<AcceptanceCaseExecutionResult,
  'caseId' | 'name' | 'feature' | 'scene' | 'priority' | 'tags' | 'timestamp' | 'evidence' | 'runId'
  | 'assertions' | 'passedAssertions' | 'failedAssertions' | 'blockedReason'> {
  return {
    runId,
    caseId: testCase.id,
    name: testCase.name,
    feature: testCase.feature,
    scene: 'api',
    priority: testCase.priority,
    tags: testCase.tags,
    timestamp: new Date().toISOString(),
    assertions: 0,
    passedAssertions: 0,
    failedAssertions: 0,
    blockedReason: null,
    evidence: {
      requirementId: testCase.source?.requirementId,
      acceptanceCriteriaIds: testCase.source?.acceptanceCriteriaIds ?? [],
      factIds: testCase.source?.factIds ?? [],
      objectiveIds: testCase.source?.objectiveIds ?? [],
      scenarioId: testCase.source?.scenarioId,
      sourceType: testCase.source?.sourceType,
      testPointId: testCase.source?.testPointId,
      assertions: [],
    },
  };
}

function attributeResult(result: CaseExecutionResult & { evidence?: AcceptanceExecutionEvidence }): AcceptanceErrorAttribution {
  if (result.status === 'PASS' && result.executed === true) return {
    classification: 'SUCCESS', confidence: 'HIGH',
    reason: '真实响应存在，且所有已声明的确定性断言通过',
    evidenceSources: ['HTTP_RESPONSE', 'ASSERTION_EVIDENCE', 'BINDING_GATE'],
  };
  if (result.status === 'FAIL' && result.executed === true) {
    const status = result.evidence?.response?.status;
    if (status !== undefined && [401, 403, 429, 500, 502, 503, 504].includes(status)) return {
      classification: 'UNCONFIRMED', confidence: 'LOW',
      reason: `HTTP ${status} 可能来自产品、凭据、网关、依赖或环境；仅凭状态码不能归责`,
      evidenceSources: ['HTTP_RESPONSE', 'ASSERTION_EVIDENCE'],
    };
    return {
      classification: 'PRODUCT_FAILURE', confidence: 'MEDIUM',
      reason: '已声明的确定性响应断言失败；尚未用服务端日志或 Trace 证明责任边界',
      evidenceSources: ['HTTP_RESPONSE', 'ASSERTION_EVIDENCE', 'BINDING_GATE'],
    };
  }
  if (result.status === 'NOT_EXECUTED') return {
    classification: 'NOT_EXECUTED', confidence: 'HIGH', reason: '执行器明确记录为未执行', evidenceSources: ['RUNNER_STATE'],
  };
  if (result.status === 'TIMEOUT') {
    const mutationUnknown = result.evidence?.transport?.sideEffect === 'POSSIBLY_COMMITTED';
    return mutationUnknown ? {
      classification: 'UNCONFIRMED', confidence: 'HIGH',
      reason: 'EXECUTION_UNKNOWN：写请求已发出但客户端超时；服务端可能已经提交副作用，不能声明未执行或安全重试',
      evidenceSources: ['HTTP_REQUEST_DISPATCH', 'ABORT_SIGNAL', 'CLIENT_TIMER'],
    } : {
      classification: 'ENVIRONMENT_FAILURE', confidence: 'MEDIUM', reason: '请求达到客户端超时；服务端责任未知', evidenceSources: ['ABORT_SIGNAL', 'CLIENT_TIMER'],
    };
  }
  if (result.status === 'CANCELLED') return {
    classification: 'EXECUTION_BLOCKED', confidence: 'HIGH', reason: 'Run AbortSignal 已取消执行或阻止后续 Case', evidenceSources: ['ABORT_SIGNAL', 'RUNNER_STATE'],
  };
  if (result.status === 'BLOCKED' && result.executed === true) return {
    classification: 'SYSTEM_ERROR', confidence: 'MEDIUM', reason: 'HTTP 已发生，但本地执行契约不足以产生可信结果', evidenceSources: ['HTTP_RESPONSE', 'RUNNER_STATE'],
  };
  if (result.status === 'BLOCKED' && result.processorInvoked === true) return {
    classification: 'ENVIRONMENT_FAILURE', confidence: 'LOW', reason: 'Processor 已调用但未获得可判定响应；网络、环境与服务端责任未确认', evidenceSources: ['PROCESSOR_STATE'],
  };
  return {
    classification: 'EXECUTION_BLOCKED', confidence: 'HIGH', reason: '执行前置条件或安全 Gate 未满足', evidenceSources: ['RUNNER_STATE'],
  };
}

function actorHeaders(actor: TestActor | undefined, options: ApiProcessorOptions): Record<string, string> | null {
  if (!actor) return {};
  const keys = [actor.tokenRef, actor.id, actor.userId].filter((value): value is string => Boolean(value));
  for (const key of keys) {
    const headers = options.actorHeaders?.[key];
    if (headers) return { ...headers };
  }
  return null;
}

function resolvePath(template: string, params: Record<string, unknown>): string | null {
  let missing = false;
  const path = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    if (params[name] === undefined || params[name] === null) {
      missing = true;
      return `{${name}}`;
    }
    return encodeURIComponent(String(params[name]));
  });
  return missing ? null : path;
}

function appendQuery(url: URL, query: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(name, String(item)));
    else url.searchParams.set(name, String(value));
  }
}

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name.toLowerCase()] = value;
  });
  return record;
}

function valueAtPath(root: unknown, path: string | undefined): unknown {
  if (!path) return root;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let value = root;
  for (const part of parts) {
    if (value === null || value === undefined || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function equalValue(actual: unknown, expected: unknown): boolean {
  return Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
}

function evaluateAssertion(assertion: AssertionDefinition, response: HttpResponseEvidence): AcceptanceAssertionEvidence {
  const type = assertion.type ?? 'UNKNOWN';
  let actual: unknown;
  let pass = false;
  if (type === 'STATUS_CODE') {
    actual = response.status;
    pass = equalValue(actual, assertion.expected);
  } else if (type === 'RESPONSE_HEADER') {
    actual = response.headers[String(assertion.header ?? '').toLowerCase()];
    pass = equalValue(actual, assertion.expected);
  } else if (type === 'JSON_PATH') {
    actual = valueAtPath(response.body, assertion.path);
    pass = actual !== undefined;
  } else if (type === 'JSON_VALUE') {
    actual = valueAtPath(response.body, assertion.path);
    pass = equalValue(actual, assertion.expected);
  } else if (type === 'CONTAINS') {
    actual = valueAtPath(response.body, assertion.path);
    pass = typeof actual === 'string'
      ? actual.includes(String(assertion.expected))
      : Array.isArray(actual) && actual.some((item) => equalValue(item, assertion.expected));
  } else if (type === 'TYPE') {
    actual = valueType(valueAtPath(response.body, assertion.path));
    pass = actual === assertion.expected;
  }
  return {
    type,
    path: assertion.path ?? assertion.header,
    factIds: assertion.factIds,
    objectiveIds: assertion.objectiveIds ?? (assertion.objectiveId ? [assertion.objectiveId] : undefined),
    sourceType: assertion.sourceType,
    provenance: assertion.provenance,
    expected: assertion.expected,
    actual,
    pass,
    detail: `${type}${assertion.path ? ` ${assertion.path}` : assertion.header ? ` ${assertion.header}` : ''}：expected=${JSON.stringify(assertion.expected)} actual=${JSON.stringify(actual)}`,
  };
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (/json/i.test(contentType)) {
    try { return JSON.parse(text) as unknown; } catch { return text; }
  }
  return text;
}

function makeLinkedSignal(options: ApiProcessorOptions): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error(`API 请求超时（${options.timeoutMs ?? 5000}ms）`));
  }, options.timeoutMs ?? 5000);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    cleanup: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** 通用 HTTP API Processor：只有真实 Response + 有效断言全部通过才产生 PASS。 */
export class ApiProcessor {
  readonly name = 'api';
  readonly supportedScenes = ['api'] as const;
  readonly supportedMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

  supports(scene: CanonicalSceneId): boolean {
    return scene === 'api';
  }

  async execute(testCase: TestCase, options: ApiProcessorOptions): Promise<AcceptanceCaseExecutionResult> {
    const result = await this.executeRaw(testCase, options);
    const attribution = attributeResult(result);
    return { ...result, runId: options.runId, classification: attribution.classification, attribution };
  }

  private async executeRaw(testCase: TestCase, options: ApiProcessorOptions): Promise<Omit<AcceptanceCaseExecutionResult, 'classification' | 'attribution'>> {
    const base = resultBase(testCase, options.runId);
    const qualityBlockReason = caseQualityBlockReason(testCase);
    if (qualityBlockReason) {
      return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'BLOCKED', pass: false, passRate: 0, error: `BLOCKED：${qualityBlockReason}` };
    }
    if (isDesignedOnlyCase(testCase)) {
      return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'NOT_EXECUTED', pass: false, passRate: 0, error: `NOT_EXECUTED：${testCase.executionMode}` };
    }
    const dsl = checkDslExecutable(testCase);
    const nonAssertionProblems = dsl.problems.filter((problem) => problem !== '缺少有效业务断言');
    if (nonAssertionProblems.length) {
      return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'NOT_EXECUTED', pass: false, passRate: 0, error: `NOT_EXECUTED：${nonAssertionProblems.join('；')}` };
    }
    // Assertion Gate 必须位于任何身份准备、Binding、URL 构造和网络请求之前。
    // 对写请求尤其重要：缺少 oracle 的 Case 不允许先产生副作用、再返回 BLOCKED。
    if (dsl.problems.includes('缺少有效业务断言')) {
      return {
        ...base,
        executed: false,
        processor: this.name,
        processorInvoked: false,
        status: 'BLOCKED',
        pass: false,
        passRate: 0,
        assertions: 0,
        passedAssertions: 0,
        failedAssertions: 0,
        blockedReason: {
          code: 'MISSING_ASSERTION',
          stage: 'GATE',
          message: '没有有效 HTTP 业务断言，禁止发起请求',
          recoverable: true,
        },
        error: 'BLOCKED：MISSING_ASSERTION：没有有效 HTTP 业务断言，禁止发起请求',
      };
    }
    const requestSteps = testCase.steps.filter((item): item is TestStep & { type: 'HTTP_REQUEST' } => item.type === 'HTTP_REQUEST');
    const step = requestSteps[0];
    if (!step || !step.method || !step.url) {
      return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'NOT_EXECUTED', pass: false, passRate: 0, error: 'NOT_EXECUTED：缺少 HTTP_REQUEST' };
    }
    if (requestSteps.length !== 1) {
      return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'NOT_EXECUTED', pass: false, passRate: 0, error: 'NOT_EXECUTED：第一阶段每个 API Case 必须且只能包含一个 HTTP_REQUEST' };
    }
    if (!(this.supportedMethods as readonly string[]).includes(step.method)) {
      return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'NOT_EXECUTED', pass: false, passRate: 0, error: `NOT_EXECUTED：不支持 HTTP Method ${String(step.method)}` };
    }
    if (!options.baseUrl?.trim()) {
      return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'BLOCKED', pass: false, passRate: 0, error: 'BLOCKED：API baseUrl 未配置' };
    }
    const identityHeaders = actorHeaders(step.actor ?? testCase.actor, options);
    if (identityHeaders === null) {
      return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'BLOCKED', pass: false, passRate: 0, error: `BLOCKED：身份 ${(step.actor ?? testCase.actor)?.id ?? 'unknown'} 无法准备` };
    }
    const headers: Record<string, string> = { ...identityHeaders, ...(step.headers ?? {}) };
    if (options.contractResolver) {
      const contractRef = testCase.source?.contractRef;
      if (!contractRef) {
        return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'BLOCKED', pass: false, passRate: 0,
          error: 'BLOCKED：MISSING_CONTRACT：API Case 缺少 canonical contractRef' };
      }
      const resolution = options.contractResolver.resolve<Record<string, unknown>>({ id: contractRef });
      const contract = resolution.contract;
      if (resolution.status !== 'RESOLVED' || !contract) {
        return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'BLOCKED', pass: false, passRate: 0,
          error: `BLOCKED：CONTRACT_${resolution.status}：${contractRef}` };
      }
      if ((testCase.source?.contractVersion && contract.version !== testCase.source.contractVersion)
        || (testCase.source?.contractFingerprint && contract.fingerprint !== testCase.source.contractFingerprint)
        || contract.value.method !== step.method || contract.value.path !== step.url) {
        return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'BLOCKED', pass: false, passRate: 0,
          error: `BLOCKED：CONTRACT_DRIFT：${contractRef} 与 Case Method/Path/Version/Fingerprint 不一致` };
      }
    }
    const gate = validateApiBindingGate(testCase, step, options.apiSpecs, headers);
    base.evidence.binding = gate.valid
      ? { valid: true, apiSpecId: gate.apiSpecId, operationKey: gate.apiSpec.operationKey }
      : { valid: false, apiSpecId: gate.apiSpecId, code: gate.code, message: gate.message };
    if (!gate.valid) {
      return {
        ...base, executed: false, processor: this.name, processorInvoked: false,
        status: 'BLOCKED', pass: false, passRate: 0,
        error: `BLOCKED：${gate.code}：${gate.message}`,
      };
    }
    const pathParams = step.pathParams ?? {};
    const resolvedPath = resolvePath(step.url, pathParams);
    if (!resolvedPath) {
      return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'NOT_EXECUTED', pass: false, passRate: 0, error: 'NOT_EXECUTED：Path Parameter 缺失' };
    }

    if (!/^\/(?!\/)/.test(resolvedPath) || /[\\\u0000-\u001f]/.test(resolvedPath)) {
      return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'BLOCKED', pass: false, passRate: 0, error: 'BLOCKED：INVALID_API_PATH，HTTP Request 必须使用 single-leading-slash 相对路径' };
    }

    let baseUrl: URL;
    let url: URL;
    try {
      baseUrl = new URL(options.baseUrl);
      url = new URL(resolvedPath, baseUrl);
      if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || url.origin !== baseUrl.origin) {
        throw new Error('request origin differs from configured baseUrl');
      }
    } catch (error) {
      return { ...base, executed: false, processor: this.name, processorInvoked: false, status: 'BLOCKED', pass: false, passRate: 0, error: `BLOCKED：ENVIRONMENT_TARGET_MISMATCH：${(error as Error).message}` };
    }
    appendQuery(url, step.query ?? {});
    const requestInit: RequestInit = { method: step.method, headers };
    if (step.body !== undefined) {
      if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      requestInit.body = JSON.stringify(step.body);
    }
    const requestEvidence: HttpRequestEvidence = {
      method: step.method,
      url: url.toString(),
      headers: { ...headers },
      pathParams,
      query: step.query ?? {},
      body: step.body,
      actor: step.actor ?? testCase.actor,
    };
    base.evidence.request = requestEvidence;
    const mutatingRequest = !['GET', 'HEAD'].includes(step.method);
    base.evidence.transport = {
      requestDispatched: true,
      responseCompleted: false,
      outcome: 'UNKNOWN',
      sideEffect: mutatingRequest ? 'POSSIBLY_COMMITTED' : 'NOT_APPLICABLE',
    };

    const linked = makeLinkedSignal(options);
    const started = Date.now();
    try {
      const response = await (options.fetchImpl ?? fetch)(url, { ...requestInit, signal: linked.signal, redirect: 'manual' });
      if (linked.signal.aborted) throw linked.signal.reason ?? new Error('request aborted');
      const responseEvidence: HttpResponseEvidence = {
        status: response.status,
        headers: headerRecord(response.headers),
        body: await parseResponse(response),
      };
      base.evidence.transport = {
        requestDispatched: true,
        responseCompleted: true,
        outcome: 'CONFIRMED',
        sideEffect: 'NOT_APPLICABLE',
      };
      if (linked.signal.aborted) throw linked.signal.reason ?? new Error('request aborted');
      const assertions = testCase.assertions.filter((assertion) => assertion.type).map((assertion) => evaluateAssertion(assertion, responseEvidence));
      if (linked.signal.aborted) throw linked.signal.reason ?? new Error('request aborted');
      const evidence = { ...base.evidence, response: responseEvidence, assertions };
      if (!assertions.length) {
        return {
          ...base, evidence, executed: true, processor: this.name, processorInvoked: true,
          requestId: response.headers.get('x-request-id') ?? undefined,
          status: 'BLOCKED', pass: false, passRate: 0, durationMs: Date.now() - started,
          error: 'BLOCKED：没有有效 HTTP 业务断言', checks: [],
        };
      }
      const passed = assertions.filter((assertion) => assertion.pass).length;
      const pass = passed === assertions.length;
      return {
        ...base, evidence, executed: true, processor: this.name, processorInvoked: true,
        assertions: assertions.length,
        passedAssertions: passed,
        failedAssertions: assertions.length - passed,
        requestId: response.headers.get('x-request-id') ?? undefined,
        status: pass ? 'PASS' : 'FAIL', pass, passRate: Math.round((passed / assertions.length) * 100),
        durationMs: Date.now() - started,
        error: pass ? undefined : `FAIL：${assertions.length - passed} 条业务断言失败`,
        checks: assertions.map((assertion) => ({ name: assertion.type, pass: assertion.pass, detail: assertion.detail, kind: 'BUSINESS' })),
      };
    } catch (error) {
      const timeout = linked.timedOut();
      const executionUnknown = mutatingRequest && base.evidence.transport?.requestDispatched === true;
      return {
        ...base, executed: false, processor: this.name, processorInvoked: true,
        status: timeout ? 'TIMEOUT' : options.signal?.aborted ? 'CANCELLED' : 'BLOCKED',
        pass: false, passRate: 0, timedOut: timeout, durationMs: Date.now() - started,
        error: redactSensitiveText(`${executionUnknown ? 'EXECUTION_UNKNOWN/POSSIBLY_EXECUTED；' : ''}${timeout ? 'TIMEOUT' : options.signal?.aborted ? 'CANCELLED' : 'BLOCKED'}：${(error as Error).message}`),
      };
    } finally {
      linked.cleanup();
    }
  }
}

export interface AcceptanceRunResult {
  outcome: ExecutionOutcome;
  results: AcceptanceCaseExecutionResult[];
}

export async function runAcceptanceApiCases(
  testCases: TestCase[],
  options: ApiProcessorOptions & { processor?: ApiProcessor | null },
): Promise<AcceptanceRunResult> {
  const processor = options.processor === undefined ? new ApiProcessor() : options.processor;
  const results: AcceptanceCaseExecutionResult[] = [];
  const deadlineController = options.deadlineMs !== undefined ? new AbortController() : undefined;
  let deadlineExceeded = false;
  const onExternalAbort = (): void => deadlineController?.abort(options.signal?.reason);
  if (deadlineController && options.signal?.aborted) deadlineController.abort(options.signal.reason);
  else if (deadlineController) options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const deadlineTimer = deadlineController ? setTimeout(() => {
    deadlineExceeded = true;
    deadlineController.abort(new Error(`RUN_DEADLINE_EXCEEDED：${options.deadlineMs}ms`));
  }, Math.max(1, options.deadlineMs!)) : undefined;
  const executionSignal = deadlineController?.signal ?? options.signal;
  const executionOptions = { ...options, signal: executionSignal };
  try {
    for (const testCase of testCases) {
      const qualityBlockReason = caseQualityBlockReason(testCase);
      if (qualityBlockReason) {
        const base = resultBase(testCase, options.runId);
        results.push({
          ...base, classification: 'EXECUTION_BLOCKED', attribution: {
            classification: 'EXECUTION_BLOCKED', confidence: 'HIGH', reason: qualityBlockReason, evidenceSources: ['CASE_QUALITY_GATE'],
          }, executed: false, processorInvoked: false,
          status: 'BLOCKED', pass: false, passRate: 0, error: redactSensitiveText(`BLOCKED：${qualityBlockReason}`),
        });
      } else if (isDesignedOnlyCase(testCase)) {
        const base = resultBase(testCase, options.runId);
        results.push({
          ...base, classification: 'NOT_EXECUTED', attribution: {
            classification: 'NOT_EXECUTED', confidence: 'HIGH', reason: `${testCase.executionMode} Case 不具备执行契约`, evidenceSources: ['CASE_EXECUTION_MODE'],
          }, executed: false, processorInvoked: false,
          status: 'NOT_EXECUTED', pass: false, passRate: 0,
          error: `NOT_EXECUTED：${String(testCase.metadata?.reason ?? testCase.executionMode)}`,
        });
      } else if (options.blockedReason) {
        const base = resultBase(testCase, options.runId);
        const classification = options.blockedClassification ?? 'ENVIRONMENT_FAILURE';
        results.push({ ...base, classification, attribution: {
          classification, confidence: classification === 'EXECUTION_BLOCKED' ? 'HIGH' : 'MEDIUM',
          reason: 'Pipeline 前置条件或 Data Lifecycle 未满足', evidenceSources: ['PIPELINE_GATE'],
        }, executed: false, processorInvoked: false, status: 'BLOCKED', pass: false, passRate: 0, error: redactSensitiveText(`BLOCKED：${options.blockedReason}`) });
      } else if (options.executionEnabled === false) {
        const base = resultBase(testCase, options.runId);
        results.push({ ...base, classification: 'NOT_EXECUTED', attribution: {
          classification: 'NOT_EXECUTED', confidence: 'HIGH', reason: 'DRY_RUN 禁止发起 HTTP 请求', evidenceSources: ['RUN_MODE'],
        }, executed: false, processorInvoked: false, status: 'NOT_EXECUTED', pass: false, passRate: 0, error: 'NOT_EXECUTED：DRY_RUN，仅生成验收资产，未发起 HTTP 请求' });
      } else if (!processor) {
        const base = resultBase(testCase, options.runId);
        const missingProcessor = { code: 'MISSING_PROCESSOR', stage: 'GATE', message: 'ApiProcessor 不存在', recoverable: true };
        results.push({ ...base, classification: 'EXECUTION_BLOCKED', attribution: {
          classification: 'EXECUTION_BLOCKED', confidence: 'HIGH', reason: 'ApiProcessor 不存在', evidenceSources: ['PROCESSOR_REGISTRY'],
        }, executed: false, processorInvoked: false, status: 'BLOCKED', pass: false, passRate: 0,
        blockedReason: missingProcessor, error: 'BLOCKED：MISSING_PROCESSOR：ApiProcessor 不存在' });
      } else if (executionSignal?.aborted) {
        const base = resultBase(testCase, options.runId);
        results.push({
          ...base, classification: 'EXECUTION_BLOCKED', attribution: {
            classification: 'EXECUTION_BLOCKED', confidence: 'HIGH', reason: 'Run Deadline 或外部 Abort 已阻止 Case 启动', evidenceSources: ['ABORT_SIGNAL', 'RUNNER_STATE'],
          }, executed: false, processorInvoked: false,
          status: 'CANCELLED', pass: false, passRate: 0,
          error: deadlineExceeded ? 'CANCELLED：RUN_DEADLINE_EXCEEDED' : 'CANCELLED：Run AbortSignal 已取消',
        });
      } else {
        results.push(await processor.execute(testCase, executionOptions));
      }
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
  return {
    results,
    outcome: computeOutcome(testCases[0]?.feature ?? 'acceptance', results, {
      executed: results.length > 0 && results.every((result) => result.executed === true && (result.status === 'PASS' || result.status === 'FAIL')),
      summary: `API 开发验收：${results.length} 条，PASS ${results.filter((result) => result.status === 'PASS').length}，FAIL ${results.filter((result) => result.status === 'FAIL').length}，BLOCKED ${results.filter((result) => result.status === 'BLOCKED').length}，NOT_EXECUTED ${results.filter((result) => result.status === 'NOT_EXECUTED').length}`,
    }),
  };
}

/** 只有真实执行后的 FAIL 才生成产品缺陷；其余状态由报告归入风险/未测试。 */
export interface AcceptanceDefect extends DefectDraft {
  runId?: string;
  requirementId?: string;
  acceptanceCriteriaIds: string[];
  factIds: string[];
  objectiveIds: string[];
  testPointId?: string;
  caseId: string;
  classification: 'PRODUCT_DEFECT';
  suspectedLayer: 'PRODUCT';
  attribution: AcceptanceErrorAttribution;
  preconditions: string[];
  request?: unknown;
  response?: unknown;
}

/** 将 URL 的内部 Origin 移除，保留可与环境 baseUrl 组合复现的 Path/Query。 */
function safeRequest(request: HttpRequestEvidence | undefined): unknown {
  if (!request) return undefined;
  let url = request.url;
  try {
    const parsed = new URL(url);
    const safePath = parsed.pathname.replace(/\/(?:user|tenant)-[A-Za-z0-9_-]+/gi, '/[REDACTED_RESOURCE_ID]');
    for (const [name, queryValue] of parsed.searchParams) {
      parsed.searchParams.set(name,
        /(?:token|key|secret|auth|cookie|session|password|email|phone|mobile|user|tenant|account)/i.test(name)
          ? '***'
          : redactSensitiveText(queryValue));
    }
    url = `[CONFIGURED_BASE_URL]${redactSensitiveText(safePath)}${parsed.search}`;
  } catch { /* 相对 URL 原样进入递归脱敏 */ }
  return redactSensitive({ ...request, url });
}

export function buildAcceptanceDefects(
  results: AcceptanceCaseExecutionResult[],
  environment = 'test',
  context: { runId?: string; testCases?: TestCase[] } = {},
): AcceptanceDefect[] {
  const cases = new Map((context.testCases ?? []).map((testCase) => [testCase.id, testCase]));
  return results
    .filter((result) => result.executed === true && result.status === 'FAIL' && result.classification === 'PRODUCT_FAILURE')
    .map((result, index) => {
      const failed = result.evidence.assertions.filter((assertion) => !assertion.pass);
      const request = result.evidence.request;
      const response = result.evidence.response;
      const testCase = cases.get(result.caseId);
      const safeReq = safeRequest(request);
      const safeResponse = redactSensitive(response);
      return {
        id: `defect-${String(index + 1).padStart(3, '0')}`,
        feature: result.feature ?? 'acceptance',
        title: `[API] ${result.name} 业务断言失败`,
        severity: result.priority === 'P0' ? 'P0' : 'P1',
        priority: result.priority === 'P0' ? 'CRITICAL' : 'HIGH',
        description: `真实 API 请求已完成，但 ${failed.length} 条业务断言失败。`,
        steps: request ? [
          `${request.method} ${(safeReq as { url?: string } | undefined)?.url ?? '[URL REDACTED]'}`,
          `Actor=${request.actor?.id ?? 'anonymous'}`,
          `Headers=${JSON.stringify((safeReq as { headers?: unknown } | undefined)?.headers ?? {})}`,
          `Body=${JSON.stringify((safeReq as { body?: unknown } | undefined)?.body)}`,
        ] : [`执行用例 ${result.caseId}`],
        expected: failed.map((assertion) => `${assertion.type}=${JSON.stringify(assertion.expected)}`).join('；'),
        actual: failed.map((assertion) => `${assertion.type}=${JSON.stringify(assertion.actual)}`).join('；'),
        impact: `${result.feature ?? 'acceptance'} API 开发验收失败`,
        environment,
        evidence: failed.map((assertion) => redactSensitiveText(assertion.detail)),
        logs: [],
        responseSummary: response ? `HTTP ${response.status} ${JSON.stringify((safeResponse as { body?: unknown } | undefined)?.body)}` : redactSensitiveText(result.error ?? ''),
        relatedCases: [result.caseId],
        status: 'DRAFT',
        createdAt: new Date().toISOString(),
        source: 'acceptance-deterministic',
        confidence: result.attribution.confidence === 'HIGH' ? 1 : result.attribution.confidence === 'MEDIUM' ? 0.7 : 0.3,
        runId: context.runId ?? result.runId,
        requirementId: result.evidence.requirementId,
        acceptanceCriteriaIds: result.evidence.acceptanceCriteriaIds,
        factIds: result.evidence.factIds ?? [],
        objectiveIds: result.evidence.objectiveIds ?? [],
        testPointId: result.evidence.testPointId,
        caseId: result.caseId,
        classification: 'PRODUCT_DEFECT',
        suspectedLayer: 'PRODUCT',
        attribution: result.attribution,
        preconditions: testCase?.preconditions ?? [],
        request: safeReq,
        response: safeResponse,
      } satisfies AcceptanceDefect;
    });
}
