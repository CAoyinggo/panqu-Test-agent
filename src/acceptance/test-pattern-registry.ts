import type { AcceptanceRequirement, RequirementFact } from './requirement-ir.js';
import type { TestDimension } from './test-objective.js';
import type { ScenarioAssertionChannel, ScenarioEvidenceKind } from './scenario-contract.js';

export const TEST_PATTERN_IDS = [
  'FUNCTIONAL',
  'API_CONTRACT',
  'PERSISTENCE',
  'NON_MUTATION',
  'IDEMPOTENCY',
  'AUTHORIZATION',
  'TENANT_ISOLATION',
  'PROJECT_ISOLATION',
  'ATOMICITY',
  'STATE_MACHINE',
  'ASYNC',
  'BILLING',
  'PROVIDER_FAILURE',
  'CALLBACK',
  'BOUNDARY',
  'AUDIT',
  'SECURITY',
] as const;

export type TestPatternId = typeof TEST_PATTERN_IDS[number];

export type PatternProofObligationKind =
  | 'OPERATION_BINDING'
  | 'RESPONSE_ASSERTION'
  | 'IDENTITY_CONTEXT'
  | 'SCOPE_CONTEXT'
  | 'STATE_BEFORE'
  | 'STATE_AFTER'
  | 'STATE_TRANSITION'
  | 'NON_MUTATION'
  | 'ENTITY_COUNT'
  | 'SIDE_EFFECT_COUNT'
  | 'ATOMIC_ROLLBACK'
  | 'TERMINAL_STATE'
  | 'CORRELATION'
  | 'BILLING_DELTA'
  | 'EXTERNAL_CALL'
  | 'AUDIT_RECORD'
  | 'BOUNDARY_VECTOR'
  | 'NO_INFORMATION_LEAKAGE';

/**
 * Pattern 描述“必须证明什么”；它与 MIN/MAX、重复输入等 Test Strategy
 * 技术相互独立。
 */
export interface PatternProofObligation {
  id: string;
  kind: PatternProofObligationKind;
  description: string;
  channels: readonly ScenarioAssertionChannel[];
  evidenceKinds: readonly ScenarioEvidenceKind[];
  required: true;
}

export interface TestPatternDefinition {
  id: TestPatternId;
  title: string;
  description: string;
  dimensions: readonly TestDimension[];
  priority: 'P0' | 'P1';
  proofObligations: readonly PatternProofObligation[];
}

const obligation = (
  id: string,
  kind: PatternProofObligationKind,
  description: string,
  channels: readonly ScenarioAssertionChannel[],
  evidenceKinds: readonly ScenarioEvidenceKind[],
): PatternProofObligation => ({ id, kind, description, channels, evidenceKinds, required: true });

export const TEST_PATTERN_DEFINITIONS = [
  {
    id: 'FUNCTIONAL', title: 'Functional', priority: 'P0', dimensions: ['FUNCTIONAL'],
    description: '验证显式业务动作及其可判定结果。',
    proofObligations: [
      obligation('functional-response', 'RESPONSE_ASSERTION', '业务动作必须具有确定性结果断言。', ['RESPONSE'], ['RESPONSE']),
    ],
  },
  {
    id: 'API_CONTRACT', title: 'API Contract', priority: 'P0', dimensions: ['API'],
    description: '验证每个 API 动作精确绑定 Method、Path 与响应契约。',
    proofObligations: [
      obligation('api-operation-binding', 'OPERATION_BINDING', 'API Step 必须精确绑定 Method + Path。', ['API'], ['REQUEST']),
      obligation('api-response', 'RESPONSE_ASSERTION', '必须验证响应状态或响应体契约。', ['RESPONSE'], ['RESPONSE']),
    ],
  },
  {
    id: 'PERSISTENCE', title: 'Persistence', priority: 'P0', dimensions: ['FUNCTIONAL', 'STATE'],
    description: '验证写操作的响应与持久化后置状态。',
    proofObligations: [
      obligation('persistence-response', 'RESPONSE_ASSERTION', '写操作响应必须符合契约。', ['RESPONSE'], ['RESPONSE']),
      obligation('persistence-state-after', 'STATE_AFTER', '必须通过独立状态探针证明数据已持久化。', ['STATE', 'DATA', 'API'], ['STATE_AFTER', 'DATABASE', 'RESOURCE']),
    ],
  },
  {
    id: 'NON_MUTATION', title: 'Non-Mutation', priority: 'P0', dimensions: ['ERROR', 'SIDE_EFFECT'],
    description: '验证拒绝或失败操作没有改变业务数据和副作用。',
    proofObligations: [
      obligation('non-mutation-before', 'STATE_BEFORE', '操作前必须保存可比较状态。', ['STATE', 'DATA', 'API'], ['STATE_BEFORE', 'DATABASE', 'RESOURCE']),
      obligation('non-mutation-response', 'RESPONSE_ASSERTION', '必须证明请求被拒绝或失败。', ['RESPONSE'], ['RESPONSE']),
      obligation('non-mutation-after', 'NON_MUTATION', '操作后状态必须与操作前一致。', ['STATE', 'DATA', 'SIDE_EFFECT'], ['STATE_AFTER', 'DATABASE', 'RESOURCE']),
    ],
  },
  {
    id: 'IDEMPOTENCY', title: 'Idempotency', priority: 'P0', dimensions: ['BUSINESS_RULE', 'SIDE_EFFECT'],
    description: '验证重复调用不产生额外实体或副作用。',
    proofObligations: [
      obligation('idempotency-entity-count', 'ENTITY_COUNT', '重复调用后有效业务实体只能存在一份。', ['STATE', 'DATA'], ['STATE_AFTER', 'DATABASE', 'RESOURCE']),
      obligation('idempotency-side-effect-count', 'SIDE_EFFECT_COUNT', '重复调用后外部副作用不得重复。', ['SIDE_EFFECT', 'AUDIT', 'PROVIDER'], ['EVENT', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD']),
    ],
  },
  {
    id: 'AUTHORIZATION', title: 'Authorization', priority: 'P0', dimensions: ['AUTH', 'PERMISSION'],
    description: '验证 Actor、Role、Action 与 Resource 的访问决策。',
    proofObligations: [
      obligation('authorization-identity', 'IDENTITY_CONTEXT', '必须使用明确且可追溯的身份执行。', ['SYSTEM', 'API', 'UI'], ['REQUEST']),
      obligation('authorization-decision', 'RESPONSE_ASSERTION', '必须验证允许或拒绝结果。', ['RESPONSE', 'UI'], ['RESPONSE', 'SCREENSHOT']),
    ],
  },
  {
    id: 'TENANT_ISOLATION', title: 'Tenant Isolation', priority: 'P0', dimensions: ['DATA_ISOLATION', 'PERMISSION'],
    description: '验证跨租户资源不可访问或污染。',
    proofObligations: [
      obligation('tenant-scope', 'SCOPE_CONTEXT', 'Subject、Target 与 Tenant 归属必须明确。', ['SYSTEM', 'DATA'], ['RESOURCE']),
      obligation('tenant-no-leakage', 'NO_INFORMATION_LEAKAGE', '跨租户响应不得泄露资源信息。', ['RESPONSE', 'STATE'], ['RESPONSE', 'STATE_AFTER']),
    ],
  },
  {
    id: 'PROJECT_ISOLATION', title: 'Project Isolation', priority: 'P0', dimensions: ['DATA_ISOLATION', 'PERMISSION'],
    description: '验证跨项目资源不可访问或污染。',
    proofObligations: [
      obligation('project-scope', 'SCOPE_CONTEXT', 'Subject、Target 与 Project 归属必须明确。', ['SYSTEM', 'DATA'], ['RESOURCE']),
      obligation('project-no-leakage', 'NO_INFORMATION_LEAKAGE', '跨项目响应不得泄露资源信息。', ['RESPONSE', 'STATE'], ['RESPONSE', 'STATE_AFTER']),
    ],
  },
  {
    id: 'ATOMICITY', title: 'Atomicity', priority: 'P0', dimensions: ['BUSINESS_RULE', 'STATE', 'SIDE_EFFECT'],
    description: '验证部分失败时所有参与项同时回滚。',
    proofObligations: [
      obligation('atomic-before', 'STATE_BEFORE', '保存所有原子参与项的执行前状态。', ['STATE', 'DATA'], ['STATE_BEFORE', 'DATABASE', 'RESOURCE']),
      obligation('atomic-rollback', 'ATOMIC_ROLLBACK', '部分失败后所有参与项必须回滚。', ['STATE', 'DATA', 'SIDE_EFFECT'], ['STATE_AFTER', 'DATABASE', 'RESOURCE', 'EVENT']),
    ],
  },
  {
    id: 'STATE_MACHINE', title: 'State Machine', priority: 'P0', dimensions: ['STATE', 'ERROR'],
    description: '验证合法与非法状态转换及终态。',
    proofObligations: [
      obligation('state-before', 'STATE_BEFORE', '必须证明转换前状态。', ['STATE', 'DATA'], ['STATE_BEFORE', 'DATABASE', 'RESOURCE']),
      obligation('state-transition', 'STATE_TRANSITION', '必须证明合法终态或非法转换保持不变。', ['STATE', 'DATA'], ['STATE_AFTER', 'DATABASE', 'RESOURCE']),
    ],
  },
  {
    id: 'ASYNC', title: 'Async Task', priority: 'P0', dimensions: ['STATE', 'SIDE_EFFECT'],
    description: '验证异步任务从提交到确定性终态。',
    proofObligations: [
      obligation('async-correlation', 'CORRELATION', '提交响应、任务查询与回调必须使用同一关联标识。', ['API', 'QUEUE', 'PROVIDER'], ['RESPONSE', 'EVENT', 'QUEUE_MESSAGE']),
      obligation('async-terminal-state', 'TERMINAL_STATE', '必须等待并证明任务最终进入允许的终态。', ['STATE', 'API', 'QUEUE'], ['STATE_AFTER', 'EVENT', 'RESOURCE']),
    ],
  },
  {
    id: 'BILLING', title: 'Billing', priority: 'P0', dimensions: ['SIDE_EFFECT', 'BUSINESS_RULE'],
    description: '验证余额、账单记录及扣费/退款次数一致。',
    proofObligations: [
      obligation('billing-before', 'STATE_BEFORE', '扣费前必须记录余额或账户状态。', ['STATE', 'DATA', 'PROVIDER'], ['STATE_BEFORE', 'BILLING_RECORD']),
      obligation('billing-delta', 'BILLING_DELTA', '扣费后余额变化和账单记录必须精确匹配。', ['SIDE_EFFECT', 'DATA', 'PROVIDER'], ['STATE_AFTER', 'BILLING_RECORD']),
      obligation('billing-count', 'SIDE_EFFECT_COUNT', '重试、失败或回调不得产生重复扣费/退款。', ['SIDE_EFFECT', 'PROVIDER'], ['BILLING_RECORD', 'PROVIDER_CALL']),
    ],
  },
  {
    id: 'PROVIDER_FAILURE', title: 'Provider Failure', priority: 'P0', dimensions: ['ERROR', 'SIDE_EFFECT'],
    description: '验证第三方失败、超时及重试下的本地状态和副作用。',
    proofObligations: [
      obligation('provider-call', 'EXTERNAL_CALL', '必须记录 Provider 调用、返回或超时证据。', ['PROVIDER'], ['PROVIDER_CALL', 'TRACE']),
      obligation('provider-failure-state', 'STATE_AFTER', 'Provider 失败后本地状态必须可判定。', ['STATE', 'DATA'], ['STATE_AFTER', 'DATABASE', 'RESOURCE']),
      obligation('provider-failure-side-effect', 'SIDE_EFFECT_COUNT', '失败或重试不得制造重复外部副作用。', ['SIDE_EFFECT', 'PROVIDER'], ['PROVIDER_CALL', 'BILLING_RECORD', 'EVENT']),
    ],
  },
  {
    id: 'CALLBACK', title: 'Callback', priority: 'P0', dimensions: ['STATE', 'SIDE_EFFECT'],
    description: '验证重复、乱序和迟到回调的相关性与幂等处理。',
    proofObligations: [
      obligation('callback-correlation', 'CORRELATION', '回调必须绑定到唯一任务或资源。', ['PROVIDER', 'QUEUE'], ['EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL']),
      obligation('callback-final-state', 'TERMINAL_STATE', '重复或迟到回调不能覆盖非法终态。', ['STATE', 'DATA'], ['STATE_AFTER', 'DATABASE', 'RESOURCE']),
      obligation('callback-side-effect-count', 'SIDE_EFFECT_COUNT', '重复回调不得重复触发副作用。', ['SIDE_EFFECT', 'PROVIDER'], ['EVENT', 'BILLING_RECORD', 'AUDIT_RECORD']),
    ],
  },
  {
    id: 'BOUNDARY', title: 'Boundary', priority: 'P1', dimensions: ['BOUNDARY', 'PARAMETER_VALIDATION'],
    description: '验证显式范围、长度、格式、枚举和空值约束。',
    proofObligations: [
      obligation('boundary-vector', 'BOUNDARY_VECTOR', '输入必须可追溯到一个显式约束及有效/无效向量。', ['SYSTEM', 'API', 'UI'], ['REQUEST']),
      obligation('boundary-response', 'RESPONSE_ASSERTION', '每个向量必须有明确接受或拒绝结果。', ['RESPONSE', 'UI'], ['RESPONSE', 'SCREENSHOT']),
    ],
  },
  {
    id: 'AUDIT', title: 'Audit', priority: 'P0', dimensions: ['SIDE_EFFECT'],
    description: '验证审计记录与 Actor、Action、Resource 和结果一致。',
    proofObligations: [
      obligation('audit-record', 'AUDIT_RECORD', '必须查询并关联唯一审计记录。', ['AUDIT', 'DATA'], ['AUDIT_RECORD', 'DATABASE']),
      obligation('audit-correlation', 'CORRELATION', '审计记录必须关联本次 Actor、资源和请求。', ['AUDIT', 'SYSTEM'], ['AUDIT_RECORD', 'TRACE']),
    ],
  },
  {
    id: 'SECURITY', title: 'Security', priority: 'P1', dimensions: ['SECURITY'],
    description: '验证显式安全约束、无越权和无敏感信息泄露。',
    proofObligations: [
      obligation('security-result', 'RESPONSE_ASSERTION', '攻击或越权输入必须得到明确安全结果。', ['RESPONSE', 'UI'], ['RESPONSE', 'SCREENSHOT']),
      obligation('security-no-leakage', 'NO_INFORMATION_LEAKAGE', '响应、日志和错误中不得泄露敏感信息。', ['RESPONSE', 'SYSTEM'], ['RESPONSE', 'LOG', 'TRACE']),
    ],
  },
] as const satisfies readonly TestPatternDefinition[];

/** 便于模板/文档生成器使用的小写别名；两者引用同一份定义。 */
export const testPatternDefinitions: readonly TestPatternDefinition[] = TEST_PATTERN_DEFINITIONS;
export const definitions: readonly TestPatternDefinition[] = TEST_PATTERN_DEFINITIONS;

function buildPatternRegistry(): Readonly<Record<TestPatternId, TestPatternDefinition>> {
  const registry = {} as Record<TestPatternId, TestPatternDefinition>;
  for (const definition of TEST_PATTERN_DEFINITIONS) registry[definition.id] = definition;
  return Object.freeze(registry);
}

export const TEST_PATTERN_REGISTRY = buildPatternRegistry();

export interface SelectedTestPattern {
  id: TestPatternId;
  definition: TestPatternDefinition;
  factIds: string[];
  reasons: string[];
  source: 'STRUCTURED_FACT' | 'EXPLICIT' | 'EXPLICIT_AND_STRUCTURED';
}

const BOUNDARY_CONSTRAINTS = new Set([
  'REQUIRED', 'NULLABLE', 'TYPE', 'RANGE', 'LENGTH', 'FORMAT', 'ENUM',
]);

function normativeFacts(requirement: AcceptanceRequirement): RequirementFact[] {
  return requirement.factLedger.filter((fact) => fact.normativity === 'NORMATIVE');
}

function hasConstraint(fact: RequirementFact, kind: string): boolean {
  return fact.canonical.constraints.some((constraint) => constraint.kind === kind);
}

function hasAnyConstraint(fact: RequirementFact, kinds: ReadonlySet<string>): boolean {
  return fact.canonical.constraints.some((constraint) => kinds.has(constraint.kind));
}

function hasSideEffect(fact: RequirementFact, kind: string): boolean {
  return fact.canonical.sideEffects.some((sideEffect) => sideEffect.kind === kind);
}

function isMutation(fact: RequirementFact, requirement: AcceptanceRequirement): boolean {
  if (['CREATE', 'UPDATE', 'DELETE', 'CHARGE', 'ROLLBACK'].includes(fact.canonical.action.kind)) return true;
  const apiIds = new Set(fact.entityRefs.apiSpecIds);
  const operationKey = fact.canonical.action.operationKey;
  return requirement.apis.some((api) => (apiIds.has(api.id) || api.operationKey === operationKey)
    && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(api.method));
}

function isRejected(fact: RequirementFact): boolean {
  const expected = fact.canonical.expected;
  return ['DENY', 'FAILURE', 'INVALID', 'NOT_FOUND', 'UNCHANGED'].includes(expected.kind)
    || expected.status !== undefined && expected.status >= 400;
}

function hasScope(fact: RequirementFact, dimension: 'TENANT' | 'PROJECT'): boolean {
  return fact.canonical.scopes.some((scope) => scope.dimension === dimension);
}

function factsForPattern(
  pattern: TestPatternId,
  requirement: AcceptanceRequirement,
  facts: RequirementFact[],
): RequirementFact[] {
  switch (pattern) {
    case 'FUNCTIONAL':
      return facts.filter((fact) => fact.category === 'FUNCTIONAL'
        || ['CREATE', 'READ', 'UPDATE', 'DELETE', 'SUBMIT'].includes(fact.canonical.action.kind));
    case 'API_CONTRACT':
      return facts.filter((fact) => fact.category === 'API'
        || fact.entityRefs.apiSpecIds.length > 0
        || Boolean(fact.canonical.action.operationKey));
    case 'PERSISTENCE':
      return facts.filter((fact) => isMutation(fact, requirement) && !isRejected(fact));
    case 'NON_MUTATION':
      return facts.filter((fact) => isMutation(fact, requirement) && isRejected(fact));
    case 'IDEMPOTENCY':
      return facts.filter((fact) => hasConstraint(fact, 'IDEMPOTENT'));
    case 'AUTHORIZATION':
      return facts.filter((fact) => fact.category === 'AUTH' || fact.category === 'PERMISSION'
        || fact.canonical.constraints.some((constraint) => ['ROLE_REQUIRED', 'OWNER_ONLY', 'AUTH_NOT_REQUIRED'].includes(constraint.kind)));
    case 'TENANT_ISOLATION':
      return facts.filter((fact) => hasScope(fact, 'TENANT'));
    case 'PROJECT_ISOLATION':
      return facts.filter((fact) => hasScope(fact, 'PROJECT'));
    case 'ATOMICITY':
      return facts.filter((fact) => hasConstraint(fact, 'ATOMIC'));
    case 'STATE_MACHINE':
      return facts.filter((fact) => fact.category === 'STATE' || hasConstraint(fact, 'STATE_TRANSITION'));
    case 'ASYNC': {
      const hasSubmit = facts.some((fact) => fact.canonical.action.kind === 'SUBMIT');
      const hasState = facts.some((fact) => fact.category === 'STATE' || hasConstraint(fact, 'STATE_TRANSITION'));
      const hasEventEvidence = facts.some((fact) => fact.canonical.sideEffects.some((sideEffect) => sideEffect.observation === 'EVENT'));
      return hasSubmit && (hasState || hasEventEvidence)
        ? facts.filter((fact) => fact.canonical.action.kind === 'SUBMIT' || fact.category === 'STATE'
          || fact.canonical.sideEffects.some((sideEffect) => sideEffect.observation === 'EVENT'))
        : [];
    }
    case 'BILLING':
      return facts.filter((fact) => fact.canonical.action.kind === 'CHARGE' || hasSideEffect(fact, 'BILLING'));
    case 'PROVIDER_FAILURE': {
      const external = facts.filter((fact) => hasSideEffect(fact, 'EXTERNAL'));
      const failures = facts.filter((fact) => fact.category === 'ERROR' || isRejected(fact));
      return external.length && failures.length ? [...new Set([...external, ...failures])] : [];
    }
    case 'CALLBACK': {
      const eventFacts = facts.filter((fact) => fact.canonical.sideEffects.some((sideEffect) =>
        sideEffect.observation === 'EVENT' || sideEffect.kind === 'EXTERNAL'));
      const deliveryRules = facts.filter((fact) => hasConstraint(fact, 'ORDERING') || hasConstraint(fact, 'IDEMPOTENT'));
      return eventFacts.length && deliveryRules.length ? [...new Set([...eventFacts, ...deliveryRules])] : [];
    }
    case 'BOUNDARY':
      return facts.filter((fact) => fact.category === 'BOUNDARY' || fact.category === 'VALIDATION'
        || hasAnyConstraint(fact, BOUNDARY_CONSTRAINTS));
    case 'AUDIT':
      return facts.filter((fact) => hasSideEffect(fact, 'AUDIT'));
    case 'SECURITY':
      return facts.filter((fact) => fact.category === 'SECURITY');
  }
}

function reasonFor(fact: RequirementFact): string {
  const constraints = [...new Set(fact.canonical.constraints.map((constraint) => constraint.kind))];
  const sideEffects = [...new Set(fact.canonical.sideEffects.map((sideEffect) => sideEffect.kind))];
  const scopes = [...new Set(fact.canonical.scopes.map((scope) => scope.dimension))];
  return [
    `Fact ${fact.id}`,
    `category=${fact.category}`,
    `action=${fact.canonical.action.kind}`,
    constraints.length ? `constraints=${constraints.join(',')}` : '',
    scopes.length ? `scopes=${scopes.join(',')}` : '',
    sideEffects.length ? `sideEffects=${sideEffects.join(',')}` : '',
  ].filter(Boolean).join('；');
}

function isPatternId(value: string): value is TestPatternId {
  return (TEST_PATTERN_IDS as readonly string[]).includes(value);
}

/**
 * 只消费 AcceptanceRequirement 的结构化 Fact/Constraint/Scope/SideEffect/API
 * 投影。严禁在这里扫描 statement、source.text 或原始 Markdown。
 */
export function selectTestPatterns(
  requirement: AcceptanceRequirement,
  explicit: readonly TestPatternId[] = [],
): SelectedTestPattern[] {
  for (const id of explicit as readonly string[]) {
    if (!isPatternId(id)) throw new Error(`UNKNOWN_TEST_PATTERN：${id}`);
  }
  const explicitIds = new Set<TestPatternId>(explicit);
  const facts = normativeFacts(requirement);
  const selections: SelectedTestPattern[] = [];
  for (const definition of TEST_PATTERN_DEFINITIONS) {
    const matched = factsForPattern(definition.id, requirement, facts);
    const selectedExplicitly = explicitIds.has(definition.id);
    if (!matched.length && !selectedExplicitly) continue;
    selections.push({
      id: definition.id,
      definition,
      factIds: [...new Set(matched.map((fact) => fact.id))],
      reasons: [
        ...matched.map(reasonFor),
        ...(selectedExplicitly ? [`Pattern ${definition.id} 由调用方显式选择`] : []),
      ],
      source: selectedExplicitly
        ? matched.length ? 'EXPLICIT_AND_STRUCTURED' : 'EXPLICIT'
        : 'STRUCTURED_FACT',
    });
  }
  return selections;
}
