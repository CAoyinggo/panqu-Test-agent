// API 客户端：调用平台 REST API（JWT 认证 + 25.7 链路 traceId 透传）
// Phase 41.18：统一错误契约 ApiError（code/message/status/requestId/traceId）
// Phase 41.2：登录响应适配后端 AuthTokens 契约（accessToken 主用，兼容 token 别名）
const API_BASE = '/api';
const AUTH_BASE = '/auth';

const TOKEN_KEY = 'panqu_token';
const USER_KEY = 'panqu_user';
const TRACE_KEY = 'panqu_trace_id';

/** 请求超时（ms）：超过则视为 network timeout 错误（41.18） */
const REQUEST_TIMEOUT_MS = 15_000;

export interface AuthUser {
  username: string;
  role: string;
  scopes: { projects: string[]; environments: string[]; businesses: string[] };
}

/** 统一 API 错误（Phase 41.18）：UI 依据 status/code 分派 Login / PermissionDenied / NotFound / Error+Retry */
export interface ApiErrorPayload {
  code: string;
  message: string;
  status: number;
  requestId?: string;
  traceId?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly traceId?: string;

  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiError';
    this.code = payload.code;
    this.status = payload.status;
    this.requestId = payload.requestId;
    this.traceId = payload.traceId;
  }
}

/** 统一服务端错误契约解析：{error?: code|{message}, message?, requestId?, traceId?} */
function parseApiError(res: Response, body: Record<string, unknown>): ApiError {
  const err = body.error as unknown;
  let code = 'request_failed';
  let message: string | null = null;
  if (typeof err === 'string') {
    code = err;
  } else if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string };
    code = e.code ?? code;
    message = e.message ?? null;
  }
  const fallback: Record<number, string> = {
    401: '登录已过期，请重新登录',
    403: '没有权限执行此操作',
    404: '请求的资源不存在',
    409: '资源冲突，请刷新后重试',
    429: '请求过于频繁，请稍后再试',
    500: '服务器内部错误，请重试',
  };
  return new ApiError({
    code,
    message: message ?? (body.message as string | undefined) ?? fallback[res.status] ?? `HTTP ${res.status}`,
    status: res.status,
    requestId: body.requestId as string | undefined,
    traceId: body.traceId as string | undefined,
  });
}

/** 带超时与网络错误归一化的 fetch 包装（41.18） */
async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    throw new ApiError({
      code: aborted ? 'timeout' : 'network_error',
      message: aborted ? '请求超时，请检查网络后重试' : '网络错误，请检查连接',
      status: 0,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 会话级 traceId：同一控制台会话的所有请求共享，便于后端审计链路关联（25.7） */
function getSessionTraceId(): string {
  let tid = localStorage.getItem(TRACE_KEY);
  if (!tid) {
    tid = `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(TRACE_KEY, tid);
  }
  return tid;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  // 41.2：通知 App 会话失效 → 自动退出回登录页（避免停留在 Dashboard 死循环）
  window.dispatchEvent(new CustomEvent('panqu:unauthorized'));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Trace-Id': getSessionTraceId() };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err = parseApiError(res, body);
    // 401：令牌失效 → 自动退出（41.2）
    if (err.status === 401) clearSession();
    throw err;
  }
  return (await res.json()) as T;
}

export async function login(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const res = await fetchWithTimeout(`${AUTH_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Trace-Id': getSessionTraceId() },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw parseApiError(res, body);
  }
  // 后端 AuthTokens 契约：{ accessToken, refreshToken, expiresIn, user }；兼容 { token, user } 旧契约
  const data = (await res.json()) as { token?: string; accessToken?: string; user?: Record<string, unknown> };
  const token = data.accessToken ?? data.token ?? '';
  // 41.11：后端 user 返回 roles: string[]，前端 AuthUser 使用单数 role → 归一化
  const raw = data.user ?? {};
  const roles = Array.isArray(raw.roles)
    ? raw.roles.map(String)
    : typeof raw.role === 'string'
      ? [raw.role]
      : [];
  const user: AuthUser = {
    username: String(raw.username ?? ''),
    role: roles[0] ?? 'VIEWER',
    scopes: { projects: [], environments: [], businesses: [] },
  };
  setSession(token, user);
  return { token, user };
}

export async function logout(): Promise<void> {
  try {
    await fetchWithTimeout(`${AUTH_BASE}/logout`, { method: 'POST', headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
  } catch {
    /* 忽略登出失败 */
  }
  clearSession();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  // 43.1：补 DELETE（平台端点若需删除资源时使用；当前无调用方仍保持契约完整）
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ===== Phase 45：AI 质量评测报告（GET /api/eval/report）=====
// 确定性规则评测（model=rules），返回当前 AI 测试质量评测报告。

/** 关键安全指标：任意非 0 都代表命中安全风险，需重点处理 */
export interface EvalCritical {
  p0Miss: number;
  falsePass: number;
  unsafeHealing: number;
  skippedCritical: number;
}

export interface EvalCost {
  cost: number;
  totalTokens: number;
  latencyMs: number;
}

export interface EvalVersionInfo {
  model: string;
  modelVersion: string;
  promptVersion: string;
  toolVersion: string;
  agentVersion: string;
}

/** 领域内逐条评测结果 */
export interface EvalResult {
  caseId: string;
  domain: string;
  score: number;
  passed: boolean;
  tracked: boolean;
  expected: string;
  actual: string;
  errors: string[];
  evidence?: string;
}

export interface EvalDomainFailure {
  caseId: string;
  expected: string;
  actual: string;
  errors: string[];
}

export interface EvalDomain {
  domain: string;
  label: string;
  benchmark: string;
  benchmarkVersion: string;
  total: number;
  tracked: number;
  untracked: number;
  passed: number;
  score: number;
  metrics: Record<string, number>;
  failures: EvalDomainFailure[];
  results: EvalResult[];
}

export interface EvalReport {
  version: string;
  generatedAt: string;
  overall: number;
  critical: EvalCritical;
  cost: EvalCost;
  versionInfo: EvalVersionInfo;
  domains: EvalDomain[];
}

/** Phase 45：获取当前 AI 评测报告（确定性规则评测，model=rules） */
export function getEvalReport(): Promise<EvalReport> {
  return request<EvalReport>('/eval/report');
}
