import { isDesignedOnlyCase, type TestCase } from '../agents/test-design/testcase-schema.js';
import type { AcceptanceRequirement } from './requirement-ir.js';
import type { TestPoint } from './test-point.js';
import type { TestObjective } from './test-objective.js';

export interface AcceptanceTraceIssue {
  code: 'DUPLICATE_ID' | 'ORPHAN_TEST_POINT' | 'ORPHAN_TEST_CASE' | 'UNKNOWN_AC' | 'UNKNOWN_FACT' | 'UNKNOWN_OBJECTIVE' | 'FACT_CLOSURE_INCOMPLETE' | 'ASSERTION_TRACE_MISSING' | 'MISSING_SOURCE' | 'OPERATION_TRACE_MISMATCH';
  entityId: string;
  message: string;
}

/** 验证 Requirement → AC → TP → Case 引用完整性；交付入口在执行前 fail-fast。 */
export function validateAcceptanceTrace(
  requirement: AcceptanceRequirement,
  testPoints: TestPoint[],
  testCases: TestCase[],
  objectives: TestObjective[] = [],
): AcceptanceTraceIssue[] {
  const issues: AcceptanceTraceIssue[] = [];
  const seen = new Set<string>();
  for (const id of [requirement.id, ...requirement.factLedger.map((item) => item.id), ...requirement.acceptanceCriteria.map((item) => item.criterionId), ...objectives.map((item) => item.id), ...testPoints.map((item) => item.id), ...testCases.map((item) => item.id)]) {
    if (seen.has(id)) issues.push({ code: 'DUPLICATE_ID', entityId: id, message: `ID 重复：${id}` });
    seen.add(id);
  }
  const criteria = new Set(requirement.acceptanceCriteria.map((item) => item.criterionId));
  const facts = new Set(requirement.factLedger.map((item) => item.id));
  const objectiveIds = new Set(objectives.map((item) => item.id));
  const points = new Set(testPoints.map((item) => item.id));
  const apis = new Map(requirement.apis.map((api) => [api.id, api]));
  for (const point of testPoints) {
    if (point.requirementId !== requirement.id) issues.push({ code: 'ORPHAN_TEST_POINT', entityId: point.id, message: `${point.id} 引用了不存在的 Requirement ${point.requirementId}` });
    for (const ac of point.acceptanceCriteriaIds) {
      if (!criteria.has(ac)) issues.push({ code: 'UNKNOWN_AC', entityId: point.id, message: `${point.id} 引用了不存在的 AC ${ac}` });
    }
    for (const factId of point.factIds ?? []) {
      if (!facts.has(factId)) issues.push({ code: 'UNKNOWN_FACT', entityId: point.id, message: `${point.id} 引用了不存在的 Fact ${factId}` });
    }
    if (objectives.length && !objectiveIds.has(point.objectiveId)) issues.push({ code: 'UNKNOWN_OBJECTIVE', entityId: point.id, message: `${point.id} 引用了不存在的 Objective ${point.objectiveId}` });
    if (!point.source?.line) issues.push({ code: 'MISSING_SOURCE', entityId: point.id, message: `${point.id} 无法定位 Requirement Source` });
  }
  for (const testCase of testCases) {
    if (!testCase.source || testCase.source.requirementId !== requirement.id || !points.has(testCase.source.testPointId)) {
      issues.push({ code: 'ORPHAN_TEST_CASE', entityId: testCase.id, message: `${testCase.id} 缺少有效 Requirement / Test Point 引用` });
      continue;
    }
    for (const ac of testCase.source.acceptanceCriteriaIds) {
      if (!criteria.has(ac)) issues.push({ code: 'UNKNOWN_AC', entityId: testCase.id, message: `${testCase.id} 引用了不存在的 AC ${ac}` });
    }
    for (const factId of testCase.source.factIds ?? []) {
      if (!facts.has(factId)) issues.push({ code: 'UNKNOWN_FACT', entityId: testCase.id, message: `${testCase.id} 引用了不存在的 Fact ${factId}` });
    }
    for (const objectiveId of testCase.source.objectiveIds ?? []) {
      if (objectives.length && !objectiveIds.has(objectiveId)) issues.push({ code: 'UNKNOWN_OBJECTIVE', entityId: testCase.id, message: `${testCase.id} 引用了不存在的 Objective ${objectiveId}` });
    }
    if (!isDesignedOnlyCase(testCase)) {
      const api = apis.get(testCase.source.apiSpecId ?? '');
      if (!api || testCase.source.apiOperationKey !== api.operationKey) {
        issues.push({
          code: 'OPERATION_TRACE_MISMATCH', entityId: testCase.id,
          message: `${testCase.id} 缺少稳定 ApiSpec / Operation Key 引用`,
        });
      }
    }
    for (const assertion of testCase.assertions) {
      if (!assertion.factIds?.length || !(assertion.objectiveIds?.length || assertion.objectiveId)) {
        issues.push({ code: 'ASSERTION_TRACE_MISSING', entityId: testCase.id, message: `${testCase.id} 的断言缺少 Fact / Objective 来源` });
      }
    }
    if (!testCase.source.line) issues.push({ code: 'MISSING_SOURCE', entityId: testCase.id, message: `${testCase.id} 无法定位 Requirement Source` });
  }

  if (objectives.length) {
    for (const fact of requirement.factLedger.filter((item) => item.normativity === 'NORMATIVE')) {
      if (fact.status === 'CONSUMED') {
        const linkedObjectives = objectives.filter((objective) => objective.sourceType !== 'HEURISTIC' && objective.factIds.includes(fact.id));
        const linkedCases = testCases.filter((testCase) => testCase.source?.factIds?.includes(fact.id));
        const linkedAssertions = linkedCases.flatMap((testCase) => testCase.assertions).filter((assertion) => assertion.factIds?.includes(fact.id));
        if (!linkedObjectives.length || !linkedCases.length || !linkedAssertions.length) {
          issues.push({ code: 'FACT_CLOSURE_INCOMPLETE', entityId: fact.id, message: `${fact.id} 标记 CONSUMED，但未闭合到 Objective / Case / Assertion` });
        }
      } else if (!fact.statusReason) {
        issues.push({ code: 'FACT_CLOSURE_INCOMPLETE', entityId: fact.id, message: `${fact.id} 为 ${fact.status}，但没有明确原因` });
      }
    }
  }
  return issues;
}
