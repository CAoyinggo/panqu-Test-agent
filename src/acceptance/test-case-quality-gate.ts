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

export type TestCaseQualityIssueCode =
  | 'SOURCE_FACT_MISSING'
  | 'SOURCE_OBJECTIVE_MISSING'
  | 'EXPECTED_OUTCOME_UNKNOWN'
  | 'EXECUTION_CONTRACT_INCOMPLETE'
  | 'ACTOR_CONTEXT_MISSING'
  | 'TARGET_CONTEXT_MISSING'
  | 'EXECUTOR_UNAVAILABLE'
  | 'HEURISTIC_EXECUTION_FORBIDDEN'
  | 'DUPLICATE_SEMANTICS';

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
}

export interface TestCaseQualityGateResult {
  testCases: TestCase[];
  assessments: TestCaseQualityAssessment[];
  generatedCount: number;
  deduplicatedCount: number;
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
    type: 'DESIGN_EXPECTATION',
    expected: testCase.design?.expectedOutcome ?? testCase.expected?.description ?? reason,
    description: reason,
    severity: testCase.priority === 'P3' ? 'P2' : testCase.priority,
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
  testCase.steps = [];
  testCase.assertions = [designAssertion(testCase, reason)];
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
  const objectiveById = new Map(input.objectives.map((objective) => [objective.id, objective]));
  const assessments: TestCaseQualityAssessment[] = [];

  for (const testCase of deduplicated.cases) {
    const issues: TestCaseQualityIssue[] = [];
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
    const dimensions = dimensionsFor(testCase, objectiveById);
    const expectedOutcomeKnown = hasKnownExpected(testCase, linkedObjectives);
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
    assessments.push({
      caseId: testCase.id,
      status,
      issues,
      traceable: !issues.some((issue) => issue.code === 'SOURCE_FACT_MISSING' || issue.code === 'SOURCE_OBJECTIVE_MISSING'),
      expectedOutcomeKnown,
      executable: status === 'READY',
    });
  }

  assignStableAcceptanceCaseIds(deduplicated.cases);
  for (let index = 0; index < assessments.length; index++) assessments[index].caseId = deduplicated.cases[index].id;
  return {
    testCases: deduplicated.cases,
    assessments,
    generatedCount,
    deduplicatedCount: deduplicated.count,
  };
}
