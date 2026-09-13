import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { DevTestMcpService, DEVTEST_MCP_TOOL } from '../../../src/devtest/mcp-service.js';

describe('DevTest MCP High-Level Scenario Tools (for Trae & Developer Self-Test)', () => {
  const service = new DevTestMcpService(path.resolve('.'));

  describe('1. DEVTEST_MCP_TOOL 架构规范与 Schema 检查', () => {
    it('包含全部高阶操作动作定义', () => {
      const actionProp = DEVTEST_MCP_TOOL.inputSchema.properties.action;
      expect(actionProp.enum).toContain('quick_verify');
      expect(actionProp.enum).toContain('audit_billing');
      expect(actionProp.enum).toContain('diagnose_diversion');
      expect(actionProp.enum).toContain('self_test_plan');
      expect(actionProp.enum).toContain('probe_environment');
      expect(actionProp.enum).toContain('export_repro');
      expect(actionProp.enum).toContain('extract_model_matrix');
      expect(actionProp.enum).toContain('doctor');
      expect(actionProp.enum).toContain('plan');
      expect(actionProp.enum).toContain('execute');
      expect(actionProp.enum).toContain('status');
      expect(DEVTEST_MCP_TOOL.inputSchema.properties).not.toHaveProperty('cookie');
    });

    it('拒绝明文 Cookie 与项目外路径', async () => {
      expect(await service.call({ action: 'probe_environment', cookie: 'secret' })).toMatchObject({ ok: false, status: 'BLOCKED' });
      expect(await service.call({ action: 'extract_model_matrix', panqu_root: '/tmp' })).toMatchObject({ ok: false, status: 'BLOCKED', message: 'PATH_OUTSIDE_PROJECT' });
      expect(await service.call({ action: 'export_ci_workflow', workflow_path: '../outside.yml' })).toMatchObject({ ok: false, status: 'BLOCKED', message: 'PATH_OUTSIDE_PROJECT' });
    });
  });

  describe('2. quick_verify: 模型一键体检与闭环自测', () => {
    it('受控 MOCK 模式快速验证 Wan 3.0 (84) 正向闭环', async () => {
      const result = await service.call({
        action: 'quick_verify',
        model_id: 84,
        media_type: 'video',
        mode: 'mock',
        resolution: '720p',
        duration: 4,
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe('PASS');
      expect(result.diversion).toMatchObject({
        passed: true,
        is_diverted: true,
        newapi_model: 'wan3.0-video',
      });
      expect(result.artifact).toMatchObject({
        passed: true,
        decodable: true,
        format: expect.stringContaining('mp4'),
      });
      expect(result.billing).toMatchObject({
        passed: true,
        expected_points: 56,
        net_deducted_points: 56,
        anti_double_billing: true,
        refund_idempotency: true,
      });
      expect(result.supplier_cost).toMatchObject({
        passed: true,
      });
    });

    it('受控 MOCK 模式验证失败退款与净扣归零不变量闭环', async () => {
      const result = await service.call({
        action: 'quick_verify',
        model_id: 84,
        media_type: 'video',
        mode: 'mock',
        expect_failure: true,
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe('PASS');
      expect(result.business_status).toBe('FAILED');
      expect(result.billing).toMatchObject({
        passed: true,
        net_deducted_points: 0,
        net_charge_zero: true,
        refund_idempotency: true,
      });
    });
  });

  describe('3. audit_billing: 账单流水对账核销与防资损审计', () => {
    const taskId = 9901;

    it('正常预扣与结算流水核验 PASS', async () => {
      const result = await service.call({
        action: 'audit_billing',
        task_id: taskId,
        model_id: 84,
        media_type: 'video',
        duration: 4,
        resolution: '720p',
        terminal_status: 'SUCCESS',
        score_logs: [
          { task_id: taskId, type: 2, score: -56, memo: '预扣' },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe('PASS');
      expect(result.expected_points).toBe(56);
      expect(result.net_deducted_points).toBe(56);
      expect(result.invariants).toMatchObject({
        anti_double_billing: true,
        refund_idempotency: true,
      });
    });

    it('检测到同一 client_token 重复预扣时触发 ANTI_DOUBLE_BILLING 违背报警', async () => {
      const result = await service.call({
        action: 'audit_billing',
        task_id: taskId,
        model_id: 84,
        media_type: 'video',
        duration: 4,
        resolution: '720p',
        terminal_status: 'SUCCESS',
        score_logs: [
          { task_id: taskId, type: 2, score: -56, client_token: 'token-retry-123' },
          { task_id: taskId, type: 2, score: -56, client_token: 'token-retry-123' },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe('FAIL');
      const invariants = result.invariants as Record<string, unknown>;
      const anomalies = result.anomalies as Record<string, unknown>;
      expect(invariants.anti_double_billing).toBe(false);
      expect(anomalies.duplicate_charged).toBe(true);
      expect((result.reasons as string[]).some((r) => r.includes('ANTI_DOUBLE_BILLING'))).toBe(true);
    });

    it('失败任务未退款触发 NET_CHARGE_ZERO 违背报警', async () => {
      const result = await service.call({
        action: 'audit_billing',
        task_id: taskId,
        model_id: 84,
        media_type: 'video',
        duration: 4,
        resolution: '720p',
        terminal_status: 'FAILED',
        score_logs: [
          { task_id: taskId, type: 2, score: -56 },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe('FAIL');
      const invariants = result.invariants as Record<string, unknown>;
      const anomalies = result.anomalies as Record<string, unknown>;
      expect(invariants.net_charge_zero).toBe(false);
      expect(anomalies.missing_refund).toBe(true);
      expect((result.reasons as string[]).some((r) => r.includes('NET_CHARGE_ZERO'))).toBe(true);
    });
  });

  describe('4. diagnose_diversion: 分流规则与快照诊断', () => {
    it('Wan 3.0 视频符合条件时推导为 DIVERTED 命中万相 NewAPI 渠道', async () => {
      const result = await service.call({
        action: 'diagnose_diversion',
        model_id: 84,
        media_type: 'video',
        resolution: '720p',
        aspect_ratio: '16:9',
        task_type: 28,
      });

      expect(result.ok).toBe(true);
      expect(result.decision).toBe('DIVERTED');
      expect(result.line).toBe(10);
      expect(result.will_divert).toBe(true);
      expect(result.expected_snapshot).toMatchObject({
        orgId: 10,
        newapiModel: 'wan3.0-video',
      });
      expect(result.gateway).toBeDefined();
    });

    it('传入不支持的规格参数时推导降级回退 DIRECT', async () => {
      const result = await service.call({
        action: 'diagnose_diversion',
        model_id: 84,
        media_type: 'video',
        resolution: '4k',
        aspect_ratio: '16:9',
        task_type: 28,
      });

      expect(result.ok).toBe(false);
      expect(result.decision).toBe('DIRECT');
      expect(result.will_divert).toBe(false);
      expect(String(result.reason)).toContain('4k');
    });
  });

  describe('5. self_test_plan: 需求驱动自主测试规划', () => {
    it('针对新上线直连模型规划 DIRECT 模式方案', async () => {
      const result = await service.call({
        action: 'self_test_plan',
        requirement: '直接接入新视频模型 Kling 2.0，代码写死直连 NewAPI',
        flow_type: 'direct',
        model_id: 95,
        media_type: 'video',
        model_alias: 'kling-2.0',
      });

      expect(result.ok).toBe(true);
      expect(result.flow_type).toBe('DIRECT');
      expect(result.scenario_count).toBeGreaterThanOrEqual(5);
      expect((result.scenarios as Array<{ kind: string }>).some((s) => s.kind === 'DIRECT_SPEC_MATRIX')).toBe(true);
    });

    it('针对已有模型分流规划 DIVERSION 模式方案', async () => {
      const result = await service.call({
        action: 'self_test_plan',
        requirement: '对已有 Wan 3.0 视频模型开启 NewAPI 分流',
        flow_type: 'diversion',
        model_id: 84,
        media_type: 'video',
      });

      expect(result.ok).toBe(true);
      expect(result.flow_type).toBe('DIVERSION');
      expect((result.scenarios as Array<{ kind: string }>).some((s) => s.kind === 'DIVERSION_FALLBACK_DIRECT')).toBe(true);
    });
  });

  describe('6. probe_environment: 真实环境只读连通性与就绪巡检', () => {
    it('调用 probe_environment 输出端点与模型分流状态', async () => {
      const result = await service.call({
        action: 'probe_environment',
        env: 'test',
        mode: 'mock',
        model_id: 84,
        media_type: 'video',
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe('HEALTHY');
      expect(result.env).toBe('test');
      expect(Array.isArray(result.endpoints)).toBe(true);
      expect(result.model_readiness).toMatchObject({
        modelId: 84,
        willDivert: true,
      });
    });
  });

  describe('7. export_repro: 缺陷一键复现包生成与导出', () => {
    it('针对计费或分流异常生成复现脚本与提单 Markdown', async () => {
      const result = await service.call({
        action: 'export_repro',
        case_id: 'MCP-REPRO-TEST-001',
        failure_category: 'BILLING_ANOMALY',
        model_id: 84,
        media_type: 'video',
        duration: 4,
        resolution: '720p',
        violated_invariants: ['ANTI_DOUBLE_BILLING'],
        reasons: ['检测到重复预扣积分流水'],
      });

      expect(result.ok).toBe(true);
      expect(result.severity).toBe('P0');
      expect(result.title).toContain('P0');
      expect(result.curl_command).toContain('/aivideo/videonew/add');
      expect(result.playwright_script).toContain('@playwright/test');
      expect(result.markdown_report).toContain('ANTI_DOUBLE_BILLING');
    });
  });

  describe('8. extract_model_matrix: 业务模型规格逆向提取', () => {
    it('提取核心模型规格矩阵并生成推荐正交用例', async () => {
      const result = await service.call({
        action: 'extract_model_matrix',
        model_id: 84,
      });

      expect(result.ok).toBe(true);
      expect(result.model_id).toBe(84);
      expect(result.spec).toMatchObject({
        modelName: 'Wan 3.0',
        alias: 'wan3.0-video',
        mediaType: 'video',
      });
      expect(Array.isArray(result.scenarios)).toBe(true);
      expect((result.scenarios as any[]).length).toBeGreaterThanOrEqual(3);
    });

    it('不传 model_id 时返回全部已知模型的规格字典', async () => {
      const result = await service.call({
        action: 'extract_model_matrix',
      });

      expect(result.ok).toBe(true);
      expect(Number(result.count)).toBeGreaterThanOrEqual(7);
      expect(result.models).toBeDefined();
    });
  });

  describe('9. analyze_git_impact: Git 改动增量模型影响分析', () => {
    it('调用 analyze_git_impact 分析改动文件并输出受影响模型', async () => {
      const result = await service.call({
        action: 'analyze_git_impact',
        changed_files: ['aibaseos/application/admin/service/Image25Service.php'],
      });

      expect(result.ok).toBe(true);
      expect(result.impact_level).toBe('MEDIUM');
      expect(Array.isArray(result.affected_models)).toBe(true);
      expect((result.affected_models as any[]).some((m) => m.modelId === 901)).toBe(true);
      expect(Array.isArray(result.suggested_test_commands)).toBe(true);
    });
  });

  describe('10. watch_task: 长任务流式监视与断点对账', () => {
    it('调用 watch_task 监视任务进度并自动完成质检与对账', async () => {
      const result = await service.call({
        action: 'watch_task',
        task_id: 88888,
        model_id: 84,
        media_type: 'video',
        mode: 'mock',
      });

      expect(result.ok).toBe(true);
      expect(result.task_id).toBe(88888);
      expect(result.final_status).toBe('COMPLETED');
      expect(result.media_inspection).toBeDefined();
      expect(result.billing_reconciliation).toBeDefined();
      expect((result.billing_reconciliation as any).passed).toBe(true);
    });
  });

  describe('11. simulate_chaos: NewAPI 网关多渠道容灾演练', () => {
    it('调用 simulate_chaos 注入 429 故障并验证故障转移', async () => {
      const result = await service.call({
        action: 'simulate_chaos',
        chaos_type: 'UPSTREAM_429_RATE_LIMIT',
        model_id: 84,
        mode: 'mock',
      });

      expect(result.ok).toBe(true);
      expect(result.resilience_passed).toBe(true);
      expect(result.initial_channel).toBeDefined();
      expect(result.failover_channel).toBeDefined();
      expect(result.invariants_checked).toMatchObject({
        antiDoubleBilling: true,
      });
    });
  });

  describe('12. audit_config_drift: 多环境配置与刊例价差异动审计', () => {
    it('调用 audit_config_drift 审计配置一致性与刊例价', async () => {
      const result = await service.call({
        action: 'audit_config_drift',
        env: 'test',
        compare_env: 'online',
        mode: 'mock',
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBeDefined();
      expect(Array.isArray(result.issues)).toBe(true);
      expect(typeof result.summary).toBe('string');
    });
  });

  describe('13. audit_margin: 供应商成本与平台毛利率智能核算门禁', () => {
    it('调用 audit_margin 核算模型多规格毛利率与门禁结果', async () => {
      const result = await service.call({
        action: 'audit_margin',
        model_id: 84,
        media_type: 'video',
        duration: 4,
        target_margin_percent: 30,
      });

      expect(result.ok).toBe(true);
      expect(result.gate_passed).toBe(true);
      expect(result.model_id).toBe(84);
      expect(result.overall_status).toBe('PROFITABLE');
      expect(Array.isArray(result.resolutions)).toBe(true);
      expect((result.resolutions as any[]).length).toBeGreaterThanOrEqual(3);

      const res720 = (result.resolutions as any[]).find((r) => r.resolution === '720p');
      expect(res720).toBeDefined();
      expect(res720.gross_profit_yuan || res720.grossProfitYuan).toBeGreaterThan(0);
      expect(res720.gross_margin_percent || res720.grossMarginPercent).toBeGreaterThan(30);
    });
  });

  describe('14. review_pr: GitHub PR 质量与毛利自动化审查门禁', () => {
    it('调用 review_pr 对变更文件进行综合门禁核算并输出 Markdown', async () => {
      const result = await service.call({
        action: 'review_pr',
        changed_files: ['app/admin/controller/aivideo/PlotService.php'],
        target_margin_percent: 30,
        mode: 'mock',
      });

      expect(result.ok).toBe(true);
      expect(result.gate_passed).toBe(true);
      expect(result.conclusion).toBeDefined();
      expect(typeof result.markdown_report).toBe('string');
      expect(result.markdown_report).toContain('### 🤖 Panqu Test-Flow CI Quality & Margin Review');
      expect(Array.isArray(result.affected_models)).toBe(true);
      expect(result.github_review_event).toBeDefined();
      expect(result.github_mcp_payload).toBeDefined();
      expect(result.trae_next_action).toBeDefined();
      expect((result.trae_next_action as any).tool).toBe('create_pull_request_review');
    });
  });

  describe('15. export_ci_workflow: 导出 GitHub Actions CI 门禁配置', () => {
    it('调用 export_ci_workflow 成功生成工作流文件与内容', async () => {
      const result = await service.call({
        action: 'export_ci_workflow',
      });

      expect(result.ok).toBe(true);
      expect(typeof result.workflow_path).toBe('string');
      expect(typeof result.yaml_content).toBe('string');
      expect(result.yaml_content).toContain('Panqu Test-Flow CI Quality Gate');
      expect(result.yaml_content).toContain('run-playwright-cli.js --ci-gate');
    });
  });

  describe('16. propose_fix_pr: 资损与毛利优化一键提 PR 闭环', () => {
    it('调用 propose_fix_pr 生成调价 PR 描述、SQL 与 GitHub MCP actions', async () => {
      const result = await service.call({
        action: 'propose_fix_pr',
        model_id: 84,
        target_margin_percent: 30,
      });

      expect(result.ok).toBe(true);
      expect(result.model_id).toBe(84);
      expect(typeof result.branch_name).toBe('string');
      expect(typeof result.pr_title).toBe('string');
      expect(typeof result.pr_body).toBe('string');
      expect(Array.isArray(result.file_changes)).toBe(true);
      expect(Array.isArray(result.github_mcp_actions)).toBe(true);
      expect((result.github_mcp_actions as any[]).some((a) => a.tool === 'create_pull_request')).toBe(true);
    });
  });

  describe('17. report_check_run: GitHub Check Runs 原生门禁回写与 Annotations', () => {
    it('调用 report_check_run 生成标准 Check Run 载荷与 GitHub MCP actions', async () => {
      const result = await service.call({
        action: 'report_check_run',
        head_sha: 'commit_sha_123456',
        pull_number: 42,
        mode: 'mock',
      });

      expect(result.ok).toBe(true);
      expect(result.conclusion).toBeDefined();
      expect(result.head_sha).toBe('commit_sha_123456');
      expect(typeof result.check_name).toBe('string');
      expect(result.check_run_payload).toBeDefined();
      expect((result.check_run_payload as any).head_sha).toBe('commit_sha_123456');
      expect((result.check_run_payload as any).output).toBeDefined();
      expect(Array.isArray((result.check_run_payload as any).output.annotations)).toBe(true);
      expect(result.commit_status_payload).toBeDefined();
      expect(Array.isArray(result.github_mcp_actions)).toBe(true);
      expect((result.github_mcp_actions as any[]).some((a) => a.tool === 'create_check_run')).toBe(true);
      expect((result.github_mcp_actions as any[]).some((a) => a.tool === 'create_commit_status')).toBe(true);
      expect(typeof result.summary).toBe('string');
      expect(typeof result.trae_next_instruction).toBe('string');
    });
  });

  describe('18. handle_pr_command: GitHub PR 评论指令解析与交互闭环', () => {
    it('调用 handle_pr_command 解析 /retest 指令并返回复测与 GitHub MCP 回复', async () => {
      const result = await service.call({
        action: 'handle_pr_command',
        comment_body: '@panqu-bot /retest',
        comment_author: 'alice',
        pull_number: 42,
        mode: 'mock',
      });

      expect(result.ok).toBe(true);
      expect(result.command_type).toBe('RETEST');
      expect(result.command_name).toBe('retest');
      expect(result.pull_number).toBe(42);
      expect(typeof result.reply_markdown).toBe('string');
      expect(result.reply_markdown).toContain('门禁复测回执');
      expect(Array.isArray(result.github_mcp_actions)).toBe(true);
      expect((result.github_mcp_actions as any[]).some((a) => a.tool === 'create_issue_comment')).toBe(true);
      expect(typeof result.trae_next_instruction).toBe('string');
    });

    it('调用 handle_pr_command 解析 /fix 84 指令并生成调价 PR 闭环', async () => {
      const result = await service.call({
        action: 'handle_pr_command',
        comment_body: '/fix 84',
        comment_author: 'bob',
        pull_number: 99,
      });

      expect(result.ok).toBe(true);
      expect(result.command_type).toBe('FIX');
      expect(result.model_id).toBe(84);
      expect(result.reply_markdown).toContain('资损调价修复包已生成');
      expect((result.github_mcp_actions as any[]).some((a) => a.tool === 'create_pull_request')).toBe(true);
      expect((result.github_mcp_actions as any[]).some((a) => a.tool === 'create_issue_comment')).toBe(true);
    });
  });

  describe('19. post_merge_release: PR 合入后配置零漂移核验、关闭工单与发版闭环', () => {
    it('调用 post_merge_release 自动完成线上配置复测、组织 Issue 关闭与 Release 动作', async () => {
      const result = await service.call({
        action: 'post_merge_release',
        pull_number: 42,
        associated_issue_numbers: [38],
        tag_name: 'v1.2.0',
        mode: 'mock',
      });

      expect(result.ok).toBe(true);
      expect(result.pull_number).toBe(42);
      expect(result.tag_name).toBe('v1.2.0');
      expect(result.drift_passed).toBe(true);
      expect(result.margin_passed).toBe(true);
      expect(result.closed_issues).toEqual([38]);
      expect(typeof result.release_notes).toBe('string');
      expect(result.release_notes).toContain('# 🚀 Release v1.2.0');
      expect(Array.isArray(result.github_mcp_actions)).toBe(true);
      expect((result.github_mcp_actions as any[]).some((a) => a.tool === 'update_issue')).toBe(true);
      expect((result.github_mcp_actions as any[]).some((a) => a.tool === 'create_release')).toBe(true);
      expect((result.github_mcp_actions as any[]).some((a) => a.tool === 'create_issue_comment')).toBe(true);
      expect(typeof result.trae_next_instruction).toBe('string');
    });
  });
});
