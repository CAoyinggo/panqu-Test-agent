# Phase 25.1 SQLite Persistence 报告

## 一、目标与结论

将平台持久化从「Memory + JSON」升级为「Memory + JSON + SQLite」，CLI 默认 SQLite，
上层 Service 完全不感知底层存储类型（统一 `Repository<T>` 接口）。

**结论：25.1 完成。** 全部验收指标 PASS：

```text
npm test                  1230 PASS（新增 13）
agent:test                 450 PASS
platform:test              138 PASS（新增 sqlite.test.ts 10）
platform:integration        19 PASS（新增 sqlite-persistence.test.ts 3）
```

## 二、新增能力

### 1. `src/platform/storage/sqlite/database.ts`
- `createSqliteDatabase(file)`：`:memory:` 或文件路径；文件模式自动建目录并开启 WAL
- `ensureCollection(db, collection)`：`CREATE TABLE IF NOT EXISTS`（幂等），sanitizeIdent 防 SQL 注入
- `withTransaction(db, fn)` / `withTransactionSync(db, fn)`：异步 / 同步事务包装（失败回滚）

### 2. `src/platform/storage/sqlite/sqlite-repository.ts`
`SqliteRepository<T extends Entity> implements Repository<T>`：

```text
create / get / update / delete / query / count / clear
+ transaction（超出 Repository 接口的额外能力，不破坏兼容）
```

语义与 Memory / JSON 完全一致：顶层字段浅相等过滤 + limit/offset 分页。

### 3. `src/platform/storage/storage-factory.ts`
`StorageKind = 'memory' | 'json' | 'sqlite'`；`createRepository` 增加 sqlite 分支
（通过 `opts.db` 传入共享 `DatabaseSync` 连接）。

### 4. `src/platform/projects/project-registry.ts`
新增 `storage` / `sqliteDb` 选项：`load()` 从表读取、`save()` `INSERT OR REPLACE`、`clear()` 清表。
保持同步 API（DatabaseSync 为同步接口）。

### 5. `src/platform/service/factory.ts`
- 工厂统一 `store(collection)` 传入 `dir` + 共享 `db`，全部集合（runs/checkpoints/jobs/approvals/audit/idempotency）落到同一 `.sqlite` 文件
- 新增 `dataDir` 选项（测试隔离 / 生产自定义目录）

### 6. CLI（`bin/platform-cli.ts`）
- 默认 `sqlite`
- `STORAGE_BACKEND=json|memory|sqlite` 覆盖；旧别名 `PLATFORM_STORAGE` 仍兼容

### 7. 类型修复
`src/types/node-sqlite.d.ts`：`node:sqlite` 最小类型声明（@types/node 20.x 缺失；Node v26 运行时原生支持）。
已确认 `require('node:sqlite')` 运行时可用。

## 三、实体迁移覆盖

平台层当前接线到 SQLite 的集合：

```text
projects / runs / checkpoints / jobs / approvals / audit / idempotency
```

任务书列举的其余域实体（TestAsset / Defect / Knowledge / Decision / Cost / Quality / ReleaseDecision）
由 autonomous pipeline 内部模块管理（各自 Map + JSON 存储），不经过平台 `Repository<T>`。
SqliteRepository 为**泛型实现**，天然可承载任意实体集合，JSON→SQLite 迁移与备份/恢复在 25.8 落地时覆盖全部集合。

## 四、验证

- 单元：`tests/unit/sqlite.test.ts`（10 例：CRUD 语义 / 分页 / 冲突报错 / 跨实例持久化 / 事务提交回滚 / 工厂接入 / 集合共存 / sqliteDataFile）
- 集成：`tests/integration/sqlite-persistence.test.ts`（3 例：SQLite 全链路 / 数据跨工厂实例可恢复 / 三后端行为一致）
- CLI 冒烟：跨进程 `project create` → 新进程 `project list` 可见；`platform.sqlite` 含 7 集合
- 修复既有 flaky：Scheduler jobId 增加随机后缀，避免同毫秒重复入队撞 id

## 五、风险与说明

- Breaking Change：无。`Repository<T>` 接口未变；JSON / Memory 兼容层保留
- Production 风险：SQLite 为单机持久化；多进程并发写依赖 WAL（PostgreSQL 适配在 25.2 解决多机场景）
- 依赖：`node:sqlite` 需要 Node >= 22.5（本项目 Node v26，CI 需同步确认 Node 版本）
