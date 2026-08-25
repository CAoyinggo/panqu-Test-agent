import type { CheckResult } from './types.js';
import { abortReasonOf, isExecutionAbortError } from './abort.js';
import { effectiveAssertions } from './execution-evidence.js';

/**
 * 核心执行状态：只有 PASS 代表 Processor 已执行且至少一个有效断言全部通过。
 * TIMEOUT / CANCELLED：执行被中止（时间预算耗尽 / 外部取消）——底层任务已真实停止，
 * 永远不得视为通过，也区别于 BLOCKED（执行器自身问题）。
 */
export type CoreExecutionStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED' | 'TIMEOUT' | 'CANCELLED';

export interface ExecutionStateInput {
  hasProcessor: boolean;
  processorInvoked: boolean;
  error?: Error | null;
  checks: CheckResult[];
}

export interface CoreExecutionState {
  executed: boolean;
  status: CoreExecutionStatus;
  passRate: number;
  reason?: string;
}

/**
 * Fail-closed 执行判定：
 * - 执行被中止（超时/取消）=> TIMEOUT / CANCELLED（fail-closed，绝不 PASS）
 * - 无 Processor / Processor 未调用 => NOT_EXECUTED
 * - 执行异常 / 无有效断言 => BLOCKED
 * - 有断言但失败 => FAIL
 * - 仅真实执行且断言全部通过 => PASS
 */
export function evaluateCoreExecution(input: ExecutionStateInput): CoreExecutionState {
  if (isExecutionAbortError(input.error)) {
    return {
      executed: false,
      status: input.error.reason,
      passRate: 0,
      reason: input.error.message,
    };
  }
  if (!input.hasProcessor || !input.processorInvoked) {
    return {
      executed: false,
      status: 'NOT_EXECUTED',
      passRate: 0,
      reason: !input.hasProcessor ? '未找到支持该 canonical scene 的 Processor' : 'Processor 未完成实际调用',
    };
  }
  if (input.error) {
    return { executed: false, status: 'BLOCKED', passRate: 0, reason: input.error.message };
  }
  const assertions = effectiveAssertions(input.checks);
  if (assertions.length === 0) {
    return { executed: true, status: 'BLOCKED', passRate: 0, reason: '没有有效断言，禁止默认 PASS' };
  }
  const passed = assertions.filter((check) => check.pass).length;
  const passRate = Math.round((passed / assertions.length) * 100);
  return passed === assertions.length
    ? { executed: true, status: 'PASS', passRate }
    : { executed: true, status: 'FAIL', passRate, reason: `${assertions.length - passed} 条业务断言失败` };
}

/** 是否为「已中止」终态（TIMEOUT / CANCELLED）：不得计为通过，也不得再产生业务写入 */
export function isAbortedStatus(status: CoreExecutionStatus): boolean {
  return status === 'TIMEOUT' || status === 'CANCELLED';
}

/** 从任意错误提取中止终态（非中止错误返回 null），供引擎/工具层归一状态 */
export function abortedStatusFromError(e: unknown): 'TIMEOUT' | 'CANCELLED' | null {
  return abortReasonOf(e);
}
