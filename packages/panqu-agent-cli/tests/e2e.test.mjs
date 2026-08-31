/**
 * 测试 23：从本地 tgz 用 `npm exec` 做端到端验证。
 *
 * 覆盖：
 *  - 成功 fixture（--dry-run 与真实执行）；
 *  - 失败 fixture → overall=FAILED、非零退出、报告仍完整；
 *  - 报告文件齐全（report.json/report.md/analysis.json/logs）；
 *  - 原 fixture 目录 hash 前后不变。
 *
 * 说明：真实 Trae 模型分析依赖登录状态；未登录时分析为 BLOCKED，整体为 BLOCKED。
 * 本测试断言随登录状态自适应，保证在任何环境下都只反映真实结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run, tmpDir, makeGitRepo, hashTree, PACKAGE_ROOT, write } from './helpers.mjs';
import { fixturePassFiles, fixtureFailFiles, fixtureNoGitFiles } from './fixtures.mjs';
import { findTraecli, traecliLoginStatus } from '../src/preflight.mjs';

function packTgz() {
  const dest = tmpDir('panqu-pack-');
  const res = run('npm', ['pack', '--json', '--pack-destination', dest], { cwd: PACKAGE_ROOT });
  assert.equal(res.ok, true, `npm pack 失败: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  return join(dest, parsed[0].filename);
}

function execValidate(tgz, ws, extraArgs = []) {
  const reportDir = tmpDir('panqu-e2e-report-');
  const args = [
    'exec', '--yes',
    `--package=${tgz}`,
    '--',
    'panqu-test-agent', 'validate',
    '--workspace', ws,
    '--checks', 'typecheck,lint,test,build',
    '--report-dir', reportDir,
    ...extraArgs,
  ];
  const res = run('npm', args, { cwd: PACKAGE_ROOT, timeout: 120000 });
  return { res, reportDir };
}

function findReportDir(reportDir) {
  const entries = readdirSync(reportDir);
  return join(reportDir, entries[0]);
}

test('端到端（成功 fixture，--dry-run）：SKIPPED 退出码 4，报告完整', () => {
  const ws = makeGitRepo(fixturePassFiles);
  const tgz = packTgz();
  const before = hashTree(ws);
  const { res, reportDir } = execValidate(tgz, ws, ['--dry-run']);
  assert.equal(res.code, 4, `dry-run 应退出 4，实际 ${res.code}\n${res.stdout}\n${res.stderr}`);

  const dir = findReportDir(reportDir);
  const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(json.overall_status, 'SKIPPED');
  assert.equal(json.dry_run, true);
  assert.equal(json.checks.length, 4);
  for (const c of json.checks) assert.equal(c.status, 'SKIPPED');
  assert.equal(existsSync(join(dir, 'report.md')), true);
  assert.equal(existsSync(join(dir, 'analysis.json')), true);
  assert.deepEqual(hashTree(ws), before, '原 fixture 不得被修改');
});

test('端到端（成功 fixture，真实执行）：确定性检查真实运行，整体状态与登录态一致', async () => {
  const ws = makeGitRepo(fixturePassFiles);
  const tgz = packTgz();
  const before = hashTree(ws);
  const { res, reportDir } = execValidate(tgz, ws);

  const dir = findReportDir(reportDir);
  assert.equal(existsSync(join(dir, 'report.json')), true, '报告必须生成');
  const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));

  // 确定性检查真实运行（非 dry-run）
  assert.equal(json.checks.length, 4);
  const statuses = new Set(json.checks.map((c) => c.status));
  assert.ok(statuses.has('PASSED'), '成功 fixture 的检查应有 PASSED');
  assert.ok(!statuses.has('FAILED'), '成功 fixture 的检查不应 FAILED');
  assert.equal(json.totals.failed, 0);
  assert.equal(existsSync(join(dir, 'report.md')), true);
  assert.equal(existsSync(join(dir, 'analysis.json')), true);

  // 登录态自适应断言：未登录 → BLOCKED；已登录 → 允许 PASSED/BLOCKED/ERROR
  const traecliPath = await findTraecli();
  const login = traecliPath ? await traecliLoginStatus(traecliPath) : { status: 'unknown' };
  if (login.status !== 'logged_in') {
    assert.equal(json.analysis.status, 'BLOCKED', '未登录时分析必须 BLOCKED');
    assert.equal(json.overall_status, 'BLOCKED', '未登录时整体必须 BLOCKED（必要项被阻塞）');
    assert.equal(res.code, 3, '未登录时退出码应为 3（BLOCKED）');
  } else {
    assert.ok(['PASSED', 'BLOCKED', 'ERROR'].includes(json.overall_status));
  }
  assert.deepEqual(hashTree(ws), before, '原 fixture 不得被修改');
});

test('端到端（失败 fixture）：overall=FAILED、非零退出、报告仍完整、不输出全部通过', () => {
  const ws = makeGitRepo(fixtureFailFiles);
  const tgz = packTgz();
  const before = hashTree(ws);
  const { res, reportDir } = execValidate(tgz, ws, ['--dry-run']);
  // dry-run 不执行检查；改为真实执行以观察 FAILED
  const { res: realRes, reportDir: realDir } = execValidate(tgz, ws);
  assert.equal(realRes.code, 1, `失败 fixture 应退出 1，实际 ${realRes.code}\n${realRes.stdout}\n${realRes.stderr}`);

  const dir = findReportDir(realDir);
  const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(json.overall_status, 'FAILED');
  assert.ok(json.totals.failed >= 1);
  const failed = json.checks.find((c) => c.status === 'FAILED');
  assert.ok(failed, '应存在 FAILED 检查');
  assert.equal(existsSync(join(dir, 'report.md')), true, '失败时报告仍必须完整生成');
  assert.equal(existsSync(join(dir, 'analysis.json')), true);
  assert.ok(!realRes.stdout.includes('全部通过'), '不得输出“全部通过”');
  assert.deepEqual(hashTree(ws), before, '原 fixture 不得被修改');
  assert.equal(res.code, 4, 'dry-run 失败 fixture 仍为 SKIPPED(4)');
});

test('端到端（非 Git fixture）：fail closed BLOCKED', () => {
  const dir = tmpDir('panqu-nongit-');
  for (const [rel, content] of Object.entries(fixtureNoGitFiles)) {
    write(join(dir, rel), content);
  }
  const tgz = packTgz();
  const { res, reportDir } = execValidate(tgz, dir, ['--dry-run']);
  // 非 Git 在 preflight 即 BLOCKED
  assert.ok([3, 4].includes(res.code), `非 Git 应 fail closed，实际 ${res.code}`);
  const json = JSON.parse(readFileSync(join(findReportDir(reportDir), 'report.json'), 'utf8'));
  assert.equal(json.overall_status, 'BLOCKED');
});
