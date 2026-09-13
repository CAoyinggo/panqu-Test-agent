import { describe, it, expect } from 'vitest';
import { PrCommentCommandHandler } from '../../../src/devtest/pr-comment-command.js';

describe('PrCommentCommandHandler (PR Slash Command Interactive Loop via GitHub MCP)', () => {
  describe('1. 指令解析器单元测试 (Command Parser)', () => {
    it('正确解析 @bot /retest 指令', () => {
      const parsed = PrCommentCommandHandler.parse({
        commentBody: '@panqu-bot /retest',
        commentAuthor: 'alice',
        pullNumber: 42,
      });

      expect(parsed.type).toBe('RETEST');
      expect(parsed.commandName).toBe('retest');
      expect(parsed.commentAuthor).toBe('alice');
      expect(parsed.pullNumber).toBe(42);
    });

    it('正确解析无 @ 的 /check 与 /gate 指令', () => {
      const parsed1 = PrCommentCommandHandler.parse({ commentBody: '/check' });
      expect(parsed1.type).toBe('RETEST');

      const parsed2 = PrCommentCommandHandler.parse({ commentBody: '/gate' });
      expect(parsed2.type).toBe('RETEST');
    });

    it('正确解析 /fix 84 与自定义毛利参数', () => {
      const parsed = PrCommentCommandHandler.parse({
        commentBody: '@panqu-bot /fix 84 --margin=35',
        commentAuthor: 'bob',
        pullNumber: 108,
      });

      expect(parsed.type).toBe('FIX');
      expect(parsed.commandName).toBe('fix');
      expect(parsed.modelId).toBe(84);
      expect(parsed.targetMarginPercent).toBe(35);
      expect(parsed.pullNumber).toBe(108);
    });

    it('正确解析 /audit 84 成本与盈亏速查指令', () => {
      const parsed = PrCommentCommandHandler.parse({
        commentBody: '/audit 84',
        commentAuthor: 'qa-tester',
      });

      expect(parsed.type).toBe('AUDIT');
      expect(parsed.modelId).toBe(84);
    });

    it('正确解析 /help 指令', () => {
      const parsed = PrCommentCommandHandler.parse({ commentBody: '/help' });
      expect(parsed.type).toBe('HELP');
    });

    it('正确标记未知指令为 UNKNOWN', () => {
      const parsed = PrCommentCommandHandler.parse({ commentBody: '/unknown_action_xyz' });
      expect(parsed.type).toBe('UNKNOWN');
      expect(parsed.commandName).toBe('unknown_action_xyz');
    });

    it('普通讨论评论判定为 NONE', () => {
      const parsed = PrCommentCommandHandler.parse({ commentBody: 'LGTM! 代码写得很干净，感谢提交。' });
      expect(parsed.type).toBe('NONE');
    });
  });

  describe('2. 指令执行与 GitHub MCP 动作链生成 (Execution & MCP Actions)', () => {
    it('/retest 执行：完成门禁复测，生成 Check Run 动作与通俗 Issue Comment 回复', async () => {
      const result = await PrCommentCommandHandler.execute({
        commentBody: '@panqu-bot /retest',
        commentAuthor: 'developer-1',
        pullNumber: 42,
        headSha: 'commit-sha-42',
        mock: true,
      });

      expect(result.ok).toBe(true);
      expect(result.type).toBe('RETEST');
      expect(result.summary).toContain('门禁复测');
      expect(result.replyMarkdown).toContain('### 🤖 Panqu Test-Flow 门禁复测回执 (@developer-1)');
      expect(result.replyMarkdown).toContain('门禁最终裁决');
      expect(result.replyMarkdown).toContain('分支保护卡点');

      // 验证 GitHub MCP 动作链包含上报 Check Run 与回复 Issue Comment
      const hasCheckRunAction = result.githubMcpActions.some(
        (a) => a.tool === 'create_check_run' || a.tool === 'create_commit_status'
      );
      expect(hasCheckRunAction).toBe(true);

      const issueCommentAction = result.githubMcpActions.find((a) => a.tool === 'create_issue_comment');
      expect(issueCommentAction).toBeDefined();
      expect(issueCommentAction?.arguments.issue_number).toBe(42);
      expect(issueCommentAction?.arguments.body).toContain('门禁复测回执');
    });

    it('/fix 84 执行：生成保本调价修复方案、SQL 迁移脚本与 PR 回复', async () => {
      const result = await PrCommentCommandHandler.execute({
        commentBody: '/fix 84',
        commentAuthor: 'dev-lead',
        pullNumber: 55,
      });

      expect(result.ok).toBe(true);
      expect(result.type).toBe('FIX');
      expect(result.fixResult).toBeDefined();
      expect(result.fixResult?.modelId).toBe(84);
      expect(result.replyMarkdown).toContain('### 🛠️ Panqu Test-Flow 资损调价修复包已生成 (@dev-lead)');
      expect(result.replyMarkdown).toContain('产品与测试看板：调价前后收支对比');
      expect(result.replyMarkdown).toContain('研发排查与 FastAdmin 安全调价 SQL');
      expect(result.replyMarkdown).toContain('INSERT INTO pq_model_point');

      // 验证 GitHub MCP 动作链：文件提交、开PR、评论回复
      const hasFileCreate = result.githubMcpActions.some((a) => a.tool === 'create_or_update_file_contents');
      const hasPrCreate = result.githubMcpActions.some((a) => a.tool === 'create_pull_request');
      const hasComment = result.githubMcpActions.some((a) => a.tool === 'create_issue_comment');

      expect(hasFileCreate).toBe(true);
      expect(hasPrCreate).toBe(true);
      expect(hasComment).toBe(true);
    });

    it('/audit 84 执行：输出模型收支与各分辨率单笔盈亏看板', async () => {
      const result = await PrCommentCommandHandler.execute({
        commentBody: '@panqu-bot /audit 84',
        commentAuthor: 'pm-alice',
        pullNumber: 77,
      });

      expect(result.ok).toBe(true);
      expect(result.type).toBe('AUDIT');
      expect(result.auditResult).toBeDefined();
      expect(result.replyMarkdown).toContain('### 💰 Panqu Test-Flow 模型收支与毛利率看板 (@pm-alice)');
      expect(result.replyMarkdown).toContain('用户刊例');
      expect(result.replyMarkdown).toContain('供应商成本');
      expect(result.replyMarkdown).toContain('单笔盈亏');
      expect(result.replyMarkdown).toContain('毛利率');

      const commentAction = result.githubMcpActions.find((a) => a.tool === 'create_issue_comment');
      expect(commentAction).toBeDefined();
      expect(commentAction?.arguments.issue_number).toBe(77);
    });

    it('/help 执行：输出完整的指令手册与示例卡片', async () => {
      const result = await PrCommentCommandHandler.execute({
        commentBody: '/help',
        commentAuthor: 'newbie',
        pullNumber: 99,
      });

      expect(result.ok).toBe(true);
      expect(result.type).toBe('HELP');
      expect(result.replyMarkdown).toContain('### 🤖 Panqu Test-Flow PR 交互指令手册 (@newbie)');
      expect(result.replyMarkdown).toContain('/retest');
      expect(result.replyMarkdown).toContain('/fix');
      expect(result.replyMarkdown).toContain('/audit');
    });

    it('未知指令执行：友好提示未知指令，引导查看帮助', async () => {
      const result = await PrCommentCommandHandler.execute({
        commentBody: '/bad_command_test',
        commentAuthor: 'user-x',
        pullNumber: 12,
      });

      expect(result.ok).toBe(false);
      expect(result.type).toBe('UNKNOWN');
      expect(result.replyMarkdown).toContain('### ⚠️ 未知指令回执 (@user-x)');
      expect(result.replyMarkdown).toContain('未能识别您输入的指令：`/bad_command_test`');
    });

    it('普通无指令评论：返回 NONE 且不产生任何 GitHub MCP 动作', async () => {
      const result = await PrCommentCommandHandler.execute({
        commentBody: 'Looks good to me!',
        commentAuthor: 'reviewer',
        pullNumber: 12,
      });

      expect(result.ok).toBe(false);
      expect(result.type).toBe('NONE');
      expect(result.githubMcpActions.length).toBe(0);
    });
  });
});
