/**
 * 测试 11-14：dirty Git 工作区快照；未跟踪源码复制；.env/私钥/大文件排除；
 * 原工作区文件 hash 前后不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot, cleanupSnapshot, isExcludedUntracked, isManagedSnapshotRoot } from '../src/workspace-snapshot.mjs';
import { makeGitRepo, write, hashTree, run, tmpDir } from './helpers.mjs';

test('dirty 工作区快照：未提交修改与未跟踪源码进入快照，原工作区不变', () => {
  const ws = makeGitRepo({
    'package.json': '{"name":"x","version":"1.0.0"}',
    'src/a.js': 'module.exports = 1;\n',
  });
  // 未提交修改
  write(`${ws}/src/a.js`, 'module.exports = 2;\n');
  // 未跟踪源码
  write(`${ws}/src/b.js`, 'module.exports = 3;\n');

  const before = hashTree(ws);
  const snap = createSnapshot(ws);
  assert.equal(snap.ok, true);
  const wt = snap.worktree;

  assert.equal(readFileSync(`${wt}/src/a.js`, 'utf8'), 'module.exports = 2;\n', '未提交修改应进入快照');
  assert.equal(readFileSync(`${wt}/src/b.js`, 'utf8'), 'module.exports = 3;\n', '未跟踪源码应进入快照');
  assert.equal(snap.excluded.length, 0);

  const after = hashTree(ws);
  assert.deepEqual(after, before, '原工作区文件 hash 前后必须一致');

  cleanupSnapshot(snap);
});

test('.env / 私钥 / 大文件 默认排除并写入 excluded，不进入快照', () => {
  const ws = makeGitRepo({ 'package.json': '{"name":"x","version":"1.0.0"}' });
  write(`${ws}/.env`, 'SECRET=abc');
  write(`${ws}/.env.local`, 'TOKEN=xyz');
  write(`${ws}/keys/id_rsa`, 'PRIVATE KEY');
  write(`${ws}/certs/cert.pem`, 'PEM');
  write(`${ws}/big.bin`, 'x'.repeat(1024 * 1024));
  write(`${ws}/src/app.js`, 'ok');

  const snap = createSnapshot(ws, { maxUntrackedBytes: 1024 });
  assert.equal(snap.ok, true);
  const excludedPaths = snap.excluded.map((e) => e.path);
  assert.ok(excludedPaths.includes('.env'));
  assert.ok(excludedPaths.includes('.env.local'));
  assert.ok(excludedPaths.includes('keys/id_rsa'));
  assert.ok(excludedPaths.includes('certs/cert.pem'));
  assert.ok(excludedPaths.includes('big.bin'));
  assert.equal(existsSync(`${snap.worktree}/.env`), false);
  assert.equal(existsSync(`${snap.worktree}/keys/id_rsa`), false);
  assert.equal(existsSync(`${snap.worktree}/big.bin`), false);
  assert.equal(existsSync(`${snap.worktree}/src/app.js`), true, '普通源码应复制');

  cleanupSnapshot(snap);
});

test('isExcludedUntracked 规则覆盖 .env/私钥/敏感名/构建产物/大文件', () => {
  assert.equal(isExcludedUntracked('.env'), true);
  assert.equal(isExcludedUntracked('.env.production'), true);
  assert.equal(isExcludedUntracked('a/b/id_rsa'), true);
  assert.equal(isExcludedUntracked('keys/secret.json'), true);
  assert.equal(isExcludedUntracked('node_modules/x/y.js'), true);
  assert.equal(isExcludedUntracked('coverage/lcov.info'), true);
  assert.equal(isExcludedUntracked('dist/bundle.js'), true);
  assert.equal(isExcludedUntracked('src/app.js'), false);
});

test('受管快照根校验：只允许 tmpdir 下 panqu-snapshot- 前缀', () => {
  const managed = join(tmpdir(), 'panqu-snapshot-abc');
  assert.equal(isManagedSnapshotRoot(managed), true);
  assert.equal(isManagedSnapshotRoot('/Users/someone/panqu-snapshot-abc'), false);
  assert.equal(isManagedSnapshotRoot(join(tmpdir(), 'other-abc')), false);
});

test('快照内应用二进制 diff 补丁（--binary）', () => {
  const ws = makeGitRepo({ 'data.bin': Buffer.alloc(0) });
  // 修改为二进制内容（含 \0）
  write(`${ws}/data.bin`, Buffer.concat([Buffer.from('AB'), Buffer.from([0, 1, 2]), Buffer.from('CD')]));
  const before = hashTree(ws);
  const snap = createSnapshot(ws);
  assert.equal(snap.ok, true);
  const copied = readFileSync(`${snap.worktree}/data.bin`);
  assert.deepEqual(copied, Buffer.concat([Buffer.from('AB'), Buffer.from([0, 1, 2]), Buffer.from('CD')]));
  assert.deepEqual(hashTree(ws), before);
  cleanupSnapshot(snap);
});

test('cleanupSnapshot 清理本次创建的快照目录', () => {
  const ws = makeGitRepo({ 'package.json': '{"name":"x"}' });
  const snap = createSnapshot(ws);
  assert.equal(existsSync(snap.worktree), true);
  const res = cleanupSnapshot(snap);
  assert.equal(res.errors.length, 0);
  assert.equal(existsSync(snap.worktree), false);
  assert.equal(existsSync(snap.snapshotRoot), false);
});

test('git worktree 注册在清理后移除', () => {
  const ws = makeGitRepo({ 'package.json': '{"name":"x"}' });
  const snap = createSnapshot(ws);
  const listBefore = run('git', ['-C', ws, 'worktree', 'list']);
  assert.ok(listBefore.stdout.includes(snap.worktree), '快照 worktree 应已注册');
  cleanupSnapshot(snap);
  const listAfter = run('git', ['-C', ws, 'worktree', 'list']);
  assert.equal(listAfter.stdout.includes(snap.worktree), false, '快照 worktree 应已注销');
});
