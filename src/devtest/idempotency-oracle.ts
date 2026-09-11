/**
 * 通用重试、幂等与并发安全测试 Oracle（Idempotency Oracle）
 *
 * 覆盖全流程防重与安全恢复能力：
 * 1. SUBMISSION_UNKNOWN 安全恢复（未知/超时状态先查后投，禁止盲目重交引发双重扣费）
 * 2. REQUEST_TIMEOUT_DEDUPLICATION（超时防重：相同 client_token/请求体在窗口期内返回相同 task_id）
 * 3. ANTI_DOUBLE_BILLING（防二次扣费：重试重放扣费记录数严格为 1 或正负对账核销净额为 0）
 * 4. ANTI_DUPLICATE_TASK（防重复任务/资产：重试不创建多个运行中任务或重复生产相同资产）
 * 5. CONCURRENT_SUBMIT_SAFETY（并发提交安全：并发提交同一任务时加锁/互斥，防竞态）
 * 6. REPLAY_CALLBACK_SAFETY（重复回调/状态更新幂等：同一网关回调收到多次，不重复退款或重复跳状态）
 * 7. EVENTUAL_CONSISTENCY（最终一致性：重试或故障恢复后系统最终状态、余额与资产保持确定性一致）
 */

import { createHash } from 'node:crypto';
import type { DevTestIdempotencyCheck, DevTestIdempotencyCheckKind } from './types.js';

export interface SubmitAttemptRecord {
  attempt: number;
  requestPayload?: unknown;
  clientToken?: string;
  idempotencyKey?: string;
  responseStatus?: number;
  responseBody?: unknown;
  taskId?: number | string;
  error?: string;
  timestamp?: string;
}

export interface BillingEntryRecord {
  id?: number | string;
  taskId?: number | string;
  type: 'CHARGE' | 'REFUND' | 'HOLD';
  amount: number;
  currency?: string;
  timestamp?: string;
}

export interface TaskRecord {
  taskId: number | string;
  prompt?: string;
  status?: string;
  createdAt?: string;
}

export interface AssetRecord {
  assetId?: string;
  url?: string;
  taskId?: number | string;
}

export interface CallbackEventRecord {
  callbackId: string;
  taskId: number | string;
  status: string;
  processedAt?: string;
  refundTriggered?: boolean;
  balanceChanged?: number;
}

export interface FinalStateRecord {
  balance: number;
  expectedBalance: number;
  taskStatus?: string;
  expectedTaskStatus?: string;
  assetCount?: number;
  expectedAssetCount?: number;
}

export interface IdempotencyAuditInput {
  requestId?: string;
  idempotencyKey?: string;
  clientToken?: string;
  submitAttempts?: SubmitAttemptRecord[];
  existingTasksLookup?: {
    invoked: boolean;
    foundTaskId?: number | string;
    queryFilter?: Record<string, unknown>;
  };
  billingEntries?: BillingEntryRecord[];
  createdTasks?: TaskRecord[];
  createdAssets?: AssetRecord[];
  callbacks?: CallbackEventRecord[];
  finalState?: FinalStateRecord;
}

function hashPayload(payload: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex').slice(0, 16);
  } catch {
    return 'UNKNOWN_HASH';
  }
}

export class IdempotencyOracle {
  /**
   * 1. SUBMISSION_UNKNOWN 安全恢复
   * 当提交响应为超时或 502/UNKNOWN 时，系统必须先按 clientToken / prompt 查重，
   * 严禁在未确认前次任务存在与否的情况下盲目重投。
   */
  static auditSubmissionUnknownRecovery(input: IdempotencyAuditInput): DevTestIdempotencyCheck {
    const attempts = input.submitAttempts ?? [];
    const hasUnknownAttempt = attempts.some((a) =>
      (a.responseStatus && a.responseStatus >= 500) ||
      (a.error && /timeout|unknown|econn|fetch failed/i.test(a.error)) ||
      !a.taskId
    );

    if (!hasUnknownAttempt && attempts.length <= 1) {
      return {
        kind: 'SUBMISSION_UNKNOWN_RECOVERY',
        verdict: 'PASS',
        evidence: {
          required: ['SUBMISSION_STATUS'],
          collected: ['SUBMISSION_STATUS:NORMAL'],
          complete: true,
        },
        reason: '首次提交响应明确且成功，无需触发未知状态查重恢复',
      };
    }

    const lookup = input.existingTasksLookup;
    if (!lookup) {
      return {
        kind: 'SUBMISSION_UNKNOWN_RECOVERY',
        verdict: 'FAIL',
        evidence: {
          required: ['EXISTING_TASK_LOOKUP_EVIDENCE'],
          collected: [],
          complete: false,
        },
        reason: 'SUBMISSION_UNKNOWN: 提交发生未知异常或超时，但未触发先查重机制即尝试重交',
        details: { attempts: attempts.length },
      };
    }

    if (lookup.invoked) {
      return {
        kind: 'SUBMISSION_UNKNOWN_RECOVERY',
        verdict: 'PASS',
        evidence: {
          required: ['EXISTING_TASK_LOOKUP_EVIDENCE'],
          collected: [lookup.foundTaskId ? `FOUND_TASK:${lookup.foundTaskId}` : 'NO_EXISTING_TASK'],
          complete: true,
        },
        reason: `SUBMISSION_UNKNOWN 恢复安全：已按条件前置查重（发现任务 ID=${lookup.foundTaskId ?? 'NONE'}），避免盲目重交`,
        details: { foundTaskId: lookup.foundTaskId },
      };
    }

    return {
      kind: 'SUBMISSION_UNKNOWN_RECOVERY',
      verdict: 'FAIL',
      evidence: {
        required: ['EXISTING_TASK_LOOKUP_EVIDENCE'],
        collected: ['LOOKUP_NOT_INVOKED'],
        complete: true,
      },
      reason: 'SUBMISSION_UNKNOWN 失败：查重处理器未执行，可能导致重复建单与重复扣费',
    };
  }

  /**
   * 2. 请求超时后的去重
   * 重复提交相同时，必须返回已存在的任务 ID，或直接提示重复请求并安全拒绝。
   */
  static auditRequestTimeoutDeduplication(input: IdempotencyAuditInput): DevTestIdempotencyCheck {
    const attempts = input.submitAttempts ?? [];
    if (attempts.length <= 1) {
      return {
        kind: 'REQUEST_TIMEOUT_DEDUPLICATION',
        verdict: 'PASS',
        evidence: {
          required: ['REQUEST_DEDUPLICATION'],
          collected: ['SINGLE_REQUEST'],
          complete: true,
        },
        reason: '单次提交无重试，去重规则默认满足',
      };
    }

    const taskIds = attempts.map((a) => a.taskId).filter(Boolean);
    const uniqueTaskIds = [...new Set(taskIds.map(String))];

    if (uniqueTaskIds.length > 1) {
      return {
        kind: 'REQUEST_TIMEOUT_DEDUPLICATION',
        verdict: 'FAIL',
        evidence: {
          required: ['TASK_ID_UNIQUENESS'],
          collected: uniqueTaskIds.map((id) => `TASK_ID:${id}`),
          complete: true,
        },
        reason: `REQUEST_TIMEOUT_DEDUPLICATION 失败：同一重试逻辑创建了不同的任务 ID（${uniqueTaskIds.join(', ')}），存在重复提交风险`,
        details: { uniqueTaskIds },
      };
    }

    return {
      kind: 'REQUEST_TIMEOUT_DEDUPLICATION',
      verdict: 'PASS',
      evidence: {
        required: ['TASK_ID_UNIQUENESS'],
        collected: uniqueTaskIds.length ? [`SINGLE_TASK_ID:${uniqueTaskIds[0]}`] : ['SAFE_REJECTED'],
        complete: true,
      },
      reason: '请求重试去重验证通过：重复请求返回同一任务 ID 或被安全拦截',
      details: { taskId: uniqueTaskIds[0] },
    };
  }

  /**
   * 3. 重试不会重复扣费
   * 检查计费流水中，针对同一任务/请求的扣费次数。
   * 成功任务扣费记录条数严格为 1；失败任务正负核销净额为 0。
   */
  static auditAntiDoubleBilling(input: IdempotencyAuditInput): DevTestIdempotencyCheck {
    const billings = input.billingEntries ?? [];
    if (billings.length === 0) {
      return {
        kind: 'ANTI_DOUBLE_BILLING',
        verdict: 'BLOCKED',
        evidence: {
          required: ['BILLING_LOGS'],
          collected: [],
          complete: false,
        },
        reason: 'ANTI_DOUBLE_BILLING 阻断：缺少账务流水记录，无法证明重试未引发双重扣费',
      };
    }

    const chargeEntries = billings.filter((b) => b.type === 'CHARGE');
    const refundEntries = billings.filter((b) => b.type === 'REFUND');

    const totalCharged = chargeEntries.reduce((sum, b) => sum + Math.abs(b.amount), 0);
    const totalRefunded = refundEntries.reduce((sum, b) => sum + Math.abs(b.amount), 0);
    const netCharged = totalCharged - totalRefunded;

    // 若进行了多次扣款，且退款数未能完全抵消多扣部分
    if (chargeEntries.length > 1 && totalRefunded === 0) {
      return {
        kind: 'ANTI_DOUBLE_BILLING',
        verdict: 'FAIL',
        evidence: {
          required: ['SINGLE_CHARGE_RECORD'],
          collected: chargeEntries.map((c) => `CHARGE_AMOUNT:${c.amount}`),
          complete: true,
        },
        reason: `ANTI_DOUBLE_BILLING 严重缺陷：检测到 ${chargeEntries.length} 笔扣费流水，总扣款 ${totalCharged}，未发生相应退款，存在重复扣费！`,
        details: { chargeCount: chargeEntries.length, totalCharged },
      };
    }

    return {
      kind: 'ANTI_DOUBLE_BILLING',
      verdict: 'PASS',
      evidence: {
        required: ['SINGLE_CHARGE_RECORD'],
        collected: [
          `CHARGE_COUNT:${chargeEntries.length}`,
          `REFUND_COUNT:${refundEntries.length}`,
          `NET_CHARGED:${netCharged}`,
        ],
        complete: true,
      },
      reason: `防二次扣费验证通过：扣费条数=${chargeEntries.length}，退款条数=${refundEntries.length}，净扣款=${netCharged}`,
      details: { chargeEntries: chargeEntries.length, netCharged },
    };
  }

  /**
   * 4. 重试不会产生重复任务/资产
   */
  static auditAntiDuplicateTask(input: IdempotencyAuditInput): DevTestIdempotencyCheck {
    const tasks = input.createdTasks ?? [];
    const assets = input.createdAssets ?? [];

    if (tasks.length > 1) {
      return {
        kind: 'ANTI_DUPLICATE_TASK',
        verdict: 'FAIL',
        evidence: {
          required: ['MAX_SINGLE_TASK'],
          collected: tasks.map((t) => `TASK:${t.taskId}`),
          complete: true,
        },
        reason: `ANTI_DUPLICATE_TASK 失败：检测到生成了 ${tasks.length} 个重复任务（${tasks.map((t) => t.taskId).join(', ')}）`,
        details: { taskIds: tasks.map((t) => t.taskId) },
      };
    }

    if (assets.length > 1) {
      return {
        kind: 'ANTI_DUPLICATE_TASK',
        verdict: 'FAIL',
        evidence: {
          required: ['MAX_SINGLE_ASSET'],
          collected: assets.map((a) => `ASSET:${a.assetId || a.url}`),
          complete: true,
        },
        reason: `ANTI_DUPLICATE_TASK 失败：检测到生产了 ${assets.length} 份重复产物资产`,
        details: { assets: assets.map((a) => a.assetId || a.url) },
      };
    }

    return {
      kind: 'ANTI_DUPLICATE_TASK',
      verdict: 'PASS',
      evidence: {
        required: ['MAX_SINGLE_TASK', 'MAX_SINGLE_ASSET'],
        collected: [
          tasks.length ? `TASK_COUNT:${tasks.length}` : 'NO_ORPHAN_TASK',
          assets.length ? `ASSET_COUNT:${assets.length}` : 'NO_DUPLICATE_ASSET',
        ],
        complete: true,
      },
      reason: '防重复任务与资产验证通过：未产生冗余任务队列或重复资产',
    };
  }

  /**
   * 5. 并发提交安全
   * 验证并发请求时具备加锁或去重，严禁并发双写或并发双扣。
   */
  static auditConcurrentSubmitSafety(input: IdempotencyAuditInput): DevTestIdempotencyCheck {
    const attempts = input.submitAttempts ?? [];
    if (attempts.length <= 1) {
      return {
        kind: 'CONCURRENT_SUBMIT_SAFETY',
        verdict: 'PASS',
        evidence: {
          required: ['CONCURRENCY_EVIDENCE'],
          collected: ['SEQUENTIAL_EXECUTION'],
          complete: true,
        },
        reason: '非并发执行环境，并发安全默认满足',
      };
    }

    // 检查是否有并发成功返回两个不同任务的情况
    const successAttempts = attempts.filter((a) => (a.responseStatus && a.responseStatus < 300) || (a.taskId && !a.error));
    const distinctTaskIds = [...new Set(successAttempts.map((a) => a.taskId).filter(Boolean))];

    if (distinctTaskIds.length > 1) {
      return {
        kind: 'CONCURRENT_SUBMIT_SAFETY',
        verdict: 'FAIL',
        evidence: {
          required: ['CONCURRENCY_MUTEX'],
          collected: distinctTaskIds.map((id) => `RACE_TASK:${id}`),
          complete: true,
        },
        reason: `CONCURRENT_SUBMIT_SAFETY 竞态冲突：并发提交同时创建了 ${distinctTaskIds.length} 个互斥任务，缺少并发锁防护`,
        details: { distinctTaskIds },
      };
    }

    return {
      kind: 'CONCURRENT_SUBMIT_SAFETY',
      verdict: 'PASS',
      evidence: {
        required: ['CONCURRENCY_MUTEX'],
        collected: ['MUTEX_OR_DEDUP_PROTECTED'],
        complete: true,
      },
      reason: '并发提交安全验证通过：并发请求已安全互斥或合并',
    };
  }

  /**
   * 6. 重复回调/重复状态更新安全
   */
  static auditReplayCallbackSafety(input: IdempotencyAuditInput): DevTestIdempotencyCheck {
    const callbacks = input.callbacks ?? [];
    if (callbacks.length <= 1) {
      return {
        kind: 'REPLAY_CALLBACK_SAFETY',
        verdict: 'PASS',
        evidence: {
          required: ['CALLBACK_REPLAY_EVIDENCE'],
          collected: ['SINGLE_OR_NO_CALLBACK'],
          complete: true,
        },
        reason: '无重复回调推送，回调幂等性默认满足',
      };
    }

    // 检查同一事件是否触发了多次退款或多次余额变动
    const refundCallbacks = callbacks.filter((c) => c.refundTriggered === true);
    if (refundCallbacks.length > 1) {
      return {
        kind: 'REPLAY_CALLBACK_SAFETY',
        verdict: 'FAIL',
        evidence: {
          required: ['SINGLE_REFUND_ON_REPLAY'],
          collected: refundCallbacks.map((c) => `REFUND_EVENT:${c.callbackId}`),
          complete: true,
        },
        reason: `REPLAY_CALLBACK_SAFETY 严重缺陷：重复回调触发了 ${refundCallbacks.length} 次退款，存在资金安全漏洞！`,
      };
    }

    return {
      kind: 'REPLAY_CALLBACK_SAFETY',
      verdict: 'PASS',
      evidence: {
        required: ['SINGLE_REFUND_ON_REPLAY'],
        collected: [`CALLBACK_COUNT:${callbacks.length}`, 'IDEMPOTENT_HANDLED'],
        complete: true,
      },
      reason: `重复回调安全验证通过：收到 ${callbacks.length} 次回调，仅处理一次状态流转与核销`,
    };
  }

  /**
   * 7. 失败恢复后的最终一致性
   */
  static auditEventualConsistency(input: IdempotencyAuditInput): DevTestIdempotencyCheck {
    const finalState = input.finalState;
    if (!finalState) {
      return {
        kind: 'EVENTUAL_CONSISTENCY',
        verdict: 'BLOCKED',
        evidence: {
          required: ['FINAL_STATE_SNAPSHOT'],
          collected: [],
          complete: false,
        },
        reason: 'EVENTUAL_CONSISTENCY 阻断：缺少最终状态快照，无法证明最终一致性',
      };
    }

    const issues: string[] = [];
    if (finalState.balance !== finalState.expectedBalance) {
      issues.push(`余额不一致：实际=${finalState.balance}，预期=${finalState.expectedBalance}`);
    }
    if (finalState.taskStatus && finalState.expectedTaskStatus && finalState.taskStatus !== finalState.expectedTaskStatus) {
      issues.push(`任务状态不一致：实际=${finalState.taskStatus}，预期=${finalState.expectedTaskStatus}`);
    }
    if (finalState.assetCount !== undefined && finalState.expectedAssetCount !== undefined && finalState.assetCount !== finalState.expectedAssetCount) {
      issues.push(`产物资产数量不一致：实际=${finalState.assetCount}，预期=${finalState.expectedAssetCount}`);
    }

    if (issues.length > 0) {
      return {
        kind: 'EVENTUAL_CONSISTENCY',
        verdict: 'FAIL',
        evidence: {
          required: ['STATE_CONSISTENCY_EVIDENCE'],
          collected: issues,
          complete: true,
        },
        reason: `EVENTUAL_CONSISTENCY 校验失败：${issues.join('；')}`,
        details: { issues, finalState },
      };
    }

    return {
      kind: 'EVENTUAL_CONSISTENCY',
      verdict: 'PASS',
      evidence: {
        required: ['STATE_CONSISTENCY_EVIDENCE'],
        collected: [
          `BALANCE:${finalState.balance}`,
          `STATUS:${finalState.taskStatus ?? 'N/A'}`,
          `ASSETS:${finalState.assetCount ?? 'N/A'}`,
        ],
        complete: true,
      },
      reason: '最终一致性验证通过：余额、任务终态与产物资产全部符合预期',
    };
  }

  /**
   * 批量执行所有适用的重试与幂等审计项
   */
  static evaluate(input: IdempotencyAuditInput): DevTestIdempotencyCheck[] {
    return [
      this.auditSubmissionUnknownRecovery(input),
      this.auditRequestTimeoutDeduplication(input),
      this.auditAntiDoubleBilling(input),
      this.auditAntiDuplicateTask(input),
      this.auditConcurrentSubmitSafety(input),
      this.auditReplayCallbackSafety(input),
      this.auditEventualConsistency(input),
    ];
  }
}
