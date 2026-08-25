// Idempotency Store（Phase 24.7）：关键操作的幂等键去重
// 覆盖：重复 POST /runs、重复 Job、重复 Worker Consume、重复 Release Gate、
//       重复 Defect Create、重复 Knowledge Update。
// 同一 idempotencyKey 首次执行返回 created=true，之后返回既有结果。

import type { Entity, Repository } from '../storage/repository.js';

export interface IdempotencyRecord extends Entity {
  key: string;
  kind: string;
  resultId: string;
  status: 'IN_PROGRESS' | 'DONE';
  createdAt: string;
}

export interface IdempotencyOptions {
  now?: () => string;
}

export class IdempotencyStore {
  constructor(
    private readonly repo: Repository<IdempotencyRecord>,
    private readonly opts: IdempotencyOptions = {},
  ) {}

  private nowIso(): string {
    return this.opts.now ? this.opts.now() : new Date().toISOString();
  }

  /**
   * 若 key 已存在 → 返回 { repeated: true, resultId }
   * 否则创建占位并返回 { repeated: false, resultId: null }（调用方执行后调 complete 绑定结果）
   * 去重维度：kind + key（不同操作种类同 key 互不干扰）
   */
  async begin(kind: string, key: string): Promise<{ repeated: boolean; resultId: string | null }> {
    const existing = await this.repo.query({ kind, key });
    if (existing.length > 0) return { repeated: true, resultId: existing[0].resultId };
    await this.repo.create({
      id: `idem-${kind}-${key}`,
      key,
      kind,
      resultId: '',
      status: 'IN_PROGRESS',
      createdAt: this.nowIso(),
    });
    return { repeated: false, resultId: null };
  }

  /** 执行成功后绑定结果 id */
  async complete(kind: string, key: string, resultId: string): Promise<void> {
    const existing = await this.repo.query({ kind, key });
    if (existing.length === 0) {
      await this.repo.create({
        id: `idem-${kind}-${key}`,
        key,
        kind,
        resultId,
        status: 'DONE',
        createdAt: this.nowIso(),
      });
      return;
    }
    await this.repo.update(existing[0].id, { resultId, status: 'DONE' });
  }

  /** 操作在提交副作用前失败时释放占位，允许同一幂等键安全重试。 */
  async release(kind: string, key: string): Promise<void> {
    const existing = await this.repo.query({ kind, key });
    for (const record of existing) {
      if (record.status === 'IN_PROGRESS') await this.repo.delete(record.id);
    }
  }

  async has(kind: string, key: string): Promise<boolean> {
    const rows = await this.repo.query({ kind, key });
    return rows.length > 0;
  }

  async clear(): Promise<void> {
    await this.repo.clear();
  }
}
