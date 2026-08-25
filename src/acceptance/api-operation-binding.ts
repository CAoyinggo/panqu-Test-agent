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
 * Binding Policy：单 API 可确定绑定；多 API 仅接受 AC 中明确的 Method + Path。
 * 业务描述相似度不作为执行依据，避免猜测后真实调用错误接口。
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
  return issue(point, 'BINDING_AMBIGUOUS', `${point.id} 面对多个 ApiSpec，但 AC 未明确 Method + Path`, requirement.apis);
}
