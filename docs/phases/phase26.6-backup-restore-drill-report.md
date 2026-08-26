# Phase 26.6 Backup / Restore Drill — 阶段报告

> 阶段：26.6 / 8
> 范围：真实备份/恢复演练（Count / Checksum / Key ID 一致）+ Restore 后禁止自动重触发
> 状态：✅ 完成
> 证据级别：**Offline（E2E）+ Staging Real（staging SQLite 数据目录真实快照导出/落盘/恢复）**

---

## 一、目标

在 staging 真实执行备份与恢复闭环并验证数据完整性：

- **Count 一致**：快照导出总数与恢复后重新采集总数一致（逐集合计数）。
- **Checksum 一致**：快照内容指纹（逐集合数据按 id 稳定排序后 sha256）在恢复前后一致，证明未丢失、未篡改。
- **Key ID 一致**：恢复后每条记录的 id 与备份前原样保留（run / job / 审批 / 遥测等）。
- **Restore 后禁止自动重触发**：恢复后历史队列（QUEUED / RETRY / RUNNING Job）不自动重放；即使注册 Worker + dispatch 也不执行；不新增 Run；已终态 Run 不重跑。

## 二、扫描结论（复用点与缺口）

| 项 | 结论 |
|---|---|
| 复用点 | `backup.ts` 已有 `collectSnapshot`（16 集合全量导出，含 projects registry）/ `restoreSnapshot` / `snapshotTotal`（25.8） |
| 复用点 | `production-readiness.test.ts` 已有备份/恢复闭环测试（计数与 id 一致） |
| 缺口 | 快照无内容指纹 → 新增 `checksum`（sha256）与 `computeSnapshotChecksum` |
| 缺口 | Restore 后遗留 QUEUED/RETRY/RUNNING Job 会被调度器自动领取（重触发风险）→ 新增 `noAutoRetrigger`（默认 true）把遗留非终态 Job 置 CANCELLED |
| 缺口 | 无恢复一致性校验 → 新增 `verifyRestore`（Count / Checksum / Key ID 三维比对，支持归一化禁止重触发差异） |
| 缺口 | `ProjectRegistry.create` 重生成时间戳导致恢复后 createdAt/updatedAt 漂移 → 新增 `importAll`（保留原 id/时间戳直接注入） |
| 缺口 | CLI 备份命令无 checksum 与恢复校验 → `backup save/restore/summary/checksum` 增强 |

## 三、产出清单

| 文件 | 说明 |
|---|---|
| `src/platform/ops/backup.ts`（修改） | `PlatformSnapshot.checksum` + `computeSnapshotChecksum`；`restoreSnapshot` 增 `noAutoRetrigger`（遗留非终态 Job 置 CANCELLED，返回 `cancelledJobs`）；新增 `verifyRestore`（Count/Checksum/Key ID + 归一化禁止重触发差异） |
| `src/platform/projects/project-registry.ts`（修改） | 新增 `importAll(records)`：恢复时保留原 id / createdAt / updatedAt（不经 create 重生成时间戳） |
| `bin/platform-cli.ts`（修改） | `backup save` 输出 checksum；`backup restore` 输出 cancelledJobs + verify 三维校验；`backup summary` 带 checksum；新增 `backup checksum <file>` |
| `tests/e2e/backup-restore-real.test.ts`（新建，2 例） | 真实 SQLite 数据目录：三一致闭环 + 禁止自动重触发 |

## 四、演练设计

- **备份**：`collectSnapshot` 导出 16 集合原始记录（含真实 Run 产生的遥测/成本/审计/checkpoint/release/审批 + test-assets），计算内容指纹 checksum，落盘 JSON。
- **恢复**：`restoreSnapshot` 校验版本 → 逐集合清空 → 批量写入（保留原 id；projects 走 `importAll` 保留时间戳）→ 遗留非终态 Job 置 CANCELLED（`error=restored-no-auto-retrigger`）。
- **校验**：`verifyRestore` 对恢复后数据重新采集，比对 Count（总数一致）、Checksum（内容指纹一致，归一化禁止重触发差异）、Key ID（逐集合 id 集合一致）。
- **禁止自动重触发专项**：制造遗留 QUEUED Job（createRun 后不 dispatch）→ 快照含 QUEUED → 恢复后该 Job 置 CANCELLED、`pendingCount()=0`、注册 Worker + dispatch 后 Run 仍 QUEUED（未被领取执行）。

## 五、验证结果

### 5.1 Staging Real：`backup save / restore / checksum`（staging SQLite 数据目录真实快照）

| 命令 | 结果 |
|---|---|
| `backup save /tmp/panqu-drill-snapshot.json` | 572 条 / 16 集合，checksum=`8b2842…e3c5` |
| `backup checksum <file>` | 重算 checksum 与落盘一致，`match=true` |
| `backup restore <file>` | 恢复 572 条 / 16 集合；`countMatch=true`、`checksumMatch=true`（归一化禁止重触发维度）、`idMismatch=[]`；`cancelledJobs=17`（17 个遗留 QUEUED Job 被置 CANCELLED，禁止自动重触发） |

### 5.2 Staging Real：禁止自动重触发证据

```json
{ "restored": 572, "stores": 16, "cancelledJobs": 17,
  "verify": { "countBefore": 572, "countAfter": 572, "countMatch": true,
    "checksumMatch": true, "idMismatch": [],
    "detail": "17 个遗留 Job 已按「禁止自动重触发」置 CANCELLED，Checksum 已归一化该维度" } }
```

真实数据目录中 17 个历史非终态 Job 在恢复后全部被置 CANCELLED，`pendingCount()=0`，不会在恢复后被调度器自动重放。

### 5.3 Offline（E2E，2 例全 PASS）

1. 真实备份/恢复闭环：16 集合全量导出（含 telemetry/cost/audit/test-assets/approvals 真实数据）→ 恢复进全新 SQLite 目录 → `verifyRestore.ok=true`（Count / Checksum / Key ID 全一致）；`cancelledJobs=0`（全终态）；run id 原样保留且状态一致；审批 PENDING 原样保留；Restore 后 `pendingCount()=0`、Run 总数不变 ✅
2. 禁止自动重触发：快照含 QUEUED Job → 恢复后该 Job 置 CANCELLED（`error=restored-no-auto-retrigger`）、`pendingCount()=0`、注册 Worker + dispatch 后 Run 仍 QUEUED（未被领取执行）✅

### 5.4 全量回归（26.6 改动后）

`npx vitest run` → **113 passed | 4 skipped（1386 tests）**；`npm run build` 通过。

## 六、证据分类

| 级别 | 结论 | 说明 |
|---|---|---|
| Mock | 不适用 | 无 Mock 断言 |
| Offline | ✅ 全 PASS | E2E 2 例（三一致闭环 / 禁止自动重触发） |
| Staging Real | ✅ 通过 | staging SQLite 真实快照导出/落盘/校验/恢复；cancelledJobs=17 真实遗留 Job 被禁止重触发 |
| Production | 未执行 | 本阶段不触碰生产环境 |

## 七、缺口与风险

1. 真实数据目录存在 17 个历史非终态 Job（26.4/26.5 及早期 CLI 演练遗留），恢复时被正确置 CANCELLED；属预期的禁止自动重触发行为，非数据丢失（run 记录保留）。
2. Checksum 归一化仅针对 `error=restored-no-auto-retrigger` 的 Job 状态变更；其余字段（含时间戳）严格一致（projects 经 `importAll` 保留原时间戳）。
3. `backup restore` 是对当前数据目录的就地恢复；跨目录恢复（全新库）由 E2E 覆盖验证。

## 八、下一阶段

进入 **26.7 Observability / Alerting**：接入真实飞书通知，验证 6 类通知含丰富上下文，创建 `tests/e2e/notification-real.test.ts`。
