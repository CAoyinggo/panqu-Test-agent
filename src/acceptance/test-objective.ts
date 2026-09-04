import { createHash } from 'node:crypto';
import type { TestCase, TestCaseSourceType, TestProvenance } from '../agents/test-design/testcase-schema.js';
import type {
  AcceptanceRequirement,
  CanonicalRequirementFact,
  RequirementFact,
  RequirementFactProvenance,
  RequirementSource,
} from './requirement-ir.js';
import {
  buildFactTestStrategy,
  type TestStrategyDecision,
  type TestStrategyKind,
} from './test-strategy-engine.js';
import { buildBusinessModelProjection, businessFlowForFacts, type BusinessModelProjection } from './business-model.js';
import {
  buildBusinessScenarioCandidates,
  buildBusinessUnderstanding,
  buildRiskDrivenTestStrategy,
  businessGoalForFact,
  type BusinessScenarioCandidate,
  type BusinessUnderstanding,
  type RiskDrivenTestStrategy,
} from './test-design-intelligence.js';

export type TestDimension =
  | 'UI'
  | 'FUNCTIONAL'
  | 'API'
  | 'PARAMETER_VALIDATION'
  | 'AUTH'
  | 'PERMISSION'
  | 'DATA_ISOLATION'
  | 'BUSINESS_RULE'
  | 'STATE'
  | 'ERROR'
  | 'BOUNDARY'
  | 'SECURITY'
  | 'COMPATIBILITY'
  | 'PERFORMANCE'
  | 'SIDE_EFFECT'
  | 'CLEANUP';

export const TEST_DIMENSIONS: readonly TestDimension[] = [
  'UI', 'FUNCTIONAL', 'API', 'PARAMETER_VALIDATION', 'AUTH', 'PERMISSION',
  'DATA_ISOLATION', 'BUSINESS_RULE', 'STATE', 'ERROR', 'BOUNDARY', 'SECURITY',
  'COMPATIBILITY', 'PERFORMANCE', 'SIDE_EFFECT', 'CLEANUP',
];

export type TestDimensionApplicability = 'REQUIRED' | 'OPTIONAL' | 'NOT_APPLICABLE' | 'UNKNOWN';

export interface TestDimensionDecision {
  factId: string;
  dimension: TestDimension;
  applicability: TestDimensionApplicability;
  reason: string;
}

export interface TestObjective {
  id: string;
  requirementId: string;
  factIds: string[];
  dimension: TestDimension;
  scenario: string;
  expectedOutcome: string;
  outcomeStatus: 'KNOWN' | 'UNKNOWN';
  sourceType: TestCaseSourceType;
  provenance: RequirementFactProvenance;
  priority: 'P0' | 'P1' | 'P2';
  risk?: string;
  source: RequirementSource;
  apiSpecIds: string[];
  parameterNames: string[];
  executionTarget: 'API' | 'UI' | 'FUNCTIONAL' | 'DATA' | 'HYBRID';
  /** 由集中 Test Strategy Policy 产生，Generator 不再从 scenario 重判业务策略。 */
  strategyIds: string[];
  strategies: TestStrategyKind[];
  canonicalFact: CanonicalRequirementFact;
  scenarioId?: string;
}

export interface TestScenarioAction {
  channel: 'UI' | 'API' | 'FUNCTIONAL' | 'DATA';
  description: string;
  factIds: string[];
  apiSpecId?: string;
}

export interface TestScenario {
  id: string;
  title: string;
  kind: 'SINGLE' | 'HYBRID';
  factIds: string[];
  objectiveIds: string[];
  actions: TestScenarioAction[];
  expectedOutcomes: string[];
  executionMode: 'EXECUTABLE' | 'DESIGNED_ONLY';
}

export interface AcceptanceTestDesign {
  businessModel: BusinessModelProjection;
  businessUnderstanding: BusinessUnderstanding;
  testStrategy: RiskDrivenTestStrategy;
  dimensionDecisions: TestDimensionDecision[];
  objectives: TestObjective[];
  scenarioCandidates: BusinessScenarioCandidate[];
  scenarioDeduplicatedCount: number;
  scenarios: TestScenario[];
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12).toUpperCase()}`;
}

function refs(fact: RequirementFact): { apiSpecIds: string[]; parameterNames: string[] } {
  const entityRefs = fact.entityRefs as { apiSpecIds?: string[]; parameterNames?: string[] } | undefined;
  return {
    apiSpecIds: [...new Set(entityRefs?.apiSpecIds ?? [])],
    parameterNames: [...new Set(entityRefs?.parameterNames ?? [])],
  };
}

function resolveApiContext(
  requirement: AcceptanceRequirement,
  fact: RequirementFact,
): { apiSpecIds: string[]; parameterNames: string[] } {
  const related = refs(fact);
  const explicitOperation = fact.canonical.action.operationKey;
  const explicitOperationMatchesContract = explicitOperation
    ? requirement.apis.some((api) => api.operationKey === explicitOperation)
    : true;
  const explicitlyNonHttpEvidence = fact.category === 'UI' || fact.canonical.resource.kind === 'DATABASE';
  // A single configured API is useful context only when the requirement did not
  // explicitly name a different operation. Never turn a mismatched contract into
  // an apparently bound executable objective through the single-API fallback.
  if (explicitOperation && !explicitOperationMatchesContract) {
    // EntityRefs may point to a same-named Parameter on another operation.
    // An explicit Method+Path always wins; retain no stale ApiSpec binding so
    // the standard binding policy can emit API_NOT_FOUND fail-closed.
    related.apiSpecIds = [];
  }
  if (!related.apiSpecIds.length
    && requirement.apis.length === 1
    && !explicitlyNonHttpEvidence
    && explicitOperationMatchesContract) {
    related.apiSpecIds = [requirement.apis[0].id];
  }
  return related;
}

function makeObjective(
  requirement: AcceptanceRequirement,
  businessModel: BusinessModelProjection,
  fact: RequirementFact,
  strategy: TestStrategyDecision,
  related: { apiSpecIds: string[]; parameterNames: string[] },
): TestObjective {
  // 纯 Contract Operation 没有用户目标时保留契约语义，不能伪造 Actor/Goal。
  const businessGoal = fact.provenance === 'CONTRACT' && fact.category === 'API'
    ? fact.statement : businessGoalForFact(fact, businessModel);
  // 保留原始 Fact statement 作为生成期上下文，避免业务目标替代 Requirement trace。
  const scenario = businessGoal === fact.statement ? fact.statement : `${businessGoal}；需求依据：${fact.statement}`;
  const value = {
    factId: fact.id, dimension: strategy.dimension, scenario,
    sourceType: strategy.sourceType, strategyIds: strategy.policyRuleIds,
  };
  return {
    id: stableId('OBJ', value),
    requirementId: requirement.id,
    factIds: [fact.id],
    dimension: strategy.dimension,
    scenario,
    expectedOutcome: strategy.expectedOutcome,
    outcomeStatus: strategy.outcomeStatus,
    sourceType: strategy.sourceType,
    provenance: strategy.provenance,
    priority: strategy.priority,
    risk: strategy.risk,
    source: fact.source,
    apiSpecIds: related.apiSpecIds,
    parameterNames: related.parameterNames,
    executionTarget: strategy.executionTarget,
    strategyIds: strategy.policyRuleIds,
    strategies: strategy.strategies,
    canonicalFact: strategy.canonical,
  };
}

function scenarioAction(objective: TestObjective): TestScenarioAction {
  const channel: TestScenarioAction['channel'] = objective.dimension === 'UI' ? 'UI'
    : objective.executionTarget === 'API' ? 'API'
      : objective.executionTarget === 'DATA' ? 'DATA' : 'FUNCTIONAL';
  return {
    channel,
    description: objective.scenario,
    factIds: objective.factIds,
    apiSpecId: objective.apiSpecIds.length === 1 ? objective.apiSpecIds[0] : undefined,
  };
}

function buildScenarios(
  objectives: TestObjective[],
  businessModel: BusinessModelProjection,
  candidates: BusinessScenarioCandidate[],
): TestScenario[] {
  const scenarios: TestScenario[] = [];
  for (const candidate of candidates) {
    const objectiveIds = new Set(candidate.objectiveIds);
    const group = objectives.filter((objective) => objectiveIds.has(objective.id));
    if (!group.length) continue;
    const channels = new Set(group.map((objective) => scenarioAction(objective).channel));
    const isHybrid = channels.has('UI') && (channels.has('API') || channels.has('DATA') || channels.has('FUNCTIONAL'));
    const id = stableId('SCN', { candidateId: candidate.id, objectiveIds: group.map((item) => item.id).sort() });
    const businessFlow = businessFlowForFacts(businessModel, candidate.factIds);
    const scenario: TestScenario = {
      id,
      title: candidate.title,
      kind: isHybrid || candidate.factIds.length > 1 || (businessFlow?.steps.length ?? 0) > 1 ? 'HYBRID' : 'SINGLE',
      factIds: candidate.factIds,
      objectiveIds: group.map((item) => item.id),
      actions: group.map(scenarioAction),
      expectedOutcomes: [...new Set(group.map((item) => item.expectedOutcome))],
      executionMode: candidate.status === 'READY_FOR_CASE'
        && group.every((item) => item.executionTarget === 'API' && item.outcomeStatus === 'KNOWN') ? 'EXECUTABLE' : 'DESIGNED_ONLY',
    };
    for (const objective of group) objective.scenarioId = id;
    scenarios.push(scenario);
  }

  const allChannels = new Set(objectives.map((objective) => scenarioAction(objective).channel));
  const explicitHybrid = allChannels.has('UI') && allChannels.has('API')
    && objectives.some((objective) => ['BUSINESS_RULE', 'STATE', 'SIDE_EFFECT'].includes(objective.dimension));
  if (explicitHybrid && objectives.length > 1) {
    const ordered = [...objectives].sort((a, b) => (a.source.line ?? 0) - (b.source.line ?? 0));
    scenarios.push({
      id: stableId('SCN', { kind: 'HYBRID', objectives: ordered.map((item) => item.id) }),
      title: '跨 UI / API / Data 的开发验收场景',
      kind: 'HYBRID',
      factIds: [...new Set(ordered.flatMap((item) => item.factIds))],
      objectiveIds: ordered.map((item) => item.id),
      actions: ordered.map(scenarioAction),
      expectedOutcomes: [...new Set(ordered.map((item) => item.expectedOutcome))],
      executionMode: 'DESIGNED_ONLY',
    });
  }
  return scenarios;
}

function normalizedObjectiveScenario(value: string): string {
  return value
    .replace(/^\s*AC-\d+\s*[:：-]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 合并相同验证语义的 Objective，同时保留所有来源 Fact 的闭环关系。 */
function deduplicateObjectives(input: TestObjective[]): TestObjective[] {
  const output: TestObjective[] = [];
  const byKey = new Map<string, TestObjective>();
  for (const objective of input) {
    const key = JSON.stringify({
      dimension: objective.dimension,
      scenario: normalizedObjectiveScenario(objective.scenario),
      expectedOutcome: objective.expectedOutcome,
      outcomeStatus: objective.outcomeStatus,
      sourceType: objective.sourceType,
      executionTarget: objective.executionTarget,
      apiSpecIds: [...objective.apiSpecIds].sort(),
      parameterNames: [...objective.parameterNames].sort(),
    });
    const existing = byKey.get(key);
    if (!existing) {
      objective.id = stableId('OBJ', key);
      byKey.set(key, objective);
      output.push(objective);
      continue;
    }
    existing.factIds = [...new Set([...existing.factIds, ...objective.factIds])];
    existing.apiSpecIds = [...new Set([...existing.apiSpecIds, ...objective.apiSpecIds])];
    existing.parameterNames = [...new Set([...existing.parameterNames, ...objective.parameterNames])];
    existing.strategyIds = [...new Set([...existing.strategyIds, ...objective.strategyIds])];
    existing.strategies = [...new Set([...existing.strategies, ...objective.strategies])];
  }
  return output;
}

/** Canonical Fact Ledger → Dimension Matrix → Test Objective → Scenario。 */
export function buildAcceptanceTestDesign(requirement: AcceptanceRequirement): AcceptanceTestDesign {
  const businessModel = buildBusinessModelProjection(requirement);
  const dimensionDecisions: TestDimensionDecision[] = [];
  const objectives: TestObjective[] = [];
  for (const fact of requirement.factLedger) {
    fact.linkedObjectiveIds = [];
    if (fact.normativity === 'NON_NORMATIVE' || fact.status === 'NON_NORMATIVE') continue;
    // 冲突 Fact 只能留在 Ledger 中等待澄清；禁止选择性采用其中一个版本生成 Case。
    if (fact.status === 'BLOCKED') continue;
    if (fact.provenance === 'CONFIGURED' && fact.entityRefs.items.every((ref) => ref.type === 'ACTOR')) {
      fact.normativity = 'NON_NORMATIVE';
      fact.status = 'NON_NORMATIVE';
      fact.statusReason = 'Actor 表提供执行配置，不独立声明可判定业务结果';
      continue;
    }
    const related = resolveApiContext(requirement, fact);
    const plan = buildFactTestStrategy(fact, related.apiSpecIds);
    const required = new Set(plan.decisions.map((decision) => decision.dimension));
    const optional = new Set(plan.optionalDimensions);
    for (const dimension of TEST_DIMENSIONS) {
      const applicability: TestDimensionApplicability = required.has(dimension) ? 'REQUIRED'
        : optional.has(dimension) ? 'OPTIONAL' : required.size ? 'NOT_APPLICABLE' : 'UNKNOWN';
      dimensionDecisions.push({
        factId: fact.id,
        dimension,
        applicability,
        reason: applicability === 'REQUIRED'
          ? `由 Test Strategy Policy ${plan.decisions.find((decision) => decision.dimension === dimension)?.policyRuleIds.join(', ') ?? ''} 激活`
          : applicability === 'OPTIONAL' ? '标准测试启发式；不计入需求覆盖'
            : applicability === 'UNKNOWN' ? '缺少足够结构化信息，禁止猜测测试维度'
              : '该 Fact 没有触发此维度',
      });
    }
    for (const strategy of plan.decisions) objectives.push(makeObjective(requirement, businessModel, fact, strategy, related));
    fact.status = required.size ? 'CONSUMED' : 'UNVERIFIED';
    fact.statusReason = required.size ? undefined : '无法从规范性语句确定可靠测试维度';
  }
  const deduplicated = deduplicateObjectives(objectives);
  for (const fact of requirement.factLedger) {
    fact.linkedObjectiveIds = deduplicated.filter((item) => item.factIds.includes(fact.id)).map((item) => item.id);
  }
  const businessUnderstanding = buildBusinessUnderstanding(requirement, businessModel);
  const testStrategy = buildRiskDrivenTestStrategy(requirement, businessModel, deduplicated);
  const scenarioDesign = buildBusinessScenarioCandidates(requirement, businessModel, deduplicated);
  return {
    businessModel,
    businessUnderstanding,
    testStrategy,
    dimensionDecisions,
    objectives: deduplicated,
    scenarioCandidates: scenarioDesign.scenarios,
    scenarioDeduplicatedCount: scenarioDesign.deduplicatedCount,
    scenarios: buildScenarios(deduplicated, businessModel, scenarioDesign.scenarios),
  };
}

/**
 * Case 生成后收敛 Fact disposition。CONSUMED 必须真的闭合到 Case 与 Assertion；
 * 只有启发式 Objective 不能让需求 Fact 看起来已覆盖。
 */
export function finalizeRequirementFactLedger(
  requirement: AcceptanceRequirement,
  objectives: TestObjective[],
  testCases: TestCase[],
): void {
  for (const fact of requirement.factLedger) {
    if (fact.normativity === 'NON_NORMATIVE') {
      fact.status = 'NON_NORMATIVE';
      continue;
    }
    if (fact.status === 'BLOCKED') continue;
    const requiredObjectives = objectives.filter((objective) => objective.sourceType !== 'HEURISTIC' && objective.factIds.includes(fact.id));
    if (!requiredObjectives.length) {
      fact.status = 'UNVERIFIED';
      fact.statusReason ??= '没有可靠的 Requirement-derived Test Objective';
      continue;
    }
    const requiredIds = new Set(requiredObjectives.map((objective) => objective.id));
    const linkedCases = testCases.filter((testCase) => testCase.source?.objectiveIds?.some((id) => requiredIds.has(id)));
    const asserted = new Set(linkedCases.flatMap((testCase) => testCase.assertions
      .filter((assertion) => assertion.factIds?.includes(fact.id))
      .flatMap((assertion) => assertion.objectiveIds ?? (assertion.objectiveId ? [assertion.objectiveId] : []))
      .filter((id): id is string => Boolean(id))));
    const unknownOutcome = requiredObjectives.some((objective) => objective.outcomeStatus === 'UNKNOWN');
    const onlyDesigned = linkedCases.length > 0 && linkedCases.every((testCase) => testCase.executionMode !== 'EXECUTABLE');
    if (!linkedCases.length || requiredObjectives.some((objective) => !asserted.has(objective.id)) || unknownOutcome || onlyDesigned) {
      fact.status = 'UNVERIFIED';
      fact.statusReason = unknownOutcome
        ? '需求未给出可靠预期结果，已保留测试设计但不能形成可判定断言'
        : onlyDesigned ? 'Test Objective 已形成设计，但当前只有 DESIGNED_ONLY Case，不能声明需求已消费为可执行验证'
        : !linkedCases.length ? 'Test Objective 没有生成 Test Case' : 'Test Case 没有闭合到 Fact-aware Assertion';
    } else {
      fact.status = 'CONSUMED';
      fact.statusReason = undefined;
    }
  }
}

export function toTestProvenance(value: RequirementFactProvenance): TestProvenance {
  return value;
}
