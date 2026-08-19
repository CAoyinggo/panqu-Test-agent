// 平台备份/恢复（Phase 25.8 / 26.6）：全量快照导出与恢复
// collectSnapshot 遍历全部 16 集合原始记录导出为平台无关 JSON 快照（含内容指纹 checksum）；
// restoreSnapshot 校验版本 → 逐集合清空 → 批量写入（保留原 id）；
//   26.6 新增 noAutoRetrigger（默认 true）：恢复后遗留的 QUEUED/RETRY/RUNNING Job 置 CANCELLED，
//   禁止 Restore 后自动重触发历史队列。
// verifyRestore 对恢复后数据重新采集，校验 Count / Checksum / Key ID 一致性。
// 快照可落盘（backup 命令）也可在内存中恢复（restore 命令）。

import { createHash } from 'node:crypto';
import { ALL_COLLECTIONS } from './migrations.js';
import type { PlatformBundle } from '../service/factory.js';
import type { Entity } from '../storage/repository.js';
import type { Project } from '../projects/project-schema.js';

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
  /** 26.6：内容指纹（对 stores 数据按 id 稳定排序后 sha256），用于恢复后一致性校验 */
  checksum?: string;
}

const SNAPSHOT_VERSION = 1 as const;
/** projects 由 ProjectService/Registry 自持持久化（非 Repository），备份/恢复特殊处理 */
const PROJECT_STORE = 'projects';
/** 26.6：恢复后禁止自动重触发的 Job 状态（非终态） */
const NON_TERMINAL_JOB_STATUS = ['QUEUED', 'RETRY', 'RUNNING'];

/** 计算快照内容指纹：逐集合 data 按 id 稳定排序后序列化 sha256（不含 exportedAt/checksum） */
export function computeSnapshotChecksum(snapshot: PlatformSnapshot): string {
  const stable = snapshot.stores.map((s) => ({
    store: s.store,
    data: [...s.data].sort((a, b) =>
      String((a as { id?: string }).id ?? '').localeCompare(String((b as { id?: string }).id ?? '')),
    ),
  }));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

/** 导出全量快照：16 集合原始记录（含 telemetry 真实数据；projects 走 registry） */
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
  const snapshot: PlatformSnapshot = {
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    stores,
  };
  snapshot.checksum = computeSnapshotChecksum(snapshot);
  return snapshot;
}

export interface RestoreResult {
  restored: number;
  stores: number;
  /** 26.6：Restore 后置 CANCELLED 的遗留 Job 数（禁止自动重触发） */
  cancelledJobs: number;
}

/**
 * 从快照恢复：校验版本 → 逐集合清空 → 批量写入（保留原 id）。
 * 26.6 noAutoRetrigger（默认 true）：恢复 jobs 集合时，遗留的 QUEUED/RETRY/RUNNING Job 置 CANCELLED
 * （error=restored-no-auto-retrigger），保证 Restore 后历史队列不会被自动重新触发。
 */
export async function restoreSnapshot(
  bundle: PlatformBundle,
  snapshot: PlatformSnapshot,
  opts: { noAutoRetrigger?: boolean } = {},
): Promise<RestoreResult> {
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(`快照版本不兼容：${snapshot.version}（期望 ${SNAPSHOT_VERSION}）`);
  }
  const noAutoRetrigger = opts.noAutoRetrigger ?? true;
  let restored = 0;
  let stores = 0;
  let cancelledJobs = 0;
  for (const store of snapshot.stores) {
    if (store.store === PROJECT_STORE) {
      // 清空 registry 后按快照注入项目（importAll 保留原 id / createdAt / updatedAt，保证 Checksum 一致）
      bundle.projects.registry.clear();
      bundle.projects.registry.importAll(store.data as Project[]);
      restored += store.data.length;
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
    // 26.6：jobs 集合恢复后禁止自动重触发（遗留非终态 Job 置 CANCELLED）
    if (store.store === 'jobs' && noAutoRetrigger) {
      for (const record of store.data) {
        const status = (record as { status?: string }).status ?? '';
        if (NON_TERMINAL_JOB_STATUS.includes(status)) {
          await repo.update((record as { id: string }).id, {
            status: 'CANCELLED',
            error: 'restored-no-auto-retrigger',
            updatedAt: new Date().toISOString(),
          });
          cancelledJobs += 1;
        }
      }
    }
    stores += 1;
  }
  return { restored, stores, cancelledJobs };
}

/** 恢复一致性校验：对恢复后的 bundle 重新采集，比对 Count / Checksum / Key ID。
 * normalizeAutoRetrigger（默认 true）：计算 Checksum 前，把因「禁止自动重触发」合法置 CANCELLED
 * （error=restored-no-auto-retrigger）的 Job 记录还原为快照原值——该差异是有意的行为变更而非数据损坏，
 * 归一化后 Checksum 一致才能证明其余数据（Count / Key ID / 内容）未丢失、未篡改。 */
export async function verifyRestore(
  bundle: PlatformBundle,
  snapshot: PlatformSnapshot,
  opts: { normalizeAutoRetrigger?: boolean } = {},
): Promise<{
  ok: boolean;
  countBefore: number;
  countAfter: number;
  countMatch: boolean;
  checksumBefore: string;
  checksumAfter: string;
  checksumMatch: boolean;
  idMismatch: string[];
  cancelledJobs: number;
}> {
  const normalize = opts.normalizeAutoRetrigger ?? true;
  const after = await collectSnapshot(bundle);
  const cancelledJobs = after.stores
    .find((s) => s.store === 'jobs')
    ?.data.filter((d) => (d as { error?: string }).error === 'restored-no-auto-retrigger').length ?? 0;
  if (normalize) {
    const snapJobs = snapshot.stores.find((s) => s.store === 'jobs');
    const afterJobs = after.stores.find((s) => s.store === 'jobs');
    if (snapJobs && afterJobs) {
      const snapById = new Map(snapJobs.data.map((d) => [String((d as { id?: string }).id), d]));
      afterJobs.data = afterJobs.data.map((d) =>
        (d as { error?: string }).error === 'restored-no-auto-retrigger'
          ? (snapById.get(String((d as { id?: string }).id)) ?? d)
          : d,
      );
    }
  }
  const countBefore = snapshotTotal(snapshot);
  const countAfter = snapshotTotal(after);
  const countMatch = countBefore === countAfter;
  const checksumBefore = computeSnapshotChecksum(snapshot);
  const checksumAfter = computeSnapshotChecksum(after);
  const checksumMatch = checksumBefore === checksumAfter;
  const idMismatch: string[] = [];
  for (const s of snapshot.stores) {
    const a = after.stores.find((x) => x.store === s.store);
    if (!a) {
      idMismatch.push(`${s.store}:missing-after`);
      continue;
    }
    const idsB = new Set(s.data.map((d) => (d as { id?: string }).id));
    const idsA = new Set(a.data.map((d) => (d as { id?: string }).id));
    if (idsB.size !== idsA.size || ![...idsB].every((id) => idsA.has(id))) {
      idMismatch.push(`${s.store}:${idsB.size}->${idsA.size}`);
    }
  }
  const ok = countMatch && checksumMatch && idMismatch.length === 0;
  return {
    ok,
    countBefore,
    countAfter,
    countMatch,
    checksumBefore,
    checksumAfter,
    checksumMatch,
    idMismatch,
    cancelledJobs,
  };
}

/** 快照统计摘要（CLI 展示） */
export function snapshotSummary(snapshot: PlatformSnapshot): Array<{ store: string; count: number }> {
  return snapshot.stores.map((s) => ({ store: s.store, count: s.count }));
}

/** 总记录数 */
export function snapshotTotal(snapshot: PlatformSnapshot): number {
  return snapshot.stores.reduce((acc, s) => acc + s.count, 0);
}
