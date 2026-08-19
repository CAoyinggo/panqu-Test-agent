// Storage 模块导出（Phase 24.2 / 25.1）

export * from './repository.js';
export * from './memory-repository.js';
export * from './json-repository.js';
// sqlite / postgres 均导出 ensureCollection / withTransaction，需显式重导出消歧
export { SqliteRepository, createSqliteDatabase, sqliteDataFile, withTransaction as sqliteWithTransaction, ensureCollection as sqliteEnsureCollection } from './sqlite/index.js';
export { PostgresRepository, collectionTableSql, withTransaction as pgWithTransaction, ensureCollection as pgEnsureCollection } from './postgres/index.js';
export * from './storage-factory.js';
export * from './faulty-repository.js';
