// 重试与超时工具：单次请求超时保护 + 可配置重试 + 指数退避
import { logger } from './logger.js';

export interface RetryOptions {
  /** 重试次数（默认 3） */
  retries?: number;
  /** 退避基数毫秒（默认 1000，指数退避：base * 2^attempt） */
  backoff?: number;
  /** 单次请求超时毫秒（默认 15000） */
  timeout?: number;
  /** 是否可重试（默认 true）。POST 等非幂等请求应设 false */
  retryable?: boolean;
  /** 重试回调（用于记录重试次数等） */
  onRetry?: (err: Error, attempt: number) => void;
}

/** 带超时执行：超时则 reject，不取消原 Promise（适用 GET 等幂等场景） */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`请求超时（${ms}ms）`)), ms);
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 带重试与超时的执行。
 * - retryable=true：重试 retries 次，每次指数退避
 * - retryable=false：仅超时保护，不重试（适用于 POST 等非幂等请求）
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, backoff = 1000, timeout = 15000, retryable = true, onRetry } = opts;

  if (!retryable) {
    return withTimeout(fn, timeout);
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(fn, timeout);
    } catch (e: any) {
      lastError = e;
      if (attempt < retries) {
        const delay = backoff * Math.pow(2, attempt);
        logger.debug(`  重试 ${attempt + 1}/${retries}（${delay}ms 后重试）：${e.message}`);
        onRetry?.(e, attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}
