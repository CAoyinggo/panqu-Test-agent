// 真实环境 E2E 辅助（Phase 20.2）：统一管理 RUN_REAL_E2E 开关、真实配置、会话、Http/Billing。
// 安全约束：默认关闭（RUN_REAL_E2E=false），显式开启才会触发真实 API；
// 真实「提交」进一步需要 REAL_E2E_SUBMIT=true，避免只开 RUN_REAL_E2E 就产生真实业务副作用。
import fs from 'node:fs';
import { describe, it } from 'vitest';
import { loadConfig, getEnvironment } from '../../../src/config/config.js';
import { Http } from '../../../src/integrations/http.js';
import { Billing } from '../../../src/integrations/billing.js';
import type { AppConfig, Session } from '../../../src/core/types.js';

/** 真实 E2E 总开关：默认关闭，必须显式 RUN_REAL_E2E=true */
export const REAL_ENABLED = (process.env.RUN_REAL_E2E ?? 'false').toLowerCase() === 'true';
/** 是否允许真实提交（进一步门槛，避免默认触发真实业务副作用） */
export const REAL_SUBMIT = (process.env.REAL_E2E_SUBMIT ?? 'false').toLowerCase() === 'true';
/** 真实 E2E 环境名（默认 test） */
export const REAL_ENV = process.env.REAL_E2E_ENV ?? 'test';

/** 只读真实测试（需 RUN_REAL_E2E=true） */
export function describeReal(title: string, fn: () => void): void {
  describe.skipIf(!REAL_ENABLED)(`[real] ${title}`, fn);
}
export function itReal(title: string, fn: () => void | Promise<void>): void {
  it.skipIf(!REAL_ENABLED)(title, fn);
}
/** 含真实提交的测试（需 RUN_REAL_E2E=true 且 REAL_E2E_SUBMIT=true） */
export function itRealSubmit(title: string, fn: () => void | Promise<void>): void {
  it.skipIf(!REAL_ENABLED || !REAL_SUBMIT)(title, fn);
}

/** 真实环境上下文（含 Http 与 Billing） */
export interface RealEnvCtx {
  envName: string;
  cfg: AppConfig;
  baseUrl: string;
  submitUrl: string;
  statusUrl: string;
  detailUrl: string;
  billingUrl: string;
  csrfPage: string;
  projectId: number;
  account: string;
  http: Http;
  billing: Billing;
}

/** 加载真实配置（不含会话） */
export function loadRealConfig(envName: string = REAL_ENV): AppConfig {
  return loadConfig(envName);
}

/** 获取真实 Http + 会话（无会话则抛错，明确提示） */
export function getRealHttp(
  envName: string = REAL_ENV,
): { http: Http; session: Session; cfg: AppConfig } {
  const cfg = loadConfig(envName);
  const env = getEnvironment(cfg, envName);
  if (!fs.existsSync(cfg.session_cookies_path)) {
    throw new Error(`真实 E2E 缺少会话文件：${cfg.session_cookies_path}（请配置 TESTFLOW_SESSION_COOKIES_PATH 或准备登录态）`);
  }
  const raw = JSON.parse(fs.readFileSync(cfg.session_cookies_path, 'utf-8')) as { sessions?: Session[] };
  const session = (raw.sessions ?? []).find((s) => s.env === envName) as Session | undefined;
  if (!session?.cookie_string) {
    throw new Error(`真实 E2E 未找到环境 ${envName} 的登录态（session_cookies_path=${cfg.session_cookies_path}）`);
  }
  return { http: new Http(env.base_url, session.cookie_string), session, cfg };
}

/** 获取完整真实环境上下文 */
export function getRealEnv(envName: string = REAL_ENV): RealEnvCtx {
  const { http, session, cfg } = getRealHttp(envName);
  const env = getEnvironment(cfg, envName);
  return {
    envName,
    cfg,
    baseUrl: env.base_url ?? '',
    submitUrl: env.submit_url ?? '',
    statusUrl: env.status_url ?? '',
    detailUrl: env.detail_url ?? '',
    billingUrl: env.billing_url ?? '',
    csrfPage: env.csrf_page ?? '',
    projectId: session.project_id ?? env.project_id ?? 0,
    account: session.account ?? env.account ?? '',
    http,
    billing: new Billing(http, env.billing_url ?? ''),
  };
}
