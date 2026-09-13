import { describe, it, expect } from 'vitest';
import { AutoFixPrEngine } from '../../../src/devtest/auto-fix-pr.js';

describe('AutoFixPrEngine (资损与毛利优化一键提 PR 闭环)', () => {
  it('1. 针对基准模型生成完整提 PR 载荷与 SQL 迁移脚本', async () => {
    const result = await AutoFixPrEngine.generateFixPr({
      modelId: 84,
      targetMarginPercent: 30,
      baseBranch: 'main',
      repoOwner: 'panqu-ai',
      repoName: 'panqu-ai',
    });

    expect(result.ok).toBe(true);
    expect(result.modelId).toBe(84);
    expect(result.modelName).toContain('Wan 3.0');
    expect(result.branchName).toBe('fix/pricing-margin-model-84');
    expect(result.prTitle).toContain('调整模型 #84');
    expect(result.prBody).toContain('Before vs After');
    expect(result.prBody).toContain('NET_CHARGE_ZERO');
    expect(result.prBody).toContain('ANTI_DOUBLE_BILLING');

    // 验证文件变更 (SQL + JSON)
    expect(result.fileChanges.length).toBe(2);
    const sqlChange = result.fileChanges.find((f) => f.path.endsWith('.sql'));
    expect(sqlChange).toBeDefined();
    expect(sqlChange?.content).toContain('START TRANSACTION;');
    expect(sqlChange?.content).toContain('INSERT INTO pq_model_point');
    expect(sqlChange?.content).toContain('ON DUPLICATE KEY UPDATE');
    expect(sqlChange?.content).toContain('COMMIT;');

    const jsonChange = result.fileChanges.find((f) => f.path.endsWith('.json'));
    expect(jsonChange).toBeDefined();
    expect(jsonChange?.content).toContain('pricing_patch');

    // 验证 GitHub MCP Actions 列表
    expect(result.githubMcpActions.length).toBe(3);
    const fileAction = result.githubMcpActions[0];
    expect(fileAction.tool).toBe('create_or_update_file_contents');
    expect(fileAction.arguments.owner).toBe('panqu-ai');
    expect(fileAction.arguments.branch).toBe('fix/pricing-margin-model-84');

    const prAction = result.githubMcpActions[2];
    expect(prAction.tool).toBe('create_pull_request');
    expect(prAction.arguments.head).toBe('fix/pricing-margin-model-84');
    expect(prAction.arguments.base).toBe('main');
  });

  it('2. 针对价格倒挂规格，自动调整至达标保本建议积分 (42 pt)', async () => {
    const result = await AutoFixPrEngine.generateFixPr({
      modelId: 84,
      targetMarginPercent: 30,
      effectiveCnyPerPoint: 0.10,
      customBeforePoints: {
        '1080p': 10, // 故意传入 10pt (倒挂亏损)
      },
    });

    expect(result.ok).toBe(true);
    const item1080 = result.pricingComparison.find((p) => p.resolution === '1080p');
    expect(item1080).toBeDefined();
    expect(item1080?.beforePoints).toBe(10);
    expect(item1080?.statusBefore).toBe('NEGATIVE_MARGIN_LOSS');
    expect(item1080?.beforeMarginPercent).toBeLessThan(0);

    // 调整后必须保本且达到 30% 目标毛利率
    expect(item1080?.afterPoints).toBeGreaterThanOrEqual(42);
    expect(item1080?.afterMarginPercent).toBeGreaterThanOrEqual(30);
    expect(item1080?.statusAfter).toBe('PROFITABLE');

    // 验证 SQL 中写入了 42+ pt
    const sqlChange = result.fileChanges.find((f) => f.path.endsWith('.sql'));
    expect(sqlChange?.content).toContain(`'1080p', ${item1080?.afterPoints}`);
  });
});
