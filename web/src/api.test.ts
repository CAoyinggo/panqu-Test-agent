// Phase 42.1：API 客户端单元测试（api.ts）
// 覆盖：登录契约（accessToken 主用 / roles 归一化）/ 会话存取 / 认证头透传 /
//      统一错误契约 ApiError（string|object error）/ 401 自动登出 / 网络错误 / 超时
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, login, getToken, getStoredUser, setSession, clearSession, ApiError } from './api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 可 abort 的 fetch mock：监听 signal.abort → 以 AbortError 拒绝（模拟真实超时行为） */
function abortableFetch(neverResolve = true) {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      if (neverResolve) {
        init?.signal?.addEventListener('abort', () => {
          const e = new DOMException('Aborted', 'AbortError');
          reject(e);
        });
      } else {
        init?.signal?.addEventListener('abort', () => {
          const e = new DOMException('Aborted', 'AbortError');
          reject(e);
        });
      }
    });
  });
}

describe('API 客户端（Phase 42.1）', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('login 登录契约', () => {
    it('成功登录：使用后端 accessToken 契约并持久化会话', async () => {
      const user = { username: 'qa-a', role: 'QA', scopes: { projects: ['wan3'], environments: [], businesses: [] } };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { accessToken: 'jwt-abc', refreshToken: 'r', expiresIn: 3600, user }))
      );
      const { token } = await login('qa-a', 'secret');
      expect(token).toBe('jwt-abc');
      expect(getToken()).toBe('jwt-abc');
      expect(getStoredUser()?.username).toBe('qa-a');
      expect(getStoredUser()?.role).toBe('QA');
    });

    it('兼容旧契约 token 别名', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { token: 'legacy-token', user: { username: 'u', role: 'VIEWER', scopes: {} } }))
      );
      const { token } = await login('u', 'p');
      expect(token).toBe('legacy-token');
    });

    it('后端 user.roles 数组归一化为前端单数 role（Phase 41.11）', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { accessToken: 't', user: { username: 'mgr', roles: ['RELEASE_MANAGER'] } }))
      );
      const { user } = await login('mgr', 'p');
      expect(user.role).toBe('RELEASE_MANAGER');
    });

    it('登录失败：401 → ApiError（status/code）', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'invalid_credentials', message: '用户名或密码错误' })));
      await expect(login('qa-a', 'wrong')).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    });
  });

  describe('会话存取', () => {
    it('setSession / getToken / getStoredUser 往返一致', () => {
      const user = { username: 'qa-b', role: 'QA', scopes: { projects: ['order'], environments: [], businesses: [] } };
      setSession('tok-1', user);
      expect(getToken()).toBe('tok-1');
      expect(getStoredUser()).toEqual(user);
    });

    it('clearSession 清空会话并派发 panqu:unauthorized 事件', () => {
      const dispatched: string[] = [];
      window.addEventListener('panqu:unauthorized', () => dispatched.push('unauthorized'));
      setSession('t', { username: 'u', role: 'VIEWER', scopes: { projects: [], environments: [], businesses: [] } });
      clearSession();
      expect(getToken()).toBeNull();
      expect(getStoredUser()).toBeNull();
      expect(dispatched).toContain('unauthorized');
    });

    it('getStoredUser 对损坏 JSON 返回 null 而非抛错', () => {
      localStorage.setItem('panqu_user', '{bad json');
      expect(getStoredUser()).toBeNull();
    });
  });

  describe('api.get 请求行为', () => {
    it('携带 Bearer Token 与 X-Trace-Id 头', async () => {
      setSession('jwt-token', { username: 'u', role: 'QA', scopes: { projects: [], environments: [], businesses: [] } });
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
      vi.stubGlobal('fetch', fetchMock);
      await api.get<{ ok: boolean }>('/projects');
      const [, init] = fetchMock.mock.calls[0];
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer jwt-token');
      expect(headers['X-Trace-Id']).toBeTruthy();
      expect(String(init.method ?? 'GET')).toBe('GET');
    });

    it('401 → 自动清会话（Token 失效跳登录）并抛 ApiError', async () => {
      const dispatched: string[] = [];
      window.addEventListener('panqu:unauthorized', () => dispatched.push('unauthorized'));
      setSession('expired', { username: 'u', role: 'QA', scopes: { projects: [], environments: [], businesses: [] } });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'token_expired' })));
      await expect(api.get('/x')).rejects.toMatchObject({ status: 401, code: 'token_expired' });
      expect(getToken()).toBeNull();
      expect(dispatched).toContain('unauthorized');
    });

    it('404 → ApiError 使用状态码兜底文案', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, {})));
      await expect(api.get('/nope')).rejects.toMatchObject({ status: 404, message: '请求的资源不存在' });
    });

    it('error 为 object 形态时解析 code/message', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(403, { error: { code: 'forbidden', message: '无项目作用域' }, requestId: 'req-1' })));
      const err = (await api.get('/x').catch((e) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('forbidden');
      expect(err.message).toBe('无项目作用域');
      expect(err.requestId).toBe('req-1');
    });

    it('网络错误 → ApiError code=network_error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
      await expect(api.get('/x')).rejects.toMatchObject({ code: 'network_error', status: 0 });
    });

    it('超时（15s 未响应）→ ApiError code=timeout', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', abortableFetch(true));
      // 先挂断言处理器再推进假时钟，避免超时拒绝在 handler 挂载前被记为未处理
      const assertion = expect(api.get('/slow')).rejects.toMatchObject({ code: 'timeout', status: 0 });
      await vi.advanceTimersByTimeAsync(15_001);
      await assertion;
    });
  });

  describe('api.del 请求行为（43.1）', () => {
    it('发送 DELETE 方法并携带认证头', async () => {
      setSession('jwt-token', { username: 'u', role: 'QA', scopes: { projects: [], environments: [], businesses: [] } });
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
      vi.stubGlobal('fetch', fetchMock);
      await api.del<{ ok: boolean }>('/runs/abc');
      const [, init] = fetchMock.mock.calls[0];
      const headers = init.headers as Record<string, string>;
      expect(String(init.method ?? '')).toBe('DELETE');
      expect(headers.Authorization).toBe('Bearer jwt-token');
    });
  });
});
