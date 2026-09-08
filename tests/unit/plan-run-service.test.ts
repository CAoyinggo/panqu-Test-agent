// plan-run-service 单元测试：execute_test_plan 的 plan/execute/status 编排（无 LLM、无真实网络）。
// 覆盖验收：文件锁 + 幂等（并发只执行一次 / 同 key 重放 / 异 key 拒绝）；Policy Gate 接入；
//           preonline/prod BLOCK；allowlist fail-closed；原子持久化 0600；status 读真实状态。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from '../../src/utils/atomic-fs.js';
import { validatePlan, type NormalizedPlan } from '../../src/agents/plan/plan-contract.js';
import {
  executeRun,
  persistPlan,
  statusRun,
} from '../../src/agents/orchestration/plan-run-service.js';
import type { PlanExecutionResult } from '../../src/agents/orchestration/plan-executor.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-run-service-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function normalize(input: Record<string, unknown>): NormalizedPlan {
  const v = validatePlan(input);
  if (!v.ok) throw new Error('plan should be valid: ' + JSON.stringify(v.errors));
  return v.normalized;
}

function basePlanInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirement_summary: '测试需求',
    target_url: 'https://api.example.com/',
    environment: 'test',
    test_scope: 'api',
    test_cases: [
      {
        id: 'C1',
        name: '健康检查',
        priority: 'P1',
        type: 'API',
        steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/health' }],
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 200 }],
      },
    ],
    risks: [],
    ...overrides,
  };
}

const ALLOWED = new Set(['https://api.example.com']);

function makeResult(normalized: NormalizedPlan): PlanExecutionResult {
  return {
    schema: 'panqu-test-agent/plan-execution-result@1',
    targetUrl: normalized.targetUrl,
    environment: normalized.environment,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    summary: {
      designedTotal: 1,
      executableTotal: 1,
      executedTotal: 1,
      passed: 1,
      failed: 0,
      networkErrors: 0,
      responseTooLarge: 0,
      blocked: 0,
      blockedByBudget: 0,
      designedOnly: 0,
      passRate: 100,
    },
    caseResults: [{ caseId: 'C1', name: '健康检查', classification: 'EXECUTABLE', status: 'PASSED', assertions: [] }],
  };
}

describe('plan-run-service：persist + 原子持久化', () => {
  it('plan 落盘，文件权限 0600，无临时文件残留', () => {
    const persisted = persistPlan(normalize(basePlanInput()), { outputRoot: tmpDir, allowedOrigins: ALLOWED });
    const stat = fs.statSync(persisted.paths.plan);
    expect(stat.mode & 0o777).toBe(0o600);

    const runDir = path.dirname(persisted.paths.plan);
    const files = fs.readdirSync(runDir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('原子写入失败不遗留 .tmp、不产生半成品目标文件', () => {
    const target = path.join(tmpDir, 'atomic.json');
    // 先写入旧版本，验证 rename 失败后旧版本完整保留、不会被写坏。
    writeAtomic(target, '{"v":"old"}');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename fail');
    });

    expect(() => writeAtomic(target, '{"v":"new"}')).toThrow('rename fail');
    spy.mockRestore();

    // 旧版本完整保留（未被半成品替换）。
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ v: 'old' });
    // 无临时文件残留。
    expect(fs.readdirSync(tmpDir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

describe('plan-run-service：execute + Policy Gate', () => {
  it('preonline 永远 BLOCK（APPROVAL_BACKEND_NOT_IMPLEMENTED）', async () => {
    const normalized = normalize(basePlanInput({ environment: 'preonline' }));
    const persisted = persistPlan(normalized, { outputRoot: tmpDir, allowedOrigins: ALLOWED });
    const outcome = await executeRun(
      { plan_id: persisted.planId, expected_plan_hash: persisted.hash, idempotency_key: 'k1' },
      { outputRoot: tmpDir, allowedOrigins: ALLOWED },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.blocked).toBe(true);
    expect(outcome.code).toBe('APPROVAL_BACKEND_NOT_IMPLEMENTED');
  });

  it('allowlist 未配置 fail-closed', async () => {
    const normalized = normalize(basePlanInput());
    const persisted = persistPlan(normalized, { outputRoot: tmpDir, allowedOrigins: ALLOWED });
    const outcome = await executeRun(
      { plan_id: persisted.planId, expected_plan_hash: persisted.hash, idempotency_key: 'k1' },
      { outputRoot: tmpDir }, // 不传 allowedOrigins → 未配置
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.blocked).toBe(true);
    expect(outcome.code).toBe('POLICY_GATE_BLOCKED');
  });

  it('非 allowlist origin BLOCKED', async () => {
    const normalized = normalize(basePlanInput({ target_url: 'https://evil.example.com/' }));
    const persisted = persistPlan(normalized, { outputRoot: tmpDir, allowedOrigins: ALLOWED });
    const outcome = await executeRun(
      { plan_id: persisted.planId, expected_plan_hash: persisted.hash, idempotency_key: 'k1' },
      { outputRoot: tmpDir, allowedOrigins: ALLOWED },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.blocked).toBe(true);
    expect(outcome.code).toBe('POLICY_GATE_BLOCKED');
  });

  it('缺少 idempotency_key 被拒绝（INVALID_ARGS）', async () => {
    const normalized = normalize(basePlanInput());
    const persisted = persistPlan(normalized, { outputRoot: tmpDir, allowedOrigins: ALLOWED });
    const outcome = await executeRun(
      { plan_id: persisted.planId, expected_plan_hash: persisted.hash },
      { outputRoot: tmpDir, allowedOrigins: ALLOWED },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('INVALID_ARGS');
  });
});

describe('plan-run-service：幂等与并发', () => {
  it('两个并发 execute 只发生一次网络执行', async () => {
    const normalized = normalize(basePlanInput());
    const persisted = persistPlan(normalized, { outputRoot: tmpDir, allowedOrigins: ALLOWED });
    let calls = 0;
    const mockExecute = async (n: NormalizedPlan): Promise<PlanExecutionResult> => {
      calls += 1;
      return makeResult(n);
    };

    const [a, b] = await Promise.all([
      executeRun(
        { plan_id: persisted.planId, expected_plan_hash: persisted.hash, idempotency_key: 'key-a' },
        { outputRoot: tmpDir, allowedOrigins: ALLOWED, executePlanFn: mockExecute },
      ),
      executeRun(
        { plan_id: persisted.planId, expected_plan_hash: persisted.hash, idempotency_key: 'key-b' },
        { outputRoot: tmpDir, allowedOrigins: ALLOWED, executePlanFn: mockExecute },
      ),
    ]);

    expect(calls).toBe(1);
    const results = [a, b].map((o) => o.ok);
    expect(results).toContain(true);
    expect(results).toContain(false);
    const refused = [a, b].find((o) => o.ok === false);
    expect(refused?.code).toBe('PLAN_ALREADY_EXECUTED');
  });

  it('相同 idempotency_key 返回第一次结果（replayed）', async () => {
    const normalized = normalize(basePlanInput());
    const persisted = persistPlan(normalized, { outputRoot: tmpDir, allowedOrigins: ALLOWED });
    let calls = 0;
    const mockExecute = async (n: NormalizedPlan): Promise<PlanExecutionResult> => {
      calls += 1;
      return makeResult(n);
    };
    const deps = { outputRoot: tmpDir, allowedOrigins: ALLOWED, executePlanFn: mockExecute };
    const first = await executeRun({ plan_id: persisted.planId, expected_plan_hash: persisted.hash, idempotency_key: 'key-x' }, deps);
    const second = await executeRun({ plan_id: persisted.planId, expected_plan_hash: persisted.hash, idempotency_key: 'key-x' }, deps);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('plan-run-service：status 读真实状态', () => {
  it('plan 后 status=PLANNED，execute 后 status=EXECUTED', async () => {
    const normalized = normalize(basePlanInput());
    const persisted = persistPlan(normalized, { outputRoot: tmpDir, allowedOrigins: ALLOWED });

    const beforeStatus = statusRun({ plan_id: persisted.planId }, { outputRoot: tmpDir });
    expect(beforeStatus.ok).toBe(true);
    expect(beforeStatus.status).toBe('PLANNED');

    const mockExecute = async (n: NormalizedPlan): Promise<PlanExecutionResult> => makeResult(n);
    const exe = await executeRun(
      { plan_id: persisted.planId, expected_plan_hash: persisted.hash, idempotency_key: 'key-x' },
      { outputRoot: tmpDir, allowedOrigins: ALLOWED, executePlanFn: mockExecute },
    );
    expect(exe.ok).toBe(true);

    const afterStatus = statusRun({ plan_id: persisted.planId }, { outputRoot: tmpDir });
    expect(afterStatus.ok).toBe(true);
    expect(afterStatus.status).toBe('EXECUTED');
  });
});