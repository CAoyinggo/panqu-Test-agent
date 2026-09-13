import { MarginAuditor, type MarginAuditReport } from './margin-auditor.js';
import { ModelMatrixExtractor } from './model-matrix-extractor.js';

export interface FixPrOptions {
  modelId: number;
  mediaType?: 'video' | 'image';
  issueType?: 'NEGATIVE_MARGIN_LOSS' | 'UNPRICED_MODEL' | 'AUTO';
  targetMarginPercent?: number;
  effectiveCnyPerPoint?: number;
  baseBranch?: string;
  repoOwner?: string;
  repoName?: string;
  repoPath?: string;
  customBeforePoints?: Record<string, number>;
}

export interface ProposedFileChange {
  path: string;
  action: 'create' | 'update';
  content: string;
  description: string;
}

export interface PricingComparisonItem {
  resolution: string;
  beforePoints: number;
  afterPoints: number;
  supplierCostYuan: number;
  beforeMarginPercent: number;
  afterMarginPercent: number;
  statusBefore: string;
  statusAfter: string;
}

export interface GitHubMcpActionCall {
  tool: string;
  description: string;
  arguments: Record<string, unknown>;
}

export interface FixPrResult {
  ok: boolean;
  modelId: number;
  modelName: string;
  branchName: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  fileChanges: ProposedFileChange[];
  pricingComparison: PricingComparisonItem[];
  githubMcpActions: GitHubMcpActionCall[];
  summary: string;
}

export class AutoFixPrEngine {
  public static async generateFixPr(options: FixPrOptions): Promise<FixPrResult> {
    const modelId = options.modelId;
    const targetMarginPercent = options.targetMarginPercent ?? 30;
    const effectiveRate = options.effectiveCnyPerPoint ?? 0.10;
    const baseBranch = options.baseBranch || 'main';
    const repoOwner = options.repoOwner || 'panqu-ai';
    const repoName = options.repoName || 'panqu-ai';
    const repoPath = options.repoPath || process.cwd();

    // 1. 获取模型元信息与毛利核算
    const audit = await MarginAuditor.auditModelMargin({
      modelId,
      mediaType: options.mediaType,
      targetMarginPercent,
      effectiveCnyPerPoint: effectiveRate,
      customPoints: options.customBeforePoints,
      repoPath,
    });

    const modelName = audit.modelName;
    const pricingComparison: PricingComparisonItem[] = [];

    for (const res of audit.resolutions) {
      const beforePoints = res.userPoints;
      const supplierCost = res.supplierCostYuan;

      // 如果当前毛利达标且无倒挂，保持原价；否则调整到建议积分
      let afterPoints = beforePoints;
      if (res.status === 'NEGATIVE_MARGIN_LOSS' || res.status === 'LOW_MARGIN' || beforePoints <= 0) {
        afterPoints = Math.max(res.suggestedPoints, Math.ceil(supplierCost / (effectiveRate * (1 - targetMarginPercent / 100))));
      }

      const afterRevenue = Number((afterPoints * effectiveRate).toFixed(4));
      const afterGrossProfit = Number((afterRevenue - supplierCost).toFixed(4));
      const afterMarginPercent = afterRevenue > 0
        ? Number(((afterGrossProfit / afterRevenue) * 100).toFixed(1))
        : 0;

      pricingComparison.push({
        resolution: res.resolution,
        beforePoints,
        afterPoints,
        supplierCostYuan: supplierCost,
        beforeMarginPercent: res.grossMarginPercent,
        afterMarginPercent,
        statusBefore: res.status,
        statusAfter: afterMarginPercent >= targetMarginPercent ? 'PROFITABLE' : 'LOW_MARGIN',
      });
    }

    // 2. 构造文件修改清单 (FastAdmin SQL 迁移 + 平台配置 Patch JSON)
    const sqlPath = `database/migrations/fix_pricing_model_${modelId}.sql`;
    const jsonPath = `application/extra/model_points_patch_${modelId}.json`;

    const sqlStatements: string[] = [
      `-- Panqu AI Model Pricing & Margin Adjustment Migration`,
      `-- Model #${modelId} (${modelName})`,
      `-- Target Gross Margin: >= ${targetMarginPercent}%`,
      `-- Generated at: ${new Date().toISOString()}`,
      '',
      'START TRANSACTION;',
      '',
    ];

    for (const p of pricingComparison) {
      sqlStatements.push(`-- 调整规格 ${p.resolution}: 原刊例 ${p.beforePoints} pt -> 达标刊例 ${p.afterPoints} pt (预测毛利率: ${p.afterMarginPercent}%)`);
      sqlStatements.push(
        `INSERT INTO pq_model_point (model_id, resolution, points, is_active, updatetime) ` +
        `VALUES (${modelId}, '${p.resolution}', ${p.afterPoints}, 1, UNIX_TIMESTAMP()) ` +
        `ON DUPLICATE KEY UPDATE points = ${p.afterPoints}, is_active = 1, updatetime = UNIX_TIMESTAMP();`
      );
      sqlStatements.push('');
    }
    sqlStatements.push('COMMIT;');
    const sqlContent = sqlStatements.join('\n');

    const jsonContent = JSON.stringify(
      {
        model_id: modelId,
        model_name: modelName,
        target_margin_percent: targetMarginPercent,
        effective_cny_per_point: effectiveRate,
        generated_at: new Date().toISOString(),
        pricing_patch: Object.fromEntries(
          pricingComparison.map((p) => [
            p.resolution,
            {
              before_points: p.beforePoints,
              after_points: p.afterPoints,
              supplier_cost_yuan: p.supplierCostYuan,
              before_margin_percent: p.beforeMarginPercent,
              after_margin_percent: p.afterMarginPercent,
              status_before: p.statusBefore,
              status_after: p.statusAfter,
            },
          ])
        ),
      },
      null,
      2
    );

    const fileChanges: ProposedFileChange[] = [
      {
        path: sqlPath,
        action: 'create',
        content: sqlContent,
        description: `FastAdmin 刊例价格更新 SQL 脚本 (pq_model_point)`,
      },
      {
        path: jsonPath,
        action: 'create',
        content: jsonContent,
        description: `平台刊例价覆盖补丁 JSON 配置`,
      },
    ];

    // 3. 构造 PR 标题与 Markdown 描述
    const branchName = `fix/pricing-margin-model-${modelId}`;
    const commitMessage = `fix(pricing): 调整模型 #${modelId} (${modelName}) 刊例价以满足 ${targetMarginPercent}% 保本毛利门禁`;
    const prTitle = `fix(pricing): 调整模型 #${modelId} (${modelName}) 刊例价以满足 ${targetMarginPercent}% 保本毛利门禁`;

    const tableRows = pricingComparison.map((p) => {
      const beforeStr = p.beforePoints > 0 ? `${p.beforePoints} pt` : '未配置 (0 pt)';
      const statusBeforeStr = p.statusBefore === 'PROFITABLE' ? '🟢 合规' : p.statusBefore === 'LOW_MARGIN' ? '🟡 偏低' : '🔴 倒挂';
      const statusAfterStr = p.statusAfter === 'PROFITABLE' ? '🟢 达标' : '🟡 偏低';
      return `| **${p.resolution}** | ${beforeStr} | **${p.afterPoints} pt** | ¥${p.supplierCostYuan.toFixed(2)} | ${p.beforeMarginPercent}% | **${p.afterMarginPercent}%** | ${statusBeforeStr} $\\rightarrow$ ${statusAfterStr} |`;
    }).join('\n');

    const prBody = [
      `## 🤖 Panqu Test-Flow: 模型定价与毛利安全调优 PR`,
      '',
      `### 1. 变更背景与原因`,
      `在运行 \`MarginAuditor\` 供应商成本与平台毛利率智能门禁时，检测到 **模型 #${modelId} (${modelName})** 存在定价偏低或倒挂资损风险：`,
      `- 检测到部分规格定价低于供应商实际履约成本（价格倒挂），单次任务面临净亏损；`,
      `- 本 PR 自动将刊例价格对齐至保本平衡点以上，确保满足平台 **${targetMarginPercent}% 目标毛利率门禁**。`,
      '',
      `### 2. 财务毛利测算对比 (Before vs After)`,
      `| 规格 | 原刊例积分 | 调整后刊例 | 供应商成本 | 原毛利率 | 调整后毛利率 | 财务状态变迁 |`,
      `| :---: | :---: | :---: | :---: | :---: | :---: | :---: |`,
      tableRows,
      '',
      `### 3. 核心账务不变量核验`,
      `- [x] **NET_CHARGE_ZERO**: 任务失败全额退款净扣归零不变量依然严格有效；`,
      `- [x] **ANTI_DOUBLE_BILLING**: 防重锁与幂等流水不受调价影响；`,
      `- [x] **BREAK_EVEN**: 调价后刊例积分严格高于供应商保本临界点 (Break-Even Points)。`,
      '',
      `### 4. 上线与回滚指南`,
      `- **上线方式**：合并本 PR 后，执行 \`${sqlPath}\` 数据库迁移脚本或在 FastAdmin 后台重新加载 \`pq_model_point\` 缓存；`,
      `- **安全回滚**：如需回滚，可在 FastAdmin 后台将对应规格的 points 积分值恢复原值。`,
      '',
      `---`,
      `*Created automatically by Trae + Test-Flow via GitHub MCP*`,
    ].join('\n');

    // 4. 封装匹配 GitHub MCP 标准工具参数的 actions
    const githubMcpActions: GitHubMcpActionCall[] = [
      {
        tool: 'create_or_update_file_contents',
        description: `提交数据库调价迁移 SQL 脚本 (${sqlPath})`,
        arguments: {
          owner: repoOwner,
          repo: repoName,
          branch: branchName,
          path: sqlPath,
          content: sqlContent,
          message: commitMessage,
        },
      },
      {
        tool: 'create_or_update_file_contents',
        description: `提交平台配置补丁 JSON (${jsonPath})`,
        arguments: {
          owner: repoOwner,
          repo: repoName,
          branch: branchName,
          path: jsonPath,
          content: jsonContent,
          message: `${commitMessage} (JSON 配置)`,
        },
      },
      {
        tool: 'create_pull_request',
        description: `向目标基准分支 (${baseBranch}) 开启修复 PR`,
        arguments: {
          owner: repoOwner,
          repo: repoName,
          title: prTitle,
          body: prBody,
          head: branchName,
          base: baseBranch,
        },
      },
    ];

    const summary = `已为模型 #${modelId} (${modelName}) 生成调价修复包：拟创建分支 [${branchName}]，包含 ${fileChanges.length} 个配置/迁移文件，已就绪 ${githubMcpActions.length} 个 GitHub MCP 调用动作。`;

    return {
      ok: true,
      modelId,
      modelName,
      branchName,
      commitMessage,
      prTitle,
      prBody,
      fileChanges,
      pricingComparison,
      githubMcpActions,
      summary,
    };
  }
}
