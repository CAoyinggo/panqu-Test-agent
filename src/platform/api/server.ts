// Platform HTTP API（Phase 24.7）：node:http 实现的统一平台 API
// 认证（Bearer Token）+ RBAC（X-Actor / X-Role 头，由上游身份网关注入）+ 限流 + 请求校验 + 审计。
// 所有业务逻辑委托 PlatformService（与 CLI 共用 Service Layer，禁止维护两套逻辑）。

import http from 'node:http';
import type { PlatformService } from '../service/platform-service.js';
import type { Role } from '../rbac/rbac.js';

export interface ApiServerOptions {
  service: PlatformService;
  /** Bearer Token（缺省用 PLATFORM_API_TOKEN 或 dev-token） */
  token?: string;
  /** 每 IP 每分钟请求上限 */
  rateLimitPerMinute?: number;
  host?: string;
  port?: number;
  now?: () => string;
}

interface Route {
  method: string;
  segments: string[];
  handler: (ctx: Ctx, params: Record<string, string>) => Promise<unknown>;
}

interface Ctx {
  service: PlatformService;
  actor: string;
  role: Role;
  body: Record<string, unknown>;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

const DEFAULT_TOKEN = 'dev-token';
const DEFAULT_RATE_LIMIT = 120;

export interface PlatformHttpServer {
  listen(): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
  address(): number | undefined;
}

export function createPlatformServer(opts: ApiServerOptions): PlatformHttpServer {
  const token = opts.token ?? process.env.PLATFORM_API_TOKEN ?? DEFAULT_TOKEN;
  const rateLimitPerMinute = opts.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT;
  const now = opts.now ?? (() => new Date().toISOString());

  let server: http.Server | null = null;
  let boundPort: number | undefined;
  const hits = new Map<string, { windowStart: number; count: number }>();

  const routes: Route[] = [
    { method: 'POST', segments: ['projects'], handler: async (c) => c.service.createProject(c.body as never) },
    { method: 'GET', segments: ['projects'], handler: async (c) => c.service.listProjects() },

    { method: 'POST', segments: ['runs'], handler: async (c) => createRunHandler(c) },
    { method: 'GET', segments: ['runs', ':id'], handler: async (c, p) => c.service.getRun(p.id) },
    { method: 'POST', segments: ['runs', ':id', 'cancel'], handler: async (c, p) => c.service.cancelRun(p.id, c.actor, c.role) },
    { method: 'POST', segments: ['runs', ':id', 'retry'], handler: async (c, p) => c.service.retryRun(p.id, c.actor, c.role) },
    { method: 'GET', segments: ['runs', ':id', 'report'], handler: async (c, p) => c.service.getRunReport(p.id) },
    { method: 'GET', segments: ['runs', ':id', 'trace'], handler: async (c, p) => c.service.getRunTrace(p.id) },
    { method: 'GET', segments: ['runs', ':id', 'detail'], handler: async (c, p) => c.service.runDetail(p.id) },

    { method: 'GET', segments: ['test-assets'], handler: async () => ({ items: [], source: 'platform-repo-not-connected' }) },
    { method: 'GET', segments: ['defects'], handler: async () => ({ items: [], source: 'platform-repo-not-connected' }) },
    { method: 'GET', segments: ['knowledge'], handler: async () => ({ items: [], source: 'platform-repo-not-connected' }) },

    { method: 'POST', segments: ['approvals', ':id', 'approve'], handler: async (c, p) => c.service.approveApproval(p.id, c.actor, c.role) },
    { method: 'POST', segments: ['approvals', ':id', 'reject'], handler: async (c, p) => c.service.rejectApproval(p.id, c.actor, c.role) },
    { method: 'GET', segments: ['approvals'], handler: async (c) => c.service.listApprovals() },

    { method: 'GET', segments: ['dashboard'], handler: async (c) => c.service.dashboard() },
    { method: 'GET', segments: ['health'], handler: async (c) => c.service.health() },
  ];

  async function createRunHandler(c: Ctx): Promise<unknown> {
    const idempotencyKey = c.req.headers['idempotency-key'] ? String(c.req.headers['idempotency-key']) : undefined;
    return c.service.createRun({
      projectId: String(c.body.projectId ?? ''),
      environment: String(c.body.environment ?? ''),
      trigger: (c.body.trigger as never) ?? 'manual',
      businessId: c.body.businessId ? String(c.body.businessId) : undefined,
      feature: c.body.feature ? String(c.body.feature) : undefined,
      change: c.body.change as never,
      actor: c.actor,
      role: c.role,
      idempotencyKey,
    });
  }

  function match(reqUrl: string, method: string): { route: Route; params: Record<string, string> } | null {
    const pathname = reqUrl.split('?')[0];
    const segs = pathname.split('/').filter(Boolean);
    for (const r of routes) {
      if (r.method !== method) continue;
      if (r.segments.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.segments[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
        else if (p !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }

  function authOk(authHeader: string | undefined): boolean {
    return authHeader === `Bearer ${token}`;
  }

  function rateLimited(ip: string): boolean {
    const t = now();
    const nowMs = Date.parse(t);
    const hit = hits.get(ip);
    if (!hit || nowMs - hit.windowStart >= 60_000) {
      hits.set(ip, { windowStart: nowMs, count: 1 });
      return false;
    }
    hit.count += 1;
    return hit.count > rateLimitPerMinute;
  }

  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) reject(new Error('请求体过大'));
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  server = http.createServer(async (req, res) => {
    const start = Date.now();
    const ip = req.socket.remoteAddress ?? 'unknown';
    try {
      if (!authOk(req.headers.authorization)) {
        sendJson(res, 401, { error: 'unauthorized', message: '缺少或无效的 Bearer Token' });
        return;
      }
      if (rateLimited(ip)) {
        sendJson(res, 429, { error: 'rate_limited', message: '请求过于频繁' });
        return;
      }
      const url = req.url ?? '/';
      const method = (req.method ?? 'GET').toUpperCase();
      const m = match(url, method);
      if (!m) {
        sendJson(res, 404, { error: 'not_found', message: `${method} ${url.split('?')[0]} 不存在` });
        return;
      }
      let body: Record<string, unknown> = {};
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const raw = await readBody(req);
        if (raw.trim()) {
          try {
            body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            sendJson(res, 400, { error: 'invalid_json', message: '请求体不是合法 JSON' });
            return;
          }
        }
      }
      const ctx: Ctx = {
        service: opts.service,
        actor: String(req.headers['x-actor'] ?? 'api'),
        role: (req.headers['x-role'] as Role) ?? 'VIEWER',
        body,
        req,
        res,
      };
      const result = await m.route.handler(ctx, m.params);
      sendJson(res, 200, result);
    } catch (err) {
      const e = err as Error;
      const status = /权限|缺少|无权|不存在|非法|重复|禁止|已存在/.test(e.message) ? 400 : 500;
      sendJson(res, status, { error: 'error', message: e.message });
    } finally {
      // 运维指标：记录 API 延迟
      opts.service.recordApiLatency(Date.now() - start);
    }
  });

  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server!.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
          const a = server!.address() as { port: number } | null;
          boundPort = a?.port;
          resolve();
        });
        server!.on('error', reject);
      });
      return { port: boundPort!, url: `http://127.0.0.1:${boundPort}` };
    },
    async close() {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },
    address() {
      return boundPort;
    },
  };
}
