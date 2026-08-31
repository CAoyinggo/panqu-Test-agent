/**
 * API 黑盒测试门禁（MVP：plan-only，真实执行未实现）。
 *
 * 规则：
 *  - API 测试默认关闭；只有 --execute-api 且提供 --api-origin 才进入评估；
 *  - origin 必须 http/https、合法、不含凭据、不含路径/查询/片段；
 *  - 非 test 语义（prod/preonline）fail closed；
 *  - origin 必须在允许列表内（默认 https://test.panqu.com，可用 PANQU_ALLOWED_TARGET_ORIGINS 覆盖）；
 *  - MVP 即使全部通过也只生成 PANQU_TEST_PLAN_V1 plan（plan-only），
 *    真实 execute 标记为 BLOCKED/未实现，不发起任何 HTTP 请求；
 *  - 绝不用普通 fetch 临时绕开已加固的安全执行器（execute_test_plan）。
 */

export const DEFAULT_ALLOWED_API_ORIGINS = new Set(['https://test.panqu.com']);

export function resolveAllowedOrigins(env = process.env) {
  const raw = env.PANQU_ALLOWED_TARGET_ORIGINS;
  if (!raw || raw.trim() === '') return DEFAULT_ALLOWED_API_ORIGINS;
  const out = new Set();
  for (const token of raw.split(',')) {
    const origin = token.trim().replace(/\/+$/, '');
    if (origin) out.add(origin);
  }
  return out.size > 0 ? out : DEFAULT_ALLOWED_API_ORIGINS;
}

const PROD_HINT = /(^|[-.])(prod|production|preonline|pre[-_]?prod|live)([-.]|$)/i;
const RESERVED_HOST_HINT = /(^|[-.])(localhost|local|127\.0\.0\.1|0\.0\.0\.0|metadata)([-.]|$)/i;

/**
 * 评估 API 请求。
 * @returns {{
 *   requested:boolean, executed:boolean, origin:string|null,
 *   status:'SKIPPED'|'BLOCKED'|'BLOCKED_PLAN_ONLY'|'ERROR',
 *   reason?:string, plan?:object, cases:Array
 * }}
 */
export function evaluateApiRequest({ executeApi, apiOrigin, allowedOrigins = null, env = process.env }) {
  if (!executeApi) {
    return {
      requested: false,
      executed: false,
      origin: null,
      status: 'SKIPPED',
      reason: '未启用 --execute-api，API 黑盒测试默认不执行',
      cases: [],
    };
  }

  if (!apiOrigin) {
    return {
      requested: true,
      executed: false,
      origin: null,
      status: 'BLOCKED',
      reason: '--execute-api 已启用但缺少 --api-origin，fail closed',
      cases: [],
    };
  }

  let url;
  try {
    url = new URL(apiOrigin);
  } catch {
    return { requested: true, executed: false, origin: apiOrigin, status: 'BLOCKED', reason: '--api-origin 不是合法 origin', cases: [] };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { requested: true, executed: false, origin: apiOrigin, status: 'BLOCKED', reason: '--api-origin 必须是 http/https origin', cases: [] };
  }
  if (url.username || url.password) {
    return { requested: true, executed: false, origin: apiOrigin, status: 'BLOCKED', reason: '--api-origin 不得内联用户名/密码', cases: [] };
  }
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    return { requested: true, executed: false, origin: apiOrigin, status: 'BLOCKED', reason: '--api-origin 必须是 origin，不含路径/查询/片段', cases: [] };
  }

  const host = url.hostname.toLowerCase();
  if (PROD_HINT.test(host)) {
    return { requested: true, executed: false, origin: apiOrigin, status: 'BLOCKED', reason: `目标 host 疑似生产/preonline 环境（${host}），不允许执行`, cases: [] };
  }
  if (RESERVED_HOST_HINT.test(host)) {
    return { requested: true, executed: false, origin: apiOrigin, status: 'BLOCKED', reason: `目标 host 为本地/保留地址（${host}），不允许执行`, cases: [] };
  }

  const normalized = `${url.protocol}//${url.host}`;
  const allowlist = allowedOrigins || resolveAllowedOrigins(env);
  if (!allowlist.has(normalized)) {
    return {
      requested: true,
      executed: false,
      origin: normalized,
      status: 'BLOCKED',
      reason: `origin ${normalized} 不在允许列表（${[...allowlist].join(', ')}），fail closed`,
      cases: [],
    };
  }

  // MVP：允许列表通过也只做 plan-only；真实执行需复用已加固的 execute_test_plan 执行器，本轮未实现。
  const plan = buildPlanOnly(normalized);
  return {
    requested: true,
    executed: false,
    origin: normalized,
    status: 'BLOCKED_PLAN_ONLY',
    reason: '允许列表校验通过，但真实 API 执行需复用已加固的 execute_test_plan 执行器，本轮未实现；仅生成 plan-only，未发起任何 HTTP 请求',
    plan,
    cases: [],
  };
}

export function buildPlanOnly(origin) {
  return {
    requirement_summary: '对本地项目验证目标做只读健康检查（plan-only，未执行）',
    target_url: origin,
    environment: 'test',
    test_scope: 'api',
    test_cases: [
      {
        id: 'TC-API-HEALTH-PLANONLY',
        name: '只读健康检查（plan-only，未执行）',
        priority: 'P0',
        type: 'API',
        steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/health' }],
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 200 }],
      },
    ],
    risks: [],
  };
}
