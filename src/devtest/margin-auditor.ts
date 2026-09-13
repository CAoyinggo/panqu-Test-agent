import { BillingOracle } from './billing-oracle.js';
import { SupplierCostOracle } from './supplier-cost-oracle.js';
import { ModelMatrixExtractor } from './model-matrix-extractor.js';

export type MarginStatus = 'PROFITABLE' | 'LOW_MARGIN' | 'NEGATIVE_MARGIN_LOSS';

export interface ResolutionMarginDetail {
  resolution: string;
  durationSeconds?: number;
  userPoints: number;
  effectiveCnyPerPoint: number;
  userRevenueYuan: number;
  supplierCostYuan: number;
  grossProfitYuan: number;
  grossMarginPercent: number;
  breakEvenPoints: number;
  suggestedPoints: number;
  status: MarginStatus;
  fallbackSupplierCostYuan?: number;
  fallbackGrossMarginPercent?: number;
  fallbackStatus?: MarginStatus;
  pricingBasis: string;
}

export interface MarginAuditOptions {
  modelId: number;
  mediaType?: 'video' | 'image';
  duration?: number;
  effectiveCnyPerPoint?: number;
  targetMarginPercent?: number;
  resolutions?: string[];
  customPoints?: Record<string, number>;
  repoPath?: string;
}

export interface MarginAuditReport {
  ok: boolean;
  gatePassed: boolean;
  modelId: number;
  modelName: string;
  mediaType: 'video' | 'image';
  flowType: 'DIRECT' | 'DIVERSION';
  targetMarginPercent: number;
  overallStatus: MarginStatus;
  resolutions: ResolutionMarginDetail[];
  blockers: string[];
  recommendations: string[];
  summary: string;
}

export class MarginAuditor {
  public static async auditModelMargin(options: MarginAuditOptions): Promise<MarginAuditReport> {
    const modelId = options.modelId;
    const targetMargin = options.targetMarginPercent ?? 30;
    const effectiveRate = options.effectiveCnyPerPoint ?? 0.10; // 默认 10 积分 = 1 元
    const duration = options.duration ?? 4;

    // 逆向获取模型基础信息
    let modelName = `Model #${modelId}`;
    let flowType: 'DIRECT' | 'DIVERSION' = 'DIVERSION';
    let mediaType: 'video' | 'image' = options.mediaType ?? 'video';
    let testResolutions: string[] = options.resolutions || [];

    try {
      const spec = await ModelMatrixExtractor.extractModel(modelId, options.repoPath);
      if (spec) {
        modelName = spec.modelName;
        flowType = spec.flowType;
        if (!options.mediaType) mediaType = spec.mediaType;
        if (testResolutions.length === 0) {
          testResolutions = spec.supportedResolutions.slice(0, 5);
        }
      }
    } catch {
      // 容错使用默认
    }

    if (testResolutions.length === 0) {
      testResolutions = mediaType === 'video' ? ['480p', '720p', '1080p'] : ['1k', '2k'];
    }

    const details: ResolutionMarginDetail[] = [];
    const blockers: string[] = [];
    const recommendations: string[] = [];

    for (const res of testResolutions) {
      // 1. 用户侧积分与折算收入
      let userPoints = options.customPoints?.[res];
      if (userPoints === undefined) {
        userPoints = BillingOracle.calculateExpectedPoints({
          mediaType,
          modelId,
          duration,
          resolution: res,
        });
      }

      const userRevenueYuan = Number((userPoints * effectiveRate).toFixed(4));

      // 2. 供应商正向渠道成本 (NewAPI Line 10)
      const newapiCost = SupplierCostOracle.calculateSingleCallCost({
        mediaType,
        modelId,
        duration,
        resolution: res,
        line: 10,
        terminalStatus: 'SUCCESS',
      });
      const supplierCostYuan = Number(newapiCost.expectedCostCny.toFixed(4));

      // 3. 毛利计算
      const grossProfitYuan = Number((userRevenueYuan - supplierCostYuan).toFixed(4));
      const grossMarginPercent = userRevenueYuan > 0
        ? Number(((grossProfitYuan / userRevenueYuan) * 100).toFixed(2))
        : -100;

      // 4. 保本临界点与目标毛利建议积分
      const breakEvenPoints = Math.ceil(supplierCostYuan / effectiveRate);
      const targetRatio = Math.max(0.01, 1 - targetMargin / 100);
      const suggestedPoints = Math.ceil(supplierCostYuan / (targetRatio * effectiveRate));

      // 5. 状态判定
      let status: MarginStatus = 'PROFITABLE';
      if (grossProfitYuan < 0) {
        status = 'NEGATIVE_MARGIN_LOSS';
        blockers.push(`[${res}] 规格发生价格倒挂！收入 ¥${userRevenueYuan} < 成本 ¥${supplierCostYuan}，每单净亏损 ¥${Math.abs(grossProfitYuan)}`);
        recommendations.push(`建议将 [${res}] 定价从 ${userPoints} pt 上调至至少 ${suggestedPoints} pt (保本需 ${breakEvenPoints} pt)`);
      } else if (grossMarginPercent < targetMargin) {
        status = 'LOW_MARGIN';
        recommendations.push(`[${res}] 当前毛利率为 ${grossMarginPercent}%，低于目标 ${targetMargin}%。建议定价调整至 ${suggestedPoints} pt`);
      }

      // 6. 分流降级至原直连链路敏感度测算 (Line 0 Direct)
      let fallbackCostYuan: number | undefined;
      let fallbackMarginPercent: number | undefined;
      let fallbackStatus: MarginStatus | undefined;

      if (flowType === 'DIVERSION') {
        const directCost = SupplierCostOracle.calculateSingleCallCost({
          mediaType,
          modelId,
          duration,
          resolution: res,
          line: 0,
          terminalStatus: 'SUCCESS',
        });
        fallbackCostYuan = Number((directCost.expectedCostCny * 1.15).toFixed(4)); // 直连无批发折扣通常高约 15%
        const fallbackProfit = Number((userRevenueYuan - fallbackCostYuan).toFixed(4));
        fallbackMarginPercent = userRevenueYuan > 0
          ? Number(((fallbackProfit / userRevenueYuan) * 100).toFixed(2))
          : -100;

        if (fallbackProfit < 0) {
          fallbackStatus = 'NEGATIVE_MARGIN_LOSS';
          recommendations.push(`[${res}] 若 NewAPI 故障降级回原链路，毛利将倒挂亏损 (降级毛利率: ${fallbackMarginPercent}%)`);
        } else if (fallbackMarginPercent < targetMargin) {
          fallbackStatus = 'LOW_MARGIN';
        } else {
          fallbackStatus = 'PROFITABLE';
        }
      }

      details.push({
        resolution: res,
        durationSeconds: mediaType === 'video' ? duration : undefined,
        userPoints,
        effectiveCnyPerPoint: effectiveRate,
        userRevenueYuan,
        supplierCostYuan,
        grossProfitYuan,
        grossMarginPercent,
        breakEvenPoints,
        suggestedPoints,
        status,
        fallbackSupplierCostYuan: fallbackCostYuan,
        fallbackGrossMarginPercent: fallbackMarginPercent,
        fallbackStatus,
        pricingBasis: newapiCost.pricingBasis,
      });
    }

    // 综合判定
    let overallStatus: MarginStatus = 'PROFITABLE';
    if (details.some((d) => d.status === 'NEGATIVE_MARGIN_LOSS')) {
      overallStatus = 'NEGATIVE_MARGIN_LOSS';
    } else if (details.some((d) => d.status === 'LOW_MARGIN')) {
      overallStatus = 'LOW_MARGIN';
    }

    const gatePassed = overallStatus !== 'NEGATIVE_MARGIN_LOSS';
    const summary = gatePassed
      ? `模型 [${modelName}#${modelId}] 全规格毛利测算通过，综合毛利状态: [${overallStatus}]。最低毛利率: ${Math.min(...details.map((d) => d.grossMarginPercent))}%。`
      : `模型 [${modelName}#${modelId}] 触发价格倒挂门禁阻断！存在 ${blockers.length} 项规格每单产生亏损，需前置调价。`;

    return {
      ok: true,
      gatePassed,
      modelId,
      modelName,
      mediaType,
      flowType,
      targetMarginPercent: targetMargin,
      overallStatus,
      resolutions: details,
      blockers,
      recommendations,
      summary,
    };
  }

  public static async auditAllModelsMargin(repoPath?: string): Promise<Record<number, MarginAuditReport>> {
    const all = await ModelMatrixExtractor.extractAll(repoPath);
    const results: Record<number, MarginAuditReport> = {};

    for (const idStr of Object.keys(all)) {
      const id = Number(idStr);
      results[id] = await this.auditModelMargin({ modelId: id, repoPath });
    }

    return results;
  }
}
