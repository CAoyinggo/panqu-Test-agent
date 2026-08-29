// run-plan CLI 集成测试：通过 spawn 真实调用 dist/bin/run-plan.js，
// 覆盖落盘、零执行、哈希绑定、审批门禁、报告生成、幂等。
// 需要先 `npm run build`（依赖 dist/bin/run-plan.js）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = path.join(ROOT, 'dist', 'bin', 'run-plan.js');

const tmpDirs: string[] = [];

function newTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-plan-cli-'));
  tmpDirs.push(dir);
  return dir;
}

function runPlan(tmpDir: string, args: string[], input: string) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      TESTFLOW_OUTPUT_DIR: tmpDir,
      TESTFLOW_ALLOWED_TARGET_ORIGINS: 'https://nonexistent.invalid',
    },
    input,
    encoding: 'utf8',
  });
}

function basePlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirement_summary: '集成测试需求',
    target_url: 'https://nonexistent.invalid/',
    environment: 'test',
    test_scope: 'api',
    test_cases: [
      {
        id: 'C1',
        name: '健康检查',
        priority: 'P1',
        type: 'API',
        steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/x' }],
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 200 }],
      },
    ],
    risks: [],
    ...overrides,
  };
}

beforeAll(() => {
  expect(fs.existsSync(BIN), '请先执行 npm run build 生成 dist/bin/run-plan.js').toBe(true);
});

afterAll(() => {
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('run-plan CLI：action=plan', () => {
  it('校验并持久化成功，返回真实路径且零执行', () => {
    const tmp = newTmpDir();
    const res = runPlan(tmp, ['--stdin', '--action=plan', '--json'], JSON.stringify(basePlan()));
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.plan_id).toBeTruthy();
    expect(parsed.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.run_id).toBeTruthy();

    expect(fs.existsSync(parsed.paths.plan)).toBe(true);
    expect(fs.existsSync(parsed.paths.manifest)).toBe(true);
    const runDir = path.dirname(parsed.paths.plan);
    expect(fs.existsSync(path.join(runDir, 'result.json'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'report.html'))).toBe(false);
  });

  it('重复 case id 被拒绝', () => {
    const tmp = newTmpDir();
    const plan = basePlan();
    const dup = { ...(plan.test_cases as unknown[])[0] as Record<string, unknown> };
    plan.test_cases = [dup, dup];
    const res = runPlan(tmp, ['--stdin', '--action=plan', '--json'], JSON.stringify(plan));
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('PLAN_INVALID');
    expect(parsed.errors.map((e: { code: string }) => e.code)).toContain('DUPLICATE_CASE_ID');
  });

  it('敏感 header 被拒绝', () => {
    const tmp = newTmpDir();
    const plan = basePlan({
      test_cases: [
        {
          id: 'C1',
          name: 'x',
          priority: 'P1',
          type: 'API',
          steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/x', headers: { Authorization: 'Bearer x' } }],
          assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 200 }],
        },
      ],
    });
    const res = runPlan(tmp, ['--stdin', '--action=plan', '--json'], JSON.stringify(plan));
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.code).toBe('PLAN_INVALID');
    expect(parsed.errors.map((e: { code: string }) => e.code)).toContain('SENSITIVE_HEADER');
  });
});

describe('run-plan CLI：action=execute', () => {
  function planOnce(tmpDir: string): { plan_id: string; plan_hash: string } {
    const res = runPlan(tmpDir, ['--stdin', '--action=plan', '--json'], JSON.stringify(basePlan()));
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    return { plan_id: parsed.plan_id, plan_hash: parsed.plan_hash };
  }

  it('plan_hash 不匹配时被 BLOCKED', () => {
    const tmp = newTmpDir();
    const { plan_id } = planOnce(tmp);
    const wrongHash = '0'.repeat(64);
    const res = runPlan(tmp, ['--stdin', '--action=execute', '--json'], JSON.stringify({ plan_id, expected_plan_hash: wrongHash, idempotency_key: 'idem-1' }));
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.blocked).toBe(true);
    expect(parsed.code).toBe('PLAN_HASH_MISMATCH');
  });

  it('preonline 环境永远 BLOCK（APPROVAL_BACKEND_NOT_IMPLEMENTED）', () => {
    const tmp = newTmpDir();
    const pre = basePlan({ environment: 'preonline' });
    const res = runPlan(tmp, ['--stdin', '--action=plan', '--json'], JSON.stringify(pre));
    const planned = JSON.parse(res.stdout);
    expect(planned.ok).toBe(true);

    const exe = runPlan(
      tmp,
      ['--stdin', '--action=execute', '--json'],
      JSON.stringify({ plan_id: planned.plan_id, expected_plan_hash: planned.plan_hash, idempotency_key: 'idem-1' }),
    );
    expect(exe.status).toBe(1);
    const parsed = JSON.parse(exe.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.blocked).toBe(true);
    expect(parsed.code).toBe('APPROVAL_BACKEND_NOT_IMPLEMENTED');
  });

  it('execute 真实生成 result.json + report.html，且 DESIGNED_ONLY 标注存在', () => {
    const tmp = newTmpDir();
    const { plan_id, plan_hash } = planOnce(tmp);
    const res = runPlan(
      tmp,
      ['--stdin', '--action=execute', '--json'],
      JSON.stringify({ plan_id, expected_plan_hash: plan_hash, idempotency_key: 'idem-1' }),
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.paths.result).toBeTruthy();
    expect(parsed.paths.report).toBeTruthy();
    expect(fs.existsSync(parsed.paths.result)).toBe(true);
    expect(fs.existsSync(parsed.paths.report)).toBe(true);

    const result = JSON.parse(fs.readFileSync(parsed.paths.result, 'utf8'));
    expect(result.summary.designedTotal).toBeDefined();
    expect(result.summary.executedTotal).toBeDefined();

    const html = fs.readFileSync(parsed.paths.report, 'utf8');
    expect(html).toContain('执行计划报告');
    expect(html).toContain('DESIGNED_ONLY');
  });

  it('report.html 首字节为 <!DOCTYPE html> 且权限 0600', () => {
    const tmp = newTmpDir();
    const { plan_id, plan_hash } = planOnce(tmp);
    const res = runPlan(
      tmp,
      ['--stdin', '--action=execute', '--json'],
      JSON.stringify({ plan_id, expected_plan_hash: plan_hash, idempotency_key: 'idem-1' }),
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    const reportPath = parsed.paths.report as string;
    expect(typeof reportPath).toBe('string');

    const html = fs.readFileSync(reportPath, 'utf8');
    const firstSegment = html.trimStart();
    expect(firstSegment.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(firstSegment[0]).not.toBe('"');

    const stat = fs.statSync(reportPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('同一 idempotency_key 不重复执行', () => {
    const tmp = newTmpDir();
    const { plan_id, plan_hash } = planOnce(tmp);
    const executeInput = JSON.stringify({ plan_id, expected_plan_hash: plan_hash, idempotency_key: 'idem-1' });

    const first = runPlan(tmp, ['--stdin', '--action=execute', '--json'], executeInput);
    const firstParsed = JSON.parse(first.stdout);
    expect(firstParsed.ok).toBe(true);
    expect(firstParsed.paths.result).toBeTruthy();

    const second = runPlan(tmp, ['--stdin', '--action=execute', '--json'], executeInput);
    const secondParsed = JSON.parse(second.stdout);
    expect(secondParsed.ok).toBe(true);
    expect(secondParsed.replayed).toBe(true);
  });
});

describe('run-plan CLI：analyze / resume 语义诚实', () => {
  it.each(['analyze', 'resume'])('action=%s 返回 NOT_IMPLEMENTED', (action) => {
    const tmp = newTmpDir();
    const res = runPlan(tmp, ['--stdin', `--action=${action}`, '--json'], JSON.stringify({}));
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('NOT_IMPLEMENTED');
  });
});