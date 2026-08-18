// 单元测试：Change Impact Analysis 变更影响分析（Phase 21.3）
import { describe, it, expect } from 'vitest';
import { createTestAssetStore, type TestAssetStore } from '../../src/test-assets/index.js';
import { createBusinessRegistry, loadBuiltinBusinesses, type BusinessRegistry } from '../../src/business/index.js';
import {
  analyzeChangeImpact,
  generateRunId,
  normalizeChangeEvent,
  type ChangeEvent,
} from '../../src/regression/index.js';

/** 构造多业务用例资产库 */
function buildStore(): TestAssetStore {
  const store = createTestAssetStore();
  store.create({ id: 'tc-wan3-p0', type: 'test-case', feature: 'wan3', tags: ['P0', 'text-to-video'], content: { priority: 'P0', name: '文生视频正常生成' } });
  store.create({ id: 'tc-wan3-p1', type: 'test-case', feature: 'wan3', tags: ['P1', 'image-to-video'], content: { priority: 'P1', name: '图生视频正常生成' } });
  store.create({ id: 'tc-wan3-p2', type: 'test-case', feature: 'wan3', tags: ['P2', 'billing'], content: { priority: 'P2', name: '积分扣除校验' } });
  store.create({ id: 'tc-img-p0', type: 'test-case', feature: 'image-generation', tags: ['P0', 'text-to-image'], content: { priority: 'P0', name: '文生图正常生成' } });
  store.create({ id: 'tc-archived', type: 'test-case', feature: 'wan3', tags: ['P0'], content: { priority: 'P0' } });
  store.archive('tc-archived');
  return store;
}

function buildRegistry(): BusinessRegistry {
  const registry = createBusinessRegistry();
  loadBuiltinBusinesses(registry);
  return registry;
}

describe('impact - ChangeEvent 校验与 runId', () => {
  it('合法变更事件归一化', () => {
    const event = normalizeChangeEvent({ type: 'model', target: 'Model A', from: 'v1', to: 'v2' });
    expect(event.type).toBe('model');
    expect(event.target).toBe('Model A');
    expect(event.at).toBeTruthy();
  });

  it('非法 type / 缺 target / 非对象抛错', () => {
    expect(() => normalizeChangeEvent({ type: 'bad', target: 'x' })).toThrow('type 无效');
    expect(() => normalizeChangeEvent({ type: 'code' })).toThrow('缺少 target');
    expect(() => normalizeChangeEvent(null)).toThrow('必须为对象');
  });

  it('generateRunId 唯一且带日期前缀', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateRunId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^run-\d{8}-/);
  });
});

describe('impact - 影响分析', () => {
  it('模型变化：定位业务与受影响用例', () => {
    const change: ChangeEvent = { type: 'model', target: 'wan3/text-to-video', from: 'Model A', to: 'Model B', at: 'now' };
    const impact = analyzeChangeImpact(change, buildStore(), buildRegistry());
    expect(impact.affectedBusinesses).toContain('wan3');
    expect(impact.affectedCases).toEqual(expect.arrayContaining(['tc-wan3-p0', 'tc-wan3-p1', 'tc-wan3-p2']));
    expect(impact.affectedCases).not.toContain('tc-img-p0');
    expect(impact.affectedRisks.some((r) => r.includes('生成质量'))).toBe(true);
    expect(impact.reasons.length).toBeGreaterThan(0);
  });

  it('归档用例不进入受影响集合', () => {
    const change: ChangeEvent = { type: 'model', target: 'wan3', at: 'now' };
    const impact = analyzeChangeImpact(change, buildStore(), buildRegistry());
    expect(impact.affectedCases).not.toContain('tc-archived');
  });

  it('显式 businessId 直接定位', () => {
    const change: ChangeEvent = { type: 'api', target: 'submit_url', businessId: 'image-generation', at: 'now' };
    const impact = analyzeChangeImpact(change, buildStore(), buildRegistry());
    expect(impact.affectedBusinesses).toEqual(['image-generation']);
    expect(impact.affectedCases).toContain('tc-img-p0');
    expect(impact.affectedCases).not.toContain('tc-wan3-p0');
  });

  it('价格变化提示计费风险', () => {
    const change: ChangeEvent = { type: 'pricing', target: 'wan3', at: 'now' };
    const impact = analyzeChangeImpact(change, buildStore(), buildRegistry());
    expect(impact.affectedRisks.some((r) => r.includes('计费'))).toBe(true);
  });

  it('全局型变更（code）未定位业务时影响全部业务', () => {
    const change: ChangeEvent = { type: 'code', target: 'src/core/engine.ts', at: 'now' };
    const impact = analyzeChangeImpact(change, buildStore(), buildRegistry());
    expect(impact.affectedBusinesses.length).toBeGreaterThan(1);
    expect(impact.affectedCases).toEqual(expect.arrayContaining(['tc-wan3-p0', 'tc-img-p0']));
  });

  it('未知目标且非全局型：无受影响用例', () => {
    const change: ChangeEvent = { type: 'model', target: 'no-such-model', at: 'now' };
    const impact = analyzeChangeImpact(change, buildStore(), buildRegistry());
    expect(impact.affectedCases).toEqual([]);
    expect(impact.affectedBusinesses).toEqual([]);
  });

  it('无注册中心时仅按关键词匹配用例', () => {
    const change: ChangeEvent = { type: 'requirement', target: 'billing', at: 'now' };
    const impact = analyzeChangeImpact(change, buildStore());
    expect(impact.affectedCases).toContain('tc-wan3-p2'); // tags 含 billing
  });
});
