import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiPrGate, resolveEvidenceLocation } from '../../../src/devtest/ci-pr-gate.js';
import { readFile, unlink, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('CiPrGate (GitHub Actions CI/CD & PR Quality Gate)', () => {
  it('does not claim an unrelated changed line as a confirmed location', () => {
    const location = resolveEvidenceLocation({
      filePatches: [{ filename: 'VideoService.php', patch: '@@ -1 +1 @@\n-old\n+unrelated' }],
      filePattern: /VideoService/, keywords: ['1080p'],
    });
    expect(location.locationStatus).toBe('UNKNOWN');
    expect(location.line).toBeNull();
  });
  let tempDir: string;
  let summaryFile: string;
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'cipr-test-'));
    summaryFile = path.join(tempDir, 'step-summary.md');
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
  });

  afterEach(async () => {
    process.env.GITHUB_STEP_SUMMARY = originalSummary;
    if (existsSync(summaryFile)) {
      await unlink(summaryFile).catch(() => {});
    }
  });

  it('1. PR 正常改动视频服务代码时，自动推导波及模型并生成通过门禁', async () => {
    const prCommentPath = path.join(tempDir, 'pr-comment.md');
    const result = await CiPrGate.run({
      changedFiles: ['app/admin/controller/aivideo/PlotService.php'],
      targetMarginPercent: 30,
      outputPrCommentPath: prCommentPath,
      mock: true,
    });

    expect(result.ok).toBe(true);
    expect(result.gatePassed).toBe(true);
    expect(['APPROVED', 'NEEDS_ATTENTION']).toContain(result.conclusion);
    expect(result.gitImpact.affectedModels.some((m) => m.modelId === 84)).toBe(true);
    expect(result.marginAudits.length).toBeGreaterThan(0);
    expect(result.markdownReport).toContain('### 🤖 Panqu Test-Flow CI Quality & Margin Review');
    expect(result.markdownReport).toContain('Wan 3.0');

    // 验证 PR 评论文件已落地
    expect(existsSync(prCommentPath)).toBe(true);
    const savedComment = await readFile(prCommentPath, 'utf8');
    expect(savedComment).toContain('门禁裁决');

    // 验证 GITHUB_STEP_SUMMARY 已写入
    expect(existsSync(summaryFile)).toBe(true);
    const summaryContent = await readFile(summaryFile, 'utf8');
    expect(summaryContent).toContain('Panqu Test-Flow CI Quality & Margin Review');

    // 验证 GitHub MCP Payload 构造
    expect(result.githubReviewEvent).toBeDefined();
    expect(result.githubMcpPayload).toBeDefined();
    expect(result.traeNextAction).toBeDefined();
    expect(result.traeNextAction.tool).toBe('create_pull_request_review');
  });

  it('2. 针对指定模型核算毛利与门禁阻断判定 (BLOCKED 拦截资损)', async () => {
    // 针对基准模型 84，此时毛利合规通过
    const passResult = await CiPrGate.run({
      targetModels: [84],
      targetMarginPercent: 30,
      mock: true,
    });
    expect(passResult.ok).toBe(true);
    expect(passResult.gatePassed).toBe(true);
    expect(passResult.blockers.length).toBe(0);

    // 针对图片模型 901
    const imgResult = await CiPrGate.run({
      targetModels: [901],
      targetMarginPercent: 30,
      mock: true,
    });
    expect(imgResult.ok).toBe(true);
    expect(imgResult.gatePassed).toBe(true);
    expect(imgResult.marginAudits.some((a) => a.modelId === 901)).toBe(true);
  });

  it('3. generateWorkflowYaml() 能够正确生成开箱即用的 GitHub Actions CI 配置', () => {
    const yaml = CiPrGate.generateWorkflowYaml();
    expect(yaml).toContain('name: Panqu Test-Flow CI Quality Gate');
    expect(yaml).toContain('pull_request:');
    expect(yaml).toContain('node dist/src/devtest/run-playwright-cli.js --ci-gate');
    expect(yaml).toContain('actions/github-script@v7');
    expect(yaml).toContain('pr-comment.md');
    expect(yaml).toContain('### 🤖 Panqu Test-Flow CI Quality & Margin Review');
  });

  it('4. renderMarkdownReport() 正确格式化各种门禁状态与 Markdown 徽章', () => {
    const mockReport = CiPrGate.renderMarkdownReport({
      conclusion: 'BLOCKED',
      summary: '检测到负毛利价格倒挂',
      gitImpact: {
        ok: true,
        repoPath: '/mock',
        changedFiles: ['app/test.php'],
        impactLevel: 'CRITICAL',
        affectedModels: [{ modelId: 84, modelName: 'Wan 3.0', flowType: 'DIVERSION', reason: 'test' }],
        recommendedScenarios: ['MAIN_HAPPY_PATH'],
        suggestedTestCommands: [],
        summary: 'test',
      },
      configDrift: {
        ok: true,
        status: 'CONSISTENT',
        env: 'test',
        compareEnv: 'online',
        driftCount: 0,
        issues: [],
        summary: 'ok',
      },
      marginAudits: [{
        ok: true,
        gatePassed: false,
        modelId: 84,
        modelName: 'Wan 3.0',
        mediaType: 'video',
        flowType: 'DIVERSION',
        targetMarginPercent: 30,
        overallStatus: 'NEGATIVE_MARGIN_LOSS',
        resolutions: [{
          resolution: '1080p',
          userPoints: 10,
          effectiveCnyPerPoint: 0.1,
          userRevenueYuan: 1.0,
          supplierCostYuan: 2.88,
          grossProfitYuan: -1.88,
          grossMarginPercent: -188,
          breakEvenPoints: 29,
          suggestedPoints: 42,
          status: 'NEGATIVE_MARGIN_LOSS',
          pricingBasis: 'test',
        }],
        blockers: ['价格倒挂'],
        recommendations: ['提价至 42pt'],
        summary: 'fail',
      }],
      blockers: ['价格倒挂亏损'],
      warnings: [],
      recommendations: ['提价至 42pt'],
      targetMarginPercent: 30,
    });

    expect(mockReport).toContain('🔴 BLOCKED (资损阻断)');
    expect(mockReport).toContain('价格倒挂亏损');
    expect(mockReport).toContain('提价至 42pt');
    expect(mockReport).toContain('1080p');
  });

  it('5. 传入 pullNumber 与 filePatches 时，输出完整 lineComments 与 GitHub MCP 载荷', async () => {
    const result = await CiPrGate.run({
      pullNumber: 42,
      changedFiles: ['app/common/model/Score.php'],
      filePatches: [{
        filename: 'app/common/model/Score.php',
        patch: '@@ -50,3 +50,4 @@\n+    $deducted = true;',
      }],
      mock: true,
    });

    expect(result.ok).toBe(true);
    expect(result.githubMcpPayload.pull_number).toBe(42);
    expect(result.traeNextAction.arguments.pull_number).toBe(42);
    expect(result.lineComments.length).toBeGreaterThan(0);
    expect(result.lineComments[0].path).toBe('app/common/model/Score.php');
    expect(result.lineComments[0].line).toBe(50);
  });
});
