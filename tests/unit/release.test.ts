// Phase 21.8 Production Operations 单元测试
// 覆盖：Release Gate（P0=PASS / P1≥98% / Coverage≥90% / Critical Defect=0）、
// 统一运维视图聚合（状态判定 + 关注项）、HTML 渲染、Model Evaluation 横向对比。

import { describe, it, expect } from 'vitest';
import {
  evaluateReleaseGate,
  buildOperationsView,
  renderOperationsHtml,
  compareModels,
  type OperationsInput,
  type ModelRunResult,
} from '../../src/operations/index.js';

describe('evaluateReleaseGate 发布门禁', () => {
  const good = { p0: { total: 5, passed: 5 }, p1: { total: 100, passed: 99 }, coverage: 0.95, criticalDefects: 0 };

  it('全部达标 → RELEASE=PASS', () => {
    const result = evaluateReleaseGate(good);
    expect(result.release).toBe('PASS');
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every((c) => c.pass)).toBe(true);
    expect(result.blockReasons).toEqual([]);
  });

  it('P0 有失败 → BLOCK', () => {
    const result = evaluateReleaseGate({ ...good, p0: { total: 5, passed: 4 } });
    expect(result.release).toBe('BLOCK');
    expect(result.blockReasons.some((r) => r.includes('P0'))).toBe(true);
  });

  it('P1 通过率 < 98% → BLOCK', () => {
    const result = evaluateReleaseGate({ ...good, p1: { total: 100, passed: 97 } });
    expect(result.release).toBe('BLOCK');
    expect(result.blockReasons.some((r) => r.includes('P1'))).toBe(true);
    // 恰好 98% → PASS
    expect(evaluateReleaseGate({ ...good, p1: { total: 100, passed: 98 } }).release).toBe('PASS');
  });

  it('Coverage < 90% → BLOCK', () => {
    const result = evaluateReleaseGate({ ...good, coverage: 0.85 });
    expect(result.release).toBe('BLOCK');
    expect(result.blockReasons.some((r) => r.includes('Coverage'))).toBe(true);
  });

  it('Critical Defect > 0 → BLOCK；多项不满足全部列出', () => {
    const result = evaluateReleaseGate({ ...good, criticalDefects: 2, coverage: 0.5 });
    expect(result.release).toBe('BLOCK');
    expect(result.blockReasons).toHaveLength(2);
    expect(result.summary).toContain('RELEASE=BLOCK');
  });

  it('自定义阈值；P0/P1 无用例时因缺少执行证据而阻断', () => {
    const result = evaluateReleaseGate({
      p0: { total: 0, passed: 0 },
      p1: { total: 0, passed: 0 },
      coverage: 0.5,
      criticalDefects: 0,
      thresholds: { minCoverage: 0.5, p1PassRate: 0.9 },
    });
    expect(result.release).toBe('BLOCK');
  });
});

describe('buildOperationsView 运维视图', () => {
  it('HEALTHY：无缺陷无隔离', () => {
    const view = buildOperationsView({
      health: { ok: true, checks: [{ name: '配置加载', ok: true }] },
      runs: [{ runId: 'run-1', feature: 'wan3', total: 10, passed: 10, failed: 0 }],
    });
    expect(view.status).toBe('HEALTHY');
    expect(view.runs.passRate).toBe(1);
    expect(view.highlights).toEqual([]);
    expect(view.summary).toContain('HEALTHY');
  });

  it('DEGRADED：存在开放缺陷或隔离用例', () => {
    const view = buildOperationsView({
      runs: [{ runId: 'run-1', feature: 'wan3', total: 10, passed: 9, failed: 1 }],
      defects: { total: 3, open: 2, critical: 0 },
      flaky: { byStatus: { QUARANTINED: 1 }, quarantineIds: ['tc-9'] },
    });
    expect(view.status).toBe('DEGRADED');
    expect(view.highlights.some((h) => h.includes('开放缺陷 2'))).toBe(true);
    expect(view.highlights.some((h) => h.includes('tc-9'))).toBe(true);
    expect(view.flaky.quarantined).toBe(1);
  });

  it('CRITICAL：健康检查失败或通过率过低；关注项分级', () => {
    const view = buildOperationsView({
      health: { ok: false, checks: [{ name: 'LLM 往返', ok: false, detail: '超时' }] },
      runs: [{ runId: 'run-1', feature: 'wan3', total: 10, passed: 2, failed: 8 }],
      defects: { total: 1, open: 1, critical: 1 },
      coverage: { requirement: 0.8 },
      quality: [{ feature: 'wan3', score: 55, grade: 'F' }],
    });
    expect(view.status).toBe('CRITICAL');
    expect(view.highlights[0]).toContain('[CRITICAL]');
    expect(view.highlights.some((h) => h.includes('严重缺陷'))).toBe(true);
    expect(view.highlights.some((h) => h.includes('requirement'))).toBe(true);
    expect(view.highlights.some((h) => h.includes('wan3 55'))).toBe(true);
  });

  it('自愈恢复率计算；空输入安全', () => {
    const view = buildOperationsView({ healing: { suggestions: 5, applied: 2, recovered: 2 } });
    expect(view.healing.recoveryRate).toBe(1);
    const empty = buildOperationsView({});
    expect(empty.status).toBe('HEALTHY');
    expect(empty.runs.passRate).toBe(1);
  });
});

describe('renderOperationsHtml', () => {
  it('输出自包含 HTML：状态徽章 / 各分区 / HTML 转义', () => {
    const view = buildOperationsView({
      runs: [{ runId: 'run-<1>', feature: 'wan3', total: 2, passed: 2, failed: 0 }],
      quality: [{ feature: 'wan3', score: 92, grade: 'A' }],
    });
    const html = renderOperationsHtml(view);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('HEALTHY');
    expect(html).toContain('AI Test Operations Dashboard');
    expect(html).toContain('Noto Sans CJK SC');
    expect(html).toContain('run-&lt;1&gt;'); // 转义
    expect(html).not.toContain('run-<1>');
    expect(html).toContain('92');
  });
});

describe('compareModels 模型横向对比', () => {
  const results: ModelRunResult[] = [
    { model: 'modelA', qualityScore: 90, latencyMs: 1000, cost: 10, total: 20, passed: 18, failed: 2 },
    { model: 'modelB', qualityScore: 80, latencyMs: 500, cost: 20, total: 20, passed: 19, failed: 1 },
    { model: 'modelC', qualityScore: 70, latencyMs: 2000, cost: 5, total: 20, passed: 15, failed: 5 },
  ];

  it('四维归一化 + 等权综合，输出排名与冠军', () => {
    const cmp = compareModels(results);
    expect(cmp.rows).toHaveLength(3);
    expect(cmp.rows[0].rank).toBe(1);
    // 各维度最优：quality=A，latency=B，cost=C，failure=B
    expect(cmp.bestPerDimension).toEqual({ quality: 'modelA', latency: 'modelB', cost: 'modelC', failure: 'modelB' });
    // modelA：1 + 0.5 + 0.5 + 0.5 = 2.5/4 → 62.5
    const a = cmp.rows.find((r) => r.model === 'modelA')!;
    expect(a.composite).toBe(62.5);
    // modelB：0.889 + 1 + 0.25 + 1 → 78.5
    const b = cmp.rows.find((r) => r.model === 'modelB')!;
    expect(b.composite).toBeGreaterThan(a.composite);
    expect(cmp.winner).toBe('modelB');
    expect(cmp.summary).toContain('modelB');
  });

  it('排名按综合分降序；空输入安全；确定性', () => {
    const cmp = compareModels(results);
    const ranks = cmp.rows.map((r) => `${r.model}#${r.rank}`);
    const cmp2 = compareModels(results);
    expect(cmp2.rows.map((r) => `${r.model}#${r.rank}`)).toEqual(ranks);

    const empty = compareModels([]);
    expect(empty.winner).toBeNull();
    expect(empty.summary).toBe('无对比数据');
  });

  it('并列时按模型名字典序；零值边界安全', () => {
    const tie: ModelRunResult[] = [
      { model: 'zeta', qualityScore: 80, latencyMs: 100, cost: 5, total: 10, passed: 10, failed: 0 },
      { model: 'alpha', qualityScore: 80, latencyMs: 100, cost: 5, total: 10, passed: 10, failed: 0 },
    ];
    const cmp = compareModels(tie);
    expect(cmp.rows[0].model).toBe('alpha');
    expect(cmp.winner).toBe('alpha');
    // 全并列归一为 1 → 综合 100
    expect(cmp.rows[0].composite).toBe(100);

    const zeros: ModelRunResult[] = [
      { model: 'm1', qualityScore: 0, latencyMs: 0, cost: 0, total: 0, passed: 0, failed: 0 },
    ];
    expect(() => compareModels(zeros)).not.toThrow();
    expect(compareModels(zeros).rows[0].composite).toBe(100);
  });
});
