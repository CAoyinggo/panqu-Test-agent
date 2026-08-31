/**
 * 测试 6-10：shell 注入 / shell:false / 超时与进程终止 / 输出上限 / 状态分类。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheck, commandDisplay, DEFAULT_MAX_OUTPUT_BYTES } from '../src/check-runner.mjs';
import { tmpDir, write } from './helpers.mjs';

const PASS_PROJECT = {
  'package.json': JSON.stringify({
    name: 'pass', version: '1.0.0',
    scripts: { typecheck: 'node -e "process.exit(0)"', test: 'echo ok' },
  }),
  'package-lock.json': '{}',
};

function projectDir(files) {
  const dir = tmpDir('panqu-check-');
  for (const [rel, content] of Object.entries(files)) write(join(dir, rel), content);
  return dir;
}

test('PASSED：exit 0', async () => {
  const dir = projectDir(PASS_PROJECT);
  const res = await runCheck({ name: 'test', scriptName: 'test', cwd: dir, manager: 'npm', timeoutMs: 10000 });
  assert.equal(res.status, 'PASSED');
  assert.equal(res.exitCode, 0);
});

test('FAILED：exit 非 0', async () => {
  const dir = projectDir({
    'package.json': JSON.stringify({ name: 'fail', version: '1.0.0', scripts: { test: 'node -e "process.exit(3)"' } }),
  });
  const res = await runCheck({ name: 'test', scriptName: 'test', cwd: dir, manager: 'npm', timeoutMs: 10000 });
  assert.equal(res.status, 'FAILED');
  assert.equal(res.exitCode, 3);
});

test('BLOCKED：传入 blocked 说明时直接 BLOCKED，不执行', async () => {
  const dir = projectDir(PASS_PROJECT);
  const res = await runCheck({ name: 'test', scriptName: 'test', cwd: dir, manager: 'npm', timeoutMs: 10000, blocked: 'node_modules 缺失' });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(res.exitCode, null);
});

test('ERROR：cwd 不存在 → spawn error', async () => {
  const res = await runCheck({ name: 'test', scriptName: 'test', cwd: '/no/such/dir/xyz', manager: 'npm', timeoutMs: 10000 });
  assert.equal(res.status, 'ERROR');
});

test('shell 注入字符无法变成命令（shell:false，参数数组）', async () => {
  const pwned = join(tmpDir(), 'pwned-marker');
  const dir = projectDir(PASS_PROJECT);
  const malicious = `x; touch ${pwned}`;
  const res = await runCheck({ name: 'test', scriptName: malicious, cwd: dir, manager: 'npm', timeoutMs: 10000 });
  // npm 会把整串当作字面脚本名 → Missing script → FAILED；绝不执行注入命令
  assert.equal(res.status, 'FAILED');
  assert.equal(existsSync(pwned), false, '注入命令不得被执行');
});

test('超时与进程组终止：TIMEOUT 且子进程被杀', async () => {
  const dir = projectDir({
    'package.json': JSON.stringify({
      name: 'slow', version: '1.0.0',
      scripts: {
        test: 'node -e "require(\'fs\').writeFileSync(\'pid.txt\', String(process.pid)); setTimeout(()=>{}, 60000)"',
      },
    }),
  });
  const res = await runCheck({ name: 'test', scriptName: 'test', cwd: dir, manager: 'npm', timeoutMs: 500 });
  assert.equal(res.status, 'TIMEOUT');
  assert.ok(res.durationMs < 10000, `duration 应 < 10s，实际 ${res.durationMs}ms`);
  // 进程组应被终止：pid.txt 中的 node 进程应已不存在
  const pidFile = join(dir, 'pid.txt');
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : NaN;
  if (Number.isInteger(pid) && pid > 0) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `node 子进程 ${pid} 应已被终止`);
  }
});

test('stdout/stderr 字节上限', async () => {
  const dir = projectDir({
    'package.json': JSON.stringify({
      name: 'noisy', version: '1.0.0',
      scripts: { test: 'node -e "process.stdout.write(\'a\'.repeat(500*1024))"' },
    }),
  });
  const res = await runCheck({ name: 'test', scriptName: 'test', cwd: dir, manager: 'npm', timeoutMs: 10000, maxOutputBytes: 4096 });
  assert.equal(res.status, 'PASSED');
  assert.equal(res.stdoutTruncated, true);
  assert.ok(res.stdout.length <= 4096, `stdout 应被截断到上限内，实际 ${res.stdout.length}`);
  assert.equal(res.stderr.length, 0);
});

test('commandDisplay 只输出白名单解析后的展示形式', () => {
  assert.equal(commandDisplay('npm', 'typecheck'), 'npm run typecheck');
  assert.equal(commandDisplay('pnpm', 'lint'), 'pnpm run lint');
  assert.equal(commandDisplay('yarn', 'build'), 'yarn run build');
});

test('默认输出上限常量合法', () => {
  assert.ok(DEFAULT_MAX_OUTPUT_BYTES > 0);
});
