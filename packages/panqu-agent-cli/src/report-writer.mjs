/**
 * 报告生成器：从执行数据构建 report.json / report.md / analysis.json / logs。
 *
 * Markdown 报告是 JSON 报告的可读渲染（单一事实来源），绝不产生两套矛盾事实。
 * overall_status 由确定性代码计算，规则见 computeOverallStatus。
 */
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { redactText } from './redact.mjs';

export const REPORT_SCHEMA_VERSION = 'panqu-local-validator-report-v1';
export const AGENT_NAME = 'panqu-Test-agent';

export function runId() {
  return `run-${Date.now().toString(36)}-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}`;
}

export function workspaceId(workspacePath) {
  return createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
}

/**
 * 确定性 overall_status 计算。
 * @param {Array<{status:string}>} checks
 * @param {string} analysisStatus 'PASSED'|'BLOCKED'|'ERROR'|'SKIPPED'
 * @param {{requested:boolean,status:string}} api
 * @returns {string}
 */
export function computeOverallStatus(checks, analysisStatus, api) {
  const checkStatuses = checks.map((c) => c.status);
  if (checkStatuses.includes('FAILED')) return 'FAILED';
  if (checkStatuses.includes('TIMEOUT') || checkStatuses.includes('ERROR')) return 'ERROR';
  if (analysisStatus === 'ERROR' || analysisStatus === 'TIMEOUT') return 'ERROR';

  // 必要项 BLOCKED（含分析未登录/调用缺失、显式请求的 API 被阻断）
  if (checkStatuses.includes('BLOCKED')) return 'BLOCKED';
  if (analysisStatus === 'BLOCKED') return 'BLOCKED';
  if (api.requested && (api.status === 'BLOCKED' || api.status === 'BLOCKED_PLAN_ONLY' || api.status === 'ERROR')) return 'BLOCKED';

  // 所有实际要求项 PASSED 才允许 PASSED
  const allChecksPassed = checkStatuses.every((s) => s === 'PASSED');
  if (allChecksPassed && analysisStatus === 'PASSED') {
    return 'PASSED';
  }
  // 有 SKIPPED 等未验证项 → 不伪造 PASSED（含 dry-run 全 SKIPPED）
  return 'SKIPPED';
}

export function overallExplanation(overall, checks, analysisStatus, api) {
  const parts = [];
  if (checks.some((c) => c.status === 'FAILED')) parts.push('存在失败检查（FAILED）');
  if (checks.some((c) => c.status === 'TIMEOUT' || c.status === 'ERROR')) parts.push('存在超时/错误（TIMEOUT/ERROR）');
  if (checks.some((c) => c.status === 'BLOCKED')) parts.push('存在被阻塞的必要检查（BLOCKED）');
  if (analysisStatus === 'BLOCKED') parts.push('Trae 模型分析被阻塞（未登录/未安装）');
  if (analysisStatus === 'ERROR') parts.push('Trae 模型分析失败（ERROR）');
  if (api.requested && (api.status === 'BLOCKED' || api.status === 'BLOCKED_PLAN_ONLY' || api.status === 'ERROR')) {
    parts.push(`显式请求的 API 测试未执行（${api.status}）`);
  }
  if (checks.some((c) => c.status === 'SKIPPED')) parts.push('存在未执行的检查（SKIPPED，不计为通过）');
  if (parts.length === 0 && overall === 'PASSED') parts.push('所有实际要求项均通过');
  if (parts.length === 0) parts.push('未发现失败/阻塞，但存在未验证项，不计为 PASSED');
  return parts.join('；');
}

/**
 * 构建完整 report 对象。
 * @param {object} input 见 validate.mjs 调用处
 */
export function buildReport(input) {
  const {
    runId: runIdValue,
    startedAt,
    finishedAt,
    agentVersion,
    agentProvenance,
    workspaceInfo,
    environment,
    discovery,
    checks,
    analysis,
    api,
    limitations,
    dryRun,
    artifacts,
  } = input;

  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const analysisStatus = analysis ? analysis.status : dryRun ? 'SKIPPED' : 'BLOCKED';
  const overall = computeOverallStatus(checks, analysisStatus, api);
  const totals = countTotals(checks);

  const analysisSection = analysis
    ? {
        status: analysis.status,
        reason: analysis.reason || null,
        attempts: typeof analysis.attempts === 'number' ? analysis.attempts : 1,
        ...(analysis.data || {}),
      }
    : {
        status: dryRun ? 'SKIPPED' : 'BLOCKED',
        reason: dryRun ? 'dry-run 未调用模型' : '分析未执行',
        attempts: 0,
      };

  return {
    schema_version: REPORT_SCHEMA_VERSION,
    run_id: runIdValue,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,
    agent: {
      name: AGENT_NAME,
      version: agentVersion,
      source: agentProvenance.source,
      source_spec: agentProvenance.source_spec,
      source_commit_or_tag: agentProvenance.source_commit_or_tag,
      provenance_status: agentProvenance.provenance_status,
      provenance_detail: agentProvenance.provenance_detail,
      model_runtime: 'traecli',
    },
    workspace: {
      workspace_id: workspaceInfo.workspaceId,
      workspace_basename: workspaceInfo.basename,
      git_head: workspaceInfo.gitHead,
      branch: workspaceInfo.branch,
      dirty: workspaceInfo.dirty,
      snapshot_path: workspaceInfo.snapshotPath,
      excluded_files: workspaceInfo.excludedFiles,
      snapshot_cleanup: workspaceInfo.snapshotCleanup,
    },
    environment: {
      ...environment,
      package_manager: discovery.manager,
    },
    discovery_status: discovery.status,
    discovery_reason: discovery.reason || null,
    analysis: analysisSection,
    checks,
    api: {
      requested: api.requested,
      executed: api.executed,
      origin: api.origin,
      status: api.status,
      reason: api.reason || null,
      plan: api.plan || null,
      cases: api.cases || [],
    },
    totals,
    limitations,
    overall_status: overall,
    overall_explanation: overallExplanation(overall, checks, analysisStatus, api),
    dry_run: Boolean(dryRun),
    artifacts,
  };
}

export function countTotals(checks) {
  const totals = { passed: 0, failed: 0, skipped: 0, blocked: 0, timeout: 0, error: 0 };
  for (const c of checks) {
    switch (c.status) {
      case 'PASSED': totals.passed += 1; break;
      case 'FAILED': totals.failed += 1; break;
      case 'SKIPPED': totals.skipped += 1; break;
      case 'BLOCKED': totals.blocked += 1; break;
      case 'TIMEOUT': totals.timeout += 1; break;
      case 'ERROR': totals.error += 1; break;
      default: break;
    }
  }
  totals.total = checks.length;
  return totals;
}

/**
 * 写报告与日志到 <reportDir>/<runId>/。
 * 返回 { reportDir, runId, files }
 */
export function writeReport({ reportBaseDir, runId: runIdValue, report, checks, analysis, logs }) {
  const dir = join(resolve(reportBaseDir), runIdValue);
  const logsDir = join(dir, 'logs');
  mkdirSync(logsDir, { recursive: true });

  // 日志文件
  const logRefs = {};
  for (const check of checks) {
    if (logs.checkStdout[check.name]) {
      const f = `logs/check-${check.name}.stdout.log`;
      writeFileSync(join(dir, f), redactText(logs.checkStdout[check.name]));
      logRefs[`check:${check.name}:stdout`] = f;
    }
    if (logs.checkStderr[check.name]) {
      const f = `logs/check-${check.name}.stderr.log`;
      writeFileSync(join(dir, f), redactText(logs.checkStderr[check.name]));
      logRefs[`check:${check.name}:stderr`] = f;
    }
  }
  if (logs.analysisStdout) {
    const f = 'logs/analysis.stdout.log';
    writeFileSync(join(dir, f), redactText(logs.analysisStdout));
    logRefs['analysis:stdout'] = f;
  }
  if (logs.analysisStderr) {
    const f = 'logs/analysis.stderr.log';
    writeFileSync(join(dir, f), redactText(logs.analysisStderr));
    logRefs['analysis:stderr'] = f;
  }

  const reportJsonPath = join(dir, 'report.json');
  const reportMdPath = join(dir, 'report.md');
  const analysisJsonPath = join(dir, 'analysis.json');

  const artifacts = {
    report_json: reportJsonPath,
    report_md: reportMdPath,
    analysis_json: analysisJsonPath,
    logs_dir: logsDir,
    log_files: logRefs,
  };
  const finalReport = { ...report, artifacts };

  writeFileSync(reportJsonPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  writeFileSync(reportMdPath, renderMarkdown(finalReport));
  writeFileSync(analysisJsonPath, `${JSON.stringify(finalReport.analysis, null, 2)}\n`);

  return { reportDir: dir, runId: runIdValue, files: artifacts, report: finalReport };
}

export function renderMarkdown(report) {
  const L = [];
  L.push(`# panqu-Test-agent 本地验证报告`);
  L.push('');
  L.push(`- run_id: \`${report.run_id}\``);
  L.push(`- 时间: ${report.started_at} → ${report.finished_at}（${report.duration_ms}ms）`);
  L.push(`- overall_status: **${report.overall_status}**`);
  L.push(`- 说明: ${report.overall_explanation}`);
  L.push('');
  L.push('## Agent');
  L.push('');
  L.push(`- name: ${report.agent.name}`);
  L.push(`- version: ${report.agent.version}`);
  L.push(`- source: ${report.agent.source}`);
  L.push(`- source_spec: ${report.agent.source_spec || '-'}`);
  L.push(`- source_commit_or_tag: ${report.agent.source_commit_or_tag || 'null'}`);
  L.push(`- provenance_status: ${report.agent.provenance_status}`);
  L.push(`- model_runtime: ${report.agent.model_runtime}`);
  L.push('');
  L.push('## Workspace');
  L.push('');
  L.push(`- workspace_id: \`${report.workspace.workspace_id}\`（${report.workspace.workspace_basename}）`);
  L.push(`- git_head: \`${report.workspace.git_head || '-'}\``);
  L.push(`- branch: \`${report.workspace.branch || '-'}\``);
  L.push(`- dirty: ${report.workspace.dirty}`);
  L.push(`- snapshot_path: \`${report.workspace.snapshot_path || '-'}\``);
  L.push(`- snapshot_cleanup: ${JSON.stringify(report.workspace.snapshot_cleanup || null)}`);
  if (report.workspace.excluded_files && report.workspace.excluded_files.length > 0) {
    L.push('');
    L.push('### 被排除的未跟踪文件');
    L.push('');
    for (const ex of report.workspace.excluded_files) {
      L.push(`- \`${ex.path}\` — ${ex.reason}`);
    }
  }
  L.push('');
  L.push('## Environment');
  L.push('');
  L.push(`- os: ${report.environment.os}`);
  L.push(`- node: ${report.environment.node}`);
  L.push(`- package_manager: ${report.environment.package_manager}`);
  L.push(`- traecli_version: ${report.environment.traecli_version || '-'}`);
  L.push(`- trae_login_status: ${report.environment.trae_login_status}`);
  L.push('');
  L.push('## Analysis (Trae 内置模型)');
  L.push('');
  L.push(`- status: **${report.analysis.status}**`);
  if (report.analysis.reason) L.push(`- reason: ${report.analysis.reason}`);
  if (report.analysis.architecture_summary) {
    L.push('');
    L.push(`架构概述: ${report.analysis.architecture_summary}`);
    L.push('');
    if (report.analysis.changed_areas && report.analysis.changed_areas.length) {
      L.push('### 变更影响区域');
      L.push('');
      for (const area of report.analysis.changed_areas) {
        L.push(`- \`${area.path || area}\`: ${area.impact || ''}`);
      }
      L.push('');
    }
    if (report.analysis.risks && report.analysis.risks.length) {
      L.push('### 风险');
      L.push('');
      for (const r of report.analysis.risks) {
        L.push(`- [${r.level}] ${r.category} — ${r.description}${r.mitigation ? `（缓解: ${r.mitigation}）` : ''}`);
      }
      L.push('');
    }
    if (report.analysis.recommended_checks && report.analysis.recommended_checks.length) {
      L.push('### 推荐检查');
      L.push('');
      for (const rc of report.analysis.recommended_checks) L.push(`- ${rc}`);
      L.push('');
    }
    if (report.analysis.execution_evidence) {
      L.push('### 实际执行证据');
      L.push('');
      L.push(report.analysis.execution_evidence);
      L.push('');
    }
    if (report.analysis.unverified_content && report.analysis.unverified_content.length) {
      L.push('### 未验证内容（模型声明，非执行证据）');
      L.push('');
      for (const u of report.analysis.unverified_content) L.push(`- ${u}`);
      L.push('');
    }
  }
  L.push('## Checks');
  L.push('');
  L.push('| check | command | status | exit | signal | duration | summary |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of report.checks) {
    L.push(`| ${c.name} | \`${c.command}\` | **${c.status}** | ${c.exit_code ?? '-'} | ${c.signal ?? '-'} | ${c.duration_ms}ms | ${c.summary || ''} |`);
  }
  L.push('');
  L.push('## API 黑盒测试');
  L.push('');
  L.push(`- requested: ${report.api.requested}`);
  L.push(`- executed: ${report.api.executed}`);
  L.push(`- origin: ${report.api.origin || '-'}`);
  L.push(`- status: ${report.api.status}`);
  if (report.api.reason) L.push(`- reason: ${report.api.reason}`);
  L.push('');
  L.push('## Totals');
  L.push('');
  L.push(`- passed=${report.totals.passed} failed=${report.totals.failed} skipped=${report.totals.skipped} blocked=${report.totals.blocked} timeout=${report.totals.timeout} error=${report.totals.error} (total=${report.totals.total})`);
  L.push('');
  L.push('## Limitations');
  L.push('');
  for (const lim of report.limitations) L.push(`- ${lim}`);
  L.push('');
  L.push('## Artifacts');
  L.push('');
  L.push(`- report.json: \`${report.artifacts.report_json}\``);
  L.push(`- report.md: \`${report.artifacts.report_md}\``);
  L.push(`- analysis.json: \`${report.artifacts.analysis_json}\``);
  L.push(`- logs_dir: \`${report.artifacts.logs_dir}\``);
  L.push('');
  return L.join('\n');
}
