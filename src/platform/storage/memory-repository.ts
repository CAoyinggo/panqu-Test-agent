// In-Memory Repository（Phase 24.2）：进程内实现，测试与单机模式使用

import {
  generateEntityId,
  type Entity,
  type Repository,
} from './repository.js';
import { CodedError, ErrorCode } from '../../core/errors.js';

export class InMemoryRepository<T extends Entity> implements Repository<T> {
  protected items = new Map<string, T>();

  constructor(private readonly prefix = 'ent') {}

  async create(input: Omit<T, 'id'> & { id?: string }): Promise<T> {
    const id = input.id ?? generateEntityId(this.prefix);
    if (this.items.has(id)) throw new CodedError(ErrorCode.CONFLICT, `实体已存在：${id}`);
    const entity = { ...(input as object), id } as T;
    this.items.set(id, entity);
    return entity;
  }

  async get(id: string): Promise<T | null> {
    return this.items.get(id) ?? null;
  }

  async update(id: string, input: Partial<Omit<T, 'id'>>): Promise<T> {
    const cur = this.items.get(id);
    if (!cur) throw new CodedError(ErrorCode.NOT_FOUND, `实体不存在：${id}`);
    const next = { ...cur, ...input, id } as T;
    this.items.set(id, next);
    return next;
  }

  async delete(id: string): Promise<void> {
    if (!this.items.delete(id)) throw new CodedError(ErrorCode.NOT_FOUND, `实体不存在：${id}`);
  }

  async query(filter?: Partial<T>, q?: { limit?: number; offset?: number }): Promise<T[]> {
    let rows = [...this.items.values()];
    if (filter) {
      rows = rows.filter((r) =>
        Object.entries(filter).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
      );
    }
    const offset = q?.offset ?? 0;
    const limit = q?.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }

  async count(): Promise<number> {
    return this.items.size;
  }

  async clear(): Promise<void> {
    this.items.clear();
  }
}
