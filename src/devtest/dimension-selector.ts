import type { TestCase, TestType } from '../agents/test-design/testcase-schema.js';
import {
  DEVTEST_CASE_DIMENSIONS,
  type DevTestCaseProfile,
  type DevTestCaseDimension,
  type DevTestCoreCaseKind,
  type DevTestDimensionDecision,
  type DevTestTestValueScore,
  type DevTestAdaptiveTestScore,
  type DevTestTier,
} from './types.js';

const TYPE_DIMENSION: Record<TestType, DevTestCaseDimension> = {
  API: 'API', AUTH: 'API', ERROR: 'API',
  FUNCTIONAL: 'FUNCTIONAL', BUSINESS_RULE: 'FUNCTIONAL', STATE: 'FUNCTIONAL',
  SIDE_EFFECT: 'FUNCTIONAL', CLEANUP: 'FUNCTIONAL', HYBRID: 'FUNCTIONAL',
  COMPATIBILITY: 'FUNCTIONAL', PERFORMANCE: 'FUNCTIONAL',
  UI: 'UI',
  DATA_ISOLATION: 'DATA_ISOLATION', PERMISSION: 'DATA_ISOLATION', SECURITY: 'DATA_ISOLATION',
  PARAMETER: 'PARAMETER_VALIDATION', BOUNDARY: 'PARAMETER_VALIDATION',
};

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;

export function devTestDimensionOf(testType: TestType | string | undefined): DevTestCaseDimension {
  return TYPE_DIMENSION[(testType ?? 'FUNCTIONAL') as TestType] ?? 'FUNCTIONAL';
}

export function tierOf(testCase: TestCase): DevTestTier {
  if (testCase.priority === 'P0') return 'TIER_0';
  if (['BOUNDARY', 'PARAMETER', 'PERFORMANCE'].includes(testCase.testType ?? '') && ['P2', 'P3'].includes(testCase.priority)) return 'TIER_2';
  if (coreKindOf(testCase)) return 'TIER_0';
  return 'TIER_1';
}

function httpMethod(testCase: TestCase): string | undefined {
  const method = testCase.steps.find((step) => step.type === 'HTTP_REQUEST')?.method;
  return typeof method === 'string' ? method.toUpperCase() : undefined;
}

/** 0~100：风险/影响/可能性/可检测性越高越优先，执行成本越低越优先。 */
export function scoreDevTestCase(testCase: TestCase): DevTestTestValueScore {
  const dimension = devTestDimensionOf(testCase.testType);
  const method = httpMethod(testCase);
  const testType = testCase.testType ?? 'FUNCTIONAL';
  const text = `${testCase.name} ${testCase.testType} ${(testCase.tags ?? []).join(' ')} ${JSON.stringify(testCase.design ?? {})}`;
  const risk = ({ P0: 5, P1: 4, P2: 2, P3: 1 } as const)[testCase.priority];
  const businessImpact = ['DATA_ISOLATION', 'PERMISSION', 'SECURITY', 'AUTH'].includes(testType) ? 5
    : /billing|charge|payment|扣费|provider|external/i.test(text) ? 5
      : ['FUNCTIONAL', 'BUSINESS_RULE', 'STATE', 'SIDE_EFFECT'].includes(testType) ? 4
        : dimension === 'API' || dimension === 'PARAMETER_VALIDATION' ? 3 : 2;
  const likelihood = ['BOUNDARY', 'PARAMETER', 'ERROR'].includes(testType) ? 5
    : ['AUTH', 'PERMISSION', 'DATA_ISOLATION', 'STATE'].includes(testType) ? 4 : 3;
  const detectability = testCase.executionMode === 'EXECUTABLE'
    ? testCase.assertions?.length && testCase.contractDependencies?.length ? 5 : 3
    : 1;
  const executionCost = testCase.executionMode !== 'EXECUTABLE' ? 5
    : method && ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 1
      : /billing|provider|external|delete/i.test(text) || method === 'DELETE' ? 5 : 3;
  const weighted = risk * 0.30 + businessImpact * 0.25 + likelihood * 0.20
    + detectability * 0.15 + (6 - executionCost) * 0.10;
  return {
    total: Math.round(weighted * 20), risk, businessImpact, likelihood, detectability, executionCost,
    reason: `risk=${risk}, impact=${businessImpact}, likelihood=${likelihood}, detectability=${detectability}, cost=${executionCost}`,
  };
}

function compareCases(left: TestCase, right: TestCase): number {
  const priority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (priority) return priority;
  const score = scoreDevTestCase(right).total - scoreDevTestCase(left).total;
  if (score) return score;
  return left.id.localeCompare(right.id);
}

function normalized(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ').trim();
}

function tokens(value: unknown): Set<string> {
  return new Set(normalized(value).split(/\s+/).filter(Boolean));
}

function similarity(left: unknown, right: unknown): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((item) => b.has(item)).length;
  return intersection / new Set([...a, ...b]).size;
}

function caseParts(testCase: TestCase): unknown[] {
  return [
    { facts: testCase.design?.factIds ?? testCase.source?.factIds, ac: testCase.source?.acceptanceCriteriaIds,
      scenario: testCase.source?.scenarioId, businessScenario: testCase.businessScenario },
    { actor: testCase.actor, steps: testCase.steps.map((step) => ({ id: step.id, channel: step.channel,
      action: step.action, type: step.type, method: step.method, url: step.url, dependsOn: step.dependsOn })) },
    { data: testCase.data, parameter: testCase.parameterContext, steps: testCase.steps.map((step) => ({ input: step.input, query: step.query, body: step.body })) },
    { expected: testCase.expected, outcome: testCase.design?.expectedOutcome, assertions: testCase.assertions,
      oracle: testCase.oracle, evidence: testCase.evidenceRequirements },
    (testCase.contractDependencies ?? []).map((item) => `${item.contractId}@${item.version ?? ''}`),
    testCase.dependencies,
    testCase.cleanup,
  ];
}

export function devTestCaseSimilarity(left: TestCase, right: TestCase): number {
  if (devTestDimensionOf(left.testType) !== devTestDimensionOf(right.testType)) return 0;
  const a = caseParts(left);
  const b = caseParts(right);
  const weights = [0.18, 0.18, 0.14, 0.22, 0.10, 0.10, 0.08];
  let total = 0;
  for (let index = 0; index < a.length; index++) total += similarity(a[index], b[index]) * weights[index];
  return total;
}

function informationScore(testCase: TestCase): number {
  return (testCase.assertions?.length ?? 0) * 3
    + (testCase.contractDependencies?.length ?? 0) * 2
    + (testCase.design?.factIds?.length ?? 0) * 2
    + (testCase.steps?.length ?? 0)
    + (testCase.executionMode === 'EXECUTABLE' ? 5 : 0);
}

function preferredCase(left: TestCase, right: TestCase): TestCase {
  const value = scoreDevTestCase(left).total - scoreDevTestCase(right).total;
  if (value) return value > 0 ? left : right;
  const information = informationScore(left) - informationScore(right);
  if (information) return information > 0 ? left : right;
  const cost = scoreDevTestCase(left).executionCost - scoreDevTestCase(right).executionCost;
  if (cost) return cost < 0 ? left : right;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
}

function mergeTraceability(kept: TestCase, removed: TestCase): void {
  if (kept.source && removed.source) {
    kept.source.acceptanceCriteriaIds = [...new Set([...kept.source.acceptanceCriteriaIds, ...removed.source.acceptanceCriteriaIds])];
    kept.source.factIds = [...new Set([...(kept.source.factIds ?? []), ...(removed.source.factIds ?? [])])];
    kept.source.objectiveIds = [...new Set([...(kept.source.objectiveIds ?? []), ...(removed.source.objectiveIds ?? [])])];
  }
  if (kept.design && removed.design) {
    kept.design.factIds = [...new Set([...kept.design.factIds, ...removed.design.factIds])];
    kept.design.objectiveIds = [...new Set([...kept.design.objectiveIds, ...removed.design.objectiveIds])];
  }
  for (const requirement of removed.evidenceRequirements ?? []) {
    const existing = (kept.evidenceRequirements ??= []).find((candidate) =>
      candidate.channel === requirement.channel && candidate.phase === requirement.phase
      && (candidate.expectation ?? 'PRESENT') === (requirement.expectation ?? 'PRESENT'));
    if (!existing) kept.evidenceRequirements.push({ ...requirement, factIds: [...requirement.factIds] });
    else {
      existing.required = existing.required || requirement.required;
      existing.factIds = [...new Set([...existing.factIds, ...requirement.factIds])];
    }
  }
}

export function deduplicateDevTestCases(candidates: readonly TestCase[]): {
  retained: TestCase[];
  groups: Array<{ kept: string; removed: string[] }>;
} {
  const retained: TestCase[] = [];
  const groups = new Map<string, string[]>();
  for (const candidate of candidates) {
    // Acceptance 已完成精确语义去重；DevTest 只允许完全等价 Case 再合并。
    // 模糊阈值会删除输入/断言不同的 Case，并把被删 Case 的 Fact 冒充为已覆盖。
    const duplicateIndex = retained.findIndex((item) => devTestCaseSimilarity(item, candidate) >= 0.999999);
    if (duplicateIndex < 0) {
      retained.push(candidate);
      continue;
    }
    const existing = retained[duplicateIndex];
    const kept = preferredCase(existing, candidate);
    const removed = kept === existing ? candidate : existing;
    mergeTraceability(kept, removed);
    if (kept !== existing) retained[duplicateIndex] = kept;
    const prior = groups.get(existing.id) ?? groups.get(candidate.id) ?? [];
    groups.delete(existing.id);
    groups.delete(candidate.id);
    groups.set(kept.id, [...new Set([...prior, removed.id])]);
  }
  return { retained, groups: [...groups].map(([kept, removed]) => ({ kept, removed })) };
}

function isNegative(testCase: TestCase): boolean {
  const value = normalized({ name: testCase.name, expected: testCase.expected, design: testCase.design });
  return Boolean(testCase.negativeContractIntent) || /reject|invalid|forbid|denied|error|非法|拒绝|失败|越权/.test(value);
}

export function coreKindOf(testCase: TestCase): DevTestCoreCaseKind | undefined {
  const dimension = devTestDimensionOf(testCase.testType);
  const value = normalized({ name: testCase.name, tags: testCase.tags, design: testCase.design });
  if (['AUTH', 'PERMISSION', 'SECURITY'].includes(testCase.testType ?? '') || /auth|permission|role|权限|认证|授权/.test(value)) return 'AUTHORIZATION';
  if (dimension === 'DATA_ISOLATION' || testCase.testType === 'DATA_ISOLATION') return 'DATA_ISOLATION';
  if (dimension === 'PARAMETER_VALIDATION') return 'CORE_VALIDATION';
  if (['STATE', 'SIDE_EFFECT'].includes(testCase.testType ?? '') || /persist|save|state|存储|保存|持久化/.test(value)) return 'PERSISTENCE';
  if (!isNegative(testCase) && (testCase.priority === 'P0' || ['API', 'FUNCTIONAL'].includes(dimension))) return 'HAPPY_PATH';
  return undefined;
}

function caseSignature(testCase: TestCase): string {
  return normalized(caseParts(testCase));
}

export interface DevTestCaseSelection {
  /** 精确去重后的完整生成集；未选 Case 必须保留为 NOT_TESTED。 */
  candidates: TestCase[];
  selected: TestCase[];
  unselected: Array<{ caseId: string; reason: 'TIER_2_REQUIRES_DEEP' | 'DIMENSION_DISABLED' | 'MAX_CASES' }>;
  decisions: DevTestDimensionDecision[];
  scores: Record<string, DevTestTestValueScore>;
  profiles: Record<string, DevTestCaseProfile>;
  deduplication: { generated: number; retained: number; removed: number; groups: Array<{ kept: string; removed: string[] }> };
  adaptiveScores: Record<string, DevTestAdaptiveTestScore>;
}

/** 在 Acceptance canonical TestCase 上做风险优先裁剪，不生成第二套 Case。 */
export function selectDevTestCases(
  candidates: readonly TestCase[],
  input: { maxCases: number; enabledDimensions?: Partial<Record<DevTestCaseDimension, boolean>>; deep?: boolean;
    adaptiveScores?: Record<string, DevTestAdaptiveTestScore> },
): DevTestCaseSelection {
  if (!Number.isInteger(input.maxCases) || input.maxCases < 1 || input.maxCases > 100) {
    throw new Error(`DEVTEST_MAX_CASES_INVALID：maxCases 必须是 1~100 的整数，实际为 ${input.maxCases}`);
  }
  const enabled = (dimension: DevTestCaseDimension): boolean => input.enabledDimensions?.[dimension] !== false;
  const selectionCompare = (left: TestCase, right: TestCase): number =>
    (input.adaptiveScores?.[right.id]?.score ?? scoreDevTestCase(right).total)
      - (input.adaptiveScores?.[left.id]?.score ?? scoreDevTestCase(left).total) || compareCases(left, right);
  const deduplicated = deduplicateDevTestCases(candidates);
  const optimizedCandidates = deduplicated.retained.filter((testCase) => input.deep || tierOf(testCase) !== 'TIER_2');
  const byDimension = new Map<DevTestCaseDimension, TestCase[]>();
  for (const dimension of DEVTEST_CASE_DIMENSIONS) byDimension.set(dimension, []);
  for (const testCase of optimizedCandidates) byDimension.get(devTestDimensionOf(testCase.testType))!.push(testCase);
  for (const group of byDimension.values()) group.sort(selectionCompare);

  const selected: TestCase[] = [];
  const selectedIds = new Set<string>();
  const coreIdByKind = new Map<DevTestCoreCaseKind, string>();
  for (const kind of ['HAPPY_PATH', 'CORE_VALIDATION', 'AUTHORIZATION', 'PERSISTENCE', 'DATA_ISOLATION'] as const) {
    if (selected.length >= input.maxCases) break;
    const core = optimizedCandidates.filter((testCase) => enabled(devTestDimensionOf(testCase.testType)) && coreKindOf(testCase) === kind)
      .sort(selectionCompare)[0];
    if (core && !selectedIds.has(core.id)) {
      coreIdByKind.set(kind, core.id);
      selected.push(core);
      selectedIds.add(core.id);
    }
  }
  for (const dimension of DEVTEST_CASE_DIMENSIONS) {
    if (!enabled(dimension) || selected.length >= input.maxCases) continue;
    const first = byDimension.get(dimension)?.[0];
    if (first && !selectedIds.has(first.id)) {
      selected.push(first);
      selectedIds.add(first.id);
    }
  }
  const remaining = [...optimizedCandidates]
    .filter((testCase) => enabled(devTestDimensionOf(testCase.testType)) && !selectedIds.has(testCase.id))
    .sort(selectionCompare);
  for (const testCase of remaining) {
    if (selected.length >= input.maxCases) break;
    selected.push(testCase);
    selectedIds.add(testCase.id);
  }
  const coreIds = new Set(coreIdByKind.values());
  selected.sort((left, right) => Number(!coreIds.has(left.id)) - Number(!coreIds.has(right.id))
    || selectionCompare(left, right));

  const decisions = DEVTEST_CASE_DIMENSIONS.map((dimension): DevTestDimensionDecision => {
    const group = byDimension.get(dimension) ?? [];
    const selectedCases = selected.filter((testCase) => devTestDimensionOf(testCase.testType) === dimension).length;
    if (!enabled(dimension)) return {
      dimension, applicability: 'NOT_APPLICABLE', enabled: false,
      reason: '开发者通过 CLI 显式关闭该维度', candidateCases: group.length, selectedCases: 0,
    };
    if (!group.length) return {
      dimension, applicability: 'NOT_APPLICABLE', enabled: true,
      reason: 'Requirement、Risk 与 Contract 未产生该维度的可追溯目标；系统没有强行补猜', candidateCases: 0, selectedCases: 0,
    };
    const required = group.some((testCase) => testCase.priority === 'P0');
    return {
      dimension,
      applicability: required ? 'REQUIRED' : dimension === 'UI' ? 'OPTIONAL' : 'RECOMMENDED',
      enabled: true,
      reason: required
        ? '存在 P0 Requirement/Risk 目标，必须纳入初步验证'
        : '存在可追溯 Requirement/Risk 目标，按风险和 maxCases 选择',
      candidateCases: group.length,
      selectedCases,
    };
  });
  return {
    candidates: deduplicated.retained,
    selected,
    unselected: deduplicated.retained.filter((testCase) => !selectedIds.has(testCase.id)).map((testCase) => ({
      caseId: testCase.id,
      reason: !enabled(devTestDimensionOf(testCase.testType)) ? 'DIMENSION_DISABLED' as const
        : !input.deep && tierOf(testCase) === 'TIER_2' ? 'TIER_2_REQUIRES_DEEP' as const : 'MAX_CASES' as const,
    })),
    decisions,
    scores: Object.fromEntries(selected.map((testCase) => [testCase.id, scoreDevTestCase(testCase)])),
    profiles: Object.fromEntries(selected.map((testCase) => {
      const coreKind = coreKindOf(testCase);
      const isCore = Boolean(coreKind && coreIdByKind.get(coreKind) === testCase.id);
      return [testCase.id, {
        caseId: testCase.id,
        signature: caseSignature(testCase),
        informationScore: informationScore(testCase),
        core: isCore,
        coreKind: isCore ? coreKind : undefined,
      } satisfies DevTestCaseProfile];
    })),
    deduplication: {
      generated: candidates.length,
      retained: deduplicated.retained.length,
      removed: candidates.length - deduplicated.retained.length,
      groups: deduplicated.groups,
    },
    adaptiveScores: Object.fromEntries(selected.map((testCase) => [testCase.id, input.adaptiveScores?.[testCase.id] ?? {
      caseId: testCase.id, tier: tierOf(testCase), score: scoreDevTestCase(testCase).total,
      baseValue: scoreDevTestCase(testCase).total, historicalFailures: 0, bugDensity: 0,
      codeChangeFrequency: 0, contractDrift: 0, recentRegression: 0,
      executionCost: scoreDevTestCase(testCase).executionCost, reason: '无历史 Baseline，使用 Test Value Score',
    }])),
  };
}
