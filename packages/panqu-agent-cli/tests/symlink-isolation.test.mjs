/**
 * 回归测试：依赖复制与内部 symlink 安全隔离（逃逸/合法映射/特殊类型）。
 * 覆盖：合法内部 symlink 映射、绝对/相对多级逃逸、broken、loop、顶层 symlink 拒绝、
 *       createSnapshot 集成（逃逸时命令调用=0 语义）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, lstatSync, realpathSync, existsSync, readFileSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { copyNodeModulesSafe } from '../src/dependency-copy.mjs';
import { createSnapshot, cleanupSnapshot } from '../src/workspace-snapshot.mjs';
import { tmpDir, makeGitRepo, write } from './helpers.mjs';

function setupLegalNodeModules(ws) {
  mkdirSync(join(ws, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(ws, 'node_modules', 'typescript', 'bin'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'typescript', 'bin', 'tsc'), '#!/usr/bin/env node\nconsole.log(1);\n');
  // 合法 .bin 相对链接
  symlinkSync('../typescript/bin/tsc', join(ws, 'node_modules', '.bin', 'tsc'), 'file');
}

test('合法 .bin 相对 symlink 被安全映射到 snapshot 内', () => {
  const ws = tmpDir('panqu-copy-');
  setupLegalNodeModules(ws);
  const snap = tmpDir('panqu-snap-');
  const res = copyNodeModulesSafe({ srcNodeModules: join(ws, 'node_modules'), workspaceRoot: ws, snapshotRoot: snap });
  assert.equal(res.ok, true, JSON.stringify(res));
  const link = join(snap, 'node_modules', '.bin', 'tsc');
  assert.equal(lstatSync(link).isSymbolicLink(), true, '.bin/tsc 应是 symlink');
  assert.equal(realpathSync(link).startsWith(realpathSync(snap)), true, '最终 realpath 必须位于 snapshot 内');
  assert.equal(readFileSync(realpathSync(link), 'utf8').includes('console.log'), true);
  // 普通文件 inode 不同（非 hardlink）
  const srcIno = statSync(join(ws, 'node_modules', 'typescript', 'bin', 'tsc')).ino;
  const dstIno = statSync(join(snap, 'node_modules', 'typescript', 'bin', 'tsc')).ino;
  assert.notEqual(srcIno, dstIno, '普通依赖文件 inode 必须不同');
});

test('绝对逃逸 symlink → fail closed（不落盘任何 node_modules）', () => {
  const ws = tmpDir('panqu-copy-');
  const external = tmpDir('panqu-ext-');
  mkdirSync(join(ws, 'node_modules', 'a'), { recursive: true });
  write(join(ws, 'node_modules', 'a', 'index.js'), '1');
  symlinkSync(external, join(ws, 'node_modules', 'evil'), 'dir');
  const snap = tmpDir('panqu-snap-');
  const res = copyNodeModulesSafe({ srcNodeModules: join(ws, 'node_modules'), workspaceRoot: ws, snapshotRoot: snap });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DEPENDENCY_SYMLINK_UNSAFE');
  assert.equal(existsSync(join(snap, 'node_modules')), false, '逃逸时不得部分落盘 node_modules');
});

test('相对多级逃逸 symlink → fail closed', () => {
  const parent = tmpdir();
  const ws = mkdtempSync(join(parent, 'panqu-ws-'));
  const external = mkdtempSync(join(parent, 'panqu-extrel-'));
  mkdirSync(join(ws, 'node_modules', 'a'), { recursive: true });
  write(join(ws, 'node_modules', 'a', 'index.js'), '1');
  // 相对链接指向 workspace 之外的真实兄弟目录
  const rel = relative(join(ws, 'node_modules'), external);
  symlinkSync(rel, join(ws, 'node_modules', 'rel-escape'), 'dir');
  const snap = tmpDir('panqu-snap-');
  const res = copyNodeModulesSafe({ srcNodeModules: join(ws, 'node_modules'), workspaceRoot: ws, snapshotRoot: snap });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DEPENDENCY_SYMLINK_UNSAFE');
});

test('broken link → fail closed', () => {
  const ws = tmpDir('panqu-copy-');
  mkdirSync(join(ws, 'node_modules', 'a'), { recursive: true });
  write(join(ws, 'node_modules', 'a', 'index.js'), '1');
  symlinkSync('/nonexistent-zzz-target', join(ws, 'node_modules', 'broken'), 'dir');
  const snap = tmpDir('panqu-snap-');
  const res = copyNodeModulesSafe({ srcNodeModules: join(ws, 'node_modules'), workspaceRoot: ws, snapshotRoot: snap });
  assert.equal(res.ok, false);
  assert.equal(['DEPENDENCY_SYMLINK_BROKEN', 'DEPENDENCY_SYMLINK_UNSAFE'].includes(res.code), true, res.code);
});

test('symlink loop → fail closed', () => {
  const ws = tmpDir('panqu-copy-');
  mkdirSync(join(ws, 'node_modules'), { recursive: true });
  symlinkSync(join(ws, 'node_modules', 'loop-b'), join(ws, 'node_modules', 'loop-a'), 'dir');
  symlinkSync(join(ws, 'node_modules', 'loop-a'), join(ws, 'node_modules', 'loop-b'), 'dir');
  const snap = tmpDir('panqu-snap-');
  const res = copyNodeModulesSafe({ srcNodeModules: join(ws, 'node_modules'), workspaceRoot: ws, snapshotRoot: snap });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DEPENDENCY_SYMLINK_LOOP');
});

test('createSnapshot：逃逸 symlink 时不提供 node_modules（命令调用=0 语义）', () => {
  const ws = makeGitRepo({
    'package.json': '{"name":"x","version":"1.0.0","devDependencies":{"a":"1.0.0"}}',
    '.gitignore': 'node_modules/\n',
  });
  const external = tmpDir('panqu-ext2-');
  mkdirSync(join(external, 's'), { recursive: true });
  mkdirSync(join(ws, 'node_modules', 'a'), { recursive: true });
  write(join(ws, 'node_modules', 'a', 'index.js'), '1');
  symlinkSync(external, join(ws, 'node_modules', 'evil'), 'dir');

  const snap = createSnapshot(ws);
  assert.equal(snap.ok, true);
  assert.equal(existsSync(join(snap.worktree, 'node_modules')), false, '逃逸时快照不得有 node_modules');
  cleanupSnapshot(snap);
});