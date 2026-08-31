/**
 * 测试 22：npm pack 产物（tgz）无敏感信息、无个人绝对路径、不包含测试/报告/日志。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, tmpDir, PACKAGE_ROOT } from './helpers.mjs';

function packTgz() {
  const dest = tmpDir('panqu-pack-');
  const res = run('npm', ['pack', '--json', '--pack-destination', dest], { cwd: PACKAGE_ROOT });
  assert.equal(res.ok, true, `npm pack 失败: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  const filename = parsed[0].filename;
  return { tgz: join(dest, filename), dest, filename };
}

test('npm pack 成功且文件名遵循 name-version.tgz', () => {
  const { filename, tgz } = packTgz();
  assert.match(filename, /^panqu-test-agent-cli-\d+\.\d+\.\d+\.tgz$/);
  assert.ok(existsSync(tgz));
});

test('tgz 内容白名单：包含 bin/src/prompts/schemas，不包含 tests/报告/日志/.env/私钥', () => {
  const { tgz, dest } = packTgz();
  const list = run('tar', ['-tf', tgz]);
  assert.equal(list.ok, true);
  const files = list.stdout.split('\n').filter(Boolean);
  const has = (sub) => files.some((f) => f.includes(sub));

  assert.ok(has('package/bin/panqu-test-agent.mjs'), 'bin 入口应打包');
  assert.ok(has('package/src/cli.mjs'), 'src 应打包');
  assert.ok(has('package/src/check-runner.mjs'), 'check-runner 应打包');
  assert.ok(has('package/prompts/panqu-local-validator.md'), 'prompt 应打包');
  assert.ok(has('package/schemas/analysis.schema.json'), 'schema 应打包');
  assert.ok(has('package/schemas/report.schema.json'), 'schema 应打包');
  assert.ok(has('package/README.md'), 'README 应打包');
  assert.ok(has('package/LICENSE'), 'LICENSE 应打包');

  assert.equal(has('package/tests/'), false, '测试不应打包');
  assert.equal(has('package/package-lock.json'), false, '无需 lockfile 打包');
  assert.equal(has('.env'), false);
  assert.equal(has('.tgz'), false, '不应包含嵌套 tgz');
  assert.equal(has('node_modules'), false);
});

test('tgz 内容扫描：无个人绝对路径 / 无 secret 标记 / 无 token 类内容', () => {
  const { tgz, dest } = packTgz();
  const extractDir = join(dest, 'extracted');
  run('mkdir', ['-p', extractDir]);
  const ex = run('tar', ['-xf', tgz, '-C', extractDir]);
  assert.equal(ex.ok, true);

  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && /\.(mjs|js|json|md|toml|txt)$/.test(name)) {
        const content = readFileSync(full, 'utf8');
        // 个人绝对路径
        if (/\/Users\/[^/\s:"']+/.test(content)) offenders.push(`${full}: personal_abs_path`);
        // secret/token 类字面量（排除 schema/prompt 中的字段名说明）
        if (/bearer\s+[a-z0-9]|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(content)) offenders.push(`${full}: secret_literal`);
        if (/GH[ps]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/.test(content)) offenders.push(`${full}: api_key_literal`);
      }
    }
  };
  walk(extractDir);
  assert.deepEqual(offenders, [], `tgz 内发现敏感/个人路径: ${offenders.join('; ')}`);
});
