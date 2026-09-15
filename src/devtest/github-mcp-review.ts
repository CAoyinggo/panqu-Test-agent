import type { GateConclusion } from './ci-pr-gate.js';
import type { MarginAuditReport } from './margin-auditor.js';
import type { ConfigDriftReport } from './config-drift-auditor.js';
import type { GitImpactReport } from './git-impact-analyzer.js';

export interface GitHubReviewLineComment {
  path: string;
  line: number;
  side: 'RIGHT' | 'LEFT';
  body: string;
}

export type GitHubReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface GitHubMcpReviewPayload {
  pull_number?: number;
  event: GitHubReviewEvent;
  body: string;
  comments: GitHubReviewLineComment[];
}

export interface TraeNextAction {
  tool: string;
  description: string;
  arguments: Record<string, unknown>;
}

export interface FilePatchItem {
  filename: string;
  patch?: string;
  status?: string;
}

export interface PatchAddedLine {
  line: number;
  content: string;
}

export class GitHubMcpReviewAdapter {
  /**
   * 从 Unified Diff Patch 中解析出所有新增/修改行的行号与内容 (side: RIGHT)
   */
  public static parseAddedLinesFromPatch(patch: string): PatchAddedLine[] {
    const result: PatchAddedLine[] = [];
    if (!patch || typeof patch !== 'string') return result;

    const lines = patch.split('\n');
    let currentNewLine = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        currentNewLine = parseInt(hunkMatch[1], 10);
        continue;
      }
      if (currentNewLine === 0) continue;

      if (line.startsWith('+') && !line.startsWith('+++')) {
        result.push({ line: currentNewLine, content: line.slice(1) });
        currentNewLine++;
      } else if (line.startsWith(' ')) {
        currentNewLine++;
      }
      // '-' deleted line does not advance currentNewLine
    }

    return result;
  }

  /**
   * 根据门禁审核明细与变更文件/Patches 生成代码行间评论 (Line Comments)
   */
  public static generateLineComments(input: {
    gitImpact: GitImpactReport;
    configDrift: ConfigDriftReport;
    marginAudits: MarginAuditReport[];
    changedFiles: string[];
    filePatches?: FilePatchItem[];
    targetMarginPercent?: number;
  }): GitHubReviewLineComment[] {
    const comments: GitHubReviewLineComment[] = [];
    const targetMargin = input.targetMarginPercent ?? 30;

    // 建立文件名到 patch 对象的映射
    const patchMap = new Map<string, FilePatchItem>();
    if (Array.isArray(input.filePatches)) {
      for (const p of input.filePatches) {
        if (p && p.filename) patchMap.set(p.filename, p);
      }
    }

    // 辅助函数：在文件中寻找最贴切的代码行号
    const locateLine = (filePattern: RegExp, keywords: string[]): { path: string; line: number } | undefined => {
      // 1. 优先在 filePatches 中找
      for (const [filename, patchItem] of patchMap.entries()) {
        if (filePattern.test(filename) && patchItem.patch) {
          const addedLines = this.parseAddedLinesFromPatch(patchItem.patch);
          if (addedLines.length > 0) {
            // 尝试命中包含关键字的行
            for (const kw of keywords) {
              const matched = addedLines.find((al) => al.content.toLowerCase().includes(kw.toLowerCase()));
              if (matched) return { path: filename, line: matched.line };
            }
            return { path: filename, line: addedLines[0].line };
          }
        }
      }

      // 严格无猜测：若没有 Patch 增量修改行，严禁在未修改的代码或第 1 行发表行间评论 (避免 GitHub API 422 报错)
      return undefined;
    };

    // 1. 价格倒挂与毛利过低批注 (Margin Loss / Low Margin)
    for (const audit of input.marginAudits) {
      const filePattern = audit.mediaType === 'image'
        ? /Image25|ImageService/i
        : /PlotService|Videonew|VideoService|ModelDiversion/i;

      for (const res of audit.resolutions) {
        if (res.status === 'NEGATIVE_MARGIN_LOSS') {
          const location = locateLine(filePattern, [res.resolution, String(audit.modelId), 'resolution']);
          if (location) {
            comments.push({
              path: location.path,
              line: location.line,
              side: 'RIGHT',
              body: [
                `💸 **[门禁阻断: 价格倒挂资损]**`,
                `🔴 **【产品/测试风险】** 模型 #${audit.modelId} (${audit.modelName}) 规格 \`${res.resolution}\` 供应商成本为 **¥${res.supplierCostYuan.toFixed(2)}**，而刊例折算收入仅为 **¥${res.userRevenueYuan.toFixed(2)}**，单笔净亏损 **¥${Math.abs(res.grossProfitYuan).toFixed(2)}**（毛利率: **${res.grossMarginPercent}%**）！`,
                `🛠️ **【研发怎么改】** 请修改当前文件或执行调价迁移脚本，将 \`${res.resolution}\` 刊例积分由 ${res.userPoints} pt 调升至至少 **${res.suggestedPoints} pt** (以达到平台 ${targetMargin}% 保本毛利率门禁)。`,
                `💾 **【数据库迁移 SQL】**`,
                `\`\`\`sql`,
                `INSERT INTO \`pq_model_point\` (\`model_id\`, \`resolution\`, \`point\`, \`createtime\`, \`updatetime\`)`,
                `VALUES (${audit.modelId}, '${res.resolution}', ${res.suggestedPoints}, UNIX_TIMESTAMP(), UNIX_TIMESTAMP())`,
                `ON DUPLICATE KEY UPDATE \`point\` = ${res.suggestedPoints}, \`updatetime\` = UNIX_TIMESTAMP();`,
                `\`\`\``,
              ].join('\n'),
            });
          }
        } else if (res.status === 'LOW_MARGIN') {
          const location = locateLine(filePattern, [res.resolution, String(audit.modelId), 'resolution']);
          if (location) {
            comments.push({
              path: location.path,
              line: location.line,
              side: 'RIGHT',
              body: [
                `⚠️ **[毛利关注: 低于基准]**`,
                `🟡 **【产品/运营关注】** 模型 #${audit.modelId} (${audit.modelName}) 规格 \`${res.resolution}\` 当前毛利率为 **${res.grossMarginPercent}%**，低于基准线 **${targetMargin}%**。`,
                `🛠️ **【研发修改建议】** 建议将刊例积分由 ${res.userPoints} pt 优化调整至 **${res.suggestedPoints} pt**。`,
              ].join('\n'),
            });
          }
        }

        // 降级导致倒挂
        if (res.fallbackStatus === 'NEGATIVE_MARGIN_LOSS') {
          const location = locateLine(/ModelDiversion|RouteGroup/i, [String(audit.modelId), 'diversion']);
          if (location) {
            comments.push({
              path: location.path,
              line: location.line,
              side: 'RIGHT',
              body: [
                `⚡ **[降级资损风险]**`,
                `🔴 **【产品/测试风险】** 模型 #${audit.modelId} 发生分流故障回退主站直连时，规格 \`${res.resolution}\` 供应商原价成本高达 **¥${res.fallbackSupplierCostYuan?.toFixed(2)}**，产生负毛利亏损！`,
                `🛠️ **【研发排查指引】** 请核验主站直连供应商渠道与分流准入白名单兜底逻辑。`,
              ].join('\n'),
            });
          }
        }
      }
    }

    // 2. 未配置刊例价白嫖批注 (UNPRICED_MODEL)
    for (const issue of input.configDrift.issues) {
      if (issue.category === 'UNPRICED_MODEL' && issue.modelId) {
        const location = locateLine(/Image25|ModelConfig|PlotService|ModelDiversion/i, [String(issue.modelId), 'model']);
        if (location) {
          comments.push({
            path: location.path,
            line: location.line,
            side: 'RIGHT',
            body: [
              `🚨 **[门禁阻断: 缺失刊例价]**`,
              `🔴 **【产品/测试风险】** 检测到代码中已引入或修改模型 #${issue.modelId}，但 FastAdmin 后台缺失对应积分刊例配置！上线后用户将免费白嫖生图/生视频（0 积分生成）！`,
              `🛠️ **【研发修改指引】** 请在 FastAdmin 后台 [模型积分配置] 表中为模型 #${issue.modelId} 补充定价记录后再提交合并。`,
            ].join('\n'),
          });
        }
      }
    }

    // 3. 核心计费安全批注 (Score.php / 核心扣费逻辑修改)
    const scoreFile = input.changedFiles.find((f) => /Score\.php/i.test(f));
    if (scoreFile) {
      const location = locateLine(/Score\.php/i, ['function', 'score', 'deduct']);
      comments.push({
        path: location ? location.path : scoreFile,
        line: location ? location.line : 1,
        side: 'RIGHT',
        body: [
          `🛡️ **[账务安全合规防线]**`,
          `ℹ️ **【产品/测试确认】** 检测到核心积分账单流水代码变动。请确保严格遵循四大资损不变量：`,
          `1. **ANTI_DOUBLE_BILLING**（防重复扣费：单任务仅预扣 1 次流水）`,
          `2. **NET_CHARGE_ZERO**（失败净扣归零：任务失败必须全额退款）`,
          `3. **REFUND_IDEMPOTENCY**（退款幂等：退款至多执行 1 次）`,
          `4. **BREAK_EVEN**（保本结算：避免结算倒挂）。`,
        ].join('\n'),
      });
    }

    return comments;
  }

  /**
   * 构造适配 GitHub MCP create_pull_request_review 工具的完整参数包
   */
  public static buildReviewPayload(input: {
    conclusion: GateConclusion;
    markdownReport: string;
    lineComments: GitHubReviewLineComment[];
    pullNumber?: number;
  }): {
    event: GitHubReviewEvent;
    payload: GitHubMcpReviewPayload;
    traeNextAction: TraeNextAction;
  } {
    const event: GitHubReviewEvent = input.conclusion === 'BLOCKED'
      ? 'REQUEST_CHANGES'
      : input.conclusion === 'NEEDS_ATTENTION'
        ? 'COMMENT'
        : 'APPROVE';

    const payload: GitHubMcpReviewPayload = {
      pull_number: input.pullNumber,
      event,
      body: input.markdownReport,
      comments: input.lineComments,
    };

    const actionArgs: Record<string, unknown> = {
      event,
      body: input.markdownReport,
      comments: input.lineComments,
    };
    if (typeof input.pullNumber === 'number') {
      actionArgs.pull_number = input.pullNumber;
    }

    const traeNextAction: TraeNextAction = {
      tool: 'create_pull_request_review',
      description: '请使用 GitHub MCP 直接调用此工具向 GitHub PR 提交正式审查决定与代码行间批注',
      arguments: actionArgs,
    };

    return {
      event,
      payload,
      traeNextAction,
    };
  }
}
