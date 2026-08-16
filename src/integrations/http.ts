// HTTP 封装：登录态注入、CSRF token 获取、统一请求日志、重试与超时
import type { Session } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { readJson } from '../utils/fs-utils.js';
import { withRetry, type RetryOptions } from '../utils/retry.js';
import { metrics } from '../utils/metrics.js';

export const API_HEADERS: Record<string, string> = {
  accept: 'application/json, text/javascript, */*; q=0.01',
  'x-requested-with': 'XMLHttpRequest',
};

export interface ApiResult {
  status: number;
  json: any;
}

export interface ApiOpts {
  form?: FormData | null;
  body?: unknown;
  headers?: Record<string, string>;
  /** 重试次数覆盖（GET 默认 3，POST 默认 0） */
  retries?: number;
  /** 单次请求超时毫秒（默认 15000） */
  timeout?: number;
  /** 是否可重试覆盖（GET 默认 true，POST 默认 false） */
  retryable?: boolean;
}

export class Http {
  baseUrl: string;
  cookieString: string;

  constructor(baseUrl: string, cookieString: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '') + '/';
    this.cookieString = cookieString;
  }

  /** 从页面 HTML 提取 CSRF token */
  async getCsrfToken(pagePath: string): Promise<string> {
    const res = await fetch(this.baseUrl + pagePath, { headers: { cookie: this.cookieString } });
    const html = await res.text();
    const m = html.match(/__token__["']?\s*value=["']([^"']+)["']/);
    return m ? m[1] : '';
  }

  /** 通用请求：path 相对路径，返回 { status, json }
   *  GET/HEAD 默认可重试 3 次；POST 等默认不重试（防重复扣费）。
   *  可通过 opts.retryable / opts.retries 覆盖。
   */
  async api(name: string, method: string, path: string, opts: ApiOpts = {}): Promise<ApiResult> {
    const methodUpper = method.toUpperCase();
    const isQuery = methodUpper === 'GET' || methodUpper === 'HEAD';
    const retryOpts: RetryOptions = {
      retries: opts.retries ?? (isQuery ? 3 : 0),
      timeout: opts.timeout ?? 15000,
      retryable: opts.retryable ?? isQuery,
      onRetry: () => metrics.recordApiRetry(),
    };

    return withRetry(async () => {
      const t0 = Date.now();
      const h: Record<string, string> = { ...API_HEADERS, ...(opts.headers || {}), cookie: this.cookieString };
      const fOpts: RequestInit = { method, headers: h };
      if (opts.form) fOpts.body = opts.form as any;
      else if (opts.body !== undefined && opts.body !== null) {
        fOpts.body = JSON.stringify(opts.body);
        h['content-type'] = 'application/json';
      }
      const res = await fetch(this.baseUrl + path, fOpts);
      const txt = await res.text();
      let j: any = {};
      try {
        j = JSON.parse(txt);
      } catch {
        j = { raw: txt.slice(0, 300) };
      }
      logger.debug(`  [${name}] ${method} ${path} -> ${res.status} (${Date.now() - t0}ms)`);
      return { status: res.status, json: j };
    }, retryOpts);
  }

  /** 从 session-cookies.json 加载指定环境会话 */
  static loadSession(sessionPath: string, env: string): Session {
    const S = readJson<{ sessions: Session[] }>(sessionPath);
    if (!S || !S.sessions) throw new Error(`登录态文件无效或缺失：${sessionPath}`);
    const s = S.sessions.find((x) => x.env === env);
    if (!s) throw new Error(`未找到环境 ${env} 的登录态`);
    return s;
  }
}
