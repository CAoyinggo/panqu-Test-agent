// Phase 21.6 Cost Optimization 单元测试
// 覆盖：成本 Schema 校验、LLM 成本估算、台账聚合（Cost/Case、Cost/Feature、
// Cost/Regression、Cost/Defect）、recordLLM 数据通路、持久化、最小成本集合选择。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CostLedger,
  createCostLedger,
  estimateLLMCost,
  normalizeCreateCostInput,
  selectMinimumCostSuite,
  summarizeSuiteSelection,
  DEFAULT_LLM_COST,
  type CostAwareCase,
} from '../../src/cost/index.js';

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `cost-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

describe('cost-schema', () => {
  it('normalizeCreateCostInput：category/amount 校验与默认值', () => {
    expect(() => normalizeCreateCostInput(null)).toThrow();
    expect(() => normalizeCreateCostInput({ category: 'bad', amount: 1 })).toThrow('category 无效');
    expect(() => normalizeCreateCostInput({ category: 'llm', amount: -1 })).toThrow('amount');
    expect(() => normalizeCreateCostInput({ category: 'llm', amount: NaN })).toThrow('amount');

    const norm = normalizeCreateCostInput({ category: 'gpu', amount: 2.5 });
    expect(norm.unit).toBe('credit');
    expect(norm.category).toBe('gpu');
  });

  it('estimateLLMCost：token 折算（与 tracer 默认费率一致）', () => {
    // 1000 in × 0.001 + 1000 out × 0.002 = 0.003
    expect(estimateLLMCost(1000, 1000)).toBeCloseTo(0.003, 6);
    expect(estimateLLMCost(0, 0)).toBe(0);
    expect(estimateLLMCost(2000, 500, { inputPer1k: 0.01, outputPer1k: 0.02 })).toBeCloseTo(0.03, 6);
    expect(DEFAULT_LLM_COST).toEqual({ inputPer1k: 0.001, outputPer1k: 0.002 });
  });
});

describe('CostLedger 记录与聚合', () => {
  it('六类成本记录 + byCategory 汇总', () => {
    const ledger = createCostLedger();
    ledger.record({ category: 'llm', amount: 1, feature: 'wan3' });
    ledger.record({ category: 'environment', amount: 2, feature: 'wan3' });
    ledger.record({ category: 'api', amount: 0.5, feature: 'chat' });
    ledger.record({ category: 'gpu', amount: 4, feature: 'wan3' });
    ledger.record({ category: 'credit', amount: 3, feature: 'chat' });
    ledger.record({ category: 'time', amount: 1.5, feature: 'wan3', unit: 'ms' });

    expect(ledger.total()).toBeCloseTo(12, 6);
    expect(ledger.byCategory()).toEqual({ llm: 1, environment: 2, api: 0.5, gpu: 4, credit: 3, time: 1.5 });
    expect(ledger.list({ category: 'llm' })).toHaveLength(1);
    expect(ledger.list({ feature: 'wan3' })).toHaveLength(4);
  });

  it('Cost/Case、Cost/Feature、Cost/Regression、Cost/Defect 聚合', () => {
    const ledger = createCostLedger();
    ledger.record({ category: 'llm', amount: 1, caseId: 'tc-1', feature: 'wan3', regressionRunId: 'run-1' });
    ledger.record({ category: 'gpu', amount: 2, caseId: 'tc-1', feature: 'wan3', regressionRunId: 'run-1' });
    ledger.record({ category: 'api', amount: 0.5, caseId: 'tc-2', feature: 'chat', regressionRunId: 'run-1' });
    ledger.record({ category: 'time', amount: 1, caseId: 'tc-2', feature: 'chat', regressionRunId: 'run-2' });
    ledger.record({ category: 'llm', amount: 0.8, defectId: 'def-1', feature: 'wan3' });
    ledger.record({ category: 'credit', amount: 0.2, defectId: 'def-1' });

    expect(ledger.costPerCase()).toEqual({ 'tc-1': 3, 'tc-2': 1.5 });
    expect(ledger.costPerFeature()).toEqual({ wan3: 3.8, chat: 1.5 });
    expect(ledger.costPerRegression()).toEqual({ 'run-1': 3.5, 'run-2': 1 });
    expect(ledger.costPerDefect()).toEqual({ 'def-1': 1 });

    const summary = ledger.summarize();
    expect(summary.total).toBeCloseTo(5.5, 6);
    expect(summary.recordCount).toBe(6);
    expect(summary.costPerCase['tc-1']).toBe(3);
  });

  it('recordLLM：token → 成本入账（补齐 tracer 成本通路）', () => {
    const ledger = createCostLedger();
    const record = ledger.recordLLM({ feature: 'wan3', caseId: 'tc-1' }, 1000, 1000);
    expect(record.category).toBe('llm');
    expect(record.amount).toBeCloseTo(0.003, 6);
    expect(record.quantity).toBe(2000);
    expect(ledger.costPerCase()['tc-1']).toBeCloseTo(0.003, 6);
  });

  it('save/load 往返一致；损坏文件降级为空', () => {
    const file = tmpFile('ledger.json');
    const ledger = createCostLedger();
    ledger.record({ category: 'llm', amount: 1, feature: 'wan3' });
    ledger.save(file);

    const loaded = CostLedger.load(file);
    expect(loaded.total()).toBe(1);
    expect(loaded.costPerFeature()).toEqual({ wan3: 1 });

    const bad = tmpFile('bad.json');
    fs.writeFileSync(bad, '{invalid', 'utf-8');
    expect(CostLedger.load(bad).total()).toBe(0);
    expect(CostLedger.load(tmpFile('missing.json')).total()).toBe(0);
  });
});

describe('selectMinimumCostSuite 最小成本集合', () => {
  const universe = {
    coverageItems: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'],
    riskItems: ['r1', 'r2'],
  };

  it('P0 必选 + 风险 100% + Coverage ≥90%，且总成本最小（性价比贪心）', () => {
    const candidates: CostAwareCase[] = [
      { id: 'p0-1', cost: 1, priority: 'P0', coverageItems: ['c1'] },
      // 高性价比：一条覆盖 5 个覆盖项
      { id: 'big', cost: 2, coverageItems: ['c2', 'c3', 'c4', 'c5', 'c6'] },
      // 低性价比：同样 5 项但更贵
      { id: 'expensive', cost: 10, coverageItems: ['c2', 'c3', 'c4', 'c5', 'c6'] },
      { id: 'mid', cost: 1, coverageItems: ['c7', 'c8', 'c9'] },
      { id: 'risk-a', cost: 1, riskItems: ['r1'], coverageItems: ['c10'] },
      { id: 'risk-b', cost: 5, riskItems: ['r1', 'r2'] },
      { id: 'risk-c', cost: 1, riskItems: ['r2'] },
      { id: 'idle', cost: 1, coverageItems: [] },
    ];

    const result = selectMinimumCostSuite(candidates, universe);
    expect(result.feasible).toBe(true);
    // P0 必选
    expect(result.selectedIds).toContain('p0-1');
    // 风险 100%：r1+r2 用 risk-a + risk-c（成本 2）而非 risk-b（成本 5）
    expect(result.selectedIds).toContain('risk-a');
    expect(result.selectedIds).toContain('risk-c');
    expect(result.selectedIds).not.toContain('risk-b');
    // 覆盖率：选 big（5 项，性价比高于 expensive）+ mid（3 项）→ c1..c10 全覆盖
    expect(result.selectedIds).toContain('big');
    expect(result.selectedIds).not.toContain('expensive');
    expect(result.selectedIds).toContain('mid');
    // 无用例覆盖的 idle 不入选
    expect(result.selectedIds).not.toContain('idle');
    expect(result.coverage).toBeGreaterThanOrEqual(0.9);
    expect(result.riskCoverage).toBe(1);
    expect(result.p0Coverage).toBe(1);
    // 总成本 = 1(p0) + 2(big) + 1(mid) + 1(risk-a) + 1(risk-c) = 6
    expect(result.totalCost).toBe(6);
    expect(summarizeSuiteSelection(result, candidates.length)).toContain('精简');
  });

  it('Coverage 刚好达标即停止（不多选）', () => {
    const candidates: CostAwareCase[] = [
      { id: 'a', cost: 1, coverageItems: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'] },
      { id: 'b', cost: 1, coverageItems: ['c10'] },
    ];
    const result = selectMinimumCostSuite(candidates, { coverageItems: universe.coverageItems, riskItems: [] });
    // 9/10 = 90% 达标 → 只选 a
    expect(result.feasible).toBe(true);
    expect(result.selectedIds).toEqual(['a']);
    expect(result.coverage).toBe(0.9);
    expect(result.totalCost).toBe(1);
  });

  it('风险项无候选覆盖 → 不可行', () => {
    const candidates: CostAwareCase[] = [
      { id: 'a', cost: 1, coverageItems: universe.coverageItems, riskItems: ['r1'] },
    ];
    const result = selectMinimumCostSuite(candidates, universe);
    expect(result.feasible).toBe(false);
    expect(result.riskCoverage).toBe(0.5);
    expect(result.reasons.some((r) => r.includes('r2'))).toBe(true);
  });

  it('覆盖项不足 → 不可行并说明当前覆盖率', () => {
    const candidates: CostAwareCase[] = [
      { id: 'a', cost: 1, coverageItems: ['c1', 'c2'], riskItems: ['r1', 'r2'] },
    ];
    const result = selectMinimumCostSuite(candidates, universe);
    expect(result.feasible).toBe(false);
    expect(result.coverage).toBe(0.2);
    expect(result.reasons.some((r) => r.includes('覆盖率无法达到'))).toBe(true);
  });

  it('空全集视为已满足；确定性（多次运行结果一致）', () => {
    const candidates: CostAwareCase[] = [{ id: 'x', cost: 1, priority: 'P0' }];
    const result = selectMinimumCostSuite(candidates, { coverageItems: [], riskItems: [] });
    expect(result.feasible).toBe(true);
    expect(result.coverage).toBe(1);
    expect(result.riskCoverage).toBe(1);

    const universe2 = { coverageItems: ['c1', 'c2'], riskItems: [] };
    const cs: CostAwareCase[] = [
      { id: 'a', cost: 1, coverageItems: ['c1', 'c2'] },
      { id: 'b', cost: 1, coverageItems: ['c1', 'c2'] },
    ];
    const r1 = selectMinimumCostSuite(cs, universe2);
    const r2 = selectMinimumCostSuite(cs, universe2);
    expect(r1.selectedIds).toEqual(r2.selectedIds);
    expect(r1.selectedIds).toEqual(['a']); // 同分按 id 字典序
  });
});
