/**
 * P0-1 根 Git 一条命令：git+file#SHA 安装即可启动 panqu-test-agent。
 * 断言：exit=0、版本正确、prepare/husky 不阻断安装、安装不修改候选源码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, hashTree } from './helpers.mjs';
import { buildMinimalCandidateRepo, realPath } from './helpers-p0.mjs';

test('P0: git+file#SHA 一条 npm exec 安装即可执行 --version（prepare/husky 不阻断，候选源码不变）', () => {
  const { repo, sha, filesHash } = buildMinimalCandidateRepo();
  const cache = `${repo}-npmcache`;
  const url = `git+file://${realPath(repo)}#${sha}`;

  const res = run('npm', ['exec', '--yes', `--package=${url}`, '--', 'panqu-test-agent', '--version'], {
    timeout: 240000,
    env: { ...process.env, npm_config_cache: cache },
  });

  assert.equal(res.code, 0, `npm exec 应 exit 0\nstdout: ${res.stdout.slice(-800)}\nstderr: ${res.stderr.slice(-800)}`);
  assert.match(res.stdout, /0\.1\.0/, `版本输出应含 0.1.0：${res.stdout.slice(-400)}`);

  // 安装过程不得修改候选源码 / 不得产生新 commit
  assert.equal(run('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout.trim(), sha, '候选 HEAD 不得变化');
  assert.deepEqual(hashTree(repo), filesHash, '候选源码文件不得被安装过程改写');
});