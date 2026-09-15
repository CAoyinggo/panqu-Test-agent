import type { GateConclusion } from './ci-pr-gate.js';
import type { MarginAuditReport } from './margin-auditor.js';
import type { ConfigDriftReport } from './config-drift-auditor.js';
import type { GitImpactReport } from './git-impact-analyzer.js';
import { GitHubMcpReviewAdapter, type FilePatchItem } from './github-mcp-review.js';

export type CheckAnnotationLevel = 'notice' | 'warning' | 'failure';

export interface GitHubCheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: CheckAnnotationLevel;
  title: string;
  message: string;
  raw_details?: string;
}

export interface GitHubCheckRunOutput {
  title: string;
  summary: string;
  text?: string;
  annotations: GitHubCheckRunAnnotation[];
}

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed';
export type CheckRunConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped';

export interface GitHubCheckRunPayload {
  name: string;
  head_sha: string;
  status: CheckRunStatus;
  conclusion: CheckRunConclusion;
  started_at?: string;
  completed_at?: string;
  output: GitHubCheckRunOutput;
}

export interface GitHubCommitStatusPayload {
  state: 'success' | 'failure' | 'pending';
  context: string;
  description: string;
  target_url?: string;
}

export interface GitHubMcpActionItem {
  tool: string;
  description: string;
  arguments: Record<string, unknown>;
}

export interface CheckRunGenerationInput {
  headSha: string;
  pullNumber?: number;
  repoOwner?: string;
  repoName?: string;
  checkName?: string;
  conclusion: GateConclusion;
  markdownReport: string;
  gitImpact: GitImpactReport;
  configDrift: ConfigDriftReport;
  marginAudits: MarginAuditReport[];
  changedFiles: string[];
  filePatches?: FilePatchItem[];
  targetMarginPercent?: number;
}

export interface CheckRunGenerationResult {
  conclusion: CheckRunConclusion;
  checkRunPayload: GitHubCheckRunPayload;
  commitStatusPayload: GitHubCommitStatusPayload;
  annotationsCount: {
    total: number;
    failure: number;
    warning: number;
    notice: number;
  };
  githubMcpActions: GitHubMcpActionItem[];
  summaryMarkdown: string;
}

export class GitHubCheckRunAdapter {
  public static readonly DEFAULT_CHECK_NAME = 'test-flow/quality-and-margin-gate';
  public static readonly DEFAULT_CONTEXT = 'test-flow/quality-gate';

  /**
   * 生成代码行级 Annotations 数组
   */
  public static generateAnnotations(input: {
    gitImpact: GitImpactReport;
    configDrift: ConfigDriftReport;
    marginAudits: MarginAuditReport[];
    changedFiles: string[];
    filePatches?: FilePatchItem[];
    targetMarginPercent?: number;
  }): GitHubCheckRunAnnotation[] {
    const annotations: GitHubCheckRunAnnotation[] = [];
    const targetMargin = input.targetMarginPercent ?? 30;

    // 建立 patch 映射
    const patchMap = new Map<string, FilePatchItem>();
    if (Array.isArray(input.filePatches)) {
      for (const p of input.filePatches) {
        if (p && p.filename) patchMap.set(p.filename, p);
      }
    }

    const locateLine = (filePattern: RegExp, keywords: string[]): { path: string; line: number } | undefined => {
      for (const [filename, patchItem] of patchMap.entries()) {
        if (filePattern.test(filename) && patchItem.patch) {
          const addedLines = GitHubMcpReviewAdapter.parseAddedLinesFromPatch(patchItem.patch);
          if (addedLines.length > 0) {
            for (const kw of keywords) {
              const matched = addedLines.find((al) => al.content.toLowerCase().includes(kw.toLowerCase()));
              if (matched) return { path: filename, line: matched.line };
            }
            // No keyword evidence: preserve an unknown location.
          }
        }
      }

      // 严格无猜测：若没有 Patch 增量代码行，严禁回退到 line: 1 或默认控制器！
      return undefined;
    };

    // 1. 价格倒挂与毛利过低 Annotations
    for (const audit of input.marginAudits) {
      const filePattern = audit.mediaType === 'image'
        ? /Image25|ImageService/i
        : /PlotService|Videonew|VideoService|ModelDiversion/i;

      for (const res of audit.resolutions) {
        if (res.status === 'NEGATIVE_MARGIN_LOSS') {
          const location = locateLine(filePattern, [res.resolution, String(audit.modelId), 'resolution']);
          if (location) {
            annotations.push({
              path: location.path,
              start_line: location.line,
              end_line: location.line,
              annotation_level: 'failure',
              title: `资损阻断: 价格倒挂 (需研发提价至 ${res.suggestedPoints} pt)`,
              message: [
                `🔴【产品/测试业务风险】模型 #${audit.modelId} (${audit.modelName}) 规格 \`${res.resolution}\` 发生严重价格倒挂！`,
                `  - 用户实付折算: ¥${res.userRevenueYuan.toFixed(2)} (${res.userPoints} pt)`,
                `  - 供应商成本:   ¥${res.supplierCostYuan.toFixed(2)}`,
                `  - 单笔净亏损额: ¥${Math.abs(res.grossProfitYuan).toFixed(2)} (毛利率: ${res.grossMarginPercent}%)`,
                `🛠️【研发修改指引】文件: ${location.path} (第 ${location.line} 行)`,
                `  - 请将刊例由 ${res.userPoints} pt 提价至至少 ${res.suggestedPoints} pt (保本毛利率 >= ${targetMargin}%)。`,
                `💾【数据库修复 SQL】`,
                `  INSERT INTO \`pq_model_point\` (\`model_id\`, \`resolution\`, \`point\`, \`createtime\`, \`updatetime\`) VALUES (${audit.modelId}, '${res.resolution}', ${res.suggestedPoints}, UNIX_TIMESTAMP(), UNIX_TIMESTAMP()) ON DUPLICATE KEY UPDATE \`point\` = ${res.suggestedPoints}, \`updatetime\` = UNIX_TIMESTAMP();`,
              ].join('\n'),
              raw_details: JSON.stringify(res),
            });
          }
        } else if (res.status === 'LOW_MARGIN') {
          const location = locateLine(filePattern, [res.resolution, String(audit.modelId), 'resolution']);
          if (location) {
            annotations.push({
              path: location.path,
              start_line: location.line,
              end_line: location.line,
              annotation_level: 'warning',
              title: `毛利关注: 低于基准 (Low Margin)`,
              message: [
                `🟡【产品/运营关注】模型 #${audit.modelId} 规格 \`${res.resolution}\` 毛利率为 ${res.grossMarginPercent}%，低于基准 ${targetMargin}%。`,
                `🛠️【研发修改建议】建议将刊例积分由 ${res.userPoints} pt 优化调整至 ${res.suggestedPoints} pt。`,
              ].join('\n'),
              raw_details: JSON.stringify(res),
            });
          }
        }

        // 降级倒挂
        if (res.fallbackStatus === 'NEGATIVE_MARGIN_LOSS') {
          const location = locateLine(/ModelDiversion|RouteGroup/i, [String(audit.modelId), 'diversion']);
          if (location) {
            annotations.push({
              path: location.path,
              start_line: location.line,
              end_line: location.line,
              annotation_level: 'warning',
              title: `容灾风险: 降级资损 (Fallback Loss)`,
              message: [
                `⚡【产品/测试关注】模型 #${audit.modelId} 发生分流降级回原主站直连时，规格 \`${res.resolution}\` 供应商成本为 ¥${res.fallbackSupplierCostYuan?.toFixed(2)}，产生负毛利亏损！`,
                `🛠️【研发修改建议】请核验渠道兜底配置与分流准入白名单。`,
              ].join('\n'),
            });
          }
        }
      }
    }

    // 2. 缺失刊例价白嫖 Annotations (UNPRICED_MODEL)
    for (const issue of input.configDrift.issues) {
      if (issue.category === 'UNPRICED_MODEL' && issue.modelId) {
        const location = locateLine(/Image25|ModelConfig|PlotService|ModelDiversion/i, [String(issue.modelId), 'model']);
        if (location) {
          annotations.push({
            path: location.path,
            start_line: location.line,
            end_line: location.line,
            annotation_level: 'failure',
            title: `资损阻断: 缺失刊例价 (用户免费白嫖漏洞)`,
            message: [
              `🚨【产品/测试业务风险】检测到代码已接入模型 #${issue.modelId}，但 FastAdmin 后台缺失对应积分刊例配置！`,
              `  - 漏洞隐患: 用户上线后将可以 0 积分免费白嫖生成，直接消耗平台付费采购的供应商额度。`,
              `🛠️【研发修改指引】文件: FastAdmin 数据库 \`pq_model_point\` 表`,
              `  - 请在 FastAdmin 后台 [模型管理 -> 积分刊例配置] 中为模型 #${issue.modelId} 新增定价记录后再提交合并。`,
            ].join('\n'),
            raw_details: JSON.stringify(issue),
          });
        }
      }
    }

    return annotations;
  }

  /**
   * 构建完整的 Check Run 载荷与 GitHub MCP 调用操作
   */
  public static buildCheckRunResult(input: CheckRunGenerationInput): CheckRunGenerationResult {
    const checkName = input.checkName || this.DEFAULT_CHECK_NAME;
    const annotations = this.generateAnnotations({
      gitImpact: input.gitImpact,
      configDrift: input.configDrift,
      marginAudits: input.marginAudits,
      changedFiles: input.changedFiles,
      filePatches: input.filePatches,
      targetMarginPercent: input.targetMarginPercent,
    });

    const failureCount = annotations.filter((a) => a.annotation_level === 'failure').length;
    const warningCount = annotations.filter((a) => a.annotation_level === 'warning').length;
    const noticeCount = annotations.filter((a) => a.annotation_level === 'notice').length;

    const unlocatedBlockers: string[] = [];
    for (const audit of input.marginAudits) {
      for (const res of audit.resolutions) {
        if (res.status === 'NEGATIVE_MARGIN_LOSS') {
          const hasAnno = annotations.some((a) => a.raw_details && a.raw_details.includes(res.resolution) && a.raw_details.includes(String(audit.modelId)));
          if (!hasAnno) {
            unlocatedBlockers.push(`- **[价格倒挂资损]** 模型 #${audit.modelId} (${audit.modelName}) 规格 \`${res.resolution}\` (单笔净亏 ¥${Math.abs(res.grossProfitYuan).toFixed(2)}) | \`file: null, line: null, symbol: null, locationStatus: 'UNKNOWN'\` *(当前 PR 变更集未修改该模型定价代码，未生成行级 Annotation，请参见 Summary 指引修复)*`);
          }
        }
      }
    }
    for (const issue of input.configDrift.issues) {
      if (issue.category === 'UNPRICED_MODEL') {
        const hasAnno = annotations.some((a) => a.title.includes('缺失刊例价') && a.message.includes(`#${issue.modelId}`));
        if (!hasAnno) {
          unlocatedBlockers.push(`- **[缺失刊例白嫖漏洞]** 模型 #${issue.modelId} 未定价 | \`file: null, line: null, symbol: null, locationStatus: 'UNKNOWN'\` *(FastAdmin 数据库刊例缺失，非代码改动，请在后台补齐)*`);
        }
      }
    }

    const totalBlockerCount = failureCount + unlocatedBlockers.length;

    // 映射结论：BLOCKED -> failure, NEEDS_ATTENTION -> neutral, APPROVED -> success
    const conclusion: CheckRunConclusion = input.conclusion === 'BLOCKED'
      ? 'failure'
      : input.conclusion === 'NEEDS_ATTENTION'
        ? 'neutral'
        : 'success';

    let outputTitle = '';
    if (conclusion === 'failure') {
      outputTitle = `BLOCKED: 发现 ${totalBlockerCount} 项资损阻断缺陷 (价格倒挂/白嫖漏洞，需研发调价修复)`;
    } else if (conclusion === 'neutral') {
      outputTitle = `NEEDS_ATTENTION: 发现 ${warningCount} 项低毛利或降级风险需关注 (无致命阻断)`;
    } else {
      outputTitle = `SUCCESS: 本次已执行的检查通过；未执行门禁不计为通过`;
    }

    let checkRunSummary = input.markdownReport;
    if (unlocatedBlockers.length > 0) {
      checkRunSummary += `\n\n### ⚠️ 未定位到代码行的审查项 (未生成行级 Annotation)\n${unlocatedBlockers.join('\n')}\n`;
    }

    const checkRunPayload: GitHubCheckRunPayload = {
      name: checkName,
      head_sha: input.headSha,
      status: 'completed',
      conclusion,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      output: {
        title: outputTitle,
        summary: checkRunSummary,
        annotations,
      },
    };

    // Commit Status API 备选载荷
    const commitStatusState = conclusion === 'failure' ? 'failure' : 'success';
    const commitStatusDescription = conclusion === 'failure'
      ? `Gate BLOCKED: ${totalBlockerCount} 阻断项 (毛利倒挂/未定价)`
      : `Gate PASSED: 本次已执行的检查通过`;

    const commitStatusPayload: GitHubCommitStatusPayload = {
      state: commitStatusState,
      context: this.DEFAULT_CONTEXT,
      description: commitStatusDescription,
    };

    // 组装适配 GitHub MCP 的 actions
    const githubMcpActions: GitHubMcpActionItem[] = [
      {
        tool: 'create_check_run',
        description: '【首选】使用 GitHub MCP 直接调用此工具在 GitHub PR 上报原生 Checks 状态与代码 Annotations',
        arguments: {
          owner: input.repoOwner,
          repo: input.repoName,
          name: checkName,
          head_sha: input.headSha,
          status: 'completed',
          conclusion,
          output: {
            title: outputTitle,
            summary: input.markdownReport,
            annotations,
          },
        },
      },
      {
        tool: 'create_commit_status',
        description: '【备选/降级】若 GitHub Token 权限受限缺少 checks:write，使用此工具回写 Commit 状态',
        arguments: {
          owner: input.repoOwner,
          repo: input.repoName,
          sha: input.headSha,
          state: commitStatusState,
          context: this.DEFAULT_CONTEXT,
          description: commitStatusDescription,
        },
      },
    ];

    const summaryMarkdown = [
      `### 🛡️ Test-Flow GitHub Check Run 原生门禁载荷已生成`,
      `- **Check Name**: \`${checkName}\``,
      `- **Head SHA**: \`${input.headSha}\``,
      `- **Gate Conclusion**: \`${conclusion.toUpperCase()}\``,
      `- **Annotations 统计**: 总计 **${annotations.length}** 处（❌ Failure: ${failureCount}，⚠️ Warning: ${warningCount}，ℹ️ Notice: ${noticeCount}）`,
      `- **分支保护 (Branch Protection)**: ${conclusion === 'failure' ? '❌ **阻断合入 (Merge Blocked)**' : '✅ **允许合入 (Merge Allowed)**'}`,
    ].join('\n');

    return {
      conclusion,
      checkRunPayload,
      commitStatusPayload,
      annotationsCount: {
        total: annotations.length,
        failure: failureCount,
        warning: warningCount,
        notice: noticeCount,
      },
      githubMcpActions,
      summaryMarkdown,
    };
  }
}
