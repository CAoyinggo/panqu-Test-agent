import { describe, it, expect } from 'vitest';
import { GitHubCheckRunAdapter } from '../../../src/devtest/github-check-run.js';
import type { MarginAuditReport } from '../../../src/devtest/margin-auditor.js';
import type { ConfigDriftReport } from '../../../src/devtest/config-drift-auditor.js';
import type { GitImpactReport } from '../../../src/devtest/git-impact-analyzer.js';

describe('GitHubCheckRunAdapter Unit Tests', () => {
  const mockGitImpact: GitImpactReport = {
    ok: true,
    repoPath: '/mock',
    changedFiles: ['app/admin/controller/aivideo/PlotService.php', 'application/extra/site.php'],
    impactLevel: 'MEDIUM',
    affectedModels: [
      { modelId: 84, modelName: 'Wan 2.1', flowType: 'DIRECT', reason: '改动控制器' },
    ],
    recommendedScenarios: ['BILLING_RECONCILIATION'],
    suggestedTestCommands: [],
    summary: 'Detected model 84 changes in PlotService.php',
  };

  const mockBlockedMarginAudits: MarginAuditReport[] = [
    {
      ok: true,
      gatePassed: false,
      modelId: 84,
      modelName: 'Wan 2.1 (通义万相 2.1)',
      mediaType: 'video',
      flowType: 'DIRECT',
      overallStatus: 'NEGATIVE_MARGIN_LOSS',
      targetMarginPercent: 30,
      resolutions: [
        {
          resolution: '720p',
          userPoints: 10,
          effectiveCnyPerPoint: 0.1,
          userRevenueYuan: 1.0,
          supplierCostYuan: 0.6,
          grossProfitYuan: 0.4,
          grossMarginPercent: 40.0,
          breakEvenPoints: 6,
          status: 'PROFITABLE',
          suggestedPoints: 10,
          pricingBasis: 'test basis',
        },
        {
          resolution: '1080p',
          userPoints: 10,
          effectiveCnyPerPoint: 0.1,
          userRevenueYuan: 1.0,
          supplierCostYuan: 2.88,
          grossProfitYuan: -1.88,
          grossMarginPercent: -188.0,
          breakEvenPoints: 29,
          status: 'NEGATIVE_MARGIN_LOSS',
          suggestedPoints: 42,
          pricingBasis: 'test basis',
        },
      ],
      blockers: ['规格 1080p 产生负毛利倒挂'],
      recommendations: ['将 1080p 刊例提价至 42 pt'],
      summary: '模型 #84 发现 1 个负毛利规格',
    },
  ];

  const mockConfigDrift: ConfigDriftReport = {
    ok: true,
    status: 'CRITICAL_DRIFT',
    env: 'test',
    compareEnv: 'online',
    driftCount: 1,
    issues: [
      {
        severity: 'HIGH',
        category: 'UNPRICED_MODEL',
        description: '模型 #99 未配置刊例价',
        suggestedAction: '请在后台配置刊例',
        modelId: 99,
      },
    ],
    summary: '发现 1 个未定价模型',
  };

  it('generates FAILURE check run payload with code annotations when margin loss exists and patch is provided', () => {
    const headSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const samplePatches = [
      {
        filename: 'app/admin/controller/aivideo/PlotService.php',
        patch: '@@ -45,6 +45,8 @@ class PlotService\n+ // Wan 2.1 1080p mapping\n+ $res = "1080p";',
      },
    ];

    const result = GitHubCheckRunAdapter.buildCheckRunResult({
      headSha,
      pullNumber: 42,
      repoOwner: 'panqu-ai',
      repoName: 'panqu-ai',
      conclusion: 'BLOCKED',
      markdownReport: '### Quality Gate Blocked\n- Price inversion detected',
      gitImpact: mockGitImpact,
      configDrift: mockConfigDrift,
      marginAudits: mockBlockedMarginAudits,
      changedFiles: mockGitImpact.changedFiles,
      filePatches: samplePatches,
      targetMarginPercent: 30,
    });

    expect(result.conclusion).toBe('failure');
    expect(result.checkRunPayload.name).toBe('test-flow/quality-and-margin-gate');
    expect(result.checkRunPayload.head_sha).toBe(headSha);
    expect(result.checkRunPayload.status).toBe('completed');
    expect(result.checkRunPayload.output.title).toContain('BLOCKED');
    expect(result.commitStatusPayload.state).toBe('failure');

    // 校验 Annotations
    expect(result.annotationsCount.failure).toBeGreaterThan(0);
    const failureAnnotations = result.checkRunPayload.output.annotations.filter((a) => a.annotation_level === 'failure');
    expect(failureAnnotations.length).toBeGreaterThan(0);

    const marginLossAnnotation = failureAnnotations.find((a) => a.title.includes('价格倒挂'));
    expect(marginLossAnnotation).toBeDefined();
    expect(marginLossAnnotation?.message).toContain('42 pt');
    expect(marginLossAnnotation?.path).toBe('app/admin/controller/aivideo/PlotService.php');
    expect(marginLossAnnotation?.start_line).toBeGreaterThanOrEqual(1);

    // 校验 GitHub MCP Actions 封装
    expect(result.githubMcpActions).toHaveLength(2);
    const createCheckRunAction = result.githubMcpActions[0];
    expect(createCheckRunAction.tool).toBe('create_check_run');
    expect(createCheckRunAction.arguments.owner).toBe('panqu-ai');
    expect(createCheckRunAction.arguments.repo).toBe('panqu-ai');
    expect(createCheckRunAction.arguments.head_sha).toBe(headSha);
    expect(createCheckRunAction.arguments.conclusion).toBe('failure');

    const commitStatusAction = result.githubMcpActions[1];
    expect(commitStatusAction.tool).toBe('create_commit_status');
    expect(commitStatusAction.arguments.state).toBe('failure');
  });

  it('does not generate fake line: 1 annotations when patch diff evidence is missing, reports in summary instead', () => {
    const result = GitHubCheckRunAdapter.buildCheckRunResult({
      headSha: '123456789012',
      conclusion: 'BLOCKED',
      markdownReport: 'Blocked report',
      gitImpact: mockGitImpact,
      configDrift: mockConfigDrift,
      marginAudits: mockBlockedMarginAudits,
      changedFiles: mockGitImpact.changedFiles,
      // filePatches intentionally omitted
    });

    expect(result.checkRunPayload.output.annotations).toHaveLength(0);
    expect(result.checkRunPayload.output.summary).toContain('未定位到代码行的审查项 (未生成行级 Annotation)');
    expect(result.checkRunPayload.output.summary).toContain('UNKNOWN');
  });

  it('accurately locates annotation lines from GitHub MCP diff patch hunks', () => {
    const patchSample = [
      '@@ -45,6 +45,8 @@ class PlotService',
      '     public function handleRequest() {',
      '+        // WAN 2.1 1080p resolution mapping',
      '+        $resolution = "1080p";',
      '         return true;',
      '     }',
    ].join('\n');

    const filePatches = [
      {
        filename: 'app/admin/controller/aivideo/PlotService.php',
        patch: patchSample,
      },
    ];

    const result = GitHubCheckRunAdapter.buildCheckRunResult({
      headSha: '112233445566',
      conclusion: 'BLOCKED',
      markdownReport: 'Blocked report',
      gitImpact: mockGitImpact,
      configDrift: { ok: true, status: 'CONSISTENT', env: 'test', compareEnv: 'online', driftCount: 0, issues: [], summary: 'Clean' },
      marginAudits: mockBlockedMarginAudits,
      changedFiles: mockGitImpact.changedFiles,
      filePatches,
    });

    const marginAnno = result.checkRunPayload.output.annotations.find((a) => a.title.includes('价格倒挂'));
    expect(marginAnno).toBeDefined();
    // 命中 line 46 (首个包含 1080p 的新增行)
    expect(marginAnno?.start_line).toBe(46);
    expect(marginAnno?.path).toBe('app/admin/controller/aivideo/PlotService.php');
  });

  it('generates SUCCESS check run payload and green status when all gates pass', () => {
    const cleanMarginAudits: MarginAuditReport[] = [
      {
        ok: true,
        gatePassed: true,
        modelId: 84,
        modelName: 'Wan 2.1',
        mediaType: 'video',
        flowType: 'DIRECT',
        overallStatus: 'PROFITABLE',
        targetMarginPercent: 30,
        resolutions: [
          {
            resolution: '720p',
            userPoints: 10,
            effectiveCnyPerPoint: 0.1,
            userRevenueYuan: 1.0,
            supplierCostYuan: 0.6,
            grossProfitYuan: 0.4,
            grossMarginPercent: 40.0,
            breakEvenPoints: 6,
            status: 'PROFITABLE',
            suggestedPoints: 10,
            pricingBasis: 'test basis',
          },
        ],
        blockers: [],
        recommendations: [],
        summary: 'All profitable',
      },
    ];

    const result = GitHubCheckRunAdapter.buildCheckRunResult({
      headSha: 'fedcba987654',
      conclusion: 'APPROVED',
      markdownReport: '### All 8 quality gates passed',
      gitImpact: mockGitImpact,
      configDrift: { ok: true, status: 'CONSISTENT', env: 'test', compareEnv: 'online', driftCount: 0, issues: [], summary: 'Clean' },
      marginAudits: cleanMarginAudits,
      changedFiles: mockGitImpact.changedFiles,
    });

    expect(result.conclusion).toBe('success');
    expect(result.checkRunPayload.output.title).toContain('SUCCESS');
    expect(result.commitStatusPayload.state).toBe('success');
    expect(result.annotationsCount.failure).toBe(0);
    expect(result.githubMcpActions[0].arguments.conclusion).toBe('success');
    expect(result.summaryMarkdown).toContain('允许合入 (Merge Allowed)');
  });
});
