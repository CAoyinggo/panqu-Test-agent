/**
 * Panqu AI DevTest 计费预估、流水对账与供应商成本核算器 (Billing & Supplier Cost)
 *
 * 合并 billing-oracle 与 supplier-cost-oracle：
 * 1. 用户端积分刊例价与流水级对账：
 *    - calculateExpectedPoints: 依据官方刊例价计算预扣积分
 *    - reconcileTaskLedger: 专属任务预扣、结算、退款对账
 *    - 核心账务三大不变量：防重复扣费 (antiDoubleBilling)、失败净扣归零 (netChargeZero)、退款幂等 (refundIdempotency)
 * 2. 平台端供应商真金白银成本核算：
 *    - 依据飞书分流渠道表与系统规则推导上游成本 (CNY)
 *    - 充值档位赠送积分折算有效单价
 *    - 平台毛利率与价格倒挂门禁
 */

export type FlowMediaType = 'video' | 'image' | 'canvas';
export type FlowStepStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'BLOCKED' | 'NOT_APPLICABLE' | 'UNVERIFIED' | 'PASS' | 'FAIL';
export type TaskTerminalStatus = 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'NOT_SUBMITTED';

export type CostPricingUnit = 'yuan_per_second' | 'yuan_per_image';
export type SupplierEvidenceLevel =
  | 'INTERNAL_ESTIMATED'
  | 'DB_RECORD_VERIFIED'
  | 'BILL_RECONCILED'
  | 'EXTERNAL_RECONCILED'
  | 'UNVERIFIED';

export type UpstreamExecutionState =
  | 'REJECTED_BEFORE_EXECUTION'
  | 'EXECUTED_SUCCESS'
  | 'EXECUTED_FAILED'
  | 'UNKNOWN';

export interface RechargeBatch {
  amountCny: number;
  basePoints: number;
  giftPoints: number;
  totalPoints: number;
  effectiveCnyPerPoint: number;
  sourceOrderNo?: string;
  memo?: string;
}

const PRESET_LIST: RechargeBatch[] = [
  { amountCny: 10, basePoints: 100, giftPoints: 0, totalPoints: 100, effectiveCnyPerPoint: 0.100000, memo: '10元档无赠送' },
  { amountCny: 100, basePoints: 1000, giftPoints: 0, totalPoints: 1000, effectiveCnyPerPoint: 0.100000, memo: '100元档无赠送' },
  { amountCny: 300, basePoints: 3000, giftPoints: 300, totalPoints: 3300, effectiveCnyPerPoint: 300 / 3300, memo: '300元档送300积分' },
  { amountCny: 500, basePoints: 5000, giftPoints: 1250, totalPoints: 6250, effectiveCnyPerPoint: 500 / 6250, memo: '500元档送1250积分' },
  { amountCny: 1000, basePoints: 10000, giftPoints: 5000, totalPoints: 15000, effectiveCnyPerPoint: 1000 / 15000, memo: '1000元档送5000积分' },
  { amountCny: 2000, basePoints: 20000, giftPoints: 20000, totalPoints: 40000, effectiveCnyPerPoint: 2000 / 40000, memo: '2000元档送20000积分' },
];

export const STANDARD_RECHARGE_PRESETS: RechargeBatch[] & Record<string, RechargeBatch> = Object.assign(
  [...PRESET_LIST],
  {
    '10_TIER': PRESET_LIST[0],
    '100_TIER': PRESET_LIST[1],
    '300_TIER': PRESET_LIST[2],
    '500_TIER': PRESET_LIST[3],
    '1000_TIER': PRESET_LIST[4],
    '2000_TIER': PRESET_LIST[5],
    TIER_10: PRESET_LIST[0],
    TIER_100: PRESET_LIST[1],
    TIER_300: PRESET_LIST[2],
    TIER_500: PRESET_LIST[3],
    TIER_1000: PRESET_LIST[4],
    TIER_2000: PRESET_LIST[5],
  }
) as unknown as RechargeBatch[] & Record<string, RechargeBatch>;

export const FALLBACK_POINTS_PER_CNY = 30;
export const FALLBACK_CNY_PER_POINT = 1 / 30;

export interface UpstreamCallRecord {
  callIndex?: number;
  channelCode?: string;
  channelName: string;
  model?: string;
  modelName?: string;
  executionState: UpstreamExecutionState;
  durationSeconds?: number;
  unitCostCny?: number;
  unit?: CostPricingUnit;
  incurredCostCny?: number;
  costCny?: number;
  billed?: boolean;
  costState?: 'CONFIRMED' | 'ESTIMATED' | 'UNKNOWN';
  note?: string;
}

export interface SupplierCostVerdict {
  passed: boolean;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  expectedCostCny: number;
  unitCostCny: number;
  unit: CostPricingUnit;
  currency: 'CNY';
  channelCode: string;
  channelName: string;
  line: number;
  pricingBasis: string;
  isSuccessCharged: boolean;
  userPointsNetDeducted: number;
  effectiveCnyPerPoint: number;
  userRevenueCny: number;
  revenueCalculationBasis: string;
  rechargeBatchTraceable: boolean;
  estimatedGrossProfitCny: number;
  estimatedGrossMarginPercent?: number;
  grossMarginLabel: string;
  upstreamCalls: UpstreamCallRecord[];
  upstreamExecutionState: UpstreamExecutionState;
  evidenceLevel: SupplierEvidenceLevel;
  externalBillStatus: 'PENDING_SETTLEMENT' | 'RECONCILED' | 'NOT_AVAILABLE';
  reasons: string[];
}

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
  }): BillingAuditReport {
    const { taskId, expectedPoints, terminalStatus, scoreLogs } = params;
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

    let antiDoubleBilling = preDeductCount <= 1;
    let refundIdempotency = refundCount <= 1;
    let netChargeZero = true;

    if (preDeductCount > 1) {
      duplicateCharged = true;
      antiDoubleBilling = false;
      reasons.push(`[INVARIANT_VIOLATED: ANTI_DOUBLE_BILLING] 检测到重复预扣费: 任务 ID ${taskId} 存在 ${preDeductCount} 次预扣流水`);
    }

    const clientTokens = taskLogs
      .map((l) => l.client_token || l.idempotency_key)
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '');
    if (clientTokens.length > 1 && preDeductCount > 1) {
      antiDoubleBilling = false;
      reasons.push(`[INVARIANT_VIOLATED: ANTI_DOUBLE_BILLING] 检测到并发/重试未去重: 同一 clientToken (${clientTokens[0]}) 触发了多次扣费`);
    }

    if (refundCount > 1) {
      duplicateRefunded = true;
      refundIdempotency = false;
      reasons.push(`[INVARIANT_VIOLATED: REFUND_IDEMPOTENCY] 检测到重复退款: 任务 ID ${taskId} 存在 ${refundCount} 次退款记录`);
    }

    if (terminalStatus === 'SUCCESS') {
      netChargeZero = true;
      if (preDeductCount === 0) {
        if (params.allowAsyncPending) {
          asyncSettlementPending = true;
          reasons.push(`成功任务预扣流水尚未落盘，标记异步入账处理中`);
        } else {
          reasons.push(`成功任务缺失预扣流水记录`);
        }
      } else if (netDeducted < expectedPoints) {
        underCharged = true;
        reasons.push(`少扣费: 应扣 ${expectedPoints} 积分，实际净扣 ${netDeducted} 积分`);
      } else if (netDeducted > expectedPoints) {
        overCharged = true;
        reasons.push(`多扣费: 应扣 ${expectedPoints} 积分，实际净扣 ${netDeducted} 积分 (超扣 ${netDeducted - expectedPoints})`);
      }
    } else if (terminalStatus === 'FAILED') {
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

export interface SupplierCostAuditParams {
  mediaType: FlowMediaType;
  modelId: number;
  duration?: number;
  resolution?: string;
  userPointsPaid?: number;
  terminalStatus?: TaskTerminalStatus;
  actualChannelName?: string;
  actualLine?: number;
  actualRecordedCostCny?: number;
  upstreamBillReceived?: boolean;
  rechargeBatch?: RechargeBatch;
  effectiveCnyPerPoint?: number;
  upstreamExecutionState?: UpstreamExecutionState;
  upstreamCalls?: UpstreamCallRecord[];
  requireVerifiedEvidence?: boolean;
  requireVerifiedCostEvidence?: boolean;
}

export class SupplierCostOracle {
  private static resolveCostResult(opts: {
    unitCost: number;
    unit: CostPricingUnit;
    multiplier: number;
    channelCode: string;
    channelName: string;
    line: number;
    baseBasis: string;
    upstreamExecutionState: UpstreamExecutionState;
  }) {
    const fullCalculatedCost = parseFloat((opts.unitCost * opts.multiplier).toFixed(4));

    if (opts.upstreamExecutionState === 'REJECTED_BEFORE_EXECUTION') {
      return {
        expectedCostCny: 0,
        unitCostCny: opts.unitCost,
        unit: opts.unit,
        channelCode: opts.channelCode,
        channelName: opts.channelName,
        line: opts.line,
        pricingBasis: `${opts.baseBasis} (上游未执行/前置拦截，实付成本归零 ¥0)`,
        isSuccessCharged: false,
        costState: 'CONFIRMED' as const,
        upstreamExecutionState: opts.upstreamExecutionState,
      };
    }

    if (opts.upstreamExecutionState === 'EXECUTED_FAILED') {
      return {
        expectedCostCny: fullCalculatedCost,
        unitCostCny: opts.unitCost,
        unit: opts.unit,
        channelCode: opts.channelCode,
        channelName: opts.channelName,
        line: opts.line,
        pricingBasis: `${opts.baseBasis} (上游已调用执行但生成失败，上游仍产生计费 ¥${fullCalculatedCost})`,
        isSuccessCharged: true,
        costState: 'CONFIRMED' as const,
        upstreamExecutionState: opts.upstreamExecutionState,
      };
    }

    if (opts.upstreamExecutionState === 'UNKNOWN') {
      return {
        expectedCostCny: 0,
        unitCostCny: opts.unitCost,
        unit: opts.unit,
        channelCode: opts.channelCode,
        channelName: opts.channelName,
        line: opts.line,
        pricingBasis: `${opts.baseBasis} (上游消耗证据缺失，成本状态待核实)`,
        isSuccessCharged: false,
        costState: 'UNKNOWN' as const,
        upstreamExecutionState: opts.upstreamExecutionState,
      };
    }

    return {
      expectedCostCny: fullCalculatedCost,
      unitCostCny: opts.unitCost,
      unit: opts.unit,
      channelCode: opts.channelCode,
      channelName: opts.channelName,
      line: opts.line,
      pricingBasis: opts.baseBasis,
      isSuccessCharged: true,
      costState: 'CONFIRMED' as const,
      upstreamExecutionState: opts.upstreamExecutionState,
    };
  }

  public static calculateSingleCallCost(params: {
    mediaType: FlowMediaType;
    modelId: number;
    duration?: number;
    resolution?: string;
    channelName?: string;
    line?: number;
    terminalStatus?: TaskTerminalStatus;
    upstreamExecutionState?: UpstreamExecutionState;
  }): {
    expectedCostCny: number;
    unitCostCny: number;
    unit: CostPricingUnit;
    channelCode: string;
    channelName: string;
    line: number;
    pricingBasis: string;
    isSuccessCharged: boolean;
    costState: 'CONFIRMED' | 'ESTIMATED' | 'UNKNOWN';
    upstreamExecutionState: UpstreamExecutionState;
  } {
    const { mediaType, modelId, terminalStatus = 'SUCCESS' } = params;
    const duration = Math.max(1, params.duration ?? 4);
    const resolution = (params.resolution || '').toLowerCase().trim();

    const upstreamExecutionState: UpstreamExecutionState =
      params.upstreamExecutionState ??
      (terminalStatus === 'SUCCESS' ? 'EXECUTED_SUCCESS' : 'UNKNOWN');

    if (mediaType === 'image') {
      if (modelId === 201) {
        const unitCost = 0.08;
        return this.resolveCostResult({
          unitCost,
          unit: 'yuan_per_image',
          multiplier: 1,
          channelCode: 'RH',
          channelName: params.channelName || 'RH-图片',
          line: params.line ?? 10,
          baseBasis: 'RunningHub Nano Banana 2 ¥0.08/张',
          upstreamExecutionState,
        });
      }
      const unitCost = 0.05;
      return this.resolveCostResult({
        unitCost,
        unit: 'yuan_per_image',
        multiplier: 1,
        channelCode: 'RH',
        channelName: params.channelName || 'RH-图片',
        line: params.line ?? 10,
        baseBasis: 'RunningHub Standard Image ¥0.05/张',
        upstreamExecutionState,
      });
    }

    if (modelId === 84) {
      let unitCost = 0.18;
      let basis = 'Wan 3.0 480P ¥0.18/s';
      if (resolution.includes('720')) {
        unitCost = 0.36;
        basis = 'Wan 3.0 720P ¥0.36/s';
      } else if (resolution.includes('1080')) {
        unitCost = 0.72;
        basis = 'Wan 3.0 1080P ¥0.72/s';
      }
      return this.resolveCostResult({
        unitCost,
        unit: 'yuan_per_second',
        multiplier: duration,
        channelCode: 'WX',
        channelName: params.channelName || '万相—yhuo',
        line: params.line ?? 10,
        baseBasis: basis,
        upstreamExecutionState,
      });
    }

    if (modelId === 88) {
      let unitCost = 0.315;
      let basis = 'Wan 3.0 Prime 480P ¥0.315/s';
      if (resolution.includes('720')) {
        unitCost = 0.63;
        basis = 'Wan 3.0 Prime 720P ¥0.63/s';
      } else if (resolution.includes('1080')) {
        unitCost = 1.26;
        basis = 'Wan 3.0 Prime 1080P ¥1.26/s';
      }
      return this.resolveCostResult({
        unitCost,
        unit: 'yuan_per_second',
        multiplier: duration,
        channelCode: 'WX',
        channelName: params.channelName || '万相—yhuo',
        line: params.line ?? 10,
        baseBasis: basis,
        upstreamExecutionState,
      });
    }

    if (modelId === 15) {
      let unitCost = 0.3696;
      let basis = 'TD Seedance 2.0 480P ¥0.3696/s (火山基准×0.8)';
      if (resolution.includes('720')) {
        unitCost = 0.7952;
        basis = 'TD Seedance 2.0 720P ¥0.7952/s (火山基准×0.8)';
      } else if (resolution.includes('1080')) {
        unitCost = 2.0;
        basis = 'TD Seedance 2.0 1080P ¥2.0000/s (火山基准×0.8)';
      }
      return this.resolveCostResult({
        unitCost,
        unit: 'yuan_per_second',
        multiplier: duration,
        channelCode: 'TD',
        channelName: params.channelName || 'TD',
        line: params.line ?? 4,
        baseBasis: basis,
        upstreamExecutionState,
      });
    }

    if (modelId === 78) {
      const unitCost = 0.5376;
      return this.resolveCostResult({
        unitCost,
        unit: 'yuan_per_second',
        multiplier: duration,
        channelCode: 'TD',
        channelName: params.channelName || 'TD',
        line: params.line ?? 4,
        baseBasis: 'TD Seedance 2.5 480P ¥0.5376/s (火山基准×0.8)',
        upstreamExecutionState,
      });
    }

    const fallbackUnit = 0.18;
    return this.resolveCostResult({
      unitCost: fallbackUnit,
      unit: 'yuan_per_second',
      multiplier: duration,
      channelCode: 'DIRECT',
      channelName: params.channelName || '默认线路',
      line: params.line ?? 0,
      baseBasis: '默认兜底 ¥0.18/s',
      upstreamExecutionState,
    });
  }

  public static calculateExpectedCost(params: {
    mediaType: FlowMediaType;
    modelId: number;
    duration?: number;
    resolution?: string;
    channelName?: string;
    line?: number;
    terminalStatus?: TaskTerminalStatus;
    upstreamExecutionState?: UpstreamExecutionState;
  }) {
    return this.calculateSingleCallCost(params);
  }

  public static calculateEffectiveCnyPerPoint(rechargeBatch?: RechargeBatch, explicitRate?: number): {
    rate: number;
    basis: string;
    traceable: boolean;
  } {
    if (explicitRate !== undefined && explicitRate > 0) {
      return { rate: explicitRate, basis: `指定有效积分单价: ¥${explicitRate.toFixed(6)}/pt`, traceable: true };
    }
    if (rechargeBatch) {
      const totalPoints = rechargeBatch.totalPoints > 0
        ? rechargeBatch.totalPoints
        : (rechargeBatch.basePoints + rechargeBatch.giftPoints);
      const rate = totalPoints > 0 ? rechargeBatch.amountCny / totalPoints : FALLBACK_CNY_PER_POINT;
      return {
        rate,
        basis: `可追溯充值批次折算: 实付充值 ¥${rechargeBatch.amountCny} / 实际到账 ${totalPoints} 积分 (含赠送 ${rechargeBatch.giftPoints})，有效单价 ¥${rate.toFixed(6)}/pt`,
        traceable: true,
      };
    }
    return {
      rate: FALLBACK_CNY_PER_POINT,
      basis: `ESTIMATED_FALLBACK_30_PTS_PER_CNY (充值来源不明，按约30积分/元参考估算[单价约¥0.0333/pt]，非精确业务定价)`,
      traceable: false,
    };
  }

  public static audit(params: SupplierCostAuditParams): SupplierCostVerdict {
    const reasons: string[] = [];

    let totalExpectedCostCny = 0;
    const recordedCalls: UpstreamCallRecord[] = [];
    let overallUpstreamState: UpstreamExecutionState = params.upstreamExecutionState ?? (
      params.terminalStatus === 'SUCCESS' ? 'EXECUTED_SUCCESS' : 'UNKNOWN'
    );
    let primaryPricingBasis = '';
    let primaryUnitCost = 0;
    let primaryUnit: CostPricingUnit = 'yuan_per_second';
    let primaryChannelCode = '';
    let primaryChannelName = params.actualChannelName || '';
    let primaryLine = params.actualLine ?? 0;
    let anyCallUnknown = false;

    if (params.upstreamCalls && params.upstreamCalls.length > 0) {
      for (let i = 0; i < params.upstreamCalls.length; i++) {
        const rawCall = params.upstreamCalls[i];
        const cost = rawCall.costCny ?? rawCall.incurredCostCny ?? 0;
        const call: UpstreamCallRecord = {
          callIndex: i + 1,
          channelCode: rawCall.channelCode || 'UPSTREAM',
          channelName: rawCall.channelName,
          model: rawCall.model || rawCall.modelName,
          modelName: rawCall.modelName || rawCall.model,
          executionState: rawCall.executionState,
          durationSeconds: rawCall.durationSeconds,
          unitCostCny: rawCall.unitCostCny ?? cost,
          unit: rawCall.unit ?? 'yuan_per_second',
          incurredCostCny: cost,
          costCny: cost,
          billed: rawCall.billed ?? (cost > 0),
          costState: rawCall.costState ?? (rawCall.executionState === 'UNKNOWN' ? 'UNKNOWN' : 'CONFIRMED'),
          note: rawCall.note,
        };
        recordedCalls.push(call);
        totalExpectedCostCny += cost;
        if (call.costState === 'UNKNOWN') {
          anyCallUnknown = true;
        }
      }
      totalExpectedCostCny = parseFloat(totalExpectedCostCny.toFixed(4));
      primaryPricingBasis = `多渠道调用累加 (${recordedCalls.length}次调用，合计 ¥${totalExpectedCostCny})`;
      primaryUnitCost = recordedCalls[0]?.unitCostCny ?? 0;
      primaryUnit = recordedCalls[0]?.unit ?? 'yuan_per_second';
      primaryChannelCode = recordedCalls.map((c) => c.channelCode).join('+');
      primaryChannelName = recordedCalls.map((c) => c.channelName).join('+');
      overallUpstreamState = recordedCalls.some((c) => c.executionState === 'EXECUTED_SUCCESS')
        ? 'EXECUTED_SUCCESS'
        : recordedCalls.some((c) => c.executionState === 'EXECUTED_FAILED')
        ? 'EXECUTED_FAILED'
        : recordedCalls[0]?.executionState ?? 'UNKNOWN';
    } else {
      const single = this.calculateSingleCallCost({
        mediaType: params.mediaType,
        modelId: params.modelId,
        duration: params.duration,
        resolution: params.resolution,
        channelName: params.actualChannelName,
        line: params.actualLine,
        terminalStatus: params.terminalStatus,
        upstreamExecutionState: params.upstreamExecutionState,
      });

      totalExpectedCostCny = single.expectedCostCny;
      primaryPricingBasis = single.pricingBasis;
      primaryUnitCost = single.unitCostCny;
      primaryUnit = single.unit;
      primaryChannelCode = single.channelCode;
      primaryChannelName = single.channelName;
      primaryLine = single.line;
      overallUpstreamState = single.upstreamExecutionState;

      if (single.costState === 'UNKNOWN') {
        anyCallUnknown = true;
      }

      recordedCalls.push({
        callIndex: 1,
        channelCode: single.channelCode,
        channelName: single.channelName,
        model: `${params.mediaType}-${params.modelId}`,
        executionState: single.upstreamExecutionState,
        durationSeconds: params.duration,
        unitCostCny: single.unitCostCny,
        unit: single.unit,
        incurredCostCny: single.expectedCostCny,
        costCny: single.expectedCostCny,
        billed: single.isSuccessCharged,
        costState: single.costState,
        note: single.pricingBasis,
      });
    }

    const userPointsNetDeducted = params.userPointsPaid ?? 0;
    const effective = this.calculateEffectiveCnyPerPoint(params.rechargeBatch, params.effectiveCnyPerPoint);
    const effectiveCnyPerPoint = effective.rate;
    const rechargeBatchTraceable = effective.traceable;
    const revenueCalculationBasis = effective.basis;

    const userRevenueCny = parseFloat((userPointsNetDeducted * effectiveCnyPerPoint).toFixed(4));
    const estimatedGrossProfitCny = parseFloat((userRevenueCny - totalExpectedCostCny).toFixed(4));
    let estimatedGrossMarginPercent: number | undefined;
    let grossMarginLabel: string;

    if (userRevenueCny <= 0) {
      estimatedGrossMarginPercent = undefined;
      grossMarginLabel = totalExpectedCostCny > 0
        ? `N/A (收入为0，净亏损 ¥${totalExpectedCostCny})`
        : 'N/A (收入为0，不适用)';
    } else {
      estimatedGrossMarginPercent = parseFloat(
        ((estimatedGrossProfitCny / userRevenueCny) * 100).toFixed(2)
      );
      grossMarginLabel = `${estimatedGrossMarginPercent}%`;
    }

    let evidenceLevel: SupplierEvidenceLevel = 'INTERNAL_ESTIMATED';
    let externalBillStatus: 'PENDING_SETTLEMENT' | 'RECONCILED' | 'NOT_AVAILABLE' = 'PENDING_SETTLEMENT';

    if (anyCallUnknown) {
      evidenceLevel = 'UNVERIFIED';
      reasons.push('上游消耗或执行状态存在未知记录；缺少明确凭证，严禁默认将供应商成本归零');
    }

    if (params.upstreamBillReceived && params.actualRecordedCostCny !== undefined) {
      evidenceLevel = 'BILL_RECONCILED';
      externalBillStatus = 'RECONCILED';
      const diff = Math.abs(params.actualRecordedCostCny - totalExpectedCostCny);
      if (diff > 0.005) {
        reasons.push(
          `供应商成本账单偏差: 预期成本 ¥${totalExpectedCostCny}, 实际账单记录 ¥${params.actualRecordedCostCny} (差额 ¥${diff.toFixed(4)})`
        );
      }
    } else if (!anyCallUnknown) {
      reasons.push('已完成平台内部供应商成本推导核算；外部供应商原始账单待归集（账单大盘异步归集）');
    }

    const hasDeviation = reasons.some((r) => r.includes('供应商成本账单偏差'));
    const isUnverified = anyCallUnknown || evidenceLevel === 'UNVERIFIED';
    let passed = true;
    let status: 'PASS' | 'FAIL' | 'BLOCKED' = 'PASS';

    const requireStrict = Boolean(params.requireVerifiedEvidence || params.requireVerifiedCostEvidence);
    if (hasDeviation) {
      passed = false;
      status = 'FAIL';
    } else if (isUnverified) {
      passed = !requireStrict;
      status = requireStrict ? 'BLOCKED' : 'PASS';
    }

    return {
      passed,
      status,
      expectedCostCny: totalExpectedCostCny,
      unitCostCny: primaryUnitCost,
      unit: primaryUnit,
      currency: 'CNY',
      channelCode: primaryChannelCode,
      channelName: primaryChannelName,
      line: primaryLine,
      pricingBasis: primaryPricingBasis,
      isSuccessCharged: totalExpectedCostCny > 0,
      userPointsNetDeducted,
      effectiveCnyPerPoint,
      userRevenueCny,
      revenueCalculationBasis,
      rechargeBatchTraceable,
      estimatedGrossProfitCny,
      estimatedGrossMarginPercent,
      grossMarginLabel,
      upstreamCalls: recordedCalls,
      upstreamExecutionState: overallUpstreamState,
      evidenceLevel,
      externalBillStatus,
      reasons,
    };
  }

  public static evaluateTaskSupplierCost(params: SupplierCostAuditParams): SupplierCostVerdict {
    return SupplierCostOracle.audit(params);
  }

  public static auditSupplierMargin(params: {
    modelId: number;
    mediaType?: FlowMediaType;
    targetMarginPercent?: number;
    effectiveCnyPerPoint?: number;
    customPointsMap?: Record<string, number>;
  }): {
    passed: boolean;
    targetMarginPercent: number;
    items: Array<{ resolution: string; points: number; revenueCny: number; costCny: number; marginPercent: number; passed: boolean }>;
    reasons: string[];
  } {
    const targetMargin = params.targetMarginPercent ?? 30;
    const rate = params.effectiveCnyPerPoint ?? 0.10;
    const resolutions = ['480p', '720p', '1080p'];
    const items: Array<{ resolution: string; points: number; revenueCny: number; costCny: number; marginPercent: number; passed: boolean }> = [];
    const reasons: string[] = [];

    for (const res of resolutions) {
      const points = params.customPointsMap?.[res] ?? BillingOracle.calculateExpectedPoints({
        mediaType: params.mediaType || 'video',
        modelId: params.modelId,
        duration: 4,
        resolution: res,
      });
      const revenue = points * rate;
      const costResult = this.calculateSingleCallCost({
        mediaType: params.mediaType || 'video',
        modelId: params.modelId,
        duration: 4,
        resolution: res,
      });
      const cost = costResult.expectedCostCny;
      const margin = revenue > 0 ? ((revenue - cost) / revenue) * 100 : -100;
      const passed = margin >= targetMargin;
      if (!passed) reasons.push(`${res} 毛利率 (${margin.toFixed(1)}%) 低于目标基准 (${targetMargin}%)`);
      items.push({ resolution: res, points, revenueCny: revenue, costCny: cost, marginPercent: margin, passed });
    }

    return { passed: reasons.length === 0, targetMarginPercent: targetMargin, items, reasons };
  }
}
