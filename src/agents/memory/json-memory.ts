// JSON 文件记忆实现：将记忆记录持久化到本地 JSON 文件（第一阶段方案）
// 结构：{ records: MemoryRecord[] }，追加式写入 + 原子替换。
// 后续可替换为 SQLite / 向量库，只需实现 TestMemory 接口。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../../utils/fs-utils.js';
import type { MemoryRecord, MemoryQuery, TestMemory, FailureRecord } from './memory-store.js';

/** JSON 文件记忆存储 */
export class JsonMemoryStore implements TestMemory {
  private filePath: string;
  private records: MemoryRecord[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        this.records = Array.isArray(raw?.records) ? raw.records : [];
      }
    } catch {
      // 文件损坏时重置为空
      this.records = [];
    }
  }

  private persist(): void {
    ensureDir(path.dirname(this.filePath));
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ records: this.records }, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  async save(record: MemoryRecord): Promise<void> {
    this.records.push(record);
    this.persist();
  }

  async query(query: MemoryQuery = {}): Promise<MemoryRecord[]> {
    let out = this.records;
    if (query.type) out = out.filter((r) => r.type === query.type);
    if (query.tags && query.tags.length) {
      out = out.filter((r) => query.tags!.every((t) => r.tags?.includes(t)));
    }
    if (query.from) out = out.filter((r) => r.createdAt >= query.from!);
    if (query.to) out = out.filter((r) => r.createdAt <= query.to!);
    // 按时间倒序
    out = [...out].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (query.limit) out = out.slice(0, query.limit);
    return out;
  }

  /** 相似失败检索：按类型（failure/root-cause）+ 标签 + 关键词匹配，按相似度降序 */
  async getSimilarFailures(failure: FailureRecord): Promise<MemoryRecord[]> {
    const keywords = [failure.category, failure.caseId, failure.message]
      .filter(Boolean)
      .map((s) => (s as string).toLowerCase());
    const failureTags = failure.tags ?? [];

    const scored = this.records
      .filter((r) => r.type === 'failure' || r.type === 'root-cause' || r.type === 'flaky')
      .map((r) => {
        let score = 0;
        // 标签命中
        for (const t of failureTags) {
          if (r.tags?.includes(t)) score += 3;
        }
        // 关键词命中（data 序列化后模糊匹配）
        const blob = JSON.stringify(r.data).toLowerCase();
        for (const kw of keywords) {
          if (kw && blob.includes(kw)) score += 2;
        }
        // 同 caseId 命中
        if (r.data.caseId && failure.caseId && String(r.data.caseId) === String(failure.caseId)) score += 5;
        return { record: r, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.map((x) => x.record).slice(0, 10);
  }

  /** 全部记录数（调试用） */
  count(): number {
    return this.records.length;
  }

  /** 检索某用例的历史记录：data.caseId 精确匹配或标签命中，按时间倒序 */
  async querySimilarCase(caseId: string, limit = 20): Promise<MemoryRecord[]> {
    const id = String(caseId).toLowerCase();
    const matches = this.records.filter((r) => {
      if (String(r.data.caseId ?? '').toLowerCase() === id) return true;
      if (Array.isArray(r.data.caseIds) && r.data.caseIds.some((c) => String(c).toLowerCase() === id)) return true;
      return r.tags?.some((t) => t.toLowerCase() === id) ?? false;
    });
    return this.sortByTime(matches).slice(0, limit);
  }

  /** 检索某功能的历史风险：失败 / 根因 / flaky 记录（按时间倒序） */
  async queryHistoricalRisk(feature: string, limit = 20): Promise<MemoryRecord[]> {
    const f = feature.toLowerCase();
    const matches = this.records.filter((r) => {
      if (r.type !== 'failure' && r.type !== 'root-cause' && r.type !== 'flaky') return false;
      return String(r.data.feature ?? r.data.module ?? '').toLowerCase() === f || r.tags?.includes(f);
    });
    return this.sortByTime(matches).slice(0, limit);
  }

  /** 检索已知问题：缺陷 / 根因记录（可按功能过滤） */
  async queryKnownIssue(feature?: string, limit = 20): Promise<MemoryRecord[]> {
    const matches = this.records.filter((r) => {
      if (r.type !== 'defect' && r.type !== 'root-cause') return false;
      if (feature) {
        const f = feature.toLowerCase();
        return String(r.data.feature ?? '').toLowerCase() === f || r.tags?.includes(f);
      }
      return true;
    });
    return this.sortByTime(matches).slice(0, limit);
  }

  /** 检索测试覆盖缺口：coverage-gap 记录（可按功能过滤） */
  async queryCoverageGap(feature?: string, limit = 50): Promise<MemoryRecord[]> {
    const matches = this.records.filter((r) => {
      if (r.type !== 'coverage-gap') return false;
      if (feature) {
        const f = feature.toLowerCase();
        return String(r.data.feature ?? '').toLowerCase() === f || r.tags?.includes(f);
      }
      return true;
    });
    return this.sortByTime(matches).slice(0, limit);
  }

  /** 按 createdAt 倒序（无时间戳的记录排末尾） */
  private sortByTime(records: MemoryRecord[]): MemoryRecord[] {
    return [...records].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }

  /** 清空（测试用） */
  clear(): void {
    this.records = [];
    this.persist();
  }
}
