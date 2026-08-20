// Phase 45：决策重放（replay.ts）单元测试
// 覆盖：replayCase 多次执行结果指纹一致 → deterministic=true、
// readOnly 默认 true、无评估器的领域报错。

import { describe, it, expect } from 'vitest';
import { replayCase, replayAllCases } from '../../src/eval/replay.js';
import type { EvaluationCase, EvaluationDomain } from '../../src/eval/contract.js';

/** 最小 REQUIREMENT 用例（确定性规则评测） */
const REQ_CASE: EvaluationCase = {
  id: 'replay-req-01',
  domain: 'REQUIREMENT',
  input: { text: '测试文生视频生成，需积分扣除正确、任务最终成功。' },
  groundTruth: {
    feature: 'wan3',
    capabilities: ['text-to-video'],
    inputs: [],
    businessRules: ['积分正确扣除', '任务状态最终成功'],
    risks: [],
  },
};

/** 最小 RELEASE 用例（确定性三态发布决策） */
const RELEASE_CASE: EvaluationCase = {
  id: 'replay-release-001',
  domain: 'RELEASE',
  input: {
    p0: { total: 5, passed: 5 },
    p1: { total: 20, passed: 20 },
    coverage: 0.95,
    criticalDefects: 0,
    riskLevel: 'LOW',
  },
  groundTruth: { decision: 'PASS' },
};

/** 结构指纹（与实现一致：score/passed/actual/errors） */
function runFingerprint(o: ReturnType<typeof replayCase>) {
  return o.runs.map((r) => JSON.stringify({ score: r.result.score, passed: r.result.passed, actual: r.result.actual, errors: r.result.errors }));
}

describe('replayCase：多次执行结果指纹一致 → deterministic=true', () => {
  it('REQUIREMENT 用例重复执行 3 次 → deterministic=true 且指纹完全一致', () => {
    const out = replayCase(REQ_CASE, { runs: 3 });
    expect(out.deterministic).toBe(true);
    expect(out.runs).toHaveLength(3);
    expect(out.errors).toEqual([]);
    expect(runFingerprint(out)[0]).toBe(runFingerprint(out)[1]);
    expect(runFingerprint(out)[1]).toBe(runFingerprint(out)[2]);
    // 每个 run 都产出真实结果
    for (const run of out.runs) {
      expect(run.model).toBe('rules');
      expect(run.result.tracked).toBe(true);
      expect(typeof run.result.score).toBe('number');
    }
  });

  it('RELEASE 用例重复执行 3 次 → deterministic=true 且决策一致', () => {
    const out = replayCase(RELEASE_CASE, { runs: 3 });
    expect(out.deterministic).toBe(true);
    expect(out.runs).toHaveLength(3);
    expect(runFingerprint(out)[0]).toBe(runFingerprint(out)[1]);
    expect(runFingerprint(out)[1]).toBe(runFingerprint(out)[2]);
    expect((out.runs[0].result.actual as { decision: string }).decision).toBe('PASS');
  });

  it('默认 runs=2；自定义 runs=1 返回单次结果', () => {
    expect(replayCase(REQ_CASE).runs).toHaveLength(2);
    expect(replayCase(REQ_CASE, { runs: 1 }).runs).toHaveLength(1);
  });
});

describe('replayCase：readOnly 默认 true', () => {
  it('默认 readOnly=true', () => {
    expect(replayCase(REQ_CASE).readOnly).toBe(true);
    expect(replayCase(RELEASE_CASE).readOnly).toBe(true);
  });

  it('可显式传 readOnly=false', () => {
    expect(replayCase(REQ_CASE, { readOnly: false }).readOnly).toBe(false);
  });

  it('readOnly 标志透传到输出（确定性不受影响）', () => {
    const out = replayCase(REQ_CASE, { runs: 2, readOnly: false });
    expect(out.readOnly).toBe(false);
    expect(out.deterministic).toBe(true);
  });
});

describe('replayCase：无评估器的领域报错', () => {
  it('未知领域 → errors 非空、runs 为空、deterministic=false', () => {
    const bad: EvaluationCase = {
      id: 'no-evaluator',
      domain: 'UNKNOWN' as EvaluationDomain,
      input: {},
      groundTruth: {},
    };
    const out = replayCase(bad, { runs: 2 });
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors[0]).toContain('无可用的确定性评估器');
    expect(out.runs).toEqual([]);
    expect(out.deterministic).toBe(false);
    expect(out.readOnly).toBe(true);
  });
});

describe('replayAllCases：全链路确定性聚合', () => {
  it('全部确定性用例 → allDeterministic=true、无失败', () => {
    const out = replayAllCases([REQ_CASE, RELEASE_CASE]);
    expect(out.outputs).toHaveLength(2);
    expect(out.allDeterministic).toBe(true);
    expect(out.failed).toEqual([]);
    for (const o of out.outputs) {
      expect(o.deterministic).toBe(true);
      expect(o.errors).toEqual([]);
    }
  });

  it('含无评估器用例 → allDeterministic=false 并标记失败', () => {
    const bad: EvaluationCase = {
      id: 'no-evaluator-2',
      domain: 'UNKNOWN' as EvaluationDomain,
      input: {},
      groundTruth: {},
    };
    const out = replayAllCases([REQ_CASE, bad]);
    expect(out.allDeterministic).toBe(false);
    expect(out.failed).toContain('UNKNOWN:no-evaluator-2');
  });
});
