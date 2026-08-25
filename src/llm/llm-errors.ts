// LLM 错误分类：识别失败类型并判断是否可回退（Fallback）。
// 回退原则（任务书 20.1）：Primary → Timeout/429/5xx/网络错误 → Fallback → Deterministic Fallback。
// 非可重试错误（如 400/401/403 配置或鉴权问题）直接暴露，避免掩盖真实配置错误。
import type { LLMProvider } from './types.js';
import { CodedError, ErrorCode, type ErrorCode as ErrorCodeType } from '../core/errors.js';

/** LLM 失败分类 */
export type LLMFailureKind = 'timeout' | 'http' | 'network' | 'unknown';

/** 结构化的 LLM 失败信息 */
export interface LLMFailure {
  kind: LLMFailureKind;
  /** HTTP 状态码（http 类型时） */
  status?: number;
  /** 原始错误消息 */
  message: string;
  /** 服务端建议等待时长（Retry-After 头解析结果，毫秒；429/503 常见） */
  retryAfterMs?: number;
}

/**
 * 结构化 LLM 错误：携带失败分类 / HTTP 状态 / Retry-After，
 * 供重试策略精确决策（不再从 message 正则反推）。
 */
export class LLMError extends CodedError {
  constructor(
    message: string,
    public readonly failure: LLMFailure,
  ) {
    super(llmErrorCode(failure), message, { expose: false, details: failure });
    this.name = 'LLMError';
  }
}

function llmErrorCode(failure: LLMFailure): ErrorCodeType {
  if (failure.kind === 'timeout') return ErrorCode.EXECUTION_TIMEOUT;
  if (failure.kind === 'http' && failure.status === 429) return ErrorCode.LLM_RATE_LIMIT;
  return ErrorCode.LLM_FAILURE;
}

/**
 * 从任意异常提取失败信息。HTTP 状态只接受 LLMError.failure.status，
 * 禁止从自由文本解析状态码；第三方 Provider 必须在适配层转换为 LLMError。
 */
export function classifyLLMError(e: unknown): LLMFailure {
  if (e instanceof LLMError) return e.failure;
  if (e instanceof CodedError) {
    if (e.code === ErrorCode.EXECUTION_TIMEOUT) return { kind: 'timeout', message: e.message };
    if (e.code === ErrorCode.LLM_RATE_LIMIT) return { kind: 'http', status: 429, message: e.message };
  }
  if (e instanceof Error) {
    const msg = e.message;
    // AbortController 中止 / 明确超时
    if (e.name === 'AbortError' || /超时|timeout|timed ?out|aborted|abort/i.test(msg)) {
      return { kind: 'timeout', message: msg };
    }
    // 网络类（fetch 失败：ECONNREFUSED / ENOTFOUND / fetch failed / network）
    if (/fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|连接|网络/i.test(msg)) {
      return { kind: 'network', message: msg };
    }
    return { kind: 'unknown', message: msg };
  }
  return { kind: 'unknown', message: String(e) };
}

/**
 * 是否应重试/回退：超时 / 网络错误 / 408 / 429 / 5xx。
 * 4xx 参数错误（400/404/422）与鉴权失败（401/403）不重试 —— 重试只会掩盖配置问题。
 */
export function isRetryable(failure: LLMFailure): boolean {
  if (failure.kind === 'timeout' || failure.kind === 'network') return true;
  if (failure.kind === 'http') {
    const s = failure.status ?? 0;
    return s === 408 || s === 429 || (s >= 500 && s <= 599);
  }
  return false;
}

// ── Retry-After 与重试策略（指数退避 + full jitter + Retry-After 封顶） ──

/** 解析 Retry-After 头：秒数（标准）或 HTTP-date；非法返回 undefined */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) {
    const seconds = Number(v);
    // 标准为秒；异常巨大的值（> 1 天）按毫秒容错
    return seconds > 86_400 ? seconds : seconds * 1_000;
  }
  const date = Date.parse(v);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/** LLM 重试策略 */
export interface LLMRetryPolicy {
  /** 同模型最大重试次数（有限重试；不含回退模型的额外尝试） */
  maxRetries: number;
  /** 指数退避基数毫秒（delay = base * 2^attempt，封顶 maxDelayMs） */
  baseMs: number;
  /** 退避封顶毫秒 */
  maxDelayMs: number;
  /** Retry-After 封顶毫秒（服务端建议值过大时按此封顶） */
  retryAfterCapMs: number;
  /** 是否加 full jitter（[0, delay] 均匀随机；测试可关闭换确定性） */
  jitter: boolean;
}

/** 默认策略：最多 2 次重试，0.5s 起指数退避，封顶 8s，Retry-After 封顶 15s */
export const DEFAULT_LLM_RETRY_POLICY: LLMRetryPolicy = {
  maxRetries: 2,
  baseMs: 500,
  maxDelayMs: 8_000,
  retryAfterCapMs: 15_000,
  jitter: true,
};

/**
 * 计算下一次重试等待时长（毫秒）：
 * 优先 Retry-After（429/503 等限流场景，封顶 retryAfterCapMs）；
 * 否则指数退避 base * 2^attempt（封顶 maxDelayMs）+ full jitter（[0, delay] 均匀随机）。
 * 返回 null 表示不应重试（由调用方先经 isRetryable 判断）。
 */
export function llmRetryDelayMs(
  failure: LLMFailure,
  attempt: number,
  policy: Partial<LLMRetryPolicy> = {},
  random: () => number = Math.random,
): number | null {
  const p = { ...DEFAULT_LLM_RETRY_POLICY, ...policy };
  if (failure.retryAfterMs !== undefined && failure.retryAfterMs > 0) {
    return Math.min(failure.retryAfterMs, p.retryAfterCapMs);
  }
  const exp = Math.min(p.maxDelayMs, p.baseMs * Math.pow(2, Math.max(0, attempt)));
  return p.jitter ? Math.floor(random() * exp) : exp;
}

/** 从 Provider 抛错判断是否可回退（便捷方法） */
export function shouldFallback(e: unknown): boolean {
  return isRetryable(classifyLLMError(e));
}

/** 回退事件（供观测/日志/审计） */
export interface LLMFallbackEvent {
  /** 触发回退的 Provider 名（主模型） */
  from: string;
  /** 目标 Provider 名（回退模型，或 deterministic-fallback） */
  to: string;
  failure: LLMFailure;
  /** 回退序号（1=主→备，2=备→确定性） */
  attempt: number;
}

export type LLMFallbackListener = (event: LLMFallbackEvent) => void;

/** 通用 Provider 名（观测用） */
export function providerName(p: LLMProvider): string {
  return p.name;
}
