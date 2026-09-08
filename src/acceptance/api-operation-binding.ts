import type {
  AcceptanceRequirement,
  ApiBindingIssue,
  ApiOperationBinding,
  ApiSpec,
} from './requirement-ir.js';
import type { TestPoint } from './test-point.js';

export type ApiBindingDecision =
  | { binding: ApiOperationBinding; issue?: never }
  | { binding?: never; issue: ApiBindingIssue };

export interface ApiBindingIndex {
  idsUnique: boolean;
  byOperationKey: Map<string, ApiSpec[]>;
}

export function createApiBindingIndex(requirement: AcceptanceRequirement): ApiBindingIndex {
  const ids = new Set<string>();
  let idsUnique = true;
  const byOperationKey = new Map<string, ApiSpec[]>();
  for (const api of requirement.apis) {
    if (ids.has(api.id)) idsUnique = false;
    ids.add(api.id);
    const candidates = byOperationKey.get(api.operationKey) ?? [];
    candidates.push(api);
    byOperationKey.set(api.operationKey, candidates);
  }
  return { idsUnique, byOperationKey };
}

const OPERATION_PATTERN = /\b(GET|HEAD|POST|PUT|PATCH|DELETE)\s+(\/[^\s|`，。,;；]+)/gi;

const ACTION_METHODS: Partial<Record<TestPoint['canonicalFact']['action']['kind'], readonly ApiSpec['method'][]>> = {
  CREATE: ['POST'], READ: ['GET', 'HEAD'], UPDATE: ['PUT', 'PATCH'], DELETE: ['DELETE'],
  SUBMIT: ['POST'], TRANSITION: ['POST', 'PUT', 'PATCH'], CHARGE: ['POST'],
  ROLLBACK: ['POST', 'PUT', 'PATCH'], ACCESS: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
};

const RESOURCE_ALIASES: Record<string, readonly string[]> = {
  USER_PROFILE: ['profile', 'profiles', 'user', 'users'],
  USER_DATA: ['user', 'users', 'data'], TENANT_DATA: ['tenant', 'tenants', 'data'],
  ORDER: ['order', 'orders'], RESOURCE: ['resource', 'resources'], TASK: ['task', 'tasks'],
  PROJECT: ['project', 'projects'], ACCOUNT: ['account', 'accounts'], RECORD: ['record', 'records'],
};

function pathTokens(path: string): string[] {
  return path.split('/').filter((part) => part && !part.startsWith('{'))
    .map((part) => part.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
    .filter((part) => part && part !== 'api' && !/^v\d+$/.test(part));
}

function singular(value: string): string {
  return value.replace(/ies$/i, 'y').replace(/s$/i, '');
}

function resourceMatches(point: TestPoint, api: ApiSpec): boolean {
  const kind = point.canonicalFact.resource.kind;
  if (kind === 'UNKNOWN') return false;
  const aliases = RESOURCE_ALIASES[kind] ?? [kind.toLowerCase(), kind.toLowerCase().replace(/_/g, '-')];
  const tokens = pathTokens(api.path);
  return tokens.some((token) => aliases.some((alias) => singular(token) === singular(alias)));
}

function actionPathTokens(point: TestPoint): string[] {
  const text = `${point.canonicalFact.action.expression ?? ''} ${point.objective}`;
  const result: string[] = [];
  // “取消未支付订单”中的“支付”是状态修饰语，不是 pay 动作。更具体的
  // cancel/submit/recover 动词优先，避免把状态词同时绑定到多个 Operation。
  if (/(?:取消|cancel)/i.test(text)) return ['cancel', 'cancellation'];
  if (/(?:提交|submit)/i.test(text)) result.push('submit');
  if (/(?:恢复|重试|recover|retry)/i.test(text)) result.push('recover', 'retry');
  if (/(?:支付|付款|扣款|pay(?:ment)?|charge|billing)/i.test(text)) result.push('pay', 'payment', 'charge', 'billing');
  return result;
}

function semanticCandidates(requirement: AcceptanceRequirement, point: TestPoint): ApiSpec[] {
  const actionTokens = actionPathTokens(point);
  // 状态规则常被 canonical 化为 TRANSITION，部分错误/恢复 Fact 甚至没有
  // 单一 Action kind；当需求明确给出 pay/cancel/retry 等业务动作时，允许
  // 这些确定性的 path token 限定写 Operation，但仍要求最终唯一匹配。
  const methods = ACTION_METHODS[point.canonicalFact.action.kind]
    ?? (actionTokens.length ? ['POST', 'PUT', 'PATCH'] as const : undefined);
  if (!methods?.length) return [];
  let candidates = requirement.apis.filter((api) => methods.includes(api.method) && resourceMatches(point, api));
  if (actionTokens.length) {
    const actionMatches = candidates.filter((api) => pathTokens(api.path).some((token) => actionTokens.includes(token)));
    if (actionMatches.length) candidates = actionMatches;
  } else if (point.canonicalFact.action.kind === 'CREATE') {
    const minimum = Math.min(...candidates.map((api) => pathTokens(api.path).length));
    candidates = candidates.filter((api) => pathTokens(api.path).length === minimum);
  }
  const identifiers = Object.keys(point.canonicalFact.resource.identifiers).map((name) => name.toLowerCase());
  if (/(?:列表|清单|集合|list|search)/i.test(point.objective)) {
    const collectionOperations = candidates.filter((api) => api.pathParams.length === 0);
    if (collectionOperations.length) candidates = collectionOperations;
  } else if (identifiers.length) {
    const itemOperations = candidates.filter((api) => api.pathParams.some((parameter) => identifiers.includes(parameter.name.toLowerCase())));
    if (itemOperations.length) candidates = itemOperations;
  }
  return candidates;
}

function normalizedPath(value: string): string {
  return value.trim().replace(/[，。,;；.]+$/, '');
}

function binding(api: ApiSpec, point: TestPoint, strategy: ApiOperationBinding['strategy']): ApiBindingDecision {
  return {
    binding: {
      apiSpecId: api.id,
      operationKey: api.operationKey,
      method: api.method,
      path: api.path,
      sourceAcId: point.acceptanceCriteriaIds[0],
      sourceTestPointId: point.id,
      strategy,
      confidence: 'HIGH',
    },
  };
}

function issue(
  point: TestPoint,
  code: ApiBindingIssue['code'],
  message: string,
  candidates: ApiSpec[],
): ApiBindingDecision {
  return {
    issue: {
      code,
      stage: 'BINDING',
      blocking: true,
      message,
      source: point.source,
      sourceAcId: point.acceptanceCriteriaIds[0],
      sourceTestPointId: point.id,
      candidateApiSpecIds: candidates.map((api) => api.id),
    },
  };
}

/**
 * Binding Policy：显式 Method+Path 优先；其次是单 API；最后只允许由 canonical
 * Action + Resource 唯一确定的 Operation。自由文本相似度不作为执行依据。
 */
export function bindTestPointToApi(
  requirement: AcceptanceRequirement,
  point: TestPoint,
  index: ApiBindingIndex = createApiBindingIndex(requirement),
): ApiBindingDecision {
  if (!requirement.apis.length) return issue(point, 'API_NOT_FOUND', `${point.id} 没有可绑定的 ApiSpec`, []);

  if (!index.idsUnique) {
    return issue(point, 'BINDING_AMBIGUOUS', 'ApiSpec.id 不唯一，无法建立确定绑定', requirement.apis);
  }

  const explicit = [...point.objective.matchAll(OPERATION_PATTERN)].map((match) => ({
    method: match[1].toUpperCase(),
    path: normalizedPath(match[2]),
  })).filter((operation, index, all) => all.findIndex((candidate) => (
    candidate.method === operation.method && candidate.path === operation.path
  )) === index);
  if (explicit.length > 1) {
    return issue(point, 'BINDING_AMBIGUOUS', `${point.id} 同时引用多个 HTTP Operation`, requirement.apis);
  }
  const matches = explicit.length === 1
    ? index.byOperationKey.get(`${explicit[0].method} ${explicit[0].path}`) ?? []
    : [];
  if (matches.length === 1) return binding(matches[0], point, 'EXACT_METHOD_PATH');
  if (matches.length > 1) return issue(point, 'BINDING_AMBIGUOUS', `${point.id} 同时匹配多个 ApiSpec`, matches);
  if (explicit.length) {
    return issue(point, 'API_NOT_FOUND', `${point.id} 声明的 Method + Path 在 Requirement IR 中不存在`, requirement.apis);
  }
  if (requirement.apis.length === 1) return binding(requirement.apis[0], point, 'SINGLE_API');
  const semantic = semanticCandidates(requirement, point);
  if (semantic.length === 1) return binding(semantic[0], point, 'ACTION_RESOURCE');
  if (semantic.length > 1) {
    return issue(point, 'BINDING_AMBIGUOUS', `${point.id} 的 Action + Resource 对应多个 ApiSpec，需明确 Method + Path`, semantic);
  }
  return issue(point, 'BINDING_AMBIGUOUS', `${point.id} 面对多个 ApiSpec，但 AC 未明确 Method + Path`, requirement.apis);
}
