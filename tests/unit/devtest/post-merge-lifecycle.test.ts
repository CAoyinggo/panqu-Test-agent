import { describe, it, expect } from 'vitest';
import { PostMergeLifecycleEngine } from '../../../src/devtest/post-merge-lifecycle.js';

describe('PostMergeLifecycleEngine (PR 合入后生产校验、工单关闭与版本发布 via GitHub MCP)', () => {
  it('1. PR 合并后执行上线闭环：验证线上配置、生成双视角 Release Notes 并关闭关联 Issue', async () => {
    const result = await PostMergeLifecycleEngine.execute({
      pullNumber: 42,
      mergedCommitSha: 'commit-merge-abc1234',
      associatedIssueNumbers: [38, 39],
      tagName: 'v1.2.0',
      targetModels: [84],
      compareEnv: 'online',
      mock: true,
    });

    expect(result.ok).toBe(true);
    expect(result.pullNumber).toBe(42);
    expect(result.mergedCommitSha).toBe('commit-merge-abc1234');
    expect(result.tagName).toBe('v1.2.0');
    expect(result.driftPassed).toBe(true);
    expect(result.marginPassed).toBe(true);
    expect(result.closedIssues).toEqual([38, 39]);

    // 验证通俗易懂双视角 Release Notes
    expect(result.releaseNotes).toContain('# 🚀 Release v1.2.0');
    expect(result.releaseNotes).toContain('## 📋 一、产品与业务收支看板 (Product & Business View)');
    expect(result.releaseNotes).toContain('## 🛠️ 二、研发技术归档与部署验证 (Developer & Ops View)');
    expect(result.releaseNotes).toContain('模型刊例与财务毛利明细');
    expect(result.releaseNotes).toContain('线上资金安全与核心防线验证');
    expect(result.releaseNotes).toContain('数据库迁移执行归档');
    expect(result.releaseNotes).toContain('SELECT model_id, resolution, points, is_active FROM pq_model_point');

    // 验证 GitHub MCP 动作链 (github_mcp_actions)
    // 预期动作：
    // - Issue #38 评论与关闭 (2 个)
    // - Issue #39 评论与关闭 (2 个)
    // - 创建 Release (1 个)
    // - PR #42 归档回复 (1 个)
    expect(result.githubMcpActions.length).toBe(6);

    // Issue #38
    const issue38Comment = result.githubMcpActions.find(
      (a) => a.tool === 'create_issue_comment' && a.arguments.issue_number === 38
    );
    expect(issue38Comment).toBeDefined();
    expect(issue38Comment?.arguments.body).toContain('资损问题已修复并上线闭环 (PR #42)');

    const issue38Close = result.githubMcpActions.find(
      (a) => a.tool === 'update_issue' && a.arguments.issue_number === 38
    );
    expect(issue38Close).toBeDefined();
    expect(issue38Close?.arguments.state).toBe('closed');

    // Issue #39
    const issue39Close = result.githubMcpActions.find(
      (a) => a.tool === 'update_issue' && a.arguments.issue_number === 39
    );
    expect(issue39Close?.arguments.state).toBe('closed');

    // Release Tag 创建
    const createRelease = result.githubMcpActions.find((a) => a.tool === 'create_release');
    expect(createRelease).toBeDefined();
    expect(createRelease?.arguments.tag_name).toBe('v1.2.0');
    expect(createRelease?.arguments.draft).toBe(false);
    expect(createRelease?.arguments.body).toBe(result.releaseNotes);

    // PR #42 归档回复
    const prComment = result.githubMcpActions.find(
      (a) => a.tool === 'create_issue_comment' && a.arguments.issue_number === 42
    );
    expect(prComment).toBeDefined();
    expect(prComment?.arguments.body).toContain('PR #42 合入后上线闭环已完成');
  });

  it('2. 缺省参数时能自动推导默认 Release Tag 与标题', async () => {
    const result = await PostMergeLifecycleEngine.execute({
      pullNumber: 99,
      mock: true,
    });

    expect(result.ok).toBe(true);
    expect(result.tagName).toBe('v1.99.0');
    expect(result.releaseName).toContain('PR #99');
    expect(result.closedIssues.length).toBe(0);

    const createRelease = result.githubMcpActions.find((a) => a.tool === 'create_release');
    expect(createRelease?.arguments.tag_name).toBe('v1.99.0');
  });
});
