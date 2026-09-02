/**
 * 回归测试：agent provenance 数据模型（resolved Git 为可信来源）。
 * 覆盖：VERIFIED/DECLARED/UNKNOWN、null 语义、parseGitResolved、sanitizeSourceSpec（脱敏）、
 *       local-checkout 读取 agent 自身 HEAD（不用 target HEAD）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProvenance, parseGitResolved, sanitizeSourceSpec, readAgentGitHead } from '../src/provenance.mjs';
import { tmpDir, makeGitRepo, run } from './helpers.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('parseGitResolved 解析 git+#sha，拒绝非法输入', () => {
  assert.deepEqual(parseGitResolved(`git+file:///x#${SHA_A}`), { spec: 'git+file:///x', commit: SHA_A });
  assert.deepEqual(parseGitResolved(`git+https://user:pass@github.com/x/y.git#${SHA_B}`), { spec: 'git+https://user:pass@github.com/x/y.git', commit: SHA_B });
  assert.equal(parseGitResolved('not-a-git-url'), null);
  assert.equal(parseGitResolved(`git+file:///x#shortsha`), null);
});

test('sanitizeSourceSpec 移除 userinfo/query/fragment 凭据', () => {
  assert.equal(sanitizeSourceSpec('git+https://user:secret@github.com/a/b.git'), 'git+https://github.com/a/b.git');
  assert.equal(sanitizeSourceSpec('git+https://tok123:x@host/r.git?ref=abc#frag'), 'git+https://host/r.git');
  assert.equal(sanitizeSourceSpec('git+file:///tmp/repo'), 'git+file:///tmp/repo');
  // 输出不得包含 @user:pass 或 token
  const out = sanitizeSourceSpec('git+https://alice:p@ss@host/r.git');
  assert.equal(out.includes('@'), false, '不应残留 userinfo 的 @');
});

test('本地源码 checkout → local-checkout / DECLARED，commit 为 agent 自身 HEAD', () => {
  const ws = makeGitRepo({ 'package.json': '{"name":"x"}' });
  const head = run('git', ['-C', ws, 'rev-parse', 'HEAD']).stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  const p = computeProvenance({ agentVersion: '0.1.0', distributionSource: 'https://github.com/x', pkgDir: ws });
  assert.equal(p.source, 'local-checkout');
  assert.equal(p.source_commit_or_tag, head);
  assert.equal(p.provenance_status, 'DECLARED');
});

test('readAgentGitHead：非 Git 目录返回 null；Git 目录返回 40 位 SH', () => {
  assert.equal(readAgentGitHead(tmpDir('panqu-nogit-')), null);
  const ws = makeGitRepo({ 'package.json': '{"name":"x"}' });
  assert.match(readAgentGitHead(ws), /^[0-9a-f]{40}$/);
});

test('git 安装（resolved SHA）→ VERIFIED，source 脱敏', () => {
  const dir = tmpDir('panqu-prov-');
  const old = process.env.npm_package_resolved;
  process.env.npm_package_resolved = `git+https://user:secret@github.com/a/b.git#${SHA_A}`;
  try {
    const p = computeProvenance({ agentVersion: '0.1.0', distributionSource: 'https://github.com/x', pkgDir: dir });
    assert.equal(p.source_commit_or_tag, SHA_A);
    assert.equal(p.provenance_status, 'VERIFIED');
    assert.equal(p.source_spec, 'git');
    assert.equal(p.source, 'git+https://github.com/a/b.git');
  } finally {
    if (old === undefined) delete process.env.npm_package_resolved; else process.env.npm_package_resolved = old;
  }
});

test('无 resolved 且非 Git checkout → local-package / UNKNOWN / null', () => {
  const dir = tmpDir('panqu-prov-');
  const p = computeProvenance({ agentVersion: '0.1.0', distributionSource: 'https://github.com/x', pkgDir: dir });
  assert.equal(p.source_commit_or_tag, null);
  assert.equal(p.provenance_status, 'UNKNOWN');
  assert.notEqual(p.source_commit_or_tag, 'v0.1.0');
});