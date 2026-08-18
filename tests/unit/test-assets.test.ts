// 单元测试：测试资产管理（Phase 21.2 Test Asset Management）
// 覆盖：Schema 校验 / Store 创建查询 / 版本 / 归档恢复 / 关联追踪 / 影响分析 / 持久化 / 复用引擎
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TestAssetStore,
  bumpVersion,
  createTestAssetStore,
  generateAssetId,
  normalizeCreateAssetInput,
  assessReuse,
  findReusableCases,
} from '../../src/test-assets/index.js';
import type { Requirement } from '../../src/agents/requirement/requirement-schema.js';

/** 构造最小 Requirement */
function makeReq(overrides: Partial<Requirement> = {}): Requirement {
  return {
    feature: 'wan3',
    capabilities: ['text-to-video'],
    inputs: ['prompt', 'resolution'],
    requirements: [{ name: 'resolution', values: ['720P', '1080P'] }],
    businessRules: ['任务提交成功'],
    dependencies: [],
    ...overrides,
  };
}

/** 构造预置资产库：req → tc ×2 → exec → rca → def 追踪链 */
function buildChainStore(): TestAssetStore {
  const store = createTestAssetStore();
  const req = store.create({ id: 'req-1', type: 'requirement', feature: 'wan3', tags: ['video'], content: { text: '文生视频' } });
  const tc1 = store.create({
    id: 'tc-1', type: 'test-case', feature: 'wan3', tags: ['720P', 'text-to-video'],
    content: { name: '720P 文生视频正常生成', inputs: ['prompt', 'resolution'], resolution: '720P' },
  });
  const tc2 = store.create({
    id: 'tc-2', type: 'test-case', feature: 'wan3', tags: ['1080P', 'text-to-video'],
    content: { name: '1080P 文生视频正常生成', inputs: ['prompt', 'resolution'], resolution: '1080P' },
  });
  const exec = store.create({ id: 'exec-1', type: 'execution', feature: 'wan3', content: { passRate: 0.5 } });
  const rca = store.create({ id: 'rca-1', type: 'rca', feature: 'wan3', content: { category: 'MODEL_ERROR' } });
  const def = store.create({ id: 'def-1', type: 'defect', feature: 'wan3', status: 'DRAFT', content: { title: '1080P 生成失败' } });
  store.link(req.id, tc1.id, 'derives');
  store.link(req.id, tc2.id, 'derives');
  store.link(tc2.id, exec.id, 'executes');
  store.link(exec.id, rca.id, 'failed-as');
  store.link(rca.id, def.id, 'caused');
  return store;
}

describe('test-assets - Schema 校验', () => {
  it('合法输入归一化（默认 version=v1 / status=ACTIVE）', () => {
    const norm = normalizeCreateAssetInput({ type: 'test-case', feature: 'wan3' });
    expect(norm.type).toBe('test-case');
    expect(norm.version).toBe('v1');
    expect(norm.status).toBe('ACTIVE');
    expect(norm.tags).toEqual([]);
  });

  it('非法 type / 缺 feature / 非对象抛错', () => {
    expect(() => normalizeCreateAssetInput({ type: 'unknown', feature: 'x' })).toThrow('type 无效');
    expect(() => normalizeCreateAssetInput({ type: 'risk' })).toThrow('缺少 feature');
    expect(() => normalizeCreateAssetInput('bad')).toThrow('必须为对象');
  });

  it('bumpVersion：v1→v2 / v9→v10 / 非 vN 追加', () => {
    expect(bumpVersion('v1')).toBe('v2');
    expect(bumpVersion('v9')).toBe('v10');
    expect(bumpVersion('beta')).toBe('beta-2');
  });

  it('generateAssetId 带类型前缀', () => {
    expect(generateAssetId('requirement', 'wan3')).toMatch(/^req-wan3-/);
    expect(generateAssetId('healing-patch', 'wan3')).toMatch(/^patch-wan3-/);
  });
});

describe('test-assets - Store 创建与查询', () => {
  it('create 自动生成 id 并可 get 回读', () => {
    const store = createTestAssetStore();
    const asset = store.create({ type: 'knowledge', feature: 'wan3', tags: ['flaky'] });
    expect(asset.id).toMatch(/^kb-wan3-/);
    expect(store.get(asset.id)?.type).toBe('knowledge');
    expect(store.has(asset.id)).toBe(true);
  });

  it('重复 id 创建抛错', () => {
    const store = createTestAssetStore();
    store.create({ id: 'tc-x', type: 'test-case', feature: 'wan3' });
    expect(() => store.create({ id: 'tc-x', type: 'test-case', feature: 'wan3' })).toThrow('已存在');
  });

  it('query 按 type / feature / tags / text / limit 过滤', () => {
    const store = buildChainStore();
    expect(store.query({ type: 'test-case' })).toHaveLength(2);
    expect(store.query({ feature: 'wan3', type: 'defect' })).toHaveLength(1);
    expect(store.query({ type: 'test-case', tags: ['1080P'] })).toHaveLength(1);
    expect(store.query({ text: '1080P 生成失败' }).map((a) => a.id)).toContain('def-1');
    expect(store.query({ limit: 2 })).toHaveLength(2);
    expect(store.query({ feature: 'other' })).toHaveLength(0);
  });

  it('stats 按类型统计', () => {
    const store = buildChainStore();
    const stats = store.stats();
    expect(stats['test-case']).toBe(2);
    expect(stats['requirement']).toBe(1);
    expect(stats['defect']).toBe(1);
  });
});

describe('test-assets - 版本 / 归档 / 恢复', () => {
  it('newVersion 递增版本并保留历史', () => {
    const store = createTestAssetStore();
    store.create({ id: 'req-v', type: 'requirement', feature: 'wan3', content: { text: 'v1 内容' } });
    const v2 = store.newVersion('req-v', { text: 'v2 内容' });
    expect(v2.version).toBe('v2');
    expect(store.listVersions('req-v')).toHaveLength(2);
    expect(store.latest('req-v')?.content).toEqual({ text: 'v2 内容' });
    expect(store.get('req-v', 'v1')?.content).toEqual({ text: 'v1 内容' });
  });

  it('newVersion 缺省继承最新内容', () => {
    const store = createTestAssetStore();
    store.create({ id: 'req-i', type: 'requirement', feature: 'wan3', content: { text: '原始' } });
    const v2 = store.newVersion('req-i');
    expect(v2.content).toEqual({ text: '原始' });
  });

  it('update 刷新标签 / 状态 / updatedAt', () => {
    const store = createTestAssetStore();
    store.create({ id: 'tc-u', type: 'test-case', feature: 'wan3', tags: ['old'] });
    const updated = store.update('tc-u', { tags: ['new'], status: 'DRAFT' });
    expect(updated.tags).toEqual(['new']);
    expect(updated.status).toBe('DRAFT');
    expect(() => store.update('no-such', {})).toThrow('不存在');
  });

  it('archive / restore 状态流转且归档默认不被查询', () => {
    const store = createTestAssetStore();
    store.create({ id: 'tc-a', type: 'test-case', feature: 'wan3' });
    expect(store.archive('tc-a')).toBe(true);
    expect(store.query({ type: 'test-case' })).toHaveLength(0);
    expect(store.query({ type: 'test-case', includeArchived: true })).toHaveLength(1);
    expect(store.restore('tc-a')).toBe(true);
    expect(store.query({ type: 'test-case' })).toHaveLength(1);
    // 重复归档 / 恢复非归档返回 false
    expect(store.restore('tc-a')).toBe(false);
  });
});

describe('test-assets - 关联 / 追踪链 / 影响分析', () => {
  it('link 幂等，非法 relation / 不存在资产抛错', () => {
    const store = buildChainStore();
    const before = store.allLinks().length;
    store.link('req-1', 'tc-1', 'derives'); // 重复
    expect(store.allLinks()).toHaveLength(before);
    expect(() => store.link('req-1', 'tc-1', 'bad-relation' as never)).toThrow('relation 无效');
    expect(() => store.link('req-1', 'no-such', 'related')).toThrow('不存在');
  });

  it('unlink 删除关联', () => {
    const store = buildChainStore();
    expect(store.unlink('req-1', 'tc-1', 'derives')).toBe(true);
    expect(store.linksOf('tc-1')).toHaveLength(0);
    expect(store.unlink('req-1', 'tc-1')).toBe(false);
  });

  it('trace：Requirement → TestCase → Execution → RCA → Defect 全链路', () => {
    const store = buildChainStore();
    const fromReq = store.trace('req-1');
    expect(fromReq.upstream).toEqual([]);
    expect(fromReq.downstream.sort()).toEqual(['def-1', 'exec-1', 'rca-1', 'tc-1', 'tc-2']);

    const fromDef = store.trace('def-1');
    expect(fromDef.downstream).toEqual([]);
    expect(fromDef.upstream.sort()).toEqual(['exec-1', 'rca-1', 'req-1', 'tc-2']);
  });

  it('impact：需求变更影响下游用例与缺陷（支持类型过滤）', () => {
    const store = buildChainStore();
    const impacted = store.impact('req-1');
    expect(impacted.map((a) => a.id).sort()).toEqual(['def-1', 'exec-1', 'rca-1', 'tc-1', 'tc-2']);
    const cases = store.impact('req-1', 'test-case');
    expect(cases.map((a) => a.id).sort()).toEqual(['tc-1', 'tc-2']);
    expect(store.impact('def-1')).toEqual([]);
  });
});

describe('test-assets - 持久化', () => {
  it('save / load 往返一致', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'assets-')), 'store.json');
    const store = buildChainStore();
    store.save(file);
    const loaded = TestAssetStore.load(file);
    expect(loaded.size()).toBe(store.size());
    expect(loaded.allLinks()).toHaveLength(store.allLinks().length);
    expect(loaded.trace('req-1').downstream.sort()).toEqual(['def-1', 'exec-1', 'rca-1', 'tc-1', 'tc-2']);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('文件不存在 / 损坏返回空 store', () => {
    expect(TestAssetStore.load('/no/such/file.json').size()).toBe(0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-'));
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{corrupted');
    expect(TestAssetStore.load(bad).size()).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('test-assets - Test Reuse Engine（复用评估 + Gap 分析）', () => {
  it('相似用例评分：feature +3 / capability +2 / input +1 / rule +1', () => {
    const store = buildChainStore();
    const assessment = assessReuse(makeReq(), store.query({ type: 'test-case' }));
    expect(assessment.reusable.length).toBe(2);
    const top = assessment.reusable[0];
    expect(top.score).toBeGreaterThan(0);
    expect(top.reasons).toContain('feature 一致');
    expect(top.reasons.some((r) => r.startsWith('能力命中'))).toBe(true);
  });

  it('Gap 分析：缺失的参数取值成为缺口', () => {
    const store = buildChainStore();
    // 候选用例只覆盖 720P / 1080P 标签，需求新增 4K → 缺口
    const req = makeReq({ requirements: [{ name: 'resolution', values: ['720P', '1080P', '4K'] }] });
    const assessment = assessReuse(req, store.query({ type: 'test-case' }));
    expect(assessment.gaps).toContain('resolution=4K');
    expect(assessment.gaps).not.toContain('resolution=720P');
    expect(assessment.summary.recommendation).toContain('缺口');
  });

  it('全部覆盖时无缺口，建议复用', () => {
    const store = buildChainStore();
    const req = makeReq({
      requirements: [{ name: 'resolution', values: ['720P'] }],
      inputs: ['prompt'],
      businessRules: [],
    });
    const assessment = assessReuse(req, store.query({ type: 'test-case' }));
    expect(assessment.gaps).toEqual([]);
    expect(assessment.summary.recommendation).toContain('无需新增用例');
  });

  it('空候选：全部成为缺口', () => {
    const assessment = assessReuse(makeReq(), []);
    expect(assessment.reusable).toEqual([]);
    expect(assessment.summary.existing).toBe(0);
    expect(assessment.gaps.length).toBeGreaterThan(0);
  });

  it('findReusableCases：从资产库按 feature 检索并评估', () => {
    const store = buildChainStore();
    const assessment = findReusableCases(store, makeReq());
    expect(assessment.summary.existing).toBe(2);
    expect(assessment.reusable.length).toBeGreaterThan(0);
    // 其他 feature 无候选
    const empty = findReusableCases(store, makeReq({ feature: 'chat' }));
    expect(empty.summary.existing).toBe(0);
  });
});
