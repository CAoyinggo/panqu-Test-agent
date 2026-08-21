// Phase 51.4：Evaluation 数据生命周期与可校验 Archive / Restore。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface RetentionPolicy {
  telemetryDays: number;
  evaluationDays: number;
  auditDays: number;
  benchmarkDays: number;
  groundTruthDays: number;
}

export type LifecycleTier = 'HOT' | 'WARM' | 'COLD' | 'ARCHIVED';
export type LifecycleDataKind = 'Telemetry' | 'EvaluationResult' | 'DecisionTrace' | 'Audit' | 'Benchmark' | 'GroundTruth';

export interface LifecycleRecord<T = unknown> {
  id: string;
  projectId: string;
  kind: LifecycleDataKind;
  traceId?: string;
  createdAt: string;
  tier: LifecycleTier;
  payload?: T;
  archivedAt?: string;
  archiveChecksum?: string;
  protected: boolean;
}

export interface ArchiveArtifact {
  schemaVersion: 1;
  createdAt: string;
  records: Array<LifecycleRecord>;
  checksum: string;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  telemetryDays: 90,
  evaluationDays: 180,
  auditDays: 2555,
  benchmarkDays: 2555,
  groundTruthDays: 2555,
};

const PROTECTED_KINDS = new Set<LifecycleDataKind>(['Audit', 'Benchmark', 'GroundTruth']);

export class DataLifecycleStore {
  private readonly records = new Map<string, LifecycleRecord>();

  add<T>(input: Omit<LifecycleRecord<T>, 'tier' | 'protected'> & { tier?: LifecycleTier }): LifecycleRecord<T> {
    if (this.records.has(input.id)) throw new Error(`Lifecycle record id 重复：${input.id}`);
    const record: LifecycleRecord<T> = {
      ...input,
      tier: input.tier ?? 'HOT',
      protected: PROTECTED_KINDS.has(input.kind),
    };
    this.records.set(record.id, record as LifecycleRecord);
    return clone(record);
  }

  get<T = unknown>(id: string): LifecycleRecord<T> | undefined {
    const record = this.records.get(id);
    return record ? clone(record as LifecycleRecord<T>) : undefined;
  }

  list(filter: { projectId?: string; kind?: LifecycleDataKind; tier?: LifecycleTier } = {}): LifecycleRecord[] {
    return [...this.records.values()]
      .filter((record) => !filter.projectId || record.projectId === filter.projectId)
      .filter((record) => !filter.kind || record.kind === filter.kind)
      .filter((record) => !filter.tier || record.tier === filter.tier)
      .map(clone);
  }

  applyRetention(policy: RetentionPolicy, now = new Date()): Record<LifecycleTier, number> {
    validatePolicy(policy);
    for (const record of this.records.values()) {
      if (record.tier === 'ARCHIVED') continue;
      const ageDays = Math.max(0, (now.getTime() - Date.parse(record.createdAt)) / 86_400_000);
      const retentionDays = retentionFor(record.kind, policy);
      record.tier = ageDays <= retentionDays / 4 ? 'HOT' : ageDays <= retentionDays / 2 ? 'WARM' : ageDays <= retentionDays ? 'COLD' : 'ARCHIVED';
      if (record.tier === 'ARCHIVED') record.archivedAt = now.toISOString();
    }
    return this.stats();
  }

  archive(filter: { projectId?: string; before?: Date; kinds?: LifecycleDataKind[] } = {}, now = new Date()): ArchiveArtifact {
    const selected = [...this.records.values()].filter((record) => {
      if (record.tier === 'ARCHIVED') return false;
      if (filter.projectId && record.projectId !== filter.projectId) return false;
      if (filter.before && Date.parse(record.createdAt) >= filter.before.getTime()) return false;
      return !filter.kinds || filter.kinds.includes(record.kind);
    });
    const archived = selected.map((record) => ({ ...clone(record), tier: 'ARCHIVED' as const, archivedAt: now.toISOString() }));
    const checksum = checksumRecords(archived);
    for (const record of selected) {
      record.tier = 'ARCHIVED';
      record.archivedAt = now.toISOString();
      record.archiveChecksum = checksum;
      // 详情明确显示 Archived；完整 payload 保留在 artifact，在线层只保留统计 metadata。
      delete record.payload;
    }
    return { schemaVersion: 1, createdAt: now.toISOString(), records: archived, checksum };
  }

  restore(artifact: ArchiveArtifact): { restored: number; unchanged: number } {
    if (artifact.schemaVersion !== 1 || checksumRecords(artifact.records) !== artifact.checksum) throw new Error('Archive checksum 校验失败');
    let restored = 0;
    let unchanged = 0;
    for (const archived of artifact.records) {
      const existing = this.records.get(archived.id);
      if (existing && existing.tier !== 'ARCHIVED') {
        unchanged += 1;
        continue;
      }
      this.records.set(archived.id, { ...clone(archived), tier: 'HOT', archivedAt: undefined, archiveChecksum: artifact.checksum });
      restored += 1;
    }
    return { restored, unchanged };
  }

  /** 普通清理仅能删除已归档的可再生成明细；合规数据永不由此路径删除。 */
  purgeArchived(ids: string[]): { purged: string[]; protected: string[] } {
    const purged: string[] = [];
    const protectedIds: string[] = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record || record.tier !== 'ARCHIVED') continue;
      if (record.protected) {
        protectedIds.push(id);
        continue;
      }
      this.records.delete(id);
      purged.push(id);
    }
    return { purged, protected: protectedIds };
  }

  stats(): Record<LifecycleTier, number> {
    const stats: Record<LifecycleTier, number> = { HOT: 0, WARM: 0, COLD: 0, ARCHIVED: 0 };
    for (const record of this.records.values()) stats[record.tier] += 1;
    return stats;
  }

  snapshot(): LifecycleRecord[] {
    return this.list();
  }

  static restoreSnapshot(records: LifecycleRecord[]): DataLifecycleStore {
    const store = new DataLifecycleStore();
    for (const record of records) store.records.set(record.id, clone(record));
    return store;
  }

  persist(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
    fs.renameSync(tmp, filePath);
  }

  static load(filePath: string): DataLifecycleStore {
    return fs.existsSync(filePath)
      ? DataLifecycleStore.restoreSnapshot(JSON.parse(fs.readFileSync(filePath, 'utf8')) as LifecycleRecord[])
      : new DataLifecycleStore();
  }
}

export function writeArchive(filePath: string, artifact: ArchiveArtifact): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(artifact, null, 2));
  fs.renameSync(tmp, filePath);
}

export function readArchive(filePath: string): ArchiveArtifact {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ArchiveArtifact;
}

function retentionFor(kind: LifecycleDataKind, policy: RetentionPolicy): number {
  switch (kind) {
    case 'Telemetry': return policy.telemetryDays;
    case 'EvaluationResult':
    case 'DecisionTrace': return policy.evaluationDays;
    case 'Audit': return policy.auditDays;
    case 'Benchmark': return policy.benchmarkDays;
    case 'GroundTruth': return policy.groundTruthDays;
  }
}

function validatePolicy(policy: RetentionPolicy): void {
  for (const [key, days] of Object.entries(policy)) {
    if (!Number.isFinite(days) || days <= 0) throw new Error(`Retention ${key} 必须大于 0 天`);
  }
}

function checksumRecords(records: LifecycleRecord[]): string {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
