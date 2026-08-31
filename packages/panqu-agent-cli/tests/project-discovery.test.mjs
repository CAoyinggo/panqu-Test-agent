/**
 * 测试 3 + 4 + 5：包管理器 / 脚本发现；多 lockfile fail-closed；未知 check 拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPackageManager,
  readPackageJson,
  planChecks,
  hasDependencyDeclared,
  hasNodeModules,
} from '../src/project-discovery.mjs';
import { parseChecks } from '../src/cli.mjs';
import { tmpDir, write } from './helpers.mjs';

function mkProject(lockfiles = [], pkgJson = null, extra = {}) {
  const dir = tmpDir();
  for (const lf of lockfiles) write(`${dir}/${lf}`, 'x');
  if (pkgJson) write(`${dir}/package.json`, JSON.stringify(pkgJson));
  for (const [rel, content] of Object.entries(extra)) write(`${dir}/${rel}`, content);
  return dir;
}

test('单 lockfile → 对应包管理器', () => {
  assert.equal(detectPackageManager(mkProject(['pnpm-lock.yaml'], {})).manager, 'pnpm');
  assert.equal(detectPackageManager(mkProject(['yarn.lock'], {})).manager, 'yarn');
  assert.equal(detectPackageManager(mkProject(['package-lock.json'], {})).manager, 'npm');
});

test('无 lockfile 但存在 package.json → 退回 npm', () => {
  const dir = mkProject([], { name: 'x' });
  const res = detectPackageManager(dir);
  assert.equal(res.ok, true);
  assert.equal(res.manager, 'npm');
  assert.equal(res.hasLockfile, false);
});

test('没有受支持 manifest → BLOCKED', () => {
  const res = detectPackageManager(tmpDir());
  assert.equal(res.ok, false);
  assert.equal(res.status, 'BLOCKED');
});

test('多种互相冲突的 lockfile → BLOCKED（fail closed）', () => {
  for (const combo of [
    ['pnpm-lock.yaml', 'yarn.lock'],
    ['pnpm-lock.yaml', 'package-lock.json'],
    ['yarn.lock', 'package-lock.json'],
    ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'],
  ]) {
    const res = detectPackageManager(mkProject(combo, {}));
    assert.equal(res.ok, false, `combo ${combo.join(',')} 应 fail closed`);
    assert.equal(res.status, 'BLOCKED');
  }
});

test('readPackageJson 解析成功/失败', () => {
  const ok = readPackageJson(mkProject([], { name: 'x', scripts: { test: 'echo hi' } }));
  assert.equal(ok.ok, true);
  assert.equal(ok.data.scripts.test, 'echo hi');
  const bad = readPackageJson(tmpDir());
  assert.equal(bad.ok, false);
});

test('planChecks：存在的脚本 RUNNABLE，缺失的 SKIPPED', () => {
  const plan = planChecks(['typecheck', 'lint', 'test', 'build'], { test: 'echo t', build: 'echo b' });
  const byName = Object.fromEntries(plan.map((p) => [p.name, p]));
  assert.equal(byName.typecheck.status, 'SKIPPED');
  assert.equal(byName.lint.status, 'SKIPPED');
  assert.equal(byName.test.status, 'RUNNABLE');
  assert.equal(byName.build.status, 'RUNNABLE');
});

test('未知 check 名在 parseChecks 层被拒绝（白名单）', () => {
  assert.equal(parseChecks('deploy').ok, false);
  assert.equal(parseChecks('typecheck,release').ok, false);
});

test('hasDependencyDeclared / hasNodeModules', () => {
  assert.equal(hasDependencyDeclared({ dependencies: { lodash: '^1' } }), true);
  assert.equal(hasDependencyDeclared({ devDependencies: { vitest: '^1' } }), true);
  assert.equal(hasDependencyDeclared({}), false);
  const dir = mkProject([], {});
  write(`${dir}/node_modules/x`, '');
  assert.equal(hasNodeModules(dir), true);
});
