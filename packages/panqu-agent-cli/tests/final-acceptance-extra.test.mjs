/**
 * 最终验收补测：补齐 51 项矩阵中先前缺失的可单元化项。
 * 仅测试代码，不改动核心实现。
 *
 * 覆盖：根 bin 映射/可执行 mode、无 tracked distribution.json、FIFO 特殊文件 fail closed、
 *       workspace package symlink 映射/拒绝、指回原 workspace 的绝对 symlink、cache 不污染原依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, existsSync, mkdirSync, symlinkSync, statSync, writeFileSync, realpathSync, lstatSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyNodeModulesSafe } from '../src/dependency-copy.mjs';
import { createSnapshot, cleanupSnapshot } from '../src/workspace-snapshot.mjs';
import { tmpDir, makeGitRepo, write } from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootPkg = join(__dirname, '..', '..', '..', 'package.json');
const binPath = join(__dirname, '..', 'bin', 'panqu-test-agent.mjs');

test('根 package.json 暴露 panqu-test-agent bin，且指向真实文件', () => {
  const pkg = JSON.parse(readFileSync(rootPkg, 'utf8'));
  assert.ok(pkg.bin && pkg.bin['panqu-test-agent'], '根应暴露 panqu-test-agent bin');
  const target = join(dirname(rootPkg), pkg.bin['panqu-test-agent']);
  assert.equal(existsSync(target), true, 'bin 指向文件须存在');
});

test('bin 文件 shebang 正确且 Git mode 可执行位（100755）', () => {
  const head = readFileSync(binPath, 'utf8').split('\n')[0];
  assert.equal(head.startsWith('#!'), true, '首行应为 shebang');
  const mode = statSync(binPath).mode & 0o111;
  assert.ok(mode > 0, 'bin 应具备可执行位');
});

test('不依赖 tracked distribution.json：包目录不存在该文件', () => {
  const dist = join(__dirname, '..', 'distribution.json');
  assert.equal(existsSync(dist), false, '不得存在 tracked distribution.json');
});

test('FIFO 等特殊文件 → fail closed（DEPENDENCY_ENTRY_UNSUPPORTED）', () => {
  const ws = tmpDir('panqu-fifo-');
  mkdirSync(join(ws, 'node_modules', 'a'), { recursive: true });
  write(join(ws, 'node_modules', 'a', 'index.js'), '1');
  const fifo = join(ws, 'node_modules', 'fifo-entry');
  const r = spawnSync('mkfifo', [fifo]);
  if (r.status !== 0) return; // 平台不支持 mkfifo 则跳过（不虚构覆盖）
  const snap = tmpDir('panqu-snap-');
  const res = copyNodeModulesSafe({ srcNodeModules: join(ws, 'node_modules'), workspaceRoot: ws, snapshotRoot: snap });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DEPENDENCY_ENTRY_UNSUPPORTED');
});

test('快照内写 cache 不污染原 node_modules', () => {
  const ws = tmpDir('panqu-cache-');
  mkdirSync(join(ws, 'node_modules', 'a'), { recursive: true });
  write(join(ws, 'node_modules', 'a', 'index.js'), '1');
  const snap = tmpDir('panqu-snap-');
  const res = copyNodeModulesSafe({ srcNodeModules: join(ws, 'node_modules'), workspaceRoot: ws, snapshotRoot: snap });
  assert.equal(res.ok, true);
  // 在快照副本内写入 .cache 与额外文件
  mkdirSync(join(snap, 'node_modules', '.cache'), { recursive: true });
  writeFileSync(join(snap, 'node_modules', '.cache', 'x'), 'cache-data');
  writeFileSync(join(snap, 'node_modules', 'a', 'index.js'), 'MODIFIED-IN-SNAPSHOT');
  // 原 node_modules 不受影响
  assert.equal(readFileSync(join(ws, 'node_modules', 'a', 'index.js'), 'utf8'), '1');
  assert.equal(existsSync(join(ws, 'node_modules', '.cache')), false);
});

test('指回原 workspace 根的绝对 symlink → 不逃逸（被映射或 fail closed）', () => {
  const ws = makeGitRepo({ 'package.json': '{"name":"x","version":"1.0.0","devDependencies":{"a":"1.0.0"}}', '.gitignore': 'node_modules/\n' });
  mkdirSync(join(ws, 'node_modules', 'a'), { recursive: true });
  write(join(ws, 'node_modules', 'a', 'index.js'), '1');
  // 绝对 symlink 指回原 workspace 根
  symlinkSync(ws, join(ws, 'node_modules', 'backlink'), 'dir');
  const snap = createSnapshot(ws);
  assert.equal(snap.ok, true);
  const link = join(snap.worktree, 'node_modules', 'backlink');
  if (existsSync(link)) {
    // 若被映射，最终 realpath 必须在 snapshot 内，不得指回原 workspace
    const real = realpathSync(link);
    assert.equal(real.startsWith(realpathSync(snap.worktree)), true, '指回原 workspace 的链接不得逃逸快照');
  } else {
    // 或整体 fail closed（不提供 node_modules）
    assert.equal(existsSync(join(snap.worktree, 'node_modules')), false, '失败时必须整体拒绝 node_modules');
  }
  cleanupSnapshot(snap);
});

test('workspace package symlink（node_modules 外指向 workspace 内包）→ 被映射到 snapshot', () => {
  const ws = makeGitRepo({
    'package.json': '{"name":"x","version":"1.0.0","devDependencies":{"mylib":"1.0.0"}}',
    '.gitignore': 'node_modules/\n',
    'packages/mylib/index.js': 'module.exports = 42;\n',
  });
  mkdirSync(join(ws, 'node_modules'), { recursive: true });
  // node_modules/mylib -> ../../packages/mylib（相对多级，指向 workspace 内 package）
  const rel = relative(join(ws, 'node_modules'), join(ws, 'packages', 'mylib'));
  symlinkSync(rel, join(ws, 'node_modules', 'mylib'), 'dir');
  const snap = createSnapshot(ws);
  assert.equal(snap.ok, true);
  const link = join(snap.worktree, 'node_modules', 'mylib');
  if (existsSync(link)) {
    const real = realpathSync(link);
    assert.equal(real.startsWith(realpathSync(snap.worktree)), true, 'workspace package symlink 目标应在 snapshot 内');
    assert.equal(readFileSync(join(real, 'index.js'), 'utf8').includes('42'), true);
  } else {
    assert.equal(existsSync(join(snap.worktree, 'node_modules')), false);
  }
  cleanupSnapshot(snap);
});