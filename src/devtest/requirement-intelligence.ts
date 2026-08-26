import { createHash } from 'node:crypto';

import type { TestCase } from '../agents/test-design/testcase-schema.js';
import type { AcceptanceCaseExecutionResult } from '../acceptance/api-processor.js';
import type { AcceptanceRequirement, RequirementFact } from '../acceptance/requirement-ir.js';
import type {
  DevTestCaseProfile,
  DevTestExpectedBehavior,
  DevTestExtendedDimension,
  DevTestInvariant,
  DevTestOracleResult,
  DevTestRequirementCoverageMatrix,
  DevTestUiExecutionResult,
} from './types.js';

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12).toUpperCase()}`;
}

function relatedFacts(requirement: AcceptanceRequirement, cases: readonly TestCase[]): RequirementFact[] {
  const ids = new Set(cases.flatMap((testCase) => testCase.source?.factIds ?? testCase.design?.factIds ?? []));
  return requirement.factLedger.filter((fact) => ids.has(fact.id));
}

function expectedStatus(cases: readonly TestCase[], facts: readonly RequirementFact[]): string | undefined {
  const statuses = cases.flatMap((testCase) => testCase.assertions
    .filter((assertion) => assertion.type === 'STATUS_CODE' && assertion.expected !== undefined)
    .map((assertion) => String(assertion.expected)));
  for (const fact of facts) if (fact.canonical.expected.status !== undefined) statuses.push(String(fact.canonical.expected.status));
  return [...new Set(statuses)].join(' / ') || undefined;
}

function hasPostStateExpectation(statement: string, facts: readonly RequirementFact[]): boolean {
  if (/(?:不能|不得|不会|未).{0,8}(?:修改|写入|变更|扣费|创建)|no\s+(?:mutation|change|charge)|unchanged/i.test(statement)) return true;
  return facts.some((fact) => fact.canonical.expected.kind === 'UNCHANGED'
    || fact.canonical.sideEffects.some((effect) => effect.action === 'UNCHANGED' || effect.action === 'ROLLBACK'));
}

function hasPostStateAssertion(cases: readonly TestCase[]): boolean {
  return cases.some((testCase) => testCase.assertions.some((assertion) =>
    assertion.type === 'DESIGN_EXPECTATION' && /state|mutation|unchanged|side.effect|状态|未修改|不变|副作用/i.test(assertion.description ?? ''))
    || ['STATE', 'SIDE_EFFECT'].includes(testCase.testType ?? ''));
}

function inputNames(cases: readonly TestCase[], facts: readonly RequirementFact[]): string[] {
  const names = facts.flatMap((fact) => fact.entityRefs.parameterNames ?? []);
  for (const testCase of cases) {
    if (testCase.parameterContext?.parameter) names.push(testCase.parameterContext.parameter);
    for (const step of testCase.steps) {
      names.push(...Object.keys(step.query ?? {}), ...Object.keys(step.body && typeof step.body === 'object' ? step.body as object : {}));
    }
  }
  return [...new Set(names)];
}

export function buildRequirementCoverageMatrix(input: {
  requirement: AcceptanceRequirement;
  testCases: readonly TestCase[];
  profiles: Record<string, DevTestCaseProfile>;
  results?: readonly AcceptanceCaseExecutionResult[];
  uiResults?: readonly DevTestUiExecutionResult[];
  oracleResults?: readonly DevTestOracleResult[];
}): DevTestRequirementCoverageMatrix {
  const resultByCase = new Map(input.results?.map((result) => [result.caseId, result]));
  const uiByCase = new Map(input.uiResults?.map((result) => [result.caseId, result]));
  const oracleByCase = new Map(input.oracleResults?.map((result) => [result.caseId, result]));
  const behaviors = input.requirement.acceptanceCriteria.map((criterion): DevTestExpectedBehavior => {
    const cases = input.testCases.filter((testCase) => testCase.source?.acceptanceCriteriaIds.includes(criterion.criterionId));
    const facts = relatedFacts(input.requirement, cases);
    const missingAssertions: string[] = [];
    const supplementalAssertions: DevTestExpectedBehavior['supplementalAssertions'] = [];
    if (hasPostStateExpectation(criterion.objective, facts) && !hasPostStateAssertion(cases)) {
      missingAssertions.push('MISSING_POST_STATE_ASSERTION');
      supplementalAssertions.push({ kind: 'NON_MUTATION', description: '拒绝/失败后资源状态必须保持不变（Non-Mutation）' });
    }
    const hasConcreteExpectation = Boolean(expectedStatus(cases, facts))
      || facts.some((fact) => fact.canonical.expected.expression || fact.canonical.sideEffects.length > 0)
      || cases.some((testCase) => testCase.assertions.some((assertion) => assertion.expected !== undefined));
    const ambiguous = !hasConcreteExpectation && (facts.some((fact) => fact.canonical.normalizationStatus !== 'COMPLETE')
      || /(?:应当正确|正常处理|符合预期|appropriate|correctly)/i.test(criterion.objective));
    const statuses = cases.map((testCase) => oracleByCase.get(testCase.id)?.verdict
      ?? uiByCase.get(testCase.id)?.status ?? resultByCase.get(testCase.id)?.status);
    const hasRuntime = input.oracleResults !== undefined || input.results !== undefined || input.uiResults !== undefined;
    // AC 的一个 Happy Path 通过不能掩盖同一验收义务下的 FAIL/BLOCKED/NOT_TESTED。
    const passed = cases.length > 0 && cases.every((testCase) => {
      const oracle = oracleByCase.get(testCase.id);
      if (input.oracleResults !== undefined) return oracle?.verdict === 'PASS' && oracle.evidence.complete;
      return (uiByCase.get(testCase.id)?.status ?? resultByCase.get(testCase.id)?.status) === 'PASS';
    });
    const blocked = missingAssertions.length > 0 || cases.every((testCase) => testCase.executionMode !== 'EXECUTABLE')
      || (hasRuntime && !passed);
    const canonical = facts.map((fact) => fact.canonical);
    return {
      acId: criterion.criterionId,
      statement: criterion.objective,
      actor: [...new Set(canonical.map((item) => item.actor?.role ?? item.actor?.kind).filter(Boolean))].join(' / ')
        || cases.map((item) => item.actor?.role ?? item.actor?.id).find(Boolean) || 'UNKNOWN',
      action: [...new Set(canonical.map((item) => item.action.operationKey ?? item.action.expression ?? item.action.kind).filter(Boolean))].join(' / ')
        || cases.flatMap((item) => item.steps.map((step) => step.method ? `${step.method} ${step.url}` : step.action)).filter(Boolean).join(' / ')
        || 'UNKNOWN',
      input: inputNames(cases, facts),
      expectedResponse: expectedStatus(cases, facts),
      expectedState: [...new Set(canonical.map((item) => item.expected.expression
        ?? (['UNCHANGED', 'STATE_CHANGED'].includes(item.expected.kind) ? item.expected.kind : undefined)).filter(Boolean))].join('；') || undefined,
      expectedSideEffects: [...new Set(canonical.flatMap((item) => item.sideEffects.map((effect) => `${effect.kind}:${effect.action}`)))],
      linkedCaseIds: cases.map((item) => item.id),
      // Acceptance Criteria 是最终验收契约；即使未生成 Case，也必须进入 Core Coverage 分母。
      core: true,
      status: !cases.length ? 'UNCOVERED' : ambiguous ? 'AMBIGUOUS' : blocked ? 'BLOCKED' : 'COVERED',
      missingAssertions,
      supplementalAssertions,
    };
  });
  const core = behaviors.filter((behavior) => behavior.core);
  return {
    behaviors,
    coveredAc: behaviors.filter((item) => item.status === 'COVERED').map((item) => item.acId),
    uncoveredAc: behaviors.filter((item) => item.status === 'UNCOVERED').map((item) => item.acId),
    ambiguousAc: behaviors.filter((item) => item.status === 'AMBIGUOUS').map((item) => item.acId),
    blockedAc: behaviors.filter((item) => item.status === 'BLOCKED').map((item) => item.acId),
    coreCoverage: core.length ? Math.round(core.filter((item) => item.status === 'COVERED').length / core.length * 100) : 0,
  };
}

function invariantOf(fact: RequirementFact): Omit<DevTestInvariant, 'id' | 'linkedCaseIds' | 'status'> | undefined {
  const text = `${fact.statement} ${fact.canonical.constraints.map((item) => item.kind).join(' ')}`;
  if (/余额.{0,6}(?:不能|不得).{0,4}(?:小于|低于)\s*0|balance.{0,8}(?:non.?negative|not.*below)/i.test(text)) {
    return { kind: 'NON_NEGATIVE', statement: fact.statement, sourceFactIds: [fact.id], requiredEvidence: ['STATE'] };
  }
  if (/tenant|租户|跨用户|其他用户|OWNER_ONLY|SCOPE_ISOLATION/i.test(text)) {
    return { kind: 'ISOLATION', statement: fact.statement, sourceFactIds: [fact.id], requiredEvidence: ['RESPONSE', 'STATE'] };
  }
  if (/重复|幂等|idempoten|只能创建一个|only create one/i.test(text)) {
    return { kind: 'IDEMPOTENCY', statement: fact.statement, sourceFactIds: [fact.id], requiredEvidence: ['RESPONSE', 'STATE'] };
  }
  if (/删除后|deleted?.*(?:not found|unavailable)|不可再访问/i.test(text)) {
    return { kind: 'DELETION', statement: fact.statement, sourceFactIds: [fact.id], requiredEvidence: ['RESPONSE', 'STATE'] };
  }
  if (hasPostStateExpectation(fact.statement, [fact])) {
    const billing = /扣费|charge|billing/i.test(text);
    return { kind: billing ? 'BILLING' : 'NON_MUTATION', statement: fact.statement, sourceFactIds: [fact.id],
      requiredEvidence: billing ? ['RESPONSE', 'SIDE_EFFECT'] : ['RESPONSE', 'STATE'] };
  }
  if (fact.canonical.constraints.some((constraint) => constraint.kind === 'STATE_TRANSITION')) {
    return { kind: 'STATE_TRANSITION', statement: fact.statement, sourceFactIds: [fact.id], requiredEvidence: ['STATE'] };
  }
  if (/审计|audit/i.test(text)) return { kind: 'AUDIT', statement: fact.statement, sourceFactIds: [fact.id], requiredEvidence: ['AUDIT'] };
  return undefined;
}

export function buildDevTestInvariants(input: {
  requirement: AcceptanceRequirement;
  testCases: readonly TestCase[];
  results?: readonly AcceptanceCaseExecutionResult[];
}): DevTestInvariant[] {
  const resultByCase = new Map(input.results?.map((result) => [result.caseId, result]));
  const invariants: DevTestInvariant[] = [];
  for (const fact of input.requirement.factLedger.filter((item) => item.normativity === 'NORMATIVE')) {
    const extracted = invariantOf(fact);
    if (!extracted) continue;
    const linked = input.testCases.filter((testCase) => (testCase.source?.factIds ?? []).includes(fact.id));
    const hasStateEvidence = linked.some((testCase) => ['STATE', 'SIDE_EFFECT', 'DATA_ISOLATION'].includes(testCase.testType ?? ''));
    const hasFailed = linked.some((testCase) => resultByCase.get(testCase.id)?.status === 'FAIL');
    const hasPass = linked.some((testCase) => resultByCase.get(testCase.id)?.status === 'PASS');
    const requiresNonResponse = extracted.requiredEvidence.some((item) => item !== 'RESPONSE');
    const status: DevTestInvariant['status'] = hasFailed ? 'FAILED'
      : hasPass && (!requiresNonResponse || hasStateEvidence) ? 'VERIFIED'
        : input.results ? 'BLOCKED' : 'DESIGNED';
    invariants.push({ ...extracted, id: stableId('INV', { fact: fact.id, kind: extracted.kind }),
      linkedCaseIds: linked.map((item) => item.id), status });
  }
  return invariants.filter((item, index, all) => all.findIndex((candidate) => candidate.kind === item.kind
    && candidate.statement === item.statement) === index);
}

export function extendedDimensionsOf(requirement: AcceptanceRequirement, invariants: readonly DevTestInvariant[], testCases: readonly TestCase[]): Array<{
  dimension: DevTestExtendedDimension; applicable: boolean; reason: string; caseIds: string[];
}> {
  const text = requirement.factLedger.map((fact) => fact.statement).join(' ');
  const rules: Array<[DevTestExtendedDimension, RegExp, DevTestInvariant['kind'][]]> = [
    ['IDEMPOTENCY', /幂等|重复提交|idempoten/i, ['IDEMPOTENCY']],
    ['STATE_MACHINE', /状态机|状态迁移|state transition/i, ['STATE_TRANSITION']],
    ['BILLING', /扣费|计费|余额|billing|charge/i, ['BILLING', 'NON_NEGATIVE']],
    ['PROVIDER', /provider|供应商|第三方生成|外部服务/i, []],
    ['AUDIT', /审计|audit/i, ['AUDIT']],
  ];
  return rules.map(([dimension, pattern, kinds]) => {
    const sourceFacts = new Set(invariants.filter((item) => kinds.includes(item.kind)).flatMap((item) => item.sourceFactIds));
    const applicable = pattern.test(text) || sourceFacts.size > 0;
    return { dimension, applicable,
      reason: applicable ? 'Requirement/Risk 或业务不变量明确要求' : 'Requirement/Risk 未表明需要；不生成模板 Case',
      caseIds: applicable ? testCases.filter((testCase) => (testCase.source?.factIds ?? []).some((id) => sourceFacts.has(id))).map((item) => item.id) : [] };
  });
}
