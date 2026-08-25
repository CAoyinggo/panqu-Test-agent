import type { TestCase, TestType } from '../agents/test-design/testcase-schema.js';

export type AcceptanceRegressionPolicy =
  | 'ACCESS_CONTROL'
  | 'DATA_ISOLATION'
  | 'INPUT_CONSTRAINT'
  | 'API_CONTRACT'
  | 'BUSINESS_RULE'
  | 'STATE_TRANSITION'
  | 'SIDE_EFFECT'
  | 'DATA_LIFECYCLE'
  | 'UI_BEHAVIOR'
  | 'FUNCTIONAL_BEHAVIOR'
  | 'COMPATIBILITY'
  | 'PERFORMANCE';

export type AcceptanceRegressionSelectionReason =
  | 'ORIGINAL_FAILURE'
  | 'SAME_FACT'
  | 'SAME_POLICY';

export interface AcceptanceRegressionCaseSelection {
  caseId: string;
  reasons: AcceptanceRegressionSelectionReason[];
  factIds: string[];
  objectiveIds: string[];
  policies: AcceptanceRegressionPolicy[];
}

export interface FactBasedRegressionPlan {
  strategy: 'FACT_BASED_REGRESSION_V1';
  seedCaseIds: string[];
  seedFactIds: string[];
  policies: AcceptanceRegressionPolicy[];
  affectedFactIds: string[];
  affectedObjectiveIds: string[];
  affectedCaseIds: string[];
  selections: AcceptanceRegressionCaseSelection[];
}

export class AcceptanceRegressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceRegressionError';
  }
}

const TYPE_POLICIES: Readonly<Partial<Record<TestType, readonly AcceptanceRegressionPolicy[]>>> = {
  AUTH: ['ACCESS_CONTROL'],
  PERMISSION: ['ACCESS_CONTROL'],
  SECURITY: ['ACCESS_CONTROL'],
  DATA_ISOLATION: ['ACCESS_CONTROL', 'DATA_ISOLATION'],
  PARAMETER: ['INPUT_CONSTRAINT'],
  BOUNDARY: ['INPUT_CONSTRAINT'],
  ERROR: ['API_CONTRACT'],
  API: ['API_CONTRACT'],
  BUSINESS_RULE: ['BUSINESS_RULE'],
  STATE: ['STATE_TRANSITION'],
  SIDE_EFFECT: ['SIDE_EFFECT'],
  CLEANUP: ['DATA_LIFECYCLE'],
  UI: ['UI_BEHAVIOR'],
  FUNCTIONAL: ['FUNCTIONAL_BEHAVIOR'],
  HYBRID: ['FUNCTIONAL_BEHAVIOR'],
  COMPATIBILITY: ['COMPATIBILITY'],
  PERFORMANCE: ['PERFORMANCE'],
};

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function intersects(left: Iterable<string>, right: Set<string>): boolean {
  for (const item of left) if (right.has(item)) return true;
  return false;
}

/**
 * Test strategy is derived only from the canonical TestType. This module never
 * reparses requirement prose and therefore cannot invent a new policy relation.
 */
export function acceptanceRegressionPolicies(testCase: TestCase): AcceptanceRegressionPolicy[] {
  return [...(TYPE_POLICIES[testCase.testType ?? 'FUNCTIONAL'] ?? [])];
}

/**
 * Selects the original failing Case, all Cases traced to the same Fact, and all
 * Cases compiled from the same canonical test strategy. Every selected Case
 * must come from the archived preview authorization; otherwise selection fails
 * closed before Data Prepare or execution.
 */
export function buildFactBasedRegressionPlan(input: {
  testCases: TestCase[];
  failedCaseIds: string[];
  authorizedCaseIds?: string[];
}): FactBasedRegressionPlan {
  const caseById = new Map<string, TestCase>();
  for (const testCase of input.testCases) {
    if (!testCase.id || caseById.has(testCase.id)) {
      throw new AcceptanceRegressionError(`REGRESSION_PLAN_INVALID：Case ID 缺失或重复：${testCase.id || '<empty>'}`);
    }
    caseById.set(testCase.id, testCase);
  }
  const seedCaseIds = uniqueSorted(input.failedCaseIds);
  if (!seedCaseIds.length) {
    throw new AcceptanceRegressionError('REGRESSION_SEED_MISSING：归档 Run 没有可归因的失败 Case，禁止退化为全量执行');
  }
  const unknownSeeds = seedCaseIds.filter((caseId) => !caseById.has(caseId));
  if (unknownSeeds.length) {
    throw new AcceptanceRegressionError(`REGRESSION_TRACE_INVALID：失败 Case 不存在于归档计划：${unknownSeeds.join(', ')}`);
  }
  const seeds = seedCaseIds.map((caseId) => caseById.get(caseId)!);
  const seedFactIds = uniqueSorted(seeds.flatMap((testCase) => testCase.source?.factIds ?? []));
  if (!seedFactIds.length) {
    throw new AcceptanceRegressionError('REGRESSION_TRACE_INCOMPLETE：失败 Case 没有 Requirement Fact trace，禁止执行伪 Fact-based Regression');
  }
  const seedFactSet = new Set(seedFactIds);
  const policies = uniqueSorted(seeds.flatMap(acceptanceRegressionPolicies)) as AcceptanceRegressionPolicy[];
  const policySet = new Set<string>(policies);
  const authorized = input.authorizedCaseIds ? new Set(input.authorizedCaseIds) : undefined;
  const selections: AcceptanceRegressionCaseSelection[] = [];

  for (const testCase of input.testCases) {
    const reasons: AcceptanceRegressionSelectionReason[] = [];
    const factIds = uniqueSorted(testCase.source?.factIds ?? []);
    const objectiveIds = uniqueSorted(testCase.source?.objectiveIds ?? []);
    const casePolicies = acceptanceRegressionPolicies(testCase);
    if (seedCaseIds.includes(testCase.id)) reasons.push('ORIGINAL_FAILURE');
    if (intersects(factIds, seedFactSet)) reasons.push('SAME_FACT');
    if (intersects(casePolicies, policySet)) reasons.push('SAME_POLICY');
    if (!reasons.length) continue;
    if (authorized && !authorized.has(testCase.id)) {
      throw new AcceptanceRegressionError(`REGRESSION_SCOPE_EXPANSION：Case ${testCase.id} 不在原 Execution Plan 授权范围`);
    }
    selections.push({ caseId: testCase.id, reasons, factIds, objectiveIds, policies: casePolicies });
  }
  if (!selections.length || seedCaseIds.some((id) => !selections.some((item) => item.caseId === id))) {
    throw new AcceptanceRegressionError('REGRESSION_SELECTION_EMPTY：无法保留原失败 Case，已阻断回归执行');
  }

  const priorityRank: Record<TestCase['priority'], number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  selections.sort((left, right) => {
    const leftCase = caseById.get(left.caseId)!;
    const rightCase = caseById.get(right.caseId)!;
    return priorityRank[leftCase.priority] - priorityRank[rightCase.priority]
      || left.caseId.localeCompare(right.caseId);
  });
  return {
    strategy: 'FACT_BASED_REGRESSION_V1',
    seedCaseIds,
    seedFactIds,
    policies,
    affectedFactIds: uniqueSorted(selections.flatMap((item) => item.factIds)),
    affectedObjectiveIds: uniqueSorted(selections.flatMap((item) => item.objectiveIds)),
    affectedCaseIds: selections.map((item) => item.caseId),
    selections,
  };
}
