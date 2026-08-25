// 重试与超时工具：单次请求超时保护（真实中止底层请求）+ 可配置重试 + 指数退避
// 关键语义（v2）：超时不再只是 Promise.race 放弃等待，而是通过 AbortSignal 真正取消
// 底层 fetch —— 杜绝「上层以为结束了，底层 HTTP 还在跑、继续扣费/写数据」。
import { logger } from './logger.js';
import { ExecutionAbortError, abortReasonOf, isExecutionAbortError } from '../core/abort.js';

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
  /** 外部取消信号（用例超时 / 全局取消 / Tool 取消；触发即停止重试并中止当前请求） */
  signal?: AbortSignal;
}

/**
 * 带超时执行（真实中止）：把 per-attempt AbortSignal 交给 fn（fn 必须传给 fetch），
 * 超时或外部取消时 abort 该信号 —— 底层请求立即停止，而非仅放弃等待。
 * fn 不消费 signal 时行为退化为 race（但信号已发出，供上层使用）。
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  opts: { signal?: AbortSignal; label?: string } = {},
): Promise<T> {
  const controller = new AbortController();
  const label = opts.label ?? '请求';
  let timerFired = false;
  let timeoutError: ExecutionAbortError | null = null;

  // 外部取消 → 级联中止当前尝试（CANCELLED 语义，不属于超时重试范畴）
  const onExternalAbort = () => {
    if (!controller.signal.aborted) controller.abort(opts.signal!.reason);
  };
  if (opts.signal?.aborted) onExternalAbort();
  else opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const abortPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      timerFired = true;
      timeoutError = new ExecutionAbortError('TIMEOUT', `${label}超时（${ms}ms）`);
      controller.abort(timeoutError);
      reject(timeoutError);
    }, ms);
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      // 超时已由 timer 分支 reject；这里处理外部取消
      if (!timerFired) {
        const reason = opts.signal?.reason;
        reject(isExecutionAbortError(reason)
          ? reason
          : new ExecutionAbortError('CANCELLED', `${label}已被取消`));
      }
    }, { once: true });
  });

  try {
    return await Promise.race([fn(controller.signal), abortPromise]);
  } catch (e) {
    // 计时器已触发但 fn 先以原生 AbortError 拒绝（未携带 reason 的运行时）：归类为 TIMEOUT
    if (timerFired && abortReasonOf(e) === 'CANCELLED') throw timeoutError!;
    throw e;
  } finally {
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** 中止类错误是否值得重试：超时可重试（幂等场景由调用方决定），取消一律不重试 */
function isRetryableAbort(e: Error): boolean {
  return abortReasonOf(e) !== 'CANCELLED';
}

/**
 * 带重试与超时的执行。
 * - retryable=true：重试 retries 次，每次指数退避
 * - retryable=false：仅超时保护，不重试（适用于 POST 等非幂等请求）
 * - 外部取消（CANCELLED）：立即终止，不再重试
 */
export async function withRetry<T>(fn: (signal: AbortSignal) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, backoff = 1000, timeout = 15000, retryable = true, onRetry, signal } = opts;

  if (!retryable) {
    return withTimeout(fn, timeout, { signal });
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      throw isExecutionAbortError(signal.reason) ? signal.reason : new ExecutionAbortError('CANCELLED', '重试等待期间已被取消');
    }
    try {
      return await withTimeout(fn, timeout, { signal });
    } catch (e: any) {
      lastError = e;
      // 取消不重试（外部已放弃，继续请求只会产生超时后写入）
      if (abortReasonOf(e) === 'CANCELLED') throw e;
      if (attempt < retries && isRetryableAbort(e)) {
        const delay = backoff * Math.pow(2, attempt);
        logger.debug(`  重试 ${attempt + 1}/${retries}（${delay}ms 后重试）：${e.message}`);
        onRetry?.(e, attempt + 1);
        // 退避期间外部取消 → 立即中断
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delay);
          const onAbort = () => {
            clearTimeout(t);
            reject(new ExecutionAbortError('CANCELLED', '退避等待期间已被取消'));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
  }
  throw lastError!;
}
