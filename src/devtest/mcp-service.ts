import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AcceptanceExecutionPlanIdentity } from '../acceptance/acceptance-execution-plan.js';
import { artifactSafe } from './artifacts.js';
import { doctorDevTestProject, loadDevTestConfig, type DevTestProjectConfig } from './cli-config.js';
import { runDevTest } from './devtest-runner.js';
import { loadDevTestRuntime } from './runtime-loader.js';
import type { DevTestRunResult } from './types.js';
import { devTestNextAction } from './interaction-guidance.js';
import { BillingOracle, type ScoreLogEntry } from './billing-oracle.js';
import {
  RoutingOracle,
  type MainSiteConfigSnapshot,
  type GatewayChannelConfig,
  type GatewayRoutingVerdict,
} from './routing-oracle.js';
import { SelfTestPlanner } from './self-test-planner.js';
import { runPanquPlaywrightFlow, createSyntheticValidMp4 } from './panqu-playwright-engine.js';
import { EnvironmentProbe } from './env-probe.js';
import { ReproExporter } from './repro-exporter.js';
import { ModelMatrixExtractor } from './model-matrix-extractor.js';
import { GitImpactAnalyzer } from './git-impact-analyzer.js';
import { TaskWatcher } from './task-watcher.js';
import { ChaosSimulator, type ChaosFaultType } from './chaos-simulator.js';
import { ConfigDriftAuditor } from './config-drift-auditor.js';
import { MarginAuditor } from './margin-auditor.js';
import { CiPrGate } from './ci-pr-gate.js';
import { AutoFixPrEngine } from './auto-fix-pr.js';
import { GitHubCheckRunAdapter } from './github-check-run.js';
import { PrCommentCommandHandler } from './pr-comment-command.js';
import { PostMergeLifecycleEngine } from './post-merge-lifecycle.js';

const execFileAsync = promisify(execFile);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const EXECUTION_POLICY = 'NO_SILENT_REQUIREMENT_GAPS_V1+EXACT_INPUT_CASES_V1+PANQU_SOURCE_BINDING_V1';

/** MCP is a control surface. Case schemas and execution semantics remain in TEST_CASE_V2. */
export const DEVTEST_MCP_TOOL = {
  name: 'devtest',
  description: 'Panqu DevTest 开发者自助测试 MCP 智能体。提供模型一键自测体检 (quick_verify)、账单流水对账与防资损审计 (audit_billing)、分流规则与快照诊断 (diagnose_diversion)、需求驱动测试规划 (self_test_plan)、真实环境探针 (probe_environment)、缺陷复现包导出 (export_repro)、模型规格矩阵提取 (extract_model_matrix)、Git改动增量模型影响分析 (analyze_git_impact)、长任务流式进度监视与断点对账 (watch_task)、网关渠道故障与降级容灾演练 (simulate_chaos)、多环境配置与刊例价漂移审计 (audit_config_drift)、供应商成本与平台毛利率核算门禁 (audit_margin)、GitHub PR质量与毛利自动化审查 (review_pr)、一键生成提PR调价修复包 (propose_fix_pr)、GitHub Check Runs 原生门禁回写 (report_check_run)、导出GitHub Actions CI工作流 (export_ci_workflow) 以及全量用例门禁 (doctor/plan/execute/status)。',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: [
          'quick_verify', 'audit_billing', 'diagnose_diversion', 'self_test_plan',
          'probe_environment', 'export_repro', 'extract_model_matrix',
          'analyze_git_impact', 'watch_task', 'simulate_chaos', 'audit_config_drift',
          'audit_margin', 'review_pr', 'propose_fix_pr', 'report_check_run', 'handle_pr_command', 'post_merge_release', 'export_ci_workflow',
          'doctor', 'plan', 'execute', 'status',
        ],
        description: '操作类型：quick_verify (模型快速自测体检), audit_billing (账单对账与不变量审计), diagnose_diversion (分流与路由规则诊断), self_test_plan (自主测试规划), probe_environment (环境与连通性探针), export_repro (缺陷复现包导出), extract_model_matrix (业务模型规格提取), analyze_git_impact (Git改动模型影响分析), watch_task (长任务进度监视与对账), simulate_chaos (网关容灾演练), audit_config_drift (多环境配置漂移审计), audit_margin (成本与毛利率核算门禁), review_pr (GitHub PR质量与毛利自动化审查), propose_fix_pr (一键生成提PR调价修复包), report_check_run (GitHub Check Runs 原生门禁回写), handle_pr_command (GitHub PR 评论指令解析与交互闭环), post_merge_release (PR合入后配置零漂移核验/关闭Issue/发布Release), export_ci_workflow (导出CI工作流配置), doctor (环境体检), plan/execute/status (需求执行流水线)',
      },
      model_id: { type: 'number', description: '模型 ID (例如 84, 88, 201, 205 等)' },
      media_type: { type: 'string', enum: ['video', 'image'], description: '媒体类型：video 或 image' },
      flow_type: { type: 'string', enum: ['diversion', 'direct', 'DIVERSION', 'DIRECT'], description: '测试流类型：diversion (已有模型分流) 或 direct (新模型直接接入)' },
      mode: { type: 'string', enum: ['mock', 'real', 'MOCK', 'API_INTEGRATION'], description: '执行模式：mock (受控仿真验证) 或 real (真实环境集成执行)' },
      resolution: { type: 'string', description: '分辨率规格 (例如 480p, 720p, 1080p, 1k, 2k)' },
      aspect_ratio: { type: 'string', description: '画面比例 (例如 16:9, 9:16, 1:1)' },
      duration: { type: 'number', description: '生成时长秒数 (视频模型适用，例如 4, 5)' },
      prompt: { type: 'string', description: '测试提示词' },
      serviceline: { type: 'string', description: '图片业务线标识 (例如 r 代表 RunningHub)' },
      expect_failure: { type: 'boolean', description: '是否为预期失败分支（验证失败退款与净扣归零）' },
      env: { type: 'string', enum: ['test', 'sandbox', 'preonline'], description: '执行目标环境 (默认 test)' },
      base_url: { type: 'string', description: '真实探针主站 HTTPS 地址（仅允许 test/preonline/sandbox）' },
      gateway_url: { type: 'string', description: '真实探针网关 HTTPS 地址（仅允许受信 Panqu 测试网关）' },
      timeout_ms: { type: 'number', description: '只读探针或任务等待超时毫秒数' },

      task_id: { type: 'number', description: '任务 ID' },
      terminal_status: { type: 'string', enum: ['SUCCESS', 'FAILED', 'TIMEOUT'], description: '任务终态' },
      score_logs: { type: 'array', description: '流水列表，每项包含 type (1:退款, 2:预扣), score/points, client_token 等' },
      custom_points: { type: 'number', description: '自定义刊例单次消耗积分' },
      balance_before: { type: 'number', description: '扣费前钱包余额' },
      balance_after: { type: 'number', description: '扣费后钱包余额' },

      task_type: { type: 'number', description: '任务类型 (例如 28)' },
      user_group_ids: { type: 'array', items: { type: 'number' }, description: '用户所属组织/企业 ID 列表' },
      main_config: { type: 'object', description: '主站分流配置覆盖' },

      requirement: { type: 'string', description: '需求描述文本或需求文件相对路径' },
      requirement_file: { type: 'string', description: '需求文件相对路径' },
      model_alias: { type: 'string', description: '模型别名' },

      session_file: { type: 'string', description: '当前项目内的会话凭证文件相对路径；不接受明文 Cookie' },
      case_id: { type: 'string', description: '用例标识符' },
      failure_category: { type: 'string', description: '失败类别 (如 BILLING_ANOMALY, DIVERSION_MISMATCH, ARTIFACT_CORRUPT)' },
      violated_invariants: { type: 'array', items: { type: 'string' }, description: '违背的不变量列表' },
      expected: { description: '预期结果对象或描述' },
      actual: { description: '实际结果对象或描述' },
      reasons: { type: 'array', items: { type: 'string' }, description: '失败原因说明列表' },
      auto_export_repro: { type: 'boolean', description: '是否自动导出复现包' },
      panqu_root: { type: 'string', description: '当前项目内的业务代码根目录相对路径' },

      repo_path: { type: 'string', description: '当前项目内的代码仓库相对路径' },
      staged_only: { type: 'boolean', description: '是否仅检查已暂存改动' },
      changed_files: { type: 'array', items: { type: 'string' }, description: '显式指定的变更文件列表' },
      poll_interval_ms: { type: 'number', description: '轮询间隔毫秒' },
      simulate_failure: { type: 'boolean', description: '是否模拟失败分支' },
      chaos_type: {
        type: 'string',
        enum: ['UPSTREAM_429_RATE_LIMIT', 'UPSTREAM_504_TIMEOUT', 'UPSTREAM_500_CRASH', 'CHANNEL_AUTH_FAIL', 'ALL_CHANNELS_DOWN'],
        description: '注入故障类型',
      },
      channels: { type: 'array', description: '受控仿真的网关渠道配置快照' },
      compare_env: { type: 'string', description: '对比目标环境 (如 online)' },
      check_unpriced_models: { type: 'boolean', description: '是否审计未定价模型' },
      target_margin_percent: { type: 'number', description: '期望目标毛利率百分比 (如 30 代表 30%)' },
      effective_cny_per_point: { type: 'number', description: '每积分有效人民币金额 (默认 0.10 即 10积分=1元)' },
      custom_points_map: { type: 'object', description: '自定义各分辨率积分定价映射 (如 {"720p": 56, "1080p": 108})' },
      resolutions: { type: 'array', items: { type: 'string' }, description: '显式指定的被测分辨率列表' },
      base_ref: { type: 'string', description: 'PR 或 CI 比对基准分支或 commit SHA (例如 origin/main)' },
      target_models: { type: 'array', items: { type: 'number' }, description: '显式指定的被测模型 ID 列表' },
      output_pr_comment_path: { type: 'string', description: '当前项目内的 PR 评论 Markdown 输出相对路径' },
      workflow_path: { type: 'string', description: '当前项目内导出的 CI 工作流相对路径' },
      output_dir: { type: 'string', description: '当前项目内的输出目录相对路径' },
      issue_type: { type: 'string', enum: ['NEGATIVE_MARGIN_LOSS', 'UNPRICED_MODEL', 'AUTO'], description: '自动修复问题类型' },
      pull_number: { type: 'number', description: 'GitHub PR 编号 (例如 42)' },
      file_patches: { type: 'array', description: 'GitHub MCP list_pull_request_files 返回的文件 patch 列表，用于准确定位逐行评论' },
      repo_owner: { type: 'string', description: 'GitHub 仓库所有者 (例如 panqu-ai)' },
      repo_name: { type: 'string', description: 'GitHub 仓库名称 (例如 panqu-ai)' },
      base_branch: { type: 'string', description: '目标 PR 基准分支 (例如 main)' },
      head_sha: { type: 'string', description: 'GitHub Commit SHA 或 PR head SHA' },
      check_name: { type: 'string', description: 'GitHub Check Run 名称 (默认 test-flow/quality-and-margin-gate)' },
      comment_body: { type: 'string', description: 'GitHub PR 评论正文 (例如 @panqu-bot /retest 或 /fix 84)' },
      comment_author: { type: 'string', description: 'GitHub PR 评论发布者用户名' },
      comment_id: { type: 'number', description: 'GitHub PR 评论唯一 ID' },
      associated_issue_numbers: { type: 'array', items: { type: 'number' }, description: '关联需要自动解决关闭的 GitHub Issue 编号列表 (例如 [38, 39])' },
      tag_name: { type: 'string', description: '待发布的 GitHub Release Tag (例如 v1.2.0)' },
      release_name: { type: 'string', description: 'GitHub Release 标题名称' },
      merged_commit_sha: { type: 'string', description: 'PR 合并后的 Commit SHA' },

      plan_id: { type: 'string' },
      expected_plan_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      idempotency_key: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
    },
    required: ['action'],
    allOf: [
      { if: { properties: { action: { const: 'plan' } } }, then: { required: ['requirement'] } },
      { if: { properties: { action: { const: 'execute' } } }, then: { required: ['plan_id', 'expected_plan_hash', 'idempotency_key'] } },
      { if: { properties: { action: { const: 'status' } } }, then: { required: ['plan_id'] } },
    ],
  },
};

interface PlanRecord {
  executionPolicy: string;
  planId: string;
  requirement: string;
  sourceDigest: string;
  configDigest: string;
  contextDigest: string;
  targetDigest: string;
  executionPlan: AcceptanceExecutionPlanIdentity;
  planHash: string;
  preview: Record<string, unknown>;
}

interface RunRecord {
  state: 'RUNNING' | 'COMPLETED' | 'BLOCKED';
  idempotencyKey: string;
  result?: Record<string, unknown>;
}

function planHash(record: Omit<PlanRecord, 'planHash' | 'preview'>): string {
  return digest(JSON.stringify(record));
}

function token(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`INVALID_INPUT: ${name}`);
  return value;
}

function validateInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT: expected an object');
  const input = value as Record<string, unknown>;
  const keys: Record<string, string[]> = {
    doctor: ['action'], plan: ['action', 'requirement'],
    execute: ['action', 'plan_id', 'expected_plan_hash', 'idempotency_key'], status: ['action', 'plan_id'],
    quick_verify: [
      'action', 'model_id', 'media_type', 'flow_type', 'mode', 'resolution',
      'aspect_ratio', 'duration', 'prompt', 'serviceline', 'expect_failure', 'env',
      'auto_export_repro',
    ],
    audit_billing: [
      'action', 'task_id', 'model_id', 'media_type', 'terminal_status', 'score_logs',
      'duration', 'resolution', 'custom_points', 'balance_before', 'balance_after',
    ],
    diagnose_diversion: [
      'action', 'model_id', 'media_type', 'resolution', 'aspect_ratio', 'prompt',
      'task_type', 'serviceline', 'user_group_ids', 'main_config', 'channels',
    ],
    self_test_plan: [
      'action', 'requirement', 'requirement_file', 'flow_type', 'model_id',
      'media_type', 'model_alias', 'env',
    ],
    probe_environment: [
      'action', 'env', 'base_url', 'gateway_url', 'session_file',
      'model_id', 'media_type', 'user_group_ids', 'mode', 'timeout_ms',
    ],
    export_repro: [
      'action', 'case_id', 'failure_category', 'task_id', 'model_id', 'media_type',
      'duration', 'resolution', 'aspect_ratio', 'prompt', 'serviceline', 'env',
      'expected', 'actual', 'reasons', 'violated_invariants', 'score_logs', 'output_dir',
    ],
    extract_model_matrix: [
      'action', 'model_id', 'panqu_root',
    ],
    analyze_git_impact: [
      'action', 'repo_path', 'staged_only', 'changed_files',
    ],
    watch_task: [
      'action', 'task_id', 'model_id', 'media_type', 'env', 'mode',
      'timeout_ms', 'poll_interval_ms', 'simulate_failure', 'duration', 'resolution',
    ],
    simulate_chaos: [
      'action', 'chaos_type', 'model_id', 'media_type', 'channels', 'mode',
    ],
    audit_config_drift: [
      'action', 'env', 'compare_env', 'repo_path', 'check_unpriced_models', 'mode',
    ],
    audit_margin: [
      'action', 'model_id', 'media_type', 'duration', 'resolutions', 'target_margin_percent',
      'effective_cny_per_point', 'custom_points_map', 'panqu_root', 'repo_path',
    ],
    review_pr: [
      'action', 'base_ref', 'changed_files', 'target_models', 'target_margin_percent',
      'effective_cny_per_point', 'env', 'output_pr_comment_path', 'repo_path', 'panqu_root', 'mode',
      'pull_number', 'file_patches',
    ],
    propose_fix_pr: [
      'action', 'model_id', 'media_type', 'issue_type', 'target_margin_percent',
      'effective_cny_per_point', 'base_branch', 'repo_owner', 'repo_name', 'repo_path', 'panqu_root', 'custom_points_map',
    ],
    report_check_run: [
      'action', 'head_sha', 'pull_number', 'repo_owner', 'repo_name', 'check_name',
      'base_ref', 'changed_files', 'file_patches', 'target_margin_percent',
      'effective_cny_per_point', 'env', 'repo_path', 'panqu_root', 'mode',
    ],
    handle_pr_command: [
      'action', 'comment_body', 'comment_author', 'comment_id', 'pull_number',
      'head_sha', 'repo_owner', 'repo_name', 'target_margin_percent',
      'effective_cny_per_point', 'changed_files', 'file_patches', 'env', 'repo_path', 'panqu_root', 'mode',
    ],
    post_merge_release: [
      'action', 'pull_number', 'merged_commit_sha', 'associated_issue_numbers',
      'tag_name', 'release_name', 'target_models', 'compare_env', 'target_margin_percent',
      'repo_owner', 'repo_name', 'repo_path', 'panqu_root', 'mode',
    ],
    export_ci_workflow: [
      'action', 'workflow_path', 'repo_path',
    ],
  };
  const allowed = typeof input.action === 'string' ? keys[input.action] : undefined;
  if (!allowed || Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('INVALID_INPUT: unknown action or field');
  if (input.action === 'execute' || input.action === 'status') token(input.plan_id, 'plan_id');
  if (input.action === 'execute') {
    token(input.idempotency_key, 'idempotency_key');
    if (typeof input.expected_plan_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_plan_hash)) throw new Error('INVALID_INPUT: expected_plan_hash');
  }
  return input;
}

/** Resolve symlinks, including in the parent of a not-yet-created output directory. */
async function within(root: string, relative: string, mustExist = true): Promise<string> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('PATH_OUTSIDE_PROJECT');
  const candidate = path.resolve(root, relative);
  let resolved: string;
  try { resolved = await realpath(candidate); }
  catch (error) {
    if (mustExist || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(relative);
    resolved = path.join(parent === '.' ? root : await within(root, parent, false), path.basename(relative));
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('PATH_OUTSIDE_PROJECT');
  return resolved;
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

function summary(result: DevTestRunResult, root: string): Record<string, unknown> {
  return artifactSafe({
    run_id: result.runId, conclusion: result.conclusion,
    project_assessment: result.projectAssessment,
    counts: result.deliveryCoverage.cases,
    evidence: result.deliveryCoverage.evidence,
    oracle: result.oracleResults,
    plan: result.plan,
    execution_estimate: result.executionEstimate,
    selected_case_ids: result.executionPlan.selectedCaseIds,
    requirement_coverage: result.requirementCoverage,
    requirement_assurance: result.requirementAssurance,
    unknown_fact_ids: result.requirementModel.unknownFactIds,
    unknowns: result.requirementModel.facts.filter((fact) => result.requirementModel.unknownFactIds.includes(fact.id))
      .map(({ id, statement, status, source }) => ({ id, statement, status, source })),
    problems: result.problems,
    readiness: result.environmentPreflight.status,
    readiness_detail: { target_selected: result.environmentPreflight.checks.baseUrl === 'READY',
      reason: result.environmentPreflight.reason },
    dimensions: result.dimensionApplicability,
    business_flows: result.businessFlowGraph,
    data_lifecycle: result.dataLifecycle,
    paths: Object.fromEntries(Object.entries(result.artifacts).filter(([, value]) => typeof value === 'string')
      .map(([name, value]) => [name, path.relative(root, value as string)])),
  }) as Record<string, unknown>;
}

/** All actions share the same local project and operator configuration. No shell input from the agent. */
export class DevTestMcpService {
  constructor(private readonly projectRoot: string) {}

  private async targetDigest(root: string, config: DevTestProjectConfig): Promise<string> {
    const moduleRef = process.env[config.runtime.runtimeModuleEnv] || '';
    // Bind operator-selected targets and runtime code without persisting URLs or credentials.
    const moduleDigest = moduleRef ? digest(await readFile(await within(root, moduleRef), 'utf8')) : '';
    return digest(JSON.stringify({
      baseUrl: process.env[config.runtime.baseUrlEnv] || '',
      fallbackBaseUrls: [process.env.TESTFLOW_BASE_URL || '', process.env.TEST_BASE_URL || ''],
      moduleRef, moduleDigest,
    }));
  }

  private async contextDigest(root: string, config: DevTestProjectConfig): Promise<string> {
    // Include tracked and untracked source content; output, dependencies and secrets are never read.
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 10_000,
    });
    const records: string[] = [];
    for (const file of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
      if (file.startsWith(`${config.runtime.output}/`) || /(?:^|\/)(?:node_modules|dist|\.git|\.env[^/]*|devtest-results)(?:\/|$)/.test(file)) continue;
      if (!/\.(?:[cm]?[jt]sx?|vue|md|txt|json|ya?ml|prisma|graphql)$/.test(file)) continue;
      try { records.push(`${file}:${digest(await readFile(await within(root, file), 'utf8'))}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') records.push(`${file}:deleted`); else throw error; }
    }
    return digest(records.join('\n'));
  }

  async call(value: unknown): Promise<Record<string, unknown>> {
    try {
      const input = validateInput(value);
      const result = await this.dispatch(input);
      return { ...result, next_action: devTestNextAction(result, input) };
    }
    catch (error) {
      const result = artifactSafe({ ok: false, status: 'BLOCKED', message: (error as Error).message }) as Record<string, unknown>;
      const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      return { ...result, next_action: devTestNextAction(result, input) };
    }
  }

  private async dispatch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const root = await realpath(this.projectRoot);
    for (const field of ['repo_path', 'panqu_root', 'session_file']) {
      if (typeof input[field] === 'string') input[field] = await within(root, input[field] as string);
    }
    for (const field of ['workflow_path', 'output_pr_comment_path', 'output_dir']) {
      if (typeof input[field] === 'string') input[field] = await within(root, input[field] as string, false);
    }
    const config = await loadDevTestConfig(root);
    if (input.action === 'doctor') {
      const result = await doctorDevTestProject({ root, config });
      return { ok: result.status === 'READY', ...result };
    }

    if (input.action === 'quick_verify') {
      const mediaType = (input.media_type === 'image' ? 'image' : 'video') as 'video' | 'image';
      const modelId = typeof input.model_id === 'number' ? input.model_id : (mediaType === 'video' ? 84 : 201);
      const isMock = input.mode !== 'real' && input.mode !== 'API_INTEGRATION';
      const isFail = Boolean(input.expect_failure);
      const outputDir = path.join(root, config.runtime.output, 'devtest-results');

      const expectedPoints = BillingOracle.calculateExpectedPoints({
        mediaType,
        modelId,
        duration: typeof input.duration === 'number' ? input.duration : undefined,
        resolution: typeof input.resolution === 'string' ? input.resolution : undefined,
      });

      const taskId = 29000 + Math.floor(Math.random() * 1000);
      const mockOptions = isMock ? {
        mockSubmitResponse: {
          status: 200,
          body: { code: 1, msg: 'ok', data: { id: taskId } },
        },
        mockStatusResponses: isFail
          ? [
              { status: 200, body: { task_status: 1, progress: 30 } },
              { status: 200, body: { task_status: 3, progress: 0, err: 'UPSTREAM_MODEL_LIMIT' } },
            ]
          : [
              { status: 200, body: { task_status: 1, progress: 40 } },
              { status: 200, body: { task_status: 2, progress: 100, video_url: 'https://v.panqu.com.cn/video/sample.mp4', pic_url: 'https://v.panqu.com.cn/image/sample.png' } },
            ],
        mockTaskDetails: {
          id: taskId,
          status: isFail ? 3 : 2,
          line: 10,
          video_url: 'https://v.panqu.com.cn/video/sample.mp4',
          pic_url: 'https://v.panqu.com.cn/image/sample.png',
          extra: {
            diversion: 10,
            newapi_log_id: 501,
            newapi_image: 1,
            newapi_model: mediaType === 'video' ? 'wan3.0-video' : 'runninghub-nano-banana-2',
            newapi_org_id: 0,
            newapi_group: '',
            points: expectedPoints,
            channel_id: 36,
            channel_name: '万相—yhuo',
          },
        },
        mockGatewayLog: {
          id: 501,
          ai_task_id: taskId,
          newapi_task_id: `task_${mediaType}_${taskId}`,
          channel_id: 36,
          channel_name: '万相—yhuo',
          status: isFail ? 'FAILED' : 'SUCCESS',
        },
        mockAssetBuffer: isFail
          ? undefined
          : (mediaType === 'video'
              ? createSyntheticValidMp4({
                  width: typeof input.resolution === 'string' && input.resolution.includes('1080') ? 1920 : (typeof input.resolution === 'string' && input.resolution.includes('720') ? 1280 : 854),
                  height: typeof input.resolution === 'string' && input.resolution.includes('1080') ? 1080 : (typeof input.resolution === 'string' && input.resolution.includes('720') ? 720 : 480),
                  durationSeconds: typeof input.duration === 'number' ? input.duration : 4,
                })
              : Buffer.concat([
                  Buffer.from('89504e470d0a1a0a0000000d4948445200000400000004000806000000', 'hex'),
                  Buffer.alloc(32),
                ])),
        mockScoreLogs: isFail
          ? [
              { type: 'PRE_DEDUCT' as const, points: expectedPoints },
              { type: 'REFUND' as const, points: expectedPoints },
            ]
          : [
              { type: 'PRE_DEDUCT' as const, points: expectedPoints },
              { type: 'SETTLE' as const, points: expectedPoints },
            ],
      } : {};

      const flowResult = await runPanquPlaywrightFlow({
        caseId: `MCP-${Date.now()}`,
        mediaType,
        modelId,
        executionMode: isMock ? 'MOCK' : 'API_INTEGRATION',
        duration: typeof input.duration === 'number' ? input.duration : undefined,
        resolution: typeof input.resolution === 'string' ? input.resolution : undefined,
        aspectRatio: typeof input.aspect_ratio === 'string' ? input.aspect_ratio : undefined,
        prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
        serviceline: typeof input.serviceline === 'string' ? input.serviceline : undefined,
        expectFailure: isFail,
        env: (input.env as 'test' | 'preonline') || 'test',
        outputDir,
        ...mockOptions,
      });

      let reproPackage;
      if (flowResult.overallStatus !== 'PASS' || input.auto_export_repro) {
        try {
          reproPackage = await ReproExporter.generatePackage({
            caseId: flowResult.caseId,
            failureCategory: flowResult.taskTracking.failureCategory || 'TASK_EXECUTION_FAILURE',
            taskInfo: {
              taskId,
              modelId,
              mediaType,
              duration: typeof input.duration === 'number' ? input.duration : undefined,
              resolution: typeof input.resolution === 'string' ? input.resolution : undefined,
              aspectRatio: typeof input.aspect_ratio === 'string' ? input.aspect_ratio : undefined,
              prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
              serviceline: typeof input.serviceline === 'string' ? input.serviceline : undefined,
              env: (input.env as string) || 'test',
            },
            expected: isFail ? { terminalStatus: 'FAILED', netChargeZero: true } : { overallStatus: 'PASS', billing: 'PASS' },
            actual: { overallStatus: flowResult.overallStatus, billing: flowResult.billing.status },
            reasons: flowResult.diagnosticLog || flowResult.billing.reasons,
            violatedInvariants: flowResult.billing.passed ? [] : ['NET_CHARGE_ZERO'],
            scoreLogs: (mockOptions as any).mockScoreLogs,
            outputDir: path.resolve(outputDir, 'repro'),
          });
        } catch {
          // ignore repro export errors
        }
      }

      return {
        ok: flowResult.overallStatus === 'PASS',
        status: flowResult.overallStatus,
        case_id: flowResult.caseId,
        business_status: flowResult.businessTaskStatus,
        task_id: flowResult.taskId,
        diversion: {
          passed: flowResult.diversion.passed,
          is_diverted: flowResult.diversion.isDiverted,
          status: flowResult.diversion.status,
          newapi_model: flowResult.diversion.newapiModel,
          reasons: flowResult.diversion.reasons,
        },
        artifact: {
          passed: flowResult.artifact.passed,
          decodable: flowResult.artifact.decodable,
          format: flowResult.artifact.format,
          dimensions: flowResult.artifact.dimensions,
          duration_seconds: flowResult.artifact.durationSeconds,
          reasons: flowResult.artifact.reasons,
        },
        billing: {
          passed: flowResult.billing.passed,
          status: flowResult.billing.status,
          expected_points: flowResult.billing.expectedPoints,
          net_deducted_points: flowResult.billing.netDeductedPoints,
          refunded_points: flowResult.billing.refundedPoints,
          anti_double_billing: flowResult.billing.antiDoubleBilling,
          net_charge_zero: flowResult.billing.netChargeZero,
          refund_idempotency: flowResult.billing.refundIdempotency,
          reasons: flowResult.billing.reasons,
        },
        supplier_cost: {
          passed: flowResult.supplierCost.passed,
          expected_cost_cny: flowResult.supplierCost.expectedCostCny,
          estimated_gross_profit_cny: flowResult.supplierCost.estimatedGrossProfitCny,
          gross_margin_label: flowResult.supplierCost.grossMarginLabel,
          reasons: flowResult.supplierCost.reasons,
        },
        diagnosis: {
          failure_category: flowResult.taskTracking.failureCategory,
          degraded_reason: flowResult.degradedReason,
          diagnostic_log: flowResult.diagnosticLog,
        },
        repro_package: reproPackage ? {
          severity: reproPackage.severity,
          title: reproPackage.title,
          curl_command: reproPackage.curlCommand,
          saved_files: reproPackage.savedFiles,
        } : undefined,
      };
    }

    if (input.action === 'audit_billing') {
      const taskId = typeof input.task_id === 'number' ? input.task_id : 0;
      const mediaType = (input.media_type === 'image' ? 'image' : 'video') as 'video' | 'image';
      const modelId = typeof input.model_id === 'number' ? input.model_id : (mediaType === 'video' ? 84 : 201);
      const expectedPoints = BillingOracle.calculateExpectedPoints({
        mediaType,
        modelId,
        duration: typeof input.duration === 'number' ? input.duration : undefined,
        resolution: typeof input.resolution === 'string' ? input.resolution : undefined,
        customPoints: typeof input.custom_points === 'number' ? input.custom_points : undefined,
      });
      const rawLogs = Array.isArray(input.score_logs) ? (input.score_logs as ScoreLogEntry[]) : [];
      const report = BillingOracle.reconcileTaskLedger({
        taskId,
        expectedPoints,
        terminalStatus: (input.terminal_status as any) || 'SUCCESS',
        scoreLogs: rawLogs,
        balanceBefore: typeof input.balance_before === 'number' ? input.balance_before : undefined,
        balanceAfter: typeof input.balance_after === 'number' ? input.balance_after : undefined,
      });

      return {
        ok: report.passed,
        status: report.status,
        task_id: taskId,
        expected_points: report.expectedPoints,
        pre_deducted_points: report.preDeductedPoints,
        refunded_points: report.refundedPoints,
        net_deducted_points: report.netDeductedPoints,
        invariants: {
          anti_double_billing: report.antiDoubleBilling,
          net_charge_zero: report.netChargeZero,
          refund_idempotency: report.refundIdempotency,
        },
        anomalies: {
          under_charged: report.underCharged,
          over_charged: report.overCharged,
          duplicate_charged: report.duplicateCharged,
          duplicate_refunded: report.duplicateRefunded,
          missing_refund: report.missingRefund,
        },
        ledger_entries: report.ledgerEntries,
        reasons: report.reasons,
      };
    }

    if (input.action === 'diagnose_diversion') {
      const mediaType = (input.media_type === 'image' ? 'image' : 'video') as 'video' | 'image';
      const modelId = typeof input.model_id === 'number' ? input.model_id : (mediaType === 'video' ? 84 : 201);
      const userGroupIds = Array.isArray(input.user_group_ids) ? (input.user_group_ids as number[]) : [10];
      const defaultMainConfig: MainSiteConfigSnapshot = {
        routeMode: 'newapi',
        globalModelIds: [88, 12],
        globalApiKey: 'test-global',
        globalRouteRules: {
          video: {
            84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
            88: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
            15: { resolutions: ['480p', '720p', '1080p', '4k'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
          },
        },
        groupRouteRules: {
          video: {
            panqu_test: {
              84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
              15: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
            },
          },
        },
        orgBindings: {
          10: { routeGroupId: 1, newapiGroup: 'panqu_test', status: 1, apiKey: 'test-org' },
        },
        ...((input.main_config as Partial<MainSiteConfigSnapshot>) || {}),
      };

      const mainVerdict = mediaType === 'video'
        ? RoutingOracle.evaluateVideoMainSite({
            videoType: 6,
            modelId,
            taskType: typeof input.task_type === 'number' ? input.task_type : 28,
            cueword: typeof input.prompt === 'string' ? input.prompt : 'devtest_prompt',
            resolution: typeof input.resolution === 'string' ? input.resolution : '720p',
            aspectRatio: typeof input.aspect_ratio === 'string' ? input.aspect_ratio : '16:9',
            userGroupIds,
          }, defaultMainConfig)
        : RoutingOracle.evaluateImageMainSite({
            selmodelsId: modelId,
            serviceline: typeof input.serviceline === 'string' ? input.serviceline : 'r',
            userGroupIds,
          }, defaultMainConfig);

      let gatewayVerdict: GatewayRoutingVerdict | undefined;
      if (mainVerdict.willDivert) {
        const tokenGroup = mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test';
        const targetModel = mainVerdict.expectedSnapshot?.newapiModel || (mediaType === 'video' ? 'wan3.0-video' : 'runninghub-nano-banana-2');
        const candidateChannels: GatewayChannelConfig[] = Array.isArray(input.channels)
          ? (input.channels as GatewayChannelConfig[])
          : [
              {
                id: 1,
                name: 'Wan-Primary',
                group: tokenGroup,
                models: [targetModel],
                status: 1,
                weight: 10,
                dailyQuotaLimit: 0,
                usedQuota: 0,
              },
            ];

        gatewayVerdict = RoutingOracle.evaluateGatewayRouting(
          tokenGroup,
          targetModel,
          10,
          candidateChannels,
        );
      }

      return {
        ok: mainVerdict.willDivert,
        decision: mainVerdict.willDivert ? 'DIVERTED' : 'DIRECT',
        raw_decision: mainVerdict.decision,
        line: mainVerdict.line,
        will_divert: mainVerdict.willDivert,
        reason: mainVerdict.reason,
        expected_snapshot: mainVerdict.expectedSnapshot,
        gateway: gatewayVerdict ? {
          candidate_channel_ids: gatewayVerdict.candidateChannelIds,
          allowed_channels: gatewayVerdict.allowedChannels,
          probabilities: gatewayVerdict.probabilities,
          rejected_reasons: gatewayVerdict.rejectedReasons,
          is_blocked_by_quota: gatewayVerdict.isBlockedByQuota,
        } : undefined,
      };
    }

    if (input.action === 'self_test_plan') {
      let requirement = typeof input.requirement === 'string' ? input.requirement : '';
      if (typeof input.requirement_file === 'string') {
        const file = await within(root, input.requirement_file);
        requirement = await readFile(file, 'utf8');
      }
      const modelId = typeof input.model_id === 'number' ? input.model_id : undefined;
      const mediaType = (input.media_type === 'image' ? 'image' : 'video') as 'video' | 'image';
      const flowType = typeof input.flow_type === 'string' ? (input.flow_type.toUpperCase() as 'DIVERSION' | 'DIRECT') : undefined;

      const plan = SelfTestPlanner.plan({
        requirement,
        flowType,
        modelSpec: modelId ? {
          modelId,
          modelType: mediaType,
          alias: typeof input.model_alias === 'string' ? input.model_alias : undefined,
        } : undefined,
        environment: (input.env as 'test' | 'preonline') || 'test',
      });

      return {
        ok: true,
        flow_type: plan.flowType,
        domain: plan.domain,
        scope: plan.scope,
        execution_mode: plan.executionMode,
        mode_reason: plan.modeReason,
        target_models: plan.targetModels,
        risks: plan.risks,
        scenario_count: plan.scenarios.length,
        scenarios: plan.scenarios.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          why_selected: s.whySelected,
          related_requirement: s.relatedRequirement,
          required_evidence: s.requiredEvidence,
          required_oracles: s.requiredOracles,
        })),
        dag_count: plan.executionDags.length,
      };
    }

    if (input.action === 'probe_environment') {
      const report = await EnvironmentProbe.probe({
        env: (input.env as 'test' | 'preonline') || 'test',
        baseUrl: typeof input.base_url === 'string' ? input.base_url : undefined,
        gatewayUrl: typeof input.gateway_url === 'string' ? input.gateway_url : undefined,
        sessionFile: typeof input.session_file === 'string' ? input.session_file : undefined,
        modelId: typeof input.model_id === 'number' ? input.model_id : undefined,
        mediaType: (input.media_type === 'image' ? 'image' : 'video') as 'video' | 'image',
        mock: input.mode !== 'real' && input.mode !== 'API_INTEGRATION',
        timeoutMs: typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined,
      });
      return {
        ok: report.ok,
        status: report.status,
        env: report.env,
        base_url: report.baseUrl,
        gateway_url: report.gatewayUrl,
        probed_at: report.probedAt,
        auth: report.auth,
        endpoints: report.endpoints,
        model_readiness: report.modelReadiness,
        recommendations: report.recommendations,
      };
    }

    if (input.action === 'export_repro') {
      const taskInfo = {
        taskId: typeof input.task_id === 'number' ? input.task_id : undefined,
        modelId: typeof input.model_id === 'number' ? input.model_id : 84,
        mediaType: (input.media_type === 'image' ? 'image' : 'video') as 'video' | 'image',
        duration: typeof input.duration === 'number' ? input.duration : undefined,
        resolution: typeof input.resolution === 'string' ? input.resolution : undefined,
        aspectRatio: typeof input.aspect_ratio === 'string' ? input.aspect_ratio : undefined,
        prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
        serviceline: typeof input.serviceline === 'string' ? input.serviceline : undefined,
        env: (input.env as string) || 'test',
      };
      const repro = await ReproExporter.generatePackage({
        caseId: typeof input.case_id === 'string' ? input.case_id : `REPRO-${Date.now()}`,
        failureCategory: typeof input.failure_category === 'string' ? input.failure_category : 'BILLING_ANOMALY',
        taskInfo,
        expected: (input.expected as any) || { billing: 'PASS' },
        actual: (input.actual as any) || { billing: 'FAIL' },
        reasons: Array.isArray(input.reasons) ? (input.reasons as string[]) : ['自测发现异常未通过门禁'],
        violatedInvariants: Array.isArray(input.violated_invariants) ? (input.violated_invariants as string[]) : [],
        scoreLogs: Array.isArray(input.score_logs) ? (input.score_logs as any[]) : [],
        outputDir: path.resolve(root, 'devtest-results/repro'),
      });
      return {
        ok: true,
        case_id: repro.caseId,
        severity: repro.severity,
        title: repro.title,
        curl_command: repro.curlCommand,
        playwright_script: repro.playwrightScript,
        markdown_report: repro.markdownReport,
        saved_files: repro.savedFiles,
      };
    }

    if (input.action === 'extract_model_matrix') {
      const panquRoot = typeof input.panqu_root === 'string' ? input.panqu_root : ModelMatrixExtractor.DEFAULT_PANQU_ROOT;
      if (typeof input.model_id === 'number') {
        const spec = await ModelMatrixExtractor.extractModel(input.model_id, panquRoot);
        const scenarios = spec ? ModelMatrixExtractor.generateSpecMatrixScenarios(spec) : [];
        return {
          ok: Boolean(spec),
          model_id: input.model_id,
          spec,
          scenarios,
        };
      }
      const all = await ModelMatrixExtractor.extractAll(panquRoot);
      return {
        ok: true,
        count: Object.keys(all).length,
        models: all,
      };
    }

    if (input.action === 'analyze_git_impact') {
      const report = await GitImpactAnalyzer.analyze({
        repoPath: typeof input.repo_path === 'string' ? input.repo_path : undefined,
        stagedOnly: Boolean(input.staged_only),
        changedFiles: Array.isArray(input.changed_files) ? (input.changed_files as string[]) : undefined,
      });
      return {
        ok: report.ok,
        repo_path: report.repoPath,
        impact_level: report.impactLevel,
        changed_files: report.changedFiles,
        affected_models: report.affectedModels,
        recommended_scenarios: report.recommendedScenarios,
        suggested_test_commands: report.suggestedTestCommands,
        summary: report.summary,
      };
    }

    if (input.action === 'watch_task') {
      const result = await TaskWatcher.watch({
        taskId: typeof input.task_id === 'number' ? input.task_id : undefined,
        modelId: typeof input.model_id === 'number' ? input.model_id : 84,
        mediaType: (input.media_type === 'image' ? 'image' : 'video') as 'video' | 'image',
        env: (input.env as string) || 'test',
        mock: input.mode !== 'real' && input.mode !== 'API_INTEGRATION',
        timeoutMs: typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined,
        pollIntervalMs: typeof input.poll_interval_ms === 'number' ? input.poll_interval_ms : undefined,
        simulateFailure: Boolean(input.simulate_failure),
        duration: typeof input.duration === 'number' ? input.duration : undefined,
        resolution: typeof input.resolution === 'string' ? input.resolution : undefined,
      });
      return {
        ok: result.ok,
        task_id: result.taskId,
        model_id: result.modelId,
        media_type: result.mediaType,
        final_status: result.finalStatus,
        duration_ms: result.durationMs,
        events: result.events,
        media_url: result.mediaUrl,
        media_inspection: result.mediaInspection ? {
          decodable: result.mediaInspection.decodable,
          format: result.mediaInspection.format,
          dimensions: result.mediaInspection.dimensions,
        } : undefined,
        billing_reconciliation: result.billingReconciliation ? {
          passed: result.billingReconciliation.passed,
          expected_points: result.billingReconciliation.expectedPoints,
          net_deducted_points: result.billingReconciliation.netDeductedPoints,
          net_charge_zero: result.billingReconciliation.netChargeZero,
        } : undefined,
        repro_package: result.reproPackage,
        summary: result.summary,
      };
    }

    if (input.action === 'simulate_chaos') {
      const result = await ChaosSimulator.simulate({
        chaosType: (input.chaos_type as ChaosFaultType) || 'UPSTREAM_429_RATE_LIMIT',
        modelId: typeof input.model_id === 'number' ? input.model_id : 84,
        mediaType: (input.media_type === 'image' ? 'image' : 'video') as 'video' | 'image',
        channels: Array.isArray(input.channels) ? (input.channels as any[]) : undefined,
        mock: input.mode !== 'real' && input.mode !== 'API_INTEGRATION',
      });
      return {
        ok: result.ok,
        chaos_type: result.chaosType,
        model_id: result.modelId,
        resilience_passed: result.resiliencePassed,
        initial_channel: result.initialChannel,
        failover_channel: result.failoverChannel,
        fallback_to_direct: result.fallbackToDirect,
        billing_reconciled: result.billingReconciled,
        invariants_checked: result.invariantsChecked,
        reasons: result.reasons,
        summary: result.summary,
      };
    }

    if (input.action === 'audit_config_drift') {
      const report = await ConfigDriftAuditor.audit({
        env: (input.env as string) || 'test',
        compareEnv: (input.compare_env as string) || 'online',
        repoPath: typeof input.repo_path === 'string' ? input.repo_path : undefined,
        checkUnpricedModels: input.check_unpriced_models !== false,
        mock: input.mode !== 'real' && input.mode !== 'API_INTEGRATION',
      });
      return {
        ok: report.ok,
        status: report.status,
        env: report.env,
        compare_env: report.compareEnv,
        drift_count: report.driftCount,
        issues: report.issues,
        summary: report.summary,
      };
    }

    if (input.action === 'audit_margin') {
      const modelId = typeof input.model_id === 'number' ? input.model_id : 84;
      const report = await MarginAuditor.auditModelMargin({
        modelId,
        mediaType: (input.media_type === 'image' ? 'image' : 'video') as 'video' | 'image',
        duration: typeof input.duration === 'number' ? input.duration : undefined,
        effectiveCnyPerPoint: typeof input.effective_cny_per_point === 'number' ? input.effective_cny_per_point : undefined,
        targetMarginPercent: typeof input.target_margin_percent === 'number' ? input.target_margin_percent : undefined,
        resolutions: Array.isArray(input.resolutions) ? (input.resolutions as string[]) : undefined,
        customPoints: (input.custom_points_map as Record<string, number>) || undefined,
        repoPath: typeof input.repo_path === 'string' ? input.repo_path : (typeof input.panqu_root === 'string' ? input.panqu_root : undefined),
      });

      return {
        ok: report.ok,
        gate_passed: report.gatePassed,
        model_id: report.modelId,
        model_name: report.modelName,
        media_type: report.mediaType,
        flow_type: report.flowType,
        overall_status: report.overallStatus,
        target_margin_percent: report.targetMarginPercent,
        resolutions: report.resolutions,
        blockers: report.blockers,
        recommendations: report.recommendations,
        summary: report.summary,
      };
    }

    if (input.action === 'review_pr') {
      const repoPath = typeof input.repo_path === 'string' ? input.repo_path : (typeof input.panqu_root === 'string' ? input.panqu_root : undefined);
      const result = await CiPrGate.run({
        repoPath,
        baseRef: typeof input.base_ref === 'string' ? input.base_ref : undefined,
        changedFiles: Array.isArray(input.changed_files) ? (input.changed_files as string[]) : undefined,
        targetModels: Array.isArray(input.target_models) ? (input.target_models as number[]) : undefined,
        targetMarginPercent: typeof input.target_margin_percent === 'number' ? input.target_margin_percent : undefined,
        effectiveCnyPerPoint: typeof input.effective_cny_per_point === 'number' ? input.effective_cny_per_point : undefined,
        env: (input.env as string) || 'test',
        outputPrCommentPath: typeof input.output_pr_comment_path === 'string' ? input.output_pr_comment_path : undefined,
        mock: input.mode !== 'real' && input.mode !== 'API_INTEGRATION',
        pullNumber: typeof input.pull_number === 'number' ? input.pull_number : undefined,
        filePatches: Array.isArray(input.file_patches) ? (input.file_patches as any[]) : undefined,
      });
      return {
        ok: result.ok,
        gate_passed: result.gatePassed,
        conclusion: result.conclusion,
        summary: result.summary,
        impact_level: result.gitImpact.impactLevel,
        affected_models: result.gitImpact.affectedModels,
        blockers: result.blockers,
        warnings: result.warnings,
        recommendations: result.recommendations,
        markdown_report: result.markdownReport,
        github_review_event: result.githubReviewEvent,
        line_comments: result.lineComments,
        github_mcp_payload: result.githubMcpPayload,
        trae_next_action: result.traeNextAction,
      };
    }

    if (input.action === 'propose_fix_pr') {
      const modelId = typeof input.model_id === 'number' ? input.model_id : 84;
      const repoPath = typeof input.repo_path === 'string' ? input.repo_path : (typeof input.panqu_root === 'string' ? input.panqu_root : undefined);
      const result = await AutoFixPrEngine.generateFixPr({
        modelId,
        mediaType: (input.media_type === 'image' ? 'image' : 'video') as 'video' | 'image',
        issueType: (input.issue_type as any) || 'AUTO',
        targetMarginPercent: typeof input.target_margin_percent === 'number' ? input.target_margin_percent : undefined,
        effectiveCnyPerPoint: typeof input.effective_cny_per_point === 'number' ? input.effective_cny_per_point : undefined,
        baseBranch: typeof input.base_branch === 'string' ? input.base_branch : undefined,
        repoOwner: typeof input.repo_owner === 'string' ? input.repo_owner : undefined,
        repoName: typeof input.repo_name === 'string' ? input.repo_name : undefined,
        repoPath,
        customBeforePoints: (input.custom_points_map as Record<string, number>) || undefined,
      });

      return {
        ok: result.ok,
        model_id: result.modelId,
        model_name: result.modelName,
        branch_name: result.branchName,
        commit_message: result.commitMessage,
        pr_title: result.prTitle,
        pr_body: result.prBody,
        file_changes: result.fileChanges,
        pricing_comparison: result.pricingComparison,
        github_mcp_actions: result.githubMcpActions,
        summary: result.summary,
        trae_next_instruction: '请使用 GitHub MCP 依次调用 github_mcp_actions 中的工具完成分支提交并创建 PR',
      };
    }

    if (input.action === 'report_check_run') {
      const repoPath = typeof input.repo_path === 'string' ? input.repo_path : (typeof input.panqu_root === 'string' ? input.panqu_root : undefined);
      const gateResult = await CiPrGate.run({
        repoPath,
        baseRef: typeof input.base_ref === 'string' ? input.base_ref : undefined,
        changedFiles: Array.isArray(input.changed_files) ? (input.changed_files as string[]) : undefined,
        targetMarginPercent: typeof input.target_margin_percent === 'number' ? input.target_margin_percent : undefined,
        effectiveCnyPerPoint: typeof input.effective_cny_per_point === 'number' ? input.effective_cny_per_point : undefined,
        env: (input.env as string) || 'test',
        mock: input.mode !== 'real' && input.mode !== 'API_INTEGRATION',
        pullNumber: typeof input.pull_number === 'number' ? input.pull_number : undefined,
        filePatches: Array.isArray(input.file_patches) ? (input.file_patches as any[]) : undefined,
      });

      const headSha = typeof input.head_sha === 'string' && input.head_sha ? input.head_sha : 'HEAD';
      const checkRunResult = GitHubCheckRunAdapter.buildCheckRunResult({
        headSha,
        pullNumber: typeof input.pull_number === 'number' ? input.pull_number : undefined,
        repoOwner: typeof input.repo_owner === 'string' ? input.repo_owner : undefined,
        repoName: typeof input.repo_name === 'string' ? input.repo_name : undefined,
        checkName: typeof input.check_name === 'string' ? input.check_name : undefined,
        conclusion: gateResult.conclusion,
        markdownReport: gateResult.markdownReport,
        gitImpact: gateResult.gitImpact,
        configDrift: gateResult.configDrift,
        marginAudits: gateResult.marginAudits,
        changedFiles: gateResult.gitImpact.changedFiles,
        filePatches: Array.isArray(input.file_patches) ? (input.file_patches as any[]) : undefined,
        targetMarginPercent: typeof input.target_margin_percent === 'number' ? input.target_margin_percent : undefined,
      });

      return {
        ok: gateResult.ok,
        gate_passed: gateResult.gatePassed,
        conclusion: checkRunResult.conclusion,
        head_sha: headSha,
        check_name: checkRunResult.checkRunPayload.name,
        check_run_payload: checkRunResult.checkRunPayload,
        commit_status_payload: checkRunResult.commitStatusPayload,
        annotations_count: checkRunResult.annotationsCount,
        github_mcp_actions: checkRunResult.githubMcpActions,
        summary: checkRunResult.summaryMarkdown,
        trae_next_instruction: '请使用 GitHub MCP 优先调用 create_check_run 工具上报 Checks 状态与 Annotations；若权限受限可降级调用 create_commit_status。',
      };
    }

    if (input.action === 'handle_pr_command') {
      const commentBody = typeof input.comment_body === 'string' ? input.comment_body : '';
      const result = await PrCommentCommandHandler.execute({
        commentBody,
        commentAuthor: typeof input.comment_author === 'string' ? input.comment_author : undefined,
        pullNumber: typeof input.pull_number === 'number' ? input.pull_number : undefined,
        headSha: typeof input.head_sha === 'string' ? input.head_sha : undefined,
        repoOwner: typeof input.repo_owner === 'string' ? input.repo_owner : undefined,
        repoName: typeof input.repo_name === 'string' ? input.repo_name : undefined,
        targetMarginPercent: typeof input.target_margin_percent === 'number' ? input.target_margin_percent : undefined,
        changedFiles: Array.isArray(input.changed_files) ? (input.changed_files as string[]) : undefined,
        filePatches: Array.isArray(input.file_patches) ? (input.file_patches as any[]) : undefined,
        mock: input.mode !== 'real' && input.mode !== 'API_INTEGRATION',
      });

      return {
        ok: result.ok,
        command_type: result.type,
        command_name: result.command.commandName,
        model_id: result.command.modelId,
        target_margin_percent: result.command.targetMarginPercent,
        pull_number: result.command.pullNumber,
        reply_markdown: result.replyMarkdown,
        github_mcp_actions: result.githubMcpActions,
        summary: result.summary,
        trae_next_instruction: result.githubMcpActions.length > 0
          ? '请按顺序调用 github_mcp_actions 中的 GitHub MCP 工具（如 create_issue_comment / create_check_run / create_pull_request），完成 PR 交互与自动化闭环。'
          : '该评论未触发任何 GitHub MCP 动作。',
      };
    }

    if (input.action === 'post_merge_release') {
      const pullNumber = typeof input.pull_number === 'number' ? input.pull_number : 0;
      const repoPath = typeof input.repo_path === 'string' ? input.repo_path : (typeof input.panqu_root === 'string' ? input.panqu_root : undefined);
      const result = await PostMergeLifecycleEngine.execute({
        pullNumber,
        mergedCommitSha: typeof input.merged_commit_sha === 'string' ? input.merged_commit_sha : undefined,
        associatedIssueNumbers: Array.isArray(input.associated_issue_numbers) ? (input.associated_issue_numbers as number[]) : undefined,
        tagName: typeof input.tag_name === 'string' ? input.tag_name : undefined,
        releaseName: typeof input.release_name === 'string' ? input.release_name : undefined,
        targetModels: Array.isArray(input.target_models) ? (input.target_models as number[]) : undefined,
        compareEnv: typeof input.compare_env === 'string' ? input.compare_env : undefined,
        targetMarginPercent: typeof input.target_margin_percent === 'number' ? input.target_margin_percent : undefined,
        repoOwner: typeof input.repo_owner === 'string' ? input.repo_owner : undefined,
        repoName: typeof input.repo_name === 'string' ? input.repo_name : undefined,
        repoPath,
        mock: input.mode !== 'real' && input.mode !== 'API_INTEGRATION',
      });

      return {
        ok: result.ok,
        pull_number: result.pullNumber,
        merged_commit_sha: result.mergedCommitSha,
        tag_name: result.tagName,
        release_name: result.releaseName,
        drift_passed: result.driftPassed,
        margin_passed: result.marginPassed,
        closed_issues: result.closedIssues,
        release_notes: result.releaseNotes,
        github_mcp_actions: result.githubMcpActions,
        summary: result.summary,
        trae_next_instruction: '请使用 GitHub MCP 按顺序依次调用 github_mcp_actions 完成关联 Issue 关闭、Release Tag 发布及 PR 归档记录。',
      };
    }

    if (input.action === 'export_ci_workflow') {
      const yamlContent = CiPrGate.generateWorkflowYaml();
      const targetPath = typeof input.workflow_path === 'string'
        ? input.workflow_path
        : await within(root, '.github/workflows/test-flow-ci.yml', false);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, yamlContent, 'utf8');
      return {
        ok: true,
        workflow_path: targetPath,
        yaml_content: yamlContent,
        message: `CI 工作流配置已成功导出至 ${targetPath}`,
      };
    }

    const output = await within(root, config.runtime.output, false);
    const storage = await within(root, path.relative(root, path.join(output, '.mcp')), false);
    await mkdir(storage, { recursive: true, mode: 0o700 });

    // Serialize plans/runs across processes to protect shared test state and baselines.
    const lockFile = path.join(storage, 'execution.lock');
    if (input.action === 'status') {
      const planId = token(input.plan_id, 'plan_id');
      const record = JSON.parse(await readFile(await within(root, path.relative(root, path.join(storage, `${planId}.json`))), 'utf8')) as PlanRecord;
      try {
        const run = JSON.parse(await readFile(await within(root, path.relative(root, path.join(storage, `${planId}.run.json`))), 'utf8')) as RunRecord;
        return { ok: run.state === 'COMPLETED', plan_id: planId, status: run.state, ...run.result };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return { ok: true, plan_id: planId, plan_hash: record.planHash, status: 'NOT_EXECUTED', ...record.preview };
      }
    }
    let lock;
    try { lock = await open(lockFile, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('RUN_IN_PROGRESS: project is locked; query status before retrying');
      throw error;
    }
    try {
      if (input.action === 'plan') {
        if (typeof input.requirement !== 'string' || !/\.(?:md|txt)$/i.test(input.requirement)) throw new Error('INVALID_INPUT: repository-relative requirement file is required');
        const file = await within(root, input.requirement);
        const markdown = await readFile(file, 'utf8');
        const contextDigest = await this.contextDigest(root, config);
        const targetDigest = await this.targetDigest(root, config);
        const result = await runDevTest({ markdown, documentId: input.requirement, projectRoot: root,
          project: path.basename(root), environment: config.runtime.environment,
          baseUrl: process.env[config.runtime.baseUrlEnv] || undefined, mode: 'SAFE', plan: true, outDir: output });
        const unsigned = {
          executionPolicy: EXECUTION_POLICY,
          planId: `PLAN-${randomUUID()}`, requirement: input.requirement, sourceDigest: digest(markdown),
          configDigest: digest(JSON.stringify(config)), contextDigest, targetDigest, executionPlan: result.executionPlan,
        };
        const record: PlanRecord = { ...unsigned, planHash: planHash(unsigned), preview: summary(result, root) };
        await atomicJson(path.join(storage, `${record.planId}.json`), record);
        return { ok: true, status: 'NOT_EXECUTED', plan_id: record.planId, plan_hash: record.planHash, ...record.preview };
      }

      const planId = token(input.plan_id, 'plan_id');
      const idempotencyKey = token(input.idempotency_key, 'idempotency_key');
      const record = JSON.parse(await readFile(await within(root, path.relative(root, path.join(storage, `${planId}.json`))), 'utf8')) as PlanRecord;
      const { preview: _preview, planHash: expectedHash, ...unsigned } = record;
      if (record.executionPolicy !== EXECUTION_POLICY) throw new Error('STALE_PLAN: execution policy changed; create a new plan');
      if (planHash(unsigned) !== expectedHash || expectedHash !== input.expected_plan_hash || record.planId !== planId) throw new Error('STALE_PLAN: confirmation does not match the saved plan');
      const runFile = await within(root, path.relative(root, path.join(storage, `${planId}.run.json`)), false);
      let previous: RunRecord | undefined;
      try { previous = JSON.parse(await readFile(runFile, 'utf8')) as RunRecord; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (previous) {
        if (previous.idempotencyKey !== idempotencyKey) throw new Error('PLAN_ALREADY_EXECUTED: create a new plan for a new execution');
        return { ok: previous.state === 'COMPLETED', status: previous.state, plan_id: planId, replayed: true, ...previous.result };
      }
      const markdown = await readFile(await within(root, record.requirement), 'utf8');
      if (digest(markdown) !== record.sourceDigest || digest(JSON.stringify(config)) !== record.configDigest
        || await this.contextDigest(root, config) !== record.contextDigest
        || await this.targetDigest(root, config) !== record.targetDigest) throw new Error('STALE_PLAN: requirement, config, project source or runtime target changed; create a new plan');
      // The first implementation exposes read-only local execution. Business writes remain in the approved CI path.
      await atomicJson(runFile, { state: 'RUNNING', idempotencyKey });
      try {
        const runtime = await loadDevTestRuntime({ root, environment: config.runtime.environment,
          moduleRef: process.env[config.runtime.runtimeModuleEnv] });
        const headersRaw = process.env[config.runtime.actorHeadersEnv];
        const headers = headersRaw ? JSON.parse(headersRaw) as Record<string, Record<string, string>> : {};
        const result = await runDevTest({ ...runtime, actorHeaders: { ...headers, ...runtime.actorHeaders },
          markdown, documentId: record.requirement, projectRoot: root, project: path.basename(root),
          baseUrl: process.env[config.runtime.baseUrlEnv] || undefined, environment: config.runtime.environment,
          mode: 'SAFE', confirmMutations: false, sandbox: false, expectedExecutionPlan: record.executionPlan,
          outDir: output, maxRuntimeMs: 15 * 60 * 1000 });
        const outcome = { ...summary(result, root), status: result.conclusion === 'BLOCKED' ? 'BLOCKED' : 'COMPLETED' };
        await atomicJson(runFile, { state: 'COMPLETED', idempotencyKey, result: outcome });
        return { ok: true, plan_id: planId, ...outcome };
      } catch (error) {
        const outcome = artifactSafe({ status: 'BLOCKED', message: (error as Error).message }) as Record<string, unknown>;
        await atomicJson(runFile, { state: 'BLOCKED', idempotencyKey, result: outcome });
        return { ok: false, plan_id: planId, ...outcome };
      }
    } finally {
      await lock.close();
      await rm(lockFile);
    }
  }
}
