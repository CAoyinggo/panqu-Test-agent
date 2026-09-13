import { describe, expect, it } from 'vitest';
import { MarginAuditor } from '../../../src/devtest/margin-auditor.js';

describe('MarginAuditor - 供应商成本与平台毛利率核算门禁', () => {
  it('Wan 3.0 默认刊例价下：480p/720p/1080p 全规格毛利健康 (>70%)，门禁通过', async () => {
    const report = await MarginAuditor.auditModelMargin({
      modelId: 84,
      mediaType: 'video',
      duration: 4,
      targetMarginPercent: 30,
    });

    expect(report.ok).toBe(true);
    expect(report.gatePassed).toBe(true);
    expect(report.overallStatus).toBe('PROFITABLE');
    expect(report.modelName).toBe('Wan 3.0');
    expect(report.resolutions.length).toBeGreaterThanOrEqual(3);

    const res720 = report.resolutions.find((r) => r.resolution === '720p');
    expect(res720).toBeDefined();
    expect(res720?.userPoints).toBe(56);
    expect(res720?.userRevenueYuan).toBe(5.6);
    expect(res720?.supplierCostYuan).toBe(1.44); // 0.36 * 4
    expect(res720?.grossProfitYuan).toBe(4.16);
    expect(res720?.grossMarginPercent).toBeGreaterThan(70);
    expect(res720?.status).toBe('PROFITABLE');

    // 验证分流降级敏感度
    expect(res720?.fallbackSupplierCostYuan).toBeDefined();
    expect(res720?.fallbackGrossMarginPercent).toBeDefined();
    expect(res720?.fallbackStatus).toBe('PROFITABLE');
  });

  it('当故意调低定价引发价格倒挂时：严密拦截门禁，标记 NEGATIVE_MARGIN_LOSS 并给出保本与目标提价点', async () => {
    const report = await MarginAuditor.auditModelMargin({
      modelId: 84,
      mediaType: 'video',
      duration: 4,
      customPoints: {
        '720p': 10, // 10 pt = 1.00 元，而成本 1.44 元，亏损 0.44 元
      },
      targetMarginPercent: 30,
    });

    expect(report.ok).toBe(true);
    expect(report.gatePassed).toBe(false);
    expect(report.overallStatus).toBe('NEGATIVE_MARGIN_LOSS');
    expect(report.blockers.length).toBeGreaterThan(0);
    expect(report.blockers[0]).toContain('价格倒挂');

    const res720 = report.resolutions.find((r) => r.resolution === '720p');
    expect(res720?.grossProfitYuan).toBeLessThan(0);
    expect(res720?.status).toBe('NEGATIVE_MARGIN_LOSS');
    // 保本点需 15 pt (1.44 / 0.1)
    expect(res720?.breakEvenPoints).toBe(15);
    // 目标 30% 毛利需 21 pt (1.44 / 0.07)
    expect(res720?.suggestedPoints).toBe(21);
    expect(report.recommendations.some((rec) => rec.includes('21 pt'))).toBe(true);
  });

  it('当毛利率低于目标值但未倒挂时：标记为 LOW_MARGIN 给出调价优化建议，门禁不阻断', async () => {
    const report = await MarginAuditor.auditModelMargin({
      modelId: 84,
      mediaType: 'video',
      duration: 4,
      customPoints: {
        '720p': 18, // 18 pt = 1.80 元，成本 1.44 元，毛利 0.36 元 (20% < 30%)
      },
      targetMarginPercent: 30,
    });

    expect(report.ok).toBe(true);
    expect(report.gatePassed).toBe(true);
    expect(report.overallStatus).toBe('LOW_MARGIN');
    expect(report.blockers.length).toBe(0);
    expect(report.recommendations.some((rec) => rec.includes('低于目标'))).toBe(true);
  });
});
