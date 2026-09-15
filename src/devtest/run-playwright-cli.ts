/**
 * Panqu Playwright 闭环测试命令行运行器（Playwright Flow CLI Runner）
 *
 * 用法示例：
 *   # 运行受控模拟闭环测试（覆盖成功、分流、产物、对账）
 *   node dist/src/devtest/run-playwright-cli.js --mock --media video
 *   node dist/src/devtest/run-playwright-cli.js --mock --media image
 *   node dist/src/devtest/run-playwright-cli.js --mock --media video --expect-failure
 *
 *   # 真实测试环境端到端验证（需测试预算与会话）
 *   node dist/src/devtest/run-playwright-cli.js --media video --model 84 --env test
 *   node dist/src/devtest/run-playwright-cli.js --media image --model 201 --env test
 */

import path from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import {
  runPanquPlaywrightFlow,
  sanitizeSensitiveText,
  createSyntheticValidMp4,
  type PlaywrightFlowRunOptions,
  type FlowRunEvidence,
} from './panqu-playwright-engine.js';
import { STANDARD_RECHARGE_PRESETS } from './supplier-cost-oracle.js';
import { SelfTestPlanner } from './self-test-planner.js';
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
import type { DevTestFlowType } from './types.js';

export const PLAYWRIGHT_HELP = `Panqu Playwright flow

Usage: devtest playwright [options]
  --help                         Show this help; no test or network request
  --mock                         Use synthetic evidence only
  --mode api|browser|mock         Default: api (real requests, may incur charges)
  --media video|image            Default: video
  --task-id <id>                 Inspect an existing task
  --model <id> --task-type <id>   Select model and task type
  --prompt <text>                Test prompt; never include credentials
  --duration <seconds> --resolution <value> --aspect <ratio>
  --serviceline <value>          Image service line
  --env test|preonline           Default: test
  --timeout <seconds>            Poll timeout
  --session-file <absolute-path> Session JSON path, not its contents
  --output <directory>           Markdown report and JSON evidence directory
  --expect-failure               Expect and assert failure refund
  --flow diversion|direct        Specify flow type (DIVERSION: existing model; DIRECT: new model)
  --requirement <file>           Auto-generate and execute flow based on requirement document
  --onboard-model <id>           Test onboarding of a new model with auto-planned scenarios
  --alias <name>                 Model alias for --onboard-model
  --plan-only                    Only output the auto-generated test plan without executing
  --global                       Mark onboarded model as global (is_newapi_global=1)
  --probe-env                    Probe target environment health, endpoints and diversion readiness
  --export-repro                 Export standalone cURL & Playwright reproduction package on failure
  --extract-matrix [model_id]    Extract capability specification matrix from panqu-ai codebase
  --diff-impact                  Analyze git diff impact and identify affected models
  --watch-task [id]              Watch long-running task progress and auto-reconcile media/billing
  --chaos [type]                 Simulate gateway multi-channel fault and resilience failover
  --audit-drift                  Audit configuration and pricing drift across environments
  --audit-margin [model_id]      Audit revenue, supplier cost and margin gate for models
  --ci-gate                      Run PR/CI automated quality & margin review gate
  --fix-pr [model_id]            Generate pricing auto-fix PR payload via GitHub MCP
  --check-run [commit_sha]       Generate native GitHub Check Run payload with annotations
  --pr-command <text>            Parse and execute PR slash command (/retest, /fix 84, /audit 84)
  --comment-author <name>        Comment author username (default: developer)
  --post-merge                   Run post-merge production verification, close issues and create release
  --issues <ids>                 Associated GitHub Issue numbers (e.g. 38,39)
  --tag <name>                   Release tag name (e.g. v1.2.0)

Real execution requires explicit task authorization and budget. Mock is not
business acceptance. Browser mode does not imply complete form/upload UI coverage.
`;

// 标准测试媒体 Buffer（用于受控快速自验，包含完整容器与元数据）
const MOCK_MP4_HEADER = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });

const MOCK_PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x00, 0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const CLI_VALUE_FLAGS = new Set(['--media','--mode','--task-id','--model','--task-type','--prompt',
  '--duration','--resolution','--aspect','--serviceline','--env','--timeout','--output','--session-file',
  '--model-id','--model-type','--poll-timeout','--aspect-ratio','--project-root',
  '--flow','--requirement','--onboard-model','--alias','--base','--output-pr-comment','--pr','--check-run','--check-name',
  '--pr-command','--comment-author','--issues','--tag']);

export interface PlaywrightCliParsedOptions extends PlaywrightFlowRunOptions {
  isMock: boolean;
  flowType?: DevTestFlowType;
  requirementPath?: string;
  onboardModelId?: number;
  modelAlias?: string;
  planOnly?: boolean;
  isGlobalModel?: boolean;
  probeEnv?: boolean;
  exportRepro?: boolean;
  extractMatrix?: boolean;
  diffImpact?: boolean;
  watchTaskId?: number;
  chaosType?: string;
  auditDrift?: boolean;
  auditMargin?: boolean;
  ciGate?: boolean;
  baseRef?: string;
  outputPrCommentPath?: string;
  initCi?: boolean;
  pullNumber?: number;
  fixPr?: boolean;
  checkRun?: boolean;
  headSha?: string;
  checkName?: string;
  prCommand?: string;
  commentAuthor?: string;
  postMerge?: boolean;
  associatedIssues?: number[];
  tagName?: string;
}

export function isLegacyPlaywrightCommand(argv: string[]): boolean {
  if (argv[0] !== 'flow') return false;
  if (argv[1] === 'playwright-diversion') return true;
  if (argv[1] !== 'api-diversion') return false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--playwright') return true;
    if (CLI_VALUE_FLAGS.has(argv[i])) i++;
  }
  return false;
}

/** Preserve legacy Mock-by-default semantics while forwarding all supported options. */
export function normalizeLegacyPlaywrightArgs(args: string[]): string[] {
  const aliases: Record<string,string> = {'--model-id':'--model','--model-type':'--media',
    '--poll-timeout':'--timeout','--aspect-ratio':'--aspect'};
  const normalized: string[] = [];
  let real = false, explicitMode = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--playwright') continue;
    if (arg === '--real-submit') { real = true; continue; }
    if (arg === '--project-root') throw new Error('PLAYWRIGHT_ARG_INVALID: use the working directory or MCP project_root, not --project-root');
    if (arg === '--mode' || arg === '--mock') explicitMode = true;
    normalized.push(aliases[arg] ?? arg);
    if (CLI_VALUE_FLAGS.has(arg) && args[i + 1] !== undefined) {
      const value = args[++i];
      normalized.push(arg === '--env' && value === 'sandbox' ? 'test' : value);
    }
  }
  if (!explicitMode) normalized.unshift(real ? '--mode' : '--mock', ...(real ? ['api'] : []));
  return normalized;
}

export function parseCliArgs(args: string[]): PlaywrightCliParsedOptions {
  const options: PlaywrightCliParsedOptions = {
    mediaType: 'video',
    env: 'test',
    outputDir: path.resolve(process.cwd(), 'devtest-results'),
    isMock: false,
    executionMode: 'API_INTEGRATION',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--media' && args[i + 1]) {
      options.mediaType = args[++i] as 'video' | 'image';
    } else if (arg === '--mode' && args[i + 1]) {
      const modeStr = args[++i].toLowerCase();
      if (modeStr === 'browser' || modeStr === 'ui' || modeStr === 'ui_e2e') {
        options.executionMode = 'UI_E2E';
        options.useBrowserPage = true;
      } else if (modeStr === 'api' || modeStr === 'api_integration') {
        options.executionMode = 'API_INTEGRATION';
        options.useBrowserPage = false;
      } else if (modeStr === 'mock') {
        options.executionMode = 'MOCK';
        options.isMock = true;
      } else {
        throw new Error('PLAYWRIGHT_ARG_INVALID: --mode must be api, browser, or mock');
      }
    } else if (arg === '--task-id' && args[i + 1]) {
      options.taskId = Number(args[++i]);
    } else if (arg === '--model' && args[i + 1]) {
      options.modelId = Number(args[++i]);
    } else if (arg === '--task-type' && args[i + 1]) {
      options.taskType = Number(args[++i]);
    } else if (arg === '--prompt' && args[i + 1]) {
      options.prompt = args[++i];
    } else if (arg === '--duration' && args[i + 1]) {
      options.duration = Number(args[++i]);
    } else if (arg === '--resolution' && args[i + 1]) {
      options.resolution = args[++i];
    } else if (arg === '--aspect' && args[i + 1]) {
      options.aspectRatio = args[++i];
    } else if (arg === '--serviceline' && args[i + 1]) {
      options.serviceline = args[++i];
    } else if (arg === '--env' && args[i + 1]) {
      options.env = args[++i] as 'test' | 'preonline';
    } else if (arg === '--timeout' && args[i + 1]) {
      options.pollTimeoutSec = Number(args[++i]);
    } else if (arg === '--output' && args[i + 1]) {
      options.outputDir = path.resolve(args[++i]);
    } else if (arg === '--session-file' && args[i + 1]) {
      const sessionFile = args[++i];
      if (!path.isAbsolute(sessionFile)) throw new Error('PLAYWRIGHT_ARG_INVALID: --session-file must be absolute');
      options.sessionFile = sessionFile;
    } else if (arg === '--mock') {
      options.isMock = true;
      options.executionMode = 'MOCK';
    } else if (arg === '--expect-failure') {
      options.expectFailure = true;
    } else if (arg === '--flow' && args[i + 1]) {
      const flowVal = args[++i].toUpperCase();
      if (flowVal === 'DIVERSION' || flowVal === 'DIRECT') {
        options.flowType = flowVal;
      } else {
        throw new Error('PLAYWRIGHT_ARG_INVALID: --flow must be diversion or direct');
      }
    } else if (arg === '--requirement' && args[i + 1]) {
      options.requirementPath = path.resolve(args[++i]);
    } else if (arg === '--onboard-model' && args[i + 1]) {
      options.onboardModelId = Number(args[++i]);
    } else if (arg === '--alias' && args[i + 1]) {
      options.modelAlias = args[++i];
    } else if (arg === '--plan-only') {
      options.planOnly = true;
    } else if (arg === '--global') {
      options.isGlobalModel = true;
    } else if (arg === '--probe-env') {
      options.probeEnv = true;
    } else if (arg === '--export-repro') {
      options.exportRepro = true;
    } else if (arg === '--extract-matrix') {
      options.extractMatrix = true;
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        options.modelId = Number(args[++i]);
      }
    } else if (arg === '--diff-impact' || arg === '--impact') {
      options.diffImpact = true;
    } else if (arg === '--watch-task') {
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        options.watchTaskId = Number(args[++i]);
      } else {
        options.watchTaskId = 0; // 0 indicates watch newly generated task
      }
    } else if (arg === '--chaos') {
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        options.chaosType = args[++i];
      } else {
        options.chaosType = 'UPSTREAM_429_RATE_LIMIT';
      }
    } else if (arg === '--audit-drift') {
      options.auditDrift = true;
    } else if (arg === '--audit-margin' || arg === '--margin') {
      options.auditMargin = true;
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        options.modelId = Number(args[++i]);
      }
    } else if (arg === '--ci-gate' || arg === '--pr-gate') {
      options.ciGate = true;
    } else if (arg === '--base' && args[i + 1]) {
      options.baseRef = args[++i];
    } else if (arg === '--output-pr-comment' && args[i + 1]) {
      options.outputPrCommentPath = path.resolve(args[++i]);
    } else if (arg === '--init-ci') {
      options.initCi = true;
    } else if (arg === '--pr' && args[i + 1]) {
      options.pullNumber = Number(args[++i]);
    } else if (arg === '--fix-pr' || arg === '--propose-pr') {
      options.fixPr = true;
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        options.modelId = Number(args[++i]);
      }
    } else if (arg === '--check-run' || arg === '--report-check') {
      options.checkRun = true;
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        options.headSha = args[++i];
      }
    } else if (arg === '--check-name' && args[i + 1]) {
      options.checkName = args[++i];
    } else if (arg === '--pr-command' && args[i + 1]) {
      options.prCommand = args[++i];
    } else if (arg === '--comment-author' && args[i + 1]) {
      options.commentAuthor = args[++i];
    } else if (arg === '--post-merge') {
      options.postMerge = true;
    } else if (arg === '--issues' && args[i + 1]) {
      const issueStr = args[++i];
      options.associatedIssues = issueStr.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    } else if (arg === '--tag' && args[i + 1]) {
      options.tagName = args[++i];
    } else {
      throw new Error('PLAYWRIGHT_ARG_INVALID: unknown option or missing value');
    }
  }

  if (!['video', 'image'].includes(options.mediaType ?? 'video')
    || !['test', 'preonline'].includes(options.env ?? 'test')) {
    throw new Error('PLAYWRIGHT_ARG_INVALID: unsupported media or environment');
  }
  for (const value of [options.taskId, options.modelId, options.taskType, options.duration, options.pollTimeoutSec]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error('PLAYWRIGHT_ARG_INVALID: numeric options must be positive');
    }
  }
  // An explicit mock flag cannot be undone by later mode arguments.
  if (options.isMock) {
    options.executionMode = 'MOCK';
    options.useBrowserPage = false;
  }

  return options;
}

export function renderEvidenceMarkdown(report: FlowRunEvidence): string {
  const isVideo = report.mediaType === 'video';
  const levelDescriptions: Record<string, string> = {
    BROWSER_PIXEL_DECODED: '✅ 浏览器端真实像素解码完成 (已渲染验证)',
    CONTAINER_METADATA_VERIFIED: '✅ 容器结构与元数据校验通过 (已解析 MP4 Box 树/PNG IHDR，未做像素全流解码)',
    HTTP_ACCESSIBLE_ONLY: '⚠️ 仅验证 HTTP 200 可达 (元数据未完全解析)',
    SKIPPED_ON_FAILURE: '✅ 业务失败分支优雅跳过 (直接进入退款审计)',
    UNVERIFIED: '❌ 未完成有效物理校验',
  };

  const assertionExplanation = report.testAssertionStatus === 'PASS'
    ? '任务端到端生成、分流与账单全部校验通过。'
    : report.testAssertionStatus === 'BLOCKED'
      ? '前置条件或观察凭证不足，无法完成闭环断言。'
      : '关键业务断言或产物校验失败，存在系统缺陷。';
  const businessImpactExplanation = report.overallStatus === 'PASS'
    ? '用户可正常提交生成并获取合法产物，平台通道调度与资金流水合规。'
    : '用户端可能面临生成失败、成片损坏或发生计费资损风险。';
  const diversionExplanation = report.diversion.passed
    ? `已成功命中预期渠道 (${report.diversion.actualChannel})。`
    : `未命中预期渠道或缺少快照凭据 (${report.diversion.status})。`;
  const billingExplanation = report.billing.passed
    ? '扣费流水、退款幂等与净扣归零均校验合规。'
    : `存在计费流水偏差或缺少对账凭据 (${report.billing.reasons.join('；') || '未完全对账'})。`;
  const nextRole = report.overallStatus === 'PASS' ? '测试负责人 / 产品经理' : '对应业务模块研发';
  const nextStepAction = report.overallStatus === 'PASS' ? '确认结果并归档验收凭证。' : '对照下方提交参数、状态机时间线与分流快照排查修复。';

  return `# Panqu Playwright 闭环自测报告

- **用例编号**: \`${report.caseId}\`
- **运行 ID**: \`${report.runId}\`
- **媒体类型**: \`${report.mediaType.toUpperCase()}\`
- **执行模式**: \`${report.executionMode}\`${report.degradedFromBrowser ? ' *(⚠️ 浏览器不可用已安全降级为 API 模式，禁止视作页面 E2E 通过)*' : ''}
- **业务任务终态**: \`${report.businessTaskStatus || report.taskTracking.terminalStatus}\`
- **测试断言判定**: **${report.testAssertionStatus === 'PASS' ? '✅ 通过 (PASS)' : report.testAssertionStatus === 'BLOCKED' ? '⏸ 阻塞 (BLOCKED)' : '❌ 失败 (FAIL)'}**
- **开始时间**: \`${report.startedAt}\`
- **结束时间**: \`${report.finishedAt}\`

---

## ⏱️ 一、30 秒业务与质量速览 (Product & Ops View)

| 评估项 | 结果判定 | 通俗业务影响说明 |
| :--- | :---: | :--- |
| **测试断言结论** | **${report.testAssertionStatus}** | ${assertionExplanation} |
| **业务可用性评估** | ${report.overallStatus === 'PASS' ? '🟢 链路正常' : '🔴 链路异常'} | ${businessImpactExplanation} |
| **分流安全核查** | ${report.diversion.passed ? '🟢 正常命中' : '⚠️ 分流异常'} | ${diversionExplanation} |
| **资金对账核查** | ${report.billing.passed ? '🟢 流水安全' : '🔴 账务异常'} | ${billingExplanation} |
| **下一步指引** | \`${nextRole}\` | ${nextStepAction} |

---

## 🛠️ 二、研发执行取证与现场详情 (Developer View)

### 1. 页面提交与任务关联

| 属性 | 结果 | 说明 |
| :--- | :--- | :--- |
| **任务 ID (taskId)** | \`${report.taskId ?? 'N/A'}\` | 响应拦截提取，严禁猜测 |
| **提交接口** | \`${report.submission.url}\` | HTTP ${report.submission.responseStatus} |
| **提交通道** | \`${report.submission.submissionTransport || 'API_REQUEST'}\` | ${report.submission.submissionTransport === 'BROWSER_PAGE' ? '真实浏览器页面网络拦截' : '直接 HTTP 请求上下文'} |
| **业务返回码** | \`${report.submission.responseCode}\` (${sanitizeSensitiveText(report.submission.responseMsg || 'ok').split('\n')[0].replace(/\|/g, '/').trim().slice(0, 100)}) | code === 1 判定成功 |
| **提交耗时** | \`${report.submission.durationMs}ms\` | 网络响应时间 |

---

## 2. 异步状态机跟踪

- **轮询次数**: ${report.taskTracking.pollCount} 次
- **最终状态**: \`${report.taskTracking.terminalStatus}\`
- **耗时**: \`${report.taskTracking.durationMs}ms\`
${report.taskTracking.failureCategory ? `- **失败分类**: \`${report.taskTracking.failureCategory}\`` : ''}

### 状态变化时间线
| 时间 | 状态码 | 进度 | 阶段说明 |
| :--- | :--- | :--- | :--- |
${report.taskTracking.timeline.map((t) => `| ${t.timestamp.slice(11, 19)} | ${t.status} | ${t.progress}% | ${t.label} |`).join('\n')}

---

## 3. 实际分流独立核查

- **分流核查判定**: **${report.diversion.passed ? '✅ 通过' : '❌ 未达成'}** (状态: \`${report.diversion.status}\`)
- **证据置信状态**: \`${report.diversion.evidenceState}\`
- **预期分流渠道**: \`${report.diversion.expectedChannels?.join(', ') || (Array.isArray(report.diversion.expectedChannel) ? report.diversion.expectedChannel.join(', ') : report.diversion.expectedChannel || '(未指定)')}\`
- **实际分流线路**: \`${report.diversion.actualChannel}\` (命中NewAPI: ${report.diversion.isDiverted ? '是' : '否'})
- **底层快照**:
  - \`newapi_model\`: \`${report.diversion.newapiModel || '(未设置)'}\`
  - \`newapi_org_id\`: \`${report.diversion.actualOrgId ?? '(未记录)'}\`
  - \`newapi_group\`: \`${report.diversion.actualGroup || '(未设置)'}\`

${report.diversion.reasons.length > 0 ? `> [!WARNING]\n> ${report.diversion.reasons.join('\n> ')}` : ''}

---

## 4. 产物物理校验

- **产物校验判定**: **${report.artifact.passed ? '✅ 通过' : '❌ 失败'}** (状态: \`${report.artifact.status}\`)
- **物理校验级别**: \`${report.artifact.verificationLevel || 'UNVERIFIED'}\`
  - *口径说明*: ${report.artifact.verificationLevel ? levelDescriptions[report.artifact.verificationLevel] : '未执行物理校验'}
- **容器结构完整**: ${report.artifact.containerValid ? '✅ 完整' : '❌ 异常'}
- **元数据成功解析**: ${report.artifact.metadataParsed ? '✅ 成功' : '❌ 失败'}
- **真实像素全流解码**: ${report.artifact.fullStreamDecoded ? '✅ 已在浏览器解码渲染' : '⚠️ 未执行全流解码 (以容器与元数据核验为准)'}
${report.artifact.skipped ? '> [!NOTE]\n> 因任务为生成失败分支，按协议已跳过产物物理校验，进入退费检查。' : ''}
${report.artifact.fileAccessible ? `- **HTTP 可访问性**: ✅ 正常 (HTTP ${report.artifact.httpStatus ?? 200})` : ''}
${report.artifact.format ? `- **物理容器/格式**: \`${report.artifact.format}\`` : ''}
${report.artifact.dimensions ? `- **分辨率规格**: \`${report.artifact.dimensions.width}x${report.artifact.dimensions.height}\`` : ''}
${report.artifact.durationSeconds ? `- **视频时长**: \`${report.artifact.durationSeconds}s\`` : ''}
${report.artifact.sha256 ? `- **SHA-256**: \`${report.artifact.sha256}\` (${report.artifact.sizeBytes} bytes)` : ''}

${report.artifact.reasons.length > 0 ? `> [!CAUTION]\n> ${report.artifact.reasons.join('\n> ')}` : ''}

---

## 5. 用户侧积分对账与防资损审计

- **对账核验判定**: **${report.billing.passed ? '✅ 账务一致 (满足所有不变量)' : '❌ 存在账务差错 / 违背不变量'}**
- **预期扣除积分**: \`${report.billing.expectedPoints} 积分\`
- **预扣金额**: \`${report.billing.preDeductedPoints} 积分\`
- **退款金额**: \`${report.billing.refundedPoints} 积分\`
- **实际净扣**: \`${report.billing.netDeductedPoints} 积分\`
- **失败净扣归零 (NET_CHARGE_ZERO)**: ${report.taskTracking.terminalStatus === 'FAILED' ? (report.billing.netChargeZero ? '✅ 满足 (失败全额退款，净扣 0 pt)' : '❌ 违背不变量 (存在未退还积分或超退)') : '➖ 不适用 (任务成功，正常扣费结算)'}
- **防二次扣费 (ANTI_DOUBLE_BILLING)**: ${report.billing.antiDoubleBilling ? '✅ 满足 (扣费流水严格 <= 1)' : '❌ 违背不变量 (检测到重复预扣/并发扣款)'}
- **退款幂等性 (REFUND_IDEMPOTENCY)**: ${report.billing.refundIdempotency ? '✅ 满足 (退款流水严格 <= 1)' : '❌ 违背不变量 (检测到重复退款资金漏洞)'}
- **少扣检测**: ${report.billing.underCharged ? '❌ 存在少扣' : '✅ 正常'}
- **多扣检测**: ${report.billing.overCharged ? '❌ 存在多扣' : '✅ 正常'}
- **重复扣费检测**: ${report.billing.duplicateCharged ? '❌ 发现重复扣费' : '✅ 正常'}
- **重复退款检测**: ${report.billing.duplicateRefunded ? '❌ 发现重复退款' : '✅ 正常'}

${report.billing.reasons.length > 0 ? `> [!CAUTION]\n> 账务不变量与异常详情:\n> ${report.billing.reasons.join('\n> ')}` : ''}

---

## 6. 平台侧供应商成本与毛利核算 (Supplier Cost & Gross Margin)

- **成本核验判定**: **${report.supplierCost.passed ? '✅ 通过' : '❌ 存在差错'}** (状态: \`${report.supplierCost.status}\`)
- **预期供应商成本**: \`¥${report.supplierCost.expectedCostCny.toFixed(4)} 元\`
- **计费单价与依据**: \`${report.supplierCost.pricingBasis}\` (\`${report.supplierCost.unitCostCny} ${report.supplierCost.unit}\`)
- **供应商与渠道**: \`${report.supplierCost.channelName} (${report.supplierCost.channelCode}, 线路 line${report.supplierCost.line})\`
- **上游执行状态**: \`${report.supplierCost.upstreamExecutionState}\`
- **充值折算依据**: \`${report.supplierCost.revenueCalculationBasis}\`
- **有效积分单价**: \`¥${report.supplierCost.effectiveCnyPerPoint.toFixed(6)} 元/积分\`
- **用户付费折算**: \`¥${report.supplierCost.userRevenueCny.toFixed(4)} 元\` (${report.billing.netDeductedPoints} 积分)
- **平台预估毛利**: \`¥${report.supplierCost.estimatedGrossProfitCny.toFixed(4)} 元\` (预估毛利率: \`${report.supplierCost.grossMarginLabel}\`)
- **成本证据等级**: \`${report.supplierCost.evidenceLevel}\` (${report.supplierCost.evidenceLevel === 'INTERNAL_ESTIMATED' ? '内部 Oracle 规则推导' : (report.supplierCost.evidenceLevel === 'BILL_RECONCILED' || report.supplierCost.evidenceLevel === 'EXTERNAL_RECONCILED') ? '外部供应商账单勾兑' : report.supplierCost.evidenceLevel === 'DB_RECORD_VERIFIED' ? '业务数据库记录核验' : '待对账核验'})
- **外部账单状态**: \`${report.supplierCost.externalBillStatus}\`
${report.supplierCost.upstreamCalls && report.supplierCost.upstreamCalls.length > 0 ? `
### 上游多调用记录明细:
| 序号 | 渠道 | 模型 | 执行状态 | 计费产生 | 产生费用 (元) |
| --- | --- | --- | --- | --- | --- |
${report.supplierCost.upstreamCalls.map((c, idx) => `| ${idx + 1} | ${c.channelName} | ${c.modelName || c.model || '-'} | ${c.executionState} | ${c.billed ? '是' : '否'} | ¥${(c.costCny ?? c.incurredCostCny ?? 0).toFixed(4)} |`).join('\n')}
` : ''}
${report.supplierCost.reasons.length > 0 ? `> [!NOTE]\n> 成本对账备注:\n> ${report.supplierCost.reasons.join('\n> ')}` : ''}

---

## 7. 证据档案与安全脱敏

${report.tracePath ? `- **Playwright Trace 档案**: \`${report.tracePath}\` (使用 \`npx playwright show-trace ${report.tracePath}\` 查看录屏与网络流)` : '- **Playwright Trace**: (无)'}
- **脱敏声明**: 已执行系统规则脱敏（已对已知模式的 Cookie、FastAdmin 会话凭据、JWT、密钥等实施掩码过滤；归档文件仅存放于本地受控目录，严禁对外直传）。
`;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(PLAYWRIGHT_HELP);
    return 0;
  }
  const cliOptions = parseCliArgs(args);

  if (cliOptions.probeEnv) {
    console.log(`\n🔍 正在探测目标环境 [${cliOptions.env || 'test'}] 连通性与模型就绪状态...`);
    const report = await EnvironmentProbe.probe({
      env: cliOptions.env || 'test',
      sessionFile: cliOptions.sessionFile,
      modelId: cliOptions.modelId,
      mediaType: cliOptions.mediaType,
      mock: cliOptions.isMock,
    });
    console.log(`======================================================`);
    console.log(`环境状态: ${report.status === 'HEALTHY' ? '✅ HEALTHY' : report.status === 'DEGRADED' ? '⚠️ DEGRADED' : '❌ BLOCKED'}`);
    console.log(`主站地址: ${report.baseUrl}`);
    console.log(`NewAPI网关: ${report.gatewayUrl}`);
    console.log(`会话凭据: ${report.auth.status} (${report.auth.details})`);
    console.log(`端点探活:`);
    for (const ep of report.endpoints) {
      console.log(`  - [${ep.reachable ? 'OK' : 'FAIL'}] ${ep.name}: ${ep.message}`);
    }
    if (report.modelReadiness) {
      console.log(`模型分流: ${report.modelReadiness.willDivert ? '✅ 命中切流' : '⚠️ 直连回退'} (线路: line ${report.modelReadiness.routeLine}, 候选渠道数: ${report.modelReadiness.candidateChannelCount})`);
    }
    if (report.recommendations.length > 0) {
      console.log(`诊断建议:`);
      for (const rec of report.recommendations) console.log(`  👉 ${rec}`);
    }
    console.log(`======================================================\n`);
    return report.ok ? 0 : 1;
  }

  if (cliOptions.extractMatrix) {
    console.log(`\n📋 正在只读扫描 panqu-ai 业务代码逆向提取模型规格矩阵...`);
    if (typeof cliOptions.modelId === 'number') {
      const spec = await ModelMatrixExtractor.extractModel(cliOptions.modelId);
      if (!spec) {
        console.error(`未在业务代码中找到模型 ID ${cliOptions.modelId} 的定义`);
        return 1;
      }
      console.log(`======================================================`);
      console.log(`模型名称: ${spec.modelName} (ID: ${spec.modelId}, 别名: ${spec.alias})`);
      console.log(`媒体类型: ${spec.mediaType} | 默认链路: ${spec.flowType}`);
      console.log(`支持分辨率: [${spec.supportedResolutions.join(', ')}]`);
      console.log(`支持画幅比: [${spec.supportedAspectRatios.join(', ')}]`);
      if (spec.supportedDurations) console.log(`支持时长: [${spec.supportedDurations.join(', ')}]s (默认: ${spec.defaultDuration}s)`);
      if (spec.sourceFile) console.log(`代码依据: ${spec.sourceFile}`);
      const scenarios = ModelMatrixExtractor.generateSpecMatrixScenarios(spec);
      console.log(`推荐正交自测场景数: ${scenarios.length} 个`);
      console.log(`======================================================\n`);
      return 0;
    }
    const all = await ModelMatrixExtractor.extractAll();
    console.log(`======================================================`);
    console.log(`已提取 ${Object.keys(all).length} 个核心模型的业务规格契约:`);
    for (const spec of Object.values(all)) {
      console.log(`  - [ID ${String(spec.modelId).padEnd(4)}] ${spec.modelName.padEnd(22)} (${spec.alias.padEnd(26)}) -> 分辨率: [${spec.supportedResolutions.join(', ')}]`);
    }
    console.log(`======================================================\n`);
    return 0;
  }

  if (cliOptions.diffImpact) {
    console.log(`\n🔍 正在分析 Git 改动对业务模型的影响...`);
    const report = await GitImpactAnalyzer.analyze();
    console.log(`======================================================`);
    console.log(`影响等级: [${report.impactLevel}] | 变更文件数: ${report.changedFiles.length}`);
    if (report.changedFiles.length > 0) {
      console.log(`变更文件:`);
      for (const f of report.changedFiles.slice(0, 10)) console.log(`  - ${f}`);
      if (report.changedFiles.length > 10) console.log(`  ... 其余 ${report.changedFiles.length - 10} 个文件`);
    }
    console.log(`受波及模型:`);
    for (const m of report.affectedModels) {
      console.log(`  👉 [${m.flowType}] ${m.modelName} (ID: ${m.modelId}) -> ${m.reason}`);
    }
    console.log(`建议回归场景: [${report.recommendedScenarios.join(', ')}]`);
    if (report.suggestedTestCommands.length > 0) {
      console.log(`推荐执行命令:`);
      for (const cmd of report.suggestedTestCommands) console.log(`  $ ${cmd}`);
    }
    console.log(`======================================================\n`);
    return 0;
  }

  if (cliOptions.watchTaskId !== undefined) {
    const taskId = cliOptions.watchTaskId === 0 ? undefined : cliOptions.watchTaskId;
    console.log(`\n⏱ 正在流式监视任务进度与对账 (Task: ${taskId ?? '自动分配'}) ...`);
    const result = await TaskWatcher.watch({
      taskId,
      modelId: cliOptions.modelId ?? 84,
      mediaType: cliOptions.mediaType ?? 'video',
      env: cliOptions.env || 'test',
      mock: cliOptions.isMock,
      simulateFailure: cliOptions.expectFailure,
      duration: cliOptions.duration,
      resolution: cliOptions.resolution,
      onProgress: (ev) => {
        console.log(`  [${ev.status.padEnd(10)}] 进度: ${ev.progress}% -> ${ev.message}`);
      },
    });
    console.log(`======================================================`);
    console.log(`任务状态: ${result.finalStatus === 'COMPLETED' ? '✅ COMPLETED' : '❌ ' + result.finalStatus}`);
    console.log(`总耗时: ${result.durationMs}ms`);
    if (result.mediaInspection) {
      console.log(`产物质检: [${result.mediaInspection.format}] ${result.mediaInspection.decodable ? '✅ 结构有效' : '❌ 无效'}`);
    }
    if (result.billingReconciliation) {
      console.log(`账务核销: 预期 ${result.billingReconciliation.expectedPoints} pt | 实扣 ${result.billingReconciliation.netDeductedPoints} pt | ${result.billingReconciliation.passed ? '✅ 对账吻合' : '❌ 对账违背'}`);
    }
    console.log(`总结: ${result.summary}`);
    console.log(`======================================================\n`);
    return result.ok ? 0 : 1;
  }

  if (cliOptions.chaosType) {
    console.log(`\n💥 正在注入网关多渠道故障演练 [${cliOptions.chaosType}] ...`);
    const result = await ChaosSimulator.simulate({
      chaosType: cliOptions.chaosType as ChaosFaultType,
      modelId: cliOptions.modelId ?? 84,
      mediaType: cliOptions.mediaType ?? 'video',
      mock: cliOptions.isMock,
    });
    console.log(`======================================================`);
    console.log(`演练故障: ${result.chaosType}`);
    console.log(`容灾判定: ${result.resiliencePassed ? '✅ 容灾韧性通过' : '❌ 容灾失败'}`);
    console.log(`初始渠道: #${result.initialChannel.id} (${result.initialChannel.name}) -> ${result.initialChannel.status} ${result.initialChannel.error ? `(${result.initialChannel.error})` : ''}`);
    if (result.failoverChannel) {
      console.log(`故障转移: #${result.failoverChannel.id} (${result.failoverChannel.name}) -> ${result.failoverChannel.status}`);
    }
    if (result.fallbackToDirect) {
      console.log(`回退直连: ✅ 触发平滑降级至原主站直连链路`);
    }
    console.log(`账务安全: 防重复扣费=${result.invariantsChecked.antiDoubleBilling ? '✅' : '❌'} | 失败净扣归零=${result.invariantsChecked.netChargeZeroOnFailure ? '✅' : '❌'}`);
    console.log(`总结: ${result.summary}`);
    console.log(`======================================================\n`);
    return result.resiliencePassed ? 0 : 1;
  }

  if (cliOptions.auditDrift) {
    console.log(`\n📋 正在审计多环境配置漂移与刊例价一致性...`);
    const report = await ConfigDriftAuditor.audit({
      env: cliOptions.env || 'test',
      compareEnv: 'online',
      mock: cliOptions.isMock,
    });
    console.log(`======================================================`);
    console.log(`审计状态: ${report.status === 'CONSISTENT' ? '✅ 一致' : '⚠️ 存在差异 (' + report.status + ')'}`);
    console.log(`对比环境: [${report.env}] vs [${report.compareEnv}]`);
    console.log(`差异总数: ${report.driftCount}`);
    for (const issue of report.issues) {
      console.log(`  - [${issue.severity}] [${issue.category}] ${issue.description}`);
      console.log(`    👉 建议: ${issue.suggestedAction}`);
    }
    console.log(`总结: ${report.summary}`);
    console.log(`======================================================\n`);
    return report.ok ? 0 : 1;
  }

  if (cliOptions.auditMargin) {
    const modelId = cliOptions.modelId ?? 84;
    console.log(`\n💰 正在核算模型 #${modelId} 供应商成本与平台毛利率门禁...`);
    const report = await MarginAuditor.auditModelMargin({
      modelId,
      mediaType: cliOptions.mediaType,
    });
    console.log(`======================================================`);
    console.log(`模型: ${report.modelName} (ID: ${report.modelId}) | 链路: ${report.flowType}`);
    console.log(`门禁结果: ${report.gatePassed ? '✅ PASS (毛利合规)' : '❌ BLOCKED (价格倒挂/亏损)'}`);
    console.log(`综合状态: [${report.overallStatus}] | 目标毛利率: ${report.targetMarginPercent}%`);
    console.log(`\n各规格测算明细:`);
    for (const d of report.resolutions) {
      console.log(`  - [${d.resolution.padEnd(5)}] 刊例: ${d.userPoints}pt (¥${d.userRevenueYuan.toFixed(2)}) | 成本: ¥${d.supplierCostYuan.toFixed(2)} | 毛利: ¥${d.grossProfitYuan.toFixed(2)} (${d.grossMarginPercent}%) -> [${d.status}]`);
      if (d.fallbackStatus) {
        console.log(`      ↳ 降级直连成本: ¥${d.fallbackSupplierCostYuan?.toFixed(2)} | 降级毛利: ${d.fallbackGrossMarginPercent}% [${d.fallbackStatus}]`);
      }
    }
    if (report.blockers.length > 0) {
      console.log(`\n🚫 阻断原因:`);
      for (const b of report.blockers) console.log(`  ❌ ${b}`);
    }
    if (report.recommendations.length > 0) {
      console.log(`\n💡 优化建议:`);
      for (const r of report.recommendations) console.log(`  👉 ${r}`);
    }
    console.log(`======================================================\n`);
    return report.gatePassed ? 0 : 1;
  }

  if (cliOptions.initCi) {
    console.log(`\n⚙️ 正在为项目生成 GitHub Actions CI 门禁工作流配置...`);
    const yamlContent = CiPrGate.generateWorkflowYaml();
    const workflowPath = path.resolve(process.cwd(), '.github/workflows/test-flow-ci.yml');
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(workflowPath, yamlContent, 'utf8');
    console.log(`======================================================`);
    console.log(`✅ 已成功创建 GitHub Actions 工作流文件: ${workflowPath}`);
    console.log(`可以在 GitHub 仓库提交此文件，即可在每个 PR 和 Push 时自动运行 test-flow 门禁体检。`);
    console.log(`======================================================\n`);
    return 0;
  }

  if (cliOptions.ciGate) {
    console.log(`\n🤖 正在执行 Panqu Test-Flow CI/PR 质量与毛利自动化审查门禁...`);
    const targetModels = cliOptions.modelId ? [cliOptions.modelId] : undefined;
    const result = await CiPrGate.run({
      baseRef: cliOptions.baseRef,
      targetModels,
      outputPrCommentPath: cliOptions.outputPrCommentPath,
      mock: cliOptions.isMock,
      env: cliOptions.env || 'test',
      pullNumber: cliOptions.pullNumber,
    });

    console.log(`======================================================`);
    console.log(`门禁裁决: ${result.conclusion === 'APPROVED' ? '🟢 APPROVED (门禁通过)' : (result.conclusion === 'NEEDS_ATTENTION' ? '🟡 NEEDS ATTENTION (建议关注)' : '🔴 BLOCKED (资损阻断)')}`);
    console.log(`变更影响: [${result.gitImpact.impactLevel}] | 审查模型数: ${result.marginAudits.length} 个`);
    console.log(`GitHub Review 决策: [${result.githubReviewEvent}] | 行间批注数: ${result.lineComments.length}`);
    console.log(`阻断项数: ${result.blockers.length} | 关注项数: ${result.warnings.length}`);
    console.log(`审查摘要: ${result.summary}`);

    if (result.lineComments.length > 0) {
      console.log(`\n📝 逐行代码审查批注 (Line Comments for GitHub MCP):`);
      for (const c of result.lineComments) {
        console.log(`  - [${c.path}:${c.line}] ${c.body.split('\n')[0]}`);
      }
    }

    if (result.blockers.length > 0) {
      console.log(`\n🚨 资损阻断项 (必须修复后方可合入):`);
      for (const b of result.blockers) console.log(`  ❌ ${b}`);
    }

    if (result.warnings.length > 0) {
      console.log(`\n⚠️ 关注建议项:`);
      for (const w of result.warnings) console.log(`  🟡 ${w}`);
    }

    if (result.recommendations.length > 0) {
      console.log(`\n💡 整改指引:`);
      for (const r of Array.from(new Set(result.recommendations))) console.log(`  👉 ${r}`);
    }

    if (cliOptions.outputPrCommentPath) {
      console.log(`\n📄 PR 评论 Markdown 报告已写入: ${cliOptions.outputPrCommentPath}`);
    }
    console.log(`======================================================\n`);

    return result.gatePassed ? 0 : 1;
  }

  if (cliOptions.fixPr) {
    const modelId = cliOptions.modelId ?? 84;
    console.log(`\n🛠️ 正在为模型 #${modelId} 生成资损与毛利优化提 PR 修复包 (Auto-Fix PR)...`);
    const result = await AutoFixPrEngine.generateFixPr({
      modelId,
      mediaType: cliOptions.mediaType,
    });

    console.log(`======================================================`);
    console.log(`模型: ${result.modelName} (ID: ${result.modelId})`);
    console.log(`拟创建分支: [${result.branchName}]`);
    console.log(`Commit / PR 标题: ${result.prTitle}`);
    console.log(`\n财务毛利变迁对比表:`);
    for (const p of result.pricingComparison) {
      console.log(`  - [${p.resolution.padEnd(5)}] 刊例: ${p.beforePoints}pt -> ${p.afterPoints}pt | 成本: ¥${p.supplierCostYuan.toFixed(2)} | 毛利: ${p.beforeMarginPercent}% -> ${p.afterMarginPercent}% [${p.statusAfter}]`);
    }
    console.log(`\n拟提交变更文件 (${result.fileChanges.length} 个):`);
    for (const f of result.fileChanges) {
      console.log(`  📄 [${f.action.toUpperCase()}] ${f.path} (${f.description})`);
    }
    console.log(`\nGitHub MCP 动作序列 (${result.githubMcpActions.length} 个):`);
    for (const act of result.githubMcpActions) {
      console.log(`  👉 [${act.tool}] ${act.description}`);
    }
    console.log(`\n总结: ${result.summary}`);
    console.log(`======================================================\n`);

    return 0;
  }

  if (cliOptions.checkRun) {
    const headSha = cliOptions.headSha || 'HEAD';
    console.log(`\n🛡️ 正在生成针对提交 [${headSha}] 的 GitHub Check Runs 原生门禁载荷与 Annotations...`);
    const targetModels = cliOptions.modelId ? [cliOptions.modelId] : undefined;
    const gateResult = await CiPrGate.run({
      baseRef: cliOptions.baseRef,
      targetModels,
      outputPrCommentPath: cliOptions.outputPrCommentPath,
      mock: cliOptions.isMock,
      env: cliOptions.env || 'test',
      pullNumber: cliOptions.pullNumber,
    });

    const checkResult = GitHubCheckRunAdapter.buildCheckRunResult({
      headSha,
      pullNumber: cliOptions.pullNumber,
      checkName: cliOptions.checkName,
      conclusion: gateResult.conclusion,
      markdownReport: gateResult.markdownReport,
      gitImpact: gateResult.gitImpact,
      configDrift: gateResult.configDrift,
      marginAudits: gateResult.marginAudits,
      changedFiles: gateResult.gitImpact.changedFiles,
    });

    console.log(`======================================================`);
    console.log(`Check Name: [${checkResult.checkRunPayload.name}]`);
    console.log(`Head SHA:   [${checkResult.checkRunPayload.head_sha}]`);
    console.log(`门禁结论:   ${checkResult.conclusion === 'success' ? '🟢 SUCCESS (门禁通过，允许合入)' : (checkResult.conclusion === 'neutral' ? '🟡 NEUTRAL (存在关注项)' : '🔴 FAILURE (资损阻断，硬卡点拦截)')}`);
    console.log(`Title:      ${checkResult.checkRunPayload.output.title}`);
    console.log(`Annotations 统计: 总计 ${checkResult.annotationsCount.total} 处 (❌ Failure: ${checkResult.annotationsCount.failure}，⚠️ Warning: ${checkResult.annotationsCount.warning}，ℹ️ Notice: ${checkResult.annotationsCount.notice})`);

    if (checkResult.checkRunPayload.output.annotations.length > 0) {
      console.log(`\n📍 行级代码注记 (Check Run Annotations for Files Changed):`);
      for (const a of checkResult.checkRunPayload.output.annotations) {
        const badge = a.annotation_level === 'failure' ? '❌ FAILURE' : a.annotation_level === 'warning' ? '⚠️ WARNING' : 'ℹ️ NOTICE';
        console.log(`  - [${badge}] ${a.path}:${a.start_line} - ${a.title}`);
        console.log(`    ${a.message.split('\n')[0]}`);
      }
    }

    console.log(`\nGitHub MCP 调度操作 (${checkResult.githubMcpActions.length} 个):`);
    for (const act of checkResult.githubMcpActions) {
      console.log(`  👉 [${act.tool}] ${act.description}`);
    }

    console.log(`\n分支保护裁决: ${checkResult.conclusion === 'failure' ? '❌ 阻断 Merge (Branch Protection Blocked)' : '✅ 放行 Merge (Branch Protection Passed)'}`);
    console.log(`======================================================\n`);

    return checkResult.conclusion === 'failure' ? 1 : 0;
  }

  if (cliOptions.prCommand) {
    console.log(`\n💬 正在解析并执行 PR #${cliOptions.pullNumber ?? 0} 评论指令: "${cliOptions.prCommand}"...`);
    const result = await PrCommentCommandHandler.execute({
      commentBody: cliOptions.prCommand,
      commentAuthor: cliOptions.commentAuthor,
      pullNumber: cliOptions.pullNumber,
      headSha: cliOptions.headSha,
      mock: cliOptions.isMock,
    });

    console.log(`======================================================`);
    console.log(`指令识别: [${result.command.commandName || 'NONE'}] -> 类型: [${result.type}]`);
    console.log(`执行状态: ${result.ok ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`执行摘要: ${result.summary}`);
    if (result.command.modelId) {
      console.log(`关联模型: #${result.command.modelId}`);
    }
    console.log(`\nGitHub MCP 调度操作 (${result.githubMcpActions.length} 个):`);
    for (const act of result.githubMcpActions) {
      console.log(`  👉 [${act.tool}] ${act.description}`);
    }

    console.log(`\n拟在 GitHub PR 回复的评论正文预览:`);
    console.log(`------------------------------------------------------`);
    console.log(result.replyMarkdown);
    console.log(`------------------------------------------------------`);
    console.log(`======================================================\n`);

    return result.ok ? 0 : 1;
  }

  if (cliOptions.postMerge) {
    const pullNumber = cliOptions.pullNumber || 42;
    console.log(`\n🚀 正在执行 PR #${pullNumber} 合入后与上线闭环 (Post-Merge Lifecycle)...`);
    const targetModels = cliOptions.modelId ? [cliOptions.modelId] : undefined;
    const result = await PostMergeLifecycleEngine.execute({
      pullNumber,
      mergedCommitSha: cliOptions.headSha,
      associatedIssueNumbers: cliOptions.associatedIssues,
      tagName: cliOptions.tagName,
      targetModels,
      compareEnv: cliOptions.env || 'online',
      mock: cliOptions.isMock,
    });

    console.log(`======================================================`);
    console.log(`PR 编号:    #${result.pullNumber}`);
    console.log(`发布 Tag:   [${result.tagName}]`);
    console.log(`Commit SHA: [${result.mergedCommitSha}]`);
    console.log(`配置漂移:   ${result.driftPassed ? '✅ 0 漂移通过 (与 online 环境一致)' : '⚠️ 存在差异'}`);
    console.log(`毛利达标:   ${result.marginPassed ? '🟢 全部规格毛利达标 (>=30%)' : '🔴 存在负毛利'}`);
    console.log(`关闭 Issue: ${result.closedIssues.length > 0 ? result.closedIssues.map((i) => `#${i}`).join(', ') : '无'}`);
    console.log(`执行状态:   ${result.ok ? '✅ SUCCESS' : '❌ FAILED'}`);

    console.log(`\nGitHub MCP 调度操作 (${result.githubMcpActions.length} 个):`);
    for (const act of result.githubMcpActions) {
      console.log(`  👉 [${act.tool}] ${act.description}`);
    }

    console.log(`\n拟发布的 Release Notes 预览:`);
    console.log(`------------------------------------------------------`);
    console.log(result.releaseNotes);
    console.log(`------------------------------------------------------`);
    console.log(`======================================================\n`);

    return result.ok ? 0 : 1;
  }

  if (cliOptions.requirementPath || cliOptions.onboardModelId || cliOptions.flowType) {
    let reqContent = '';
    if (cliOptions.requirementPath) {
      try {
        reqContent = await readFile(cliOptions.requirementPath, 'utf8');
      } catch (err) {
        console.error(`无法读取需求文档: ${cliOptions.requirementPath}`, err);
        return 1;
      }
    }

    const modelId = cliOptions.onboardModelId ?? cliOptions.modelId;
    const selfTestPlan = SelfTestPlanner.plan({
      requirement: reqContent,
      flowType: cliOptions.flowType,
      modelSpec: modelId ? {
        modelId,
        modelType: cliOptions.mediaType ?? 'video',
        alias: cliOptions.modelAlias,
        isGlobal: cliOptions.isGlobalModel ?? false,
        taskType: cliOptions.taskType,
        resolutions: cliOptions.resolution ? [cliOptions.resolution] : undefined,
        aspectRatios: cliOptions.aspectRatio ? [cliOptions.aspectRatio] : undefined,
      } : undefined,
      environment: cliOptions.env,
      preferExecutionMode: cliOptions.isMock
        ? 'MOCK'
        : (cliOptions.executionMode === 'UI_E2E' || (cliOptions.executionMode as string) === 'BROWSER_E2E'
          ? 'UI_E2E'
          : 'API_INTEGRATION'),
    });

    const flowTitle = selfTestPlan.flowType === 'DIRECT' ? '新模型直接接入测试 (DIRECT)' : '已有模型分流测试 (DIVERSION)';
    console.log(`\n======================================================`);
    console.log(`📋 [Self-Test Planner] 自主规划测试计划 [${flowTitle}]:`);
    console.log(`测试流类型: ${selfTestPlan.flowType} (${flowTitle})`);
    console.log(`业务领域: ${selfTestPlan.domain}`);
    console.log(`测试范围: ${selfTestPlan.scope}`);
    console.log(`执行模式: ${selfTestPlan.executionMode} (${selfTestPlan.modeReason})`);
    console.log(`目标模型: ${selfTestPlan.targetModels.map((m) => `${m.alias} (ID: ${m.id}, 全量: ${m.isGlobal})`).join(', ')}`);
    console.log(`识别风险数: ${selfTestPlan.risks.length}`);
    console.log(`规划场景数: ${selfTestPlan.scenarios.length}`);
    selfTestPlan.scenarios.forEach((s, idx) => {
      console.log(`  ${idx + 1}. [${s.kind}] ${s.name} (依据: ${s.whySelected})`);
    });
    console.log(`执行步骤 DAG 已编排就绪 (${selfTestPlan.executionDags.length} 个 DAG)`);
    console.log(`======================================================\n`);

    if (cliOptions.planOnly) {
      console.log(`[--plan-only] 计划已输出完成，停止实际执行。\n`);
      return 0;
    }

    const primaryModel = selfTestPlan.targetModels[0];
    if (primaryModel) {
      cliOptions.modelId = primaryModel.id;
      cliOptions.mediaType = primaryModel.type;
    }
  }

  console.log(`\n======================================================`);
  console.log(`🎭 Panqu Playwright 闭环测试智能体启动 [${cliOptions.flowType === 'DIRECT' ? '新模型直连模式' : '已有模型分流模式'}]`);
  console.log(`模式: ${cliOptions.isMock ? '模拟受控验证 (MOCK)' : '真实环境执行 (REAL)'}`);
  console.log(`媒体: ${cliOptions.mediaType}`);
  console.log(`======================================================\n`);

  let runOptions: PlaywrightFlowRunOptions = {
    ...cliOptions,
    executionMode: cliOptions.isMock ? 'MOCK' : (cliOptions.executionMode || 'API_INTEGRATION'),
  };

  if (cliOptions.isMock) {
    // 注入模拟夹具参数
    runOptions.userGroupIds = [10];
    if (cliOptions.mediaType === 'video') {
      const isFail = cliOptions.expectFailure;
      runOptions.modelId = 84;
      runOptions.duration = 4;
      runOptions.resolution = '480p';
      runOptions.rechargeBatch = STANDARD_RECHARGE_PRESETS['100_TIER'];
      if (isFail) {
        runOptions.upstreamExecutionState = 'REJECTED_BEFORE_EXECUTION';
      }
      runOptions.mockSubmitResponse = {
        status: 200,
        body: { code: 1, msg: 'ok', data: { id: 29001 } },
      };
      runOptions.mockStatusResponses = isFail
        ? [
            { status: 200, body: { task_status: 1, progress: 30 } },
            { status: 200, body: { task_status: 3, progress: 0, err: 'UPSTREAM_MODEL_LIMIT' } },
          ]
        : [
            { status: 200, body: { task_status: 1, progress: 40 } },
            { status: 200, body: { task_status: 2, progress: 100, video_url: 'https://v.panqu.com.cn/video/sample.mp4' } },
          ];
      runOptions.mockTaskDetails = {
        id: 29001,
        video_url: 'https://v.panqu.com.cn/video/sample.mp4',
        extra: {
          diversion: 10,
          newapi_model: 'wan3.0-video',
          newapi_org_id: 0,
          newapi_group: '',
          points: 28,
          channel_name: '万相—yhuo',
        },
      };
      runOptions.mockAssetBuffer = isFail ? undefined : MOCK_MP4_HEADER;
      runOptions.mockScoreLogs = isFail
        ? [
            { task_id: 29001, type: 2, score: -28, memo: '预扣 Wan 3.0 视频生成费用' },
            { task_id: 29001, type: 1, score: 28, memo: '任务生成失败退款' },
          ]
        : [
            { task_id: 29001, type: 2, score: -28, memo: '预扣 Wan 3.0 视频生成费用' },
            { task_id: 29001, type: 3, score: 28, memo: 'Wan 3.0 任务完成结算' },
          ];
    } else {
      runOptions.modelId = 201;
      runOptions.rechargeBatch = STANDARD_RECHARGE_PRESETS['100_TIER'];
      runOptions.mockSubmitResponse = {
        status: 200,
        body: { code: 1, msg: 'ok', data: { id: 29002 } },
      };
      runOptions.mockStatusResponses = [
        { status: 200, body: { task_status: 1, progress: 50 } },
        { status: 200, body: { task_status: 2, progress: 100, pic_url: 'https://v.panqu.com.cn/image/sample.png' } },
      ];
      runOptions.mockTaskDetails = {
        id: 29002,
        pic_url: 'https://v.panqu.com.cn/image/sample.png',
        extra: {
          newapi_image: 1,
          newapi_model: 'runninghub-nano-banana-2',
          newapi_org_id: 10,
          newapi_group: 'panqu_test',
        },
      };
      runOptions.mockAssetBuffer = MOCK_PNG_HEADER;
      runOptions.mockScoreLogs = [
        { task_id: 29002, type: 2, score: -5, memo: '场景生图预扣费用' },
        { task_id: 29002, type: 3, score: 5, memo: '场景生图完成结算' },
      ];
    }
  }

  const evidence = await runPanquPlaywrightFlow(runOptions);
  const mdReport = renderEvidenceMarkdown(evidence);

  const outDir = cliOptions.outputDir || path.resolve(process.cwd(), 'devtest-results');
  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, `${evidence.caseId}-playwright-report.md`);
  await writeFile(reportPath, mdReport, 'utf8');

  console.log(`\n======================================================`);
  console.log(`🎯 测试执行结果汇总:`);
  console.log(`测试断言判定: ${evidence.testAssertionStatus === 'PASS' ? '✅ PASS' : evidence.testAssertionStatus === 'BLOCKED' ? '⏸ BLOCKED' : '❌ FAIL'}`);
  console.log(`业务任务终态: ${evidence.businessTaskStatus}`);
  console.log(`执行接入模式: ${evidence.executionMode}${evidence.degradedFromBrowser ? ' (⚠️ 浏览器不可用降级至 API)' : ''}`);
  console.log(`任务关联 ID: ${evidence.taskId ?? 'N/A'}`);
  console.log(`路由分流核查: ${evidence.diversion.passed ? '✅ 命中' : '❌ 异常'} (${evidence.diversion.actualChannel})`);
  console.log(`产物校验级别: ${evidence.artifact.passed ? '✅ 通过' : '❌ 异常'} [${evidence.artifact.verificationLevel}] (${evidence.artifact.qualityClassification})`);
  console.log(`用户积分对账: ${evidence.billing.passed ? '✅ 平衡' : '❌ 差错'} (净扣 ${evidence.billing.netDeductedPoints} pt / 预期 ${evidence.billing.expectedPoints} pt, 退款 ${evidence.billing.refundedPoints} pt)`);
  console.log(`供应商成本核算: ${evidence.supplierCost.evidenceLevel !== 'UNVERIFIED' ? '✅ 完成' : '⚠️ 待对账'} (预估成本 ¥${evidence.supplierCost.expectedCostCny}, 毛利 ¥${evidence.supplierCost.estimatedGrossProfitCny} [${evidence.supplierCost.grossMarginLabel}], 凭证等级: ${evidence.supplierCost.evidenceLevel})`);
  console.log(`详细报告文件: ${reportPath}`);

  if (evidence.testAssertionStatus !== 'PASS' && cliOptions.exportRepro) {
    const repro = await ReproExporter.generatePackage({
      caseId: evidence.caseId,
      failureCategory: evidence.taskTracking.failureCategory || 'TASK_EXECUTION_FAILURE',
      taskInfo: {
        taskId: evidence.taskId,
        modelId: runOptions.modelId ?? cliOptions.modelId ?? 84,
        mediaType: evidence.mediaType,
        duration: runOptions.duration,
        resolution: runOptions.resolution,
        aspectRatio: runOptions.aspectRatio,
        env: cliOptions.env || 'test',
      },
      expected: cliOptions.expectFailure ? '业务任务失败且退款归零' : '全链路测试断言 PASS',
      actual: `测试断言 ${evidence.testAssertionStatus}, 业务终态 ${evidence.businessTaskStatus}`,
      reasons: evidence.diagnosticLog || evidence.billing.reasons,
      violatedInvariants: evidence.billing.passed ? [] : ['NET_CHARGE_ZERO'],
      scoreLogs: (runOptions as any).mockScoreLogs || [],
      outputDir: path.join(outDir, 'repro'),
    });
    console.log(`📦 缺陷复现包已导出: ${repro.savedFiles?.markdownPath}`);
    console.log(`   - 独立 Playwright 脚本: ${repro.savedFiles?.scriptPath}`);
  }

  console.log(`======================================================\n`);
  return evidence.testAssertionStatus === 'PASS' ? 0 : 1;
}

// CLI 直调支持
if (process.argv[1]?.endsWith('run-playwright-cli.js') || process.argv[1]?.endsWith('run-playwright-cli.ts')) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error('CLI 执行异常:', err);
    process.exit(1);
  });
}
