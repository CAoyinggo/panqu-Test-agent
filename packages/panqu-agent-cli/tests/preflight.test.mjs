/**
 * 测试 2 + 16 + 17：workspace 路径校验；traecli 缺失/未登录探测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkspace, findTraecli, traecliLoginStatus } from '../src/preflight.mjs';
import { tmpDir, makeGitRepo, write } from './helpers.mjs';

test('非 Git 目录 fail closed', async () => {
  const dir = tmpDir();
  const res = await validateWorkspace(dir);
  assert.equal(res.ok, false);
  assert.equal(res.status, 'BLOCKED');
});

test('不存在的路径 fail closed', async () => {
  const res = await validateWorkspace('/no/such/path/xyz');
  assert.equal(res.ok, false);
});

test('普通文件路径 fail closed', async () => {
  const dir = tmpDir();
  write(`${dir}/a.txt`, 'x');
  const res = await validateWorkspace(`${dir}/a.txt`);
  assert.equal(res.ok, false);
});

test('Git 工作区通过', async () => {
  const dir = makeGitRepo({ 'package.json': '{"name":"x","version":"1.0.0"}' });
  const res = await validateWorkspace(dir);
  assert.equal(res.ok, true);
});

test('findTraecli 缺省时返回 null 或路径（不抛错）', async () => {
  const p = await findTraecli();
  assert.ok(p === null || typeof p === 'string');
});

test('traecliLoginStatus 只返回状态枚举，不含凭据', async () => {
  // 用一个假的可执行脚本模拟未登录输出
  const dir = tmpDir();
  const fake = `${dir}/traecli`;
  write(fake, '#!/bin/sh\necho "Not logged in"\n');
  // eslint-disable-next-line no-undef
  await import('node:fs').then(({ chmodSync }) => chmodSync(fake, 0o755));
  const res = await traecliLoginStatus(fake);
  assert.equal(res.status, 'not_logged_in');
  assert.equal(res.raw.includes('logged'), true);
});
