import fs from 'node:fs';
import path from 'node:path';
import type {
  LegacyAssetRecord,
  LegacyAssetStatus,
  LegacyAssetType,
  LegacyMigrationIndexData,
} from './types.js';

export const DEFAULT_MIGRATION_INDEX_PATH = path.resolve(process.cwd(), 'contracts/legacy-assets.json');

function normalizeAsset(asset: string): string {
  const absolute = path.resolve(asset);
  const root = path.resolve(process.cwd());
  let relative = path.relative(root, absolute).split(path.sep).join('/');
  if (relative.startsWith('dist/src/')) relative = `src/${relative.slice('dist/src/'.length)}`.replace(/\.js$/, '.ts');
  return relative;
}

function validateIndex(data: unknown): LegacyMigrationIndexData {
  if (!data || typeof data !== 'object' || !Array.isArray((data as LegacyMigrationIndexData).assets)) {
    throw new Error('Legacy Migration Index 无效：assets 必须是数组');
  }
  const index = data as LegacyMigrationIndexData;
  for (const asset of index.assets) {
    if (!asset.asset || !asset.type || !asset.status || !Array.isArray(asset.contracts) || !Array.isArray(asset.reasons)) {
      throw new Error(`Legacy Migration Index 记录无效：${asset.asset ?? 'unknown'}`);
    }
  }
  return index;
}

export class LegacyMigrationIndex {
  private readonly byAsset: Map<string, LegacyAssetRecord>;
  constructor(readonly data: LegacyMigrationIndexData) {
    validateIndex(data);
    this.byAsset = new Map(data.assets.map((asset) => [normalizeAsset(asset.asset), asset]));
  }

  get(asset: string): LegacyAssetRecord | undefined {
    const record = this.byAsset.get(normalizeAsset(asset));
    return record ? structuredClone(record) : undefined;
  }

  list(filter: { type?: LegacyAssetType; status?: LegacyAssetStatus } = {}): LegacyAssetRecord[] {
    return this.data.assets.filter((asset) => (!filter.type || asset.type === filter.type)
      && (!filter.status || asset.status === filter.status)).map((asset) => structuredClone(asset));
  }

  byContract(contractId: string): LegacyAssetRecord[] {
    return this.data.assets.filter((asset) => asset.contracts.some((dependency) => dependency.contractId === contractId))
      .map((asset) => structuredClone(asset));
  }

  statistics(): Record<LegacyAssetType, Record<LegacyAssetStatus, number>> {
    const types: LegacyAssetType[] = ['TaskDef', 'TypeScript Case', 'Catalog', 'Template', 'Hardcoded Generator'];
    const statuses: LegacyAssetStatus[] = ['ACTIVE', 'LEGACY', 'STALE', 'CONFLICT', 'UNKNOWN'];
    return Object.fromEntries(types.map((type) => [type, Object.fromEntries(statuses.map((status) => [
      status, this.data.assets.filter((asset) => asset.type === type && asset.status === status).length,
    ]))])) as Record<LegacyAssetType, Record<LegacyAssetStatus, number>>;
  }

  static load(file = DEFAULT_MIGRATION_INDEX_PATH): LegacyMigrationIndex {
    return new LegacyMigrationIndex(validateIndex(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }
}

let cached: LegacyMigrationIndex | undefined;
export function defaultLegacyMigrationIndex(): LegacyMigrationIndex {
  cached ??= LegacyMigrationIndex.load();
  return cached;
}
