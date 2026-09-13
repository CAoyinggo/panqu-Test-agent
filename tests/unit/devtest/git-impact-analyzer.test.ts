import { describe, expect, it } from 'vitest';
import { GitImpactAnalyzer } from '../../../src/devtest/git-impact-analyzer.js';

describe('GitImpactAnalyzer - Git 改动增量模型影响分析器', () => {
  it('当改动 Image25Service 时，精准锁定 901/902 图片直连模型与规格矩阵场景', async () => {
    const report = await GitImpactAnalyzer.analyze({
      changedFiles: [
        'aibaseos/application/admin/service/Image25Service.php',
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.impactLevel).toBe('MEDIUM');
    expect(report.affectedModels.some((m) => m.modelId === 901 && m.flowType === 'DIRECT')).toBe(true);
    expect(report.affectedModels.some((m) => m.modelId === 902 && m.flowType === 'DIRECT')).toBe(true);
    expect(report.recommendedScenarios).toContain('DIRECT_SPEC_MATRIX');
    expect(report.suggestedTestCommands.some((c) => c.includes('--flow direct') && c.includes('--model 901'))).toBe(true);
  });

  it('当改动分流规则配置表时，精准锁定分流模型与路由组隔离场景', async () => {
    const report = await GitImpactAnalyzer.analyze({
      changedFiles: [
        'aibaseos/application/admin/model/aiVideo/ModelDiversion.php',
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.impactLevel).toBe('HIGH');
    expect(report.affectedModels.some((m) => m.modelId === 84 && m.flowType === 'DIVERSION')).toBe(true);
    expect(report.recommendedScenarios).toContain('ROUTING_DIVERSION');
    expect(report.recommendedScenarios).toContain('PERMISSION_ISOLATION');
    expect(report.suggestedTestCommands.some((c) => c.includes('--flow diversion') && c.includes('--model 84'))).toBe(true);
  });

  it('当改动底层积分扣费与财务核心时，标记为 CRITICAL 资损风险并触发全量对账', async () => {
    const report = await GitImpactAnalyzer.analyze({
      changedFiles: [
        'aibaseos/application/common/model/Score.php',
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.impactLevel).toBe('CRITICAL');
    expect(report.recommendedScenarios).toContain('BILLING_RECONCILIATION');
    expect(report.recommendedScenarios).toContain('FAILURE_REFUND');
    expect(report.recommendedScenarios).toContain('RETRY_IDEMPOTENCY');
  });

  it('未检测到代码改动时输出 NONE 等级且无需回归', async () => {
    const report = await GitImpactAnalyzer.analyze({
      changedFiles: [],
    });

    expect(report.ok).toBe(true);
    expect(report.impactLevel).toBe('NONE');
    expect(report.affectedModels.length).toBe(0);
    expect(report.suggestedTestCommands.length).toBe(0);
  });
});
