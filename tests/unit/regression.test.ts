// 单元测试：持续回归（Phase 21.3 Continuous Regression）
// 覆盖：回归计划（不执行全量）/ 历史与趋势 / 调度器端到端 / runId 资产串联
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestAssetStore, type TestAssetStore } from '../../src/test-assets/index.js';
import { createBusinessRegistry, loadBuiltinBusinesses } from '../../src/business/index.js';
import {
  RegressionHistory,
  assetPriority,
  createRegressionHistory,
  createRegressionScheduler,
  planRegression,
  summarizePlan,
  type ChangeEvent,
} from '../../src/regression/index.js';

/** 构造带优先级的用例资产库 */
function buildStore(): TestAssetStore {
  const store = createTestAssetStore();
  store.create({ id: 'tc-p0-1', type: 'test-case', feature: 'wan3', tags: ['text-to-video'], content: { priority: 'P0' } });
  store.create({ id: 'tc-p1-1', type: 'test-case', feature: 'wan3', tags: ['text-to-video'], content: { priority: 'P1' } });
  store.create({ id: 'tc-p2-1', type: 'test-case', feature: 'wan3', tags: ['text-to-video'], content: { priority: 'P2' } });
  store.create({ id: 'tc-p2-2', type: 'test-case', feature: 'wan3', tags: ['text-to-video'], content: { priority: 'P2' } });
  store.create({ id: 'tc-p3-1', type: 'test-case', feature: 'wan3', tags: ['text-to-video'], content: { priority: 'P3' } });
  store.create({ id: 'tc-other', type: 'test-case', feature: 'image-generation', tags: ['text-to-image'], content: { priority: 'P0' } });
  return store;
}

function wan3Change(): ChangeEvent {
  return { type: 'model', target: 'wan3/text-to-video', at: 'now' };
}

describe('regression - 计划器（不执行全量 Case）', () => {
  it('assetPriority：content > tags > 默认 P2', () => {
    const store = buildStore();
    expect(assetPriority(store.get('tc-p0-1')!)).toBe('P0');
    expect(assetPriority(store.create({ id: 'tc-tag', type: 'test-case', feature: 'x', tags: ['P1'] }))).toBe('P1');
    expect(assetPriority(store.create({ id: 'tc-none', type: 'test-case', feature: 'x', tags: [] }))).toBe('P2');
  });

  it('仅选择受影响用例：未受影响与 P3 被跳过', () => {
    const store = buildStore();
    const registry = createBusinessRegistry();
    loadBuiltinBusinesses(registry);
    const scheduler = createRegressionScheduler(store, createRegressionHistory(), registry);
    const plan = scheduler.trigger(wan3Change(), 'model-release');

    const summary = summarizePlan(plan);
    expect(plan.selected.p0).toEqual(['tc-p0-1']);
    expect(plan.selected.p1).toEqual(['tc-p1-1']);
    expect(plan.selected.p2).toEqual(['tc-p2-1', 'tc-p2-2']);
    expect(summary.skipped).toBe(2); // tc-p3-1 + tc-other
    expect(plan.skipped.map((s) => s.id)).toEqual(expect.arrayContaining(['tc-p3-1', 'tc-other']));
    expect(plan.skipped.find((s) => s.id === 'tc-other')?.reason).toContain('未受本次变更影响');
    expect(plan.runId).toMatch(/^run-/);
    expect(plan.trigger).toBe('model-release');
  });

  it('includeP3 开启时 P3 进入计划', () => {
    const store = buildStore();
    const registry = createBusinessRegistry();
    loadBuiltinBusinesses(registry);
    const scheduler = createRegressionScheduler(store, createRegressionHistory(), registry);
    const plan = scheduler.trigger(wan3Change(), 'manual', { includeP3: true });
    expect(plan.selected.p2).toContain('tc-p3-1');
  });

  it('预算裁剪：maxCases 超出时从 P2 裁剪且保 P0/P1', () => {
    const store = buildStore();
    const registry = createBusinessRegistry();
    loadBuiltinBusinesses(registry);
    const scheduler = createRegressionScheduler(store, createRegressionHistory(), registry);
    const plan = scheduler.trigger(wan3Change(), 'pr', { maxCases: 3 });
    const summary = summarizePlan(plan);
    expect(summary.total).toBe(3);
    expect(plan.selected.p0).toHaveLength(1);
    expect(plan.selected.p1).toHaveLength(1);
    expect(plan.selected.p2).toHaveLength(1);
    expect(plan.skipped.some((s) => s.reason.includes('预算裁剪'))).toBe(true);
  });

  it('planRegression 直接调用：空影响 → 全部跳过', () => {
    const store = buildStore();
    const plan = planRegression(
      { change: wan3Change(), affectedBusinesses: [], affectedCapabilities: [], affectedCases: [], affectedRisks: [], reasons: [] },
      store.query({ type: 'test-case' }),
      'manual',
    );
    expect(summarizePlan(plan).total).toBe(0);
    expect(plan.skipped.length).toBe(6);
  });
});

describe('regression - 历史与趋势', () => {
  function makeRun(runId: string, status: 'PASS' | 'FAIL', passRate: number, at: string) {
    return {
      runId, feature: 'wan3', trigger: 'schedule' as const, caseIds: ['tc-p0-1'],
      status, passRate, failures: [], startedAt: at, finishedAt: at, durationMs: 100,
    };
  }

  it('record / get / query / trend', () => {
    const history = createRegressionHistory();
    history.record(makeRun('run-1', 'PASS', 1, '2026-08-16T01:00:00Z'));
    history.record(makeRun('run-2', 'FAIL', 0.5, '2026-08-17T01:00:00Z'));
    history.record(makeRun('run-3', 'PASS', 1, '2026-08-18T01:00:00Z'));
    expect(history.size()).toBe(3);
    expect(history.get('run-2')?.status).toBe('FAIL');
    expect(history.query({ status: 'PASS' })).toHaveLength(2);
    expect(history.query({ limit: 1 })[0].runId).toBe('run-3'); // 时间倒序
    const trend = history.trend('wan3');
    expect(trend.runs).toBe(3);
    expect(trend.passRate).toBeCloseTo((1 + 0.5 + 1) / 3, 2);
    expect(trend.statusCounts).toEqual({ PASS: 2, FAIL: 1 });
  });

  it('record 幂等（runId 覆盖）', () => {
    const history = createRegressionHistory();
    history.record(makeRun('run-1', 'FAIL', 0, '2026-08-18T01:00:00Z'));
    history.record(makeRun('run-1', 'PASS', 1, '2026-08-18T02:00:00Z'));
    expect(history.size()).toBe(1);
    expect(history.get('run-1')?.status).toBe('PASS');
  });

  it('save / load 往返一致，损坏文件降级空历史', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
    const file = path.join(dir, 'history.json');
    const history = createRegressionHistory();
    history.record(makeRun('run-1', 'PASS', 1, '2026-08-18T01:00:00Z'));
    history.save(file);
    expect(RegressionHistory.load(file).size()).toBe(1);
    fs.writeFileSync(file, '{bad');
    expect(RegressionHistory.load(file).size()).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('regression - 调度器端到端与 runId 串联', () => {
  it('trigger → completeRun：执行资产落库且 case/失败链路可追踪', () => {
    const store = buildStore();
    const registry = createBusinessRegistry();
    loadBuiltinBusinesses(registry);
    const history = createRegressionHistory();
    const scheduler = createRegressionScheduler(store, history, registry);

    const plan = scheduler.trigger(wan3Change(), 'model-release');
    // 预置 RCA / Defect 资产（模拟分析阶段产物）
    store.create({ id: 'rca-100', type: 'rca', feature: 'wan3', content: { category: 'MODEL_ERROR' } });
    store.create({ id: 'def-100', type: 'defect', feature: 'wan3', status: 'DRAFT' });

    const run = scheduler.completeRun(plan, 'wan3', {
      status: 'FAIL',
      passRate: 0.75,
      failures: [{ caseId: 'tc-p0-1', rcaId: 'rca-100', defectId: 'def-100' }],
      taskId: 'task-1',
      durationMs: 1200,
    });

    // 历史记录
    expect(history.get(plan.runId)?.status).toBe('FAIL');
    expect(history.failureChain(plan.runId)[0].rcaId).toBe('rca-100');

    // runId 资产串联：execution 资产 + case→exec→rca→defect 链路
    const execId = `exec-${plan.runId}`;
    const execAsset = store.get(execId);
    expect(execAsset?.metadata?.runId).toBe(plan.runId);
    expect(store.linksOf('tc-p0-1').some((l) => l.to === execId && l.relation === 'executes')).toBe(true);
    const chain = store.trace('tc-p0-1');
    expect(chain.downstream).toEqual(expect.arrayContaining([execId, 'rca-100', 'def-100']));

    // runId 找回完整失败链路
    expect(run.caseIds).toEqual(expect.arrayContaining(['tc-p0-1', 'tc-p1-1']));
  });

  it('completeRun 幂等：同 runId 重复完成不重复建资产', () => {
    const store = buildStore();
    const history = createRegressionHistory();
    const scheduler = createRegressionScheduler(store, history);
    const plan = scheduler.trigger({ type: 'config', target: 'x', businessId: undefined }, 'manual');
    scheduler.completeRun(plan, 'wan3', { status: 'PASS', passRate: 1 });
    const sizeAfterFirst = store.size();
    scheduler.completeRun(plan, 'wan3', { status: 'PASS', passRate: 1 });
    expect(store.size()).toBe(sizeAfterFirst);
    expect(history.size()).toBe(1);
  });
});
