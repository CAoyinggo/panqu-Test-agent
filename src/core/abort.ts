// 可中止执行（Abortable Execution）：超时/取消的统一语义与信号工具。
// 目标：超时或取消不再只是「调用方不再等待」，而是把 AbortSignal 一路传递到底层
// （Engine → Pipeline → Http → fetch），让底层任务真正停止，杜绝超时后继续扣费/写数据。
//
// 语义：
//   TIMEOUT   —— 时间预算耗尽（用例级 --case-timeout / 全局 --timeout / Tool 超时 / 单请求超时）
//   CANCELLED —— 外部主动取消（上游调用方 abort、全局超时联动、编排层取消）
import { logger } from '../utils/logger.js';
import { CodedError, ErrorCode } from './errors.js';

/** 中止原因 */
export type AbortReason = 'TIMEOUT' | 'CANCELLED';

/** 统一中止错误：携带原因，供各层把最终状态落为 TIMEOUT / CANCELLED */
export class ExecutionAbortError extends CodedError {
  constructor(
    public readonly reason: AbortReason,
    message: string,
  ) {
    super(reason === 'TIMEOUT' ? ErrorCode.EXECUTION_TIMEOUT : ErrorCode.EXECUTION_CANCELLED, message);
    this.name = 'ExecutionAbortError';
  }
}

/** 是否为统一中止错误 */
export function isExecutionAbortError(e: unknown): e is ExecutionAbortError {
  return e instanceof ExecutionAbortError;
}

/** 从任意异常/中止信号提取中止原因；非中止返回 null */
export function abortReasonOf(e: unknown): AbortReason | null {
  if (isExecutionAbortError(e)) return e.reason;
  if (typeof e === 'object' && e !== null && 'name' in e && (e as { name?: unknown }).name === 'AbortError') {
    // fetch 原生 AbortError（信号未携带 reason 时）：视为取消
    return 'CANCELLED';
  }
  return null;
}

/** 中止信号已触发则抛出统一中止错误（在流水线各步骤间设置检查点） */
export function throwIfAborted(signal: AbortSignal | undefined | null, label = '执行'): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (isExecutionAbortError(reason)) throw reason;
  throw new ExecutionAbortError('CANCELLED', `${label}已被取消`);
}

/**
 * 级联中止：parent 触发时以同样的原因中止 child（reason 保持 ExecutionAbortError 语义）。
 * 返回解除级联的函数（teardown 后清理监听，防泄漏）。
 */
export function linkAbortSignal(child: AbortController, parent: AbortSignal | undefined | null): () => void {
  if (!parent) return () => undefined;
  const onParentAbort = () => {
    if (child.signal.aborted) return;
    const reason = parent.reason;
    child.abort(isExecutionAbortError(reason) ? reason : new ExecutionAbortError('CANCELLED', '上游已取消'));
  };
  if (parent.aborted) {
    onParentAbort();
    return () => undefined;
  }
  parent.addEventListener('abort', onParentAbort, { once: true });
  return () => parent.removeEventListener('abort', onParentAbort);
}

/** 以超时原因中止 controller（幂等；保留首次原因） */
export function abortForTimeout(controller: AbortController, message: string): void {
  if (controller.signal.aborted) return;
  controller.abort(new ExecutionAbortError('TIMEOUT', message));
  logger.warn(`⏱ ${message}`);
}
