import type { Scenario } from './scenario-contract.js';
import type { ScenarioExecutabilityGateResult } from './scenario-executability-gate.js';

export const SCENARIO_QUALITY_DIMENSIONS = [
  'Requirement Completeness',
  'API Completeness',
  'Precondition Completeness',
  'Assertion Completeness',
  'State Verification',
  'Side Effect Verification',
  'Evidence Completeness',
  'Executability',
  'Cleanup Completeness',
  'Traceability',
] as const;

export type ScenarioQualityDimension = typeof SCENARIO_QUALITY_DIMENSIONS[number];

export interface ScenarioQualityDimensionResult {
  dimension: ScenarioQualityDimension;
  score: 0 | 5 | 10;
  reason: string;
}

export interface ScenarioQualityResult {
  scenarioId: string;
  score: number;
  maxScore: 100;
  grade: 'EXCELLENT' | 'GOOD' | 'NEEDS_WORK' | 'INCOMPLETE';
  dimensions: ScenarioQualityDimensionResult[];
  /** 质量分不改变 executionMode，也不代替 Gate 或运行结果。 */
  executionMode: Scenario['executionMode'];
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const STATE_PATTERNS = new Set(['PERSISTENCE', 'NON_MUTATION', 'ATOMICITY', 'STATE_MACHINE', 'ASYNC']);
const EFFECT_PATTERNS = new Set(['IDEMPOTENCY', 'BILLING', 'PROVIDER_FAILURE', 'CALLBACK', 'AUDIT']);

function result(dimension: ScenarioQualityDimension, score: 0 | 5 | 10, reason: string): ScenarioQualityDimensionResult {
  return { dimension, score, reason };
}

/** 确定性场景设计评分；不读取也不推断运行状态。 */
export function scoreScenarioQuality(scenario: Scenario, gate?: ScenarioExecutabilityGateResult): ScenarioQualityResult {
  const criterionIds = new Set(scenario.acceptanceCriteriaIds);
  const operationIds = new Set(scenario.operations.map((operation) => operation.id));
  const assertionIds = new Set(scenario.assertions.map((assertion) => assertion.id));
  const requiresState = scenario.patternIds.some((pattern) => STATE_PATTERNS.has(pattern));
  const requiresEffect = scenario.patternIds.some((pattern) => EFFECT_PATTERNS.has(pattern));
  const mutates = scenario.operations.some((operation) => operation.channel === 'DATA'
    || operation.channel === 'API' && operation.method && MUTATING.has(operation.method));

  const dimensions: ScenarioQualityDimensionResult[] = [];
  dimensions.push(result('Requirement Completeness',
    scenario.requirement && scenario.acceptanceCriteriaIds.length ? 10 : scenario.requirement || scenario.acceptanceCriteriaIds.length ? 5 : 0,
    scenario.requirement && scenario.acceptanceCriteriaIds.length ? 'Requirement 与 AC 均明确' : 'Requirement 或 AC 不完整'));

  const apiOperations = scenario.operations.filter((operation) => operation.channel === 'API');
  const completeApi = apiOperations.filter((operation) => operation.method && operation.path && operation.processor).length;
  dimensions.push(result('API Completeness',
    !apiOperations.length ? 10 : completeApi === apiOperations.length ? 10 : completeApi > 0 ? 5 : 0,
    !apiOperations.length ? '场景不要求 API Contract' : `${completeApi}/${apiOperations.length} 个 API Operation 具有 Method + Path + Processor`));

  const completePreconditions = scenario.preconditions.filter((item) => item.id && item.description).length;
  dimensions.push(result('Precondition Completeness',
    !scenario.preconditions.length ? 5 : completePreconditions === scenario.preconditions.length ? 10 : 5,
    !scenario.preconditions.length ? '未声明结构化 Preconditions' : `${completePreconditions}/${scenario.preconditions.length} 条 Preconditions 完整`));

  const validAssertions = scenario.assertions.filter((assertion) => assertion.target && assertion.operator
    && assertion.acceptanceCriteriaIds.length && assertion.evidenceRequirementIds.length).length;
  dimensions.push(result('Assertion Completeness',
    !scenario.assertions.length ? 0 : validAssertions === scenario.assertions.length ? 10 : 5,
    `${validAssertions}/${scenario.assertions.length} 条 Assertion 具有 Target、Operator、AC 与 Evidence`));

  const stateAssertions = scenario.assertions.filter((assertion) => ['STATE', 'DATA'].includes(assertion.channel)
    || ['UNCHANGED', 'TRANSITIONED_TO'].includes(assertion.operator)).length;
  const stateEvidence = scenario.evidenceRequirements.some((evidence) => ['STATE_BEFORE', 'STATE_AFTER', 'DATABASE', 'RESOURCE'].includes(evidence.kind));
  dimensions.push(result('State Verification',
    !requiresState ? 10 : stateAssertions && stateEvidence ? 10 : stateAssertions || stateEvidence ? 5 : 0,
    !requiresState ? '所选 Pattern 不要求状态证明' : `状态断言 ${stateAssertions}，状态证据 ${stateEvidence ? '已声明' : '缺失'}`));

  const effectAssertions = scenario.assertions.filter((assertion) => ['SIDE_EFFECT', 'AUDIT', 'PROVIDER', 'QUEUE'].includes(assertion.channel)
    || assertion.operator === 'COUNT_EQUALS').length;
  const effectEvidence = scenario.evidenceRequirements.some((evidence) => ['EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD'].includes(evidence.kind));
  dimensions.push(result('Side Effect Verification',
    !requiresEffect ? 10 : effectAssertions && effectEvidence ? 10 : effectAssertions || effectEvidence ? 5 : 0,
    !requiresEffect ? '所选 Pattern 不要求副作用证明' : `副作用断言 ${effectAssertions}，副作用证据 ${effectEvidence ? '已声明' : '缺失'}`));

  const completeEvidence = scenario.evidenceRequirements.filter((evidence) => evidence.requiredForPass
    && (evidence.operationId || evidence.sourceRef) && evidence.assertionIds.length
    && evidence.assertionIds.every((id) => assertionIds.has(id))).length;
  dimensions.push(result('Evidence Completeness',
    !scenario.evidenceRequirements.length ? 0 : completeEvidence === scenario.evidenceRequirements.length ? 10 : completeEvidence > 0 ? 5 : 0,
    `${completeEvidence}/${scenario.evidenceRequirements.length} 个 Evidence Requirement 具有 Source 与 Assertion trace`));

  const internallyExecutable = scenario.executionMode === 'EXECUTABLE' && scenario.operations.length > 0
    && scenario.assertions.length > 0 && scenario.blockedReasons.length === 0;
  const gateExecutable = gate ? gate.allowed : internallyExecutable;
  dimensions.push(result('Executability', gateExecutable ? 10 : scenario.executionMode === 'DESIGNED_ONLY' ? 5 : 0,
    gate ? `${gate.disposition}；${gate.reasons.length} 个阻断原因` : `声明模式 ${scenario.executionMode}`));

  const validCleanup = scenario.cleanup.every((hook) => hook.handler && hook.id);
  dimensions.push(result('Cleanup Completeness',
    !mutates ? 10 : scenario.cleanup.length && validCleanup ? 10 : scenario.cleanup.length ? 5 : 0,
    !mutates ? '场景不产生持久化写入' : `${scenario.cleanup.length} 个 Cleanup Hook`));

  const tracedCriteria = scenario.acceptanceCriteriaIds.filter((criterionId) => scenario.operations.some((operation) => operation.acceptanceCriteriaIds.includes(criterionId))
    && scenario.assertions.some((assertion) => assertion.acceptanceCriteriaIds.includes(criterionId))).length;
  const validOperationRefs = scenario.assertions.every((assertion) => !assertion.operationId || operationIds.has(assertion.operationId));
  dimensions.push(result('Traceability',
    criterionIds.size > 0 && tracedCriteria === criterionIds.size && validOperationRefs ? 10 : tracedCriteria > 0 ? 5 : 0,
    `${tracedCriteria}/${criterionIds.size} 个 AC 已闭合到 Operation + Assertion`));

  const score = dimensions.reduce((sum, item) => sum + item.score, 0);
  return {
    scenarioId: scenario.id,
    score,
    maxScore: 100,
    grade: score >= 90 ? 'EXCELLENT' : score >= 75 ? 'GOOD' : score >= 50 ? 'NEEDS_WORK' : 'INCOMPLETE',
    dimensions,
    executionMode: scenario.executionMode,
  };
}
