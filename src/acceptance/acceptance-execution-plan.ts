import { createHash } from 'node:crypto';
import type { AssertionDefinition, TestActor, TestCase, TestStep } from '../agents/test-design/testcase-schema.js';

export const ACCEPTANCE_CASE_IDENTITY_POLICY = 'SEMANTIC_SHA256_V1' as const;
export const ACCEPTANCE_EXECUTION_PLAN_VERSION = 'ACCEPTANCE_EXECUTION_PLAN_V1' as const;

export interface AcceptanceExecutionPlanIdentity {
  version: typeof ACCEPTANCE_EXECUTION_PLAN_VERSION;
  caseIdentityPolicy: typeof ACCEPTANCE_CASE_IDENTITY_POLICY;
  /** Exact source digest. Any requirement edit after preview invalidates scoped execution. */
  requirementDigest: string;
  /** Order-independent digest of every generated Case's execution semantics. */
  planDigest: string;
  /** Maximum scope authorized by this preview. A later execution may only narrow it. */
  selectedCaseIds: string[];
  /** Self-check over all fields above; detects stale or partially copied plan references. */
  previewDigest: string;
}

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonicalValue(value: unknown): CanonicalValue {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return { $unsupported: typeof value };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function actorIdentity(actor: TestActor | undefined): unknown {
  if (!actor) return null;
  return {
    id: actor.id,
    userId: actor.userId,
    role: actor.role,
    tenantId: actor.tenantId,
    tokenRef: actor.tokenRef,
    provenance: actor.provenance,
  };
}

function stepIdentity(step: TestStep): unknown {
  return {
    action: step.action,
    type: step.type,
    scene: step.scene,
    input: step.input,
    until: step.until,
    method: step.method,
    url: step.url,
    headers: step.headers,
    pathParams: step.pathParams,
    query: step.query,
    body: step.body,
    actor: actorIdentity(step.actor),
  };
}

function assertionIdentity(assertion: AssertionDefinition): unknown {
  // Trace IDs and priority are intentionally excluded: they do not change the
  // request/oracle and may move when unrelated requirement text is inserted.
  return {
    type: assertion.type,
    target: assertion.target,
    path: assertion.path,
    operator: assertion.operator,
    expected: assertion.expected,
    message: assertion.message,
    description: assertion.description,
    header: assertion.header,
  };
}

function sortedAssertions(assertions: AssertionDefinition[]): unknown[] {
  return assertions.map(assertionIdentity).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

/**
 * Stable semantic identity. It deliberately excludes positional TP/Fact/Objective
 * IDs. Executable Case identity is request + oracle based, so two generators
 * cannot obtain different IDs for the same real HTTP action merely because a
 * parameter vector or source line changed.
 */
export function acceptanceCaseSemanticIdentity(testCase: TestCase): unknown {
  const executable = testCase.executionMode === 'EXECUTABLE';
  const common = {
    executionMode: testCase.executionMode,
    protocol: testCase.protocol,
    operationKey: testCase.source?.apiOperationKey,
    actor: actorIdentity(testCase.actor),
    steps: testCase.steps.map(stepIdentity),
    assertions: sortedAssertions(testCase.assertions),
    expected: executable
      ? { status: testCase.expected?.status, fields: testCase.expected?.fields }
      : testCase.expected,
    negativeContractIntent: testCase.negativeContractIntent,
  };
  if (executable) return common;
  return {
    ...common,
    testType: testCase.testType,
    preconditions: testCase.preconditions,
    name: testCase.name.replace(/\s+/g, ' ').trim(),
    parameterContext: testCase.parameterContext,
    design: testCase.design ? {
      sourceType: testCase.design.sourceType,
      expectedOutcome: testCase.design.expectedOutcome,
      actions: testCase.design.actions,
      executability: testCase.design.executability,
      reason: testCase.design.reason,
    } : undefined,
  };
}

export function acceptanceCaseSemanticDigest(testCase: TestCase): string {
  return sha256(acceptanceCaseSemanticIdentity(testCase));
}

export function stableAcceptanceCaseId(testCase: TestCase): string {
  return `CASE-${acceptanceCaseSemanticDigest(testCase).slice(0, 24).toUpperCase()}`;
}

/** Assign IDs after all fail-close transforms and de-duplication have completed. */
export function assignStableAcceptanceCaseIds(testCases: TestCase[]): TestCase[] {
  const identityById = new Map<string, string>();
  for (const testCase of testCases) {
    const identity = canonicalJson(acceptanceCaseSemanticIdentity(testCase));
    const id = stableAcceptanceCaseId(testCase);
    const existing = identityById.get(id);
    if (existing !== undefined && existing !== identity) {
      throw new Error(`CASE_ID_COLLISION：${id} 对应多个执行语义，已阻断计划生成`);
    }
    if (existing !== undefined) {
      throw new Error(`DUPLICATE_CASE_SEMANTICS：${id} 的执行语义未在生成阶段合并，已阻断计划生成`);
    }
    identityById.set(id, identity);
    testCase.id = id;
  }
  return testCases;
}

function planDigest(testCases: TestCase[]): string {
  return sha256(testCases
    .map((testCase) => ({ id: testCase.id, semantics: acceptanceCaseSemanticIdentity(testCase) }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

function previewDigest(input: Omit<AcceptanceExecutionPlanIdentity, 'previewDigest'>): string {
  return sha256(input);
}

export function buildAcceptanceExecutionPlanIdentity(input: {
  markdown: string;
  allTestCases: TestCase[];
  selectedCaseIds?: string[];
}): AcceptanceExecutionPlanIdentity {
  const selectedCaseIds = [...new Set(input.selectedCaseIds ?? input.allTestCases.map((testCase) => testCase.id))].sort();
  const unsigned = {
    version: ACCEPTANCE_EXECUTION_PLAN_VERSION,
    caseIdentityPolicy: ACCEPTANCE_CASE_IDENTITY_POLICY,
    requirementDigest: sha256(input.markdown),
    planDigest: planDigest(input.allTestCases),
    selectedCaseIds,
  };
  return { ...unsigned, previewDigest: previewDigest(unsigned) };
}

export function validateAcceptanceExecutionPlanIdentity(input: {
  expected?: AcceptanceExecutionPlanIdentity;
  current: AcceptanceExecutionPlanIdentity;
  requestedCaseIds: string[];
}): { valid: true } | { valid: false; reason: string } {
  const expected = input.expected;
  if (!expected) return {
    valid: false,
    reason: 'STALE_PLAN：按 Case 执行必须携带 dry-run/已归档 Run 产生的 Execution Plan Identity',
  };
  if (expected.version !== ACCEPTANCE_EXECUTION_PLAN_VERSION
    || expected.caseIdentityPolicy !== ACCEPTANCE_CASE_IDENTITY_POLICY) {
    return { valid: false, reason: 'STALE_PLAN：Execution Plan 或 Case Identity 版本不受支持，必须重新预览' };
  }
  const { previewDigest: suppliedDigest, ...unsignedExpected } = expected;
  if (previewDigest({ ...unsignedExpected, selectedCaseIds: [...unsignedExpected.selectedCaseIds].sort() }) !== suppliedDigest) {
    return { valid: false, reason: 'STALE_PLAN：Execution Plan Identity 自校验失败，禁止执行' };
  }
  if (expected.requirementDigest !== input.current.requirementDigest) {
    return { valid: false, reason: 'STALE_PLAN：Requirement 在预览后发生变化，禁止按旧 Case 计划执行' };
  }
  if (expected.planDigest !== input.current.planDigest) {
    return { valid: false, reason: 'STALE_PLAN：生成的 Case 计划与预览语义不一致，禁止执行' };
  }
  const authorized = new Set(expected.selectedCaseIds);
  const expanded = input.requestedCaseIds.filter((caseId) => !authorized.has(caseId));
  if (expanded.length) {
    return { valid: false, reason: `STALE_PLAN：执行范围超出预览授权：${expanded.join(', ')}` };
  }
  return { valid: true };
}
