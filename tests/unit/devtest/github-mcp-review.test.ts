import { describe, it, expect } from 'vitest';
import {
  GitHubMcpReviewAdapter,
  type FilePatchItem,
} from '../../../src/devtest/github-mcp-review.js';
import type { MarginAuditReport } from '../../../src/devtest/margin-auditor.js';
import type { ConfigDriftReport } from '../../../src/devtest/config-drift-auditor.js';
import type { GitImpactReport } from '../../../src/devtest/git-impact-analyzer.js';

describe('GitHubMcpReviewAdapter (Trae 双 MCP 协同行级审查适配器)', () => {
  it('1. parseAddedLinesFromPatch: 能够从 Unified Diff Hunks 中准确提取新增行行号与内容', () => {
    const mockPatch = `@@ -10,4 +10,7 @@ class PlotService {
   public function configure() {
-    $resolution = '720p';
+    $resolution = '1080p';
+    $modelId = 84;
+    return true;
   }`;

    const addedLines = GitHubMcpReviewAdapter.parseAddedLinesFromPatch(mockPatch);
    expect(addedLines.length).toBe(3);
    expect(addedLines[0]).toEqual({ line: 11, content: "    $resolution = '1080p';" });
    expect(addedLines[1]).toEqual({ line: 12, content: '    $modelId = 84;' });
    expect(addedLines[2]).toEqual({ line: 13, content: '    return true;' });
  });

  it('2. generateLineComments: 针对价格倒挂、未定价及计费代码生成精准行间批注', () => {
    const gitImpact: GitImpactReport = {
      ok: true,
      repoPath: '/mock',
      changedFiles: [
        'app/admin/controller/aivideo/PlotService.php',
        'app/common/model/Score.php',
      ],
      impactLevel: 'CRITICAL',
      affectedModels: [
        { modelId: 84, modelName: 'Wan 3.0', flowType: 'DIVERSION', reason: '改动控制器' },
      ],
      recommendedScenarios: ['BILLING_RECONCILIATION'],
      suggestedTestCommands: [],
      summary: 'test',
    };

    const configDrift: ConfigDriftReport = {
      ok: true,
      status: 'DRIFT_DETECTED',
      env: 'test',
      compareEnv: 'online',
      driftCount: 1,
      issues: [
        {
          severity: 'HIGH',
          category: 'UNPRICED_MODEL',
          modelId: 999,
          description: '模型 #999 缺失刊例价',
          suggestedAction: '配置刊例价',
        },
      ],
      summary: 'test',
    };

    const marginAudits: MarginAuditReport[] = [
      {
        ok: true,
        gatePassed: false,
        modelId: 84,
        modelName: 'Wan 3.0',
        mediaType: 'video',
        flowType: 'DIVERSION',
        targetMarginPercent: 30,
        overallStatus: 'NEGATIVE_MARGIN_LOSS',
        resolutions: [
          {
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
            fallbackSupplierCostYuan: 3.31,
            fallbackGrossMarginPercent: -231,
            fallbackStatus: 'NEGATIVE_MARGIN_LOSS',
            pricingBasis: 'test',
          },
        ],
        blockers: ['价格倒挂'],
        recommendations: ['建议提价至 42pt'],
        summary: 'fail',
      },
    ];

    const filePatches: FilePatchItem[] = [
      {
        filename: 'app/admin/controller/aivideo/PlotService.php',
        patch: `@@ -40,3 +40,5 @@
+    $res = '1080p';
+    $model = 84;`,
      },
      {
        filename: 'app/common/model/Score.php',
        patch: `@@ -100,3 +100,4 @@
+    public function deductScore() {`,
      },
    ];

    const comments = GitHubMcpReviewAdapter.generateLineComments({
      gitImpact,
      configDrift,
      marginAudits,
      changedFiles: gitImpact.changedFiles,
      filePatches,
      targetMarginPercent: 30,
    });

    expect(comments.length).toBeGreaterThanOrEqual(2);

    // 验证价格倒挂批注挂载到了 1080p 所在行 40
    const marginComment = comments.find((c) => c.body.includes('价格倒挂资损'));
    expect(marginComment).toBeDefined();
    expect(marginComment?.path).toBe('app/admin/controller/aivideo/PlotService.php');
    expect(marginComment?.line).toBe(40);
    expect(marginComment?.body).toContain('42 pt');

    // 验证核心计费安全批注挂载到了 Score.php 所在行 100
    const scoreComment = comments.find((c) => c.body.includes('账务安全合规防线'));
    expect(scoreComment).toBeDefined();
    expect(scoreComment?.path).toBe('app/common/model/Score.php');
    expect(scoreComment?.line).toBe(100);
    expect(scoreComment?.body).toContain('ANTI_DOUBLE_BILLING');
  });

  it('3. buildReviewPayload: 门禁状态准确映射至 GitHub Review Event 与 Trae 调用指令', () => {
    // 阻断态 (BLOCKED) -> REQUEST_CHANGES
    const blockedReview = GitHubMcpReviewAdapter.buildReviewPayload({
      conclusion: 'BLOCKED',
      markdownReport: '# Report',
      lineComments: [{ path: 'test.php', line: 10, side: 'RIGHT', body: 'block' }],
      pullNumber: 42,
    });
    expect(blockedReview.event).toBe('REQUEST_CHANGES');
    expect(blockedReview.payload.event).toBe('REQUEST_CHANGES');
    expect(blockedReview.payload.pull_number).toBe(42);
    expect(blockedReview.traeNextAction.tool).toBe('create_pull_request_review');
    expect(blockedReview.traeNextAction.arguments.event).toBe('REQUEST_CHANGES');
    expect(blockedReview.traeNextAction.arguments.pull_number).toBe(42);

    // 全绿通过态 (APPROVED) -> APPROVE
    const approvedReview = GitHubMcpReviewAdapter.buildReviewPayload({
      conclusion: 'APPROVED',
      markdownReport: '# Report',
      lineComments: [],
      pullNumber: 99,
    });
    expect(approvedReview.event).toBe('APPROVE');
    expect(approvedReview.traeNextAction.arguments.event).toBe('APPROVE');

    // 关注态 (NEEDS_ATTENTION) -> COMMENT
    const warnReview = GitHubMcpReviewAdapter.buildReviewPayload({
      conclusion: 'NEEDS_ATTENTION',
      markdownReport: '# Report',
      lineComments: [],
      pullNumber: 101,
    });
    expect(warnReview.event).toBe('COMMENT');
    expect(warnReview.traeNextAction.arguments.event).toBe('COMMENT');
  });
});
