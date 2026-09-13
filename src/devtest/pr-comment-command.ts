import { CiPrGate, type GateConclusion, type CiPrGateResult } from './ci-pr-gate.js';
import { AutoFixPrEngine, type FixPrResult, type GitHubMcpActionCall } from './auto-fix-pr.js';
import { MarginAuditor, type MarginAuditReport } from './margin-auditor.js';
import { GitHubCheckRunAdapter } from './github-check-run.js';
import type { FilePatchItem } from './github-mcp-review.js';

export type PrCommandType = 'RETEST' | 'FIX' | 'AUDIT' | 'HELP' | 'UNKNOWN' | 'NONE';

export interface ParsedPrCommand {
  type: PrCommandType;
  rawCommand: string;
  commandName: string;
  modelId?: number;
  targetMarginPercent?: number;
  commentAuthor: string;
  pullNumber: number;
  repoOwner: string;
  repoName: string;
  headSha?: string;
  arguments: string[];
}

export interface PrCommandInput {
  commentBody: string;
  commentAuthor?: string;
  pullNumber?: number;
  headSha?: string;
  repoOwner?: string;
  repoName?: string;
  targetMarginPercent?: number;
  changedFiles?: string[];
  filePatches?: FilePatchItem[];
  mock?: boolean;
}

export interface PrCommandExecutionResult {
  ok: boolean;
  type: PrCommandType;
  command: ParsedPrCommand;
  summary: string;
  replyMarkdown: string;
  githubMcpActions: GitHubMcpActionCall[];
  gateResult?: CiPrGateResult;
  fixResult?: FixPrResult;
  auditResult?: MarginAuditReport;
}

export class PrCommentCommandHandler {
  /**
   * 解析 PR 评论正文中的斜杠指令 (Slash Commands)
   */
  public static parse(input: PrCommandInput): ParsedPrCommand {
    const rawBody = (input.commentBody || '').trim();
    const commentAuthor = input.commentAuthor || 'developer';
    const pullNumber = input.pullNumber || 0;
    const repoOwner = input.repoOwner || 'panqu-ai';
    const repoName = input.repoName || 'panqu-ai';
    const headSha = input.headSha || 'mock-head-sha';

    // 匹配正则：支持 @bot /command [args...] 或起始 /command [args...]
    // 如：@panqu-bot /retest, /fix 84, /audit 84, /fix-margin 84 --margin=35
    const cmdRegex = /(?:@[\w.-]+\s+)?\/([a-zA-Z0-9_-]+)(?:\s+([^\n\r]+))?/i;
    const match = rawBody.match(cmdRegex);

    if (!match) {
      return {
        type: 'NONE',
        rawCommand: rawBody,
        commandName: '',
        commentAuthor,
        pullNumber,
        repoOwner,
        repoName,
        headSha,
        arguments: [],
      };
    }

    const commandName = match[1].toLowerCase();
    const rawArgs = match[2] ? match[2].trim().split(/\s+/) : [];
    const args = rawArgs.map((a) => a.trim()).filter(Boolean);

    let type: PrCommandType = 'UNKNOWN';
    let modelId: number | undefined;
    let targetMarginPercent = input.targetMarginPercent;

    // 解析参数中的数字作为 modelId，或者 --margin=XX / -m XX
    for (const arg of args) {
      if (/^\d+$/.test(arg)) {
        modelId = parseInt(arg, 10);
      } else if (/^--margin=(\d+)$/i.test(arg)) {
        const m = arg.match(/^--margin=(\d+)$/i);
        if (m) targetMarginPercent = parseInt(m[1], 10);
      }
    }

    switch (commandName) {
      case 'retest':
      case 'check':
      case 'gate':
      case 'ci':
      case 'test':
        type = 'RETEST';
        break;
      case 'fix':
      case 'fix-margin':
      case 'fix-pr':
      case 'autofix':
        type = 'FIX';
        break;
      case 'audit':
      case 'margin':
      case 'pricing':
        type = 'AUDIT';
        break;
      case 'help':
      case 'commands':
      case '?':
        type = 'HELP';
        break;
      default:
        type = 'UNKNOWN';
        break;
    }

    return {
      type,
      rawCommand: match[0],
      commandName,
      modelId,
      targetMarginPercent,
      commentAuthor,
      pullNumber,
      repoOwner,
      repoName,
      headSha,
      arguments: args,
    };
  }

  /**
   * 执行指令并生成对应的 PR 回复与 GitHub MCP 调用动作
   */
  public static async execute(input: PrCommandInput): Promise<PrCommandExecutionResult> {
    const parsed = this.parse(input);
    const pullNumber = parsed.pullNumber;
    const repoOwner = parsed.repoOwner;
    const repoName = parsed.repoName;
    const authorTag = `@${parsed.commentAuthor}`;

    switch (parsed.type) {
      case 'RETEST': {
        // 1. 触发 CI PR Gate 执行
        const gateResult = await CiPrGate.run({
          pullNumber: parsed.pullNumber,
          changedFiles: input.changedFiles,
          filePatches: input.filePatches,
          targetMarginPercent: parsed.targetMarginPercent,
          mock: input.mock,
        });

        // 2. 构建 Check Run 原生载荷
        const checkRunResult = GitHubCheckRunAdapter.buildCheckRunResult({
          headSha: parsed.headSha || 'mock-head-sha',
          repoOwner,
          repoName,
          pullNumber,
          conclusion: gateResult.conclusion,
          markdownReport: gateResult.markdownReport,
          gitImpact: gateResult.gitImpact,
          configDrift: gateResult.configDrift,
          marginAudits: gateResult.marginAudits,
          changedFiles: gateResult.gitImpact.changedFiles,
          filePatches: input.filePatches,
          targetMarginPercent: parsed.targetMarginPercent,
        });

        // 3. 生成通俗易懂的 Issue Comment 回复 Markdown
        const replyLines: string[] = [
          `### 🤖 Panqu Test-Flow 门禁复测回执 (${authorTag})`,
          '',
          `已响应您在 PR #${pullNumber} 发布的 \`${parsed.rawCommand}\` 复测指令，审查结论如下：`,
          '',
          `| 门禁最终裁决 | 分支保护卡点 | 审查模型数 | 资损阻断项 | 关注警告项 |`,
          `| :---: | :---: | :---: | :---: | :---: |`,
          `| **${gateResult.conclusion === 'APPROVED' ? '🟢 APPROVED (门禁通过)' : '🔴 BLOCKED (资损阻断)'}** | **${gateResult.conclusion === 'APPROVED' ? '✅ 放行 Merge' : '❌ 阻断 Merge'}** | ${gateResult.marginAudits.length} 个 | **${gateResult.blockers.length} 项** | **${gateResult.warnings.length} 项** |`,
          '',
          `> **审查结论**：${gateResult.summary}`,
          '',
        ];

        if (gateResult.blockers.length > 0) {
          replyLines.push(
            '#### 📋 产品与测试看板：资损风险',
            ...gateResult.blockers.map((b) => `- ❌ **${b}**`),
            '',
            '#### 🛠️ 研发修改指引',
            '- 可直接回复 `@panqu-bot /fix` 自动生成保本调价分支并开启修复 PR；',
            '- 或本地执行调价复测：`node dist/src/devtest/run-playwright-cli.js --ci-gate`。',
            ''
          );
        } else {
          replyLines.push(
            '#### ✅ 门禁全部通过',
            '- 未发现价格倒挂或刊例缺失漏洞；',
            '- 核心账务防线（防双扣、失败全额退款、退款幂等）校验通过，满足上线合规标准。',
            ''
          );
        }

        replyLines.push(
          '---',
          `*Action triggered via Trae & GitHub MCP • Check Run: [${checkRunResult.checkRunPayload.name}](https://github.com/${repoOwner}/${repoName}/runs) • ${new Date().toISOString()}*`
        );

        const replyMarkdown = replyLines.join('\n');

        // 4. 组装 GitHub MCP 动作链：先上报 Check Run，再回复 Issue Comment
        const actions: GitHubMcpActionCall[] = [
          ...checkRunResult.githubMcpActions,
          {
            tool: 'create_issue_comment',
            description: `在 PR #${pullNumber} 评论区回复门禁复测结论`,
            arguments: {
              owner: repoOwner,
              repo: repoName,
              issue_number: pullNumber,
              body: replyMarkdown,
            },
          },
        ];

        return {
          ok: true,
          type: 'RETEST',
          command: parsed,
          summary: `已成功完成 PR #${pullNumber} 门禁复测：结论为 [${gateResult.conclusion}]，准备上报 Check Run 并回复评论。`,
          replyMarkdown,
          githubMcpActions: actions,
          gateResult,
        };
      }

      case 'FIX': {
        const targetModelId = parsed.modelId ?? 84;
        const targetMargin = parsed.targetMarginPercent ?? 30;

        // 1. 生成调价修复包
        const fixResult = await AutoFixPrEngine.generateFixPr({
          modelId: targetModelId,
          targetMarginPercent: targetMargin,
          repoOwner,
          repoName,
          baseBranch: 'main',
        });

        // 2. 组装回复 Markdown
        const replyLines: string[] = [
          `### 🛠️ Panqu Test-Flow 资损调价修复包已生成 (${authorTag})`,
          '',
          `已响应您在 PR #${pullNumber} 发布的 \`${parsed.rawCommand}\` 调价修复指令：`,
          '',
          `| 目标模型 | 拟建分支 | 目标毛利率 | 拟提交文件数 | 后续动作 |`,
          `| :---: | :---: | :---: | :---: | :---: |`,
          `| **${fixResult.modelName} (#${targetModelId})** | \`${fixResult.branchName}\` | **${targetMargin}%** | ${fixResult.fileChanges.length} 个 | **开启独立修复 PR** |`,
          '',
          '#### 📋 产品与测试看板：调价前后收支对比',
          '| 规格 | 原刊例 | 拟调刊例 | 供应商成本 | 原毛利率 | 调后毛利率 | 状态判定 |',
          '| :--- | :---: | :---: | :---: | :---: | :---: | :---: |',
        ];

        for (const item of fixResult.pricingComparison) {
          replyLines.push(
            `| **${item.resolution}** | ${item.beforePoints} pt | **${item.afterPoints} pt** | ¥${item.supplierCostYuan.toFixed(2)} | ${item.beforeMarginPercent.toFixed(1)}% | **${item.afterMarginPercent.toFixed(1)}%** | ${item.statusAfter === 'PROFITABLE' ? '🟢 保本达标' : '🟡 观察'} |`
          );
        }

        replyLines.push(
          '',
          '#### 🛠️ 研发排查与 FastAdmin 安全调价 SQL',
          '可直接在 FastAdmin 生产数据库执行以下幂等迁移脚本：',
          '```sql',
          fixResult.fileChanges.find((f) => f.path.endsWith('.sql'))?.content || `-- 调价 SQL 就绪`,
          '```',
          '',
          '---',
          `*Auto-Fix generated via Trae & GitHub MCP • 分支 \`${fixResult.branchName}\` 将通过 GitHub MCP 自动创建 • ${new Date().toISOString()}*`
        );

        const replyMarkdown = replyLines.join('\n');

        // 3. 组装 GitHub MCP 动作链：先提交文件/开PR，再在当前 PR 回复说明
        const actions: GitHubMcpActionCall[] = [
          ...fixResult.githubMcpActions,
          {
            tool: 'create_issue_comment',
            description: `在 PR #${pullNumber} 评论区告知调价修复包已生成并附带对比表`,
            arguments: {
              owner: repoOwner,
              repo: repoName,
              issue_number: pullNumber,
              body: replyMarkdown,
            },
          },
        ];

        return {
          ok: true,
          type: 'FIX',
          command: parsed,
          summary: `已为模型 #${targetModelId} 生成保本调价修复方案，包含 ${fixResult.fileChanges.length} 个变更文件与对应 GitHub MCP 提交动作。`,
          replyMarkdown,
          githubMcpActions: actions,
          fixResult,
        };
      }

      case 'AUDIT': {
        const targetModelId = parsed.modelId ?? 84;
        const targetMargin = parsed.targetMarginPercent ?? 30;

        // 1. 单独核算毛利率
        const auditResult = await MarginAuditor.auditModelMargin({
          modelId: targetModelId,
          targetMarginPercent: targetMargin,
        });

        // 2. 组装看板回复
        const replyLines: string[] = [
          `### 💰 Panqu Test-Flow 模型收支与毛利率看板 (${authorTag})`,
          '',
          `已响应您在 PR #${pullNumber} 发布的 \`${parsed.rawCommand}\` 成本核算指令：`,
          '',
          `| 模型名称 | 链路模式 | 总体毛利状态 | 门禁合规性 | 目标毛利率 |`,
          `| :--- | :---: | :---: | :---: | :---: |`,
          `| **${auditResult.modelName} (#${targetModelId})** | \`${auditResult.flowType}\` | **${auditResult.overallStatus}** | **${auditResult.gatePassed ? '🟢 合规' : '🔴 不合规'}** | ${targetMargin}% |`,
          '',
          '#### 📋 各规格测算明细 (基准: 10 积分 ≈ 1.00 元)',
          '| 规格 | 用户刊例 | 供应商成本 | 单笔盈亏 (元) | 毛利率 | 降级成本 | 降级毛利 | 风险评估 |',
          '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |',
        ];

        for (const res of auditResult.resolutions) {
          replyLines.push(
            `| **${res.resolution}** | ${res.userPoints}pt (¥${res.userRevenueYuan.toFixed(2)}) | ¥${res.supplierCostYuan.toFixed(2)} | ${res.grossProfitYuan >= 0 ? `盈利 ¥${res.grossProfitYuan.toFixed(2)}` : `🔴 净亏 ¥${Math.abs(res.grossProfitYuan).toFixed(2)}`} | **${res.grossMarginPercent.toFixed(1)}%** | ${res.fallbackSupplierCostYuan ? `¥${res.fallbackSupplierCostYuan.toFixed(2)}` : '-'} | ${res.fallbackGrossMarginPercent !== undefined ? `${res.fallbackGrossMarginPercent.toFixed(1)}%` : '-'} | ${res.status === 'PROFITABLE' ? '🟢 保本合规' : '🔴 价格倒挂'} |`
          );
        }

        if (auditResult.blockers.length > 0) {
          replyLines.push(
            '',
            '#### 🚨 资损排查与整改建议',
            ...auditResult.blockers.map((b) => `- ❌ ${b}`),
            ...auditResult.recommendations.map((r) => `- 👉 ${r}`),
            '',
            `💡 提示：可直接回复 \`@panqu-bot /fix ${targetModelId}\` 一键自动生成保本调价修复 PR。`
          );
        }

        replyLines.push(
          '',
          '---',
          `*Audit generated via Trae & GitHub MCP • ${new Date().toISOString()}*`
        );

        const replyMarkdown = replyLines.join('\n');

        const actions: GitHubMcpActionCall[] = [
          {
            tool: 'create_issue_comment',
            description: `在 PR #${pullNumber} 评论区回复模型 #${targetModelId} 毛利率看板`,
            arguments: {
              owner: repoOwner,
              repo: repoName,
              issue_number: pullNumber,
              body: replyMarkdown,
            },
          },
        ];

        return {
          ok: true,
          type: 'AUDIT',
          command: parsed,
          summary: `已完成模型 #${targetModelId} 的毛利与成本测算，总体状态为 [${auditResult.overallStatus}]。`,
          replyMarkdown,
          githubMcpActions: actions,
          auditResult,
        };
      }

      case 'HELP': {
        const replyMarkdown = [
          `### 🤖 Panqu Test-Flow PR 交互指令手册 (${authorTag})`,
          '',
          '在 PR 评论区回复以下指令（支持 `@panqu-bot /command` 或直接 `/command`），智能体将自动调用 GitHub MCP 执行相应闭环：',
          '',
          '| 指令语法 | 适用场景 | 触发行为 | 产物反馈 |',
          '| :--- | :--- | :--- | :--- |',
          '| `/retest` 或 `/check` | 代码提交后复测 | 运行 CI 质量与毛利门禁，上报 Check Run | 评论区输出双视角结论，更新 Checks 状态卡点 |',
          '| `/fix [modelId]` | 价格倒挂一键修复 | 为倒挂模型（默认或指定 ID）核算保本售价 | 自动生成 SQL 迁移补丁并提交修复 PR |',
          '| `/audit <modelId>` | 成本与盈亏速查 | 独立测算指定模型各分辨率的供应商成本与毛利 | 评论区输出详细盈亏与单笔倒贴金额表格 |',
          '| `/help` | 查看帮助 | 打印本支持指令列表与使用指南 | 快速参考卡片 |',
          '',
          '#### 💡 使用示例',
          '- `@panqu-bot /retest`：重新跑一遍门禁测试；',
          '- `@panqu-bot /fix 84`：为模型 #84 自动生成保本调价 PR；',
          '- `@panqu-bot /audit 84`：核算模型 #84 当前的盈亏与毛利率。',
          '',
          '---',
          `*Panqu Test-Flow Automated Assistant • Supported by Trae & GitHub MCP*`,
        ].join('\n');

        const actions: GitHubMcpActionCall[] = [
          {
            tool: 'create_issue_comment',
            description: `在 PR #${pullNumber} 评论区回复指令使用帮助`,
            arguments: {
              owner: repoOwner,
              repo: repoName,
              issue_number: pullNumber,
              body: replyMarkdown,
            },
          },
        ];

        return {
          ok: true,
          type: 'HELP',
          command: parsed,
          summary: '已生成 PR 指令使用帮助说明。',
          replyMarkdown,
          githubMcpActions: actions,
        };
      }

      case 'UNKNOWN': {
        const replyMarkdown = [
          `### ⚠️ 未知指令回执 (${authorTag})`,
          '',
          `未能识别您输入的指令：\`${parsed.rawCommand}\`。`,
          '',
          '请使用以下支持的指令：',
          '- `/retest` 或 `/check`：重新触发门禁复测与 Check Run；',
          '- `/fix [modelId]`：自动生成保本调价修复 PR；',
          '- `/audit <modelId>`：核算指定模型的收支与毛利率看板；',
          '- `/help`：获取完整指令手册。',
          '',
          '---',
          `*Panqu Test-Flow Automated Assistant*`,
        ].join('\n');

        const actions: GitHubMcpActionCall[] = [
          {
            tool: 'create_issue_comment',
            description: `在 PR #${pullNumber} 回复未知指令提示`,
            arguments: {
              owner: repoOwner,
              repo: repoName,
              issue_number: pullNumber,
              body: replyMarkdown,
            },
          },
        ];

        return {
          ok: false,
          type: 'UNKNOWN',
          command: parsed,
          summary: `未知指令 [${parsed.commandName}]，已生成友好提示回复。`,
          replyMarkdown,
          githubMcpActions: actions,
        };
      }

      default: {
        return {
          ok: false,
          type: 'NONE',
          command: parsed,
          summary: '评论中未检测到有效的斜杠指令，无需执行动作。',
          replyMarkdown: '',
          githubMcpActions: [],
        };
      }
    }
  }
}
