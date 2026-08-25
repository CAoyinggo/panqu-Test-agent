import type { TestCaseSourceType } from '../agents/test-design/testcase-schema.js';
import type {
  CanonicalActionKind,
  CanonicalConstraintKind,
  CanonicalExpectedKind,
  CanonicalRequirementFact,
  RequirementFact,
  RequirementFactCategory,
  RequirementFactProvenance,
} from './requirement-ir.js';
import type { TestDimension, TestObjective } from './test-objective.js';

export type TestStrategyKind =
  | 'POSITIVE'
  | 'NEGATIVE'
  | 'API_CONTRACT'
  | 'REQUIRED_MISSING'
  | 'VALID_INVALID'
  | 'MIN_MAX_BOUNDARY'
  | 'FORMAT_VALID_INVALID'
  | 'ENUM_VALID_INVALID'
  | 'ALLOW_DENY'
  | 'SAME_CROSS_SCOPE'
  | 'VALID_INVALID_TRANSITION'
  | 'DUPLICATE'
  | 'REPEAT'
  | 'PARTIAL_FAILURE'
  | 'REORDER'
  | 'EXPECTED_FAILURE'
  | 'BEFORE_AFTER_STATE'
  | 'UI_BEHAVIOR'
  | 'AUTHENTICATION'
  | 'SECURITY_REVIEW'
  | 'COMPATIBILITY_CHECK'
  | 'PERFORMANCE_CHECK'
  | 'CLEANUP_CHECK';

export interface TestStrategyPolicyRule {
  id: string;
  description: string;
  when: {
    categories?: RequirementFactCategory[];
    constraintKinds?: CanonicalConstraintKind[];
    expectedKinds?: CanonicalExpectedKind[];
    actionKinds?: CanonicalActionKind[];
    statusClass?: 'SUCCESS' | 'ERROR';
    hasScope?: boolean;
    hasSideEffect?: boolean;
  };
  dimension: TestDimension;
  strategies: TestStrategyKind[];
}

/**
 * Fact → Strategy 的唯一规则表。规则只读取 CanonicalRequirementFact，绝不
 * 重新解析 statement。后续新增策略必须先扩展 Normalizer/此表，而不是塞进 Generator。
 */
export const TEST_STRATEGY_POLICY: readonly TestStrategyPolicyRule[] = [
  { id: 'FUNCTIONAL_CRUD', description: '功能行为形成最小正/负向策略', when: { categories: ['FUNCTIONAL'] }, dimension: 'FUNCTIONAL', strategies: ['POSITIVE', 'NEGATIVE'] },
  { id: 'UI_BEHAVIOR', description: 'UI 事实保留可观察交互/状态设计', when: { categories: ['UI'] }, dimension: 'UI', strategies: ['UI_BEHAVIOR'] },
  { id: 'API_CONTRACT', description: '显式 API/Response 契约', when: { categories: ['API'] }, dimension: 'API', strategies: ['API_CONTRACT'] },
  {
    id: 'API_CRUD_FUNCTION', description: '带显式结果的 API CRUD Fact 同时形成业务功能目标',
    when: {
      categories: ['API'], actionKinds: ['CREATE', 'READ', 'UPDATE', 'DELETE'],
      expectedKinds: ['ALLOW', 'DENY', 'SUCCESS', 'FAILURE', 'NOT_FOUND', 'EMPTY', 'UNCHANGED', 'STATE_CHANGED', 'VISIBLE', 'HIDDEN', 'VALID', 'INVALID', 'STATUS'],
    },
    dimension: 'FUNCTIONAL', strategies: ['POSITIVE', 'NEGATIVE'],
  },
  { id: 'PARAMETER_CONTRACT', description: '参数约束只生成适用的合法/非法策略', when: { categories: ['VALIDATION'] }, dimension: 'PARAMETER_VALIDATION', strategies: ['VALID_INVALID'] },
  { id: 'REQUIRED', description: '必填约束生成 Missing', when: { constraintKinds: ['REQUIRED'] }, dimension: 'PARAMETER_VALIDATION', strategies: ['REQUIRED_MISSING'] },
  { id: 'RANGE_BOUNDARY', description: 'Range 生成 Min/Max 适用边界', when: { constraintKinds: ['RANGE'] }, dimension: 'BOUNDARY', strategies: ['MIN_MAX_BOUNDARY'] },
  { id: 'LENGTH_BOUNDARY', description: 'Length 生成 Min/Max 适用边界', when: { constraintKinds: ['LENGTH'] }, dimension: 'BOUNDARY', strategies: ['MIN_MAX_BOUNDARY'] },
  { id: 'FORMAT', description: 'Format 生成 Valid/Invalid', when: { constraintKinds: ['FORMAT'] }, dimension: 'PARAMETER_VALIDATION', strategies: ['FORMAT_VALID_INVALID'] },
  { id: 'ENUM', description: 'Enum 生成 Valid/Invalid', when: { constraintKinds: ['ENUM'] }, dimension: 'PARAMETER_VALIDATION', strategies: ['ENUM_VALID_INVALID'] },
  { id: 'AUTH', description: '认证约束', when: { categories: ['AUTH'] }, dimension: 'AUTH', strategies: ['AUTHENTICATION'] },
  { id: 'PERMISSION', description: 'Actor × Action × Resource 的显式允许/拒绝', when: { categories: ['PERMISSION'] }, dimension: 'PERMISSION', strategies: ['ALLOW_DENY'] },
  { id: 'ISOLATION', description: 'Subject × Target × Scope 的同域/跨域策略', when: { hasScope: true }, dimension: 'DATA_ISOLATION', strategies: ['SAME_CROSS_SCOPE'] },
  { id: 'ISOLATION_PERMISSION', description: '隔离事实同时属于访问控制验证', when: { categories: ['DATA_ISOLATION'], hasScope: true }, dimension: 'PERMISSION', strategies: ['ALLOW_DENY'] },
  { id: 'ATOMIC', description: '原子规则验证部分失败与回滚', when: { constraintKinds: ['ATOMIC'] }, dimension: 'BUSINESS_RULE', strategies: ['PARTIAL_FAILURE', 'BEFORE_AFTER_STATE'] },
  { id: 'UNIQUE', description: '唯一规则验证重复实体', when: { constraintKinds: ['UNIQUE'] }, dimension: 'BUSINESS_RULE', strategies: ['DUPLICATE'] },
  { id: 'IDEMPOTENT', description: '幂等规则验证重复调用', when: { constraintKinds: ['IDEMPOTENT'] }, dimension: 'BUSINESS_RULE', strategies: ['REPEAT'] },
  { id: 'ORDERING', description: '顺序规则验证重排', when: { constraintKinds: ['ORDERING'] }, dimension: 'BUSINESS_RULE', strategies: ['REORDER'] },
  { id: 'BUSINESS_RULE', description: '其他显式业务规则保留目标，不扩写语义', when: { categories: ['BUSINESS_RULE'] }, dimension: 'BUSINESS_RULE', strategies: ['POSITIVE'] },
  { id: 'STATE_TRANSITION', description: '状态规则验证合法/非法流转', when: { constraintKinds: ['STATE_TRANSITION'] }, dimension: 'STATE', strategies: ['VALID_INVALID_TRANSITION'] },
  { id: 'STATE', description: '状态事实形成状态验证', when: { categories: ['STATE'] }, dimension: 'STATE', strategies: ['BEFORE_AFTER_STATE'] },
  { id: 'STATE_ERROR', description: '状态事实显式声明 4xx/5xx 时形成错误路径', when: { categories: ['STATE'], statusClass: 'ERROR' }, dimension: 'ERROR', strategies: ['EXPECTED_FAILURE'] },
  { id: 'UI_STATE', description: 'UI loading/disabled 等显式状态进入 State 维度', when: { categories: ['UI'], constraintKinds: ['UI_STATE'] }, dimension: 'STATE', strategies: ['BEFORE_AFTER_STATE'] },
  { id: 'UI_ERROR', description: 'UI 显式错误结果进入 Error 维度', when: { categories: ['UI'], constraintKinds: ['EXPECTED_ERROR'] }, dimension: 'ERROR', strategies: ['EXPECTED_FAILURE'] },
  { id: 'ERROR', description: '显式错误事实验证 Expected Failure', when: { categories: ['ERROR'] }, dimension: 'ERROR', strategies: ['EXPECTED_FAILURE'] },
  { id: 'SIDE_EFFECT', description: '副作用必须比较前后状态/外部证据', when: { hasSideEffect: true }, dimension: 'SIDE_EFFECT', strategies: ['BEFORE_AFTER_STATE'] },
  { id: 'CLEANUP', description: '清理事实验证回收状态', when: { categories: ['CLEANUP'] }, dimension: 'CLEANUP', strategies: ['CLEANUP_CHECK'] },
  { id: 'SECURITY', description: '显式安全事实', when: { categories: ['SECURITY'] }, dimension: 'SECURITY', strategies: ['SECURITY_REVIEW'] },
  { id: 'COMPATIBILITY', description: '显式兼容事实', when: { categories: ['COMPATIBILITY'] }, dimension: 'COMPATIBILITY', strategies: ['COMPATIBILITY_CHECK'] },
  { id: 'PERFORMANCE', description: '显式性能事实', when: { categories: ['PERFORMANCE'] }, dimension: 'PERFORMANCE', strategies: ['PERFORMANCE_CHECK'] },
] as const;

export interface TestStrategyDecision {
  id: string;
  factId: string;
  dimension: TestDimension;
  policyRuleIds: string[];
  strategies: TestStrategyKind[];
  expectedOutcome: string;
  outcomeStatus: 'KNOWN' | 'UNKNOWN';
  priority: TestObjective['priority'];
  risk?: string;
  executionTarget: TestObjective['executionTarget'];
  sourceType: TestCaseSourceType;
  provenance: RequirementFactProvenance;
  canonical: CanonicalRequirementFact;
}

export interface FactTestStrategyPlan {
  decisions: TestStrategyDecision[];
  optionalDimensions: TestDimension[];
}

function sourceType(provenance: RequirementFactProvenance): TestCaseSourceType {
  if (provenance === 'CONTRACT' || provenance === 'CONFIGURED') return 'CONTRACT';
  if (provenance === 'INFERRED' || provenance === 'UNKNOWN') return 'HEURISTIC';
  return 'REQUIREMENT';
}

function matches(rule: TestStrategyPolicyRule, fact: RequirementFact): boolean {
  const canonical = fact.canonical;
  const clauses: boolean[] = [];
  if (rule.when.categories) clauses.push(rule.when.categories.includes(fact.category));
  if (rule.when.constraintKinds) clauses.push(rule.when.constraintKinds.some((kind) => canonical.constraints.some((constraint) => constraint.kind === kind)));
  if (rule.when.expectedKinds) clauses.push(rule.when.expectedKinds.includes(canonical.expected.kind));
  if (rule.when.actionKinds) clauses.push(rule.when.actionKinds.includes(canonical.action.kind));
  if (rule.when.statusClass) clauses.push(canonical.expected.status !== undefined
    && (rule.when.statusClass === 'ERROR' ? canonical.expected.status >= 400 : canonical.expected.status >= 200 && canonical.expected.status < 400));
  if (rule.when.hasScope !== undefined) clauses.push((canonical.scopes.length > 0) === rule.when.hasScope);
  if (rule.when.hasSideEffect !== undefined) clauses.push((canonical.sideEffects.length > 0) === rule.when.hasSideEffect);
  return clauses.length > 0 && clauses.every(Boolean);
}

function priority(dimension: TestDimension): TestObjective['priority'] {
  if (['AUTH', 'PERMISSION', 'DATA_ISOLATION', 'BUSINESS_RULE', 'STATE', 'SECURITY', 'SIDE_EFFECT'].includes(dimension)) return 'P0';
  if (['FUNCTIONAL', 'API', 'PARAMETER_VALIDATION', 'ERROR', 'BOUNDARY', 'CLEANUP'].includes(dimension)) return 'P1';
  return 'P2';
}

function risk(dimension: TestDimension): string | undefined {
  if (dimension === 'DATA_ISOLATION') return '跨数据范围泄露或污染';
  if (dimension === 'PERMISSION' || dimension === 'AUTH' || dimension === 'SECURITY') return '身份或权限绕过';
  if (dimension === 'BUSINESS_RULE' || dimension === 'STATE') return '业务状态与需求不一致';
  if (dimension === 'SIDE_EFFECT' || dimension === 'CLEANUP') return '重复副作用或测试数据残留';
  return undefined;
}

function executionTarget(dimension: TestDimension, apiSpecIds: string[]): TestObjective['executionTarget'] {
  if (dimension === 'UI') return 'UI';
  if (dimension === 'DATA_ISOLATION' || dimension === 'SIDE_EFFECT' || dimension === 'CLEANUP') return apiSpecIds.length ? 'HYBRID' : 'DATA';
  if (apiSpecIds.length || dimension === 'API' || dimension === 'PARAMETER_VALIDATION' || dimension === 'BOUNDARY'
    || dimension === 'AUTH' || dimension === 'PERMISSION' || dimension === 'ERROR') return 'API';
  return 'FUNCTIONAL';
}

function expected(fact: RequirementFact, dimension: TestDimension): { value: string; known: boolean } {
  const canonical = fact.canonical;
  if (dimension === 'API' && canonical.action.operationKey && canonical.expected.kind === 'UNKNOWN') {
    return {
      value: `${canonical.action.operationKey} 必须唯一绑定到 Requirement ApiSpec；HTTP 结果必须由 Response 或 AC 契约另行判定`,
      known: true,
    };
  }
  if (dimension === 'BUSINESS_RULE' && canonical.constraints.some((constraint) => constraint.kind === 'ATOMIC')) {
    return { value: '所有显式原子参与项必须全部成功，或在任一失败时全部回滚，不允许部分成功', known: true };
  }
  if (dimension === 'BUSINESS_RULE' && canonical.constraints.some((constraint) => constraint.kind === 'UNIQUE')) {
    return { value: '首次满足唯一约束的操作成功；重复值被拒绝且不产生第二个有效实体', known: true };
  }
  if (dimension === 'BUSINESS_RULE' && canonical.constraints.some((constraint) => constraint.kind === 'IDEMPOTENT')) {
    return { value: '重复执行不产生额外业务实体或副作用，最终状态与单次执行一致', known: true };
  }
  if (dimension === 'PARAMETER_VALIDATION' || dimension === 'BOUNDARY') {
    const explicit = canonical.constraints.filter((constraint) => ['REQUIRED', 'NULLABLE', 'TYPE', 'RANGE', 'LENGTH', 'FORMAT', 'ENUM'].includes(constraint.kind));
    return {
      value: explicit.length ? `满足显式约束（${explicit.map((item) => item.expression).join('；')}）的值被接受，违反约束的值被拒绝` : fact.statement,
      known: explicit.length > 0,
    };
  }
  return {
    value: canonical.expected.expression ?? fact.statement,
    known: canonical.expected.explicit && canonical.expected.kind !== 'UNKNOWN',
  };
}

function optionalDimensions(required: Set<TestDimension>, canonical: CanonicalRequirementFact): TestDimension[] {
  const optional = new Set<TestDimension>();
  if (required.has('PERMISSION') || required.has('DATA_ISOLATION') || required.has('AUTH')) optional.add('SECURITY');
  if (required.has('SIDE_EFFECT') && !required.has('CLEANUP')) optional.add('CLEANUP');
  if (required.has('API') && ['CREATE', 'UPDATE', 'DELETE'].includes(canonical.action.kind) && !required.has('ERROR')) optional.add('ERROR');
  return [...optional];
}

/** Canonical RequirementFact → 最小充分 Test Strategy。 */
export function buildFactTestStrategy(fact: RequirementFact, apiSpecIds: string[]): FactTestStrategyPlan {
  const matched = TEST_STRATEGY_POLICY.filter((rule) => matches(rule, fact));
  const byDimension = new Map<TestDimension, TestStrategyPolicyRule[]>();
  for (const rule of matched) {
    const group = byDimension.get(rule.dimension) ?? [];
    group.push(rule);
    byDimension.set(rule.dimension, group);
  }
  const decisions = [...byDimension].map(([dimension, rules]): TestStrategyDecision => {
    const oracle = expected(fact, dimension);
    return {
      id: `STRATEGY-${fact.id}-${dimension}`,
      factId: fact.id,
      dimension,
      policyRuleIds: rules.map((rule) => rule.id),
      strategies: [...new Set(rules.flatMap((rule) => rule.strategies))],
      expectedOutcome: oracle.value,
      outcomeStatus: oracle.known ? 'KNOWN' : 'UNKNOWN',
      priority: priority(dimension),
      risk: risk(dimension),
      executionTarget: executionTarget(dimension, apiSpecIds),
      sourceType: sourceType(fact.provenance),
      provenance: fact.provenance,
      canonical: fact.canonical,
    };
  });
  return { decisions, optionalDimensions: optionalDimensions(new Set(byDimension.keys()), fact.canonical) };
}
