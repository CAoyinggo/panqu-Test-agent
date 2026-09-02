/**
 * 测试 10（部分）+ 15：PASSED/FAILED/BLOCKED/TIMEOUT/ERROR 分类；Markdown/JSON 报告一致性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { computeOverallStatus, buildReport, writeReport, runId, countTotals, REPORT_SCHEMA_VERSION } from '../src/report-writer.mjs';
import { tmpDir } from './helpers.mjs';

test('computeOverallStatus：确定性规则', () => {
  const P = { status: 'PASSED' };
  const F = { status: 'FAILED' };
  const B = { status: 'BLOCKED' };
  const T = { status: 'TIMEOUT' };
  const E = { status: 'ERROR' };
  const S = { status: 'SKIPPED' };

  assert.equal(computeOverallStatus([P, P], 'PASSED', { requested: false, status: 'SKIPPED' }), 'PASSED');
  assert.equal(computeOverallStatus([P, F], 'PASSED', { requested: false, status: 'SKIPPED' }), 'FAILED');
  assert.equal(computeOverallStatus([P, T], 'PASSED', { requested: false, status: 'SKIPPED' }), 'ERROR');
  assert.equal(computeOverallStatus([P, E], 'PASSED', { requested: false, status: 'SKIPPED' }), 'ERROR');
  assert.equal(computeOverallStatus([P], 'ERROR', { requested: false, status: 'SKIPPED' }), 'ERROR');
  assert.equal(computeOverallStatus([P, B], 'PASSED', { requested: false, status: 'SKIPPED' }), 'BLOCKED');
  assert.equal(computeOverallStatus([P, P], 'BLOCKED', { requested: false, status: 'SKIPPED' }), 'BLOCKED');
  assert.equal(computeOverallStatus([P, P], 'PASSED', { requested: true, status: 'BLOCKED' }), 'BLOCKED');
  assert.equal(computeOverallStatus([P, P], 'PASSED', { requested: true, status: 'BLOCKED_PLAN_ONLY' }), 'BLOCKED');
  // SKIPPED 不得计为 PASSED
  assert.equal(computeOverallStatus([P, S], 'PASSED', { requested: false, status: 'SKIPPED' }), 'SKIPPED');
  // dry-run（全 SKIPPED）自然得到 SKIPPED
  assert.equal(computeOverallStatus([S, S], 'SKIPPED', { requested: false, status: 'SKIPPED' }), 'SKIPPED');
});

test('countTotals 统计各状态', () => {
  const totals = countTotals([
    { status: 'PASSED' }, { status: 'PASSED' }, { status: 'FAILED' },
    { status: 'SKIPPED' }, { status: 'BLOCKED' }, { status: 'TIMEOUT' }, { status: 'ERROR' },
  ]);
  assert.equal(totals.passed, 2);
  assert.equal(totals.failed, 1);
  assert.equal(totals.skipped, 1);
  assert.equal(totals.blocked, 1);
  assert.equal(totals.timeout, 1);
  assert.equal(totals.error, 1);
  assert.equal(totals.total, 7);
});

function sampleReport(overallOverride = null) {
  const checks = [
    { name: 'typecheck', command: 'npm run typecheck', status: 'PASSED', exit_code: 0, signal: null, duration_ms: 100, stdout_log: null, stderr_log: null, summary: 'exit=0' },
    { name: 'test', command: 'npm run test', status: 'PASSED', exit_code: 0, signal: null, duration_ms: 200, stdout_log: null, stderr_log: null, summary: 'exit=0' },
  ];
  const overall = overallOverride || computeOverallStatus(checks, 'PASSED', { requested: false, status: 'SKIPPED' });
  return {
    runId: runId(),
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    finishedAt: new Date('2026-01-01T00:00:01.000Z'),
    agentVersion: '0.1.0',
    agentProvenance: {
      source: 'https://github.com/CAoyinggo/panqu-Test-agent',
      source_spec: 'embedded',
      source_commit_or_tag: 'abc123',
      provenance_status: 'DECLARED',
      provenance_detail: null,
    },
    workspaceInfo: {
      workspaceId: 'ws123', basename: 'demo', gitHead: 'abc123', branch: 'main', dirty: false,
      snapshotPath: '/tmp/panqu-snapshot-x/wt', excludedFiles: [], snapshotCleanup: { cleaned: [], errors: [] },
    },
    environment: { os: 'darwin arm64', node: 'v24.18.0', traecli_version: '0.201.6', trae_login_status: 'not_logged_in' },
    discovery: { ok: true, status: 'READY', manager: 'npm', hasLockfile: true },
    checks,
    analysis: { status: 'PASSED', reason: null, data: { architecture_summary: 'demo', changed_areas: [], risks: [], recommended_checks: [], execution_evidence: 'x', unverified_content: [] } },
    api: { requested: false, executed: false, origin: null, status: 'SKIPPED', reason: null, plan: null, cases: [] },
    limitations: ['lim1'],
    dryRun: false,
    artifacts: {},
    overallOverride,
  };
}

test('buildReport 生成契约字段；writeReport 产出 report.json/report.md/analysis.json', () => {
  const base = tmpDir('panqu-report-');
  const input = sampleReport();
  const report = buildReport(input);
  const written = writeReport({
    reportBaseDir: base,
    runId: report.run_id,
    report,
    checks: report.checks,
    analysis: report.analysis,
    logs: { checkStdout: { typecheck: 'stdout-typecheck' }, checkStderr: {}, analysisStdout: 'stdout-analysis', analysisStderr: '' },
  });

  const dir = written.reportDir;
  assert.equal(existsSync(`${dir}/report.json`), true);
  assert.equal(existsSync(`${dir}/report.md`), true);
  assert.equal(existsSync(`${dir}/analysis.json`), true);
  assert.equal(existsSync(`${dir}/logs/check-typecheck.stdout.log`), true);
  assert.equal(existsSync(`${dir}/logs/analysis.stdout.log`), true);

  const json = JSON.parse(readFileSync(`${dir}/report.json`, 'utf8'));
  assert.equal(json.schema_version, REPORT_SCHEMA_VERSION);
  assert.equal(json.agent.model_runtime, 'traecli');
  assert.ok(json.artifacts.report_json.endsWith('report.json'));
  assert.equal(json.overall_status, 'PASSED');
  assert.equal(json.checks.length, 2);
  assert.ok(json.totals.passed >= 2);

  // analysis.json 是 analysis 段的可读落盘
  const analysis = JSON.parse(readFileSync(`${dir}/analysis.json`, 'utf8'));
  assert.equal(analysis.status, 'PASSED');
  assert.equal(analysis.architecture_summary, 'demo');

  // 日志文件内容脱敏落盘
  assert.equal(readFileSync(`${dir}/logs/check-typecheck.stdout.log`, 'utf8'), 'stdout-typecheck');
});

test('Markdown 报告与 JSON 一致：状态与数字一致，不产生两套事实', () => {
  const base = tmpDir('panqu-report-');
  const input = sampleReport('FAILED');
  const report = buildReport(input);
  const written = writeReport({
    reportBaseDir: base,
    runId: report.run_id,
    report,
    checks: report.checks,
    analysis: report.analysis,
    logs: { checkStdout: {}, checkStderr: {}, analysisStdout: '', analysisStderr: '' },
  });
  const md = readFileSync(`${written.reportDir}/report.md`, 'utf8');
  const json = JSON.parse(readFileSync(`${written.reportDir}/report.json`, 'utf8'));

  assert.ok(md.includes(`**${json.overall_status}**`), 'markdown 应反映 overall_status');
  for (const c of json.checks) {
    assert.ok(md.includes(c.name), `markdown 应包含 check ${c.name}`);
    assert.ok(md.includes(`**${c.status}**`), `markdown 应包含 ${c.name} 的状态 ${c.status}`);
  }
  assert.ok(md.includes(`passed=${json.totals.passed}`), 'markdown totals 应与 JSON 一致');
  assert.ok(md.includes(json.agent.source));
});
