/**
 * P0-2 真实四项检查 + P0-4 provenance 分离（报告级断言）。
 * 真实 fixture（typescript/eslint/@types/node + CJS dayjs + ESM p-limit），
 * 通过 fake traecli（HOME 兜底注入）使分析确定性 PASSED。
 *
 * 断言：四项真实 spawn（exit_code=0、duration_ms>0）、overall=PASSED、
 *       .bin 解析（tsc/eslint 经 node_modules/.bin）、CJS/ESM 解析、
 *       Markdown+JSON 生成、agent SHA 与 target HEAD 分离且 source 脱敏、
 *       原 fixture（源码+node_modules 哨兵）不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run, tmpDir, hashTree, PACKAGE_ROOT } from './helpers.mjs';
import { makeFakeTraecliRoot, buildRealFixture } from './helpers-p0.mjs';

const CLI_BIN = join(PACKAGE_ROOT, 'bin', 'panqu-test-agent.mjs');

test('P0: 真实 typecheck/lint/test/build 全部执行且 provenance 分离', () => {
  const fake = makeFakeTraecliRoot();
  const fx = buildRealFixture();
  const reportDir = tmpDir('panqu-p0-reports-');
  try {
    const before = hashTree(fx.dir);
    const res = run('node', [
      CLI_BIN, 'validate',
      '--workspace', fx.dir,
      '--checks', 'typecheck,lint,test,build',
      '--report-dir', reportDir,
      '--timeout-ms', '180000',
    ], {
      timeout: 420000,
      env: fake.env(),
    });
    assert.equal(res.code, 0, `validate 应 exit 0\nstdout: ${res.stdout.slice(-1200)}\nstderr: ${res.stderr.slice(-800)}`);

    const runDir = join(reportDir, readdirSync(reportDir)[0]);
    const json = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));

    // —— 四项真实执行 ——
    assert.equal(json.checks.length, 4);
    for (const c of json.checks) {
      assert.equal(c.status, 'PASSED', `check ${c.name} 应 PASSED：${c.summary}`);
      assert.equal(c.exit_code, 0, `check ${c.name} exit_code 应为 0`);
      assert.ok(c.duration_ms > 0, `check ${c.name} duration_ms 应 > 0`);
      assert.equal(existsSync(join(runDir, c.stdout_log || '')), true, `${c.name} stdout 日志应落盘`);
    }
    assert.equal(json.overall_status, 'PASSED');
    assert.equal(json.analysis.status, 'PASSED', `fake traecli 分析应 PASSED：${json.analysis.reason || ''}`);

    // .bin 解析：typecheck/build 通过 node_modules/.bin/tsc 执行；lint 通过 .bin/eslint
    const typecheck = json.checks.find((c) => c.name === 'typecheck');
    const lint = json.checks.find((c) => c.name === 'lint');
    assert.ok(typecheck && typecheck.status === 'PASSED');
    assert.ok(lint && lint.status === 'PASSED');

    // CJS/ESM 解析：test 检查真实执行（其测试文件同时 import p-limit 与 require dayjs）
    const testCheck = json.checks.find((c) => c.name === 'test');
    assert.equal(testCheck.exit_code, 0);

    // Markdown + analysis + logs
    assert.equal(existsSync(join(runDir, 'report.md')), true);
    assert.equal(existsSync(join(runDir, 'analysis.json')), true);
    assert.equal(existsSync(join(runDir, 'logs')), true);
    const md = readFileSync(join(runDir, 'report.md'), 'utf8');
    assert.ok(md.includes('**PASSED**'), 'Markdown 应反映 PASSED');
    assert.ok(md.includes(json.agent.source_commit_or_tag), 'Markdown 应包含 agent provenance');

    // —— P0-4 provenance 分离（报告级）——
    const agentHead = run('git', ['-C', join(PACKAGE_ROOT, '..', '..'), 'rev-parse', 'HEAD']).stdout.trim();
    assert.match(json.agent.source_commit_or_tag, /^[0-9a-f]{40}$/, 'agent commit 应为 40 位 SHA');
    assert.equal(json.agent.source_commit_or_tag, agentHead, 'agent 来源应为 agent 自身仓库 HEAD（local-checkout）');
    assert.equal(json.agent.provenance_status, 'DECLARED', '本地 checkout 无 resolved 元数据 → DECLARED');
    assert.equal(json.workspace.git_head, fx.head, 'workspace.git_head 应为被测 fixture HEAD');
    assert.notEqual(json.agent.source_commit_or_tag, json.workspace.git_head, 'agent SHA 与 target HEAD 不得混用');
    assert.equal(json.agent.source_spec, 'local-checkout');
    assert.ok(!/[?&]|@.*:.*@|token|password/i.test(json.agent.source), `source 应无凭据痕迹：${json.agent.source}`);

    // —— 原 fixture 不变（源码 + node_modules 哨兵；build 产物不泄漏）——
    assert.deepEqual(hashTree(fx.dir), before, '原 fixture（含 node_modules 文件内容）不得被改写');
    assert.equal(readFileSync(fx.sentinelPath, 'utf8'), 'SENTINEL-P0-ORIGINAL', '哨兵文件不得被改写');
    assert.equal(existsSync(join(fx.dir, 'dist')), false, 'build 产物不得泄漏到原 workspace');
  } finally {
    fake.cleanup();
    fx.cleanup();
    run('rm', ['-rf', reportDir]);
  }
});