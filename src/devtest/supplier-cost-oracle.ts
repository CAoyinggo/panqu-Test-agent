/**
 * SupplierCostOracle - 独立的平台侧供应商成本核算与对账器
 *
 * 核心职责与业务口径：
 * 1. 与用户侧积分彻底分离，核算平台实际支付给上游供应商（万相/阿里、TalkingData/火山、RunningHub等）的真金白银成本（单位：元 CNY）。
 * 2. 依据飞书分流渠道表与系统 pq_absetting 规则库，独立推导各模型/分辨率/时长的成本单价。
 * 3. 严格落实失败任务成本判定：用户退款不代表供应商成本为零！若缺少上游调用与执行证据，标记为 UNKNOWN，严禁擅自归零。
 * 4. 支持单任务多次上游调用（分流重试/渠道切换，如 NewAPI 失败后兜底火山）的成本累加。
 * 5. 收入折算必须包含充值赠送积分：有效每积分金额 = 实付充值金额 ÷ 实际到账总积分（含赠送）。
 *    若充值来源不明，仅将约 30 积分/元作为参考估算并明确标注，彻底移除未经证实的 10 积分/元口径。
 * 6. 任务折算收入为零时，毛利率标记不适用（N/A）；若仍发生供应商成本，准确体现负毛利（净亏损）。
 */

import type { FlowMediaType, TaskTerminalStatus } from './panqu-playwright-engine.js';

export type CostPricingUnit = 'yuan_per_second' | 'yuan_per_image';
export type SupplierEvidenceLevel =
  | 'INTERNAL_ESTIMATED'  // 规则推导预估
  | 'DB_RECORD_VERIFIED'   // 业务数据库记录核验
  | 'BILL_RECONCILED'      // 外部供应商账单勾兑
  | 'EXTERNAL_RECONCILED'  // 兼容别名
  | 'UNVERIFIED';          // 待核验/凭证缺失

export type UpstreamExecutionState =
  | 'REJECTED_BEFORE_EXECUTION' // 上游未执行/前置拦截（如敏感词预检、503无可用渠道），成本确认为 0
  | 'EXECUTED_SUCCESS'          // 上游成功执行并计费
  | 'EXECUTED_FAILED'           // 上游已执行但在生成/回传中失败，上游仍产生计费（平台损失）
  | 'UNKNOWN';                  // 缺少上游明确调用与消耗凭证，不可自动归零

/**
 * 充值批次信息（用于精确折算有效每积分金额）
 */
export interface RechargeBatch {
  amountCny: number;            // 实付充值金额（元）
  basePoints: number;           // 基础充值积分（按基准汇率）
  giftPoints: number;           // 赠送积分
  totalPoints: number;          // 实际到账总积分（basePoints + giftPoints）
  effectiveCnyPerPoint: number; // 有效每积分金额 = amountCny / totalPoints
  sourceOrderNo?: string;       // 充值订单号（可追溯）
  memo?: string;                // 充值档位说明
}

const PRESET_LIST: RechargeBatch[] = [
  { amountCny: 10, basePoints: 100, giftPoints: 0, totalPoints: 100, effectiveCnyPerPoint: 0.100000, memo: '10元档无赠送' },
  { amountCny: 100, basePoints: 1000, giftPoints: 0, totalPoints: 1000, effectiveCnyPerPoint: 0.100000, memo: '100元档无赠送' },
  { amountCny: 300, basePoints: 3000, giftPoints: 300, totalPoints: 3300, effectiveCnyPerPoint: 300 / 3300, memo: '300元档送300积分(有效约11分/元)' },
  { amountCny: 500, basePoints: 5000, giftPoints: 1250, totalPoints: 6250, effectiveCnyPerPoint: 500 / 6250, memo: '500元档送1250积分(有效12.5分/元)' },
  { amountCny: 1000, basePoints: 10000, giftPoints: 5000, totalPoints: 15000, effectiveCnyPerPoint: 1000 / 15000, memo: '1000元档送5000积分(有效15分/元)' },
  { amountCny: 2000, basePoints: 20000, giftPoints: 20000, totalPoints: 40000, effectiveCnyPerPoint: 2000 / 40000, memo: '2000元档送20000积分(有效20分/元)' },
];

/**
 * 生产标准充值预设（来自 aibaseos/application/extra/site_recharge.php: '10|0,100|0,300|300,500|1250,1000|5000,2000|20000'）
 * 同时支持数组索引与按档位名索引（如 STANDARD_RECHARGE_PRESETS['100_TIER']）
 */
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

// 缺失数据时的参考估算（约30积分/元，非精确业务定价）
export const FALLBACK_POINTS_PER_CNY = 30;
export const FALLBACK_CNY_PER_POINT = 1 / 30; // 0.03333333333333333

/**
 * 单次上游调用证据记录
 */
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

  // 充值赠送与收入折算明细
  userPointsNetDeducted: number;
  effectiveCnyPerPoint: number;
  userRevenueCny: number;
  revenueCalculationBasis: string;
  rechargeBatchTraceable: boolean;

  // 毛利计算
  estimatedGrossProfitCny: number;
  estimatedGrossMarginPercent?: number; // 收入为0时为 undefined (N/A)
  grossMarginLabel: string;             // 如 "74.29%" 或 "N/A (收入为0，不适用)"

  // 上游调用链路详情（支持多次调用/重试累加）
  upstreamCalls: UpstreamCallRecord[];
  upstreamExecutionState: UpstreamExecutionState;

  // 凭证与外部账单
  evidenceLevel: SupplierEvidenceLevel;
  externalBillStatus: 'PENDING_SETTLEMENT' | 'RECONCILED' | 'NOT_AVAILABLE';
  reasons: string[];
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

  // 业务口径扩展：充值批次或指定有效单价
  rechargeBatch?: RechargeBatch;
  effectiveCnyPerPoint?: number;

  // 业务口径扩展：上游真实执行与计费状态
  upstreamExecutionState?: UpstreamExecutionState;

  // 业务口径扩展：多上游调用历史（重试/渠道切换）
  upstreamCalls?: UpstreamCallRecord[];

  // 强制证据完整性校验
  requireVerifiedEvidence?: boolean;
  requireVerifiedCostEvidence?: boolean;
}

export class SupplierCostOracle {
  /**
   * 独立推导平台侧单次调用的供应商单价与预期成本
   */
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

    // 确定上游执行状态：
    // 若未显式传入，当任务成功时为 EXECUTED_SUCCESS；当任务失败时默认为 UNKNOWN（缺少上游明确证据不可自动归零）
    const upstreamExecutionState: UpstreamExecutionState =
      params.upstreamExecutionState ??
      (terminalStatus === 'SUCCESS' ? 'EXECUTED_SUCCESS' : 'UNKNOWN');

    // ----------------------------------------------------
    // 1. 图片生成（RunningHub / APIFree / 直连）
    // ----------------------------------------------------
    if (mediaType === 'image') {
      // RunningHub Nano Banana 2 (ID 201)
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
      // Pan Banana Pro / 标准图片 (ID 12 或其他)
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

    // ----------------------------------------------------
    // 2. 视频生成：万相 / 阿里 (Line 11 / NewAPI Line 10)
    // ----------------------------------------------------
    // Wan 3.0 (ID 84)
    // 480P: 0.1800 元/秒, 720P: 0.3600 元/秒, 1080P: 0.7200 元/秒
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

    // Wan 3.0 Prime (ID 88)
    // 480P: 0.3150 元/秒, 720P: 0.6300 元/秒, 1080P: 1.2600 元/秒
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

    // ----------------------------------------------------
    // 3. 视频生成：TalkingData / TD (Line 4)
    // 成本表标准：火山基准价 × 0.8
    // ----------------------------------------------------
    // Seedance 2.0 (ID 15)
    // 480P: 0.3696 元/秒 (= 0.462 × 0.8)
    // 720P: 0.7952 元/秒 (= 0.994 × 0.8)
    // 1080P: 2.0000 元/秒 (= 2.500 × 0.8)
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

    // Seedance 2.5 (ID 78)
    // 480P: 0.5376 元/秒 (= 0.672 × 0.8)
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

    // 默认基准兜底（0.18 元/秒）
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

  /**
   * 辅助方法：结合上游实际执行状态解析单次调用的成本计算结果
   */
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

    // EXECUTED_SUCCESS
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

  /**
   * 兼容保留静态方法签名，委托给 calculateSingleCallCost
   */
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
    const single = this.calculateSingleCallCost(params);
    return {
      expectedCostCny: single.expectedCostCny,
      unitCostCny: single.unitCostCny,
      unit: single.unit,
      channelCode: single.channelCode,
      channelName: single.channelName,
      line: single.line,
      pricingBasis: single.pricingBasis,
      isSuccessCharged: single.isSuccessCharged,
      costState: single.costState,
      upstreamExecutionState: single.upstreamExecutionState,
    };
  }

  /**
   * 综合审计平台侧供应商成本、折算收入与毛利（支持多调用累加与赠送积分联动）
   */
  public static audit(params: SupplierCostAuditParams): SupplierCostVerdict {
    const reasons: string[] = [];

    // 1. 处理上游调用与供应商总成本（支持单任务多上游重试/兜底累加）
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
      // 场景 A：传入了多条上游调用历史（例如先请求 NewAPI 失败，再兜底火山生成）
      for (let i = 0; i < params.upstreamCalls.length; i++) {
        const rawCall = params.upstreamCalls[i];
        const cost = rawCall.incurredCostCny ?? rawCall.costCny ?? 0;
        const call: UpstreamCallRecord = {
          callIndex: rawCall.callIndex ?? i + 1,
          channelCode: rawCall.channelCode || rawCall.channelName,
          channelName: rawCall.channelName,
          model: rawCall.model || rawCall.modelName || 'unknown-model',
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
      // 场景 B：单次调用标准推导
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

    // 2. 落实充值赠送积分影响收入折算（有效每积分金额）
    const userPointsNetDeducted = params.userPointsPaid ?? 0;
    let effectiveCnyPerPoint: number;
    let revenueCalculationBasis: string;
    let rechargeBatchTraceable = false;

    if (params.rechargeBatch) {
      // A. 使用可追溯的明确充值记录
      const batch = params.rechargeBatch;
      const totalPoints = batch.totalPoints > 0 ? batch.totalPoints : (batch.basePoints + batch.giftPoints);
      effectiveCnyPerPoint = totalPoints > 0 ? (batch.amountCny / totalPoints) : FALLBACK_CNY_PER_POINT;
      rechargeBatchTraceable = true;
      revenueCalculationBasis = `可追溯充值批次折算: 实付充值 ¥${batch.amountCny} / 实际到账 ${totalPoints} 积分 (含赠送 ${batch.giftPoints})，有效单价 ¥${effectiveCnyPerPoint.toFixed(6)}/pt`;
    } else if (params.effectiveCnyPerPoint !== undefined && params.effectiveCnyPerPoint > 0) {
      // B. 直接传入可追溯折算单价
      effectiveCnyPerPoint = params.effectiveCnyPerPoint;
      rechargeBatchTraceable = true;
      revenueCalculationBasis = `指定有效积分单价: ¥${effectiveCnyPerPoint.toFixed(6)}/pt`;
    } else {
      // C. 积分来源不明：绝不擅自使用 10 积分/元！使用约 30 积分/元参考估算并明确标记
      effectiveCnyPerPoint = FALLBACK_CNY_PER_POINT;
      rechargeBatchTraceable = false;
      revenueCalculationBasis = `ESTIMATED_FALLBACK_30_PTS_PER_CNY (充值来源不明，按约30积分/元参考估算[单价约¥0.0333/pt]，非精确业务定价)`;
    }

    // 计算任务折算收入（元）
    const userRevenueCny = parseFloat((userPointsNetDeducted * effectiveCnyPerPoint).toFixed(4));

    // 3. 毛利与毛利率计算
    // 任务毛利 = 任务折算收入 - 供应商成本
    const estimatedGrossProfitCny = parseFloat((userRevenueCny - totalExpectedCostCny).toFixed(4));
    let estimatedGrossMarginPercent: number | undefined;
    let grossMarginLabel: string;

    if (userRevenueCny <= 0) {
      // 规则：任务折算收入为零时，毛利率标记不适用（N/A）；若仍发生供应商成本，体现负毛利
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

    // 4. 证据级别与外部对账偏差校验
    let evidenceLevel: SupplierEvidenceLevel = 'INTERNAL_ESTIMATED';
    let externalBillStatus: 'PENDING_SETTLEMENT' | 'RECONCILED' | 'NOT_AVAILABLE' = 'PENDING_SETTLEMENT';

    if (anyCallUnknown) {
      evidenceLevel = 'UNVERIFIED';
      reasons.push('上游消耗或执行状态存在未知记录；缺少明确凭证，严禁默认将供应商成本归零');
    }

    if (params.upstreamBillReceived && params.actualRecordedCostCny !== undefined) {
      evidenceLevel = 'BILL_RECONCILED';
      externalBillStatus = 'RECONCILED';
      // 核验实际外部账单记录与理论预期偏差
      const diff = Math.abs(params.actualRecordedCostCny - totalExpectedCostCny);
      if (diff > 0.005) {
        reasons.push(
          `供应商成本账单偏差: 预期成本 ¥${totalExpectedCostCny}, 实际账单记录 ¥${params.actualRecordedCostCny} (差额 ¥${diff.toFixed(4)})`
        );
      }
    } else if (!anyCallUnknown) {
      reasons.push('已完成平台内部供应商成本推导核算；外部供应商原始账单待归集（账单大盘异步归集）');
    }

    // 门禁判定：
    // 若要求严格验证（requireVerifiedEvidence）且证据等级为 UNVERIFIED，或出现账单偏差，则不予 PASS
    const hasDeviation = reasons.some((r) => r.includes('供应商成本账单偏差'));
    const isUnverified = anyCallUnknown || evidenceLevel === 'UNVERIFIED';
    let passed = true;
    let status: 'PASS' | 'FAIL' | 'BLOCKED' = 'PASS';

    const requireStrict = Boolean(params.requireVerifiedEvidence || params.requireVerifiedCostEvidence);
    if (hasDeviation) {
      passed = false;
      status = 'FAIL';
    } else if (isUnverified) {
      // 未知证据在严格模式下 BLOCKED，在常规模式下给出警示
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
}
