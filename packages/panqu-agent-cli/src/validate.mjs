/**
 * validate 流水线编排（唯一执行路径）。
 *
 * 顺序：
 *   1. 语义参数校验（白名单 check / 超时 / workspace / report-dir / api-origin）
 *   2. preflight（node / git / traecli 存在性 / 登录状态 / workspace 为 Git 工作区）
 *   3. 隔离快照（只读工作区 + diff + 未跟踪安全复制）
 *   4. 项目发现（包管理器 / 脚本 / 多 lockfile fail-closed）
 *   5. 确定性检查（typecheck/lint/test/build，白名单、shell:false、超时、输出上限）
 *   6. Trae 内置模型只读分析（未登录/缺失 → BLOCKED，调用失败 → ERROR）
 *   7. API 黑盒门禁（默认关闭；MVP 仅 plan-only，不发起 HTTP）
 *   8. 报告落盘（report.json / report.md / analysis.json / logs）并输出
 */
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  parseChecks,
  parseTimeout,
  parseWorkspace,
  parseReportDir,
  parseApiOrigin,
  CLI_NAME,
  readVersion,
} from './cli.mjs';
import {
  findTraecli,
  collectEnvironment,
  validateWorkspace,
  gitContext,
} from './preflight.mjs';
import {
  createSnapshot,
  cleanupSnapshot,
} from './workspace-snapshot.mjs';
import {
  detectPackageManager,
  readPackageJson,
  planChecks,
  hasDependencyDeclared,
  hasNodeModules,
  dependencyBlockReason,
} from './project-discovery.mjs';
import { runCheck, commandDisplay } from './check-runner.mjs';
import { runTraeAnalysis, composePrompt } from './trae-analyzer.mjs';
import { evaluateApiRequest } from './api-runner.mjs';
import {
  buildReport,
  writeReport,
  runId,
  workspaceId,
} from './report-writer.mjs';
import { fileURLToPath } from 'node:url';
import { computeProvenance } from './provenance.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DISTRIBUTION_SOURCE = 'https://github.com/CAoyinggo/panqu-Test-agent';

/** 计算 agent provenance（source / source_spec / source_commit_or_tag / provenance_status）。 */
function computeAgentProvenance(agentVersion) {
  return computeProvenance({
    agentVersion,
    distributionSource: DISTRIBUTION_SOURCE,
    pkgDir: join(__dirname, '..'),
  });
}

function exitCodeFor(overall) {
  switch (overall) {
    case 'PASSED': return 0;
    case 'FAILED': return 1;
    case 'ERROR': return 2;
    case 'BLOCKED': return 3;
    case 'SKIPPED': return 4;
    default: return 2;
  }
}

function defaultReportBaseDir(workspacePath) {
  return join(homedir(), '.panqu-test-agent', 'reports', workspaceId(workspacePath));
}

export async function runValidate(opts) {
  // —— 语义参数校验 ——
  const checksRes = parseChecks(opts.checks);
  if (!checksRes.ok) {
    process.stderr.write(`[${CLI_NAME}] ${checksRes.errors.join('\n')}\n`);
    return 2;
  }
  const timeoutRes = parseTimeout(opts.timeoutMs);
  if (!timeoutRes.ok) {
    process.stderr.write(`[${CLI_NAME}] ${timeoutRes.error}\n`);
    return 2;
  }
  const wsRes = parseWorkspace(opts.workspace);
  if (!wsRes.ok) {
    process.stderr.write(`[${CLI_NAME}] ${wsRes.error}\n`);
    return 2;
  }
  const originRes = parseApiOrigin(opts.apiOrigin);
  if (!originRes.ok) {
    process.stderr.write(`[${CLI_NAME}] ${originRes.error}\n`);
    return 2;
  }
  const workspacePath = wsRes.path;
  const reportBaseDir = opts.reportDir || defaultReportBaseDir(workspacePath);
  const runIdValue = runId();
  const startedAt = new Date();
  const agentVersion = readVersion();

  const limitationsBase = [
    '当前仅支持 Git 工作区；非 Git 项目 fail closed（不做不安全的全目录复制）',
    'MVP 仅支持 Node.js 项目（需要 package.json）',
    'package.json 中受信任的脚本本身仍可能执行任意项目代码，因此本命令仅适用于开发者信任的本地仓库',
    '不自动执行 npm install / npm ci；依赖已声明但 node_modules 缺失时相关检查标记为 BLOCKED',
    'Trae 模型使用 --sandbox read-only 只读分析，不修改文件、不自行运行构建/测试/lint、不发起 API 请求',
    '确定性检查在隔离快照中执行，原始工作区不被构建/测试或写入',
  ];

  // —— preflight ——
  const traecliPath = await findTraecli();
  const environment = await collectEnvironment(traecliPath);
  const wsValidate = await validateWorkspace(workspacePath);

  if (!wsValidate.ok) {
    return finishEarly({
      opts,
      reportBaseDir,
      runIdValue,
      startedAt,
      agentVersion,
      workspacePath,
      environment,
      traecliPath,
      reason: wsValidate.reason,
      status: 'BLOCKED',
      limitations: [...limitationsBase, wsValidate.reason],
    });
  }

  const gitCtx = await gitContext(workspacePath);

  // —— 隔离快照 ——
  let snapshot = null;
  let snapshotResult = null;
  if (!opts.dryRun) {
    snapshotResult = createSnapshot(workspacePath);
    if (!snapshotResult.ok) {
      return finishEarly({
        opts,
        reportBaseDir,
        runIdValue,
        startedAt,
        agentVersion,
        workspacePath,
        environment,
        traecliPath,
        gitCtx,
        reason: snapshotResult.reason,
        status: 'BLOCKED',
        limitations: [...limitationsBase, `快照创建失败: ${snapshotResult.reason}`],
      });
    }
    snapshot = snapshotResult;
  }

  // —— 项目发现 ——
  const discoverPath = snapshot ? snapshot.worktree : workspacePath;
  const discovery = detectPackageManager(discoverPath);
  if (!discovery.ok) {
    const cleanup = snapshot ? cleanupSnapshot(snapshot) : { cleaned: ['not_created'], errors: [] };
    return finishEarly({
      opts,
      reportBaseDir,
      runIdValue,
      startedAt,
      agentVersion,
      workspacePath,
      environment,
      traecliPath,
      gitCtx,
      snapshot,
      cleanup,
      reason: discovery.reason,
      status: 'BLOCKED',
      limitations: [...limitationsBase, discovery.reason],
    });
  }
  const pkg = readPackageJson(discoverPath);
  if (!pkg.ok) {
    const cleanup = snapshot ? cleanupSnapshot(snapshot) : { cleaned: ['not_created'], errors: [] };
    return finishEarly({
      opts,
      reportBaseDir,
      runIdValue,
      startedAt,
      agentVersion,
      workspacePath,
      environment,
      traecliPath,
      gitCtx,
      snapshot,
      cleanup,
      reason: pkg.reason,
      status: 'BLOCKED',
      limitations: [...limitationsBase, pkg.reason],
    });
  }

  const checkPlan = planChecks(checksRes.checks, pkg.data.scripts);
  const depsDeclared = hasDependencyDeclared(pkg.data);
  const nodeModulesPresent = snapshot ? hasNodeModules(snapshot.worktree) : hasNodeModules(discoverPath);
  const manager = discovery.manager;

  // —— 确定性检查 ——
  const checks = [];
  const logs = { checkStdout: {}, checkStderr: {}, analysisStdout: '', analysisStderr: '' };

  if (opts.dryRun) {
    for (const item of checkPlan) {
      checks.push({
        name: item.name,
        command: item.scriptName ? commandDisplay(manager, item.scriptName) : null,
        status: 'SKIPPED',
        exit_code: null,
        signal: null,
        duration_ms: 0,
        stdout_log: null,
        stderr_log: null,
        summary: 'dry-run：未执行（--dry-run）',
      });
    }
  } else {
    for (const item of checkPlan) {
      if (item.status === 'SKIPPED') {
        checks.push({
          name: item.name,
          command: null,
          status: 'SKIPPED',
          exit_code: null,
          signal: null,
          duration_ms: 0,
          stdout_log: null,
          stderr_log: null,
          summary: item.reason || '脚本不存在，SKIPPED',
        });
        continue;
      }
      const blocked = dependencyBlockReason(depsDeclared, nodeModulesPresent);
      const res = await runCheck({
        name: item.name,
        scriptName: item.scriptName,
        cwd: snapshot.worktree,
        manager,
        timeoutMs: timeoutRes.value,
        blocked,
      });
      logs.checkStdout[item.name] = res.stdout;
      logs.checkStderr[item.name] = res.stderr;
      checks.push({
        name: item.name,
        command: commandDisplay(manager, item.scriptName),
        status: res.status,
        exit_code: res.exitCode,
        signal: res.signal,
        duration_ms: res.durationMs,
        stdout_log: res.stdout.length > 0 ? `logs/check-${item.name}.stdout.log` : null,
        stderr_log: res.stderr.length > 0 ? `logs/check-${item.name}.stderr.log` : null,
        summary: res.summary,
      });
    }
  }

  // —— Trae 内置模型分析 ——
  let analysis = null;
  if (opts.dryRun) {
    analysis = { status: 'SKIPPED', reason: 'dry-run：未调用模型', data: null };
  } else {
    const promptTemplate = readFileSync(join(__dirname, '..', 'prompts', 'panqu-local-validator.md'), 'utf8');
    const schemaPath = join(__dirname, '..', 'schemas', 'analysis.schema.json');
    const outputJsonPath = join(reportBaseDir, runIdValue, 'analysis-raw.json');
    const context = {
      WORKSPACE_SUMMARY: JSON.stringify({
        basename: gitCtx.basename,
        branch: gitCtx.branch,
        git_head: gitCtx.gitHead,
        dirty: gitCtx.dirty,
        package_manager: manager,
        scripts: pkg.data.scripts || {},
      }, null, 2),
      CHECK_RESULTS: JSON.stringify(checks.map((c) => ({ name: c.name, status: c.status, exit_code: c.exit_code, summary: c.summary })), null, 2),
      GIT_CONTEXT: JSON.stringify({ head: gitCtx.gitHead, branch: gitCtx.branch, dirty: gitCtx.dirty }, null, 2),
      API_ORIGIN: opts.apiOrigin ? opts.apiOrigin : '未启用',
    };
    const prompt = composePrompt(promptTemplate, context);
    analysis = await runTraeAnalysis({
      snapshotPath: snapshot.worktree,
      promptTemplate: prompt,
      schemaPath,
      outputJsonPath,
      traecliPath,
      loginStatus: environment.trae_login_status,
    });
    logs.analysisStdout = analysis.stdout;
    logs.analysisStderr = analysis.stderr;
  }

  // —— API 门禁 ——
  const api = evaluateApiRequest({
    executeApi: opts.executeApi,
    apiOrigin: originRes.value,
  });

  // —— limitations 组装 ——
  const limitations = [...limitationsBase];
  if (api.requested) {
    limitations.push('真实 API 黑盒执行未实现（本轮仅 plan-only），未发起任何 HTTP 请求；后续复用已加固的 execute_test_plan 执行器');
  }

  // —— 清理快照 ——
  const cleanup = snapshot ? cleanupSnapshot(snapshot) : { cleaned: ['not_created'], errors: [] };

  // —— 报告 ——
  const report = buildReport({
    runId: runIdValue,
    startedAt,
    finishedAt: new Date(),
    agentVersion,
    agentProvenance: computeAgentProvenance(agentVersion),
    workspaceInfo: {
      workspaceId: workspaceId(workspacePath),
      basename: gitCtx.basename,
      gitHead: gitCtx.gitHead,
      branch: gitCtx.branch,
      dirty: gitCtx.dirty,
      snapshotPath: snapshot ? snapshot.worktree : null,
      excludedFiles: snapshot ? snapshot.excluded : [],
      snapshotCleanup: cleanup,
    },
    environment,
    discovery,
    checks,
    analysis,
    api,
    limitations,
    dryRun: opts.dryRun,
    artifacts: {},
  });

  const written = writeReport({
    reportBaseDir,
    runId: runIdValue,
    report,
    checks,
    analysis,
    logs,
  });

  const finalReport = written.report;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(finalReport, null, 2)}\n`);
  } else {
    printSummary(finalReport);
  }

  return exitCodeFor(finalReport.overall_status);
}

async function finishEarly(input) {
  const {
    opts, reportBaseDir, runIdValue, startedAt, agentVersion, workspacePath,
    environment, traecliPath, gitCtx, snapshot, cleanup, reason, status, limitations,
  } = input;

  const report = buildReport({
    runId: runIdValue,
    startedAt,
    finishedAt: new Date(),
    agentVersion,
    agentProvenance: computeAgentProvenance(agentVersion),
    workspaceInfo: {
      workspaceId: workspaceId(workspacePath),
      basename: gitCtx ? gitCtx.basename : basename(workspacePath),
      gitHead: gitCtx ? gitCtx.gitHead : '',
      branch: gitCtx ? gitCtx.branch : '',
      dirty: gitCtx ? gitCtx.dirty : false,
      snapshotPath: snapshot ? snapshot.worktree : null,
      excludedFiles: snapshot ? snapshot.excluded : [],
      snapshotCleanup: cleanup || { cleaned: ['not_created'], errors: [] },
    },
    environment,
    discovery: { ok: false, status: status, manager: null, reason },
    checks: [],
    analysis: { status, reason, data: null },
    api: { requested: false, executed: false, origin: null, status: 'SKIPPED', reason: null, plan: null, cases: [] },
    limitations,
    dryRun: opts.dryRun,
    artifacts: {},
  });

  const written = writeReport({
    reportBaseDir,
    runId: runIdValue,
    report,
    checks: [],
    analysis: { status, reason, data: null },
    logs: { checkStdout: {}, checkStderr: {}, analysisStdout: '', analysisStderr: '' },
  });

  const finalReport = written.report;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(finalReport, null, 2)}\n`);
  } else {
    printSummary(finalReport);
  }
  return exitCodeFor(finalReport.overall_status);
}

function printSummary(report) {
  const out = [];
  out.push(`panqu-Test-agent 本地验证 (run_id=${report.run_id})`);
  out.push(`overall_status: ${report.overall_status}`);
  out.push(`  - ${report.overall_explanation}`);
  out.push(`workspace: ${report.workspace.workspace_basename} (id=${report.workspace.workspace_id}, branch=${report.workspace.branch || '-'}, dirty=${report.workspace.dirty})`);
  for (const c of report.checks) {
    out.push(`check ${c.name}: ${c.status}${c.summary ? ` (${c.summary})` : ''}`);
  }
  out.push(`analysis: ${report.analysis.status}${report.analysis.reason ? ` — ${report.analysis.reason}` : ''}`);
  out.push(`api: requested=${report.api.requested} executed=${report.api.executed} status=${report.api.status}${report.api.origin ? ` origin=${report.api.origin}` : ''}`);
  out.push(`totals: passed=${report.totals.passed} failed=${report.totals.failed} skipped=${report.totals.skipped} blocked=${report.totals.blocked} timeout=${report.totals.timeout} error=${report.totals.error}`);
  out.push(`report.json: ${report.artifacts.report_json}`);
  out.push(`report.md: ${report.artifacts.report_md}`);
  process.stdout.write(`${out.join('\n')}\n`);
}
