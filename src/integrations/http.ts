// HTTP 封装：登录态注入、CSRF token 获取、统一请求日志、重试与超时
import type { Session } from '../core/types.js';
import type { HttpRecord } from '../core/types.js';
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
  /** 请求级取消信号（与实例级 signal 取或：任一触发即中止） */
  signal?: AbortSignal;
}

/** HTTP 请求记录回调类型（debug verbose/full 模式使用） */
export type HttpRecorder = (record: HttpRecord) => void;

/** 合并多个取消信号（任一触发即中止，保留触发方的 reason 语义） */
function anySignal(signals: Array<AbortSignal | undefined | null>): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  const controller = new AbortController();
  for (const s of live) {
    const forward = () => {
      if (!controller.signal.aborted) controller.abort(s.reason);
    };
    if (s.aborted) forward();
    else s.addEventListener('abort', forward, { once: true });
  }
  return controller.signal;
}

export class Http {
  baseUrl: string;
  cookieString: string;
  /** 请求记录器（设置后每个请求/响应都会被记录） */
  recorder?: HttpRecorder;
  /** 当前步骤名（用于记录关联） */
  currentStep: string = 'unknown';
  /**
   * 实例级取消信号（用例超时/取消贯穿链路：Engine → Pipeline → Http → fetch）。
   * Pipeline 在进入 teardown 清理阶段时可替换为新信号（宽限清理仍可发请求）。
   */
  signal?: AbortSignal;

  constructor(baseUrl: string, cookieString: string, signal?: AbortSignal) {
    this.baseUrl = baseUrl.replace(/\/$/, '') + '/';
    this.cookieString = cookieString;
    this.signal = signal;
  }

  /** 替换实例级取消信号（Pipeline 进入清理阶段时用于解除执行期信号） */
  setSignal(signal: AbortSignal | undefined): void {
    this.signal = signal;
  }

  /** 设置请求记录器（--debug-level verbose/full 模式） */
  setRecorder(recorder: HttpRecorder): void {
    this.recorder = recorder;
  }

  /** 设置当前步骤名（供 recorder 关联步骤） */
  setStep(step: string): void {
    this.currentStep = step;
  }

  /** 从页面 HTML 提取 CSRF token */
  async getCsrfToken(pagePath: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(this.baseUrl + pagePath, { headers: { cookie: this.cookieString }, signal: signal ?? this.signal });
    const html = await res.text();
    const m = html.match(/__token__["']?\s*value=["']([^"']+)["']/);
    return m ? m[1] : '';
  }

  /** 通用请求：path 相对路径，返回 { status, json }
   *  GET/HEAD 默认可重试 3 次；POST 等默认不重试（防重复扣费）。
   *  可通过 opts.retryable / opts.retries 覆盖。
   *  超时/取消通过 AbortSignal 真实中止底层 fetch（不是放弃等待）。
   */
  async api(name: string, method: string, path: string, opts: ApiOpts = {}): Promise<ApiResult> {
    const methodUpper = method.toUpperCase();
    const isQuery = methodUpper === 'GET' || methodUpper === 'HEAD';
    const retryOpts: RetryOptions = {
      retries: opts.retries ?? (isQuery ? 3 : 0),
      timeout: opts.timeout ?? 15000,
      retryable: opts.retryable ?? isQuery,
      onRetry: () => metrics.recordApiRetry(),
      signal: anySignal([this.signal, opts.signal]),
    };

    return withRetry(async (attemptSignal) => {
      const t0 = Date.now();
      const h: Record<string, string> = { ...API_HEADERS, ...(opts.headers || {}), cookie: this.cookieString };
      const fOpts: RequestInit = { method, headers: h, signal: attemptSignal };
      let reqBodyPreview: unknown = undefined;
      if (opts.form) {
        fOpts.body = opts.form as any;
        reqBodyPreview = '(FormData)';
      } else if (opts.body !== undefined && opts.body !== null) {
        fOpts.body = JSON.stringify(opts.body);
        h['content-type'] = 'application/json';
        reqBodyPreview = opts.body;
      }
      const fullUrl = this.baseUrl + path;
      const res = await fetch(fullUrl, fOpts);
      const txt = await res.text();
      let j: any = {};
      try {
        j = JSON.parse(txt);
      } catch {
        j = { raw: txt.slice(0, 300) };
      }
      const durationMs = Date.now() - t0;
      logger.debug(`  [${name}] ${method} ${path} -> ${res.status} (${durationMs}ms)`);

      // 记录请求/响应（debug verbose/full 模式）
      if (this.recorder) {
        this.recorder({
          step: this.currentStep,
          timestamp: new Date().toISOString(),
          name,
          method: methodUpper,
          url: fullUrl,
          requestHeaders: { ...h, cookie: '(hidden)' },
          requestBody: reqBodyPreview,
          responseStatus: res.status,
          responseBody: j,
          durationMs,
        });
      }

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
