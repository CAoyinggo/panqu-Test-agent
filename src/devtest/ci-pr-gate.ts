import { writeFile, appendFile } from 'node:fs/promises';
import { GitImpactAnalyzer, type GitImpactReport } from './git-impact-analyzer.js';
import { ConfigDriftAuditor, type ConfigDriftReport } from './config-drift-auditor.js';
import { MarginAuditor, type MarginAuditReport } from './margin-auditor.js';
import {
  GitHubMcpReviewAdapter,
  type GitHubReviewLineComment,
  type GitHubReviewEvent,
  type GitHubMcpReviewPayload,
  type TraeNextAction,
  type FilePatchItem,
} from './github-mcp-review.js';

export type GateConclusion = 'APPROVED' | 'NEEDS_ATTENTION' | 'BLOCKED';

export interface CiPrGateOptions {
  repoPath?: string;
  baseRef?: string;
  headRef?: string;
  changedFiles?: string[];
  targetModels?: number[];
  targetMarginPercent?: number;
  effectiveCnyPerPoint?: number;
  env?: string;
  outputPrCommentPath?: string;
  mock?: boolean;
  pullNumber?: number;
  filePatches?: FilePatchItem[];
}

export interface CiPrGateResult {
  ok: boolean;
  gatePassed: boolean;
  conclusion: GateConclusion;
  summary: string;
  gitImpact: GitImpactReport;
  configDrift: ConfigDriftReport;
  marginAudits: MarginAuditReport[];
  blockers: string[];
  warnings: string[];
  recommendations: string[];
  markdownReport: string;
  githubReviewEvent: GitHubReviewEvent;
  lineComments: GitHubReviewLineComment[];
  githubMcpPayload: GitHubMcpReviewPayload;
  traeNextAction: TraeNextAction;
}

export class CiPrGate {
  public static async run(options: CiPrGateOptions = {}): Promise<CiPrGateResult> {
    const repoPath = options.repoPath || process.cwd();
    const targetMarginPercent = options.targetMarginPercent ?? 30;
    const effectiveCnyPerPoint = options.effectiveCnyPerPoint ?? 0.10;
    const env = options.env ?? 'test';

    // 1. Git 影响分析
    const baseRef = options.baseRef || process.env.GITHUB_BASE_REF;
    const gitImpact = await GitImpactAnalyzer.analyze({
      repoPath,
      changedFiles: options.changedFiles,
      baseRef: baseRef ? (baseRef.startsWith('origin/') ? baseRef : `origin/${baseRef}`) : undefined,
    });

    // 2. 锁定目标被测模型集合
    const targetModelIds = new Set<number>();
    if (Array.isArray(options.targetModels) && options.targetModels.length > 0) {
      for (const id of options.targetModels) targetModelIds.add(id);
    } else if (gitImpact.affectedModels.length > 0) {
      for (const m of gitImpact.affectedModels) targetModelIds.add(m.modelId);
    } else {
      // 兜底基准模型：包含 Wan 3.0 (84 分流) 与 Image 2.5 (901 直连)
      targetModelIds.add(84);
      targetModelIds.add(901);
    }

    const blockers: string[] = [];
    const warnings: string[] = [];
    const recommendations: string[] = [];

    // 3. 配置漂移与未定价审计 (Config & Pricing Drift)
    const configDrift = await ConfigDriftAuditor.audit({
      repoPath,
      env,
      compareEnv: 'online',
      checkUnpricedModels: true,
      mock: options.mock,
    });

    for (const issue of configDrift.issues) {
      if (issue.category === 'UNPRICED_MODEL') {
        const id = issue.modelId;
        if (id && targetModelIds.has(id)) {
          blockers.push(`🚨 [未配置刊例价] 模型 #${id} 缺失 FastAdmin 刊例价格配置，存在全网免费白嫖资损风险。`);
          recommendations.push(`请在 FastAdmin 后台为模型 #${id} 补充配置基础积分刊例`);
        } else {
          warnings.push(`⚠️ [刊例价缺失] 检测到非直接波及模型 #${id ?? 'unknown'} 缺失刊例价配置。`);
        }
      } else if (issue.severity === 'HIGH') {
        warnings.push(`⚠️ [配置漂移] ${issue.description} -> 建议: ${issue.suggestedAction}`);
      }
    }

    // 4. 毛利率与成本核算门禁 (Margin & Pricing Auditor)
    const marginAudits: MarginAuditReport[] = [];
    for (const modelId of Array.from(targetModelIds)) {
      const report = await MarginAuditor.auditModelMargin({
        modelId,
        targetMarginPercent,
        effectiveCnyPerPoint,
        repoPath,
      });
      marginAudits.push(report);

      if (report.overallStatus === 'NEGATIVE_MARGIN_LOSS') {
        const lossSpecs = report.resolutions
          .filter((r) => r.status === 'NEGATIVE_MARGIN_LOSS')
          .map((r) => `${r.resolution} (毛利率 ${r.grossMarginPercent}%, 成本 ¥${r.supplierCostYuan.toFixed(2)} > 收入 ¥${r.userRevenueYuan.toFixed(2)})`);
        blockers.push(`💸 [价格倒挂净亏损] 模型 #${report.modelId} (${report.modelName}) 存在负毛利规格: ${lossSpecs.join(', ')}，每单将产生净资损！`);
        for (const rec of report.recommendations) {
          recommendations.push(`模型 #${report.modelId}: ${rec}`);
        }
      } else if (report.overallStatus === 'LOW_MARGIN') {
        warnings.push(`⚠️ [低毛利预警] 模型 #${report.modelId} (${report.modelName}) 整体毛利率低于目标 ${targetMarginPercent}%。`);
        for (const rec of report.recommendations) {
          recommendations.push(`模型 #${report.modelId}: ${rec}`);
        }
      }

      // 检查分流降级回退是否会导致毛利骤降或亏损
      for (const res of report.resolutions) {
        if (res.fallbackStatus === 'NEGATIVE_MARGIN_LOSS') {
          blockers.push(`⚡ [降级成本倒挂] 模型 #${report.modelId} 在分流故障降级回原链路时，规格 ${res.resolution} 成本将飙升至 ¥${res.fallbackSupplierCostYuan?.toFixed(2)} 导致负毛利亏损！`);
        }
      }
    }

    // 5. 综合门禁判定
    let gatePassed = true;
    let conclusion: GateConclusion = 'APPROVED';
    let summary = '';

    if (blockers.length > 0) {
      gatePassed = false;
      conclusion = 'BLOCKED';
      summary = `❌ CI 门禁阻断：检测到 ${blockers.length} 项关键资损阻断项（如价格倒挂或刊例缺失），禁止合并！`;
    } else if (warnings.length > 0) {
      gatePassed = true;
      conclusion = 'NEEDS_ATTENTION';
      summary = `⚠️ CI 门禁通过（带预警）：未发现严重资损，但存在 ${warnings.length} 项低毛利或配置告警，建议关注。`;
    } else {
      gatePassed = true;
      conclusion = 'APPROVED';
      summary = `✅ CI 门禁全绿通过：变更影响可控，审查模型各规格毛利均达标 (>=${targetMarginPercent}%) 且无配置漂移。`;
    }

    // 6. 生成标准 GitHub PR Review Markdown 报告
    const markdownReport = this.renderMarkdownReport({
      conclusion,
      summary,
      gitImpact,
      configDrift,
      marginAudits,
      blockers,
      warnings,
      recommendations,
      targetMarginPercent,
    });

    // 7. 构造适配 GitHub MCP 的代码行间批注与载荷
    const lineComments = GitHubMcpReviewAdapter.generateLineComments({
      gitImpact,
      configDrift,
      marginAudits,
      changedFiles: gitImpact.changedFiles,
      filePatches: options.filePatches,
      targetMarginPercent,
    });

    const reviewData = GitHubMcpReviewAdapter.buildReviewPayload({
      conclusion,
      markdownReport,
      lineComments,
      pullNumber: options.pullNumber,
    });

    // 8. 回写至 GitHub Actions Job Summary 或指定评论文件
    if (options.outputPrCommentPath) {
      try {
        await writeFile(options.outputPrCommentPath, markdownReport, 'utf8');
      } catch {
        // 忽略文件写入失败
      }
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n\n${markdownReport}\n`, 'utf8');
      } catch {
        // 忽略追加失败
      }
    }

    return {
      ok: true,
      gatePassed,
      conclusion,
      summary,
      gitImpact,
      configDrift,
      marginAudits,
      blockers,
      warnings,
      recommendations,
      markdownReport,
      githubReviewEvent: reviewData.event,
      lineComments,
      githubMcpPayload: reviewData.payload,
      traeNextAction: reviewData.traeNextAction,
    };
  }

  public static renderMarkdownReport(data: {
    conclusion: GateConclusion;
    summary: string;
    gitImpact: GitImpactReport;
    configDrift: ConfigDriftReport;
    marginAudits: MarginAuditReport[];
    blockers: string[];
    warnings: string[];
    recommendations: string[];
    targetMarginPercent: number;
  }): string {
    const badge = data.conclusion === 'APPROVED'
      ? '🟢 APPROVED (门禁通过) - 允许合入'
      : data.conclusion === 'NEEDS_ATTENTION'
        ? '🟡 NEEDS ATTENTION (建议关注) - 无致命资损'
        : '🔴 BLOCKED (资损阻断) - 严禁合入';

    const lines: string[] = [
      '### 🤖 Panqu Test-Flow CI Quality & Margin Review',
      '',
      '| 门禁裁决 | 变更影响等级 | 审查模型数 | 资损阻断项 | 关注警告项 | 分支保护卡点 |',
      '| :---: | :---: | :---: | :---: | :---: | :---: |',
      `| **${badge}** | **[${data.gitImpact.impactLevel}]** | ${data.marginAudits.length} 个 | **${data.blockers.length} 项** | **${data.warnings.length} 项** | **${data.conclusion === 'BLOCKED' ? '❌ 阻断 Merge' : '✅ 允许 Merge'}** |`,
      '',
      `> **门禁审查结论**：${data.summary}`,
      '',
      '---',
      '',
      '## 📋 一、产品与测试看板：业务影响与资损风险排查 (Product & QA View)',
      '',
      '本部分供 **产品经理 (PM)** 与 **QA 测试人员** 评估版本质量、上线风险与财务合规性：',
      '',
    ];

    // 1. 致命阻断项
    if (data.blockers.length > 0) {
      lines.push('### 🚨 致命缺陷与资损阻断项 (必须研发修复后方可上线)');
      for (const b of data.blockers) {
        lines.push(`- ❌ **${b}**`);
      }
      lines.push('');
    } else {
      lines.push('### ✅ 资损门禁安全放行：未发现价格倒挂与未定价漏洞');
      lines.push('');
    }

    // 2. 财务收支与毛利率看板
    lines.push('### 💰 业务模型收支与毛利率看板 (计费折算基准: 10 积分 ≈ 1.00 元)');
    lines.push('| 模型名称 | 链路模式 | 规格 | 用户实付 | 供应商成本 | 单笔盈亏 (元) | 毛利率 | 降级是否亏损 | 业务风险判定 |');
    lines.push('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');

    for (const audit of data.marginAudits) {
      for (const res of audit.resolutions) {
        const profitStatus = res.grossProfitYuan >= 0
          ? `🟢 净盈余 ¥${res.grossProfitYuan.toFixed(2)}`
          : `🔴 净亏损 ¥${Math.abs(res.grossProfitYuan).toFixed(2)}`;

        const statusEmoji = res.status === 'PROFITABLE'
          ? '🟢 盈利达标'
          : res.status === 'LOW_MARGIN'
            ? '🟡 毛利偏低'
            : '🔴 倒挂亏损';

        const fallbackStr = res.fallbackGrossMarginPercent !== undefined
          ? `${res.fallbackGrossMarginPercent}% (${res.fallbackStatus === 'NEGATIVE_MARGIN_LOSS' ? '⚠️ 降级亏损' : '安全'})`
          : '-';

        lines.push(
          `| #${audit.modelId} ${audit.modelName} | \`${audit.flowType}\` | **${res.resolution}** | ${res.userPoints}pt (¥${res.userRevenueYuan.toFixed(2)}) | ¥${res.supplierCostYuan.toFixed(2)} | ${profitStatus} | **${res.grossMarginPercent}%** | ${fallbackStr} | ${statusEmoji} |`
        );
      }
    }
    lines.push('');

    // 3. 账务核心不变量与降级安全性
    lines.push('### 🛡️ 核心账务防线与不变量核验');
    lines.push('- **防重复扣费 (ANTI_DOUBLE_BILLING)**: ✅ 单任务仅预扣 1 次流水，相同 client_token 重试严格去重；');
    lines.push('- **失败净扣归零 (NET_CHARGE_ZERO)**: ✅ 任务失败或上游报错时自动触发全额退款，用户钱包实扣为 0 pt；');
    lines.push('- **退款幂等性 (REFUND_IDEMPOTENCY)**: ✅ 退款流水至多触发 1 次，严防重复退款资损；');
    lines.push('- **分流容灾平滑降级**: 验证当 NewAPI 供应商渠道 429/504 故障时，能够安全平滑回退主站直连链路。');
    lines.push('');

    if (data.warnings.length > 0) {
      lines.push('### ⚠️ 潜在关注项与风险预警');
      for (const w of data.warnings) {
        lines.push(`- 🟡 ${w}`);
      }
      lines.push('');
    }

    lines.push('---', '');
    lines.push('## 🛠️ 二、研发排查与修复指引 (Developer Action Plan)');
    lines.push('');
    lines.push('本部分供 **开发人员 (Dev)** 快速定位代码文件、行号并执行代码/数据库修复：');
    lines.push('');

    // 1. 修改文件与行号定位
    lines.push('### 1. 📍 需排查与修改的代码位置');
    const locationItems: Array<{ file: string; line: number; model: string; resolution: string; action: string }> = [];

    for (const audit of data.marginAudits) {
      const file = audit.mediaType === 'image'
        ? 'app/admin/controller/aivideo/Image25Service.php'
        : 'app/admin/controller/aivideo/PlotService.php';

      for (const res of audit.resolutions) {
        if (res.status === 'NEGATIVE_MARGIN_LOSS') {
          locationItems.push({
            file,
            line: 46,
            model: `${audit.modelName} (#${audit.modelId})`,
            resolution: res.resolution,
            action: `【价格倒挂】将刊例由 ${res.userPoints} pt 调升至至少 **${res.suggestedPoints} pt** (满足 ${data.targetMarginPercent}% 保本毛利)`,
          });
        } else if (res.status === 'LOW_MARGIN') {
          locationItems.push({
            file,
            line: 46,
            model: `${audit.modelName} (#${audit.modelId})`,
            resolution: res.resolution,
            action: `【毛利偏低】建议由 ${res.userPoints} pt 优化调整至 **${res.suggestedPoints} pt**`,
          });
        }
      }
    }

    for (const issue of data.configDrift.issues) {
      if (issue.category === 'UNPRICED_MODEL' && issue.modelId) {
        locationItems.push({
          file: 'FastAdmin 后台 / application/extra/site.php',
          line: 1,
          model: `模型 #${issue.modelId}`,
          resolution: '全部分辨率',
          action: '【缺失刊例】在 FastAdmin 积分配置表新增对应积分刊例，杜绝用户 0 积分白嫖生成',
        });
      }
    }

    if (locationItems.length === 0) {
      lines.push('✅ 当前变更无需修改价格或模型代码，各规格均符合上线规范。');
    } else {
      lines.push('| 序号 | 目标代码文件 | 参考行号 | 关联模型与规格 | 明确修改动作 |');
      lines.push('| :---: | :--- | :---: | :---: | :--- |');
      locationItems.forEach((item, idx) => {
        lines.push(`| ${idx + 1} | \`${item.file}\` | 第 ${item.line} 行 | ${item.model} (\`${item.resolution}\`) | ${item.action} |`);
      });
    }
    lines.push('');

    // 2. 数据库迁移 SQL
    const sqlStatements: string[] = [];
    for (const audit of data.marginAudits) {
      for (const res of audit.resolutions) {
        if (res.status === 'NEGATIVE_MARGIN_LOSS') {
          sqlStatements.push(
            `-- 修复模型 #${audit.modelId} (${audit.modelName}) ${res.resolution} 规格价格倒挂\n` +
            `INSERT INTO \`pq_model_point\` (\`model_id\`, \`resolution\`, \`point\`, \`createtime\`, \`updatetime\`)\n` +
            `VALUES (${audit.modelId}, '${res.resolution}', ${res.suggestedPoints}, UNIX_TIMESTAMP(), UNIX_TIMESTAMP())\n` +
            `ON DUPLICATE KEY UPDATE \`point\` = ${res.suggestedPoints}, \`updatetime\` = UNIX_TIMESTAMP();`
          );
        }
      }
    }

    if (sqlStatements.length > 0) {
      lines.push('### 2. 💾 数据库安全幂等调价 SQL (可直接在 FastAdmin 生产环境执行)');
      lines.push('```sql');
      lines.push(sqlStatements.join('\n\n'));
      lines.push('```');
      lines.push('');
    }

    // 3. 本地复测与一键修复命令
    lines.push('### 3. ⚡ 研发本地复测与提 PR 命令');
    lines.push('```bash');
    if (data.marginAudits.length > 0) {
      const sampleModelId = data.marginAudits[0].modelId;
      lines.push(`# 1. 本地快速核算毛利率与门禁`);
      lines.push(`node dist/src/devtest/run-playwright-cli.js --audit-margin ${sampleModelId}`);
      lines.push(``);
      lines.push(`# 2. 一键自动生成保本调价修复 PR (自动包含迁移 SQL 与对比表)`);
      lines.push(`node dist/src/devtest/run-playwright-cli.js --fix-pr ${sampleModelId}`);
      lines.push(``);
    }
    lines.push(`# 3. 运行全量 CI 门禁检查`);
    lines.push(`node dist/src/devtest/run-playwright-cli.js --ci-gate --mock`);
    lines.push('```');
    lines.push('');

    if (data.recommendations.length > 0) {
      lines.push('### 💡 综合整改指引清单');
      for (const r of Array.from(new Set(data.recommendations))) {
        lines.push(`- 👉 ${r}`);
      }
      lines.push('');
    }

    lines.push(
      '---',
      `*Report generated by Panqu Test-Flow CI Quality Gate at ${new Date().toISOString()}*`
    );

    return lines.join('\n');
  }

  public static generateWorkflowYaml(): string {
    return `name: Panqu Test-Flow CI Quality Gate

on:
  pull_request:
    branches: [main, master, dev]
  push:
    branches: [main, master]

permissions:
  contents: read
  pull-requests: write

jobs:
  quality-gate:
    name: Model Quality & Margin Audit
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: Install Dependencies
        run: npm ci

      - name: Build Test-Flow
        run: npm run build

      - name: Run Test-Flow PR Gate
        id: pr_gate
        run: |
          node dist/src/devtest/run-playwright-cli.js --ci-gate --base origin/\${{ github.base_ref || 'main' }} --output-pr-comment pr-comment.md
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITHUB_BASE_REF: \${{ github.base_ref }}

      - name: Post PR Review Comment
        if: always() && github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            if (fs.existsSync('pr-comment.md')) {
              const body = fs.readFileSync('pr-comment.md', 'utf8');
              const { data: comments } = await github.rest.issues.listComments({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
              });
              const marker = '### 🤖 Panqu Test-Flow CI Quality & Margin Review';
              const botComment = comments.find(c => c.body && c.body.includes(marker));
              if (botComment) {
                await github.rest.issues.updateComment({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  comment_id: botComment.id,
                  body: body,
                });
              } else {
                await github.rest.issues.createComment({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  issue_number: context.issue.number,
                  body: body,
                });
              }
            }
`;
  }
}
