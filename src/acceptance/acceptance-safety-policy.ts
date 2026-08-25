export type AcceptanceOperationEffect = 'READ' | 'WRITE' | 'DELETE' | 'EXTERNAL_SIDE_EFFECT' | 'BILLABLE' | 'UNKNOWN';

export interface AcceptanceEnvironmentPolicy {
  /** test/integration 必须显式授权目标 Origin；local 始终只允许 loopback。 */
  allowedOrigins?: string[];
}

export interface AcceptanceOperationPolicy {
  effect: AcceptanceOperationEffect;
  reason?: string;
}

/**
 * 公开 Acceptance Pipeline 的执行授权快照。
 *
 * 该对象不是运行配置的默认值：execute 调用必须显式提供，并由 Pipeline 再校验，
 * 以避免绕过 CLI 后直接触发 Data Prepare 或 HTTP 请求。
 */
export interface AcceptanceExecutionSafetyPolicy {
  environment: string;
  allowedOrigins?: string[];
  operationPolicies: Record<string, AcceptanceOperationPolicy>;
  /** 仅 local + loopback 可显式豁免 Mutation Cleanup。 */
  allowNoCleanup?: boolean;
}

export interface AcceptanceSafetyGateInput {
  policy?: AcceptanceExecutionSafetyPolicy;
  environment?: string;
  baseUrl: string;
  operationKeys: string[];
  hasCleanup: boolean;
}

export interface AcceptanceSafetyGateDecision {
  allowed: boolean;
  reason?: string;
}

/** 第二轮审计仅批准本机/隔离测试环境；Staging 需独立 Pilot Entry Gate 后再加入。 */
export const ACCEPTANCE_EXECUTION_ENVIRONMENT_ALLOWLIST = ['local', 'test', 'integration'] as const;

const VALID_EFFECTS = new Set<AcceptanceOperationEffect>([
  'READ', 'WRITE', 'DELETE', 'EXTERNAL_SIDE_EFFECT', 'BILLABLE', 'UNKNOWN',
]);
const UNSAFE_EFFECTS = new Set<AcceptanceOperationEffect>(['EXTERNAL_SIDE_EFFECT', 'BILLABLE', 'UNKNOWN']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function denied(reason: string): AcceptanceSafetyGateDecision {
  return { allowed: false, reason };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.').map(Number);
  return octets.length === 4
    && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 127;
}

function parseTarget(baseUrl: string): URL | string {
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'API_BASE_URL_INVALID：仅支持 HTTP/HTTPS';
    if (parsed.username || parsed.password) return 'API_BASE_URL_INVALID：baseUrl 禁止包含内联凭据';
    if (parsed.search || parsed.hash) return 'API_BASE_URL_INVALID：baseUrl 禁止包含 Query 或 Fragment';
    // The HTTP processor resolves contract paths such as `/orders` from the
    // configured origin. Accepting `/sandbox/` here would misleadingly imply a
    // path prefix while URL resolution targets the same origin's `/orders`.
    if (parsed.pathname !== '/') return 'API_BASE_URL_INVALID：baseUrl 必须是纯 Origin，禁止包含 Path 前缀';
    return parsed;
  } catch (error) {
    return `API_BASE_URL_INVALID：${(error as Error).message}`;
  }
}

function parseAllowedOrigins(values: string[] | undefined): URL[] | string {
  const origins: URL[] = [];
  for (const value of values ?? []) {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username || parsed.password || parsed.search || parsed.hash
        || parsed.pathname !== '/') {
        return `ENVIRONMENT_POLICY_INVALID：allowedOrigins 必须是无凭据、Path、Query、Fragment 的 HTTP(S) Origin：${value}`;
      }
      origins.push(parsed);
    } catch {
      return `ENVIRONMENT_POLICY_INVALID：allowedOrigins 包含非法 URL：${value}`;
    }
  }
  return origins;
}

/**
 * 在 Data Prepare/HTTP 之前对公开 Pipeline 的执行边界做一次完整、无副作用的判定。
 * 返回 denied 而不是抛错，便于 Pipeline 把所有 Case 统一落为 BLOCKED。
 */
export function evaluateAcceptanceExecutionSafety(input: AcceptanceSafetyGateInput): AcceptanceSafetyGateDecision {
  if (!input.policy) return denied('SAFETY_POLICY_REQUIRED：execute 必须显式提供 Acceptance execution safety policy');

  const environment = input.environment?.trim().toLowerCase();
  const authorizedEnvironment = input.policy.environment?.trim().toLowerCase();
  if (!environment || !authorizedEnvironment || environment !== authorizedEnvironment) {
    return denied(`ENVIRONMENT_POLICY_MISMATCH：运行环境 ${input.environment ?? '(missing)'} 与授权环境 ${input.policy.environment ?? '(missing)'} 不一致`);
  }
  if (/^prod(?:uction)?$/i.test(environment)) return denied('ENVIRONMENT_POLICY_BLOCKED：Acceptance 默认禁止直接在 production 执行');
  if (!(ACCEPTANCE_EXECUTION_ENVIRONMENT_ALLOWLIST as readonly string[]).includes(environment)) {
    return denied(`ENVIRONMENT_POLICY_BLOCKED：环境 ${environment} 未进入 Acceptance 执行 Allowlist`);
  }

  const target = parseTarget(input.baseUrl);
  if (typeof target === 'string') return denied(target);
  if (environment === 'local') {
    if (!isLoopbackHost(target.hostname)) {
      return denied(`ENVIRONMENT_TARGET_MISMATCH：local 仅允许 loopback，实际为 ${target.origin}`);
    }
  } else {
    const allowedOrigins = parseAllowedOrigins(input.policy.allowedOrigins);
    if (typeof allowedOrigins === 'string') return denied(allowedOrigins);
    if (!allowedOrigins.length || !allowedOrigins.some((allowed) => allowed.origin === target.origin)) {
      return denied(`ENVIRONMENT_TARGET_MISMATCH：${environment} 必须显式 Allowlist API Origin，实际为 ${target.origin}`);
    }
  }

  const operationPolicies = input.policy.operationPolicies;
  if (!operationPolicies || typeof operationPolicies !== 'object' || Array.isArray(operationPolicies)) {
    return denied('OPERATION_POLICY_REQUIRED：operationPolicies 必须是显式 Operation Key → effect 映射');
  }
  const operationKeys = [...new Set(input.operationKeys)];
  for (const operationKey of operationKeys) {
    const method = operationKey.split(' ', 1)[0]?.toUpperCase();
    const operationPolicy = operationPolicies[operationKey];
    if (!operationPolicy) {
      return denied(`OPERATION_POLICY_REQUIRED：${operationKey} 必须显式声明 READ/WRITE/DELETE/EXTERNAL_SIDE_EFFECT/BILLABLE`);
    }
    if (!VALID_EFFECTS.has(operationPolicy.effect)) {
      return denied(`OPERATION_POLICY_INVALID：${operationKey} 的 effect=${String(operationPolicy.effect)} 非法`);
    }
    if (UNSAFE_EFFECTS.has(operationPolicy.effect)) {
      return denied(`MUTATION_POLICY_BLOCKED：${operationKey} 分类为 ${operationPolicy.effect}，当前 Pilot 禁止真实执行`);
    }
    if ((method === 'GET' || method === 'HEAD') && operationPolicy.effect !== 'READ') {
      return denied(`OPERATION_POLICY_INVALID：${operationKey} 必须分类为 READ`);
    }
    if (method === 'DELETE' && operationPolicy.effect !== 'DELETE') {
      return denied(`OPERATION_POLICY_INVALID：${operationKey} 必须分类为 DELETE`);
    }
    if (['POST', 'PUT', 'PATCH'].includes(method) && operationPolicy.effect === 'DELETE') {
      return denied(`OPERATION_POLICY_INVALID：${operationKey} 的 Method 与 DELETE effect 不一致`);
    }
  }

  if (input.policy.allowNoCleanup === true && environment !== 'local') {
    return denied('CLEANUP_POLICY_INVALID：allowNoCleanup=true 仅允许 local loopback，test/integration 禁止绕过 Cleanup');
  }
  const mutating = operationKeys.some((operationKey) => MUTATING_METHODS.has(operationKey.split(' ', 1)[0]?.toUpperCase()));
  if (mutating && !input.hasCleanup && input.policy.allowNoCleanup !== true) {
    return denied('CLEANUP_POLICY_REQUIRED：检测到有副作用的 API Case，但未配置 Cleanup；仅 local loopback 可显式 allowNoCleanup=true');
  }

  return { allowed: true };
}
