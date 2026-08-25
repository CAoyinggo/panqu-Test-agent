// 单元测试：CI 六态结果判定（Phase 20.7）
// 覆盖：isEnvironmentError / computeCiResult 六态
// PASS / FAIL / WARNING / BLOCKED / KNOWN_ISSUE / FLAKY，及 P0 阻断、P1 失败、P2/P3 告警等规则
import { describe, it, expect } from 'vitest';
import { computeCiResult, isEnvironmentError } from '../../src/qa/ci-result.js';
import { computeOutcome } from '../../src/agents/execution/execution-schema.js';
import type { CaseExecutionResult } from '../../src/agents/execution/execution-schema.js';

/** 便捷构造单条用例结果 */
function res(caseId: string, pass: boolean, over: Partial<CaseExecutionResult> = {}): CaseExecutionResult {
  const checks = over.checks?.map((check) => ({
    ...check,
    kind: check.kind ?? 'BUSINESS' as const,
  })) ?? [{
    name: `${caseId} 业务断言`,
    pass,
    detail: pass ? 'fixture business assertion passed' : 'fixture business assertion failed',
    kind: 'BUSINESS' as const,
  }];
  return {
    caseId,
    name: caseId,
    feature: 'wan3',
    processor: 'ci-result-fixture-processor',
    processorInvoked: true,
    executed: true,
    status: pass ? 'PASS' : 'FAIL',
    pass,
    passRate: pass ? 100 : 0,
    ...over,
    checks,
  };
}

const passAll = [
  res('c-pass-1', true),
  res('c-pass-2', true),
];

const env500: CaseExecutionResult = res('c-env', false, { error: 'HTTP 502 Bad Gateway' });
const envTimeout: CaseExecutionResult = res('c-env-t', false, { error: 'request timeout after 10s' });
const env429: CaseExecutionResult = res('c-env-429', false, { checks: [{ name: 'x', pass: false, detail: '429 Too Many Requests' }] });

describe('isEnvironmentError（环境类错误识别）', () => {
  it('识别 5xx', () => {
    expect(isEnvironmentError(env500)).toBe(true);
  });
  it('识别 429', () => {
    expect(isEnvironmentError(env429)).toBe(true);
  });
  it('识别超时', () => {
    expect(isEnvironmentError(envTimeout)).toBe(true);
  });
  it('识别网络错误（ENOTFOUND / ECONNREFUSED）', () => {
    expect(isEnvironmentError(res('c', false, { error: 'ENOTFOUND api.example.com' }))).toBe(true);
    expect(isEnvironmentError(res('c', false, { error: 'connect ECONNREFUSED 127.0.0.1:8080' }))).toBe(true);
  });
  it('不误判普通断言失败', () => {
    expect(isEnvironmentError(res('c', false, { error: '断言错误码失败：期望 4001，实际 4003' }))).toBe(false);
    expect(isEnvironmentError(res('c', false, { error: '期望 4001，实际 4003' }))).toBe(false);
  });
});

describe('computeCiResult 六态判定', () => {
  it('全部通过 → PASS', () => {
    const ci = computeCiResult(computeOutcome('wan3', passAll));
    expect(ci.verdict).toBe('PASS');
    expect(ci.counts.pass).toBe(2);
    expect(ci.blockReasons).toEqual([]);
  });

  it('P0 失败（非已知/非环境）→ BLOCKED（阻断）', () => {
    const failP0 = res('c-p0', false, { error: '期望 URL 为空' });
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, failP0]), { priorities: { 'c-p0': 'P0' } });
    expect(ci.verdict).toBe('BLOCKED');
    expect(ci.blockReasons.some((r) => r.includes('P0'))).toBe(true);
  });

  it('结果自带 priority 字段（无映射）→ P0 失败仍 BLOCKED', () => {
    const failP0 = res('c-p0', false, { priority: 'P0', error: '期望 URL 为空' });
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, failP0]));
    expect(ci.verdict).toBe('BLOCKED');
    expect(ci.cases.find((c) => c.caseId === 'c-p0')?.priority).toBe('P0');
  });

  it('映射优先级优先于结果自带字段', () => {
    const failP0 = res('c-p0', false, { priority: 'P2', error: 'x' });
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, failP0]), { priorities: { 'c-p0': 'P0' } });
    expect(ci.verdict).toBe('BLOCKED');
  });

  it('P1 失败 → FAIL（按配置判失败）', () => {
    const failP1 = res('c-p1', false, { error: '任务状态为 PENDING' });
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, failP1]), { priorities: { 'c-p1': 'P1' } });
    expect(ci.verdict).toBe('FAIL');
    expect(ci.blockReasons.some((r) => r.includes('P1'))).toBe(true);
  });

  it('P2/P3 失败 → WARNING（不阻断，nightly 关注）', () => {
    const failP2 = res('c-p2', false, { error: '非核心路径失败' });
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, failP2]), { priorities: { 'c-p2': 'P2' } });
    expect(ci.verdict).toBe('WARNING');
  });

  it('未知优先级失败 → WARNING（视为 P2/P3 档）', () => {
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, res('c-unknown', false, { error: 'x' })]));
    expect(ci.verdict).toBe('WARNING');
  });

  it('仅环境错误（5xx）→ WARNING 而非产品失败', () => {
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, env500]));
    expect(ci.verdict).toBe('WARNING');
    expect(ci.counts.envError).toBe(1);
    expect(ci.cases.find((c) => c.caseId === 'c-env')?.status).toBe('env-error');
  });

  it('已知问题（open）→ KNOWN_ISSUE', () => {
    const failKnown = res('c-known', false, { error: '已知缺陷：积分未扣除' });
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, failKnown]), {
      knownIssues: { 'c-known': 'open' },
    });
    expect(ci.verdict).toBe('KNOWN_ISSUE');
    expect(ci.counts.knownIssue).toBe(1);
    expect(ci.cases.find((c) => c.caseId === 'c-known')?.status).toBe('known-issue');
  });

  it('Flaky 标记 → FLAKY（不直接判产品失败）', () => {
    const flaky = res('c-flaky', false, { error: '偶发失败' });
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, flaky]), { flakyCaseIds: ['c-flaky'] });
    expect(ci.verdict).toBe('FLAKY');
    expect(ci.counts.flaky).toBe(1);
  });

  it('混合（环境错误 + 已知问题 + Flaky）→ WARNING 优先级最高', () => {
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, env500, res('c-k', false, { error: 'k' }), res('c-f', false, { error: 'f' })]), {
      knownIssues: { 'c-k': 'open' },
      flakyCaseIds: ['c-f'],
    });
    expect(ci.verdict).toBe('WARNING');
  });
});

describe('computeCiResult 选项覆盖', () => {
  it('blockOnP0=false：P0 失败不再阻断 → FAIL', () => {
    const failP0 = res('c-p0', false, { error: 'x' });
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, failP0]), {
      priorities: { 'c-p0': 'P0' },
      blockOnP0: false,
    });
    expect(ci.verdict).toBe('FAIL');
  });

  it('classifyEnvironment=false：环境错误按普通失败处理', () => {
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, env500]), { classifyEnvironment: false });
    expect(ci.counts.envError).toBe(0);
    expect(ci.cases.find((c) => c.caseId === 'c-env')?.status).toBe('fail');
  });

  it('ignoreFlaky=false：Flaky 标记不再豁免', () => {
    const flaky = res('c-flaky', false, { error: '偶发失败' });
    const ci = computeCiResult(computeOutcome('wan3', [...passAll, flaky]), {
      flakyCaseIds: ['c-flaky'],
      ignoreFlaky: false,
    });
    expect(ci.verdict).toBe('WARNING');
    expect(ci.counts.flaky).toBe(0);
  });

  it('空结果集 → BLOCKED（没有执行证据不得 PASS）', () => {
    const ci = computeCiResult(computeOutcome('wan3', []));
    expect(ci.verdict).toBe('BLOCKED');
    expect(ci.total).toBe(0);
    expect(ci.blockReasons.some((reason) => reason.includes('NO_EXECUTABLE_EVIDENCE'))).toBe(true);
  });

  it('summary 包含六态与计数', () => {
    const ci = computeCiResult(computeOutcome('wan3', passAll));
    expect(ci.summary).toContain('[PASS]');
    expect(ci.summary).toContain('通过 2');
  });
});
