#!/usr/bin/env node
// agent-ci-gate.mjs — Agent CI 六态门禁校验（Phase 20.7）
// 作用：
//   1) 用确定性夹具分别校验 BLOCKED（P0 失败）、WARNING（环境错误）、PASS（全过）三态的 CLI 退出码；
//   2) 验证 --ci-status 输出六态结论（PASS/FAIL/WARNING/BLOCKED/KNOWN_ISSUE/FLAKY）与 P0 阻断规则；
//   3) 输出 GitHub Actions Summary（$GITHUB_STEP_SUMMARY）。
// 用法：node scripts/ci/agent-ci-gate.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'output', 'ci');
fs.mkdirSync(outDir, { recursive: true });

const ok = (id) => ({ caseId: id, name: id, feature: 'wan3', priority: 'P1', pass: true, passRate: 100 });

/** 夹具 1：P0 失败 + P2 失败 → BLOCKED */
const blocked = {
  feature: 'wan3',
  total: 4,
  passed: 2,
  failed: 2,
  timedOut: 0,
  passRate: 50,
  executed: true,
  reports: [],
  results: [
    { ...ok('tc-pass-001'), priority: 'P1' },
    { ...ok('tc-pass-002'), priority: 'P2' },
    { caseId: 'tc-p0-001', name: 'URL 断言', feature: 'wan3', priority: 'P0', pass: false, passRate: 0, error: '期望 data.result.url 为空' },
    { caseId: 'tc-p2-001', name: '积分断言', feature: 'wan3', priority: 'P2', pass: false, passRate: 0, error: '积分未扣减' },
  ],
};

/** 夹具 2：全部通过 → PASS */
const clean = { ...blocked, passed: 4, failed: 0, passRate: 100, results: blocked.results.map((r) => ({ ...r, pass: true, passRate: 100 })) };

/** 夹具 3：仅环境错误（5xx）→ WARNING（无真实失败，不判产品失败） */
const envWarn = {
  feature: 'wan3',
  total: 4,
  passed: 3,
  failed: 1,
  timedOut: 0,
  passRate: 75,
  executed: true,
  reports: [],
  results: [
    { ...ok('tc-pass-001') },
    { ...ok('tc-pass-002') },
    { ...ok('tc-pass-003') },
    { ...ok('tc-p0-001'), priority: 'P0', pass: false, passRate: 0, error: 'HTTP 502 Bad Gateway' },
  ],
};

const fixtures = [
  ['p0-blocked', blocked, 'BLOCKED', 1],
  ['clean', clean, 'PASS', 0],
  ['env-warning', envWarn, 'WARNING', 0],
];

const failures = [];
let summaryLines = [];
const summaryFile = process.env.GITHUB_STEP_SUMMARY;

function runCiStatus(file) {
  return spawnSync(process.execPath, ['dist/bin/run-agent.js', `--ci-status=${file}`, '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
}

summaryLines.push('## Agent CI 六态门禁校验');
summaryLines.push('');
summaryLines.push('| 夹具 | 期望结论 | 实际结论 | 期望退出码 | 实际退出码 | 结果 |');
summaryLines.push('|------|----------|----------|------------|------------|------|');

for (const [name, fixture, expectVerdict, expectCode] of fixtures) {
  const file = path.join(outDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2));
  const run = runCiStatus(file);
  let actualVerdict = '(无法解析)';
  let actualCode = String(run.status);
  let okRun = false;
  try {
    const ci = JSON.parse(run.stdout);
    actualVerdict = ci.verdict ?? '(无 verdict)';
    const verdictOk = actualVerdict === expectVerdict;
    const codeOk = run.status === expectCode;
    okRun = verdictOk && codeOk;
    if (!verdictOk) failures.push(`${name}: 期望 ${expectVerdict}，实际 ${actualVerdict}`);
    if (!codeOk) failures.push(`${name}: 期望退出码 ${expectCode}，实际 ${run.status}`);
  } catch (e) {
    failures.push(`${name}: 无法解析输出（退出码 ${run.status}）${(run.stderr || run.stdout || '').slice(0, 200)}`);
  }
  const mark = okRun ? '✅' : '❌';
  console.log(`${mark} ${name}: 期望 ${expectVerdict}/exit=${expectCode}，实际 ${actualVerdict}/exit=${actualCode}`);
  summaryLines.push(`| ${name} | ${expectVerdict} | ${actualVerdict} | ${expectCode} | ${actualCode} | ${mark} |`);
}

if (summaryFile) {
  try {
    fs.appendFileSync(summaryFile, summaryLines.join('\n') + '\n');
  } catch (e) {
    console.warn(`无法写入 GitHub Summary：${e.message}`);
  }
}

if (failures.length) {
  console.error('\n❌ Agent CI 门禁校验失败：');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\n✅ Agent CI 六态门禁校验通过（P0 阻断规则生效）');
