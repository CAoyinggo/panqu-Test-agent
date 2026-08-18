# Phase 25.2 PostgreSQL Adapter 报告

## 一、目标与结论

在保持 `Repository<T>` 接口不变的前提下，新增 PostgreSQL 后端，使上层 Service
完全不感知底层数据库类型。第一阶段完成：连接 / 迁移 / CRUD / 事务 / 分页 / 查询。

**结论：25.2 完成。** 全部验收指标 PASS：

```text
npm test                  1246 PASS（新增 16：postgres 12 + pg-mem infra 3 + sqlite 微调）
agent:test                 450 PASS
```

## 二、新增能力

### 1. `src/platform/storage/postgres/pg-database.ts`
- `createPostgresPool(opts)`：基于 node-postgres（pg）连接池；连接串取 `DATABASE_URL`
  （默认 `postgres://postgres:postgres@localhost:5432/postgres`）
- `ensureCollection(pool, collection)`：`CREATE TABLE IF NOT EXISTS "x" (id TEXT PRIMARY KEY, data JSONB NOT NULL)`
  幂等迁移；sanitizeIdent 防 SQL 注入
- `withTransaction(pool, fn)`：异步事务包装（BEGIN/COMMIT/ROLLBACK）

### 2. `src/platform/storage/postgres/postgres-repository.ts`
`PostgresRepository<T extends Entity> implements Repository<T>`：

```text
create / get / update / delete / query / count / clear
+ transaction（超出 Repository 接口的额外能力，不破坏兼容）
```

语义与 Memory / JSON / SQLite 完全一致：顶层字段浅相等过滤 + limit/offset 分页。
唯一键冲突（duplicate key）转「实体已存在」中文错误，与其余后端一致。

**事务正确性**：Postgres 连接池下每个查询可能走不同连接，`BEGIN` 无法包裹 Repository
内部查询。实现采用「事务期间专用连接（txClient）路由」：`transaction()` 从池中取出一
个专用连接，期间所有查询（create/update/delete/count/get）均走该连接，确保原子性，
失败整体回滚，结束释放连接。

### 3. `src/platform/storage/storage-factory.ts`
`StorageKind = 'memory' | 'json' | 'sqlite' | 'postgres'`；`createRepository` 增加 postgres
分支（通过 `opts.pool` 传入共享 `pg.Pool`）。

### 4. `src/platform/service/factory.ts`
`storage === 'postgres'` 时创建共享 `pgPool`，`store(collection)` 传入 `pool`，
全部集合（runs/checkpoints/jobs/approvals/audit/idempotency）落到同一 Postgres 库。

### 5. CLI（`bin/platform-cli.ts`）
`STORAGE_BACKEND=postgres` 支持；`DATABASE_URL` 由 `pg` 连接池读取。

### 6. 依赖
新增：`pg`（运行时）、`@types/pg`（dev）、`pg-mem`（dev，测试基础设施）。

## 三、测试策略与 pg-mem 局限

| 关注点 | 测试手段 | 说明 |
| --- | --- | --- |
| CRUD / 分页 / 冲突 / 迁移 / 工厂 | pg-mem（内存 Postgres） | 真实 SQL 解析，验证 SQL 正确性 |
| 事务（BEGIN/COMMIT/ROLLBACK 语义） | 自研 fake Pool | pg-mem 3.x 对 ROLLBACK 为 no-op，无法验证回滚 |
| 事务内 txClient 路由 | fake Pool 验证「事务内冲突 → 全部回滚」 | 验证 PostgresRepository 事务实现正确性 |

**pg-mem 已知局限（已记录于 `tests/unit/_pgmem-infra.test.ts`）**：
- 对「已存在表再次 `CREATE TABLE IF NOT EXISTS`」的 AST planner 抛错——真实 Postgres 完全幂等，
  仅影响 pg-mem 模拟，不影响 `ensureCollection` 在真实 Postgres 上的幂等性
- ROLLBACK 为 no-op——事务语义测试用自研 fake Pool 覆盖

## 四、验证

- 单元：`tests/unit/postgres.test.ts`（12 例：CRUD 语义 / 分页 / 冲突报错 / 迁移 / 工厂接入 /
  后端一致性 / 事务提交 / 事务回滚 / 事务内冲突回滚）
- 基础设施：`tests/unit/_pgmem-infra.test.ts`（3 例：pg-mem 能力 + 局限记录 + CRUD 语义验证）
- 全量：`npm test` 1246 PASS、`agent:test` 450 PASS

## 五、风险与说明

- Breaking Change：无。`Repository<T>` 接口未变；JSON / Memory / SQLite 兼容层保留
- 未提供真实 Postgres 服务器集成测试（本地无 PG 服务）；pg-mem 覆盖 SQL 语义，真实连接
  测试待 25.8 production:integration 或 CI 提供 DATABASE_URL 时补充
- 事务实现为 Postgres 特有（SQLite 用共享连接 BEGIN），但均封装在 Repository 内部，
  Service 层无感知
- 强约束满足：未重写 Repository 接口、未破坏 Phase 24 API、JSON / Memory 兼容层保留
