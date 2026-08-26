# Phase 25.8 Production Readiness 报告

## 一、目标与结论

25.8 是 Phase 25 的收官阶段，把平台从"功能完备"提升为"可长期运行的生产系统"：
**preflight（上线前自检）/ health（健康检查增强）/ smoke（真实运营闭环冒烟）/ migrate（schema 迁移）/ backup（全量备份）/ restore（全量恢复）** 六项运维能力全套落地。

```text
migrate  迁移框架：15 集合 schema 版本管理（_migrations 表幂等）→ 工厂启动自动应用 + CLI 手动执行
preflight  上线自检：Node / 构建 / SQLite / PostgreSQL / 环境变量 / 迁移状态 / 敏感信息扫描
smoke      冒烟：临时 SQLite → 真实 Run → 派发 → COMPLETED → 断言真实遥测/成本/激活
backup     全量快照：15 集合（含 projects registry）导出为平台无关 JSON
restore    恢复：版本校验 → 清空 → 批量写入（保留原 id）
health     增强：新增 audit / telemetry / activation 检查项（原有 5 项不变）
```

**结论：25.8 完成。** 全部验收指标 PASS：

```text
npm run build + copy-assets     成功
npm run platform:test           208 PASS（新增 production-ops 3）
npm run platform:integration     64 PASS（新增 production-readiness 4）
npm test                       1349 PASS（新增 7）
npm run agent:test              450 PASS
CLI 冒烟：migrate 幂等 / backup-restore 闭环 / smoke 全 PASS / preflight 无 BLOCK / health 增强
```

## 二、迁移框架（`src/platform/ops/migrations.ts`）

- `ALL_COLLECTIONS`：15 集合（projects / runs / checkpoints / jobs / approvals / audit / idempotency / users / telemetry-events / cost-ledger / rca-verifications / flaky-records / healing-records / release-records / metric-activations），与 factory 装配一一对应
- `Migration { id, name, apply }` + `MIGRATIONS`（v1 base-schema：建全部集合表）
- SQLite 同步迁移：`_migrations` 表记录 `id/name/applied_at`；重复应用幂等（返回本次应用的 id）
- PostgreSQL 异步迁移：同样幂等；v1 apply 为 async，sqlite 同步建表、postgres `await` 建表（无竞态）
- 接线：`createPlatformService` 启动即应用未执行迁移（sqlite 同步、postgres 异步 catch 不阻塞）；CLI `migrate sqlite|postgres|check` 供运维手动执行与检查

## 三、备份 / 恢复（`src/platform/ops/backup.ts`）

- `collectSnapshot`：遍历 15 集合导出原始记录；**projects 由 ProjectRegistry 自持持久化（非 Repository），走 `bundle.projects.listProjects()` 特殊处理**（修复早期快照 projects=0 的缺陷）
- `restoreSnapshot`：版本校验（不兼容拒绝）→ 逐集合清空 → 批量写入（保留原 id；projects 经 registry.clear + createProject 重建）
- CLI：`backup save <file.json>` / `backup restore <file.json>` / `backup summary`
- 为支撑原始仓库访问，`PlatformBundle` 新增 `repositories: Record<string, Repository<Entity>>`（15 集合 → Repository，factory 装配时登记）

## 四、冒烟（`src/platform/ops/smoke.ts`）

- 独立临时 SQLite 数据目录（不污染生产数据），完成后自动清理
- 真实运营闭环：创建平台 → 注册真实 Worker（Mock LLM 经遥测装饰器）→ 创建 Run → 派发至 COMPLETED → 断言遥测事件 / 成本账本（>0）/ 指标激活（≥2）
- CLI `smoke` 命令（失败置退出码 1）；可独立运行（`node dist/src/platform/ops/smoke.js`）

## 五、Preflight（`src/platform/ops/preflight.ts`）

- 检查项：Node 版本（≥20.11）/ 平台构建产物 / SQLite 可写 / PostgreSQL 可连接（尽力而为 WARN）/ 迁移状态 / 环境变量（production 强制 JWT_SECRET）/ 敏感信息扫描（复用 Agent 侧模式）
- 分级：`PASS / WARN / BLOCK`，仅 BLOCK 阻断退出码；CLI `preflight [--json] [--check-postgres]`

## 六、健康检查增强（`src/platform/service/platform-service.ts`）

- `health()` 保留原 5 项（projects/runs/scheduler/workers/approvals），新增 **audit / telemetry（事件+成本）/ activation（指标激活）** 三项存储连通性检查
- CLI `platform health` / API `/health` 输出同步增强

## 七、测试

### 单元（`tests/unit/production-ops.test.ts`，3 例）
- v1 迁移建立全部集合表，`_migrations` 幂等记录
- 快照版本不匹配拒绝恢复；快照计数汇总
- Preflight 汇总：仅 BLOCK 阻断，WARN 不阻断

### 集成（`tests/integration/production-readiness.test.ts`，4 例）
- SQLite 迁移幂等：首次全部应用、二次为空、集合表可写
- 备份/恢复闭环：15 集合全量导出、恢复后计数与 runId 一致、projects registry 恢复
- 冒烟：Run COMPLETED + 遥测事件 + 成本账本 + 指标激活全断言
- Preflight：正常环境无 BLOCK

## 八、CLI 冒烟实录

```text
migrate check    → total 1 / sqlite applied [v1]（postgres 不可连接跳过，不阻断）
migrate sqlite   → 二次执行 appliedNow []（幂等）
smoke            → 6 事件 / 2 成本 ¥0.0001 / 2 指标激活 / COMPLETED / exit 0
backup save      → 15 stores / 22 条（projects=1）
backup restore   → restored 22 / stores 15，恢复后计数一致
preflight --json → 5 PASS / 1 WARN（迁移状态）/ 0 BLOCK
platform health  → ok，含 audit:2 条 / telemetry:12 事件 4 成本 / activation:2 指标激活
```

## 九、风险与说明

- Breaking Change：`PlatformBundle` 新增 `repositories` 字段（增量，不破坏既有消费方）；`health()` 返回 checks 数组新增 3 项（兼容）
- 备份为逻辑快照（JSON），适合中小数据量；超大库建议后续叠加物理备份/增量
- 强约束满足：未虚构 Metrics、未把 Mock 当生产数据、未默认关闭鉴权；preflight 在 production 模式强制 JWT_SECRET
