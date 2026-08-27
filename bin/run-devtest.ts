import { pathToFileURL } from 'node:url';

import { redactSensitiveText } from '../src/core/redact.js';
import { runDevTest } from '../src/devtest/index.js';
import type { DevTestCaseDimension, DevTestMode } from '../src/devtest/types.js';

const PANQU_AI_SOURCE_ROOT = '/Users/mac/agents/panqu-ai';

export const DEVTEST_HELP = `DevTest — 需求驱动 · 开发者自助测试

用法:
  npm run devtest -- <requirement-file>
  npm run devtest -- requirements/new-feature.md --env test --mode safe --output ./devtest-results

参数:
  <requirement-file>          Markdown/纯文本需求文件（也兼容 --doc <文件>）
  --env <local|test|integration>  默认 local；production 禁止
  --mode <safe|dry-run|live>  默认 safe；live 必须提供 --approval
  --output <目录>             默认 ./devtest-results（兼容 --out）
  --max-cases <1~100>         默认 20；按 P0→P1→P2 和维度覆盖裁剪
  --base-url <origin>         可选；未提供且无专用环境变量时只做测试设计
  --project-root <目录>       Route/OpenAPI/UI 自动发现根目录（默认 /Users/mac/agents/panqu-ai）
  执行模式固定在测试前覆盖同步 /Users/mac/agents/panqu-ai 下所有工蜂 Git 子仓库；plan/preflight/dry-run 不改源码。
  --no-ui                    关闭 UI 维度
  --no-api                   关闭 API 维度
  --no-data-isolation        关闭数据隔离维度
  --no-parameter-validation  关闭参数校验维度
  --approval <id>            LIVE 审批 ID
  --confirm-mutations        SAFE 下仅允许 Sandbox/Cleanup 约束内的写路径
  --sandbox                  声明当前目标为隔离 Sandbox/Fixture（不放行 DELETE/Billing/Provider）
  --plan                     只生成 Test Plan Preview，不执行、不覆盖 Baseline
  --final                    执行 Preflight→Oracle→Flow→Invariant→Regression Guard→Report v8
  --summary                  终端只输出一页 READY/问题/阻断/未知/下一步
  --deep                     在默认 Tier 0 + Tier 1 之外执行 Tier 2 边界 Case
  --fail-fast                P0/Critical 真实失败后停止启动后续 Case（默认）
  --no-fail-fast             调试时继续执行后续 Case
  --concurrency <1~8>        互不依赖只读 Case 最大并发，默认 4；共享写状态自动串行
  --timeout <ms>             单请求超时，默认 10000
  --max-runtime <ms>         整个验收最大执行时间
  --budget <number>          最大估算成本（DEVTEST_UNIT）
  --rerun [P001|failed|blocked|regression]  精准复测问题或状态；省略值时复测全部失败/阻断/受影响 Case
  --repro <P001>             只复现 Baseline 中指定问题
  --preflight                只检查环境、API、认证、Browser 与数据库能力
  --feishu <url>             从飞书读取需求（与本地文件二选一）
  --feishu-credentials <file> 飞书凭证文件；也可用 FEISHU_APP_ID/FEISHU_APP_SECRET
  --help                     显示帮助

固定产物:
  测试用例.md  开发自测测试报告.md
  acceptance-summary.md  report.html  report.json  cases.csv  problems.md（审计附件）
`;

export interface ParsedDevTestArgs {
  doc?: string;
  feishu?: string;
  feishuCredentials?: string;
  baseUrl?: string;
  env: string;
  mode: DevTestMode;
  project: string;
  output: string;
  approvalId?: string;
  projectRoot?: string;
  confirmMutations: boolean;
  sandbox: boolean;
  deep: boolean;
  summary: boolean;
  rerun: boolean;
  rerunTarget?: string;
  reproProblemId?: string;
  plan: boolean;
  final: boolean;
  failFast: boolean;
  concurrency: number;
  timeoutMs: number;
  maxRuntimeMs?: number;
  budget?: number;
  preflight: boolean;
  maxCases: number;
  enabledDimensions: Partial<Record<DevTestCaseDimension, boolean>>;
}

function splitArgument(argument: string): { flag: string; inlineValue?: string } {
  const index = argument.indexOf('=');
  return index < 0 ? { flag: argument } : { flag: argument.slice(0, index), inlineValue: argument.slice(index + 1) };
}

export function parseDevTestArgs(argv: readonly string[]): ParsedDevTestArgs {
  const parsed: ParsedDevTestArgs = {
    env: 'local', mode: 'SAFE', project: 'devtest', output: 'devtest-results',
    confirmMutations: false, sandbox: false, deep: false, summary: false, rerun: false, plan: false, final: false,
    failFast: true, concurrency: 4, timeoutMs: 10_000, preflight: false, maxCases: 20, enabledDimensions: {},
  };
  const seen = new Set<string>();
  const positional: string[] = [];
  const valueOf = (flag: string, inlineValue: string | undefined, index: number): { value: string; next: number } => {
    const value = inlineValue ?? argv[index + 1];
    if (!value || (inlineValue === undefined && value.startsWith('--'))) throw new Error(`DEVTEST_ARG_MISSING_VALUE：${flag} 缺少参数值`);
    return { value, next: inlineValue === undefined ? index + 1 : index };
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('-')) {
      positional.push(argument);
      continue;
    }
    const { flag, inlineValue } = splitArgument(argument);
    const booleanFlag = ['--no-ui', '--no-api', '--no-data-isolation', '--no-parameter-validation', '--confirm-mutations', '--sandbox', '--deep', '--summary', '--dry-run', '--plan', '--final', '--fail-fast', '--no-fail-fast', '--preflight'].includes(flag);
    if (seen.has(flag)) throw new Error(`DEVTEST_ARG_DUPLICATE：参数重复 ${flag}`);
    seen.add(flag);
    if (booleanFlag && inlineValue !== undefined) throw new Error(`DEVTEST_ARG_INVALID：${flag} 不接受参数值`);
    if (flag === '--no-ui') parsed.enabledDimensions.UI = false;
    else if (flag === '--no-api') parsed.enabledDimensions.API = false;
    else if (flag === '--no-data-isolation') parsed.enabledDimensions.DATA_ISOLATION = false;
    else if (flag === '--no-parameter-validation') parsed.enabledDimensions.PARAMETER_VALIDATION = false;
    else if (flag === '--confirm-mutations') parsed.confirmMutations = true;
    else if (flag === '--sandbox') parsed.sandbox = true;
    else if (flag === '--deep') parsed.deep = true;
    else if (flag === '--summary') parsed.summary = true;
    else if (flag === '--rerun') {
      parsed.rerun = true;
      const candidate = inlineValue ?? argv[index + 1];
      if (candidate && (/^P\d{3,}$/i.test(candidate) || ['failed', 'blocked', 'regression'].includes(candidate.toLowerCase()))) {
        parsed.rerunTarget = candidate.toLowerCase().startsWith('p') ? candidate.toUpperCase() : candidate.toLowerCase();
        if (inlineValue === undefined) index += 1;
      } else if (inlineValue !== undefined) throw new Error(`DEVTEST_ARG_INVALID：未知 --rerun 目标 ${inlineValue}`);
    }
    else if (flag === '--plan') parsed.plan = true;
    else if (flag === '--final') parsed.final = true;
    else if (flag === '--fail-fast') parsed.failFast = true;
    else if (flag === '--no-fail-fast') parsed.failFast = false;
    else if (flag === '--preflight') parsed.preflight = true;
    else if (flag === '--dry-run') parsed.mode = 'DRY_RUN';
    else if (['--doc', '--feishu', '--feishu-credentials', '--base-url', '--env', '--mode', '--project', '--project-root', '--output', '--out', '--max-cases', '--concurrency', '--timeout', '--max-runtime', '--budget', '--approval', '--repro'].includes(flag)) {
      const read = valueOf(flag, inlineValue, index);
      index = read.next;
      if (flag === '--doc') parsed.doc = read.value;
      else if (flag === '--feishu') parsed.feishu = read.value;
      else if (flag === '--feishu-credentials') parsed.feishuCredentials = read.value;
      else if (flag === '--base-url') parsed.baseUrl = read.value;
      else if (flag === '--env') parsed.env = read.value.toLowerCase();
      else if (flag === '--mode') {
        const mode = read.value.replace('-', '_').toUpperCase();
        if (!['SAFE', 'DRY_RUN', 'LIVE'].includes(mode)) throw new Error(`DEVTEST_ARG_INVALID：未知 mode=${read.value}`);
        parsed.mode = mode as DevTestMode;
      } else if (flag === '--project') parsed.project = read.value;
      else if (flag === '--project-root') parsed.projectRoot = read.value;
      else if (flag === '--output' || flag === '--out') parsed.output = read.value;
      else if (flag === '--approval') parsed.approvalId = read.value;
      else if (flag === '--repro') {
        if (!/^P\d{3,}$/i.test(read.value)) throw new Error(`DEVTEST_ARG_INVALID：--repro 需要 P001 格式的问题 ID`);
        parsed.reproProblemId = read.value.toUpperCase();
      }
      else if (flag === '--max-cases') parsed.maxCases = Number(read.value);
      else if (flag === '--concurrency') parsed.concurrency = Number(read.value);
      else if (flag === '--timeout') parsed.timeoutMs = Number(read.value);
      else if (flag === '--max-runtime') parsed.maxRuntimeMs = Number(read.value);
      else if (flag === '--budget') parsed.budget = Number(read.value);
    } else throw new Error(`DEVTEST_ARG_UNKNOWN：未知参数 ${flag}，使用 --help 查看帮助`);
  }
  if (positional.length > 1) throw new Error(`DEVTEST_ARG_INVALID：只允许一个 Requirement 文件，收到 ${positional.join(', ')}`);
  if (seen.has('--output') && seen.has('--out')) throw new Error('DEVTEST_ARG_DUPLICATE：--output 与 --out 是同一参数');
  if (seen.has('--mode') && seen.has('--dry-run')) throw new Error('DEVTEST_ARG_CONFLICT：--mode 与 --dry-run 不能同时使用');
  if (seen.has('--fail-fast') && seen.has('--no-fail-fast')) throw new Error('DEVTEST_ARG_CONFLICT：--fail-fast 与 --no-fail-fast 不能同时使用');
  if (parsed.plan && parsed.preflight) throw new Error('DEVTEST_ARG_CONFLICT：--plan 与 --preflight 不能同时使用');
  if (parsed.final && (parsed.plan || parsed.preflight || parsed.rerun || parsed.reproProblemId || parsed.mode !== 'SAFE')) {
    throw new Error('DEVTEST_ARG_CONFLICT：--final 必须是完整 SAFE 验收，不能与 plan/preflight/rerun/repro/LIVE/DRY_RUN 组合');
  }
  if (parsed.reproProblemId && parsed.rerun) throw new Error('DEVTEST_ARG_CONFLICT：--repro 与 --rerun 不能同时使用');
  if (parsed.sandbox && !parsed.confirmMutations) throw new Error('DEVTEST_ARG_CONFLICT：--sandbox 必须与 --confirm-mutations 一起使用');
  if (positional[0] && parsed.doc) throw new Error('DEVTEST_ARG_CONFLICT：位置 Requirement 与 --doc 不能同时使用');
  parsed.doc ??= positional[0];
  if (!parsed.doc && !parsed.feishu) throw new Error('DEVTEST_ARG_MISSING：必须提供 Requirement 文件或 --feishu');
  if (parsed.doc && parsed.feishu) throw new Error('DEVTEST_ARG_CONFLICT：Requirement 文件与 --feishu 只能选择一个');
  if (!['local', 'test', 'integration'].includes(parsed.env)) throw new Error(`DEVTEST_ARG_INVALID：环境 ${parsed.env} 不允许`);
  if (!Number.isInteger(parsed.maxCases) || parsed.maxCases < 1 || parsed.maxCases > 100) {
    throw new Error(`DEVTEST_ARG_INVALID：--max-cases 必须是 1~100 的整数`);
  }
  if (!Number.isInteger(parsed.concurrency) || parsed.concurrency < 1 || parsed.concurrency > 8) {
    throw new Error('DEVTEST_ARG_INVALID：--concurrency 必须是 1~8 的整数');
  }
  if (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs < 1) throw new Error('DEVTEST_ARG_INVALID：--timeout 必须是正整数毫秒');
  if (parsed.maxRuntimeMs !== undefined && (!Number.isInteger(parsed.maxRuntimeMs) || parsed.maxRuntimeMs < 1)) {
    throw new Error('DEVTEST_ARG_INVALID：--max-runtime 必须是正整数毫秒');
  }
  if (parsed.budget !== undefined && (!Number.isFinite(parsed.budget) || parsed.budget < 0)) {
    throw new Error('DEVTEST_ARG_INVALID：--budget 必须是非负数字');
  }
  return parsed;
}

function printOnePageSummary(result: Awaited<ReturnType<typeof runDevTest>>): void {
  const confirmed = result.problems.filter((item) => item.judgement === 'CONFIRMED_BUG').slice(0, 5);
  const blocked = result.problems.filter((item) => ['ENVIRONMENT_ISSUE', 'CONTRACT_ISSUE', 'TEST_ISSUE', 'REQUIREMENT_ISSUE'].includes(item.judgement ?? '')).slice(0, 5);
  const unknown = result.problems.filter((item) => item.judgement === 'UNKNOWN').slice(0, 5);
  console.log(`\n${result.conclusion}`);
  console.log('\n确认问题：');
  console.log(confirmed.length ? confirmed.map((item) => `${item.id} ${item.message}`).join('\n') : '无');
  console.log('\n阻断：');
  console.log(blocked.length ? blocked.map((item) => `${item.id} ${item.message}`).join('\n') : '无');
  console.log('\n未知：');
  console.log(unknown.length ? unknown.map((item) => `${item.id} ${item.message}`).join('\n') : '无');
  console.log('\n下一步：');
  console.log(result.problems.length ? result.problems.slice(0, 5).map((item, index) => `${index + 1}. ${item.remediation ?? item.message}`).join('\n') : '1. 无阻断动作，可提交评审。');
  console.log(`\n详情：${result.artifacts.acceptanceSummaryMd}`);
}

function printResult(result: Awaited<ReturnType<typeof runDevTest>>, preflightOnly = false, planOnly = false, summaryOnly = false): void {
  printOnePageSummary(result);
  if (summaryOnly) return;
  const contracts = result.pipeline.contracts.resolutions;
  const resolved = contracts.filter((item) => item.status === 'RESOLVED').length;
  const unknown = contracts.length - resolved;
  const unknowns = result.pipeline.report.coverage.unverifiedFacts.length
    + result.pipeline.report.observationGaps.length + result.pipeline.report.bindingIssues.length;
  console.log('\nDevTest');
  console.log('────────────────────────────');
  if (result.sourceSync) {
    console.log(`Source Sync        ${result.sourceSync.status} ${result.sourceSync.repositories.length} repos / ${result.sourceSync.repositories.filter((item) => item.updated).length} updated`);
  }
  const checks = result.environmentPreflight.checks;
  const mark = (status: string): string => status === 'READY' || status === 'NOT_REQUIRED' ? '✓' : status === 'UNKNOWN' ? '?' : '✗';
  console.log(`Environment        ${result.environmentPreflight.status}`);
  console.log(`Base URL           ${mark(checks.baseUrl)} ${result.environmentPreflight.selectedBaseUrl ?? result.environmentPreflight.reason ?? ''}`);
  console.log(`Health Check       ${mark(checks.health)} ${checks.health}`);
  console.log(`Authentication     ${mark(checks.authentication)} ${checks.authentication}`);
  console.log(`API Availability   ${mark(checks.api)} ${checks.api}`);
  console.log(`Browser            ${mark(checks.browser)} ${checks.browser}`);
  console.log(`Database           ${mark(checks.database)} ${checks.database}`);
  console.log(`Executable         ${result.environmentPreflight.executableDimensions.join(', ') || 'none'}`);
  console.log(`Blocked            ${result.environmentPreflight.blockedDimensions.map((item) => `${item.dimension}:${item.reason}`).join(', ') || 'none'}`);
  console.log('────────────────────────────');
  if (preflightOnly) {
    console.log(`Report             ${result.artifacts.reportHtml}`);
    return;
  }
  if (planOnly) {
    console.log(`Feature            ${result.plan.feature}`);
    console.log(`Risk               ${result.plan.risk}`);
    for (const item of result.plan.dimensions) console.log(`${item.dimension.padEnd(20)} ${item.cases} (${item.applicability})`);
    console.log(`Expected Cases     ${result.plan.estimatedCases}`);
    console.log(`SAFE Executable    ${result.plan.estimatedExecutable}`);
    console.log(`Expected BLOCKED   ${result.plan.estimatedBlocked}`);
    console.log(`Core Cases         ${result.plan.coreCases.map((item) => `${item.kind}:${item.caseId}`).join(', ') || 'none'}`);
    console.log(`Tiers              T0=${result.plan.tiers.TIER_0.length} T1=${result.plan.tiers.TIER_1.length} T2=${result.plan.tiers.TIER_2.length} Deep=${result.plan.deep}`);
    console.log(`Deduplication      ${result.plan.deduplication.generated} -> ${result.plan.deduplication.retained}`);
    console.log(`Side Effects       ${result.plan.estimatedSideEffects.filter((item) => item.effect !== 'READ').map((item) => `${item.effect}:${item.caseId}${item.blocked ? '(BLOCKED)' : ''}`).join(', ') || 'none'}`);
    console.log(`Cache              ${result.plan.cache.status} (${result.plan.cache.reason})`);
    console.log(`Impact             ${result.plan.impact.applied ? 'APPLIED' : 'ADVISORY'} (${result.plan.impact.reason})`);
    console.log(`Report             ${result.artifacts.reportHtml}`);
    return;
  }
  console.log('Requirement        ✓');
  console.log(`Contract           ${result.pipeline.contracts.validation.status === 'VALID' ? '✓' : '!' } ${resolved} ACTIVE / ${unknown} UNKNOWN_OR_BLOCKED`);
  console.log('Risk Analysis      ✓');
  console.log(`Case Generation    ✓ ${result.pipeline.summary.designed} cases`);
  console.log('');
  for (const stat of result.dimensionStats) console.log(`${stat.dimension.padEnd(20)} ${stat.total} cases`);
  console.log(`\n${result.mode} Execution`);
  console.log('────────────────────────────');
  console.log(`PASS               ${result.pipeline.summary.passed}`);
  console.log(`FAIL               ${result.pipeline.summary.failed}`);
  console.log(`BLOCKED            ${result.pipeline.summary.blocked}`);
  console.log(`NOT_EXECUTED       ${result.pipeline.summary.notExecuted}`);
  console.log(`\nProblems           ${result.problems.length}`);
  console.log(`Unknowns           ${unknowns}`);
  console.log(`Core AC Coverage   ${result.requirementCoverage.coreCoverage}%`);
  console.log(`Dev Confidence     ${result.devConfidence.score}/100${result.devConfidence.failClosed ? ' (Fail-Closed)' : ''}`);
  console.log(`Test Reliability   ${result.reliability.score}/100 (${result.reliability.flaky} flaky)`);
  console.log(`Requirement Quality ${result.requirementQuality.score}/100 · Testability ${result.requirementQuality.testability}/100`);
  console.log(`Business Flows     ${result.businessFlowGraph.coverage}% (${result.businessFlowGraph.flows.length})`);
  console.log(`Regression Guard   ${result.regressionGuard.status}`);
  console.log(`Estimate           ${result.executionEstimate.estimatedCases} cases / ${result.executionEstimate.estimatedRequests} requests / ${result.executionEstimate.estimatedRuntimeMs}ms / ${result.executionEstimate.estimatedCost} ${result.executionEstimate.costUnit}`);
  console.log(`\nFeature Result: ${result.conclusion}`);
  if (result.reproduction) console.log(`Reproduction       ${result.reproduction.problemId} ${result.reproduction.status}`);
  for (const outcome of result.baseline.rerunOutcomes) console.log(`Rerun              ${outcome.target} ${outcome.status}`);
  console.log('\nReports:');
  console.log(result.artifacts.reportHtml);
  console.log(result.artifacts.reportJson);
  console.log(result.artifacts.casesCsv);
  console.log(result.artifacts.problemsMd);
  console.log(result.artifacts.acceptanceSummaryMd);
  console.log(result.artifacts.testCasesMd);
  console.log(result.artifacts.developerSelfTestReportMd);
  if (result.artifacts.sourceSyncJson) console.log(result.artifacts.sourceSyncJson);
}

/** CI/脚本语义同样 fail-closed：只有 READY 才是成功退出。报告始终先完整落盘。 */
export function devTestExitCode(conclusion: Awaited<ReturnType<typeof runDevTest>>['conclusion']): number {
  return conclusion === 'READY' ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(DEVTEST_HELP);
    return 0;
  }
  try {
    const args = parseDevTestArgs(argv);
    const result = await runDevTest({
      docPath: args.doc, feishuUrl: args.feishu, feishuCredentialsPath: args.feishuCredentials,
      baseUrl: args.baseUrl, environment: args.env, mode: args.mode, project: args.project,
      outDir: args.output, approvalId: args.approvalId, confirmMutations: args.confirmMutations,
      maxCases: args.maxCases, enabledDimensions: args.enabledDimensions,
      rerun: args.rerun,
      rerunTarget: args.rerunTarget,
      reproProblemId: args.reproProblemId,
      plan: args.plan,
      preflight: args.preflight,
      sandbox: args.sandbox,
      final: args.final,
      failFast: args.failFast,
      concurrency: args.concurrency,
      timeoutMs: args.timeoutMs,
      maxRuntimeMs: args.maxRuntimeMs,
      budget: args.budget,
      deep: args.deep,
      summary: args.summary,
      projectRoot: args.projectRoot ?? PANQU_AI_SOURCE_ROOT,
      sourceSync: { enabled: true, root: PANQU_AI_SOURCE_ROOT, cleanUntracked: true },
    });
    printResult(result, args.preflight, args.plan, args.summary);
    if (args.preflight) return result.environmentPreflight.status === 'BLOCKED' ? 1 : 0;
    if (args.plan) return 0;
    return devTestExitCode(result.conclusion);
  } catch (error) {
    console.error(`DEVTEST_ERROR: ${redactSensitiveText((error as Error).message)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
