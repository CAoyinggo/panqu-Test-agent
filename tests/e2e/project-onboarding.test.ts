// Phase 26.2 Real Project Onboarding — E2E
// 验证：WAN3 项目（test/staging 环境）→ 50 个真实 TestCase 导入
// → 分类/复用/幂等 → API 返回真实数据 → 纳入备份集合。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';
import { WAN3_CATALOG, wan3CatalogStats } from '../../src/platform/test-assets/wan3-catalog.js';
import { ALL_COLLECTIONS } from '../../src/platform/ops/migrations.js';
import fs from 'node:fs';
import path from 'node:path';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const TOKEN = 'onboarding-token';
const opened: PlatformHttpServer[] = [];

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

async function startServer(b: PlatformBundle): Promise<{ request: (m: string, p: string, o?: { token?: string; body?: unknown }) => Promise<{ status: number; data: unknown }> }> {
  const server = createPlatformServer({ service: b.service, token: TOKEN, now: () => FIXED_ISO });
  const { port } = await server.listen();
  opened.push(server);
  const base = `http://127.0.0.1:${port}`;
  return {
    async request(method, pathname, o = {}) {
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: res.status, data };
    },
  };
}

afterEach(async () => {
  while (opened.length > 0) {
    const s = opened.pop();
    if (s) await s.close();
  }
});

describe('26.2.1 WAN3 项目（test/staging 环境）', () => {
  it('WAN3 项目存在，包含 test 与 staging 环境', () => {
    const b = makeBundle();
    const project = b.projects.getProject('wan3');
    expect(project).not.toBeNull();
    expect(project!.businesses.length).toBeGreaterThan(0);
    for (const env of ['test', 'staging']) {
      expect(b.projects.getEnvironment('wan3', env)).not.toBeNull();
    }
  });
});

describe('26.2.2 目录完整性：50 个真实 TestCase，5 类分布正确', () => {
  it('总数为 50，P0/P1=10、边界=10、异常=10、历史=10、AI=10', () => {
    const stats = wan3CatalogStats();
    expect(stats.total).toBe(50);
    expect(stats.p0 + stats.p1).toBe(10);
    expect(stats.boundary).toBe(10);
    expect(stats.exception).toBe(10);
    expect(stats.history).toBe(10);
    expect(stats['ai-generated']).toBe(10);
    // 无重复 id
    const ids = new Set(WAN3_CATALOG.map((c) => c.id));
    expect(ids.size).toBe(50);
  });

  it('复用 9 个现有 src/cases/wan3/ 资产，且文件真实存在', () => {
    const reused = WAN3_CATALOG.filter((c) => c.source.startsWith('reuse:'));
    expect(reused.length).toBe(9);
    for (const r of reused) {
      expect(r.reuseOf).toBeTruthy();
      const full = path.join(__dirname, '../../src/cases/wan3', path.basename(r.reuseOf!));
      expect(fs.existsSync(full), `${r.reuseOf} 应存在`).toBe(true);
    }
  });
});

describe('26.2.3 平台导入：50 个资产落库 + 幂等', () => {
  it('导入 50 个，重复导入不重复创建', async () => {
    const b = makeBundle();
    const first = await b.testAssets.importCatalog();
    expect(first.imported).toBe(50);
    expect(first.skipped).toBe(0);
    const second = await b.testAssets.importCatalog();
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(50);
    expect(await b.testAssets.count()).toBe(50);
  });

  it('统计：byCategory 与 bySource 真实一致（reuse=9 / onboarding=41）', async () => {
    const b = makeBundle();
    await b.testAssets.importCatalog();
    const stats = await b.testAssets.stats();
    expect(stats.total).toBe(50);
    expect(stats.byCategory.boundary).toBe(10);
    expect(stats.byCategory.exception).toBe(10);
    expect(stats.byCategory.history).toBe(10);
    expect(stats.byCategory['ai-generated']).toBe(10);
    expect(stats.byCategory.p0 + stats.byCategory.p1).toBe(10);
    expect(stats.bySource.reuse).toBe(9);
    expect(stats.bySource.onboarding).toBe(41);
  });
});

describe('26.2.4 API 返回真实 Test Assets 数据', () => {
  it('GET /api/test-assets 返回 50 条真实资产，source 不再是 platform-repo-not-connected', async () => {
    const b = makeBundle();
    await b.testAssets.importCatalog();
    const api = await startServer(b);
    const res = await api.request('GET', '/api/test-assets', { token: TOKEN });
    expect(res.status).toBe(200);
    const body = res.data as { items: Array<{ id: string; title: string; category: string }>; source: string };
    expect(body.source).toBe('platform-test-assets');
    expect(body.items.length).toBe(50);
    expect(body.items[0]).toHaveProperty('id');
    expect(body.items[0]).toHaveProperty('title');
  });

  it('GET /api/test-assets/stats 返回真实统计', async () => {
    const b = makeBundle();
    await b.testAssets.importCatalog();
    const api = await startServer(b);
    const res = await api.request('GET', '/api/test-assets/stats', { token: TOKEN });
    expect(res.status).toBe(200);
    const body = res.data as { total: number; byCategory: Record<string, number> };
    expect(body.total).toBe(50);
    expect(body.byCategory.boundary).toBe(10);
  });
});

describe('26.2.5 test-assets 纳入平台备份/恢复集合', () => {
  it('ALL_COLLECTIONS 包含 test-assets，且 health 报告 Test Case 数', async () => {
    expect(ALL_COLLECTIONS).toContain('test-assets');
    const b = makeBundle();
    await b.testAssets.importCatalog();
    const health = await b.service.health();
    const check = health.checks.find((c) => c.name === 'test-assets');
    expect(check).toBeTruthy();
    expect(check!.detail).toContain('50');
    expect(check!.ok).toBe(true);
  });
});
