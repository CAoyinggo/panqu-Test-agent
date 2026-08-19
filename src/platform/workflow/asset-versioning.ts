// Test Asset Versioning（Phase 39.4）：TestCase / Suite / Plan 版本化
// 记录 version / createdBy / changeReason / createdAt。
// 支持 Compare / Rollback / History。
// TestRun 通过 assetVersion（assetId → version 映射）固定本次运行使用的版本。

import type { Entity, Repository } from '../storage/repository.js';
import { generateEntityId } from '../storage/repository.js';

export type AssetType = 'test-case' | 'suite' | 'plan';

/** 版本快照记录（同一 assetId 按 version 递增） */
export interface AssetVersion extends Entity {
  id: string;
  assetType: AssetType;
  assetId: string;
  version: number;
  changeReason?: string;
  /** 完整快照（JSON 序列化存储；compare/rollback 基于快照） */
  snapshot: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

/** 版本摘要（History 列表项） */
export interface AssetVersionSummary {
  assetType: AssetType;
  assetId: string;
  version: number;
  changeReason?: string;
  createdBy: string;
  createdAt: string;
}

/** 差异结果（字段级） */
export interface AssetDiff {
  assetType: AssetType;
  assetId: string;
  fromVersion: number;
  toVersion: number;
  changed: string[];
  added: string[];
  removed: string[];
  /** 变更字段的 from → to 值（undefined 表示该版本无此字段） */
  changes: Array<{ key: string; from: unknown; to: unknown }>;
}

export class AssetVersioningService {
  constructor(private readonly repo: Repository<AssetVersion>) {}

  /** 记录新版本（自动计算下一个 version） */
  async recordVersion(input: {
    assetType: AssetType;
    assetId: string;
    snapshot: Record<string, unknown>;
    createdBy: string;
    changeReason?: string;
    now?: () => string;
  }): Promise<AssetVersion> {
    const now = input.now ? input.now() : new Date().toISOString();
    const prev = await this.latest(input.assetId);
    const version = (prev?.version ?? 0) + 1;
    const rec: AssetVersion = {
      id: generateEntityId('version'),
      assetType: input.assetType,
      assetId: input.assetId,
      version,
      changeReason: input.changeReason,
      snapshot: input.snapshot,
      createdBy: input.createdBy,
      createdAt: now,
    };
    await this.repo.create(rec);
    return rec;
  }

  /** 最新版本号（无版本返回 0，表示从未版本化） */
  async latestVersion(assetId: string): Promise<number> {
    const latest = await this.latest(assetId);
    return latest?.version ?? 0;
  }

  async latest(assetId: string): Promise<AssetVersion | null> {
    const versions = await this.listVersions(assetId);
    return versions[versions.length - 1] ?? null;
  }

  /** History：按版本升序 */
  async listVersions(assetId: string): Promise<AssetVersion[]> {
    const all = await this.repo.query({ assetId });
    return all.sort((a, b) => a.version - b.version);
  }

  /** History 摘要（Web/API 用） */
  async history(assetId: string): Promise<AssetVersionSummary[]> {
    const versions = await this.listVersions(assetId);
    return versions.map((v) => ({
      assetType: v.assetType,
      assetId: v.assetId,
      version: v.version,
      changeReason: v.changeReason,
      createdBy: v.createdBy,
      createdAt: v.createdAt,
    }));
  }

  async getVersion(assetId: string, version: number): Promise<AssetVersion | null> {
    const versions = await this.listVersions(assetId);
    return versions.find((v) => v.version === version) ?? null;
  }

  /** Compare：字段级差异 */
  async compare(assetId: string, fromVersion: number, toVersion: number): Promise<AssetDiff> {
    const from = await this.getVersion(assetId, fromVersion);
    const to = await this.getVersion(assetId, toVersion);
    if (!from) throw new Error(`版本不存在：${assetId} v${fromVersion}`);
    if (!to) throw new Error(`版本不存在：${assetId} v${toVersion}`);
    const fromSnap = from.snapshot;
    const toSnap = to.snapshot;
    const keys = new Set([...Object.keys(fromSnap), ...Object.keys(toSnap)]);
    const changes: AssetDiff['changes'] = [];
    const added: string[] = [];
    const removed: string[] = [];
    for (const key of keys) {
      const hasFrom = Object.prototype.hasOwnProperty.call(fromSnap, key);
      const hasTo = Object.prototype.hasOwnProperty.call(toSnap, key);
      if (!hasFrom) added.push(key);
      else if (!hasTo) removed.push(key);
      else if (JSON.stringify(fromSnap[key]) !== JSON.stringify(toSnap[key])) {
        changes.push({ key, from: fromSnap[key], to: toSnap[key] });
      }
    }
    return {
      assetType: from.assetType,
      assetId,
      fromVersion,
      toVersion,
      changed: changes.map((c) => c.key),
      added,
      removed,
      changes,
    };
  }

  /** Rollback：取指定版本快照（由调用方决定如何应用；本服务不直接改写资产） */
  async rollbackSnapshot(assetId: string, version: number): Promise<Record<string, unknown>> {
    const v = await this.getVersion(assetId, version);
    if (!v) throw new Error(`版本不存在：${assetId} v${version}`);
    return { ...v.snapshot };
  }

  async count(): Promise<number> {
    return this.repo.count();
  }
}
