import type {
  AcceptanceRequirement,
  ApiBindingIssue,
  ApiOperationBinding,
  CanonicalRequirementFact,
  RequirementFactProvenance,
  RequirementSource,
} from './requirement-ir.js';
import { bindTestPointToApi, createApiBindingIndex } from './api-operation-binding.js';
import {
  buildAcceptanceTestDesign,
  type AcceptanceTestDesign,
  type TestDimension,
  type TestObjective,
} from './test-objective.js';
import type { TestStrategyKind } from './test-strategy-engine.js';
import type { TestCaseSourceType, TestType } from '../agents/test-design/testcase-schema.js';

/** TestPoint 是绑定/执行编译层对 canonical TestObjective 的兼容投影。 */
export type TestPointCategory = TestType;

export interface TestPoint {
  id: string;
  requirementId: string;
  objectiveId: string;
  factIds: string[];
  acceptanceCriteriaIds: string[];
  category: TestPointCategory;
  dimension: TestDimension;
  priority: 'P0' | 'P1' | 'P2';
  objective: string;
  expectedOutcome: string;
  outcomeStatus: 'KNOWN' | 'UNKNOWN';
  sourceType: TestCaseSourceType;
  provenance: RequirementFactProvenance;
  executionTarget: TestObjective['executionTarget'];
  strategyIds: string[];
  strategies: TestStrategyKind[];
  canonicalFact: CanonicalRequirementFact;
  scenarioId?: string;
  parameterNames: string[];
  preconditions: string[];
  risk?: string;
  source?: RequirementSource;
  apiBinding?: ApiOperationBinding;
  bindingIssue?: ApiBindingIssue;
}

function categoryOf(dimension: TestDimension): TestPointCategory {
  if (dimension === 'PARAMETER_VALIDATION') return 'PARAMETER';
  return dimension;
}

function acceptanceCriteriaFor(requirement: AcceptanceRequirement, factIds: string[]): string[] {
  const wanted = new Set(factIds);
  return requirement.factLedger
    .filter((fact) => wanted.has(fact.id))
    .flatMap((fact) => fact.entityRefs.items
      .filter((ref) => ref.type === 'ACCEPTANCE_CRITERION')
      .map((ref) => ref.id));
}

function preconditionsFor(objective: TestObjective): string[] {
  if (objective.executionTarget === 'UI') return ['目标页面与所需测试数据已准备'];
  if (objective.dimension === 'PERMISSION' || objective.dimension === 'AUTH') return ['需求中声明的身份与凭据映射已准备'];
  if (objective.dimension === 'DATA_ISOLATION') return ['至少两个显式数据范围及其归属资源已准备'];
  if (objective.executionTarget === 'DATA' || objective.executionTarget === 'HYBRID') return ['业务数据与可观测后置状态已准备'];
  if (objective.executionTarget === 'API') return ['目标 API 可访问'];
  return ['功能前置条件已准备'];
}

function directBinding(requirement: AcceptanceRequirement, point: TestPoint, apiSpecId: string): ApiOperationBinding | undefined {
  const api = requirement.apis.find((candidate) => candidate.id === apiSpecId);
  if (!api) return undefined;
  return {
    apiSpecId: api.id,
    operationKey: api.operationKey,
    method: api.method,
    path: api.path,
    sourceAcId: point.acceptanceCriteriaIds[0],
    sourceTestPointId: point.id,
    strategy: point.canonicalFact.action.operationKey === api.operationKey ? 'EXACT_METHOD_PATH' : 'SINGLE_API',
    confidence: 'HIGH',
  };
}

/**
 * Fact-derived Test Objective → 可绑定 TestPoint。
 * UI/FUNCTIONAL/DATA 目标不会再为了复用单 API 而被强制包装成 HTTP Case。
 */
export function generateTestPoints(
  requirement: AcceptanceRequirement,
  design: AcceptanceTestDesign = buildAcceptanceTestDesign(requirement),
): TestPoint[] {
  const bindingIndex = createApiBindingIndex(requirement);
  return design.objectives.map((objective, index) => {
    const point: TestPoint = {
      id: `TP-${String(index + 1).padStart(3, '0')}`,
      requirementId: requirement.id,
      objectiveId: objective.id,
      factIds: objective.factIds,
      acceptanceCriteriaIds: acceptanceCriteriaFor(requirement, objective.factIds),
      category: categoryOf(objective.dimension),
      dimension: objective.dimension,
      priority: objective.priority,
      objective: objective.scenario,
      expectedOutcome: objective.expectedOutcome,
      outcomeStatus: objective.outcomeStatus,
      sourceType: objective.sourceType,
      provenance: objective.provenance,
      executionTarget: objective.executionTarget,
      strategyIds: objective.strategyIds,
      strategies: objective.strategies,
      canonicalFact: objective.canonicalFact,
      scenarioId: objective.scenarioId,
      parameterNames: objective.parameterNames,
      preconditions: preconditionsFor(objective),
      risk: objective.risk,
      source: objective.source,
    };

    if (objective.executionTarget === 'API' || objective.executionTarget === 'HYBRID') {
      if (objective.apiSpecIds.length === 1) point.apiBinding = directBinding(requirement, point, objective.apiSpecIds[0]);
      if (!point.apiBinding) {
        const decision = bindTestPointToApi(requirement, point, bindingIndex);
        if (decision.binding) point.apiBinding = decision.binding;
        else point.bindingIssue = decision.issue;
      }
    }
    return point;
  });
}
