/**
 * 回归测试：快照对被测项目 node_modules 的安全隔离复用。
 *
 * 覆盖：
 *   1. 原 node_modules 不被快照内命令修改（独立副本，非符号链接）；
 *   2. node_modules 副本是真实目录，杜绝符号链接逃逸写回；
 *   3. 原 node_modules 为符号链接时不复制（fail closed）；
 *   4. 清理快照时移除副本 node_modules，原 node_modules 保留；
 *   5. 依赖缺失继续 fail closed（阻塞原因）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs';
import { createSnapshot, cleanupSnapshot } from '../src/workspace-snapshot.mjs';
import { dependencyBlockReason } from '../src/project-discovery.mjs';
import { makeGitRepo, write, hashTree, tmpDir } from './helpers.mjs';

test('node_modules 以独立副本进入快照：快照内写入不影响原 node_modules', () => {
  const ws = makeGitRepo({
    'package.json': '{"name":"x","version":"1.0.0","devDependencies":{"a":"1.0.0"}}',
    '.gitignore': 'node_modules/\n',
  });
  write(`${ws}/node_modules/a/index.js`, 'module.exports = 1;\n');
  write(`${ws}/node_modules/a/package.json`, '{"name":"a","version":"1.0.0"}');
  const before = hashTree(`${ws}/node_modules`);

  const snap = createSnapshot(ws);
  assert.equal(snap.ok, true);
  const copiedFile = `${snap.worktree}/node_modules/a/index.js`;
  assert.equal(readFileSync(copiedFile, 'utf8'), 'module.exports = 1;\n', '副本应包含依赖内容');

  // 模拟快照内命令写入依赖文件
  write(copiedFile, 'module.exports = 2;\n');

  assert.equal(readFileSync(`${ws}/node_modules/a/index.js`, 'utf8'), 'module.exports = 1;\n', '原 node_modules 不得被修改');
  assert.deepEqual(hashTree(`${ws}/node_modules`), before, '原 node_modules hash 前后必须一致');
  cleanupSnapshot(snap);
});

test('node_modules 副本是真实目录而非符号链接：杜绝逃逸写回', () => {
  const ws = makeGitRepo({ 'package.json': '{}', '.gitignore': 'node_modules/\n' });
  write(`${ws}/node_modules/a/index.js`, 'x');
  const snap = createSnapshot(ws);
  assert.equal(snap.ok, true);
  const st = lstatSync(`${snap.worktree}/node_modules`);
  assert.equal(st.isSymbolicLink(), false, 'node_modules 必须是真实目录，不是指向原 workspace 的符号链接');
  assert.equal(st.isDirectory(), true);
  cleanupSnapshot(snap);
});

test('原 workspace 的 node_modules 是符号链接时不复制（fail closed，杜绝逃逸）', () => {
  const ws = makeGitRepo({ 'package.json': '{}' });
  const external = tmpDir('panqu-ext-');
  mkdirSync(`${external}/pkg`, { recursive: true });
  write(`${external}/pkg/a.js`, 'external');
  symlinkSync(external, `${ws}/node_modules`, 'dir');

  const snap = createSnapshot(ws);
  assert.equal(snap.ok, true);
  assert.equal(existsSync(`${snap.worktree}/node_modules`), false, '符号链接 node_modules 不得复制进快照');
  cleanupSnapshot(snap);
});

test('清理快照时移除副本 node_modules，原 node_modules 保留', () => {
  const ws = makeGitRepo({ 'package.json': '{}', '.gitignore': 'node_modules/\n' });
  write(`${ws}/node_modules/a/index.js`, 'x');
  const snap = createSnapshot(ws);
  assert.equal(existsSync(`${snap.worktree}/node_modules/a/index.js`), true, '副本应存在');
  const root = snap.snapshotRoot;
  const res = cleanupSnapshot(snap);
  assert.equal(res.errors.length, 0);
  assert.equal(existsSync(root), false, '快照根（含副本 node_modules）应被清理');
  assert.equal(existsSync(`${ws}/node_modules/a/index.js`), true, '原 node_modules 应保留');
});

test('缺失依赖继续 fail closed：依赖已声明但无 node_modules → 阻塞', () => {
  assert.equal(dependencyBlockReason(true, false).includes('node_modules 缺失'), true);
  assert.equal(dependencyBlockReason(true, true), null);
  assert.equal(dependencyBlockReason(false, false), null);
  assert.equal(dependencyBlockReason(false, true), null);
});