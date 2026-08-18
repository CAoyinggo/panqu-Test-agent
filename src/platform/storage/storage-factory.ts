// Storage 工厂（Phase 24.2）：按类型创建可替换 Repository
// kind: memory | json（SQLite 未来按同一 Repository 接口接入）

import path from 'node:path';
import type { Entity, Repository } from './repository.js';
import { InMemoryRepository } from './memory-repository.js';
import { JsonRepository } from './json-repository.js';

export type StorageKind = 'memory' | 'json';

/** 创建 Repository（同一实体可在不同 kind 间无缝替换） */
export function createRepository<T extends Entity>(
  kind: StorageKind,
  opts: { collection: string; prefix?: string; dir?: string },
): Repository<T> {
  if (kind === 'json') {
    const dir = opts.dir ?? path.join(process.env.TESTFLOW_OUTPUT_DIR || 'output', 'platform', 'data');
    return new JsonRepository<T>(path.join(dir, `${opts.collection}.json`), opts.prefix ?? opts.collection);
  }
  return new InMemoryRepository<T>(opts.prefix ?? opts.collection);
}

export { Repository } from './repository.js';
export type { Entity, Query } from './repository.js';
