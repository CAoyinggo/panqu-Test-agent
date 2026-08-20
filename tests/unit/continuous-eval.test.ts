// Phase 48 / 43.20：Continuous Evaluation 单元测试
// 覆盖：首次运行记录基线不判回归 / 无回归 PASS / Critical Regression → BLOCK + Alert + BlockRelease /
//  Overall 下降 → REVIEW / 定向领域 / Store 排序·快照·导入 / Service 集成（审计 + 持久化）
import { describe, it, expect } from 'vitest';
import { ContinuousEvalStore, runContinuousEvaluation, CONTINUOUS_EVAL_SCHEDULES } from '../../src/ai-quality/continuous-eval.js';
import { AIQualityService, createAIQualityService } from '../../src/ai-quality/service.js';
import type { ContinuousEvalRun } from '../../src/ai-quality/continuous-eval.js';
import type { EvalReport } from '../../src/eval/runner.js';

/** 构造确定性 EvalReport（供回归场景模拟；生产一律走 runAllEvaluation 不虚构） */
function mockReport(overall: number, critical: { p0Miss: number; falsePass: number; unsafeHealing: number; skippedCritical: number }, domains: string[] = ['REQUIREMENT', 'TEST_DESIGN', 'RISK', 'SELECTION', 'RCA', 'DEFECT', 'HEALING', 'RELEASE']): EvalReport {
  return {
    version: '4.23.0',
    generatedAt: '2026-08-20T00:00:00.000Z',
    versionInfo: { model: 'rules', modelVersion: '1.0.0', promptVersion: 'n/a', toolVersion: 'eval-tool-v1', agentVersion: 'eval-agent-v1' },
    domains: domains.map((d) => ({
      domain: d as never,
      label: d,
      benchmark: `${d}_BENCHMARK_v1`,
      benchmarkVersion: 'v1',
      total: 30, tracked: 30, untracked: 0, passed: 27,
      score: overall,
      metrics: {},
      failures: [],
      results: [],
      cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 10, cost: 0.001 },
    })),
    overall,
    critical,
    cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 80, cost: 0.008 },
  };
}

/** 注入一条基线运行（其 current 作为下一次判定的 baseline） */
function seedBaseline(store: ContinuousEvalStore, current: { overall: number; critical: { p0Miss: number; falsePass: number; unsafeHealing: number; skippedCritical: number } }): ContinuousEvalRun {
  return store.add({
    schedule: 'NIGHTLY',
    triggeredBy: 'MANUAL',
    baseline: { overall: 0.936, critical: { p0Miss: 0, falsePass: 0, unsafeHealing: 0, skippedCritical: 0 } },
    current,
    domains: {},
    cost: 0,
    latencyMs: 0,
    regression: { regression: false, criticalRegression: false, reasons: [], verdict: 'PASS' },
    alertSent: false,
    releaseBlocked: false,
    reportVersion: '4.23.0',
    domainCount: 8,
    createdBy: 'test',
  });
}

const CLEAN = { p0Miss: 0, falsePass: 0, unsafeHealing: 0, skippedCritical: 0 };

describe('Continuous Evaluation（43.20）', () => {
  it('首次运行：只记录基线，不判回归（verdict PASS）', () => {
    const store = new ContinuousEvalStore();
    const run = runContinuousEvaluation({ schedule: 'NIGHTLY', triggeredBy: 'MANUAL', createdBy: 'tester' }, { store });
    expect(run.schedule).toBe('NIGHTLY');
    expect(run.triggeredBy).toBe('MANUAL');
    expect(run.regression.regression).toBe(false);
    expect(run.regression.verdict).toBe('PASS');
    expect(run.alertSent).toBe(false);
    expect(run.releaseBlocked).toBe(false);
    expect(run.baseline.overall).toBe(run.current.overall);
    expect(run.current.overall).toBeGreaterThan(0);
    expect(run.domainCount).toBe(8);
    expect(run.domains['RISK']).toBeGreaterThan(0);
    expect(store.size()).toBe(1);
  });

  it('连续运行：真实 Benchmark 确定性，无回归 → PASS', () => {
    const store = new ContinuousEvalStore();
    runContinuousEvaluation({ schedule: 'NIGHTLY' }, { store });
    const second = runContinuousEvaluation({ schedule: 'NIGHTLY' }, { store });
    expect(second.regression.regression).toBe(false);
    expect(second.regression.verdict).toBe('PASS');
    expect(second.alertSent).toBe(false);
    expect(second.releaseBlocked).toBe(false);
    expect(second.current.overall).toBeCloseTo(second.baseline.overall, 4);
    expect(store.size()).toBe(2);
  });

  it('Critical Regression（P0 Miss 0→1）：BLOCK + Alert + BlockRelease', () => {
    const store = new ContinuousEvalStore();
    seedBaseline(store, { overall: 0.936, critical: CLEAN });
    const run = runContinuousEvaluation(
      { schedule: 'RELEASE', triggeredBy: 'RELEASE_GATE' },
      { store, report: mockReport(0.936, { ...CLEAN, p0Miss: 1 }) },
    );
    expect(run.regression.regression).toBe(true);
    expect(run.regression.criticalRegression).toBe(true);
    expect(run.regression.verdict).toBe('BLOCK');
    expect(run.alertSent).toBe(true);
    expect(run.releaseBlocked).toBe(true);
    expect(run.regression.reasons.join(' ')).toContain('P0 Miss 上升');
  });

  it('Critical Regression（False Pass 0→1）：BLOCK（发布门禁联动）', () => {
    const store = new ContinuousEvalStore();
    seedBaseline(store, { overall: 0.936, critical: CLEAN });
    const run = runContinuousEvaluation(
      { schedule: 'NIGHTLY' },
      { store, report: mockReport(0.936, { ...CLEAN, falsePass: 1 }) },
    );
    expect(run.regression.verdict).toBe('BLOCK');
    expect(run.releaseBlocked).toBe(true);
  });

  it('普通指标下降（Overall -5% 无关键上升）：REVIEW，不 Block Release', () => {
    const store = new ContinuousEvalStore();
    seedBaseline(store, { overall: 0.936, critical: CLEAN });
    const run = runContinuousEvaluation(
      { schedule: 'WEEKLY' },
      { store, report: mockReport(0.88, CLEAN) },
    );
    expect(run.regression.regression).toBe(true);
    expect(run.regression.criticalRegression).toBe(false);
    expect(run.regression.verdict).toBe('REVIEW');
    expect(run.alertSent).toBe(false);
    expect(run.releaseBlocked).toBe(false);
  });

  it('无回归且关键指标持平：PASS，不 Alert', () => {
    const store = new ContinuousEvalStore();
    seedBaseline(store, { overall: 0.936, critical: CLEAN });
    const run = runContinuousEvaluation(
      { schedule: 'NIGHTLY' },
      { store, report: mockReport(0.936, CLEAN) },
    );
    expect(run.regression.verdict).toBe('PASS');
    expect(run.alertSent).toBe(false);
  });

  it('定向领域（Targeted Evaluation）：只评测指定领域，domainCount < 8', () => {
    const store = new ContinuousEvalStore();
    const run = runContinuousEvaluation(
      { schedule: 'WEEKLY', domains: ['RISK', 'RCA'] },
      { store, report: mockReport(0.9, CLEAN, ['RISK', 'RCA']) },
    );
    expect(run.domainCount).toBe(2);
    expect(Object.keys(run.domains).sort()).toEqual(['RCA', 'RISK']);
  });

  it('Store：latest / 按 schedule 过滤 / snapshot 与 import 往返', () => {
    const store = new ContinuousEvalStore();
    runContinuousEvaluation({ schedule: 'NIGHTLY' }, { store });
    const weekly = runContinuousEvaluation({ schedule: 'WEEKLY' }, { store });
    runContinuousEvaluation({ schedule: 'RELEASE' }, { store });

    const weeklyList = store.list({ schedule: 'WEEKLY' });
    expect(weeklyList.length).toBe(1);
    expect(weeklyList[0].id).toBe(weekly.id);
    const all = store.list();
    expect(all[0].createdAt >= all[all.length - 1].createdAt).toBe(true);

    const restored = ContinuousEvalStore.import(store.snapshot());
    expect(restored.size()).toBe(store.size());
    expect(restored.list()[0].id).toBe(all[0].id);
  });

  it('调度常量：NIGHTLY / WEEKLY / RELEASE 与 cronLike', () => {
    expect(CONTINUOUS_EVAL_SCHEDULES.map((s) => s.name)).toEqual(['nightly', 'weekly', 'release']);
    expect(CONTINUOUS_EVAL_SCHEDULES[0].cronLike).toMatch(/^\d+ \d+ \* \* \*/);
  });
});

describe('AIQualityService.runContinuousEval（集成）', () => {
  it('运行一次并记录审计 + 快照/恢复保留历史', () => {
    const svc = createAIQualityService();
    const run = svc.runContinuousEval({ schedule: 'NIGHTLY', triggeredBy: 'MANUAL', createdBy: 'tester' });
    expect(run.regression.verdict).toBe('PASS');
    expect(svc.continuousEval.size()).toBe(1);
    expect(svc.audit.size()).toBe(1);
    const audit = svc.audit.list()[0];
    expect(audit.decision).toContain('Continuous Evaluation');
    expect(audit.metrics?.overall).toBe(run.current.overall);

    const restored = AIQualityService.restore(svc.snapshot());
    expect(restored.continuousEval.size()).toBe(1);
    expect(restored.continuousEval.list()[0].id).toBe(run.id);
  });

  it('RELEASE 门禁触发：releaseBlocked 与 verdict 一致', () => {
    const svc = createAIQualityService();
    const run = svc.runContinuousEval({ schedule: 'RELEASE', triggeredBy: 'RELEASE_GATE' });
    expect(run.schedule).toBe('RELEASE');
    expect(run.triggeredBy).toBe('RELEASE_GATE');
    expect(run.releaseBlocked).toBe(run.regression.verdict === 'BLOCK');
  });
});
