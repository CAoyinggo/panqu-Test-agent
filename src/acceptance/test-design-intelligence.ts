import { createHash } from 'node:crypto';
import type { TestCase } from '../agents/test-design/testcase-schema.js';
import type { BusinessModelProjection, BusinessStateProjection } from './business-model.js';
import type { AcceptanceRequirement, RequirementFact } from './requirement-ir.js';
import type { TestDimension, TestObjective } from './test-objective.js';

export type TestDesignOrigin = 'REQUIREMENT_DERIVED' | 'RULE_DERIVED' | 'RISK_DERIVED' | 'EXPLORATORY';
export type IntelligenceStatus = 'KNOWN' | 'UNKNOWN' | 'NEED_CONFIRMATION';

export interface BusinessUnderstandingAnswer {
  factIds: string[];
  actor: string;
  role: string;
  resource: string;
  owner: string;
  tenant: string;
  project: string;
  state: string;
  action: string;
  rules: string[];
  expectedResult: string;
  sideEffects: string[];
  status: IntelligenceStatus;
  unknowns: string[];
}

export interface BusinessUnderstandingUnknown {
  id: string;
  status: 'UNKNOWN' | 'NEED_CONFIRMATION';
  question: string;
  factIds: string[];
}

export interface BusinessStateGraph {
  nodes: string[];
  transitions: Array<{
    id: string;
    resourceId?: string;
    from: string;
    action: string;
    to: string;
    factIds: string[];
    status: IntelligenceStatus;
  }>;
}

export interface BusinessDataRelationship {
  id: string;
  kind: 'OWNERSHIP' | 'SCOPE' | 'DEPENDENCY' | 'SIDE_EFFECT';
  from: string;
  to: string;
  relation: string;
  factIds: string[];
}

export interface BusinessUnderstanding {
  requirementId: string;
  answers: BusinessUnderstandingAnswer[];
  stateGraph: BusinessStateGraph;
  dataRelationships: BusinessDataRelationship[];
  unknowns: BusinessUnderstandingUnknown[];
}

export type TestStrategyArea =
  | 'CORE_BUSINESS_FLOW'
  | 'HIGH_RISK_FLOW'
  | 'NEGATIVE_BUSINESS_FLOW'
  | 'STATE_RISK'
  | 'PERMISSION_RISK'
  | 'DATA_ISOLATION_RISK'
  | 'CONCURRENCY_RISK'
  | 'IDEMPOTENCY_RISK'
  | 'SIDE_EFFECT_RISK'
  | 'RECOVERY_RISK';

export interface RiskDrivenStrategyDecision {
  id: string;
  area: TestStrategyArea;
  applicability: 'REQUIRED' | 'NOT_APPLICABLE' | 'NEED_CONFIRMATION';
  priority: 'P0' | 'P1' | 'P2';
  reason: string;
  factIds: string[];
  riskIds: string[];
  dimensions: TestDimension[];
}

export interface RiskDrivenTestStrategy {
  requirementId: string;
  decisions: RiskDrivenStrategyDecision[];
  selectedDimensions: TestDimension[];
}

export type BusinessScenarioCandidateKind =
  | 'CORE_FLOW'
  | 'NEGATIVE_FLOW'
  | 'STATE_CONFLICT'
  | 'PERMISSION_CONFLICT'
  | 'OWNERSHIP_CONFLICT'
  | 'CROSS_SCOPE_ACCESS'
  | 'DUPLICATE_OPERATION'
  | 'CONCURRENT_OPERATION'
  | 'FAILURE_RECOVERY'
  | 'DATA_CONSISTENCY'
  | 'SIDE_EFFECT';

export interface BusinessScenarioCandidate {
  id: string;
  title: string;
  goal: string;
  kind: BusinessScenarioCandidateKind;
  origin: TestDesignOrigin;
  status: 'READY_FOR_CASE' | 'NEED_CONFIRMATION';
  priority: 'P0' | 'P1' | 'P2';
  factIds: string[];
  objectiveIds: string[];
  riskIds: string[];
  dimensions: TestDimension[];
  actorIds: string[];
  resourceIds: string[];
  state?: { from?: string; to?: string };
  primaryConclusion: string;
  semanticKey: string;
}

export interface TestDesignCoverageItem {
  required: number;
  covered: number;
  missingIds: string[];
}

export interface TestDesignReview {
  requirementCoverage: TestDesignCoverageItem;
  coreBusinessFlowCoverage: TestDesignCoverageItem;
  riskCoverage: TestDesignCoverageItem;
  negativeCoverage: TestDesignCoverageItem;
  stateCoverage: TestDesignCoverageItem;
  permissionCoverage: TestDesignCoverageItem;
  isolationCoverage: TestDesignCoverageItem;
  sideEffectCoverage: TestDesignCoverageItem;
  executableRate: number;
  oracleCompleteness: number;
  evidenceCompleteness: number;
  unknownHandling: { total: number; safelyBlocked: number; violations: string[] };
  semanticDuplicateCaseIds: string[];
  businessDuplicateCaseIds: string[];
  missingHighValueScenarioIds: string[];
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12).toUpperCase()}`;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function factsFor(model: BusinessModelProjection, factIds: readonly string[]) {
  return {
    actors: model.actors.filter((item) => item.factIds.some((id) => factIds.includes(id))),
    resources: model.resources.filter((item) => item.factIds.some((id) => factIds.includes(id))),
    ownerships: model.ownerships.filter((item) => item.factIds.some((id) => factIds.includes(id))),
    states: model.states.filter((item) => item.factIds.some((id) => factIds.includes(id))),
    rules: model.rules.filter((item) => item.factIds.some((id) => factIds.includes(id))),
  };
}

function actionLabel(fact: RequirementFact): string {
  const labels: Record<string, string> = {
    CREATE: '创建', READ: '查看', UPDATE: '修改', DELETE: '删除', SUBMIT: '提交',
    VALIDATE: '验证', TRANSITION: '完成状态流转', DISPLAY: '查看展示结果', NOTIFY: '触发通知',
    CHARGE: '完成扣款', ROLLBACK: '执行恢复', CLEANUP: '清理', ACCESS: '访问', UNKNOWN: '执行 UNKNOWN 操作',
  };
  return labels[fact.canonical.action.kind] ?? fact.canonical.action.kind;
}

/** 将 canonical 业务关系表达为用户目标；原始 statement 仍保留在 Fact/Expected trace 中。 */
export function businessGoalForFact(fact: RequirementFact, model: BusinessModelProjection): string {
  const projected = factsFor(model, [fact.id]);
  const actor = projected.actors[0];
  const state = projected.states[0];
  const actorLabel = actor?.name || actor?.role || fact.canonical.actor?.role
    || (fact.canonical.actor?.kind && fact.canonical.actor.kind !== 'UNKNOWN'
      ? fact.canonical.actor.kind : 'UNKNOWN Actor');
  const resource = projected.resources[0]?.type
    ?? (fact.canonical.resource.kind !== 'UNKNOWN' ? fact.canonical.resource.kind : 'UNKNOWN Resource');
  const stateLabel = state?.from ? `处于 ${state.from} 状态的 ` : '';
  return `${actorLabel}对${stateLabel}${resource}${actionLabel(fact)}`;
}

export function buildBusinessUnderstanding(
  requirement: AcceptanceRequirement,
  model: BusinessModelProjection,
): BusinessUnderstanding {
  const unknowns: BusinessUnderstandingUnknown[] = [];
  const answers = requirement.factLedger
    .filter((fact) => fact.normativity === 'NORMATIVE')
    .map((fact): BusinessUnderstandingAnswer => {
      const projected = factsFor(model, [fact.id]);
      const actor = projected.actors[0];
      const ownership = projected.ownerships[0];
      const owner = model.actors.find((item) => item.id === ownership?.ownerActorId);
      const state = projected.states[0];
      const missing = [...fact.canonical.unresolved];
      if (!actor && (!fact.canonical.actor || fact.canonical.actor.kind === 'UNKNOWN')) missing.push('ACTOR_UNKNOWN');
      if (fact.canonical.resource.kind === 'UNKNOWN') missing.push('RESOURCE_UNKNOWN');
      if (fact.canonical.action.kind === 'UNKNOWN') missing.push('ACTION_UNKNOWN');
      if (fact.canonical.expected.kind === 'UNKNOWN') missing.push('EXPECTED_RESULT_UNKNOWN');
      const normalizedMissing = unique(missing);
      for (const item of normalizedMissing) unknowns.push({
        id: stableId('UNKNOWN', { factId: fact.id, item }),
        status: fact.epistemicType === 'FACT' ? 'NEED_CONFIRMATION' : 'UNKNOWN',
        question: `${fact.id} 需要确认 ${item}`,
        factIds: [fact.id],
      });
      return {
        factIds: [fact.id],
        actor: actor?.id ?? fact.canonical.actor?.id ?? fact.canonical.actor?.role ?? 'UNKNOWN',
        role: actor?.role ?? fact.canonical.actor?.role ?? 'UNKNOWN',
        resource: projected.resources[0]?.type ?? fact.canonical.resource.kind,
        owner: owner?.id ?? ownership?.ownerActorId ?? 'UNKNOWN',
        tenant: ownership?.tenantId ?? actor?.tenantId ?? 'UNKNOWN',
        project: ownership?.projectId ?? actor?.projectId ?? 'UNKNOWN',
        state: state ? `${state.from ?? 'UNKNOWN'} --${state.action}--> ${state.to ?? 'UNKNOWN'}` : 'UNKNOWN',
        action: fact.canonical.action.kind,
        rules: projected.rules.map((item) => item.description),
        expectedResult: fact.canonical.expected.expression ?? fact.statement,
        sideEffects: fact.canonical.sideEffects.map((item) => item.expression),
        status: normalizedMissing.length ? 'NEED_CONFIRMATION' : 'KNOWN',
        unknowns: normalizedMissing,
      };
    });

  const transitions = model.states.map((state) => ({
    id: state.id,
    resourceId: state.resourceId,
    from: state.from ?? 'UNKNOWN',
    action: state.action,
    to: state.to ?? 'UNKNOWN',
    factIds: [...state.factIds],
    status: state.from && state.to ? 'KNOWN' as const : 'NEED_CONFIRMATION' as const,
  }));
  const dataRelationships: BusinessDataRelationship[] = [
    ...model.ownerships.map((item) => ({
      id: item.id, kind: 'OWNERSHIP' as const, from: item.ownerActorId ?? 'UNKNOWN_OWNER', to: item.resourceId,
      relation: item.relation, factIds: [...item.factIds],
    })),
    ...model.ownerships.flatMap((item) => item.scopes.map((scope) => ({
      id: stableId('REL', { ownership: item.id, scope }), kind: 'SCOPE' as const,
      from: item.subjectActorId ?? 'UNKNOWN_SUBJECT', to: item.resourceId,
      relation: `${scope.dimension}:${scope.relation}`, factIds: [...item.factIds],
    }))),
    ...model.dependencies.map((item) => ({
      id: item.id, kind: 'DEPENDENCY' as const, from: item.resourceId ?? 'BUSINESS_FLOW', to: item.description,
      relation: item.kind, factIds: [...item.factIds],
    })),
    ...requirement.factLedger.flatMap((fact) => fact.canonical.sideEffects.map((effect) => ({
      id: stableId('REL', { fact: fact.id, effect: effect.expression }), kind: 'SIDE_EFFECT' as const,
      from: fact.canonical.resource.kind, to: effect.kind, relation: effect.action, factIds: [fact.id],
    }))),
  ];
  return {
    requirementId: requirement.id,
    answers,
    stateGraph: {
      nodes: unique(transitions.flatMap((item) => [item.from, item.to])).filter((item) => item !== 'UNKNOWN'),
      transitions,
    },
    dataRelationships,
    unknowns: [...new Map(unknowns.map((item) => [item.id, item])).values()],
  };
}

function factIdsMatching(requirement: AcceptanceRequirement, predicate: (fact: RequirementFact) => boolean): string[] {
  return requirement.factLedger.filter((fact) => fact.normativity === 'NORMATIVE' && predicate(fact)).map((fact) => fact.id);
}

export function buildRiskDrivenTestStrategy(
  requirement: AcceptanceRequirement,
  model: BusinessModelProjection,
  objectives: TestObjective[],
): RiskDrivenTestStrategy {
  const objectiveFactIds = new Set(objectives.flatMap((objective) => objective.factIds));
  const relevantRisks = model.risks.filter((risk) => risk.factIds.some((id) => objectiveFactIds.has(id)));
  const constraintFacts = (kind: string): string[] => factIdsMatching(requirement,
    (fact) => fact.canonical.constraints.some((constraint) => constraint.kind === kind));
  const objectiveFacts = (dimension: TestDimension): string[] => unique(objectives
    .filter((objective) => objective.dimension === dimension).flatMap((objective) => objective.factIds));
  const negativeFacts = factIdsMatching(requirement, (fact) =>
    ['DENY', 'FAILURE', 'NOT_FOUND', 'UNCHANGED', 'INVALID'].includes(fact.canonical.expected.kind)
    || Boolean(fact.canonical.expected.status && fact.canonical.expected.status >= 400));
  const coreFacts = unique(objectives.filter((objective) => ['FUNCTIONAL', 'API'].includes(objective.dimension)
    && objective.outcomeStatus === 'KNOWN').flatMap((objective) => objective.factIds));
  const specs: Array<{
    area: TestStrategyArea; priority: 'P0' | 'P1' | 'P2'; factIds: string[]; riskIds: string[];
    dimensions: TestDimension[]; confirmationWhenAbsent?: boolean; reason: string;
  }> = [
    { area: 'CORE_BUSINESS_FLOW', priority: 'P0', factIds: coreFacts, riskIds: [], dimensions: ['FUNCTIONAL', 'API'], reason: '覆盖 Requirement 明确的核心用户目标与业务结果' },
    { area: 'HIGH_RISK_FLOW', priority: 'P0', factIds: unique(relevantRisks.flatMap((risk) => risk.factIds)), riskIds: relevantRisks.map((risk) => risk.id), dimensions: unique(relevantRisks.flatMap((risk) => risk.category === 'SECURITY' ? ['PERMISSION', 'DATA_ISOLATION'] : risk.category === 'DATA_INTEGRITY' ? ['STATE', 'BUSINESS_RULE'] : ['BUSINESS_RULE'])) as TestDimension[], reason: '由 Business Model 中 P0/P1 风险决定范围' },
    { area: 'NEGATIVE_BUSINESS_FLOW', priority: 'P1', factIds: negativeFacts, riskIds: [], dimensions: ['ERROR'], confirmationWhenAbsent: coreFacts.length > 0, reason: '只覆盖需求明确的拒绝、失败、不变或错误结果' },
    { area: 'STATE_RISK', priority: 'P0', factIds: unique([...model.states.flatMap((state) => state.factIds), ...objectiveFacts('STATE')]), riskIds: relevantRisks.filter((risk) => risk.category === 'DATA_INTEGRITY').map((risk) => risk.id), dimensions: ['STATE'], reason: '验证 State Graph 中声明的状态与流转' },
    { area: 'PERMISSION_RISK', priority: 'P0', factIds: unique([...model.rules.filter((rule) => rule.kind === 'PERMISSION').flatMap((rule) => rule.factIds), ...objectiveFacts('PERMISSION')]), riskIds: relevantRisks.filter((risk) => risk.category === 'SECURITY').map((risk) => risk.id), dimensions: ['PERMISSION'], reason: '验证显式 Actor × Role × Resource × Operation 规则' },
    { area: 'DATA_ISOLATION_RISK', priority: 'P0', factIds: unique([...model.rules.filter((rule) => rule.kind === 'ISOLATION').flatMap((rule) => rule.factIds), ...objectiveFacts('DATA_ISOLATION')]), riskIds: relevantRisks.filter((risk) => risk.category === 'SECURITY').map((risk) => risk.id), dimensions: ['DATA_ISOLATION'], reason: '验证显式 Owner/Tenant/Project 数据范围' },
    { area: 'CONCURRENCY_RISK', priority: 'P1', factIds: constraintFacts('CONCURRENCY'), riskIds: relevantRisks.filter((risk) => risk.category === 'CONCURRENCY').map((risk) => risk.id), dimensions: ['BUSINESS_RULE'], reason: '并发仅在 Requirement 声明冲突或一致性规则时进入范围' },
    { area: 'IDEMPOTENCY_RISK', priority: 'P1', factIds: constraintFacts('IDEMPOTENT'), riskIds: relevantRisks.filter((risk) => risk.category === 'DATA_INTEGRITY').map((risk) => risk.id), dimensions: ['BUSINESS_RULE'], reason: '重复操作仅在显式幂等约束下生成' },
    { area: 'SIDE_EFFECT_RISK', priority: 'P1', factIds: factIdsMatching(requirement, (fact) => fact.canonical.sideEffects.length > 0), riskIds: relevantRisks.filter((risk) => ['FINANCIAL', 'DEPENDENCY', 'DATA_INTEGRITY'].includes(risk.category)).map((risk) => risk.id), dimensions: ['SIDE_EFFECT'], reason: '验证 Requirement 声明的账务、库存、消息、审计或外部副作用' },
    { area: 'RECOVERY_RISK', priority: 'P1', factIds: constraintFacts('RECOVERY'), riskIds: relevantRisks.filter((risk) => risk.category === 'RECOVERY').map((risk) => risk.id), dimensions: ['BUSINESS_RULE'], reason: '失败恢复只在显式回滚、补偿或重试规则下生成' },
  ];
  const decisions = specs.map((spec): RiskDrivenStrategyDecision => ({
    id: `PORTFOLIO-${spec.area}`,
    area: spec.area,
    applicability: spec.factIds.length ? 'REQUIRED' : spec.confirmationWhenAbsent ? 'NEED_CONFIRMATION' : 'NOT_APPLICABLE',
    priority: spec.priority,
    reason: spec.factIds.length ? spec.reason
      : spec.confirmationWhenAbsent ? `${spec.reason}；当前信息不足，不生成 Case，需确认` : `${spec.reason}；Requirement/Business Model 未支持`,
    factIds: spec.factIds,
    riskIds: unique(spec.riskIds),
    dimensions: spec.dimensions,
  }));
  return { requirementId: requirement.id, decisions, selectedDimensions: unique(objectives.map((item) => item.dimension)) as TestDimension[] };
}

function candidateKind(objective: TestObjective): BusinessScenarioCandidateKind {
  if (objective.strategies.includes('CONCURRENT_REQUEST')) return 'CONCURRENT_OPERATION';
  if (objective.strategies.includes('REPEAT')) return 'DUPLICATE_OPERATION';
  if (objective.strategies.includes('RECOVERY_CHECK') || objective.strategies.includes('PARTIAL_FAILURE')) return 'FAILURE_RECOVERY';
  if (objective.dimension === 'DATA_ISOLATION') return 'CROSS_SCOPE_ACCESS';
  if (objective.dimension === 'PERMISSION' || objective.dimension === 'AUTH') return 'PERMISSION_CONFLICT';
  if (objective.dimension === 'STATE') return 'STATE_CONFLICT';
  if (objective.dimension === 'SIDE_EFFECT') return 'SIDE_EFFECT';
  if (objective.strategies.includes('CONSISTENCY_CHECK') || objective.strategies.includes('CROSS_CHANNEL_CHECK')) return 'DATA_CONSISTENCY';
  if (objective.strategies.some((item) => ['NEGATIVE', 'EXPECTED_FAILURE', 'VALID_INVALID', 'REQUIRED_MISSING'].includes(item))) return 'NEGATIVE_FLOW';
  return 'CORE_FLOW';
}

function candidateOrigin(objective: TestObjective): TestDesignOrigin {
  if (objective.sourceType === 'HEURISTIC') return 'EXPLORATORY';
  if (objective.strategies.some((item) => ['CONCURRENT_REQUEST', 'REPEAT', 'RECOVERY_CHECK', 'PARTIAL_FAILURE', 'SAME_CROSS_SCOPE'].includes(item))) return 'RISK_DERIVED';
  if (['BUSINESS_RULE', 'STATE', 'PERMISSION', 'DATA_ISOLATION', 'SIDE_EFFECT'].includes(objective.dimension)) return 'RULE_DERIVED';
  return 'REQUIREMENT_DERIVED';
}

function stateForFacts(model: BusinessModelProjection, factIds: readonly string[]): BusinessStateProjection | undefined {
  return model.states.find((state) => state.factIds.some((id) => factIds.includes(id)));
}

function candidateKey(candidate: Omit<BusinessScenarioCandidate, 'id' | 'semanticKey'>): string {
  return JSON.stringify({
    title: candidate.title.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''),
    kind: candidate.kind,
    actorIds: [...candidate.actorIds].sort(),
    resourceIds: [...candidate.resourceIds].sort(),
    state: candidate.state,
    conclusion: candidate.primaryConclusion.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''),
  });
}

export function buildBusinessScenarioCandidates(
  requirement: AcceptanceRequirement,
  model: BusinessModelProjection,
  objectives: TestObjective[],
): { scenarios: BusinessScenarioCandidate[]; deduplicatedCount: number } {
  const raw = objectives.map((objective): BusinessScenarioCandidate => {
    const fact = requirement.factLedger.find((item) => item.id === objective.factIds[0])!;
    const projected = factsFor(model, objective.factIds);
    const state = stateForFacts(model, objective.factIds);
    const goal = businessGoalForFact(fact, model);
    const draft = {
      title: goal,
      goal,
      kind: candidateKind(objective),
      origin: candidateOrigin(objective),
      status: objective.outcomeStatus === 'KNOWN' && fact.canonical.normalizationStatus === 'COMPLETE'
        ? 'READY_FOR_CASE' as const : 'NEED_CONFIRMATION' as const,
      priority: objective.priority,
      factIds: [...objective.factIds],
      objectiveIds: [objective.id],
      riskIds: unique(model.risks.filter((risk) => risk.factIds.some((id) => objective.factIds.includes(id))).map((risk) => risk.id)),
      dimensions: [objective.dimension],
      actorIds: unique(projected.actors.map((item) => item.id)),
      resourceIds: unique(projected.resources.map((item) => item.id)),
      state: state ? { from: state.from, to: state.to } : undefined,
      primaryConclusion: objective.expectedOutcome,
    };
    const semanticKey = candidateKey(draft);
    return { ...draft, id: stableId('BSCN', semanticKey), semanticKey };
  });

  // Connected State Graph edges form one user-level, cross-step scenario. No edge
  // is invented: every step and conclusion comes from an existing Fact/Objective.
  for (const first of model.states) for (const second of model.states) {
    if (first.id === second.id || !first.to || !second.from || first.to !== second.from
      || first.resourceId !== second.resourceId) continue;
    const factIds = unique([...first.factIds, ...second.factIds]);
    const linked = objectives.filter((objective) => objective.factIds.some((id) => factIds.includes(id)));
    if (linked.length < 2) continue;
    const resource = model.resources.find((item) => item.id === first.resourceId)?.type ?? 'Resource';
    const actorIds = unique(model.flows.filter((flow) => flow.factIds.some((id) => factIds.includes(id))).flatMap((flow) => flow.actorIds));
    const title = `${actorIds[0] ?? '业务参与者'}推动${resource}从 ${first.from} 经 ${first.to} 流转到 ${second.to ?? 'UNKNOWN'}`;
    const draft = {
      title, goal: title, kind: 'CORE_FLOW' as const, origin: 'RULE_DERIVED' as const,
      status: second.to ? 'READY_FOR_CASE' as const : 'NEED_CONFIRMATION' as const,
      priority: 'P0' as const, factIds, objectiveIds: unique(linked.map((item) => item.id)),
      riskIds: unique(model.risks.filter((risk) => risk.factIds.some((id) => factIds.includes(id))).map((risk) => risk.id)),
      dimensions: unique(linked.map((item) => item.dimension)) as TestDimension[], actorIds,
      resourceIds: first.resourceId ? [first.resourceId] : [], state: { from: first.from, to: second.to },
      primaryConclusion: linked.map((item) => item.expectedOutcome).join('；'),
    };
    const semanticKey = candidateKey(draft);
    raw.push({ ...draft, id: stableId('BSCN', semanticKey), semanticKey });
  }

  const output: BusinessScenarioCandidate[] = [];
  const byKey = new Map<string, BusinessScenarioCandidate>();
  let deduplicatedCount = 0;
  for (const candidate of raw) {
    const existing = byKey.get(candidate.semanticKey);
    if (!existing) {
      byKey.set(candidate.semanticKey, candidate);
      output.push(candidate);
      continue;
    }
    existing.factIds = unique([...existing.factIds, ...candidate.factIds]);
    existing.objectiveIds = unique([...existing.objectiveIds, ...candidate.objectiveIds]);
    existing.riskIds = unique([...existing.riskIds, ...candidate.riskIds]);
    existing.dimensions = unique([...existing.dimensions, ...candidate.dimensions]) as TestDimension[];
    deduplicatedCount++;
  }
  return { scenarios: output, deduplicatedCount };
}

function coverage(requiredIds: string[], coveredIds: Set<string>): TestDesignCoverageItem {
  const required = unique(requiredIds);
  const missingIds = required.filter((id) => !coveredIds.has(id));
  return { required: required.length, covered: required.length - missingIds.length, missingIds };
}

function caseSemanticKey(testCase: TestCase): string {
  return JSON.stringify({
    actor: testCase.actor && { id: testCase.actor.id, role: testCase.actor.role, tenant: testCase.actor.tenantId, project: testCase.actor.projectId },
    resource: testCase.businessScenario?.resourceContext,
    kind: testCase.businessScenario?.kind,
    steps: testCase.steps.map((step) => ({ action: step.action, method: step.method, url: step.url, input: step.input, path: step.pathParams, query: step.query, body: step.body })),
    expected: testCase.expected,
  });
}

function businessCaseKey(testCase: TestCase): string {
  return JSON.stringify({
    goal: testCase.businessScenario?.goal.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''),
    actors: testCase.businessScenario?.actors.map((item) => [item.id, item.role, item.tenantId, item.projectId, item.relation]).sort(),
    resources: testCase.businessScenario?.resources?.map((item) => item.id).sort(),
    state: testCase.businessScenario?.state,
    permission: testCase.businessScenario?.permission,
    conclusion: testCase.businessScenario?.expectedBusinessOutcome.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''),
    proofObligations: [...(testCase.testAspects ?? [])].sort(),
    assertions: testCase.assertions.map((assertion) => ({
      type: assertion.type,
      channel: assertion.channel,
      path: assertion.path,
      operator: assertion.operator,
      expected: assertion.expected,
    })),
  });
}

export function reviewTestDesign(input: {
  requirement: AcceptanceRequirement;
  businessModel: BusinessModelProjection;
  strategy: RiskDrivenTestStrategy;
  scenarioCandidates: BusinessScenarioCandidate[];
  testCases: TestCase[];
}): TestDesignReview {
  const { requirement, businessModel, strategy, scenarioCandidates, testCases } = input;
  const caseFacts = new Set(testCases.flatMap((testCase) => testCase.source?.factIds ?? []));
  const caseObjectives = new Set(testCases.flatMap((testCase) => testCase.source?.objectiveIds ?? []));
  const coveredCandidates = new Set(scenarioCandidates.filter((candidate) =>
    candidate.objectiveIds.some((id) => caseObjectives.has(id))).map((candidate) => candidate.id));
  const casesFor = (predicate: (candidate: BusinessScenarioCandidate) => boolean): Set<string> =>
    new Set(scenarioCandidates.filter(predicate).filter((candidate) => coveredCandidates.has(candidate.id)).map((candidate) => candidate.id));
  const requiredCandidates = (predicate: (candidate: BusinessScenarioCandidate) => boolean): string[] =>
    scenarioCandidates.filter((candidate) => candidate.status === 'READY_FOR_CASE' && predicate(candidate)).map((candidate) => candidate.id);
  const requiredRiskIds = strategy.decisions.filter((decision) => decision.applicability === 'REQUIRED').flatMap((decision) => decision.riskIds);
  const coveredRiskIds = new Set(testCases.flatMap((testCase) => testCase.businessScenario?.risks.map((risk) => risk.id) ?? []));
  const unknownCases = testCases.filter((testCase) => testCase.requirementStatus === 'UNKNOWN'
    || testCase.requirementStatus === 'NEED_CONFIRMATION');
  const unknownViolations = unknownCases.filter((testCase) => testCase.executionMode === 'EXECUTABLE'
    || testCase.oracle?.status === 'READY').map((testCase) => testCase.id);
  const duplicates = (keyOf: (testCase: TestCase) => string): string[] => {
    const seen = new Map<string, string>();
    const result: string[] = [];
    for (const testCase of testCases) {
      const key = keyOf(testCase);
      const previous = seen.get(key);
      if (previous) result.push(previous, testCase.id); else seen.set(key, testCase.id);
    }
    return unique(result);
  };
  const runtimeCases = testCases.filter((testCase) => testCase.executionMode === 'EXECUTABLE');
  const oracleComplete = testCases.filter((testCase) => testCase.oracle?.deterministic
    && testCase.oracle.assertionIds.length > 0 && testCase.oracle.evidenceRequirementIds.length > 0).length;
  const evidenceComplete = testCases.filter((testCase) => (testCase.evidenceRequirements ?? []).some((item) => item.required)
    && testCase.assertions.filter((assertion) => assertion.type !== 'DESIGN_EXPECTATION')
      .every((assertion) => Boolean(assertion.evidenceRequirementIds?.length))).length;
  const negative = (candidate: BusinessScenarioCandidate): boolean => ['NEGATIVE_FLOW', 'STATE_CONFLICT', 'PERMISSION_CONFLICT', 'OWNERSHIP_CONFLICT', 'CROSS_SCOPE_ACCESS', 'DUPLICATE_OPERATION', 'CONCURRENT_OPERATION', 'FAILURE_RECOVERY'].includes(candidate.kind);
  const missingHighValueScenarioIds = scenarioCandidates.filter((candidate) => candidate.priority !== 'P2'
    && candidate.status === 'READY_FOR_CASE' && !coveredCandidates.has(candidate.id)).map((candidate) => candidate.id);
  return {
    requirementCoverage: coverage(requirement.factLedger.filter((fact) => fact.normativity === 'NORMATIVE'
      && fact.status !== 'BLOCKED').map((fact) => fact.id), caseFacts),
    coreBusinessFlowCoverage: coverage(requiredCandidates((candidate) => candidate.kind === 'CORE_FLOW'), casesFor((candidate) => candidate.kind === 'CORE_FLOW')),
    riskCoverage: coverage(requiredRiskIds, coveredRiskIds),
    negativeCoverage: coverage(requiredCandidates(negative), casesFor(negative)),
    stateCoverage: coverage(requiredCandidates((candidate) => candidate.kind === 'STATE_CONFLICT'), casesFor((candidate) => candidate.kind === 'STATE_CONFLICT')),
    permissionCoverage: coverage(requiredCandidates((candidate) => candidate.kind === 'PERMISSION_CONFLICT' || candidate.kind === 'OWNERSHIP_CONFLICT'), casesFor((candidate) => candidate.kind === 'PERMISSION_CONFLICT' || candidate.kind === 'OWNERSHIP_CONFLICT')),
    isolationCoverage: coverage(requiredCandidates((candidate) => candidate.kind === 'CROSS_SCOPE_ACCESS'), casesFor((candidate) => candidate.kind === 'CROSS_SCOPE_ACCESS')),
    sideEffectCoverage: coverage(requiredCandidates((candidate) => candidate.kind === 'SIDE_EFFECT'), casesFor((candidate) => candidate.kind === 'SIDE_EFFECT')),
    executableRate: testCases.length ? runtimeCases.length / testCases.length : 0,
    oracleCompleteness: testCases.length ? oracleComplete / testCases.length : 0,
    evidenceCompleteness: testCases.length ? evidenceComplete / testCases.length : 0,
    unknownHandling: { total: unknownCases.length, safelyBlocked: unknownCases.length - unknownViolations.length, violations: unknownViolations },
    semanticDuplicateCaseIds: duplicates(caseSemanticKey),
    businessDuplicateCaseIds: duplicates(businessCaseKey),
    missingHighValueScenarioIds,
  };
}
