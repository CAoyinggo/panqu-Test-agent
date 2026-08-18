// 平台备份/恢复（Phase 25.8）：全量快照导出与恢复
// collectSnapshot 遍历全部 15 集合原始记录导出为平台无关 JSON 快照；
// restoreSnapshot 校验版本 → 逐集合清空 → 批量写入（保留原 id）。
// 快照可落盘（backup 命令）也可在内存中恢复（restore 命令）。

import { ALL_COLLECTIONS } from './migrations.js';
import type { PlatformBundle } from '../service/factory.js';
import type { Entity } from '../storage/repository.js';
import type { ProjectCreateInput } from '../projects/project-schema.js';

/** 快照内单集合数据 */
export interface SnapshotStore {
  store: string;
  count: number;
  data: Entity[];
}

/** 平台全量快照（平台无关，可 JSON 序列化落盘） */
export interface PlatformSnapshot {
  version: 1;
  exportedAt: string;
  stores: SnapshotStore[];
}

const SNAPSHOT_VERSION = 1 as const;
/** projects 由 ProjectService/Registry 自持持久化（非 Repository），备份/恢复特殊处理 */
const PROJECT_STORE = 'projects';

/** 导出全量快照：15 集合原始记录（含 telemetry 真实数据；projects 走 registry） */
export async function collectSnapshot(bundle: PlatformBundle): Promise<PlatformSnapshot> {
  const stores: SnapshotStore[] = [];
  for (const collection of ALL_COLLECTIONS) {
    if (collection === PROJECT_STORE) {
      const data = bundle.projects.listProjects() as unknown as Entity[];
      stores.push({ store: collection, count: data.length, data });
      continue;
    }
    const repo = bundle.repositories[collection];
    if (!repo) {
      // 某集合未装配（理论上不会发生）；跳过并标记
      stores.push({ store: collection, count: 0, data: [] });
      continue;
    }
    const data = await repo.query({});
    stores.push({ store: collection, count: data.length, data });
  }
  return {
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    stores,
  };
}

/** 从快照恢复：校验版本 → 逐集合清空 → 批量写入（保留原 id） */
export async function restoreSnapshot(bundle: PlatformBundle, snapshot: PlatformSnapshot): Promise<{ restored: number; stores: number }> {
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(`快照版本不兼容：${snapshot.version}（期望 ${SNAPSHOT_VERSION}）`);
  }
  let restored = 0;
  let stores = 0;
  for (const store of snapshot.stores) {
    if (store.store === PROJECT_STORE) {
      // 清空 registry 后按快照重建项目（createProject 校验环境合法性）
      bundle.projects.registry.clear();
      for (const record of store.data) {
        bundle.projects.createProject(record as ProjectCreateInput);
        restored += 1;
      }
      stores += 1;
      continue;
    }
    const repo = bundle.repositories[store.store];
    if (!repo) continue;
    await repo.clear();
    for (const record of store.data) {
      await repo.create(record as Entity);
      restored += 1;
    }
    stores += 1;
  }
  return { restored, stores };
}

/** 快照统计摘要（CLI 展示） */
export function snapshotSummary(snapshot: PlatformSnapshot): Array<{ store: string; count: number }> {
  return snapshot.stores.map((s) => ({ store: s.store, count: s.count }));
}

/** 总记录数 */
export function snapshotTotal(snapshot: PlatformSnapshot): number {
  return snapshot.stores.reduce((acc, s) => acc + s.count, 0);
}
