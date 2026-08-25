import { operationId, normalizeHttpMethod, normalizeOperationPath } from '../operation-id.js';
import type { DiscoveredOperation } from '../types.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RuntimeProbeInput {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  /** Mutation probe is allowed only when its invalid/reject semantics are explicit. */
  invalidProbe?: { body?: unknown; expectedRejectStatuses: number[]; sideEffectFree: true };
}

export interface RuntimeDiscoveryOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function schemaOf(value: unknown): unknown {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? schemaOf(value[0]) : {} };
  if (typeof value === 'object') return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, schemaOf(child)])),
  };
  return { type: typeof value };
}

async function responseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 304) return null;
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function headersOf(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => { result[name.toLowerCase()] = value; });
  return result;
}

export async function probeRuntime(input: RuntimeProbeInput, options: RuntimeDiscoveryOptions): Promise<DiscoveredOperation> {
  const method = normalizeHttpMethod(input.method);
  const path = normalizeOperationPath(input.path);
  if (!SAFE_METHODS.has(method) && !input.invalidProbe?.sideEffectFree) {
    throw new Error(`UNSAFE_RUNTIME_PROBE：${method} ${path} 不是只读请求，也没有显式 sideEffectFree invalidProbe`);
  }
  if (!SAFE_METHODS.has(method) && input.invalidProbe!.expectedRejectStatuses.length === 0) {
    throw new Error('UNSAFE_RUNTIME_PROBE：Mutation invalidProbe 必须声明 expectedRejectStatuses');
  }
  const url = new URL(path, options.baseUrl);
  for (const [name, value] of Object.entries(input.query ?? {})) url.searchParams.set(name, value);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = options.timeoutMs ? setTimeout(() => controller.abort(new Error('RUNTIME_PROBE_TIMEOUT')), options.timeoutMs) : undefined;
  const startedAt = Date.now();
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method, headers: input.headers,
      body: input.invalidProbe?.body === undefined ? undefined : JSON.stringify(input.invalidProbe.body),
      signal: controller.signal,
    });
    const body = await responseBody(response);
    const expectedReject = input.invalidProbe?.expectedRejectStatuses.includes(response.status) ?? false;
    return {
      id: operationId(method, path), method, path,
      source: [{ type: 'RUNTIME', ref: `${method} ${url.origin}${url.pathname}`, confidence: 0.98, observedAt: new Date().toISOString() }],
      confidence: 0.98,
      responseSchema: schemaOf(body),
      sideEffects: input.invalidProbe ? ['VALIDATION_REJECT_PROBE'] : [],
      safeProbe: SAFE_METHODS.has(method) || expectedReject,
      observed: {
        status: response.status, headers: headersOf(response.headers),
        responseSchema: response.ok ? schemaOf(body) : undefined,
        errorSchema: response.ok ? undefined : schemaOf(body),
        traceId: response.headers.get('x-request-id') ?? response.headers.get('traceparent') ?? undefined,
        timingMs: Date.now() - startedAt,
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function observeRuntime(
  inputs: readonly RuntimeProbeInput[],
  options: RuntimeDiscoveryOptions,
): Promise<{ operations: DiscoveredOperation[]; errors: string[] }> {
  const operations: DiscoveredOperation[] = [];
  const errors: string[] = [];
  for (const input of inputs) {
    try { operations.push(await probeRuntime(input, options)); }
    catch (error) { errors.push(`${input.method} ${input.path}：${(error as Error).message}`); }
  }
  return { operations, errors };
}
