// 平台 Test Assets 服务（Phase 26.2 Real Project Onboarding）
// 基于平台统一 Repository<TestAsset> 持久化（与 Run/Job/Audit 同存储后端，
// 自动纳入备份/恢复/审计体系）。能力：查询 / 分类统计 / 目录导入（幂等）。
// 复用 src/test-assets/asset-schema.ts 的 TestAsset 类型与校验，避免重复实现。

import { normalizeCreateAssetInput } from '../../test-assets/asset-schema.js';
import type { TestAsset } from '../../test-assets/asset-schema.js';
import type { Repository, Entity } from '../storage/repository.js';
import { WAN3_CATALOG, wan3CatalogStats, type Wan3TestCase } from './wan3-catalog.js';

export type { Wan3TestCase, Wan3AssetCategory } from './wan3-catalog.js';
export { WAN3_CATALOG, WAN3_CATEGORY_LABEL, wan3CatalogStats } from './wan3-catalog.js';

/** 平台测试资产实体（id 唯一，无版本分层；metadata 承载分类/优先级/来源） */
export interface PlatformTestAsset extends Entity {
  id: string;
  type: 'test-case';
  projectId: string;
  feature: string;
  business: string;
  title: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  category: string;
  status: 'ACTIVE' | 'ARCHIVED';
  source: string;
  reuseOf?: string;
  content: {
    preconditions: string;
    steps: string[];
    expected: string;
    extra?: Record<string, unknown>;
  };
  createdAt: string;
}

export interface TestAssetStats {
  total: number;
  byCategory: Record<string, number>;
  byPriority: Record<string, number>;
  bySource: { reuse: number; onboarding: number };
}

export class PlatformTestAssets {
  constructor(private readonly repo: Repository<PlatformTestAsset>) {}

  /** 查询全部（或按分类过滤） */
  async list(filter?: Partial<PlatformTestAsset>): Promise<PlatformTestAsset[]> {
    return this.repo.query(filter ?? {});
  }

  async get(id: string): Promise<PlatformTestAsset | null> {
    return this.repo.get(id);
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  /** 真实统计（基于仓储数据；无数据则 0，不虚构） */
  async stats(): Promise<TestAssetStats> {
    const items = await this.list();
    const byCategory: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    let reuse = 0;
    for (const a of items) {
      byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
      byPriority[a.priority] = (byPriority[a.priority] ?? 0) + 1;
      if (a.source?.startsWith('reuse:')) reuse += 1;
    }
    return {
      total: items.length,
      byCategory,
      byPriority,
      bySource: { reuse, onboarding: items.length - reuse },
    };
  }

  /** 从目录导入（幂等：id 已存在则跳过，不重复创建） */
  async importCatalog(
    catalog: Wan3TestCase[] = WAN3_CATALOG,
    opts: { projectId?: string; now?: () => string } = {},
  ): Promise<{ imported: number; skipped: number; total: number }> {
    const now = opts.now ?? (() => new Date().toISOString());
    const projectId = opts.projectId ?? 'wan3';
    let imported = 0;
    let skipped = 0;
    for (const c of catalog) {
      if (await this.repo.get(c.id)) {
        skipped += 1;
        continue;
      }
      const asset: PlatformTestAsset = {
        id: c.id,
        type: 'test-case',
        projectId,
        feature: c.feature,
        business: c.business,
        title: c.title,
        priority: c.priority,
        category: c.category,
        status: 'ACTIVE',
        source: c.source,
        reuseOf: c.reuseOf,
        content: {
          preconditions: c.preconditions,
          steps: c.steps,
          expected: c.expected,
          extra: c.extra,
        },
        createdAt: now(),
      };
      // 用 schema 校验器确保结构合法（保持复用单一校验源）
      const norm = normalizeCreateAssetInput({
        id: asset.id,
        type: asset.type,
        feature: asset.feature,
        status: asset.status,
        tags: [asset.category, asset.business, asset.source],
        content: asset.content,
        metadata: {
          projectId, business: asset.business, priority: asset.priority, category: asset.category,
          source: asset.source, reuseOf: asset.reuseOf,
        },
      });
      void norm;
      await this.repo.create(asset);
      imported += 1;
    }
    return { imported, skipped, total: catalog.length };
  }

  /** 从任意自定义目录导入（元数据校验同一入口） */
  async importMany(items: Wan3TestCase[], projectId = 'wan3'): Promise<{ imported: number; skipped: number }> {
    const result = await this.importCatalog(items, { projectId });
    return { imported: result.imported, skipped: result.skipped };
  }
}

/** WAN3 目录统计快捷入口（测试/报告用） */
export function wan3ExpectedStats(): Record<string, number> {
  return wan3CatalogStats();
}
