// Platform HTTP API（Phase 24.7 + 25.3 + 25.7）：node:http 实现的统一平台 API
// 认证：JWT（AuthService，Phase 25.3）优先；静态 Bearer Token + X-Actor/X-Role 仅作为
//       development/test 内部模式（生产默认关闭）。RBAC 角色 + 资源作用域（Project/Environment）
//       双重校验。
// 25.7 Hardening：requestId/traceId（客户端可透传 X-Request-Id/X-Trace-Id）、统一错误契约
//       {error,message,status,requestId,traceId}、每 IP 限流（X-RateLimit-* 头 + 429 Retry-After）、
//       列表可选分页（?page&pageSize → {items,pagination}，默认向后兼容纯数组）。
// 所有业务逻辑委托 PlatformService（与 CLI 共用 Service Layer，禁止维护两套逻辑）。

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PlatformService } from '../service/platform-service.js';
import type { Role } from '../rbac/rbac.js';
import { hasPermission, isRole, type Permission } from '../rbac/rbac.js';
import { assertRunAccess } from '../rbac/scopes.js';
import type { AuthService } from '../auth/auth-service.js';
import type { User } from '../auth/user.js';
import type { TestRun } from '../runs/run-schema.js';
import type { TelemetryPeriod } from '../telemetry/index.js';
import { buildVersionInfo } from '../version.js';
import { isProductionLike, resolvePlatformMode, resolveStaticIdentity, type PlatformMode } from '../security/index.js';

/** 平台运行模式（25.8 完整实现；27.1 起与安全策略模块共用同一枚举，避免多头定义） */
export type PlatformRunMode = PlatformMode;

/** 27.2：带状态码的业务错误（读端点 RBAC 等返回 403 Forbidden） */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiServerOptions {
  service: PlatformService;
  /** JWT 认证服务（Phase 25.3）；未提供则退回静态 Token 内部模式 */
  auth?: AuthService;
  /** 运行模式：development/test 允许 X-Actor/X-Role 内部模式；production 关闭 */
  mode?: PlatformRunMode;
  /** 静态 Bearer Token（internal/test mode；缺省用 PLATFORM_API_TOKEN 或 dev-token） */
  token?: string;
  /** 每 IP 每分钟请求上限 */
  rateLimitPerMinute?: number;
  host?: string;
  port?: number;
  now?: () => string;
  /** Web Dashboard 静态目录（25.6）：提供时挂载 / 与 /assets/*（SPA fallback） */
  webDir?: string;
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
  /** JWT 认证用户（25.3）；内部模式为 undefined */
  user?: User;
  body: Record<string, unknown>;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  requestId: string;
  traceId: string;
}

interface Principal {
  user?: User;
  actor: string;
  role: Role;
}

const DEFAULT_TOKEN = 'dev-token';
const DEFAULT_RATE_LIMIT = 120;

export interface PlatformHttpServer {
  listen(): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
  address(): number | undefined;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

function parseBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1] : null;
}

export function createPlatformServer(opts: ApiServerOptions): PlatformHttpServer {
  const token = opts.token ?? process.env.PLATFORM_API_TOKEN ?? DEFAULT_TOKEN;
  const rateLimitPerMinute = opts.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT;
  const now = opts.now ?? (() => new Date().toISOString());
  const authService = opts.auth;
  // 27.1：运行模式统一从 PLATFORM_MODE 解析（缺省 development），避免未显式配置时静默退化为非生产模式
  const mode: PlatformRunMode = opts.mode ?? resolvePlatformMode();

  let server: http.Server | null = null;
  let boundPort: number | undefined;
  const hits = new Map<string, { windowStart: number; count: number }>();

  // ── 认证解析：JWT 优先；静态 Token → internal/test 模式（production 关闭 X-Header 直信任）──
  async function resolvePrincipal(authHeader: string | undefined, req: http.IncomingMessage): Promise<Principal | null> {
    const cred = parseBearer(authHeader);
    if (!cred) return null;
    if (authService) {
      try {
        const { user } = await authService.verify(cred);
        return { user, actor: user.username, role: (user.roles[0] as Role) ?? 'VIEWER' };
      } catch {
        /* JWT 无效，尝试内部模式（仅 development/test） */
      }
    }
    if (cred === token) {
      // 36（DEBT-12 已解决）+ 安全加固（v4.13.1）：静态身份守卫 + 解析收敛到 security.resolveStaticIdentity——
      // production 返回 null（防身份伪造不可绕过），其余模式解析 X-Actor/X-Role（默认 api/VIEWER）；
      // role 必须经 rbac.isRole 校验，非法 X-Role（如 HACKER）直接拒绝，不得 as Role 硬断言。
      const ident = resolveStaticIdentity(mode, req.headers);
      if (!ident) return null;
      if (!isRole(ident.role)) return null;
      return { user: undefined, actor: ident.actor, role: ident.role };
    }
    return null;
  }

  // ── 27.2：读端点 RBAC —— 运维只读（审计/遥测成本/Job/Worker）需要 OPS_READ，防 VIEWER 越权读敏感数据 ──
  function requireOpsRead(c: Ctx): void {
    if (!hasPermission(c.role, 'OPS_READ' satisfies Permission)) {
      throw new HttpError(403, `角色 ${c.role} 无权读取运维数据（需 OPS_READ 权限）`);
    }
  }

  // ── 认证路由（无需静态 Token 即可访问 login/refresh；logout/info 需有效凭证）──
  async function handleAuthRoute(req: http.IncomingMessage, res: http.ServerResponse, ids: { requestId: string; traceId: string }): Promise<void> {
    if (!authService) {
      sendError(res, 501, 'auth_disabled', '认证服务未启用', ids);
      return;
    }
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/auth/login') {
      const body = await readBodyJson(req, res);
      if (!body) return;
      const username = String(body.username ?? '');
      const password = String(body.password ?? '');
      if (!username || !password) {
        sendError(res, 400, 'missing_credentials', '缺少用户名或密码', ids);
        return;
      }
      try {
        const tokens = await authService.login(username, password);
        sendJson(res, 200, tokens);
      } catch (err) {
        sendError(res, 401, 'invalid_credentials', (err as Error).message, ids);
      }
      return;
    }
    if (pathname === '/auth/refresh') {
      const body = await readBodyJson(req, res);
      if (!body) return;
      const refreshToken = String(body.refreshToken ?? '');
      if (!refreshToken) {
        sendError(res, 400, 'missing_refresh_token', '缺少 refreshToken', ids);
        return;
      }
      try {
        const tokens = await authService.refresh(refreshToken);
        sendJson(res, 200, tokens);
      } catch (err) {
        sendError(res, 401, 'invalid_refresh_token', (err as Error).message, ids);
      }
      return;
    }
    if (pathname === '/auth/logout') {
      const body = await readBodyJson(req, res);
      if (!body) return;
      await authService.logout(body.refreshToken ? String(body.refreshToken) : undefined);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/auth/info') {
      const cred = parseBearer(req.headers.authorization);
      if (!cred) {
        sendError(res, 401, 'unauthorized', '缺少 Bearer Token', ids);
        return;
      }
      try {
        sendJson(res, 200, await authService.info(cred));
      } catch (err) {
        sendError(res, 401, 'unauthorized', (err as Error).message, ids);
      }
      return;
    }
    sendError(res, 404, 'not_found', `${req.method ?? 'GET'} ${pathname} 不存在`, ids);
  }

  function isAuthRoute(method: string, pathname: string): boolean {
    return (
      (method === 'POST' && (pathname === '/auth/login' || pathname === '/auth/logout' || pathname === '/auth/refresh')) ||
      (method === 'GET' && pathname === '/auth/info')
    );
  }

  // ── Run 级作用域校验（JWT 用户）──
  async function withRunScope<T>(c: Ctx, runId: string, fn: (run: TestRun) => T): Promise<T> {
    const run = await c.service.getRun(runId);
    if (!run) throw new Error(`Run 不存在：${runId}`);
    if (c.user) {
      assertRunAccess({ roles: c.user.roles, scopes: c.user.scopes }, run.projectId, run.environment);
    }
    return fn(run);
  }

  // ── 审批级作用域校验（JWT 用户；approval → run → project/env）──
  async function withApprovalScope<T>(c: Ctx, approvalId: string, fn: (approval: { runId: string; environment: string }) => T): Promise<T> {
    const approvals = await c.service.listApprovals({ approvalId });
    const approval = approvals[0];
    if (!approval) throw new Error(`审批不存在：${approvalId}`);
    if (c.user && approval.runId) {
      const run = await c.service.getRun(approval.runId);
      if (run) assertRunAccess({ roles: c.user.roles, scopes: c.user.scopes }, run.projectId, run.environment);
    }
    return fn(approval);
  }

  const routes: Route[] = [
    { method: 'POST', segments: ['projects'], handler: async (c) => c.service.createProject(c.body as never) },
    {
      method: 'GET', segments: ['projects'],
      handler: async (c) => {
        let projects = c.service.listProjects();
        if (c.user) {
          const allowed = c.user.scopes?.projects;
          if (allowed && allowed.length > 0) projects = projects.filter((p) => allowed.includes(p.id));
        }
        return maybePaginate(c.req.url, projects);
      },
    },

    { method: 'POST', segments: ['runs'], handler: async (c) => createRunHandler(c) },
    { method: 'GET', segments: ['runs'], handler: async (c) => listRunsHandler(c) },
    { method: 'GET', segments: ['runs', ':id'], handler: async (c, p) => withRunScope(c, p.id, (run) => run) },
    { method: 'POST', segments: ['runs', ':id', 'cancel'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.cancelRun(p.id, c.actor, c.role)) },
    { method: 'POST', segments: ['runs', ':id', 'retry'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.retryRun(p.id, c.actor, c.role)) },
    { method: 'GET', segments: ['runs', ':id', 'report'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.runReport(p.id)) },
    { method: 'GET', segments: ['runs', ':id', 'report', 'export'], handler: async (c, p) => withRunScope(c, p.id, () => (queryParam(c.req.url, 'format') === 'html' ? c.service.exportReportHtml(p.id) : c.service.exportReportJson(p.id))) },
    { method: 'GET', segments: ['runs', ':id', 'trace'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.getRunTrace(p.id)) },
    { method: 'GET', segments: ['runs', ':id', 'detail'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.runDetail(p.id)) },

    { method: 'GET', segments: ['test-assets'], handler: async (c) => ({ items: await c.service.listTestAssets(), source: 'platform-test-assets' }) },
    { method: 'GET', segments: ['test-assets', 'stats'], handler: async (c) => c.service.testAssetStats() },
    { method: 'GET', segments: ['knowledge'], handler: async () => ({ items: [], source: 'platform-repo-not-connected' }) },

    // ── QA Workflow（Phase 40.2）：Defect 管理（真实实体，替换此前空 stub）──
    { method: 'GET', segments: ['defects'], handler: async (c) => maybePaginate(c.req.url, await c.service.listDefects(undefined, c.user?.scopes)) },
    { method: 'POST', segments: ['defects'], handler: async (c) => c.service.createDefect({ projectId: String(c.body.projectId ?? ''), title: String(c.body.title ?? ''), severity: c.body.severity as never, environment: c.body.environment as string | undefined, runId: c.body.runId as string | undefined, caseId: c.body.caseId as string | undefined, description: c.body.description as string | undefined, evidence: c.body.evidence as unknown[] | undefined, createdBy: c.actor }, c.role, c.user?.scopes) },
    { method: 'GET', segments: ['defects', ':id'], handler: async (c, p) => { const d = await c.service.getDefect(p.id, c.user?.scopes); if (!d) throw new HttpError(404, `缺陷不存在：${p.id}`); return d; } },
    { method: 'PATCH', segments: ['defects', ':id', 'status'], handler: async (c, p) => c.service.updateDefectStatus(p.id, String(c.body.status ?? '') as never, c.body.resolution as string | undefined, c.actor, c.role, c.user?.scopes) },
    { method: 'POST', segments: ['defects', ':id', 'assign'], handler: async (c, p) => c.service.assignDefect(p.id, String(c.body.assignee ?? ''), c.actor, c.role, c.user?.scopes) },

    // ── QA Workflow（Phase 39）：Test Suite ──
    { method: 'POST', segments: ['test-suites'], handler: async (c) => c.service.createSuite({ ...(c.body as Record<string, unknown>), createdBy: c.actor } as never, c.role) },
    { method: 'GET', segments: ['test-suites'], handler: async (c) => maybePaginate(c.req.url, await c.service.listSuites(undefined, c.user?.scopes)) },
    { method: 'GET', segments: ['test-suites', ':id'], handler: async (c, p) => { const s = await c.service.getSuite(p.id, c.user?.scopes); if (!s) throw new HttpError(404, `Test Suite 不存在：${p.id}`); return s; } },
    { method: 'PATCH', segments: ['test-suites', ':id'], handler: async (c, p) => c.service.updateSuite(p.id, c.body as never, c.actor, c.role) },
    { method: 'POST', segments: ['test-suites', ':id', 'archive'], handler: async (c, p) => c.service.archiveSuite(p.id, c.actor, c.role) },
    { method: 'POST', segments: ['test-suites', ':id', 'restore'], handler: async (c, p) => c.service.restoreSuite(p.id, c.actor, c.role) },
    { method: 'POST', segments: ['test-suites', ':id', 'copy'], handler: async (c, p) => c.service.copySuite(p.id, c.actor, c.role) },
    { method: 'POST', segments: ['test-suites', ':id', 'cases'], handler: async (c, p) => c.service.addSuiteCases(p.id, ((c.body.caseIds as string[]) ?? []) as string[], c.actor, c.role) },
    { method: 'DELETE', segments: ['test-suites', ':id', 'cases'], handler: async (c, p) => c.service.removeSuiteCases(p.id, ((c.body.caseIds as string[]) ?? []) as string[], c.actor, c.role) },
    { method: 'GET', segments: ['test-suites', 'tags', ':tag'], handler: async (c, p) => c.service.listSuitesByTag([p.tag], c.user?.scopes) },

    // ── QA Workflow（Phase 39）：Test Plan ──
    { method: 'POST', segments: ['test-plans'], handler: async (c) => c.service.createPlan({ ...(c.body as Record<string, unknown>), createdBy: c.actor } as never, c.role) },
    { method: 'GET', segments: ['test-plans'], handler: async (c) => maybePaginate(c.req.url, await c.service.listPlans(undefined, c.user?.scopes)) },
    { method: 'GET', segments: ['test-plans', ':id'], handler: async (c, p) => { const plan = await c.service.getPlan(p.id, c.user?.scopes); if (!plan) throw new HttpError(404, `Test Plan 不存在：${p.id}`); return plan; } },
    { method: 'PATCH', segments: ['test-plans', ':id'], handler: async (c, p) => c.service.updatePlan(p.id, c.body as never, c.actor, c.role) },
    { method: 'POST', segments: ['test-plans', ':id', 'run'], handler: async (c, p) => c.service.runPlan(p.id, c.actor, c.role, c.user?.scopes) },
    { method: 'GET', segments: ['test-plans', ':id', 'cases'], handler: async (c, p) => c.service.planCases(p.id, c.user?.scopes) },

    // ── QA Workflow（Phase 39）：Run Template ──
    { method: 'POST', segments: ['run-templates'], handler: async (c) => c.service.createTemplate({ ...(c.body as Record<string, unknown>), createdBy: c.actor } as never, c.role) },
    { method: 'GET', segments: ['run-templates'], handler: async (c) => maybePaginate(c.req.url, await c.service.listTemplates(undefined, c.user?.scopes)) },
    { method: 'GET', segments: ['run-templates', ':id'], handler: async (c, p) => c.service.getTemplate(p.id, c.user?.scopes) },
    { method: 'POST', segments: ['run-templates', ':id', 'run'], handler: async (c, p) => c.service.runTemplate(p.id, c.actor, c.role, c.user?.scopes) },

    // ── QA Workflow（Phase 39）：Asset Versioning ──
    { method: 'GET', segments: ['assets', ':id', 'versions'], handler: async (c, p) => c.service.assetVersions(p.id, c.user?.scopes) },
    { method: 'GET', segments: ['assets', ':id', 'compare'], handler: async (c, p) => c.service.assetCompare(p.id, Number(queryParam(c.req.url, 'from') ?? 1), Number(queryParam(c.req.url, 'to') ?? 2)) },
    { method: 'POST', segments: ['assets', ':id', 'version'], handler: async (c, p) => c.service.recordAssetVersion({ assetType: String(c.body.assetType ?? 'test-case') as never, assetId: p.id, snapshot: (c.body.snapshot as Record<string, unknown>) ?? {}, createdBy: c.actor, changeReason: c.body.changeReason as string | undefined }, c.role) },

    // ── QA Workflow（Phase 39）：Run 复用 + 协作 + 分享 ──
    { method: 'POST', segments: ['runs', ':id', 'rerun'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.rerunRun(p.id, c.actor, c.role, c.user?.scopes)) },
    { method: 'POST', segments: ['runs', ':id', 'clone'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.cloneRun(p.id, { environment: c.body.environment as string | undefined, budget: c.body.budget as number | undefined, releaseGate: c.body.releaseGate as boolean | undefined }, c.actor, c.role, c.user?.scopes)) },
    { method: 'POST', segments: ['runs', ':id', 'template'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.saveTemplateFromRun(p.id, String(c.body.name ?? ''), c.actor, c.role, c.user?.scopes)) },
    { method: 'POST', segments: ['runs', ':id', 'share'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.shareRun(p.id, c.actor, c.role, c.user?.scopes)) },
    { method: 'POST', segments: ['runs', ':id', 'comments'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.addRunComment(p.id, String(c.body.body ?? ''), c.actor, c.role, c.user?.scopes)) },
    { method: 'GET', segments: ['runs', ':id', 'comments'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.listRunComments(p.id, c.user?.scopes)) },
    { method: 'POST', segments: ['runs', ':id', 'assign'], handler: async (c, p) => withRunScope(c, p.id, () => c.service.assignRun(p.id, (c.body.assignees as string[]) ?? [], c.actor, c.role, c.user?.scopes)) },

    // ── QA Workflow（Phase 39）：QA Home / Action Center ──
    { method: 'GET', segments: ['qa-home'], handler: async (c) => c.service.qaHome(c.user?.scopes) },

    { method: 'POST', segments: ['approvals', ':id', 'approve'], handler: async (c, p) => withApprovalScope(c, p.id, () => c.service.approveApproval(p.id, c.actor, c.role)) },
    { method: 'POST', segments: ['approvals', ':id', 'reject'], handler: async (c, p) => withApprovalScope(c, p.id, () => c.service.rejectApproval(p.id, c.actor, c.role)) },
    { method: 'GET', segments: ['approvals'], handler: async (c) => maybePaginate(c.req.url, await c.service.listApprovals(undefined, c.user?.scopes)) },

    { method: 'GET', segments: ['dashboard'], handler: async (c) => c.service.dashboard() },
    { method: 'GET', segments: ['health'], handler: async (c) => c.service.health() },

    // 25.5/25.6：指标与遥测（Dashboard 数据源）
    { method: 'GET', segments: ['metrics'], handler: async (c) => c.service.metrics(queryWindow(c.req.url)) },
    { method: 'GET', segments: ['metrics', 'activation'], handler: async (c) => c.service.metricsActivation() },
    { method: 'GET', segments: ['telemetry', 'snapshot'], handler: async (c) => c.service.telemetrySnapshot(queryWindow(c.req.url)) },
    { method: 'GET', segments: ['telemetry', 'cost'], handler: async (c) => { requireOpsRead(c); return c.service.telemetryCost(queryWindow(c.req.url)); } },
    {
      method: 'GET', segments: ['telemetry', 'events'],
      handler: async (c) => maybePaginate(c.req.url, await c.service.telemetryEvents(queryParam(c.req.url, 'run') ?? undefined)),
    },

    // 25.6：运维视图数据源（Dashboard；27.2：审计/Job/Worker 属运维敏感数据，需 OPS_READ）
    { method: 'GET', segments: ['jobs'], handler: async (c) => { requireOpsRead(c); return maybePaginate(c.req.url, await c.service.listJobs()); } },
    { method: 'GET', segments: ['audit'], handler: async (c) => { requireOpsRead(c); return maybePaginate(c.req.url, await c.service.listAudit()); } },
    { method: 'GET', segments: ['workers'], handler: async (c) => { requireOpsRead(c); return maybePaginate(c.req.url, await c.service.listWorkers()); } },
  ];

  /** 解析 ?window= 参数（默认 7d） */
  function queryWindow(reqUrl: string | undefined): TelemetryPeriod {
    const v = queryParam(reqUrl, 'window') ?? '7d';
    return (['1h', '6h', '24h', '7d', '30d', 'release', 'version'].includes(v) ? v : '7d') as TelemetryPeriod;
  }

  function queryParam(reqUrl: string | undefined, key: string): string | null {
    const q = (reqUrl ?? '').split('?')[1];
    if (!q) return null;
    const m = new URLSearchParams(q).get(key);
    return m;
  }

  /** 25.7：可选分页——显式传 ?page / ?pageSize 才返回 {items, pagination}；否则原样返回（向后兼容） */
  function maybePaginate<T>(reqUrl: string | undefined, items: T[]): unknown {
    const pageParam = queryParam(reqUrl, 'page');
    const sizeParam = queryParam(reqUrl, 'pageSize');
    if (pageParam === null && sizeParam === null) return items;
    const page = Math.max(1, Math.floor(Number(pageParam)) || 1);
    const pageSize = Math.min(200, Math.max(1, Math.floor(Number(sizeParam)) || 50));
    const total = items.length;
    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

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
      scopes: c.user?.scopes,
      idempotencyKey,
      // Phase 39：QA Workflow 上下文透传（Plan / Suite / Template / 模式 / 预算 / 门禁 / 资产版本）
      planId: c.body.planId ? String(c.body.planId) : undefined,
      suiteIds: Array.isArray(c.body.suiteIds) ? (c.body.suiteIds as string[]) : undefined,
      templateId: c.body.templateId ? String(c.body.templateId) : undefined,
      mode: c.body.mode ? String(c.body.mode) : undefined,
      budget: typeof c.body.budget === 'number' ? c.body.budget : undefined,
      releaseGate: typeof c.body.releaseGate === 'boolean' ? c.body.releaseGate : undefined,
      assetVersion: c.body.assetVersion as Record<string, number> | undefined,
    });
  }

  async function listRunsHandler(c: Ctx): Promise<unknown> {
    let runs = await c.service.listRuns();
    if (c.user) {
      const projects = c.user.scopes?.projects;
      if (projects && projects.length > 0) {
        runs = runs.filter((r) => projects.includes(r.projectId));
      }
    }
    return maybePaginate(c.req.url, runs);
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

  /** 25.7：每 IP 每分钟限流；返回配额信息（剩余 / 重置时间）供响应头 */
  function rateLimitInfo(ip: string): { limited: boolean; remaining: number; resetAt: string; limit: number } {
    const nowMs = Date.parse(now());
    const hit = hits.get(ip);
    if (!hit || nowMs - hit.windowStart >= 60_000) {
      hits.set(ip, { windowStart: nowMs, count: 1 });
      return { limited: false, remaining: rateLimitPerMinute - 1, resetAt: new Date(nowMs + 60_000).toISOString(), limit: rateLimitPerMinute };
    }
    hit.count += 1;
    return {
      limited: hit.count > rateLimitPerMinute,
      remaining: Math.max(0, rateLimitPerMinute - hit.count),
      resetAt: new Date(hit.windowStart + 60_000).toISOString(),
      limit: rateLimitPerMinute,
    };
  }

  /** 25.7：每请求元数据（追踪 + 限流），挂到 res 以贯穿所有响应 */
  interface RequestMeta {
    requestId: string;
    traceId: string;
    rateLimit?: { limit: number; remaining: number; resetAt: string };
  }
  type MetaResponse = http.ServerResponse & { _meta?: RequestMeta };

  function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    const meta = (res as MetaResponse)._meta;
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'X-Request-Id': meta?.requestId ?? 'static',
      'X-Trace-Id': meta?.traceId ?? 'static',
    };
    if (meta?.rateLimit) {
      headers['X-RateLimit-Limit'] = String(meta.rateLimit.limit);
      headers['X-RateLimit-Remaining'] = String(meta.rateLimit.remaining);
      headers['X-RateLimit-Reset'] = meta.rateLimit.resetAt;
    }
    Object.assign(headers, extraHeaders);
    res.writeHead(status, headers);
    res.end(payload);
  }

  /** 托管 Web Dashboard 静态资源（25.6）：/assets/* 原样返回，其余路径回退 index.html（SPA） */
  function serveIndex(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const webDir = opts.webDir;
    if (!webDir) return false;
    const file = path.join(webDir, 'index.html');
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const content = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': content.length,
        'Cache-Control': 'no-cache',
      });
      res.end(content);
      return true;
    }
    sendError(res, 404, 'dashboard_not_built', 'Web Dashboard 未构建（运行 npm run build:web 后重试）', { requestId: 'static', traceId: 'static' });
    return true;
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const webDir = opts.webDir;
    if (!webDir || (req.method ?? 'GET').toUpperCase() !== 'GET') return false;
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];
    // API 与认证路由不参与静态托管
    if (pathname === '/' || pathname === '/index.html') {
      return serveIndex(req, res);
    }
    if (pathname.startsWith('/assets/')) {
      const rel = pathname.slice(1);
      const file = path.join(webDir, rel);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        const types: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
          '.woff2': 'font/woff2',
        };
        const content = fs.readFileSync(file);
        res.writeHead(200, {
          'Content-Type': types[ext] ?? 'application/octet-stream',
          'Content-Length': content.length,
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(content);
        return true;
      }
      // 44.1 修复：/assets/:id（资产版本追溯 SPA 路由）与 vite 产物目录 /assets/* 冲突。
      // 文件不存在时：带扩展名的视为真实静态资源缺失 → 404；无扩展名（SPA 客户端路由）→ 回退，
      // 由 SPA fallback 返回 index.html（避免将 /assets/WAN3-CORE-001 误判为静态文件 404）。
      if (path.extname(pathname).length > 0) {
        sendError(res, 404, 'not_found', `${pathname} 不存在`, { requestId: 'static', traceId: 'static' });
      }
      return false;
    }
    return false;
  }

  /** 26.1：公开版本信息端点（无需认证；CI/运维确认运行版本）GET /version 与 /api/version */
  function handlePublicVersion(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== '/version' && pathname !== '/api/version') return false;
    sendJson(res, 200, buildVersionInfo());
    return true;
  }

  /** Phase 40.3：公开分享落地页 —— ?share=<token> 时无需 JWT 即可读取报告 / 导出（share token 防跨项目猜测）
   *  支持 /api 前缀（前端 api.ts baseURL=/api）；浏览器直链（Accept: text/html）放行给 SPA fallback 渲染前端公开页。 */
  async function handlePublicShare(req: http.IncomingMessage, res: http.ServerResponse, ids: { requestId: string; traceId: string }): Promise<boolean> {
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;
    const url = req.url ?? '';
    const pathname = url.split('?')[0];
    const stripped = pathname.startsWith('/api/') ? pathname.slice(4) : pathname;
    const m = /^\/runs\/([^/]+)\/report(\/export)?$/.exec(stripped);
    if (!m) return false;
    const shareToken = queryParam(url, 'share');
    if (!shareToken) return false; // 无 share 参数 → 走正常认证流程（受保护）
    // 浏览器直链分享链接 → 交给 SPA fallback 返回 index.html，由前端 ReadOnlyRunReport 渲染（再从 /api 取数据）
    if ((req.headers.accept ?? '').includes('text/html')) return false;
    const runId = m[1];
    const isExport = !!m[2];
    try {
      const ok = await opts.service.verifyShare(runId, shareToken);
      if (!ok) {
        sendError(res, 403, 'share_invalid', '分享链接无效或已失效', ids);
        return true;
      }
      if (isExport) {
        const format = queryParam(url, 'format');
        const body = format === 'html' ? await opts.service.exportReportHtml(runId) : await opts.service.exportReportJson(runId);
        res.writeHead(200, {
          'Content-Type': format === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      } else {
        const report = await opts.service.runReport(runId);
        sendJson(res, 200, report);
      }
      return true;
    } catch (err) {
      const e = err as Error;
      const isForbidden = /无权|缺少权限|禁止|越权/.test(e.message);
      sendError(res, /不存在/.test(e.message) ? 404 : isForbidden ? 403 : 500, 'error', e.message, ids);
      return true;
    }
  }

  /** 前端 /api 前缀 → 根路由（25.6：Dashboard 与 API 同源部署） */
  function stripApiPrefix(u: string): string {
    const pathname = u.split('?')[0];
    if (pathname === '/api') return u.replace('/api', '/');
    if (pathname.startsWith('/api/')) {
      const q = u.includes('?') ? u.slice(u.indexOf('?')) : '';
      return `/${pathname.slice(4)}${q}`;
    }
    return u;
  }

  function sendError(
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
    ids: { requestId: string; traceId: string },
    extraHeaders: Record<string, string> = {},
  ): void {
    const meta = (res as MetaResponse)._meta;
    sendJson(
      res,
      status,
      {
        error: code,
        message,
        status,
        requestId: meta?.requestId ?? ids.requestId,
        traceId: meta?.traceId ?? ids.traceId,
      },
      extraHeaders,
    );
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

  async function readBodyJson(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | null> {
    const raw = await readBody(req);
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      sendError(res, 400, 'invalid_json', '请求体不是合法 JSON', { requestId: 'unknown', traceId: 'unknown' });
      return null;
    }
  }

  server = http.createServer(async (req, res) => {
    const start = Date.now();
    const ip = req.socket.remoteAddress ?? 'unknown';
    // 25.7：客户端可透传 X-Request-Id / X-Trace-Id 用于跨服务链路关联；否则服务端生成
    const rawReqId = String(req.headers['x-request-id'] ?? '').slice(0, 64);
    const rawTraceId = String(req.headers['x-trace-id'] ?? '').slice(0, 64);
    const requestId = rawReqId || newId('req');
    const traceId = rawTraceId || newId('trace');
    (res as MetaResponse)._meta = { requestId, traceId };
    const ids = { requestId, traceId };
    try {
      const url = req.url ?? '/';
      const method = (req.method ?? 'GET').toUpperCase();
      const pathname = url.split('?')[0];

      // 25.6：Web Dashboard 静态资源（先于认证/API 路由处理）
      if (serveStatic(req, res)) return;

      // 26.1：公开版本信息（无需认证）
      if (handlePublicVersion(req, res)) return;

      // Phase 40.3：公开分享落地页（?share=<token> 无需 JWT 读报告/导出；无 share 参数回退正常认证流程）
      if (await handlePublicShare(req, res, ids)) return;

      // 认证路由无需静态 Token
      if (isAuthRoute(method, pathname)) {
        await handleAuthRoute(req, res, ids);
        return;
      }

      // 25.6：SPA fallback——浏览器直链/刷新（Accept: text/html）回退 index.html；
      // /api、/auth 与 fetch 默认 Accept(*/*) 不受影响，仍走 API。
      if (
        opts.webDir &&
        method === 'GET' &&
        (req.headers.accept ?? '').includes('text/html') &&
        !pathname.startsWith('/api') &&
        !pathname.startsWith('/auth')
      ) {
        if (serveIndex(req, res)) return;
      }

      const principal = await resolvePrincipal(req.headers.authorization, req);
      if (!principal) {
        sendError(res, 401, 'unauthorized', '缺少或无效的 Bearer Token', ids);
        return;
      }
      // 25.7：限流（配额信息注入所有响应头；超限返回 429 + Retry-After）
      const rl = rateLimitInfo(ip);
      (res as MetaResponse)._meta!.rateLimit = rl;
      if (rl.limited) {
        sendError(res, 429, 'rate_limited', '请求过于频繁', ids, { 'Retry-After': '1' });
        return;
      }
      const m = match(stripApiPrefix(url), method);
      if (!m) {
        sendError(res, 404, 'not_found', `${method} ${pathname} 不存在`, ids);
        return;
      }
      let body: Record<string, unknown> = {};
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const parsed = await readBodyJson(req, res);
        if (!parsed) return;
        body = parsed;
      }
      const ctx: Ctx = {
        service: opts.service,
        actor: principal.actor,
        role: principal.role,
        user: principal.user,
        body,
        req,
        res,
        requestId,
        traceId,
      };
      const result = await m.route.handler(ctx, m.params);
      sendJson(res, 200, result);
    } catch (err) {
      const e = err as Error;
      // 27.2：HttpError 携带显式状态码（如读端点 RBAC 的 403 Forbidden）；
      // Phase 39：权限/作用域拒绝（RBAC 不足 / 项目环境越权）语义化为 403 Forbidden；
      // 其余按业务错误语义映射为 400，未识别异常 500。
      const isForbidden = /无权|缺少权限|禁止|越权/.test(e.message);
      const status = e instanceof HttpError ? e.status : isForbidden ? 403 : /权限|缺少|不存在|非法|重复|已存在/.test(e.message) ? 400 : 500;
      sendError(res, status, 'error', e.message, ids);
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
