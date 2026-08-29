// Plan Executor：第一阶段确定性 HTTP 执行器。
//
// 职责（无 LLM、无 Runtime LLM、无 MockLLM、不读 LLM_PROVIDER、不调模型 API、不调 traecli）：
//   1. 按 classifyPlanCase 将用例分为 EXECUTABLE / DESIGNED_ONLY；
//   2. 对 EXECUTABLE 用例在「通过 Policy Gate」之后执行确定性命中 HTTP_REQUEST 的请求：
//      - origin 允许列表（fail-closed）+ 每一步重定向必须同源；
//      - 字面 host 检查 + DNS 解析后逐 IP 复查 SSRF（DNS 失败 fail-closed）；
//      - 流式读取 Response.body，超过 maxResponseBytes 立即 cancel/abort；
//      - budget_cases 限制可执行用例数、budget_duration 为整个计划的总时限；
//   3. 确定性评估断言（STATUS_CODE / RESPONSE_HEADER / JSON_PATH / JSON_VALUE / CONTAINS / TYPE）；
//   4. 统计 designed/executable/executed/passed/failed/network-errors/blocks 等。
//
// DESIGNED_ONLY 用例不进入通过率分母；未执行用例必须标注「已设计，当前执行器不支持，未执行」。

import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { extractPath } from '../../core/path-extractor.js';
import { applyOperator } from '../../core/assertion-operators.js';
import {
  classifyPlanCase,
  isBlockedHost,
  isBlockedIpAddress,
  type NormalizedAssertion,
  type NormalizedCase,
  type NormalizedPlan,
  type PlanCaseClass,
} from '../plan/plan-contract.js';

export type CaseExecutionStatus =
  | 'PASSED'
  | 'FAILED'
  | 'ERROR'
  | 'DESIGNED_ONLY'
  | 'RESPONSE_TOO_LARGE'
  | 'BLOCKED'
  | 'BLOCKED_BY_BUDGET';

export interface AssertionExecutionResult {
  id: string;
  type: NormalizedAssertion['type'];
  path?: string;
  header?: string;
  operator: string;
  expected?: unknown;
  actual?: unknown;
  pass: boolean;
  detail: string;
}

export interface HttpExecutionEvidence {
  method: string;
  url: string;
  status: number;
  statusText: string;
  durationMs: number;
  /** 是否命中 SSRF / 域名解析 / 跨域重定向阻断。 */
  ssrfBlocked: boolean;
}

export interface PlanCaseExecutionResult {
  caseId: string;
  name: string;
  classification: PlanCaseClass;
  status: CaseExecutionStatus;
  reason?: string;
  assertions: AssertionExecutionResult[];
  http?: HttpExecutionEvidence;
}

export interface PlanExecutionSummary {
  designedTotal: number;
  executableTotal: number;
  /** 实际发起过 HTTP 请求的可执行用例数（PASSED/FAILED/ERROR/RESPONSE_TOO_LARGE）。 */
  executedTotal: number;
  passed: number;
  failed: number;
  /** 网络层错误（fetch 抛错 / 超时）。 */
  networkErrors: number;
  /** 响应体超过上限。 */
  responseTooLarge: number;
  /** SSRF / origin 允许列表 / DNS / 跨域重定向阻断。 */
  blocked: number;
  /** 预算（budget_cases / budget_duration）阻断，未请求网络。 */
  blockedByBudget: number;
  designedOnly: number;
  /** passed / executed_total；executed_total 为 0 时为 null。 */
  passRate: number | null;
}

export interface PlanExecutionResult {
  schema: 'panqu-test-agent/plan-execution-result@1';
  planId?: string;
  planHash?: string;
  targetUrl: string;
  environment: string;
  startedAt: string;
  endedAt: string;
  summary: PlanExecutionSummary;
  caseResults: PlanCaseExecutionResult[];
}

export type ResolveHostFn = (hostname: string) => Promise<string[]>;

/** 响应体读取错误分类：超限 / 流错误 / 中止（超时或预算）/ 超时。 */
export type BodyReadError = 'RESPONSE_TOO_LARGE' | 'STREAM_ERROR' | 'ABORTED' | 'TIMEOUT';
export type BodyReadOutcome = { ok: true; text: string } | { ok: false; error: BodyReadError };

/** 确定性 HTTP 传输层：socket 必须连接「已校验公开 IP」，禁止重新解析 hostname（防 DNS rebinding）。 */

export interface PinnedHttpRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** 已通过 SSRF 校验的公开地址；socket 只能连接其中地址。 */
  addresses: string[];
  timeoutMs: number;
  signal: AbortSignal;
}

export interface PinnedHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** 带字节上限的流式读取；超限立即取消；signal 中止时返回 ABORTED。 */
  readText(maxBytes: number, signal?: AbortSignal): Promise<BodyReadOutcome>;
  /** 取消 / 释放响应体（重定向等丢弃 body 时调用）。 */
  drain(): Promise<void>;
}

export type PinnedHttpTransport = (req: PinnedHttpRequest) => Promise<PinnedHttpResponse>;

export interface ExecutePlanOptions {
  /** 单次 HTTP 超时（毫秒）。 */
  httpTimeoutMs?: number;
  /** 最大重定向次数。 */
  maxRedirects?: number;
  /** 额外主机黑名单。 */
  blockedHosts?: ReadonlySet<string>;
  /** 服务端允许的目标 origin（未配置时 fail-closed）。 */
  allowedTargetOrigins?: ReadonlySet<string>;
  /** 响应体字节上限。 */
  maxResponseBytes?: number;
  /** 注入 plan_id / plan_hash 到结果头。 */
  planId?: string;
  planHash?: string;
  /** 本次最多执行的 EXECUTABLE 用例数（超出标 BLOCKED_BY_BUDGET）。 */
  budgetCases?: number;
  /** 整个计划的总执行时限（毫秒）。 */
  budgetDurationMs?: number;
  /** DNS 解析注入点（测试用）。 */
  resolveHost?: ResolveHostFn;
  /** 传输层注入点（测试用）；默认使用「已校验 IP 绑定」的 http/https 实现。 */
  transport?: PinnedHttpTransport;
  /** 时间源注入点（测试用）。 */
  now?: () => number;
}

const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

function defaultResolveHost(hostname: string): Promise<string[]> {
  return lookup(hostname, { all: true }).then((results) => results.map((r) => r.address));
}

function originOfUrl(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/** 拼接相对/绝对 step.url 到 target_url，并复查字面 SSRF。 */
function resolveStepUrl(targetUrl: string, stepUrl: string, blockedHosts: ReadonlySet<string>): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(stepUrl, targetUrl);
  } catch {
    return { error: `无法解析 step.url：${stepUrl}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `仅支持 HTTP/HTTPS：${url.protocol}` };
  }
  if (url.username || url.password) {
    return { error: 'URL 不得内联用户名或密码' };
  }
  if (isBlockedHost(url.hostname, blockedHosts)) {
    return { error: `目标主机被禁止访问（SSRF）：${url.hostname}` };
  }
  return { url };
}

/** origin 允许列表 + 重定向同源约束。 */
function assertOriginAllowed(url: URL, allowedOrigins: ReadonlySet<string>, rootOrigin: string): string | null {
  if (allowedOrigins.size === 0) {
    return '未配置允许的目标 origin（fail-closed）';
  }
  const origin = originOfUrl(url);
  if (!allowedOrigins.has(origin)) {
    return `origin ${origin} 不在服务端允许列表`;
  }
  if (origin !== rootOrigin) {
    return `跨域重定向被禁止：${rootOrigin} -> ${origin}`;
  }
  return null;
}

/** DNS 解析受 deadline / AbortSignal 约束：即使底层 Promise 无法取消，上层也必须及时返回并忽略迟到结果。 */
export type ResolveHostOutcome =
  | { kind: 'ok'; addresses: string[] }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' };

export function resolveHostWithTimeout(
  resolveHost: ResolveHostFn,
  hostname: string,
  options: { signal?: AbortSignal; deadlineMs?: number; now?: () => number } = {},
): Promise<ResolveHostOutcome> {
  const signal = options.signal;
  const deadlineMs = options.deadlineMs;
  const now = options.now ?? (() => Date.now());

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const onAbort = (): void => finish({ kind: 'aborted' });
    const cleanup = (): void => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (outcome: ResolveHostOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    // deadline 已过：立即 fail-closed，不再发起任何等待。
    if (deadlineMs !== undefined && now() >= deadlineMs) {
      finish({ kind: 'aborted' });
      return;
    }
    if (signal) {
      if (signal.aborted) { finish({ kind: 'aborted' }); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (deadlineMs !== undefined) {
      const remaining = Math.max(0, deadlineMs - now());
      timer = setTimeout(() => finish({ kind: 'aborted' }), remaining);
    }

    // 底层 Promise 无法强制取消：迟到结果在 settled 后会被 finish 忽略。
    resolveHost(hostname).then(
      (addresses) => finish({ kind: 'ok', addresses }),
      () => finish({ kind: 'error', message: `DNS 解析失败（fail-closed）：${hostname}` }),
    );
  });
}

/** 字面 host + DNS 解析后逐 IP 的 SSRF 复查（DNS 失败 fail-closed），返回已校验的公开地址供 socket 绑定。 */
async function resolveSafeAddresses(
  url: URL,
  blockedHosts: ReadonlySet<string>,
  resolveHost: ResolveHostFn,
  opts: { signal?: AbortSignal; deadlineMs?: number; now?: () => number } = {},
): Promise<{ addresses: string[] } | { error: string } | { aborted: true }> {
  const hostname = url.hostname;
  if (!hostname || isBlockedHost(hostname, blockedHosts)) {
    return { error: `目标主机被禁止访问（SSRF）：${hostname}` };
  }
  if (isIP(hostname) !== 0) {
    return isBlockedIpAddress(hostname)
      ? { error: `目标主机为禁止地址（SSRF）：${hostname}` }
      : { addresses: [hostname] };
  }
  const outcome = await resolveHostWithTimeout(resolveHost, hostname, opts);
  if (outcome.kind === 'aborted') return { aborted: true };
  if (outcome.kind === 'error') return { error: outcome.message };
  const addresses = outcome.addresses;
  if (addresses.length === 0) {
    return { error: `DNS 解析无结果（fail-closed）：${hostname}` };
  }
  for (const addr of addresses) {
    if (isBlockedIpAddress(addr)) {
      return { error: `目标主机解析到禁止地址（SSRF）：${hostname} -> ${addr}` };
    }
  }
  return { addresses };
}

/** 将 path_params 替换到 URL 模板（{name} 或 :name），query 追加为查询串。 */
function buildRequestUrl(url: URL, pathParams: Record<string, unknown>, query: Record<string, unknown>): URL {
  let pathname = url.pathname;
  for (const [key, value] of Object.entries(pathParams)) {
    const val = encodeURIComponent(String(value));
    pathname = pathname.split(`{${key}}`).join(val).split(`:${key}`).join(val);
  }
  const out = new URL(url.href);
  out.pathname = pathname;
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) out.searchParams.append(key, String(item));
    } else {
      out.searchParams.set(key, String(value));
    }
  }
  return out;
}

/** Node LookupFunction 返回的地址项（options.all=true 时使用数组回调）。 */
export interface PinnedLookupAddress {
  address: string;
  family: number;
}

export type PinnedLookupCallback =
  | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void)
  | ((err: NodeJS.ErrnoException | null, addresses: PinnedLookupAddress[]) => void);

export type PinnedLookupFunction = (
  hostname: string,
  options: { all?: boolean; family?: number; hints?: number },
  callback: PinnedLookupCallback,
) => void;

/** 构造「只返回已校验公开 IP」的 lookup 回调，禁止再触发真实 DNS（socket 层面防 DNS rebinding）。
 *  遵守 Node LookupFunction 的 family 语义：family=4 只 IPv4、family=6 只 IPv6、family=0/缺省走安全优选；
 *  指定 family 无对应地址时 fail-closed（不回退到另一地址族）。 */
export function pinnedLookupFactory(addresses: ReadonlyArray<string>): PinnedLookupFunction {
  const candidates = addresses.filter((a) => isIP(a) !== 0);
  return (_hostname, options, cb) => {
    const opts = options && typeof options === 'object' ? options : {};
    const all = opts.all === true;
    const family: number = typeof opts.family === 'number' ? opts.family : 0;

    // family 过滤：0 表示不限制（保留 SSRF 校验后的全部地址）。
    const filtered = family === 0 ? candidates : candidates.filter((a) => isIP(a) === family);
    if (filtered.length === 0) {
      // 指定 family 或空地址均 fail-closed，不得回退到其它地址族。
      const err: NodeJS.ErrnoException = new Error('无可用已校验地址（pinned-lookup fail-closed）');
      err.code = 'EAI_AGAIN';
      if (all) (cb as (e: NodeJS.ErrnoException | null, a: PinnedLookupAddress[]) => void)(err, []);
      else (cb as (e: NodeJS.ErrnoException | null, a: string, f: number) => void)(err, '', 0);
      return;
    }
    if (all) {
      const list = filtered.map((address) => ({ address, family: isIP(address) as number }));
      (cb as (e: NodeJS.ErrnoException | null, a: PinnedLookupAddress[]) => void)(null, list);
      return;
    }
    const preferred = family === 0
      ? (filtered.find((a) => isIP(a) === 4) ?? filtered[0])
      : filtered[0];
    (cb as (e: NodeJS.ErrnoException | null, a: string, f: number) => void)(null, preferred, isIP(preferred) as number);
  };
}

/** 流式读取 Node IncomingMessage；按字节累计，超过 maxBytes 立即销毁流并返回 RESPONSE_TOO_LARGE。 */
function readStreamLimited(stream: Readable, maxBytes: number, signal?: AbortSignal): Promise<BodyReadOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (outcome: BodyReadOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const onAbort = (): void => {
      finish({ ok: false, error: 'ABORTED' });
      stream.destroy();
    };
    const cleanup = (): void => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    stream.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        finish({ ok: false, error: 'RESPONSE_TOO_LARGE' });
        stream.destroy();
      } else {
        chunks.push(buf);
      }
    });
    stream.on('end', () => { if (settled) return; finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }); });
    // 流错误 / 中止必须 fail-closed：不把部分 body 当作正常响应。
    stream.on('error', () => { if (settled) return; finish({ ok: false, error: 'STREAM_ERROR' }); });
    stream.on('aborted', () => { if (settled) return; finish({ ok: false, error: 'ABORTED' }); });

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 释放响应体连接：重定向等丢弃 body 时优先 destroy/cancel，禁止无限后台 drain。 */
function drainStream(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    stream.destroy();
    resolve();
  });
}

/** 归一化 Node 响应头为小写字符串映射。 */
function normalizeHeaders(raw: NodeJS.Dict<string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** 传输层禁止用户覆盖的 Host 与 hop-by-hop 请求头（不区分大小写）。 */
export const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host', 'connection', 'proxy-connection', 'transfer-encoding',
  'content-length', 'upgrade', 'trailer', 'te',
]);

/** 发送前再次删除用户提供的 Host / hop-by-hop 头，服务端自行设置唯一 Host=url.host。 */
function sanitizeRequestHeaders(url: URL, headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (FORBIDDEN_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  out['Host'] = url.host;
  return out;
}

/** 默认传输层：socket 通过 pinned lookup 连接「已校验公开 IP」，Host/SNI/证书校验保持原 hostname。 */
export const defaultTransport: PinnedHttpTransport = (req) => new Promise((resolve, reject) => {
  const { url, method, headers, body, addresses, timeoutMs, signal } = req;
  const isHttps = url.protocol === 'https:';
  const lib = (isHttps ? https : http) as typeof https;
  const hostname = url.hostname;
  const port = url.port !== '' ? Number(url.port) : (isHttps ? 443 : 80);

  let settled = false;

  const reqHandle = lib.request({
    hostname,
    port,
    path: `${url.pathname}${url.search}`,
    method,
    // Host 由服务端唯一设置（删除用户覆盖）；SNI 与证书校验用原 hostname（不因 pinned IP 而改变）。
    headers: sanitizeRequestHeaders(url, headers),
    lookup: pinnedLookupFactory(addresses),
    servername: hostname,
    rejectUnauthorized: true,
  } as https.RequestOptions, (res) => {
    if (settled) { res.destroy(); return; }
    settled = true;
    clearTimeout(timer);
    resolve({
      status: res.statusCode ?? 0,
      statusText: res.statusMessage ?? '',
      headers: normalizeHeaders(res.headers),
      readText: (maxBytes, bodySignal) => readStreamLimited(res, maxBytes, bodySignal ?? signal),
      drain: () => drainStream(res),
    });
  });

  const timer = setTimeout(() => {
    const err: NodeJS.ErrnoException = new Error('HTTP_TIMEOUT');
    err.code = 'ETIMEDOUT';
    reqHandle.destroy(err);
  }, timeoutMs);

  const onAbort = (): void => {
    const err: NodeJS.ErrnoException = new Error('ABORTED');
    err.code = 'ABORT_ERR';
    reqHandle.destroy(err);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  reqHandle.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(err);
  });

  if (body !== undefined && body !== '') reqHandle.write(body);
  reqHandle.end();
});

function parseBody(text: string): { json: unknown; raw: string } {
  let json: unknown = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = text ? { raw: text } : {};
  }
  return { json, raw: text };
}

function actualForAssertion(a: NormalizedAssertion, ctx: { status: number; headers: Record<string, string>; json: unknown; raw: string }): unknown {
  switch (a.type) {
    case 'STATUS_CODE':
      return ctx.status;
    case 'RESPONSE_HEADER': {
      if (!a.header) return undefined;
      const key = a.header.toLowerCase();
      return ctx.headers[key] ?? Object.keys(ctx.headers).find((h) => h.toLowerCase() === key);
    }
    case 'JSON_VALUE':
    case 'JSON_PATH':
    case 'CONTAINS':
    case 'TYPE': {
      if (!a.path) return ctx.json;
      return extractPath(ctx.json, a.path);
    }
    default:
      return undefined;
  }
}

function evaluateAssertion(a: NormalizedAssertion, ctx: { status: number; headers: Record<string, string>; json: unknown; raw: string }): AssertionExecutionResult {
  const actual = actualForAssertion(a, ctx);
  const operator = a.operator;
  const result = applyOperator(operator, actual, a.expected, {
    target: 'response',
    path: a.path,
    operator: operator as never,
    expected: a.expected,
  });
  return {
    id: a.id,
    type: a.type,
    path: a.path,
    header: a.header,
    operator,
    expected: a.expected,
    actual,
    pass: result.pass,
    detail: result.detail,
  };
}

interface ExecutableCaseOutcome {
  status: CaseExecutionStatus;
  reason?: string;
  assertions: AssertionExecutionResult[];
  http?: HttpExecutionEvidence;
}

interface ExecContext {
  httpTimeoutMs: number;
  maxRedirects: number;
  blockedHosts: ReadonlySet<string>;
  allowedTargetOrigins: ReadonlySet<string>;
  maxResponseBytes: number;
  resolveHost: ResolveHostFn;
  transport: PinnedHttpTransport;
  planId?: string;
  planHash?: string;
  budgetDeadlineMs?: number;
  now: () => number;
}

/** 执行单条 HTTP_REQUEST 用例（origin 允许列表 + 重定向同源 + DNS SSRF + 已校验 IP 绑定 + 流式响应限制 + 预算中止）。 */
async function executeExecutableCase(
  testCase: NormalizedCase,
  targetUrl: string,
  ctx: ExecContext,
): Promise<ExecutableCaseOutcome> {
  const step = testCase.steps[0];
  if (!step || step.type !== 'HTTP_REQUEST' || !step.method) {
    return { status: 'BLOCKED', reason: '无可执行的 HTTP_REQUEST 步骤', assertions: [], http: undefined };
  }
  const method = step.method;
  const resolved = resolveStepUrl(targetUrl, step.url ?? '', ctx.blockedHosts);
  if ('error' in resolved) {
    return { status: 'BLOCKED', assertions: [], http: undefined, reason: resolved.error };
  }

  let currentUrl = resolved.url;
  let currentAddresses: string[] = [];
  const rootOrigin = originOfUrl(currentUrl);

  const controller = new AbortController();
  let abortedByBudget = false;
  const remainingMs = ctx.budgetDeadlineMs !== undefined ? Math.max(1, ctx.budgetDeadlineMs - ctx.now()) : undefined;
  const httpTimeout = remainingMs !== undefined ? Math.min(ctx.httpTimeoutMs, remainingMs) : ctx.httpTimeoutMs;
  const timeout = setTimeout(() => {
    abortedByBudget = ctx.budgetDeadlineMs !== undefined && ctx.now() >= ctx.budgetDeadlineMs;
    controller.abort();
  }, httpTimeout);
  const t0 = ctx.now();

  const blockedResult = (reason: string, url: URL, ssrfBlocked: boolean): ExecutableCaseOutcome => ({
    status: 'BLOCKED',
    reason,
    assertions: [],
    http: { method: method, url: url.href, status: 0, statusText: 'BLOCKED', durationMs: ctx.now() - t0, ssrfBlocked },
  });

  const dnsAbortedResult = (): ExecutableCaseOutcome => {
    if (ctx.budgetDeadlineMs !== undefined && ctx.now() >= ctx.budgetDeadlineMs) {
      return {
        status: 'BLOCKED_BY_BUDGET',
        reason: 'budget_duration 已耗尽，DNS 解析已中止',
        assertions: [],
        http: { method: method, url: currentUrl.href, status: 0, statusText: 'BUDGET_ABORTED', durationMs: ctx.now() - t0, ssrfBlocked: false },
      };
    }
    return {
      status: 'ERROR',
      reason: `DNS 解析超时（${httpTimeout}ms）`,
      assertions: [],
      http: { method: method, url: currentUrl.href, status: 0, statusText: 'TIMEOUT', durationMs: ctx.now() - t0, ssrfBlocked: false },
    };
  };

  try {
    // 初始地址安全检查：origin 允许列表 → 字面/DNS SSRF → 得到已校验公开 IP。
    const initialAllowErr = await assertOriginAllowed(currentUrl, ctx.allowedTargetOrigins, rootOrigin);
    if (initialAllowErr) return blockedResult(initialAllowErr, currentUrl, true);
    const initialDns = await resolveSafeAddresses(currentUrl, ctx.blockedHosts, ctx.resolveHost, { signal: controller.signal, deadlineMs: ctx.budgetDeadlineMs, now: ctx.now });
    if ('aborted' in initialDns) return dnsAbortedResult();
    if ('error' in initialDns) return blockedResult(initialDns.error, currentUrl, true);
    currentAddresses = initialDns.addresses;

    for (let hop = 0; hop <= ctx.maxRedirects; hop++) {
      const requestUrl = buildRequestUrl(currentUrl, step.pathParams, step.query);
      const headers: Record<string, string> = { ...step.headers };
      let body: string | undefined;
      if (step.body !== undefined && step.body !== null && method !== 'GET' && method !== 'HEAD') {
        body = JSON.stringify(step.body);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['content-type'] = 'application/json';
        }
      }

      let resp: PinnedHttpResponse;
      try {
        resp = await ctx.transport({
          url: requestUrl,
          method,
          headers,
          body,
          addresses: currentAddresses,
          timeoutMs: httpTimeout,
          signal: controller.signal,
        });
      } catch (cause) {
        if (controller.signal.aborted && abortedByBudget) {
          return {
            status: 'BLOCKED_BY_BUDGET',
            reason: 'budget_duration 已耗尽，进行中的请求已中止',
            assertions: [],
            http: { method: method, url: requestUrl.href, status: 0, statusText: 'BUDGET_ABORTED', durationMs: ctx.now() - t0, ssrfBlocked: false },
          };
        }
        const aborted = controller.signal.aborted;
        return {
          status: 'ERROR',
          assertions: [],
          http: { method: method, url: requestUrl.href, status: 0, statusText: aborted ? 'TIMEOUT' : 'NETWORK_ERROR', durationMs: ctx.now() - t0, ssrfBlocked: false },
          reason: aborted ? `请求超时（${httpTimeout}ms）` : `请求失败：${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }

      const status = resp.status;
      if (status >= 300 && status < 400) {
        const location = resp.headers['location'];
        // 重定向响应体必须排空/取消后再解析下一跳。
        await resp.drain();
        if (!location) break;
        let next: URL;
        try {
          next = new URL(location, requestUrl);
        } catch {
          return { status: 'BLOCKED', reason: `非法重定向地址：${location}`, assertions: [], http: { method: method, url: requestUrl.href, status, statusText: resp.statusText, durationMs: ctx.now() - t0, ssrfBlocked: false } };
        }
        // 每一跳都必须同源且位于允许列表，且重新解析并绑定已校验公开 IP。
        const redirectAllowErr = await assertOriginAllowed(next, ctx.allowedTargetOrigins, rootOrigin);
        if (redirectAllowErr) return blockedResult(redirectAllowErr, next, true);
        const redirectDns = await resolveSafeAddresses(next, ctx.blockedHosts, ctx.resolveHost, { signal: controller.signal, deadlineMs: ctx.budgetDeadlineMs, now: ctx.now });
        if ('aborted' in redirectDns) return dnsAbortedResult();
        if ('error' in redirectDns) return blockedResult(redirectDns.error, next, true);
        currentUrl = next;
        currentAddresses = redirectDns.addresses;
        continue;
      }

      const bodyResult = await resp.readText(ctx.maxResponseBytes, controller.signal);
      if (!bodyResult.ok) {
        controller.abort();
        if (bodyResult.error === 'RESPONSE_TOO_LARGE') {
          return {
            status: 'RESPONSE_TOO_LARGE',
            reason: `响应体超过上限 ${ctx.maxResponseBytes} 字节，已中止`,
            assertions: [],
            http: { method: method, url: requestUrl.href, status, statusText: 'RESPONSE_TOO_LARGE', durationMs: ctx.now() - t0, ssrfBlocked: false },
          };
        }
        const budget = abortedByBudget;
        const statusText = budget ? 'BUDGET_ABORTED' : (bodyResult.error === 'STREAM_ERROR' ? 'STREAM_ERROR' : 'TIMEOUT');
        const reason = budget
          ? 'budget_duration 已耗尽，响应体读取已中止'
          : bodyResult.error === 'STREAM_ERROR'
            ? '响应体流错误（STREAM_ERROR）'
            : `响应体读取中止（${bodyResult.error}）`;
        return {
          status: budget ? 'BLOCKED_BY_BUDGET' : 'ERROR',
          reason,
          assertions: [],
          http: { method: method, url: requestUrl.href, status, statusText, durationMs: ctx.now() - t0, ssrfBlocked: false },
        };
      }

      const { json, raw } = parseBody(bodyResult.text);
      const ctxAssert = { status, headers: resp.headers, json, raw };
      const assertionResults = testCase.assertions.map((a) => evaluateAssertion(a, ctxAssert));
      const pass = assertionResults.every((a) => a.pass);
      return {
        status: pass ? 'PASSED' : 'FAILED',
        assertions: assertionResults,
        http: { method: method, url: requestUrl.href, status, statusText: resp.statusText, durationMs: ctx.now() - t0, ssrfBlocked: false },
      };
    }

    return {
      status: 'BLOCKED',
      reason: `重定向次数超过上限 ${ctx.maxRedirects}`,
      assertions: [],
      http: { method: method, url: currentUrl.href, status: 0, statusText: 'TOO_MANY_REDIRECTS', durationMs: ctx.now() - t0, ssrfBlocked: false },
    };
  } catch (cause) {
    if (controller.signal.aborted && abortedByBudget) {
      return {
        status: 'BLOCKED_BY_BUDGET',
        reason: 'budget_duration 已耗尽，进行中的请求已中止',
        assertions: [],
        http: { method: method, url: currentUrl.href, status: 0, statusText: 'BUDGET_ABORTED', durationMs: ctx.now() - t0, ssrfBlocked: false },
      };
    }
    const aborted = controller.signal.aborted;
    return {
      status: 'ERROR',
      assertions: [],
      http: { method: method, url: currentUrl.href, status: 0, statusText: aborted ? 'TIMEOUT' : 'NETWORK_ERROR', durationMs: ctx.now() - t0, ssrfBlocked: false },
      reason: aborted ? `请求超时（${httpTimeout}ms）` : `请求失败：${cause instanceof Error ? cause.message : String(cause)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** 阶段一唯一执行入口：纯确定性，无任何模型调用。 */
export async function executePlan(normalized: NormalizedPlan, options: ExecutePlanOptions = {}): Promise<PlanExecutionResult> {
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const blockedHosts = options.blockedHosts ?? new Set<string>();
  const allowedTargetOrigins = options.allowedTargetOrigins ?? new Set<string>();
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const transport = options.transport ?? defaultTransport;
  const now = options.now ?? (() => Date.now());
  const startMs = now();
  const budgetDeadlineMs = options.budgetDurationMs !== undefined ? startMs + options.budgetDurationMs : undefined;

  const startedAt = new Date(startMs).toISOString();
  const caseResults: PlanCaseExecutionResult[] = [];
  let executedCount = 0;

  for (const testCase of normalized.testCases) {
    const classification = classifyPlanCase(testCase).classification;
    if (classification === 'DESIGNED_ONLY') {
      caseResults.push({
        caseId: testCase.id,
        name: testCase.name,
        classification,
        status: 'DESIGNED_ONLY',
        reason: '已设计，当前执行器不支持，未执行',
        assertions: [],
      });
      continue;
    }

    if (options.budgetCases !== undefined && executedCount >= options.budgetCases) {
      caseResults.push({
        caseId: testCase.id,
        name: testCase.name,
        classification,
        status: 'BLOCKED_BY_BUDGET',
        reason: `budget_cases 已达上限（${options.budgetCases}）`,
        assertions: [],
      });
      continue;
    }
    if (budgetDeadlineMs !== undefined && now() >= budgetDeadlineMs) {
      caseResults.push({
        caseId: testCase.id,
        name: testCase.name,
        classification,
        status: 'BLOCKED_BY_BUDGET',
        reason: 'budget_duration 已耗尽',
        assertions: [],
      });
      continue;
    }

    executedCount += 1;
    let partial: ExecutableCaseOutcome;
    try {
      partial = await executeExecutableCase(testCase, normalized.targetUrl, {
        httpTimeoutMs, maxRedirects, blockedHosts, allowedTargetOrigins, maxResponseBytes,
        resolveHost, transport, now, budgetDeadlineMs,
        planId: options.planId, planHash: options.planHash,
      });
    } catch (cause) {
      partial = {
        status: 'ERROR',
        assertions: [],
        http: undefined,
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }

    caseResults.push({
      caseId: testCase.id,
      name: testCase.name,
      classification,
      status: partial.status,
      reason: partial.reason,
      assertions: partial.assertions,
      http: partial.http,
    });
  }

  const summary = summarize(caseResults);
  const endedAt = new Date(now()).toISOString();

  return {
    schema: 'panqu-test-agent/plan-execution-result@1',
    planId: options.planId,
    planHash: options.planHash,
    targetUrl: normalized.targetUrl,
    environment: normalized.environment,
    startedAt,
    endedAt,
    summary,
    caseResults,
  };
}

/** 统计：DESIGNED_ONLY 不进入通过率分母；预算阻断与网络错误分开统计。 */
export function summarize(caseResults: PlanCaseExecutionResult[]): PlanExecutionSummary {
  const designedTotal = caseResults.length;
  const executable = caseResults.filter((c) => c.classification === 'EXECUTABLE');
  const executableTotal = executable.length;
  const designedOnly = caseResults.filter((c) => c.classification === 'DESIGNED_ONLY').length;
  const passed = executable.filter((c) => c.status === 'PASSED').length;
  const failed = executable.filter((c) => c.status === 'FAILED').length;
  const networkErrors = executable.filter((c) => c.status === 'ERROR').length;
  const responseTooLarge = executable.filter((c) => c.status === 'RESPONSE_TOO_LARGE').length;
  const blocked = executable.filter((c) => c.status === 'BLOCKED').length;
  const blockedByBudget = executable.filter((c) => c.status === 'BLOCKED_BY_BUDGET').length;
  const executedTotal = executable.filter((c) => ['PASSED', 'FAILED', 'ERROR', 'RESPONSE_TOO_LARGE'].includes(c.status)).length;
  const passRate = executedTotal === 0 ? null : Number(((passed / executedTotal) * 100).toFixed(2));
  return { designedTotal, executableTotal, executedTotal, passed, failed, networkErrors, responseTooLarge, blocked, blockedByBudget, designedOnly, passRate };
}

export { classifyPlanCase };
export type { PlanCaseClass };