// JSON 文件记忆实现：将记忆记录持久化到本地 JSON 文件。
// 结构：{ records: MemoryRecord[] }。
//
// 并发安全（短期方案，修复「固定 .tmp 多实例覆盖」）：
//   1. UUID 临时文件 + fsync + 原子 rename（writeAtomic）—— 实例间 tmp 永不共享；
//   2. 跨进程文件锁（withFileLock）—— read-merge-write 临界区串行化；
//   3. CAS：写前比对文件版本指纹，被其它实例修改过 → 重读合并（消灭「后写者整文件覆盖」丢更新）；
//   4. 损坏隔离：解析失败时把坏文件改名为 .corrupt-<ts> 留档排查，而非静默清空。
// 长期方向：SQLite / PostgreSQL（SqliteMemoryStore），接口不变（TestMemory）。
import fs from 'node:fs';
import { withFileLock, writeAtomic, fileVersion } from '../../utils/atomic-fs.js';
import type { MemoryRecord, MemoryQuery, TestMemory, FailureRecord } from './memory-store.js';
import {
  matchQuery,
  matchSimilarFailures,
  matchSimilarCase,
  matchHistoricalRisk,
  matchKnownIssue,
  matchCoverageGap,
} from './memory-matching.js';

/** JSON 文件记忆存储（并发安全写入） */
export class JsonMemoryStore implements TestMemory {
  private filePath: string;
  /** 最后已知快照（不含 pending） */
  private records: MemoryRecord[] = [];
  /** 已 save 但尚未落盘的新增记录（CAS 合并依据；查询时与快照合并可见） */
  private pending: MemoryRecord[] = [];
  /** 快照对应的文件版本指纹（CAS） */
  private version = 'missing';

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /** 全量可见记录（快照 + 未落盘 pending） */
  private all(): MemoryRecord[] {
    this.refreshIfChanged();
    return [...this.records, ...this.pending];
  }

  /** 让长生命周期实例也能看到其它进程已经提交的记录。 */
  private refreshIfChanged(): void {
    const current = fileVersion(this.filePath);
    if (current === this.version) return;
    const fresh = this.readAllSafe();
    const pendingById = new Set(this.pending.map((record) => record.id));
    this.records = fresh.filter((record) => !pendingById.has(record.id));
    this.version = fileVersion(this.filePath);
  }

  private load(): void {
    this.records = this.readAllSafe();
    this.version = fileVersion(this.filePath);
  }

  /** 读取全部记录；损坏时隔离坏文件（留档）并返回空集（不再静默丢数据无痕迹） */
  private readAllSafe(): MemoryRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      return Array.isArray(raw?.records) ? raw.records : [];
    } catch {
      const quarantined = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, quarantined);
      } catch { /* 隔离失败则按空处理 */ }
      return [];
    }
  }

  /**
   * 落盘（锁内 CAS 合并写）：
   * 锁内重比文件版本 → 被其它实例写过则重读合并 pending（按 id 去重，pending 优先）→
   * UUID tmp + fsync + 原子 rename → 更新版本指纹。
   */
  private async flush(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      // CAS：文件版本变化 = 其它实例已写入 → 重读合并，避免整文件覆盖丢更新
      let base = this.records;
      const actualVersion = fileVersion(this.filePath);
      if (actualVersion !== this.version) {
        base = this.readAllSafe();
      }
      // CAS merge：同 id 采用当前提交覆盖旧值，与 SQLite UPSERT 语义一致。
      const merged = new Map(base.map((record) => [record.id, record]));
      for (const record of this.pending) merged.set(record.id, record);
      const nextRecords = [...merged.values()];
      writeAtomic(this.filePath, `${JSON.stringify({ records: nextRecords }, null, 2)}\n`);
      this.records = nextRecords;
      this.version = fileVersion(this.filePath);
      this.pending = [];
    });
  }

  async save(record: MemoryRecord): Promise<void> {
    this.pending.push(record);
    await this.flush();
  }

  async query(query: MemoryQuery = {}): Promise<MemoryRecord[]> {
    return matchQuery(this.all(), query);
  }

  /** 相似失败检索：按类型（failure/root-cause）+ 标签 + 关键词匹配，按相似度降序 */
  async getSimilarFailures(failure: FailureRecord): Promise<MemoryRecord[]> {
    return matchSimilarFailures(this.all(), failure);
  }

  /** 全部记录数（调试用） */
  count(): number {
    return this.all().length;
  }

  /** 检索某用例的历史记录：data.caseId 精确匹配或标签命中，按时间倒序 */
  async querySimilarCase(caseId: string, limit = 20): Promise<MemoryRecord[]> {
    return matchSimilarCase(this.all(), caseId, limit);
  }

  /** 检索某功能的历史风险：失败 / 根因 / flaky 记录（按时间倒序） */
  async queryHistoricalRisk(feature: string, limit = 20): Promise<MemoryRecord[]> {
    return matchHistoricalRisk(this.all(), feature, limit);
  }

  /** 检索已知问题：缺陷 / 根因记录（可按功能过滤） */
  async queryKnownIssue(feature?: string, limit = 20): Promise<MemoryRecord[]> {
    return matchKnownIssue(this.all(), feature, limit);
  }

  /** 检索测试覆盖缺口：coverage-gap 记录（可按功能过滤） */
  async queryCoverageGap(feature?: string, limit = 50): Promise<MemoryRecord[]> {
    return matchCoverageGap(this.all(), feature, limit);
  }

  /** 清空（测试用；同样走锁 + 原子写） */
  async clear(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      this.records = [];
      this.pending = [];
      writeAtomic(this.filePath, `${JSON.stringify({ records: [] }, null, 2)}\n`);
      this.version = fileVersion(this.filePath);
    });
  }
}

/** 记忆持久化工厂：json（默认，并发安全）| sqlite（长期方向） */
export async function createPersistentMemory(opts: {
  kind?: 'json' | 'sqlite';
  path: string;
}): Promise<TestMemory> {
  const kind = opts.kind ?? (/\.(?:sqlite|db)$/i.test(opts.path) ? 'sqlite' : 'json');
  if (kind === 'sqlite') {
    const { SqliteMemoryStore } = await import('./sqlite-memory.js');
    return new SqliteMemoryStore(opts.path);
  }
  // JSON 保留调用方给出的原路径，兼容既有 --memory=<path> 行为。
  return new JsonMemoryStore(opts.path);
}
