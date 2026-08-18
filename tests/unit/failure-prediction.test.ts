// Phase 22.5 Failure Prediction 单元测试
// 覆盖：任务书场景（Case A 低失败率无变更 vs Case B 高失败率+高变更 → B 优先）、
// 类别判定（PASS/FAIL/FLAKY/ENV）、模型异常、环境异常、冲突信号、
// 空数据/历史不足、未执行当前版本、批量排序、确定性。

import { describe, it, expect } from 'vitest';
import {
  predictFailure,
  predictFailureBatch,
  type FailurePredictionInput,
} from '../../src/failure-prediction/index.js';

const DAY = 86400000;

/** 构造样本：total 个样本，其中 failIndexes 索引位置失败 */
function samples(total: number, failIndexes: number[], base = '2026-07-01T00:00:00Z'): Array<{ passed: boolean; at: string }> {
  const start = new Date(base).getTime();
  return Array.from({ length: total }, (_, i) => ({
    passed: !failIndexes.includes(i),
    at: new Date(start + i * DAY).toISOString(),
  }));
}

describe('任务书场景：失败概率驱动的优先级对比', () => {
  it('Case A：failureRate 0.01 无变更 → 低；Case B：failureRate 0.35 + changeImpact 0.8 → 高；B > A', () => {
    // A：100 次中 1 次失败（0.01）
    const a: FailurePredictionInput = {
      caseId: 'case-a',
      historicalSamples: samples(100, [50]),
      changeImpact: 0,
    };
    // B：20 次中 7 次失败（0.35）+ 变更 0.8
    const b: FailurePredictionInput = {
      caseId: 'case-b',
      historicalSamples: samples(20, [0, 3, 6, 9, 12, 15, 18]),
      changeImpact: 0.8,
    };
    const pa = predictFailure(a);
    const pb = predictFailure(b);
    expect(pa.failureProbability).toBeLessThan(0.2);
    expect(pb.failureProbability).toBeGreaterThan(0.2);
    expect(pb.failureProbability).toBeGreaterThan(pa.failureProbability);
    // 证据可解释：B 的历史与变更信号都被记录
    expect(pb.evidence.some((e) => e.includes('历史 20 次失败 7 次'))).toBe(true);
    expect(pb.evidence.some((e) => e.includes('变更影响 80%'))).toBe(true);
  });

  it('高失败概率 → 类别 FAIL；但 Flaky 信号优先 → FLAKY；Env 高 → ENV', () => {
    // FAIL：历史全失败 + 变更 + 模型 + 风险，无 flaky/env
    const fail = predictFailure({
      caseId: 'c1',
      historicalSamples: samples(10, Array.from({ length: 10 }, (_, i) => i)),
      changeImpact: 0.8,
      modelRisk: 0.5,
      riskScore: 0.5,
    });
    expect(fail.predictedCategory).toBe('FAIL');
    expect(fail.failureProbability).toBeGreaterThanOrEqual(0.5);
    expect(fail.confidence).toBeGreaterThanOrEqual(0.4);
    expect(fail.confidence).toBeLessThanOrEqual(0.95);

    // FLAKY：flaky 与 env 同时高 → 按确定性顺序判 FLAKY（冲突信号）
    const flaky = predictFailure({
      caseId: 'c2',
      historicalSamples: samples(10, Array.from({ length: 10 }, (_, i) => i)),
      changeImpact: 0.8,
      environmentRisk: 0.8,
      flakyRate: 0.6,
    });
    expect(flaky.predictedCategory).toBe('FLAKY');
    expect(flaky.evidence.some((e) => e.includes('Flaky 率 60%'))).toBe(true);

    // ENV：环境风险高、无 flaky
    const env = predictFailure({
      caseId: 'c3',
      historicalSamples: samples(10, Array.from({ length: 10 }, (_, i) => i)),
      changeImpact: 0.5,
      modelRisk: 0.5,
      environmentRisk: 0.8,
    });
    expect(env.predictedCategory).toBe('ENV');
    expect(env.evidence.some((e) => e.includes('环境风险 80%'))).toBe(true);
  });

  it('模型异常：modelRisk 高 → 概率抬升且证据记录', () => {
    const baseline = predictFailure({ caseId: 'm' });
    const withModel = predictFailure({ caseId: 'm', modelRisk: 0.9 });
    expect(withModel.factors.model).toBe(0.9);
    expect(withModel.failureProbability).toBeGreaterThan(baseline.failureProbability);
    expect(withModel.evidence.some((e) => e.includes('模型风险 90%'))).toBe(true);
  });
});

describe('空数据 / 历史不足 / 边界', () => {
  it('全部输入为空 → 概率 0、PASS、置信度低、无历史证据', () => {
    const p = predictFailure({ caseId: 'new' });
    expect(p.failureProbability).toBe(0);
    expect(p.predictedCategory).toBe('PASS');
    expect(p.confidence).toBeLessThan(0.5);
    expect(p.evidence).toEqual([]);
    expect(p.factors.historical).toBe(0);
  });

  it('历史数据不足：少量样本置信度被压低；无样本但有信号 → 证据不含历史', () => {
    const few = predictFailure({
      caseId: 'few',
      historicalSamples: samples(2, [1]),
      changeImpact: 0.8,
    });
    expect(few.confidence).toBeLessThan(0.6);
    // 2/30 数据强度低
    expect(few.evidence.some((e) => e.includes('历史 2 次失败 1 次'))).toBe(true);

    const noSamples = predictFailure({ caseId: 'signal-only', changeImpact: 0.9, defectDensity: 0.5 });
    expect(noSamples.evidence.some((e) => e.includes('历史'))).toBe(false);
    expect(noSamples.evidence.some((e) => e.includes('变更影响 90%'))).toBe(true);
    expect(noSamples.evidence.some((e) => e.includes('缺陷密度 50%'))).toBe(true);
  });

  it('当前版本未执行 → 证据标注并小幅抬升概率', () => {
    const unknown = predictFailure({ caseId: 'u', executedOnCurrentVersion: false });
    const known = predictFailure({ caseId: 'u', executedOnCurrentVersion: true });
    expect(unknown.evidence.some((e) => e.includes('当前版本尚未执行'))).toBe(true);
    expect(unknown.failureProbability).toBeGreaterThan(known.failureProbability);
  });

  it('边界：信号缺失按 0 处理，不抛异常；所有概率被 clamp 到 [0,1]', () => {
    const extreme = predictFailure({
      caseId: 'x',
      historicalSamples: samples(10, Array.from({ length: 10 }, (_, i) => i)),
      changeImpact: 2,
      modelRisk: -1,
      environmentRisk: 3,
      flakyRate: 0.8,
      defectDensity: 0.5,
    });
    expect(extreme.failureProbability).toBeLessThanOrEqual(1);
    expect(extreme.failureProbability).toBeGreaterThanOrEqual(0);
    expect(extreme.factors.model).toBe(0); // 负值被 clamp 为 0
  });
});

describe('批量预测与执行排序', () => {
  it('按失败概率降序，概率相同按 caseId 字典序，suggestedOrder 从 1 开始', () => {
    const inputs: FailurePredictionInput[] = [
      { caseId: 'a', changeImpact: 0.4, modelRisk: 0.4, riskScore: 0.4, flakyRate: 0.4, defectDensity: 0.4, environmentRisk: 0.4 }, // 0.4*0.7 = 0.28
      { caseId: 'b', changeImpact: 0.4, modelRisk: 0.4, riskScore: 0.4, flakyRate: 0.4, defectDensity: 0.4, environmentRisk: 0.4 }, // 与 a 相同概率
      { caseId: 'c', historicalSamples: samples(30, Array.from({ length: 30 }, (_, i) => i)), changeImpact: 0.9, modelRisk: 0.9, riskScore: 0.9, environmentRisk: 0.9 }, // 最高
      { caseId: 'd' }, // 最低 0
    ];
    const batch = predictFailureBatch(inputs);
    expect(batch.length).toBe(4);
    expect(batch[0].caseId).toBe('c');
    expect(batch[1].caseId).toBe('a'); // 与 b 概率相同 → a 在 b 前
    expect(batch[2].caseId).toBe('b');
    expect(batch[3].caseId).toBe('d');
    expect(batch.map((p) => p.suggestedOrder)).toEqual([1, 2, 3, 4]);
  });

  it('确定性：相同输入两次输出完全一致', () => {
    const input: FailurePredictionInput = {
      caseId: 'det',
      historicalSamples: samples(10, [2, 5, 8]),
      changeImpact: 0.6,
      flakyRate: 0.3,
    };
    const p1 = predictFailure(input);
    const p2 = predictFailure(input);
    expect(p1).toEqual(p2);
  });
});
