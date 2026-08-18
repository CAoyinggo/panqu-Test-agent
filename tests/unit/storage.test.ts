// 单元测试：Platform Storage Repository（Phase 24.2）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  InMemoryRepository,
  JsonRepository,
  createRepository,
  generateEntityId,
  type Entity,
  type Repository,
} from '../../src/platform/storage/index.js';

interface Widget extends Entity {
  name: string;
  env: string;
  score: number;
}

/** 对 Memory 与 JSON 实现跑同一组断言 */
async function runSuite(make: () => Repository<Widget>, label: string): Promise<void> {
  describe(`${label} 仓库 CRUD`, () => {
    it('create / get / update / delete / count / clear', async () => {
      const r = make();
      const w = await r.create({ name: 'a', env: 'test', score: 1 });
      expect(w.id).toBeTruthy();
      expect((await r.get(w.id))!.name).toBe('a');
      expect(await r.count()).toBe(1);
      const u = await r.update(w.id, { name: 'a2', score: 2 });
      expect(u.name).toBe('a2');
      expect((await r.get(w.id))!.score).toBe(2);
      await r.delete(w.id);
      expect(await r.get(w.id)).toBeNull();
      expect(await r.count()).toBe(0);
      await r.clear();
    });

    it('create 提供 id 时不重复生成', async () => {
      const r = make();
      await r.create({ id: 'fixed-1', name: 'x', env: 'dev', score: 0 });
      expect((await r.get('fixed-1'))!.name).toBe('x');
    });

    it('query 浅相等过滤 + 分页', async () => {
      const r = make();
      for (let i = 0; i < 5; i++) {
        await r.create({ id: `w${i}`, name: `n${i}`, env: i % 2 ? 'test' : 'dev', score: i });
      }
      const devs = await r.query({ env: 'dev' });
      expect(devs.map((d) => d.id)).toEqual(['w0', 'w2', 'w4']);
      const page = await r.query({ env: 'dev' }, { offset: 1, limit: 1 });
      expect(page.map((d) => d.id)).toEqual(['w2']);
    });

    it('重复 id create 抛错 / 更新不存在抛错', async () => {
      const r = make();
      await r.create({ id: 'dup', name: 'x', env: 'test', score: 0 });
      await expect(r.create({ id: 'dup', name: 'y', env: 'test', score: 1 })).rejects.toThrow(/已存在/);
      await expect(r.update('missing', { name: 'z' })).rejects.toThrow(/不存在/);
      await expect(r.delete('missing')).rejects.toThrow(/不存在/);
    });
  });
}

runSuite(() => new InMemoryRepository<Widget>('widget'), 'Memory');

runSuite(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p24s-'));
  return new JsonRepository<Widget>(path.join(dir, 'widgets.json'), 'widget');
}, 'JSON');

describe('JsonRepository 持久化', () => {
  it('写盘后可被新实例读回', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p24s-'));
    const file = path.join(dir, 'widgets.json');
    const a = new JsonRepository<Widget>(file, 'widget');
    await a.create({ id: 'p1', name: 'persisted', env: 'production', score: 9 });
    const b = new JsonRepository<Widget>(file, 'widget');
    expect((await b.get('p1'))!.name).toBe('persisted');
    expect(await b.count()).toBe(1);
  });

  it('损坏文件按空处理，不抛错', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p24s-'));
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{not-json', 'utf-8');
    const r = new JsonRepository<Widget>(file, 'widget');
    expect(await r.count()).toBe(0);
  });
});

describe('createRepository 工厂', () => {
  it('memory 与 json 可替换', async () => {
    const mem = createRepository<Widget>('memory', { collection: 'w' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p24s-'));
    const json = createRepository<Widget>('json', { collection: 'w', dir });
    for (const r of [mem, json]) {
      await r.create({ id: 'same', name: 'x', env: 'test', score: 0 });
      expect((await r.get('same'))!.name).toBe('x');
    }
  });

  it('generateEntityId 生成带前缀 id', () => {
    expect(generateEntityId('run')).toMatch(/^run-/);
  });
});
