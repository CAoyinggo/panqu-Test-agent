// Phase 21.5 Knowledge Optimization 单元测试
// 覆盖：Schema 校验、去重合并、查询 scope、Ranking、touch、生命周期流转、
// revive、知识参与决策（失败率 → 风险权重 → 优先级提升）、持久化。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KnowledgeStore,
  createKnowledgeStore,
  DEFAULT_LIFECYCLE_CONFIG,
  normalizeCreateKnowledgeInput,
  generateKnowledgeId,
  adviseFromKnowledge,
  failureRateOf,
  boostedTagsFromAdvice,
  PRIORITY_BOOST_THRESHOLD,
  type KnowledgeEntry,
} from '../../src/knowledge/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `knowledge-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

describe('knowledge-schema', () => {
  it('normalizeCreateKnowledgeInput：必填校验与默认值', () => {
    expect(() => normalizeCreateKnowledgeInput(null)).toThrow();
    expect(() => normalizeCreateKnowledgeInput({ type: 'bad', feature: 'f', title: 't' })).toThrow('type 无效');
    expect(() => normalizeCreateKnowledgeInput({ type: 'known-issue', title: 't' })).toThrow('feature');
    expect(() => normalizeCreateKnowledgeInput({ type: 'known-issue', feature: 'f' })).toThrow('title');
    expect(() =>
      normalizeCreateKnowledgeInput({ type: 'known-issue', feature: 'f', title: 't', confidence: 2 }),
    ).toThrow('confidence');

    const norm = normalizeCreateKnowledgeInput({ type: 'risk-insight', feature: 'wan3', title: '1080P 失败率' });
    expect(norm.confidence).toBe(0.5);
    expect(norm.source).toBe('manual');
    expect(norm.tags).toEqual([]);
  });

  it('generateKnowledgeId：带 feature 前缀且唯一', () => {
    const a = generateKnowledgeId('wan3');
    const b = generateKnowledgeId('wan3');
    expect(a).toMatch(/^kb-wan3-\d{4}$/);
    expect(a).not.toBe(b);
  });
});

describe('KnowledgeStore.add 去重合并', () => {
  it('同 feature+type+title 合并：usageCount 累加、confidence 取大、EXPIRED 复活', () => {
    const store = createKnowledgeStore();
    const first = store.add({ type: 'failure-pattern', feature: 'wan3', title: '1080P+10s 超时', confidence: 0.6 });
    expect(first.merged).toBe(false);
    expect(first.entry.usageCount).toBe(0);

    const second = store.add({
      type: 'failure-pattern',
      feature: 'wan3',
      title: '1080P+10s 超时',
      confidence: 0.4,
      tags: ['1080P'],
      stats: { runs: 10, failures: 3 },
    });
    expect(second.merged).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.usageCount).toBe(1);
    expect(second.entry.confidence).toBe(0.6); // 取大
    expect(second.entry.tags).toContain('1080P');
    expect(second.entry.stats).toMatchObject({ runs: 10, failures: 3 });
    expect(store.size()).toBe(1);

    // EXPIRED 复活
    const entry = store.get(first.entry.id)!;
    entry.status = 'EXPIRED';
    const third = store.add({ type: 'failure-pattern', feature: 'wan3', title: '1080P+10s 超时', confidence: 0.9 });
    expect(third.merged).toBe(true);
    expect(third.entry.status).toBe('ACTIVE');
    expect(third.entry.confidence).toBe(0.9);
  });

  it('不同 title 不合并', () => {
    const store = createKnowledgeStore();
    store.add({ type: 'known-issue', feature: 'wan3', title: 'A' });
    store.add({ type: 'known-issue', feature: 'wan3', title: 'B' });
    expect(store.size()).toBe(2);
  });
});

describe('KnowledgeStore.query', () => {
  it('默认仅 ACTIVE；scope=all 含全部；feature/type/tags/text 过滤', () => {
    const store = createKnowledgeStore();
    const a = store.add({ type: 'risk-insight', feature: 'wan3', title: '超时风险', tags: ['timeout'], content: '1080P 高失败率' }).entry;
    const b = store.add({ type: 'known-issue', feature: 'chat', title: '已知问题', tags: ['billing'] }).entry;
    store.get(b.id)!.status = 'STALE';
    const c = store.add({ type: 'environment-fact', feature: 'wan3', title: '环境事实' }).entry;
    store.get(c.id)!.status = 'EXPIRED';

    expect(store.query().map((e) => e.id)).toEqual([a.id]);
    expect(store.query({ scope: 'stale' }).map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
    expect(store.query({ scope: 'all' })).toHaveLength(3);
    expect(store.query({ feature: 'wan3' }).map((e) => e.id)).toEqual([a.id]);
    expect(store.query({ scope: 'all', type: 'known-issue' }).map((e) => e.id)).toEqual([b.id]);
    expect(store.query({ tags: ['timeout'] }).map((e) => e.id)).toEqual([a.id]);
    expect(store.query({ text: '1080p' }).map((e) => e.id)).toEqual([a.id]);
  });
});

describe('KnowledgeStore.rank', () => {
  it('综合得分：confidence × 0.5 + 时效 × 0.3 + 使用频率 × 0.2', () => {
    const store = createKnowledgeStore();
    const now = Date.now();
    const high = store.add({ type: 'risk-insight', feature: 'f', title: '高置信高频', confidence: 0.9 }).entry;
    high.usageCount = 20;
    high.lastUsedAt = new Date(now).toISOString();
    const low = store.add({ type: 'risk-insight', feature: 'f', title: '低置信陈旧', confidence: 0.2 }).entry;
    low.usageCount = 1;
    low.lastUsedAt = new Date(now - 60 * DAY_MS).toISOString();

    const ranked = store.rank([low, high], now);
    expect(ranked[0].id).toBe(high.id);
    expect(ranked[1].id).toBe(low.id);
  });
});

describe('KnowledgeStore.touch', () => {
  it('引用计数 +1、刷新 lastUsedAt、confidence 上限 0.99', () => {
    const store = createKnowledgeStore();
    const { entry } = store.add({ type: 'test-insight', feature: 'f', title: 't', confidence: 0.985 });
    const touched = store.touch(entry.id);
    expect(touched.usageCount).toBe(1);
    expect(touched.lastUsedAt).toBeDefined();
    expect(touched.confidence).toBeLessThanOrEqual(0.99);
    expect(() => store.touch('kb-not-exist')).toThrow();
  });
});

describe('KnowledgeStore.refreshLifecycle', () => {
  it('ACTIVE → STALE（超 staleDays）→ EXPIRED（超 expireDays）', () => {
    const store = new KnowledgeStore({ staleDays: 30, expireDays: 90 });
    const { entry } = store.add({ type: 'known-issue', feature: 'f', title: 'old' });
    const createdAt = new Date(entry.createdAt).getTime();

    // 31 天未引用 → STALE
    const t1 = store.refreshLifecycle(createdAt + 31 * DAY_MS);
    expect(t1).toHaveLength(1);
    expect(t1[0]).toMatchObject({ from: 'ACTIVE', to: 'STALE' });
    expect(store.get(entry.id)!.status).toBe('STALE');

    // 91 天未引用 → EXPIRED
    const t2 = store.refreshLifecycle(createdAt + 91 * DAY_MS);
    expect(t2).toHaveLength(1);
    expect(t2[0]).toMatchObject({ from: 'STALE', to: 'EXPIRED' });
    expect(store.get(entry.id)!.status).toBe('EXPIRED');
  });

  it('已过 validUntil 直接 EXPIRED；revive 手动复活', () => {
    const store = createKnowledgeStore();
    const past = new Date(Date.now() - DAY_MS).toISOString();
    const { entry } = store.add({ type: 'environment-fact', feature: 'f', title: '限时事实', validUntil: past });
    const transitions = store.refreshLifecycle(Date.now());
    expect(transitions.some((t) => t.id === entry.id && t.to === 'EXPIRED' && t.reason.includes('validUntil'))).toBe(true);

    expect(store.revive(entry.id)).toBe(true);
    expect(store.get(entry.id)!.status).toBe('ACTIVE');
    expect(store.revive(entry.id)).toBe(false); // 已 ACTIVE
  });

  it('stats 按状态计数', () => {
    const store = createKnowledgeStore();
    const a = store.add({ type: 'known-issue', feature: 'f', title: 'a' }).entry;
    const b = store.add({ type: 'known-issue', feature: 'f', title: 'b' }).entry;
    store.get(b.id)!.status = 'STALE';
    expect(store.stats()).toEqual({ ACTIVE: 1, STALE: 1 });
    expect(a.id).not.toBe(b.id);
  });
});

describe('Knowledge Advisor：知识真正参与决策', () => {
  it('任务书场景：过去 30 次 1080P+10s 失败率 37% → 提高风险权重与执行优先级', () => {
    const store = createKnowledgeStore();
    const { entry } = store.add({
      type: 'risk-insight',
      feature: 'wan3',
      title: '1080P + 10s 历史失败率 37%',
      confidence: 1,
      tags: ['1080P', '10s'],
      stats: { runs: 30, failures: 11 }, // 11/30 ≈ 36.7%
      source: 'memory',
    });

    const advice = adviseFromKnowledge([entry], { feature: 'wan3', tags: ['1080P', '10s', 'text-to-video'] });
    expect(advice).toHaveLength(1);
    const a = advice[0];
    expect(a.failureRate).toBeCloseTo(11 / 30, 2);
    expect(a.riskWeight).toBeCloseTo((11 / 30) * 1, 2);
    expect(a.priorityBoost).toBe(true); // 失败率 ≥ 20%
    expect(a.matchedTags.sort()).toEqual(['1080P', '10s']);
    expect(a.reason).toContain('提高风险权重');
    expect(a.reason).toContain('执行优先级');

    // 提权标签输出：供用例 P2 → P1
    expect(boostedTagsFromAdvice(advice).sort()).toEqual(['1080P', '10s']);
  });

  it('低失败率不建议提权；无 stats 失败率为 0', () => {
    const low: KnowledgeEntry = {
      id: 'kb-low', type: 'risk-insight', feature: 'wan3', title: '低风险', content: '',
      confidence: 0.9, usageCount: 0, source: 'manual', status: 'ACTIVE', tags: ['720P'],
      stats: { runs: 100, failures: 5 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const noStats: KnowledgeEntry = { ...low, id: 'kb-nostats', title: '无统计', tags: ['4K'], stats: undefined };
    const advice = adviseFromKnowledge([low, noStats], { feature: 'wan3', tags: ['720P', '4K'] });
    expect(advice).toHaveLength(2);
    const lowAdvice = advice.find((a) => a.knowledgeId === 'kb-low')!;
    expect(lowAdvice.failureRate).toBe(0.05);
    expect(lowAdvice.priorityBoost).toBe(false);
    const noStatsAdvice = advice.find((a) => a.knowledgeId === 'kb-nostats')!;
    expect(noStatsAdvice.failureRate).toBe(0);
    expect(boostedTagsFromAdvice(advice)).toEqual([]);
  });

  it('过滤：非 ACTIVE / 不同 feature / tags 不命中均不参与决策', () => {
    const base: KnowledgeEntry = {
      id: 'kb-x', type: 'failure-pattern', feature: 'wan3', title: 'x', content: '',
      confidence: 1, usageCount: 0, source: 'rca', status: 'ACTIVE', tags: ['1080P'],
      stats: { runs: 10, failures: 5 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const stale = { ...base, id: 'kb-stale', status: 'STALE' as const };
    const otherFeature = { ...base, id: 'kb-chat', feature: 'chat' };
    const noTagHit = { ...base, id: 'kb-notag', tags: ['billing'] };
    const featureLevel = { ...base, id: 'kb-general', tags: [], title: '通用风险' };

    const advice = adviseFromKnowledge(
      [stale, otherFeature, noTagHit, featureLevel, base],
      { feature: 'wan3', tags: ['1080P'] },
    );
    const ids = advice.map((a) => a.knowledgeId).sort();
    expect(ids).toEqual(['kb-general', 'kb-x']);
  });

  it('failureRateOf 边界：runs=0 / 缺失 / 越界截断', () => {
    const mk = (stats?: Record<string, unknown>): KnowledgeEntry => ({
      id: 'kb', type: 'risk-insight', feature: 'f', title: 't', content: '', confidence: 1,
      usageCount: 0, source: 'manual', status: 'ACTIVE', tags: [], stats,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    expect(failureRateOf(mk(undefined))).toBe(0);
    expect(failureRateOf(mk({ runs: 0, failures: 5 }))).toBe(0);
    expect(failureRateOf(mk({ runs: 10, failures: 99 }))).toBe(1);
    expect(PRIORITY_BOOST_THRESHOLD).toBe(0.2);
  });

  it('按风险权重降序返回', () => {
    const mk = (id: string, failures: number, confidence: number): KnowledgeEntry => ({
      id, type: 'risk-insight', feature: 'wan3', title: id, content: '', confidence,
      usageCount: 0, source: 'memory', status: 'ACTIVE', tags: ['t'],
      stats: { runs: 10, failures }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const advice = adviseFromKnowledge([mk('kb-a', 2, 1), mk('kb-b', 8, 1), mk('kb-c', 5, 0.5)], { feature: 'wan3', tags: ['t'] });
    expect(advice.map((a) => a.knowledgeId)).toEqual(['kb-b', 'kb-c', 'kb-a']);
  });
});

describe('KnowledgeStore 持久化', () => {
  it('save/load 往返一致；损坏文件降级为空', () => {
    const file = tmpFile('store.json');
    const store = createKnowledgeStore();
    store.add({ type: 'known-issue', feature: 'wan3', title: '持久化知识', tags: ['persist'] });
    store.save(file);

    const loaded = KnowledgeStore.load(file);
    expect(loaded.size()).toBe(1);
    expect(loaded.query({ tags: ['persist'] })[0].title).toBe('持久化知识');

    // 损坏文件降级为空
    const bad = tmpFile('bad.json');
    fs.writeFileSync(bad, '{invalid json', 'utf-8');
    expect(KnowledgeStore.load(bad).size()).toBe(0);
    // 不存在文件返回空
    expect(KnowledgeStore.load(tmpFile('missing.json')).size()).toBe(0);
    expect(DEFAULT_LIFECYCLE_CONFIG).toEqual({ staleDays: 30, expireDays: 90 });
  });
});
