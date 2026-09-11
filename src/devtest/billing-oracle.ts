/**
 * BillingOracle - 独立的计费预估与流水级对账器
 *
 * 依据已确认需求规则与刊例价独立计算金额：
 * 1. 单位：积分（固定汇率 10 积分 = 1 元人民币）
 * 2. 精确度与舍入：整数积分（Math.round 四舍五入）
 * 3. 关联任务主键对账：预扣（type=2）、结算、退款（type=1）
 * 4. 全面审计：重复扣费、漏退款、重复退款、多扣/少扣、降级计费归属
 * 5. 考虑异步入账容差；余额总差额仅作为辅助证据
 */

import type { FlowMediaType, FlowStepStatus, TaskTerminalStatus } from './panqu-playwright-engine.js';

export interface ScoreLogEntry {
  id?: number | string;
  task_id?: number | string;
  type: number | string; // 2: 扣费/预扣, 1: 充值/退款
  score: number; // 积分值 (扣费通常为负数或正数绝对值)
  memo?: string;
  createtime?: number | string;
}

export interface BillingAuditReport {
  passed: boolean;
  status: FlowStepStatus;
  expectedPoints: number;
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
  ledgerEntries: Array<{
    id?: string;
    type: 'PRE_DEDUCT' | 'SETTLE' | 'REFUND';
    points: number;
    time?: string;
    memo?: string;
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
  /**
   * 依据刊例价表独立计算预期消耗积分
   */
  public static calculateExpectedPoints(params: {
    mediaType: FlowMediaType;
    modelId: number;
    duration?: number;
    resolution?: string;
    hasReferenceVideo?: boolean;
  }): number {
    if (params.mediaType === 'image') {
      // 依据 aibaseos Points.php 与 FastAdmin 真实刊例：
      // 基础图片模型标准刊例价为 5 积分/张
      // 若为 Model 12 (Pan Banana Pro) 且指定 1k/2k 高清场景图：实收 10 积分；4k 为 15 积分
      if (params.modelId === 12 && params.resolution) {
        const res = params.resolution.toLowerCase().trim();
        if (res.includes('4k')) return 15;
        if (res.includes('1k') || res.includes('2k')) return 10;
      }
      return 5;
    }

    const duration = Math.max(1, params.duration ?? 4);
    const resolution = (params.resolution || '').toLowerCase().trim();

    // 1. Wan 3.0 (ID 84)
    // 480P: 7 积分/秒, 720P: 14 积分/秒, 1080P: 27 积分/秒
    if (params.modelId === 84) {
      if (resolution.includes('720')) return Math.round(14 * duration);
      if (resolution.includes('1080')) return Math.round(27 * duration);
      return Math.round(7 * duration); // 默认 480p: 7 积分/秒
    }

    // 2. Wan 3.0 Prime (ID 88)
    // 480P: 11 积分/秒, 720P: 22 积分/秒, 1080P: 44 积分/秒
    if (params.modelId === 88) {
      if (resolution.includes('480')) return Math.round(11 * duration);
      if (resolution.includes('1080')) return Math.round(44 * duration);
      return Math.round(22 * duration); // 720p 默认
    }

    // 3. Seedance 2.0 (ID 15)
    // 480P: 15 积分/秒 (4s=60), 720P: 30 积分/秒 (4s=120)
    if (params.modelId === 15) {
      if (resolution.includes('480')) return Math.round(15 * duration);
      return Math.round(30 * duration); // 720p 默认
    }

    // 4. Seedance 2.5 (ID 78)
    // 480P: 20 积分/秒, 720P: 40 积分/秒
    if (params.modelId === 78) {
      if (resolution.includes('480')) return Math.round(20 * duration);
      return Math.round(40 * duration);
    }

    // 默认兜底：按 7 积分/秒
    return Math.round(7 * duration);
  }

  /**
   * 对账任务专属积分流水
   */
  public static reconcileTaskLedger(params: {
    taskId: number;
    expectedPoints: number;
    terminalStatus: TaskTerminalStatus;
    scoreLogs: ScoreLogEntry[];
    balanceBefore?: number;
    balanceAfter?: number;
    allowAsyncPending?: boolean;
  }): BillingAuditReport {
    const { taskId, expectedPoints, terminalStatus, scoreLogs } = params;
    const reasons: string[] = [];

    // 1. 过滤属于该任务的专属流水
    const taskLogs = scoreLogs.filter((log) => {
      if (log.task_id !== undefined && log.task_id !== null) {
        return Number(log.task_id) === Number(taskId);
      }
      // 若无显式 task_id，检查 memo 中是否含 taskId
      if (log.memo && log.memo.includes(String(taskId))) {
        return true;
      }
      return false;
    });

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
        // 退款 / 解冻
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
        // 预扣 / 消费
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

    // 2. 核心异常审计
    let duplicateCharged = false;
    let duplicateRefunded = false;
    let underCharged = false;
    let overCharged = false;
    let missingRefund = false;
    let asyncSettlementPending = false;

    // 防重扣
    if (preDeductCount > 1) {
      duplicateCharged = true;
      reasons.push(`检测到重复预扣费: 任务 ID ${taskId} 存在 ${preDeductCount} 次预扣记录 (总扣 ${preDeduct} pts)`);
    }

    // 防重退
    if (refundCount > 1) {
      duplicateRefunded = true;
      reasons.push(`检测到重复退款: 任务 ID ${taskId} 存在 ${refundCount} 次退款记录 (总退 ${refunded} pts)`);
    }

    // 依据终态核对实扣
    if (terminalStatus === 'SUCCESS') {
      if (preDeductCount === 0) {
        if (params.allowAsyncPending) {
          asyncSettlementPending = true;
          reasons.push(`成功任务预扣流水尚未落盘，标记异步入账处理中`);
        } else {
          reasons.push(`成功任务缺失预扣流水记录`);
        }
      } else if (netDeducted < expectedPoints) {
        underCharged = true;
        reasons.push(`少扣费: 依据刊例价应扣 ${expectedPoints} 积分，实际净扣除 ${netDeducted} 积分`);
      } else if (netDeducted > expectedPoints) {
        overCharged = true;
        reasons.push(`多扣费: 依据刊例价应扣 ${expectedPoints} 积分，实际净扣除 ${netDeducted} 积分 (超扣 ${netDeducted - expectedPoints})`);
      }
    } else if (terminalStatus === 'FAILED') {
      if (preDeductCount === 0 && expectedPoints > 0) {
        if (params.allowAsyncPending) {
          asyncSettlementPending = true;
          reasons.push(`失败任务预扣与退款流水尚未落盘，标记异步处理中`);
        } else {
          reasons.push(`失败任务缺失专属预扣流水记录，无法确认扣退核销状态`);
        }
      } else if (netDeducted > 0) {
        missingRefund = true;
        reasons.push(`任务失败漏退款: 任务已生成失败，但仍有净扣除 ${netDeducted} 积分未退回`);
      }
    } else if (terminalStatus === 'TIMEOUT') {
      reasons.push(`任务处于 TIMEOUT 超时未决状态，保留最后账务快照 (净扣 ${netDeducted} pts)`);
    } else {
      reasons.push(`任务处于未决或未知状态 (${terminalStatus})，无法完成计费终态对账`);
    }

    // 3. 辅助钱包余额差额
    let balanceDelta: number | undefined;
    let balanceNote = '未提供钱包前后余额';
    if (params.balanceBefore !== undefined && params.balanceAfter !== undefined) {
      balanceDelta = params.balanceBefore - params.balanceAfter;
      balanceNote = `钱包余额变化: ${params.balanceBefore} -> ${params.balanceAfter} (差额 ${balanceDelta} pts)；主判定依据任务流水`;
    }

    const passed = reasons.length === 0;
    const status: FlowStepStatus = passed ? 'PASS' : 'FAIL';

    return {
      passed,
      status,
      expectedPoints,
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
      ledgerEntries: structuredEntries,
      balanceAuxiliary: {
        balanceBefore: params.balanceBefore,
        balanceAfter: params.balanceAfter,
        balanceDelta,
        note: balanceNote,
      },
      reasons,
    };
  }
}
