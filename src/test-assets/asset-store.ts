// Test Asset Store：测试资产库（Phase 21.2）
// 能力：创建 / 查询 / 版本 / 归档 / 恢复 / 关联 / 追踪链 / 影响分析 / JSON 持久化。
// 主键 = id@version：同一 id 多版本共存，latest() 取最新版本。
// 与 Memory 的分工：Memory 存执行经验记录（失败/风险/已知问题），
// TestAssetStore 存受管理的测试资产（有版本、状态、关联图）。

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/fs-utils.js';
import {
  ASSET_RELATIONS,
  bumpVersion,
  generateAssetId,
  normalizeCreateAssetInput,
  type AssetLink,
  type AssetQuery,
  type AssetRelation,
  type CreateAssetInput,
  type TestAsset,
} from './asset-schema.js';

/** 持久化结构 */
interface StoreSnapshot {
  assets: TestAsset[];
  links: AssetLink[];
}

export class TestAssetStore {
  /** key = id@version */
  private readonly assets = new Map<string, TestAsset>();
  private readonly links: AssetLink[] = [];

  private static key(id: string, version: string): string {
    return `${id}@${version}`;
  }

  // ── 创建 / 查询 ──

  /** 创建资产：显式 id 已存在时抛错（需走 newVersion） */
  create(input: unknown): TestAsset {
    const norm = normalizeCreateAssetInput(input);
    const id = norm.id ?? generateAssetId(norm.type, norm.feature);
    const version = norm.version ?? 'v1';
    if (this.has(id)) {
      throw new Error(`TestAsset 创建失败：${id} 已存在（请使用 newVersion 升级版本）`);
    }
    const now = new Date().toISOString();
    const asset: TestAsset = {
      id,
      type: norm.type,
      version,
      feature: norm.feature,
      createdAt: now,
      updatedAt: now,
      status: norm.status ?? 'ACTIVE',
      tags: norm.tags ?? [],
    };
    if (norm.content !== undefined) asset.content = norm.content;
    if (norm.metadata) asset.metadata = norm.metadata;
    this.assets.set(TestAssetStore.key(id, version), asset);
    return asset;
  }

  has(id: string): boolean {
    return this.listVersions(id).length > 0;
  }

  /** 取指定版本；version 缺省取最新 */
  get(id: string, version?: string): TestAsset | null {
    if (version) return this.assets.get(TestAssetStore.key(id, version)) ?? null;
    return this.latest(id);
  }

  /** 最新版本（按版本号数值排序，非 vN 格式排最后按插入序） */
  latest(id: string): TestAsset | null {
    const versions = this.listVersions(id);
    return versions.length ? versions[versions.length - 1] : null;
  }

  /** 全部版本（版本号升序） */
  listVersions(id: string): TestAsset[] {
    const all = [...this.assets.values()].filter((a) => a.id === id);
    return all.sort((a, b) => {
      const na = /^v(\d+)$/.exec(a.version);
      const nb = /^v(\d+)$/.exec(b.version);
      if (na && nb) return Number(na[1]) - Number(nb[1]);
      if (na) return -1;
      if (nb) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  /** 条件查询（默认排除 ARCHIVED，仅取每个 id 的最新版本） */
  query(filter: AssetQuery = {}): TestAsset[] {
    const latestById = new Map<string, TestAsset>();
    for (const a of this.assets.values()) {
      const cur = latestById.get(a.id);
      if (!cur) latestById.set(a.id, a);
      else {
        const versions = this.listVersions(a.id);
        latestById.set(a.id, versions[versions.length - 1]);
      }
    }
    const text = (filter.text ?? '').toLowerCase();
    let result = [...latestById.values()].filter((a) => {
      if (filter.type && a.type !== filter.type) return false;
      if (filter.feature && a.feature !== filter.feature) return false;
      if (filter.status && a.status !== filter.status) return false;
      if (!filter.includeArchived && a.status === 'ARCHIVED') return false;
      if (filter.tags?.length && !filter.tags.every((t) => a.tags.includes(t))) return false;
      if (text) {
        const hay = `${a.id} ${a.tags.join(' ')} ${JSON.stringify(a.content ?? {})}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
    result.sort((a, b) => a.id.localeCompare(b.id));
    if (filter.limit && filter.limit > 0) result = result.slice(0, filter.limit);
    return result;
  }

  /** 按类型统计（含全部版本） */
  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const a of this.assets.values()) out[a.type] = (out[a.type] ?? 0) + 1;
    return out;
  }

  size(): number {
    return this.assets.size;
  }

  // ── 更新 / 版本 / 归档 ──

  /** 更新最新版本的 tags / status / content / metadata（updatedAt 刷新） */
  update(id: string, patch: { tags?: string[]; status?: string; content?: unknown; metadata?: Record<string, unknown> }): TestAsset {
    const asset = this.latest(id);
    if (!asset) throw new Error(`TestAsset 更新失败：${id} 不存在`);
    if (patch.tags) asset.tags = patch.tags;
    if (patch.status) asset.status = patch.status;
    if (patch.content !== undefined) asset.content = patch.content;
    if (patch.metadata) asset.metadata = { ...(asset.metadata ?? {}), ...patch.metadata };
    asset.updatedAt = new Date().toISOString();
    return asset;
  }

  /** 派生新版本（内容默认继承最新版）：v1 → v2 */
  newVersion(id: string, content?: unknown): TestAsset {
    const cur = this.latest(id);
    if (!cur) throw new Error(`TestAsset 升版失败：${id} 不存在`);
    const version = bumpVersion(cur.version);
    const now = new Date().toISOString();
    const next: TestAsset = {
      ...cur,
      version,
      createdAt: now,
      updatedAt: now,
      status: 'ACTIVE',
      tags: [...cur.tags],
      content: content !== undefined ? content : cur.content,
      metadata: cur.metadata ? { ...cur.metadata } : undefined,
    };
    this.assets.set(TestAssetStore.key(id, version), next);
    return next;
  }

  /** 归档（最新版本置 ARCHIVED） */
  archive(id: string): boolean {
    const asset = this.latest(id);
    if (!asset || asset.status === 'ARCHIVED') return false;
    asset.status = 'ARCHIVED';
    asset.updatedAt = new Date().toISOString();
    return true;
  }

  /** 恢复归档（ARCHIVED → ACTIVE） */
  restore(id: string): boolean {
    const asset = this.latest(id);
    if (!asset || asset.status !== 'ARCHIVED') return false;
    asset.status = 'ACTIVE';
    asset.updatedAt = new Date().toISOString();
    return true;
  }

  // ── 关联 / 追踪 / 影响分析 ──

  /** 建立关联边（幂等：重复关联不新增） */
  link(from: string, to: string, relation: AssetRelation): AssetLink {
    if (!ASSET_RELATIONS.includes(relation)) {
      throw new Error(`关联失败：relation 无效（需为 ${ASSET_RELATIONS.join(' / ')}）`);
    }
    if (!this.has(from)) throw new Error(`关联失败：资产 ${from} 不存在`);
    if (!this.has(to)) throw new Error(`关联失败：资产 ${to} 不存在`);
    const existing = this.links.find((l) => l.from === from && l.to === to && l.relation === relation);
    if (existing) return existing;
    const link: AssetLink = { from, to, relation, createdAt: new Date().toISOString() };
    this.links.push(link);
    return link;
  }

  unlink(from: string, to: string, relation?: AssetRelation): boolean {
    const idx = this.links.findIndex(
      (l) => l.from === from && l.to === to && (!relation || l.relation === relation),
    );
    if (idx < 0) return false;
    this.links.splice(idx, 1);
    return true;
  }

  /** 资产相关的全部关联边（出边 + 入边） */
  linksOf(id: string): AssetLink[] {
    return this.links.filter((l) => l.from === id || l.to === id);
  }

  allLinks(): AssetLink[] {
    return [...this.links];
  }

  /**
   * 追踪链：从指定资产出发，upstream = 反向 BFS（谁派生/触发了我），
   * downstream = 正向 BFS（我派生/触发了谁）。
   * 对应 Requirement → TestCase → Execution → RCA → Defect → Regression 全链路。
   */
  trace(id: string): { upstream: string[]; downstream: string[] } {
    const bfs = (start: string, direction: 'from' | 'to'): string[] => {
      const seen = new Set<string>();
      const queue = [start];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const l of this.links) {
          const next = direction === 'from'
            ? (l.from === cur ? l.to : null)
            : (l.to === cur ? l.from : null);
          if (next && !seen.has(next) && next !== id) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return [...seen];
    };
    return { upstream: bfs(id, 'to'), downstream: bfs(id, 'from') };
  }

  /**
   * 影响分析：资产变更时的下游受影响集合。
   * type 过滤返回特定类型（如只看受影响的 test-case）。
   */
  impact(id: string, type?: TestAsset['type']): TestAsset[] {
    const { downstream } = this.trace(id);
    const assets = downstream
      .map((d) => this.latest(d))
      .filter((a): a is TestAsset => a !== null);
    return type ? assets.filter((a) => a.type === type) : assets;
  }

  // ── 持久化 ──

  /** 保存到 JSON 文件 */
  save(file: string): void {
    const snapshot: StoreSnapshot = { assets: [...this.assets.values()], links: this.links };
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  /** 从 JSON 文件加载（文件不存在返回空 store） */
  static load(file: string): TestAssetStore {
    const store = new TestAssetStore();
    try {
      if (!fs.existsSync(file)) return store;
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf-8')) as StoreSnapshot;
      for (const a of snapshot.assets ?? []) {
        store.assets.set(TestAssetStore.key(a.id, a.version), a);
      }
      for (const l of snapshot.links ?? []) store.links.push(l);
    } catch {
      // 文件损坏：返回空 store（与 JsonMemoryStore 策略一致）
    }
    return store;
  }
}

/** 创建独立资产库实例 */
export function createTestAssetStore(): TestAssetStore {
  return new TestAssetStore();
}
