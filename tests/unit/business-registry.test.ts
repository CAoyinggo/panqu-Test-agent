// 单元测试：业务注册中心（Phase 21.1 Multi-Business）
// 覆盖：Schema 校验 / Registry 注册与解析 / Adapter 映射 / Loader（内置 + 外部目录）
// 验收场景 1：新增业务 image-generation 仅通过 BusinessDefinition + Adapter 接入，不修改 core。
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateBusinessDefinition,
  normalizeBusinessDefinition,
  createBusinessRegistry,
  loadBuiltinBusinesses,
  loadBusinessDefinitionsFromDir,
  initBusinessRegistry,
  createBusinessAdapter,
  BUILTIN_BUSINESSES,
  WAN3_BUSINESS,
  IMAGE_GENERATION_BUSINESS,
  type BusinessDefinition,
} from '../../src/business/index.js';

function validDef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo-biz',
    name: 'Demo Business',
    version: '1.0',
    scenes: ['demo'],
    environments: ['test'],
    capabilities: ['demo-cap'],
    ...overrides,
  };
}

describe('business - Schema 校验与归一化', () => {
  it('合法定义校验通过并归一化', async () => {
    const def = await validateBusinessDefinition(validDef());
    expect(def.id).toBe('demo-biz');
    expect(def.scenes).toEqual(['demo']);
    expect(def.environments).toEqual(['test']);
  });

  it('environments 缺省补默认 test', () => {
    const def = normalizeBusinessDefinition(validDef({ environments: [] }));
    expect(def.environments).toEqual(['test']);
  });

  it('缺 id 校验失败', async () => {
    await expect(validateBusinessDefinition(validDef({ id: '' }))).rejects.toThrow('缺少 id');
  });

  it('非对象输入校验失败', async () => {
    await expect(validateBusinessDefinition('not-an-object')).rejects.toThrow('必须为对象');
    await expect(validateBusinessDefinition(null)).rejects.toThrow('必须为对象');
  });

  it('coverageThreshold 超出 0~1 校验失败', async () => {
    await expect(validateBusinessDefinition(
      validDef({ testPolicy: { coverageThreshold: 1.5 } }),
    )).rejects.toThrow('校验失败');
  });

  it('riskPolicy / testPolicy / description 保留', async () => {
    const def = await validateBusinessDefinition(validDef({
      riskPolicy: { forbiddenActions: ['delete-data'], requireApproval: true },
      testPolicy: { defaultSuite: 'smoke', p0Required: true },
      description: '演示业务',
    }));
    expect(def.riskPolicy?.forbiddenActions).toEqual(['delete-data']);
    expect(def.testPolicy?.defaultSuite).toBe('smoke');
    expect(def.description).toBe('演示业务');
  });
});

describe('business - Registry 注册与解析', () => {
  let registry = createBusinessRegistry();

  beforeEach(() => {
    registry = createBusinessRegistry();
    loadBuiltinBusinesses(registry);
  });

  it('内置 6 个业务全部注册', () => {
    expect(registry.size()).toBe(6);
    expect(registry.ids()).toEqual(
      ['chat', 'digital-human', 'image-generation', 'music', 'wan3', 'workflow'],
    );
  });

  it('重复注册同 id 抛错', () => {
    expect(() => registry.register(WAN3_BUSINESS)).toThrow('已存在');
  });

  it('get / has / unregister / clear', () => {
    expect(registry.has('wan3')).toBe(true);
    expect(registry.get('wan3')?.definition.name).toBe('WAN3 Video Generation');
    expect(registry.unregister('wan3')).toBe(true);
    expect(registry.has('wan3')).toBe(false);
    registry.clear();
    expect(registry.size()).toBe(0);
  });

  it('resolveByFeature：业务 id 命中', () => {
    expect(registry.resolveByFeature('wan3')?.definition.id).toBe('wan3');
    expect(registry.resolveByFeature('image-generation')?.definition.id).toBe('image-generation');
    expect(registry.resolveByFeature('unknown-biz')).toBeNull();
    expect(registry.resolveByFeature('')).toBeNull();
  });

  it('resolveByCapability：能力标签命中', () => {
    expect(registry.resolveByCapability('text-to-video')?.definition.id).toBe('wan3');
    expect(registry.resolveByCapability('text-to-image')?.definition.id).toBe('image-generation');
    expect(registry.resolveByCapability('multi-turn')?.definition.id).toBe('chat');
    expect(registry.resolveByCapability('no-such-cap')).toBeNull();
  });

  it('resolveByScene：场景命中', () => {
    expect(registry.resolveByScene('video')?.definition.id).toBe('wan3');
    expect(registry.resolveByScene('chat')?.definition.id).toBe('chat');
    expect(registry.resolveByScene('music')?.definition.id).toBe('music');
    expect(registry.resolveByScene('no-such-scene')).toBeNull();
  });

  it('list 按 id 稳定排序', () => {
    const ids = registry.list().map((e) => e.definition.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });
});

describe('business - Adapter 映射', () => {
  it('wan3 适配器保持既有行为（adapter 名 + 7 项默认断言档案）', () => {
    const adapter = createBusinessAdapter(WAN3_BUSINESS);
    expect(adapter.businessId).toBe('wan3');
    expect(adapter.defaultAdapterName()).toBe('wan3');
    expect(adapter.assertionProfile()).toContain('billing-check');
    expect(adapter.assertionProfile()).toHaveLength(7);
    expect(adapter.matchFeature('wan3')).toBe(true);
    expect(adapter.resolveScene('video')).toBe('video');
  });

  it('新业务适配器：matchFeature / resolveScene / 断言档案', () => {
    const adapter = createBusinessAdapter(IMAGE_GENERATION_BUSINESS);
    expect(adapter.matchFeature('image-generation')).toBe(true);
    expect(adapter.matchFeature('wan3')).toBe(false);
    expect(adapter.resolveScene('image-generation')).toBe('image-generation');
    expect(adapter.resolveScene('video')).toBeNull();
    expect(adapter.defaultAdapterName()).toBe('image-generation');
    expect(adapter.assertionProfile()).toEqual(['image-generation-default']);
  });

  it('大小写不敏感匹配', () => {
    const adapter = createBusinessAdapter(IMAGE_GENERATION_BUSINESS);
    expect(adapter.matchFeature('Image-Generation')).toBe(true);
  });
});

describe('business - Loader（外部定义目录，零代码接入）', () => {
  function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'biz-defs-'));
  }

  it('加载外部 JSON 定义并注册', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'podcast.json'), JSON.stringify(validDef({
      id: 'podcast', name: 'Podcast Generation', scenes: ['podcast'], capabilities: ['text-to-podcast'],
    })));
    const registry = createBusinessRegistry();
    const loaded = await loadBusinessDefinitionsFromDir(registry, dir);
    expect(loaded).toBe(1);
    expect(registry.has('podcast')).toBe(true);
    expect(registry.resolveByCapability('text-to-podcast')?.definition.id).toBe('podcast');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('非法定义文件跳过且不影响其他文件', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a-bad.json'), '{"name": "缺 id"}');
    fs.writeFileSync(path.join(dir, 'b-good.json'), JSON.stringify(validDef({ id: 'good-biz', scenes: ['g'] })));
    const registry = createBusinessRegistry();
    const loaded = await loadBusinessDefinitionsFromDir(registry, dir);
    expect(loaded).toBe(1);
    expect(registry.has('good-biz')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('与已注册业务 id 冲突时跳过不覆盖', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'wan3.json'), JSON.stringify(validDef({ id: 'wan3', name: 'Other Wan' })));
    const registry = createBusinessRegistry();
    loadBuiltinBusinesses(registry);
    const loaded = await loadBusinessDefinitionsFromDir(registry, dir);
    expect(loaded).toBe(0);
    expect(registry.get('wan3')?.definition.name).toBe('WAN3 Video Generation');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('目录不存在返回 0 不报错', async () => {
    const registry = createBusinessRegistry();
    expect(await loadBusinessDefinitionsFromDir(registry, '/no/such/dir')).toBe(0);
    expect(await loadBusinessDefinitionsFromDir(registry, '')).toBe(0);
  });

  it('initBusinessRegistry：内置 + 外部合并', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'extra.json'), JSON.stringify(validDef({ id: 'extra-biz', scenes: ['x'] })));
    const registry = createBusinessRegistry();
    const { externalLoaded } = await initBusinessRegistry(registry, { externalDir: dir });
    expect(externalLoaded).toBe(1);
    expect(registry.size()).toBe(7); // 6 内置 + 1 外部
    expect(registry.has('extra-biz')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('initBusinessRegistry 可关闭内置业务', async () => {
    const registry = createBusinessRegistry();
    await initBusinessRegistry(registry, { builtin: false });
    expect(registry.size()).toBe(0);
  });
});

describe('business - 验收场景 1：新增业务不改 core/pipeline/assertion', () => {
  it('image-generation 仅凭定义 + 默认适配器完成接入', () => {
    const registry = createBusinessRegistry();
    // 模拟「新增业务」：只提交一份 BusinessDefinition（等价于外部 JSON 文件）
    const def: BusinessDefinition = IMAGE_GENERATION_BUSINESS;
    registry.register(def);

    const entry = registry.get('image-generation');
    expect(entry).not.toBeNull();
    // 注册中心可解析归属
    expect(registry.resolveByFeature('image-generation')?.definition.id).toBe('image-generation');
    // 适配器提供引擎映射（scene / adapter 名 / 断言档案），无需改 core
    expect(entry!.adapter.resolveScene('image-generation')).toBe('image-generation');
    expect(entry!.adapter.defaultAdapterName()).toBe('image-generation');
    expect(entry!.adapter.assertionProfile().length).toBeGreaterThan(0);
    // 策略齐备
    expect(def.riskPolicy?.requireApproval).toBe(true);
    expect(def.testPolicy?.p0Required).toBe(true);
  });

  it('内置业务定义均含 id/name/version/scenes/capabilities', () => {
    expect(BUILTIN_BUSINESSES).toHaveLength(6);
    for (const b of BUILTIN_BUSINESSES) {
      expect(b.id).toBeTruthy();
      expect(b.name).toBeTruthy();
      expect(b.version).toBeTruthy();
      expect(b.scenes.length).toBeGreaterThan(0);
      expect(b.capabilities.length).toBeGreaterThan(0);
      expect(b.environments.length).toBeGreaterThan(0);
    }
  });
});
