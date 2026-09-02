/**
 * P0-3 清理路径：检查失败 / 超时 / Abort / 依赖复制失败后，snapshot 与 staging 必须清理干净。
 * 每项断言临时路径实际不存在；tmpdir 无 panqu-snapshot- 残留。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { run, tmpDir, makeGitRepo, write, PACKAGE_ROOT } from './helpers.mjs';
import { makeFakeTraecliRoot } from './helpers-p0.mjs';
import { materializeDependencyCopy, cleanupDependencyCopy, stagingDirName } from '../src/dependency-copy.mjs';

const CLI_BIN = join(PACKAGE_ROOT, 'bin', 'panqu-test-agent.mjs');

/** 运行 validate（fake traecli 加速分析），返回 { res, runDir }。 */
function execValidate(workspace, extraArgs = []) {
  const fake = makeFakeTraecliRoot();
  const reportDir = tmpDir('panqu-p0-cleanup-reports-');
  try {
    const res = run('node', [CLI_BIN, 'validate', '--workspace', workspace, '--report-dir', reportDir, '--timeout-ms', '3000', ...extraArgs], {
      timeout: 180000,
      env: fake.env(),
    });
    const entries = readdirSync(reportDir);
    const runDir = entries.length > 0 ? join(reportDir, entries[0]) : null;
    return { res, runDir };
  } finally {
    fake.cleanup();
  }
}

test('P0: 检查失败后 snapshot/staging 清理，tmpdir 无快照残留', () => {
  const ws = makeGitRepo({
    'package.json': '{"name":"f","version":"1.0.0","scripts":{"typecheck":"node -e \\"process.exit(0)\\"","lint":"node -e \\"process.exit(0)\\"","test":"node -e \\"process.exit(7)\\"","build":"node -e \\"process.exit(0)\\""}}',
    '.gitignore': 'node_modules/\n',
    'index.js': 'module.exports = 1;\n',
  });
  const { res, runDir } = execValidate(ws, ['--checks', 'typecheck,lint,test,build']);
  assert.equal(res.code, 1, `失败 fixture 应 exit 1：${res.stdout.slice(-600)}`);

  const json = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
  assert.equal(json.overall_status, 'FAILED');
  // 并发安全断言：本次运行的快照（worktree 与其所在的快照根）必须实际不存在
  const snapshotPath = json.workspace.snapshot_path;
  assert.ok(snapshotPath, '报告应记录 snapshot_path');
  assert.equal(existsSync(snapshotPath), false, 'snapshot worktree 路径必须已清理');
  assert.equal(existsSync(dirname(snapshotPath)), false, '快照根目录必须已清理（staging 随之移除）');
  assert.ok(json.workspace.snapshot_cleanup.cleaned.length > 0, '快照清理应有记录');
});

test('P0: 检查超时后 snapshot/staging 清理，tmpdir 无快照残留', () => {
  const ws = makeGitRepo({
    'package.json': '{"name":"f","version":"1.0.0","scripts":{"typecheck":"node -e \\"process.exit(0)\\"","lint":"node -e \\"process.exit(0)\\"","test":"node -e \\"setTimeout(function(){},60000)\\"","build":"node -e \\"process.exit(0)\\""}}',
    '.gitignore': 'node_modules/\n',
    'index.js': 'module.exports = 1;\n',
  });
  const { res, runDir } = execValidate(ws, ['--checks', 'typecheck,lint,test,build']);
  assert.equal(res.code, 2, `超时 fixture 应 exit 2(ERROR)：${res.stdout.slice(-600)}`);

  const json = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
  const testCheck = json.checks.find((c) => c.name === 'test');
  assert.equal(testCheck.status, 'TIMEOUT', `test 应 TIMEOUT：${testCheck.summary}`);
  // 并发安全断言：本次运行的快照（worktree 与其所在的快照根）必须实际不存在
  const snapshotPath = json.workspace.snapshot_path;
  assert.ok(snapshotPath, '报告应记录 snapshot_path');
  assert.equal(existsSync(snapshotPath), false, 'snapshot worktree 路径必须已清理');
  assert.equal(existsSync(dirname(snapshotPath)), false, '快照根目录必须已清理（staging 随之移除）');
});

test('P0: Abort 后 staging 清理（materialize 层确定性验证）', () => {
  const ws = tmpDir('panqu-p0-abort-ws-');
  mkdirSync(join(ws, 'node_modules', 'a'), { recursive: true });
  write(join(ws, 'node_modules', 'a', 'index.js'), '1');

  const snapshotRoot = mkdtempSync(join(tmpdir(), 'panqu-snapshot-'));
  const staging = join(snapshotRoot, stagingDirName());
  mkdirSync(staging, { recursive: true });

  const controller = new AbortController();
  controller.abort();
  const res = materializeDependencyCopy({
    srcNodeModules: join(ws, 'node_modules'),
    stagingDir: staging,
    workspaceRoot: ws,
    signal: controller.signal,
  });
  assert.equal(res.ok, false, 'aborted materialize 应失败');
  assert.equal(res.code, 'DEPENDENCY_ABORTED');

  const cleaned = cleanupDependencyCopy(staging);
  assert.equal(cleaned.ok, true);
  assert.equal(existsSync(staging), false, 'Abort 后 staging 必须实际不存在');
  rmSync(snapshotRoot, { recursive: true, force: true });
});

test('P0: 依赖复制失败后 staging 清理（源目录读取失败 EACCES）', () => {
  // root 用户不受权限限制，无法用 chmod 注入 EACCES（不虚构覆盖）
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;

  const ws = tmpDir('panqu-p0-copyfail-ws-');
  mkdirSync(join(ws, 'node_modules', 'a'), { recursive: true });
  mkdirSync(join(ws, 'node_modules', 'b'), { recursive: true });
  write(join(ws, 'node_modules', 'a', 'index.js'), '1');
  write(join(ws, 'node_modules', 'b', 'index.js'), '2');

  const snapshotRoot = mkdtempSync(join(tmpdir(), 'panqu-snapshot-'));
  const staging = join(snapshotRoot, stagingDirName());
  mkdirSync(staging, { recursive: true });

  // b 目录不可读 → walk 中 readdirSync(b) EACCES → 结构化复制失败
  chmodSync(join(ws, 'node_modules', 'b'), 0o000);
  let res;
  try {
    res = materializeDependencyCopy({
      srcNodeModules: join(ws, 'node_modules'),
      stagingDir: staging,
      workspaceRoot: ws,
    });
  } finally {
    chmodSync(join(ws, 'node_modules', 'b'), 0o755);
  }
  assert.equal(res.ok, false, `复制失败应返回错误：${JSON.stringify(res)}`);
  assert.equal(res.code, 'DEPENDENCY_COPY_FAILED', `错误码应结构化：${JSON.stringify(res)}`);

  const cleaned = cleanupDependencyCopy(staging);
  assert.equal(cleaned.ok, true);
  assert.equal(existsSync(staging), false, '复制失败后 staging 必须实际不存在');
  assert.equal(readFileSync(join(ws, 'node_modules', 'a', 'index.js'), 'utf8'), '1', '原依赖不得被复制失败影响');
  rmSync(snapshotRoot, { recursive: true, force: true });
});