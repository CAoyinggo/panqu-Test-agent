// API 客户端：调用平台 REST API（JWT 认证 + 25.7 链路 traceId 透传）
const API_BASE = '/api';
const AUTH_BASE = '/auth';

const TOKEN_KEY = 'panqu_token';
const USER_KEY = 'panqu_user';
const TRACE_KEY = 'panqu_trace_id';

export interface AuthUser {
  username: string;
  role: string;
  scopes: { projects: string[]; environments: string[]; businesses: string[] };
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
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Trace-Id': getSessionTraceId() };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    // 25.7 统一错误契约：{error: code, message, status, requestId, traceId}
    const body = (await res.json().catch(() => ({}))) as { error?: string | { message?: string }; message?: string };
    const message = typeof body.error === 'object' ? body.error?.message : (body.message ?? `HTTP ${res.status}`);
    if (res.status === 401) clearSession();
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function login(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${AUTH_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Trace-Id': getSessionTraceId() },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string | { message?: string }; message?: string };
    throw new Error(typeof body.error === 'object' ? body.error?.message : (body.message ?? '登录失败'));
  }
  const data = (await res.json()) as { token: string; user: AuthUser };
  setSession(data.token, data.user);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${AUTH_BASE}/logout`, { method: 'POST', headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
  } catch {
    /* 忽略登出失败 */
  }
  clearSession();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
};
