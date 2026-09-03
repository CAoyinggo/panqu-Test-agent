/**
 * P0 回归测试：workspace 快照的 git apply stdin/超时/清理语义。
 *
 * 背景（真实故障，V12 Terminal.app 事故）：
 *   修复前 createSnapshot 用 spawnSync('git', ['apply', ...], { input }) 应用 dirty diff，
 *   无超时、无 kill 路径。真实事故中该调用在 TTY 环境下永久等待 stdin（父进程持有
 *   子进程 stdin 写端且永不写入/关闭），CLI 挂死 27+ 分钟且无任何清理。
 *
 * 本文件覆盖 §九 场景：
 *   1. 父进程 stdin 保持打开（pipe 永不 EOF），dirty 快照仍能完成；
 *   2. binary diff 真实应用（内容哈希一致）；
 *   3. 被删除的 tracked 文件在快照中保持删除；
 *   4. 空 diff 不启动 git apply；
 *   5. git apply 失败 → fail closed + 快照/worktree 完整清理；
 *   6. git apply 永不结束 → 有界超时终止 + WORKSPACE_PATCH_TIMEOUT + 完整清理；
 *   7. 普通 stdin EOF（/dev/null 等价）下正常工作。
 *
 * 约束：不调用真实 Trae CLI / 网络 / 外部 LLM；git apply 停滞用 PATH 注入的 git shim 模拟。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url)); // .../tests/
const SNAPSHOT_MODULE = resolve(TEST_DIR, '../src/workspace-snapshot.mjs');
const REAL_GIT = '/usr/bin/git';

import { createSnapshot, cleanupSnapshot, isManagedSnapshotRoot } from '../src/workspace-snapshot.mjs';
import { makeGitRepo, write, tmpDir } from './helpers.mjs';

/** 创建含全部 dirty 形态的 fixture：文本修改 + 二进制修改 + tracked 删除 + untracked。 */
function makeDirtyRepo() {
  const ws = makeGitRepo({
    'package.json': '{"name":"x","version":"1.0.0"}\n',
    'src/a.js': 'module.exports = 1;\n',
  });
  writeFileSync(join(ws, 'logo.bin'), Buffer.alloc(1024, 1));
  execFileSync(REAL_GIT, ['-C', ws, 'add', '-A']);
  execFileSync(REAL_GIT, ['-C', ws, 'commit', '-qm', 'add-binary']);
  // dirty：文本修改
  write(`${ws}/src/a.js`, 'module.exports = 2;\n');
  // dirty：二进制修改
  writeFileSync(join(ws, 'logo.bin'), Buffer.alloc(4096, 7));
  // dirty：tracked 文件删除
  rmSync(join(ws, 'package.json'));
  // untracked
  write(`${ws}/src/b.js`, 'module.exports = 3;\n');
  return ws;
}

/** 写一个 PATH shim git：仅拦截 apply，其余子命令透传真实 git。 */
function makeGitShim(applyBehavior) {
  const dir = mkdtempSync(join(tmpdir(), 'panqu-git-shim-'));
  const script = [
    '#!/bin/bash',
    'if [ "$1" = "apply" ]; then',
    applyBehavior,
    'fi',
    `exec ${REAL_GIT} "$@"`,
    '',
  ].join('\n');
  const shim = join(dir, 'git');
  writeFileSync(shim, script);
  chmodSync(shim, 0o755);
  return dir;
}

/** 在子进程中运行真实 createSnapshot（隔离 CLI 路径），返回 { exit, stdout, stderr }。 */
function runSnapshotInSubprocess(workspacePath, { stdinMode = 'pipe', timeoutMs = 20000, extraPath = null } = {}) {
  const childScript = `
    import { createSnapshot, cleanupSnapshot } from ${JSON.stringify(SNAPSHOT_MODULE)};
    const ws = process.argv[2];
    const snap = createSnapshot(ws, process.argv[3] ? JSON.parse(process.argv[3]) : {});
    if (!snap.ok) { console.error('SNAPSHOT_FAILED:' + snap.reason); process.exit(3); }
    const out = { worktree: snap.worktree, excluded: snap.excluded.length };
    console.log('SNAPSHOT_META:' + JSON.stringify(out));
    cleanupSnapshot(snap);
    console.log('SNAPSHOT_CLEANED');
  `;
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    if (extraPath) env.PATH = `${extraPath}:${env.PATH}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, '-', workspacePath], {
      stdio: [stdinMode === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (stdinMode === 'pipe-open') {
      // 故意保持写端打开：不 write、不 end（模拟 V12 TTY/父 stdin 不关闭条件）
    } else if (stdinMode === 'pipe') {
      child.stdin.end();
    }
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout: out, stderr: err }));
    child.on('error', (e) => resolvePromise({ code: -1, signal: null, stdout: out, stderr: String(e) }));
  });
}

function assertSnapshotCleaned(ws) {
  // worktree 注册不残留：porcelain 输出只允许主工作区自身 1 个条目
  const prune = execFileSync(REAL_GIT, ['-C', ws, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const entries = prune.split('\n').filter((l) => l.startsWith('worktree '));
  assert.equal(entries.length, 1, `worktree 注册应无残留（实际 ${entries.length} 个）`);
}

// ---------- 1. 父进程 stdin 保持打开（V12 条件） ----------
test('父 stdin pipe 永不 EOF：dirty diff 仍完整应用，子进程有界退出', async () => {
  const ws = makeDirtyRepo();
  const before = createHash('sha256').update(readFileSync(join(ws, 'src/a.js'))).digest('hex');
  const r = await runSnapshotInSubprocess(ws, { stdinMode: 'pipe-open', timeoutMs: 20000 });
  assert.equal(r.code, 0, `子进程应成功退出，实际 code=${r.code} stderr=${r.stderr.slice(0, 300)}`);
  assert.ok(r.stdout.includes('SNAPSHOT_CLEANED'), '快照应完成并清理');
  assert.equal(createHash('sha256').update(readFileSync(join(ws, 'src/a.js'))).digest('hex'), before, '原工作区不变');
  assertSnapshotCleaned(ws);
});

// ---------- 2. binary diff ----------
test('binary diff：二进制修改真实应用，内容哈希一致', async () => {
  const ws = makeDirtyRepo();
  const snap = createSnapshot(ws);
  assert.equal(snap.ok, true, snap.ok ? '' : snap.reason);
  const wt = snap.worktree;
  const wsHash = createHash('sha256').update(readFileSync(join(ws, 'logo.bin'))).digest('hex');
  const wtHash = createHash('sha256').update(readFileSync(join(wt, 'logo.bin'))).digest('hex');
  assert.equal(wtHash, wsHash, '二进制修改应真实应用（哈希一致）');
  cleanupSnapshot(snap);
});

// ---------- 3. 删除文件 ----------
test('被删除的 tracked 文件在快照中保持删除', () => {
  const ws = makeDirtyRepo();
  const snap = createSnapshot(ws);
  assert.equal(snap.ok, true);
  assert.equal(existsSync(join(snap.worktree, 'package.json')), false, '删除应保持删除');
  cleanupSnapshot(snap);
});

// ---------- 4. 空 diff：不启动 git apply ----------
test('干净工作区（空 diff）：不调用 git apply，快照成功', () => {
  const ws = makeGitRepo({ 'package.json': '{"name":"x"}' });
  const shimDir = makeGitShim('  echo "apply must not be called" >&2; exit 99;');
  const origPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${origPath}`;
  let snap = null;
  try {
    snap = createSnapshot(ws);
    assert.equal(snap.ok, true, snap.ok ? '' : snap.reason);
  } finally {
    process.env.PATH = origPath;
    if (snap && snap.ok) cleanupSnapshot(snap);
    rmSync(shimDir, { recursive: true, force: true });
  }
});

// ---------- 5. git apply 失败：fail closed + 完整清理 ----------
test('git apply 非零退出：BLOCKED 且返回 stderr，worktree/快照无残留', () => {
  const ws = makeDirtyRepo();
  const shimDir = makeGitShim('  echo "simulated patch failure" >&2; exit 1;');
  const origPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${origPath}`;
  let result = null;
  try {
    result = createSnapshot(ws);
  } finally {
    process.env.PATH = origPath;
    rmSync(shimDir, { recursive: true, force: true });
  }
  assert.equal(result.ok, false, 'apply 失败必须 fail closed');
  assert.match(result.reason, /simulated patch failure/, '失败原因应包含子进程 stderr');
  assertSnapshotCleaned(ws);
  // 失败路径不得遗留受管快照目录
  assert.equal(isManagedSnapshotRoot(result.snapshotRoot || ''), false, '失败结果不应携带快照根');
});

// ---------- 6. git apply 永不结束：有界超时 + 清理 ----------
test('git apply 永久等待（模拟 V12 挂起）：内部超时终止并返回 WORKSPACE_PATCH_TIMEOUT', () => {
  const ws = makeDirtyRepo();
  // shim：apply 时 sleep 300（不读 stdin、永不退出）— 复现 V12 子进程停滞
  const shimDir = makeGitShim('  exec sleep 300;');
  const origPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${origPath}`;
  let result = null;
  const t0 = Date.now();
  try {
    result = createSnapshot(ws, { gitApplyTimeoutMs: 2000 });
  } finally {
    process.env.PATH = origPath;
    rmSync(shimDir, { recursive: true, force: true });
  }
  const elapsed = Date.now() - t0;
  assert.equal(result.ok, false, '停滞的 apply 必须失败而非永久等待');
  assert.match(result.reason, /WORKSPACE_PATCH_TIMEOUT/, `应返回超时错误，实际: ${result.reason}`);
  assert.ok(elapsed < 15000, `必须在有界时间内返回（实际 ${elapsed}ms）`);
  // 残留的 sleep 子进程应已被终止
  const ps = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' });
  assert.equal(/sleep 300/.test(ps), false, '超时后不得残留 apply 子进程');
  assertSnapshotCleaned(ws);
});

// ---------- 7. 普通 stdin EOF（/dev/null 等价） ----------
test('子进程 stdin 立即 EOF（/dev/null 等价）：快照正常完成', async () => {
  const ws = makeDirtyRepo();
  const r = await runSnapshotInSubprocess(ws, { stdinMode: 'ignore', timeoutMs: 20000 });
  assert.equal(r.code, 0, `应成功退出，实际 code=${r.code} stderr=${r.stderr.slice(0, 300)}`);
  assert.ok(r.stdout.includes('SNAPSHOT_CLEANED'));
  assertSnapshotCleaned(ws);
});
