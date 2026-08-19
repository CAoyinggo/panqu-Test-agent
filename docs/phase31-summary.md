# Phase 31 总结：迁移 down / 回滚（Migration Rollback）

> 版本：v4.7.0 ｜ 日期：2026-08-19 ｜ 模式：持续自主开发（CONTINUOUS AUTONOMOUS DEVELOPMENT）

## 一、目标

解决 DEBT-09（P1）：为 schema 迁移框架补齐 down / 回滚路径——`Migration` 此前只有 `apply`（up）没有 `revert`（down），升级后无法回退到旧 schema；验证 backup→migrate→rollback→restore 完整链（phase30-summary 下一阶段建议 1）。

## 二、扫描发现

| 项 | 现状 | 处置 |
|---|---|---|
| Migration 接口只有 `apply` | 迁移只能单向应用，无 down 路径 | 本阶段新增 `revert` |
| 回滚目标语义未定义 | 若允许任意跳级回滚，会造成 schema/数据部分不一致 | `resolveRevertTarget` 仅允许回滚最新已应用迁移 |
| `_migrations` 表 | 记录已应用迁移 id/name/applied_at，回滚后应同步删除记录 | 回滚流程删除记录，表本身保留为基础设施 |
| 回滚安全性 | 回滚会删除集合表（含数据），需保证可恢复 | 集成测试验证 backup→migrate→rollback→restore 闭环 |

## 三、实施内容

### 31.1 回滚核心（`src/platform/ops/migrations.ts`）

- `Migration` 接口新增可选 `revert?: (ctx) => void | Promise<void>`（down 实现）。
- `v1/base-schema` 增加 `revert`：循环 `ALL_COLLECTIONS` 执行 `DROP TABLE IF EXISTS`（sqlite 同步 / pool 异步，幂等：表不存在忽略）。
- 新增 `resolveRevertTarget(applied, targetId?)`：
  - 无已应用迁移 → `null`（无可回滚）；
  - 未指定 `targetId` → 取最新已应用迁移；
  - 指定 `targetId` → 必须是最新已应用迁移（**禁止跳级回滚**，避免部分回滚造成 schema/数据不一致）；
  - 目标迁移必须存在且实现 `revert`，否则抛错（防御：迁移不可回滚时显式失败而非静默）。
- 新增 `revertSqliteMigration(db, targetId?)` / `revertPostgresMigration(pool, targetId?)`：解析目标 → 执行 `revert` → 同步删除 `_migrations` 记录 → 返回回滚迁移 id；无可回滚返回 `null`。回滚后迁移可再次 `apply` 恢复。

### 31.2 CLI `migrate down` 子命令（`bin/platform-cli.ts`）

- `migrate down check`：展示 sqlite / postgres 两端最新已应用（latestApplied）与已应用列表（applied），以及是否可回滚（rollbackable）。
- `migrate down sqlite [--id <id>]`：调用 `revertSqliteMigration`，回滚后输出回滚的迁移 id；`null` 时输出「无已应用迁移可回滚」。
- `migrate down postgres [--id <id>]`：调用 `revertPostgresMigration`（`createPostgresPool()` 连接），同上。

## 四、修改 / 新增文件

- 新增：`tests/unit/migrations-down.test.ts`（5 项）、`tests/integration/migrations-rollback.test.ts`（2 项）、`docs/phase31-summary.md`。
- 修改：`src/platform/ops/migrations.ts`（`revert` + `resolveRevertTarget` + 回滚函数）、`bin/platform-cli.ts`（`migrate down`）、`package.json`（v4.7.0 + phase31:test）、`src/platform/version.ts`（4.7.0）、`package-lock.json`、`README.md`、`CHANGELOG.md`、`docs/TECH-DEBT.md`（DEBT-09 已解决）、`tests/unit/platform-coverage-gap.test.ts`（通知通道 send 返回类型修复）。

## 五、测试与验收

| 项 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | 通过（修复 TS2722 / TS2322 后） |
| 迁移 down 单元套件 | `npx vitest run tests/unit/migrations-down.test.ts` | 5 项通过 |
| 回滚闭环集成套件 | `npx vitest run tests/integration/migrations-rollback.test.ts` | 2 项通过 |
| 全量回归 | `npm test` | **1452 passed / 18 skipped**（125 个测试文件） |

单元测试覆盖：SQLite apply→revert→再 apply 闭环、无已应用返回 null、`resolveRevertTarget` 空→null / 指定非最新→throw / latest 不存在→throw、mock Pool 回滚（DROP 全部集合表 + DELETE 记录）、Postgres 空态返回 null。

集成测试（真实 SQLite 数据目录）覆盖 backup→migrate→rollback→restore 完整闭环：

1. `collectSnapshot` 备份升级前数据；
2. `revertSqliteMigration` 回滚：全部集合表消失 + `_migrations` 记录删除；
3. 重新 `applySqliteMigrations` 恢复 schema；
4. `restoreSnapshot` + `verifyRestore` 三一致校验（Count / Checksum / Key ID 全部一致）；
5. `_migrations` 表本身保留（仅记录删除），回滚后 schema 可再次升级。

**结论**：只要升级前有备份，迁移回滚不会造成数据永久丢失。

## 六、性能 / 安全 / 兼容性

- **性能**：新增回滚逻辑仅在 CLI 显式触发时执行，不影响正常迁移与运行路径。
- **安全**：回滚为破坏性操作（删除集合表），通过 `resolveRevertTarget` 强制只回滚最新迁移、目标必须实现 `revert`、集成测试闭环验证可恢复性；CLI 命令需运维权限执行。
- **兼容性**：`Migration.revert` 为可选新增（向后兼容，不实现 revert 的迁移仅不可回滚）；无公共 API 破坏；`_migrations` 表保留为基础设施。

## 七、遗留问题与下一阶段建议

1. **Phase 32 变异测试（DEBT-07，P0）**：引入 Stryker 或等价变异工具，建立 Critical 变异阈值（`mutationScore` 门禁），验证既有测试对关键逻辑（Run 状态机 / 审批门禁 / 生产安全 / 恢复流程）的防护能力。
2. 持续开放：DEBT-01（双环境策略源）、DEBT-05（assertion-visualizer）、DEBT-11/12/13。
