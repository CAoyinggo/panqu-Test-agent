// Plan Contract：Trae 自定义智能体 → test-flow 之间唯一的「结构化测试计划」输入契约。
//
// 职责（确定性、无 LLM、无网络、无副作用）：
//   1. 定义外部契约类型（Trae 产出的 PANQU_TEST_PLAN_V1）；
//   2. 校验 + 归一化（安全：SSRF/敏感字段/URL/大小/深度/引用完整性）；
//   3. 对归一化计划计算 SHA-256 plan_hash（用于 execute 时绑定确认，防止计划被替换）。
//
// 该路径禁止创建 Runtime LLM、读取 LLM_PROVIDER、调用模型 API、回退 MockLLM、调用 traecli。

import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

export const PLAN_SCHEMA_VERSION = 'PANQU_TEST_PLAN_V1' as const;

/** 第一阶段执行环境。 */
export type PlanEnvironment = 'test' | 'preonline' | 'prod';

/** Trae 声明的测试范围；只影响分类语义，不驱动执行器。 */
export type PlanScope = 'comprehensive' | 'api' | 'functional' | 'ui';

/** 第一阶段用例类型：仅 API（安全方法）可确定性映射为 HTTP_REQUEST，其余为 DESIGNED_ONLY。 */
export type PlanCaseType =
  | 'API' | 'FUNCTIONAL' | 'UI' | 'BROWSER'
  | 'DATA_ISOLATION' | 'SECURITY' | 'BUSINESS_RULE' | 'STATE'
  | 'ERROR' | 'BOUNDARY' | 'COMPATIBILITY';

/** 第一阶段允许真实执行的 HTTP 方法（只读幂等）。 */
export const SAFE_HTTP_METHODS: ReadonlySet<PlanHttpMethod> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeHttpMethod(method: PlanHttpMethod): boolean {
  return SAFE_HTTP_METHODS.has(method);
}

/** 第一阶段用例类型全集（API 之外均为设计态 DESIGNED_ONLY）。 */
const PLAN_CASE_TYPES: ReadonlySet<PlanCaseType> = new Set<PlanCaseType>([
  'API', 'FUNCTIONAL', 'UI', 'BROWSER',
  'DATA_ISOLATION', 'SECURITY', 'BUSINESS_RULE', 'STATE',
  'ERROR', 'BOUNDARY', 'COMPATIBILITY',
]);

export type PlanPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type PlanRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type PlanHttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// —— 外部契约（Trae 产出） ——

export interface PlanStepInput {
  id?: string;
  /** 步骤类型：HTTP_REQUEST 可执行；DESCRIPTION 为设计态说明步骤（不要求 method/url）。 */
  type?: 'HTTP_REQUEST' | 'DESCRIPTION';
  /** DESCRIPTION 步骤的说明文本。 */
  description?: string;
  action?: string;
  method?: PlanHttpMethod;
  /** 相对路径，或与 target_url 同源的绝对 URL。 */
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  path_params?: Record<string, unknown>;
  body?: unknown;
}

export interface PlanAssertionInput {
  id?: string;
  /** 协议断言类型；HTTP 用例必须提供确定性 type 才能执行。 */
  type?: 'STATUS_CODE' | 'JSON_VALUE' | 'JSON_PATH' | 'RESPONSE_HEADER' | 'CONTAINS' | 'TYPE';
  path?: string;
  header?: string;
  operator?: 'equals' | 'notEquals' | 'contains' | 'notContains' | 'exists' | 'notExists'
    | 'gt' | 'gte' | 'lt' | 'lte' | 'type' | 'regex';
  expected?: unknown;
  description?: string;
}

export interface PlanCaseInput {
  id: string;
  name: string;
  description?: string;
  priority: PlanPriority;
  type: PlanCaseType;
  /** 前置条件（设计态保留，不驱动执行）。 */
  preconditions?: string[];
  /** 清理步骤（设计态保留，不驱动执行）。 */
  cleanup?: string[];
  /** 需要鉴权时只能引用凭据名称，禁止内联 Secret。 */
  credential_ref?: string;
  auth_ref?: string;
  steps: PlanStepInput[];
  assertions: PlanAssertionInput[];
}

export interface PlanRiskInput {
  id: string;
  level: PlanRiskLevel | PlanPriority;
  category: string;
  description: string;
  mitigation?: string;
  affected_cases?: string[];
  affectedCases?: string[];
}

export interface PlanContractInput {
  requirement_summary: string;
  target_url: string;
  environment: PlanEnvironment;
  test_scope: PlanScope;
  test_cases: PlanCaseInput[];
  risks: PlanRiskInput[];
}

// —— 归一化结果 ——

export interface NormalizedStep {
  id: string;
  type: 'HTTP_REQUEST' | 'DESCRIPTION';
  method?: PlanHttpMethod;
  url?: string;
  description?: string;
  headers: Record<string, string>;
  query: Record<string, unknown>;
  pathParams: Record<string, unknown>;
  body?: unknown;
}

export interface NormalizedAssertion {
  id: string;
  type: 'STATUS_CODE' | 'JSON_VALUE' | 'JSON_PATH' | 'RESPONSE_HEADER' | 'CONTAINS' | 'TYPE';
  path?: string;
  header?: string;
  operator: string;
  expected?: unknown;
}

export interface NormalizedCase {
  id: string;
  name: string;
  description?: string;
  priority: PlanPriority;
  type: PlanCaseType;
  preconditions: string[];
  cleanup: string[];
  credentialRef?: string;
  steps: NormalizedStep[];
  assertions: NormalizedAssertion[];
}

export interface NormalizedRisk {
  id: string;
  level: PlanRiskLevel;
  category: string;
  description: string;
  mitigation?: string;
  affectedCases: string[];
}

export interface NormalizedPlan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  requirementSummary: string;
  targetUrl: string;
  environment: PlanEnvironment;
  scope: PlanScope;
  testCases: NormalizedCase[];
  risks: NormalizedRisk[];
}

export interface PlanIssue {
  code: string;
  message: string;
  path?: string;
}

// —— 限制常量（默认值，可注入覆盖用于测试） ——

export interface ValidatePlanOptions {
  maxCases?: number;
  maxFieldLength?: number;
  maxBodyBytes?: number;
  maxDepth?: number;
  maxSteps?: number;
  maxAssertions?: number;
  /** 自定义禁止访问的 host（补充默认黑名单）；跳过本地网络解析，纯字面匹配。 */
  blockedHosts?: ReadonlySet<string>;
}

const DEFAULT_MAX_CASES = 1000;
const DEFAULT_MAX_FIELD_LENGTH = 10_000;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_STEPS = 50;
const DEFAULT_MAX_ASSERTIONS = 50;

/** 需要期望值的操作符；存在性类操作符不需要 expected。 */
const OPERATORS_REQUIRING_EXPECTED = new Set([
  'equals', 'notEquals', 'contains', 'notContains', 'gt', 'gte', 'lt', 'lte', 'type', 'regex',
]);
const OPERATORS_NOT_REQUIRING_EXPECTED = new Set(['exists', 'notExists']);

const VALID_OPERATORS = new Set([...OPERATORS_REQUIRING_EXPECTED, ...OPERATORS_NOT_REQUIRING_EXPECTED]);

/** 禁止出现在 headers 中的凭据传递头（不区分大小写）。 */
const FORBIDDEN_HEADER_KEYS = new Set([
  'authorization', 'proxy-authorization',
  'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token', 'x-access-token', 'x-api-token',
  'token', 'access-token', 'id-token',
]);

/** 禁止在 plan 中覆盖的 Host 与 hop-by-hop 请求头（不区分大小写）；传输层会二次删除。 */
const FORBIDDEN_HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'proxy-connection', 'transfer-encoding',
  'content-length', 'upgrade', 'trailer', 'te',
]);

/** 递归扫描对象中的敏感字段名（凭据类）。 */
const SENSITIVE_FIELD = /^(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|token|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth[_-]?token|client[_-]?secret)$/i;

/** 默认禁止访问的主机（SSRF 防护：localhost / link-local / metadata / 内网 / 保留）。 */
const RESERVED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  '169.254.169.254',
]);

export type PlanValidationResult =
  | { ok: true; normalized: NormalizedPlan }
  | { ok: false; errors: PlanIssue[] };

// —— 运行时严格字段校验（服务端强制，不依赖 MCP Schema 的 additionalProperties） ——

/** 任何层级出现即拒绝的危险/命令执行/审批类字段名。 */
const FORBIDDEN_FIELD = /^(command|shell|file_path|filepath|execution_approval)$/i;

/** 顶层 plan 允许字段。 */
const PLAN_TOP_KEYS: ReadonlySet<string> = new Set([
  'requirement_summary', 'target_url', 'environment', 'test_scope', 'test_cases', 'risks',
]);
/** case 允许字段。 */
const CASE_KEYS: ReadonlySet<string> = new Set([
  'id', 'name', 'description', 'priority', 'type', 'preconditions', 'cleanup',
  'credential_ref', 'auth_ref', 'steps', 'assertions',
]);
/** step 允许字段。 */
const STEP_KEYS: ReadonlySet<string> = new Set([
  'id', 'type', 'description', 'action', 'method', 'url', 'headers', 'query', 'path_params', 'body',
]);
/** assertion 允许字段。 */
const ASSERTION_KEYS: ReadonlySet<string> = new Set([
  'id', 'type', 'path', 'header', 'operator', 'expected', 'description',
]);
/** risk 允许字段。 */
const RISK_KEYS: ReadonlySet<string> = new Set([
  'id', 'level', 'category', 'description', 'mitigation', 'affected_cases', 'affectedCases',
]);

/** 拒绝未知字段与危险字段（execution_approval / command / shell / file_path 等）。 */
function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  objPath: string,
  errors: PlanIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_FIELD.test(key)) {
      errors.push({ code: 'FORBIDDEN_FIELD', message: `禁止字段：${key}`, path: `${objPath}.${key}` });
    } else if (!allowed.has(key)) {
      errors.push({ code: 'UNKNOWN_FIELD', message: `未知字段：${key}`, path: `${objPath}.${key}` });
    }
  }
}

// —— 工具函数 ——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 递归去除 undefined 键（对齐 JSON.stringify 的序列化语义），保证跨 JSON 落盘后哈希稳定。 */
function stripUndefined(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripUndefined);
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec).sort()) {
    const val = rec[key];
    if (val === undefined) continue;
    out[key] = stripUndefined(val);
  }
  return out;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stripUndefined(value));
}

function depthOf(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth;
  const children: unknown[] = Array.isArray(value)
    ? (value as unknown[])
    : Object.values(value as Record<string, unknown>);
  let max = depth;
  for (const item of children) {
    max = Math.max(max, depthOf(item, depth + 1));
  }
  return max;
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

function hasSensitiveField(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (Array.isArray(value)) return value.some((item) => hasSensitiveField(item, depth + 1));
  if (isRecord(value)) {
    return Object.entries(value).some(([key, item]) => SENSITIVE_FIELD.test(key) || hasSensitiveField(item, depth + 1));
  }
  return false;
}

function isPrivateOrReservedIp(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const parts = host.split('.').map(Number);
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  return a >= 224; // multicast / reserved
}

function isLoopbackOrBlockedIp(host: string): boolean {
  if (host === '::1' || host === '::') return true;
  const lower = host.toLowerCase();
  if (lower.startsWith('fe80:')) return true; // link-local IPv6
  if (lower.startsWith('fd')) return true; // ULA IPv6
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    return isPrivateOrReservedIp(v4) || v4 === '127.0.0.1';
  }
  return false;
}

/** 判断 host 是否命中 SSRF 黑名单（纯字面匹配，不做 DNS 解析）。 */
export function isBlockedHost(host: string, extraBlocked: ReadonlySet<string> = new Set()): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return true;
  if (RESERVED_HOSTS.has(normalized)) return true;
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (extraBlocked.has(normalized)) return true;
  if (isIP(normalized) !== 0) return isPrivateOrReservedIp(normalized) || isLoopbackOrBlockedIp(normalized);
  return false;
}

/** 判断 IPv6 地址是否属于禁止范围（SSRF：loopback/ULA/link-local/multicast/映射内网/文档保留）。 */
function isBlockedIpv6(ip: string): boolean {
  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  if (ip.startsWith('ff')) return true; // multicast ff00::/8
  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // link-local fe80::/10
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA fc00::/7
  if (ip.startsWith('2001:db8')) return true; // documentation（保留）
  if (ip.startsWith('2001:10')) return true; // ORCHID（保留）
  if (ip.startsWith('::ffff:')) {
    const v4 = ip.slice('::ffff:'.length);
    return isPrivateOrReservedIp(v4) || v4 === '127.0.0.1';
  }
  return false;
}

/**
 * 判断 DNS 解析后的实际 IP（IPv4/IPv6）是否属于禁止范围（SSRF）。
 * 与 isBlockedHost（字面主机名）互补：即使主机名不为内网字面，解析出的地址也必须逐跳复查；
 * 非合法 IP 返回 true（fail-closed）。
 */
export function isBlockedIpAddress(ip: string): boolean {
  const normalized = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return true;
  const version = isIP(normalized);
  if (version === 0) return true;
  if (version === 4) return isPrivateOrReservedIp(normalized);
  return isBlockedIpv6(normalized);
}

/** 校验绝对 URL；只允许 HTTP/HTTPS，禁止内联凭据与 SSRF 主机。 */
export function validateAbsoluteUrl(raw: string, options: ValidatePlanOptions = {}): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [{ code: 'URL_REQUIRED', message: 'URL 不能为空' }];
  }
  if (raw.length > DEFAULT_MAX_FIELD_LENGTH) {
    issues.push({ code: 'URL_TOO_LONG', message: 'URL 超长' });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [{ code: 'URL_INVALID', message: 'URL 不是合法地址' }];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    issues.push({ code: 'URL_SCHEME', message: '仅支持 HTTP/HTTPS' });
  }
  if (url.username || url.password) {
    issues.push({ code: 'URL_CREDENTIALS', message: 'URL 不得内联用户名或密码' });
  }
  if (!url.hostname) {
    issues.push({ code: 'URL_HOST', message: 'URL 缺少主机名' });
  } else if (isBlockedHost(url.hostname, options.blockedHosts)) {
    issues.push({ code: 'URL_SSRF_BLOCKED', message: `目标主机被禁止访问：${url.hostname}` });
  }
  return issues;
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

// —— 归一化 ——

function normalizeMethod(value: unknown): PlanHttpMethod | undefined {
  return typeof value === 'string' && ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(value)
    ? value as PlanHttpMethod : undefined;
}

function normalizeAssertionType(value: unknown): NormalizedAssertion['type'] | undefined {
  return typeof value === 'string'
    && ['STATUS_CODE', 'JSON_VALUE', 'JSON_PATH', 'RESPONSE_HEADER', 'CONTAINS', 'TYPE'].includes(value)
    ? value as NormalizedAssertion['type'] : undefined;
}

function defaultOperatorForType(type: NormalizedAssertion['type']): string {
  switch (type) {
    case 'JSON_PATH': return 'exists';
    case 'CONTAINS': return 'contains';
    case 'TYPE': return 'type';
    default: return 'equals';
  }
}

// —— 主校验 + 归一化 ——

export function validatePlan(input: unknown, options: ValidatePlanOptions = {}): PlanValidationResult {
  const errors: PlanIssue[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ code: 'PLAN_NOT_OBJECT', message: 'plan 必须是对象' }] };

  rejectUnknownFields(input, PLAN_TOP_KEYS, 'plan', errors);

  const maxCases = options.maxCases ?? DEFAULT_MAX_CASES;
  const maxFieldLength = options.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxAssertions = options.maxAssertions ?? DEFAULT_MAX_ASSERTIONS;
  const blockedHosts = options.blockedHosts ?? new Set<string>();

  const requirementSummary = typeof input.requirement_summary === 'string' ? input.requirement_summary.trim() : '';
  if (!requirementSummary) errors.push({ code: 'REQUIREMENT_SUMMARY_REQUIRED', message: 'requirement_summary 不能为空', path: 'requirement_summary' });
  else if (requirementSummary.length > maxFieldLength) errors.push({ code: 'FIELD_TOO_LONG', message: 'requirement_summary 超长', path: 'requirement_summary' });

  const targetUrl = typeof input.target_url === 'string' ? input.target_url : '';
  errors.push(...validateAbsoluteUrl(targetUrl, { ...options, blockedHosts }).map((issue) => ({ ...issue, path: 'target_url' })));

  const environment = input.environment;
  if (environment !== 'test' && environment !== 'preonline' && environment !== 'prod') {
    errors.push({ code: 'ENVIRONMENT_INVALID', message: 'environment 必须是 test/preonline/prod 之一', path: 'environment' });
  }

  const scope = input.test_scope;
  if (scope !== 'comprehensive' && scope !== 'api' && scope !== 'functional' && scope !== 'ui') {
    errors.push({ code: 'SCOPE_INVALID', message: 'test_scope 非法', path: 'test_scope' });
  }

  const rawCases = Array.isArray(input.test_cases) ? input.test_cases : [];
  if (!Array.isArray(input.test_cases)) errors.push({ code: 'TEST_CASES_ARRAY', message: 'test_cases 必须是数组', path: 'test_cases' });
  else if (rawCases.length === 0) errors.push({ code: 'TEST_CASES_MIN', message: 'test_cases 至少需要 1 条用例', path: 'test_cases' });
  if (rawCases.length > maxCases) errors.push({ code: 'TOO_MANY_CASES', message: `test_cases 超过上限 ${maxCases}`, path: 'test_cases' });

  const caseIds = new Set<string>();
  const normalizedCases: NormalizedCase[] = [];
  rawCases.forEach((rawCase, index) => {
    const base = `test_cases[${index}]`;
    if (!isRecord(rawCase)) { errors.push({ code: 'CASE_NOT_OBJECT', message: 'case 必须是对象', path: base }); return; }
    rejectUnknownFields(rawCase, CASE_KEYS, base, errors);
    const id = typeof rawCase.id === 'string' ? rawCase.id.trim() : '';
    if (!id) { errors.push({ code: 'CASE_ID_REQUIRED', message: 'case.id 不能为空', path: `${base}.id` }); return; }
    if (caseIds.has(id)) { errors.push({ code: 'DUPLICATE_CASE_ID', message: `case.id 重复：${id}`, path: `${base}.id` }); }
    caseIds.add(id);

    const name = typeof rawCase.name === 'string' ? rawCase.name.trim() : '';
    if (!name) errors.push({ code: 'CASE_NAME_REQUIRED', message: 'case.name 不能为空', path: `${base}.name` });

    const priority = rawCase.priority;
    if (priority !== 'P0' && priority !== 'P1' && priority !== 'P2' && priority !== 'P3') {
      errors.push({ code: 'CASE_PRIORITY_INVALID', message: 'case.priority 非法', path: `${base}.priority` });
    }

    const type = rawCase.type;
    if (typeof type !== 'string' || !PLAN_CASE_TYPES.has(type as PlanCaseType)) {
      errors.push({ code: 'CASE_TYPE_INVALID', message: 'case.type 非法', path: `${base}.type` });
    }

    const credentialRef = typeof rawCase.credential_ref === 'string' && rawCase.credential_ref.trim()
      ? rawCase.credential_ref.trim()
      : typeof rawCase.auth_ref === 'string' && rawCase.auth_ref.trim() ? rawCase.auth_ref.trim() : undefined;

    const rawSteps = Array.isArray(rawCase.steps) ? rawCase.steps : [];
    const steps: NormalizedStep[] = [];
    rawSteps.forEach((rawStep, stepIndex) => {
      const stepBase = `${base}.steps[${stepIndex}]`;
      if (!isRecord(rawStep)) { errors.push({ code: 'STEP_NOT_OBJECT', message: 'step 必须是对象', path: stepBase }); return; }
      rejectUnknownFields(rawStep, STEP_KEYS, stepBase, errors);
      const stepType = rawStep.type === undefined ? 'HTTP_REQUEST' : rawStep.type;
      if (stepType !== 'HTTP_REQUEST' && stepType !== 'DESCRIPTION') {
        errors.push({ code: 'STEP_TYPE_UNSUPPORTED', message: 'step.type 仅支持 HTTP_REQUEST 或 DESCRIPTION', path: `${stepBase}.type` });
        return;
      }
      const stepId = typeof rawStep.id === 'string' && rawStep.id.trim() ? rawStep.id.trim() : `STEP-${String(stepIndex + 1).padStart(3, '0')}`;

      if (stepType === 'DESCRIPTION') {
        steps.push({
          id: stepId,
          type: 'DESCRIPTION',
          description: typeof rawStep.description === 'string' ? rawStep.description.trim() : '',
          headers: {},
          query: {},
          pathParams: {},
          body: undefined,
        });
        return;
      }

      const method = normalizeMethod(rawStep.method);
      if (!method) { errors.push({ code: 'STEP_METHOD_INVALID', message: 'HTTP step 缺少合法 method', path: `${stepBase}.method` }); return; }
      const url = typeof rawStep.url === 'string' ? rawStep.url.trim() : '';
      if (!url) { errors.push({ code: 'STEP_URL_REQUIRED', message: 'HTTP step 缺少 url', path: `${stepBase}.url` }); return; }
      // step.url 必须是相对路径或与 target_url 同源
      let resolvedUrl: string = url;
      if (/^https?:\/\//i.test(url)) {
        let stepUrl: URL;
        try { stepUrl = new URL(url); } catch { errors.push({ code: 'STEP_URL_INVALID', message: 'step.url 不是合法 URL', path: `${stepBase}.url` }); return; }
        if (stepUrl.username || stepUrl.password) {
          errors.push({ code: 'URL_CREDENTIALS', message: 'step.url 不得内联用户名或密码', path: `${stepBase}.url` });
        }
        if (isBlockedHost(stepUrl.hostname, blockedHosts)) {
          errors.push({ code: 'URL_SSRF_BLOCKED', message: `step.url 主机被禁止：${stepUrl.hostname}`, path: `${stepBase}.url` });
        }
        if (targetUrl) {
          try {
            const root = new URL(targetUrl);
            if (originOf(stepUrl) !== originOf(root)) {
              errors.push({ code: 'STEP_URL_CROSS_ORIGIN', message: 'step.url 必须与 target_url 同源', path: `${stepBase}.url` });
            } else {
              resolvedUrl = stepUrl.pathname + stepUrl.search;
            }
          } catch { /* target_url 已单独报错 */ }
        }
      }

      const headers = isRecord(rawStep.headers) ? rawStep.headers as Record<string, string> : {};
      for (const [key] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        if (FORBIDDEN_HEADER_KEYS.has(lower)) {
          errors.push({ code: 'SENSITIVE_HEADER', message: `禁止在 plan 中传递凭据头 ${key}`, path: `${stepBase}.headers.${key}` });
        } else if (FORBIDDEN_HOP_BY_HOP_HEADERS.has(lower)) {
          errors.push({ code: 'FORBIDDEN_HEADER', message: `禁止在 plan 中覆盖 Host 或 hop-by-hop 请求头 ${key}`, path: `${stepBase}.headers.${key}` });
        }
      }

      const query = isRecord(rawStep.query) ? rawStep.query : {};
      const pathParams = isRecord(rawStep.path_params) ? rawStep.path_params : {};
      const body = rawStep.body;
      if (hasSensitiveField(query)) errors.push({ code: 'SENSITIVE_FIELD', message: 'query 含敏感凭据字段', path: `${stepBase}.query` });
      if (hasSensitiveField(pathParams)) errors.push({ code: 'SENSITIVE_FIELD', message: 'path_params 含敏感凭据字段', path: `${stepBase}.path_params` });
      if (hasSensitiveField(body)) errors.push({ code: 'SENSITIVE_FIELD', message: 'body 含敏感凭据字段', path: `${stepBase}.body` });
      if (byteLength(body) > maxBodyBytes) errors.push({ code: 'BODY_TOO_LARGE', message: 'body 超过大小上限', path: `${stepBase}.body` });
      if (depthOf(body) > maxDepth) errors.push({ code: 'DEPTH_TOO_LARGE', message: 'body 嵌套深度超限', path: `${stepBase}.body` });

      steps.push({
        id: stepId,
        type: 'HTTP_REQUEST',
        method,
        url: resolvedUrl,
        headers,
        query,
        pathParams,
        body,
      });
    });
    if (rawSteps.length > maxSteps) errors.push({ code: 'TOO_MANY_STEPS', message: 'steps 超限', path: base });

    const rawAssertions = Array.isArray(rawCase.assertions) ? rawCase.assertions : [];
    const assertions: NormalizedAssertion[] = [];
    rawAssertions.forEach((rawAssertion, assertionIndex) => {
      const assertBase = `${base}.assertions[${assertionIndex}]`;
      if (!isRecord(rawAssertion)) { errors.push({ code: 'ASSERTION_NOT_OBJECT', message: 'assertion 必须是对象', path: assertBase }); return; }
      rejectUnknownFields(rawAssertion, ASSERTION_KEYS, assertBase, errors);
      const assertionType = normalizeAssertionType(rawAssertion.type);
      if (!assertionType) { errors.push({ code: 'ASSERTION_TYPE_INVALID', message: 'assertion.type 非法（HTTP 断言必须给出确定性 type）', path: `${assertBase}.type` }); return; }
      const operator = typeof rawAssertion.operator === 'string' && VALID_OPERATORS.has(rawAssertion.operator)
        ? rawAssertion.operator : defaultOperatorForType(assertionType);
      const needsExpected = OPERATORS_REQUIRING_EXPECTED.has(operator) && !OPERATORS_NOT_REQUIRING_EXPECTED.has(operator);
      if (needsExpected && rawAssertion.expected === undefined) {
        errors.push({ code: 'ASSERTION_EXPECTED_REQUIRED', message: `操作符 ${operator} 需要 expected`, path: `${assertBase}.expected` });
      }
      if (assertionType === 'RESPONSE_HEADER' && !(typeof rawAssertion.header === 'string' && rawAssertion.header.trim())) {
        errors.push({ code: 'ASSERTION_HEADER_REQUIRED', message: 'RESPONSE_HEADER 断言需要 header', path: `${assertBase}.header` });
      }
      if (['JSON_VALUE', 'JSON_PATH', 'CONTAINS', 'TYPE'].includes(assertionType) && !(typeof rawAssertion.path === 'string' && rawAssertion.path.trim())) {
        errors.push({ code: 'ASSERTION_PATH_REQUIRED', message: `${assertionType} 断言需要 path`, path: `${assertBase}.path` });
      }
      if (assertionType === 'STATUS_CODE' && operator === 'equals' && typeof rawAssertion.expected !== 'number') {
        errors.push({ code: 'ASSERTION_STATUS_EXPECTED_NUMBER', message: 'STATUS_CODE equals 的 expected 必须是数字', path: `${assertBase}.expected` });
      }
      assertions.push({
        id: typeof rawAssertion.id === 'string' && rawAssertion.id.trim() ? rawAssertion.id.trim() : `AS-${String(assertionIndex + 1).padStart(3, '0')}`,
        type: assertionType,
        path: typeof rawAssertion.path === 'string' ? rawAssertion.path : undefined,
        header: typeof rawAssertion.header === 'string' ? rawAssertion.header : undefined,
        operator,
        expected: rawAssertion.expected,
      });
    });
    if (rawAssertions.length > maxAssertions) errors.push({ code: 'TOO_MANY_ASSERTIONS', message: 'assertions 超限', path: base });

    normalizedCases.push({
      id,
      name,
      description: typeof rawCase.description === 'string' ? rawCase.description : undefined,
      priority: (priority as PlanPriority) ?? 'P2',
      type: (type as PlanCaseType) ?? 'FUNCTIONAL',
      preconditions: Array.isArray(rawCase.preconditions) ? rawCase.preconditions.map(String) : [],
      cleanup: Array.isArray(rawCase.cleanup) ? rawCase.cleanup.map(String) : [],
      credentialRef,
      steps,
      assertions,
    });
  });

  const rawRisks = Array.isArray(input.risks) ? input.risks : [];
  const risks: NormalizedRisk[] = [];
  rawRisks.forEach((rawRisk, index) => {
    const base = `risks[${index}]`;
    if (!isRecord(rawRisk)) { errors.push({ code: 'RISK_NOT_OBJECT', message: 'risk 必须是对象', path: base }); return; }
    rejectUnknownFields(rawRisk, RISK_KEYS, base, errors);
    const id = typeof rawRisk.id === 'string' ? rawRisk.id.trim() : '';
    if (!id) { errors.push({ code: 'RISK_ID_REQUIRED', message: 'risk.id 不能为空', path: `${base}.id` }); }
    const level = rawRisk.level;
    const normalizedLevel = level === 'LOW' || level === 'MEDIUM' || level === 'HIGH' || level === 'CRITICAL'
      ? level : level === 'P0' ? 'CRITICAL' : level === 'P1' ? 'HIGH' : level === 'P2' ? 'MEDIUM' : level === 'P3' ? 'LOW' : undefined;
    if (!normalizedLevel) errors.push({ code: 'RISK_LEVEL_INVALID', message: 'risk.level 非法', path: `${base}.level` });

    const affectedCases = (Array.isArray(rawRisk.affected_cases) ? rawRisk.affected_cases
      : Array.isArray(rawRisk.affectedCases) ? rawRisk.affectedCases : []) as string[];
    for (const affected of affectedCases) {
      if (typeof affected === 'string' && !caseIds.has(affected)) {
        errors.push({ code: 'RISK_AFFECTED_INVALID', message: `affectedCases 引用了不存在的 case.id：${affected}`, path: `${base}.affected_cases` });
      }
    }

    risks.push({
      id,
      level: normalizedLevel ?? 'MEDIUM',
      category: typeof rawRisk.category === 'string' ? rawRisk.category : '',
      description: typeof rawRisk.description === 'string' ? rawRisk.description : '',
      mitigation: typeof rawRisk.mitigation === 'string' ? rawRisk.mitigation : undefined,
      affectedCases: affectedCases.filter((item): item is string => typeof item === 'string'),
    });
  });

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    normalized: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      requirementSummary,
      targetUrl,
      environment: environment as PlanEnvironment,
      scope: scope as PlanScope,
      testCases: normalizedCases,
      risks,
    },
  };
}

/** 对归一化计划计算 SHA-256 plan_hash（排他 planId/时间戳等非确定字段）。 */
export function planHash(normalized: NormalizedPlan): string {
  const canonical = {
    schemaVersion: normalized.schemaVersion,
    requirement_summary: normalized.requirementSummary,
    target_url: normalized.targetUrl,
    environment: normalized.environment,
    test_scope: normalized.scope,
    test_cases: normalized.testCases,
    risks: normalized.risks,
  };
  return createHash('sha256').update(stableStringify(canonical), 'utf8').digest('hex');
}

export function generatePlanId(prefix = 'plan'): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

/** 判定一条归一化用例能否确定性映射为 HTTP_REQUEST（第一阶段，仅 API 只读幂等）。 */
export type PlanCaseClass = 'EXECUTABLE' | 'DESIGNED_ONLY';
export function classifyPlanCase(testCase: NormalizedCase): { classification: PlanCaseClass; reason?: string } {
  if (testCase.type !== 'API') {
    return { classification: 'DESIGNED_ONLY', reason: `type=${testCase.type} 当前执行器不支持，未执行` };
  }
  if (testCase.credentialRef) {
    return { classification: 'DESIGNED_ONLY', reason: '需要鉴权（credential_ref/auth_ref），当前无凭据解析器，未执行' };
  }
  if (testCase.preconditions.length > 0) {
    return { classification: 'DESIGNED_ONLY', reason: '存在前置条件（preconditions），第一阶段不执行' };
  }
  if (testCase.cleanup.length > 0) {
    return { classification: 'DESIGNED_ONLY', reason: '存在清理步骤（cleanup），第一阶段不执行' };
  }
  if (testCase.steps.length !== 1) {
    return { classification: 'DESIGNED_ONLY', reason: '第一阶段仅支持恰好一个步骤' };
  }
  const onlyStep = testCase.steps[0];
  if (onlyStep.type !== 'HTTP_REQUEST') {
    return { classification: 'DESIGNED_ONLY', reason: '唯一步骤不是 HTTP_REQUEST' };
  }
  if (!onlyStep.method || !isSafeHttpMethod(onlyStep.method)) {
    return { classification: 'DESIGNED_ONLY', reason: `method=${onlyStep.method ?? '未知'} 不在第一阶段允许的只读方法（GET/HEAD/OPTIONS）内` };
  }
  if (testCase.assertions.length === 0 || testCase.assertions.some((a) => !a.type || !a.operator)) {
    return { classification: 'DESIGNED_ONLY', reason: '缺少确定性断言' };
  }
  return { classification: 'EXECUTABLE' };
}