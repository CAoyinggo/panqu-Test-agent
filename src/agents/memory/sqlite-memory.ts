// SQLite 记忆实现（JSON Memory → SQLite 的长期方向落地）。
// 动机：JSON 文件的并发写需要「UUID tmp + 文件锁 + CAS」三件套兜底（见 json-memory.ts）；
// SQLite（WAL 模式）天然提供事务级并发安全 —— 读写不阻塞、写写串行、崩溃恢复由日志保证。
// 接口与 JSON 实现完全一致（TestMemory），检索语义复用同一套匹配函数（memory-matching）。
// PostgreSQL：平台已有 pg 仓储基建（storage/postgres），升级路径相同 —— 换驱动保接口。
import type { DatabaseSync } from 'node:sqlite';
import { createSqliteDatabase } from '../../platform/storage/sqlite/database.js';
import type { MemoryRecord, MemoryQuery, TestMemory, FailureRecord } from './memory-store.js';
import {
  matchQuery,
  matchSimilarFailures,
  matchSimilarCase,
  matchHistoricalRisk,
  matchKnownIssue,
  matchCoverageGap,
} from './memory-matching.js';

/** 单表结构：id 主键 + 类型/时间/标签列（供 SQL 过滤）+ data JSON */
const SCHEMA = `CREATE TABLE IF NOT EXISTS memory_records (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  tags       TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_records_type_created
  ON memory_records(type, created_at DESC);`;

/** 行 → MemoryRecord */
function rowToRecord(row: { id: string; type: string; created_at: string; tags: string | null; data: string }): MemoryRecord {
  return {
    id: row.id,
    type: row.type as MemoryRecord['type'],
    createdAt: row.created_at,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

/** SQLite 记忆存储（WAL 并发安全；写事务串行化，无需文件锁/CAS） */
export class SqliteMemoryStore implements TestMemory {
  private readonly db: DatabaseSync;
  private readonly stmtInsert: ReturnType<DatabaseSync['prepare']>;

  constructor(file: string) {
    this.db = createSqliteDatabase(file);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.stmtInsert = this.db.prepare(
      `INSERT INTO memory_records (id, type, created_at, tags, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         created_at = excluded.created_at,
         tags = excluded.tags,
         data = excluded.data`,
    );
  }

  private write(stmt: () => void): void {
    this.db.exec('BEGIN IMMEDIATE;'); // 写事务：立刻取写锁，避免升级死锁
    try {
      stmt();
      this.db.exec('COMMIT;');
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    }
  }

  private loadAll(): MemoryRecord[] {
    const rows = this.db.prepare('SELECT id, type, created_at, tags, data FROM memory_records').all() as Array<Parameters<typeof rowToRecord>[0]>;
    return rows.map(rowToRecord);
  }

  async save(record: MemoryRecord): Promise<void> {
    this.write(() => {
      this.stmtInsert.run(
        record.id,
        record.type,
        record.createdAt,
        record.tags ? JSON.stringify(record.tags) : null,
        JSON.stringify(record.data),
      );
    });
  }

  async query(query: MemoryQuery = {}): Promise<MemoryRecord[]> {
    // type 过滤下推 SQL，其余（tags/时间窗/排序/limit）复用共享匹配逻辑
    let rows: Array<Parameters<typeof rowToRecord>[0]>;
    if (query.type) {
      rows = this.db
        .prepare('SELECT id, type, created_at, tags, data FROM memory_records WHERE type = ?')
        .all(query.type) as typeof rows;
    } else {
      rows = this.db
        .prepare('SELECT id, type, created_at, tags, data FROM memory_records')
        .all() as typeof rows;
    }
    return matchQuery(rows.map(rowToRecord), query);
  }

  async getSimilarFailures(failure: FailureRecord): Promise<MemoryRecord[]> {
    return matchSimilarFailures(this.loadAll(), failure);
  }

  async querySimilarCase(caseId: string, limit = 20): Promise<MemoryRecord[]> {
    return matchSimilarCase(this.loadAll(), caseId, limit);
  }

  async queryHistoricalRisk(feature: string, limit = 20): Promise<MemoryRecord[]> {
    return matchHistoricalRisk(this.loadAll(), feature, limit);
  }

  async queryKnownIssue(feature?: string, limit = 20): Promise<MemoryRecord[]> {
    return matchKnownIssue(this.loadAll(), feature, limit);
  }

  async queryCoverageGap(feature?: string, limit = 50): Promise<MemoryRecord[]> {
    return matchCoverageGap(this.loadAll(), feature, limit);
  }

  /** 全部记录数（调试用） */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get() as { n: number };
    return row.n;
  }

  /** 测试/运维清理；事务保证不会留下半清理状态。 */
  async clear(): Promise<void> {
    this.write(() => { this.db.exec('DELETE FROM memory_records;'); });
  }

  /** 关闭数据库连接（进程退出前调用；WAL 自动 checkpoint） */
  close(): void {
    this.db.close();
  }
}
