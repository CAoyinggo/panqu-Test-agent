/**
 * Panqu AI DevTest 用户积分流水对账 (Billing Oracle)
 *
 * 积分流水级对账：防重复扣款、失败净扣归零、退款幂等三大不变量核验。
 */

export type FlowMediaType = 'video' | 'image' | 'canvas';
export type FlowStepStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'BLOCKED' | 'NOT_APPLICABLE' | 'UNVERIFIED' | 'PASS' | 'FAIL';
export type TaskTerminalStatus = 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'NOT_SUBMITTED';

export const FALLBACK_POINTS_PER_CNY = 30;
export const FALLBACK_CNY_PER_POINT = 1 / 30;

export interface ScoreLogEntry {
  id?: number | string;
  task_id?: number | string;
  client_token?: string;
  idempotency_key?: string;
  type: number | string; // 2: 扣费/预扣, 1: 充值/退款
  score: number;
  memo?: string;
  createtime?: number | string;
}

export interface BillingAuditReport {
  passed: boolean;
  status: FlowStepStatus;
  expectedPoints: number;
  expectedChargeSource?: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION';
  preDeductedPoints: number;
  settledPoints: number;
  refundedPoints: number;
  netDeductedPoints: number;
  underCharged: boolean;
  overCharged: boolean;
  duplicateCharged: boolean;
  duplicateRefunded: boolean;
  missingRefund: boolean;
  asyncSettlementPending: boolean;
  netChargeZero?: boolean;
  antiDoubleBilling?: boolean;
  refundIdempotency?: boolean;
  ledgerEntries: Array<{
    id?: string;
    type: 'PRE_DEDUCT' | 'SETTLE' | 'REFUND';
    points: number;
    time?: string;
    memo?: string;
    clientToken?: string;
  }>;
  balanceAuxiliary?: {
    balanceBefore?: number;
    balanceAfter?: number;
    balanceDelta?: number;
    note: string;
  };
  reasons: string[];
}

export class BillingOracle {
  public static calculateExpectedPoints(params: {
    mediaType: FlowMediaType;
    modelId: number;
    duration?: number;
    resolution?: string;
    hasReferenceVideo?: boolean;
    customPoints?: number;
    pointsPerSecond?: number;
  }): number {
    if (params.customPoints !== undefined && params.customPoints >= 0) {
      return Math.round(params.customPoints);
    }
    if (params.pointsPerSecond !== undefined && params.pointsPerSecond > 0) {
      const duration = Math.max(1, params.duration ?? 4);
      return Math.round(params.pointsPerSecond * duration);
    }

    if (params.mediaType === 'image') {
      if (params.modelId === 205) {
        const res = (params.resolution || '').toLowerCase().trim();
        if (res.includes('2k') || res.includes('flare') || res.includes('hd') || res.includes('4k')) return 15;
        return 10;
      }
      if (params.modelId === 12 && params.resolution) {
        const res = params.resolution.toLowerCase().trim();
        if (res.includes('4k')) return 15;
        if (res.includes('2k')) return 10;
      }
      return 5;
    }

    const duration = Math.max(1, params.duration ?? 4);
    const resolution = (params.resolution || '').toLowerCase().trim();

    if (params.modelId === 84) {
      if (resolution.includes('720')) return Math.round(14 * duration);
      if (resolution.includes('1080')) return Math.round(27 * duration);
      return Math.round(7 * duration);
    }

    if (params.modelId === 88) {
      if (resolution.includes('480')) return Math.round(11 * duration);
      if (resolution.includes('1080')) return Math.round(44 * duration);
      return Math.round(22 * duration);
    }

    if (params.modelId === 15) {
      if (resolution.includes('480')) return Math.round(15 * duration);
      return Math.round(30 * duration);
    }

    if (params.modelId === 78) {
      if (resolution.includes('480')) return Math.round(20 * duration);
      return Math.round(40 * duration);
    }

    return Math.round(7 * duration);
  }

  public static reconcileTaskLedger(params: {
    taskId: number;
    expectedPoints: number;
    terminalStatus: TaskTerminalStatus;
    scoreLogs: ScoreLogEntry[];
    balanceBefore?: number;
    balanceAfter?: number;
    allowAsyncPending?: boolean;
    expectedChargeSource?: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION';
  }): BillingAuditReport {
    const { taskId, expectedPoints, terminalStatus, scoreLogs } = params;
    const expectedChargeSource = params.expectedChargeSource ?? 'DEVTEST_EXPECTATION';
    const reasons: string[] = [];

    const taskLogs = scoreLogs.filter((log) => {
      if (log.task_id !== undefined && log.task_id !== null) return Number(log.task_id) === Number(taskId);
      if (log.memo && log.memo.includes(String(taskId))) return true;
      return false;
    });

    const hasMismatchedTaskLogs = scoreLogs.length > 0 && taskLogs.length === 0;
    if (hasMismatchedTaskLogs) {
      reasons.push(`提供了 ${scoreLogs.length} 条积分流水，但没有任何记录匹配任务 ID ${taskId}`);
    }

    let preDeduct = 0;
    let settled = 0;
    let refunded = 0;
    let preDeductCount = 0;
    let refundCount = 0;

    const structuredEntries: BillingAuditReport['ledgerEntries'] = [];

    for (const entry of taskLogs) {
      const typeNum = Number(entry.type);
      const typeStr = String(entry.type || '').toUpperCase();
      const entryObj = entry as unknown as Record<string, unknown>;
      const rawPoints = entryObj.points !== undefined ? entryObj.points : entry.score;
      const absScore = Math.abs(Number(rawPoints || 0));

      if (typeNum === 1 || typeStr === 'REFUND' || (entry.memo && (entry.memo.includes('退') || entry.memo.includes('返还')))) {
        refunded += absScore;
        refundCount++;
        structuredEntries.push({
          id: String(entry.id || structuredEntries.length + 1),
          type: 'REFUND',
          points: absScore,
          time: entry.createtime ? String(entry.createtime) : undefined,
          memo: entry.memo,
        });
      } else if (typeNum === 2 || typeStr === 'PRE_DEDUCT' || (entry.memo && (entry.memo.includes('扣除') || entry.memo.includes('扣费') || entry.memo.includes('预扣')))) {
        preDeduct += absScore;
        preDeductCount++;
        structuredEntries.push({
          id: String(entry.id || structuredEntries.length + 1),
          type: 'PRE_DEDUCT',
          points: absScore,
          time: entry.createtime ? String(entry.createtime) : undefined,
          memo: entry.memo,
        });
      } else {
        settled += absScore;
        structuredEntries.push({
          id: String(entry.id || structuredEntries.length + 1),
          type: 'SETTLE',
          points: absScore,
          time: entry.createtime ? String(entry.createtime) : undefined,
          memo: entry.memo,
        });
      }
    }

    const netDeducted = preDeduct - refunded;
    let duplicateCharged = false;
    let duplicateRefunded = false;
    let underCharged = false;
    let overCharged = false;
    let missingRefund = false;
    let asyncSettlementPending = false;

    let antiDoubleBilling: boolean | undefined = undefined;
    let refundIdempotency: boolean | undefined = undefined;
    let netChargeZero: boolean | undefined = undefined;

    const isSuccess = terminalStatus === 'SUCCESS' || (terminalStatus as string) === 'SUCCEEDED';
    const isFailed = terminalStatus === 'FAILED';

    if (taskLogs.length === 0) {
      reasons.push(`未找到匹配任务 ID ${taskId} 的有效流水记录 [UNVERIFIED]`);
    } else {
      antiDoubleBilling = preDeductCount === 1;
      if (preDeductCount > 1) {
        duplicateCharged = true;
        antiDoubleBilling = false;
        reasons.push(`[INVARIANT_VIOLATED: ANTI_DOUBLE_BILLING] 检测到重复预扣费: 任务 ID ${taskId} 存在 ${preDeductCount} 次预扣流水`);
      } else if (preDeductCount === 0) {
        antiDoubleBilling = false;
        reasons.push(`[INVARIANT_VIOLATED: ANTI_DOUBLE_BILLING] 任务缺失有效预扣流水记录`);
      }

      const clientTokens = taskLogs
        .map((l) => l.client_token || l.idempotency_key)
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '');
      if (clientTokens.length > 1 && preDeductCount > 1) {
        antiDoubleBilling = false;
        reasons.push(`[INVARIANT_VIOLATED: ANTI_DOUBLE_BILLING] 检测到并发/重试未去重: 同一 clientToken (${clientTokens[0]}) 触发了多次扣费`);
      }

      if (isSuccess) {
        refundIdempotency = refundCount === 0;
        if (refundCount > 0) {
          refundIdempotency = false;
          reasons.push(`[INVARIANT_VIOLATED: REFUND_IDEMPOTENCY] 成功任务异常触发退款: 存在 ${refundCount} 次退款记录`);
        }

        if (preDeductCount === 0) {
          netChargeZero = false;
          if (params.allowAsyncPending) {
            asyncSettlementPending = true;
            reasons.push(`成功任务预扣流水尚未落盘，标记异步入账处理中`);
          } else {
            reasons.push(`成功任务缺失预扣流水记录`);
          }
        } else if (netDeducted < expectedPoints) {
          underCharged = true;
          netChargeZero = false;
          reasons.push(`少扣费: 应扣 ${expectedPoints} 积分，实际净扣 ${netDeducted} 积分`);
        } else if (netDeducted > expectedPoints) {
          overCharged = true;
          netChargeZero = false;
          reasons.push(`多扣费: 应扣 ${expectedPoints} 积分，实际净扣 ${netDeducted} 积分 (超扣 ${netDeducted - expectedPoints})`);
        } else {
          netChargeZero = true;
        }
      } else if (isFailed) {
        if (preDeductCount > 0) {
          refundIdempotency = refundCount === 1;
          if (refundCount > 1) {
            duplicateRefunded = true;
            refundIdempotency = false;
            reasons.push(`[INVARIANT_VIOLATED: REFUND_IDEMPOTENCY] 检测到重复退款: 任务 ID ${taskId} 存在 ${refundCount} 次退款记录`);
          } else if (refundCount === 0) {
            refundIdempotency = false;
            reasons.push(`[INVARIANT_VIOLATED: REFUND_IDEMPOTENCY] 失败任务未执行退款`);
          }
        } else {
          refundIdempotency = refundCount === 0;
        }

        netChargeZero = netDeducted === 0;
        if (preDeductCount === 0 && expectedPoints > 0) {
          if (params.allowAsyncPending) {
            asyncSettlementPending = true;
            reasons.push(`失败任务预扣与退款流水尚未落盘，标记异步处理中`);
          } else {
            reasons.push(`失败任务缺失专属预扣流水记录`);
          }
        } else if (netDeducted > 0) {
          missingRefund = true;
          reasons.push(`[INVARIANT_VIOLATED: NET_CHARGE_ZERO] 任务失败漏退款: 失败仍净扣 ${netDeducted} 积分未退回`);
        } else if (netDeducted < 0) {
          reasons.push(`[INVARIANT_VIOLATED: NET_CHARGE_ZERO] 任务失败超额退款: 退款总额 (${refunded}) 超过预扣 (${preDeduct})`);
        }
      } else {
        netChargeZero = undefined;
        reasons.push(`任务终态为 ${terminalStatus}，无法核验账务不变量 [UNVERIFIED]`);
      }
    }

    let balanceDelta: number | undefined;
    let balanceNote = '未提供钱包前后余额';
    if (params.balanceBefore !== undefined && params.balanceAfter !== undefined) {
      balanceDelta = params.balanceBefore - params.balanceAfter;
      balanceNote = `钱包余额变化: ${params.balanceBefore} -> ${params.balanceAfter} (差额 ${balanceDelta} pts)`;
    }

    const passed = reasons.length === 0;
    const status: FlowStepStatus = passed ? 'PASS' : taskLogs.length === 0 && !hasMismatchedTaskLogs ? 'BLOCKED' : 'FAIL';

    return {
      passed,
      status,
      expectedPoints,
      expectedChargeSource,
      preDeductedPoints: preDeduct,
      settledPoints: settled,
      refundedPoints: refunded,
      netDeductedPoints: netDeducted,
      underCharged,
      overCharged,
      duplicateCharged,
      duplicateRefunded,
      missingRefund,
      asyncSettlementPending,
      netChargeZero,
      antiDoubleBilling,
      refundIdempotency,
      ledgerEntries: structuredEntries,
      balanceAuxiliary: { balanceBefore: params.balanceBefore, balanceAfter: params.balanceAfter, balanceDelta, note: balanceNote },
      reasons,
    };
  }
}
