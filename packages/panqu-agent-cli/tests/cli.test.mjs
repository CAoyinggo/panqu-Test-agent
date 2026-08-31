/**
 * 测试 1：CLI 参数解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseChecks, parseTimeout, parseWorkspace, parseReportDir, parseApiOrigin, ALLOWED_CHECKS } from '../src/cli.mjs';

test('默认子命令是 validate，默认 checks 为全部白名单', () => {
  const opts = parseArgs([]);
  assert.equal(opts.command, 'validate');
  const checks = parseChecks(opts.checks);
  assert.ok(checks.ok);
  assert.deepEqual(checks.checks, ALLOWED_CHECKS);
});

test('--version / --help / --json / --execute-api / --dry-run 布尔开关', () => {
  const opts = parseArgs(['--version']);
  assert.equal(opts.version, true);
  const help = parseArgs(['--help']);
  assert.equal(help.help, true);
  const flags = parseArgs(['validate', '--json', '--execute-api', '--dry-run']);
  assert.equal(flags.json, true);
  assert.equal(flags.executeApi, true);
  assert.equal(flags.dryRun, true);
});

test('带值参数（--checks / --workspace / --report-dir / --timeout-ms / --api-origin）', () => {
  const opts = parseArgs([
    'validate',
    '--checks', 'typecheck,lint',
    '--workspace', '/tmp/foo',
    '--report-dir', './reports',
    '--timeout-ms', '5000',
    '--api-origin', 'https://test.panqu.com',
  ]);
  assert.equal(opts.checks, 'typecheck,lint');
  assert.equal(opts.workspace, '/tmp/foo');
  assert.equal(opts.reportDir, './reports');
  assert.equal(opts.timeoutMs, '5000');
  assert.equal(opts.apiOrigin, 'https://test.panqu.com');
});

test('= 形式赋值同样支持', () => {
  const opts = parseArgs(['--checks=typecheck', '--timeout-ms=1000']);
  assert.equal(opts.checks, 'typecheck');
  assert.equal(opts.timeoutMs, '1000');
});

test('未知参数被收集', () => {
  const opts = parseArgs(['--bogus', 'x']);
  assert.deepEqual(opts.unknown, ['--bogus', 'x']);
});

test('--checks 只接受白名单精确名；shell 注入字符被拒绝', () => {
  assert.equal(parseChecks('typecheck; rm -rf /tmp/x').ok, false);
  assert.equal(parseChecks('typecheck && echo pwned').ok, false);
  assert.equal(parseChecks('typecheck,../evil').ok, false);
  assert.equal(parseChecks('').ok, true);
  const ok = parseChecks('typecheck,lint');
  assert.ok(ok.ok);
  assert.deepEqual(ok.checks, ['typecheck', 'lint']);
});

test('--timeout-ms 必须为正整数', () => {
  assert.equal(parseTimeout('1000').ok, true);
  assert.equal(parseTimeout('0').ok, false);
  assert.equal(parseTimeout('-1').ok, false);
  assert.equal(parseTimeout('abc').ok, false);
  assert.equal(parseTimeout('1.5').ok, false);
});

test('--workspace 相对路径解析到绝对路径；不存在时失败', () => {
  const { path } = parseWorkspace('foo/bar');
  assert.ok(path.startsWith('/'));
  assert.equal(parseWorkspace('/definitely/not/exist/xyz123').ok, false);
});

test('--report-dir 缺省为 null（由调用方落到默认目录）', () => {
  assert.equal(parseReportDir(null), null);
  assert.ok(parseReportDir('./r').endsWith('/r'));
});

test('--api-origin 校验：非法/凭据/带路径 一律拒绝', () => {
  assert.equal(parseApiOrigin('https://test.panqu.com').ok, true);
  assert.equal(parseApiOrigin('http://test.panqu.com').ok, true);
  assert.equal(parseApiOrigin('ftp://x.com').ok, false);
  assert.equal(parseApiOrigin('https://user:pass@x.com').ok, false);
  assert.equal(parseApiOrigin('https://x.com/path').ok, false);
  assert.equal(parseApiOrigin('not a url').ok, false);
});
