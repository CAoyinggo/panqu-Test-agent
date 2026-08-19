// 集成测试：Production Readiness（Phase 25.8）
// 覆盖：SQLite 迁移幂等 / 备份恢复闭环（projects 含 registry）/ 冒烟真实运营闭环 / Preflight 自检。

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createSqliteDatabase, sqliteDataFile } from '../../src/platform/storage/sqlite/database.js';
import {
  applySqliteMigrations,
  listAppliedSqlite,
  MIGRATIONS,
} from '../../src/platform/ops/migrations.js';
import { collectSnapshot, restoreSnapshot, snapshotTotal } from '../../src/platform/ops/backup.js';
import { runPlatformSmoke } from '../../src/platform/ops/smoke.js';
import { runPlatformPreflight, preflightSummary } from '../../src/platform/ops/preflight.js';
import { withLLMTelemetry, runContext } from '../../src/platform/telemetry/index.js';
import { MockLLMProvider } from '../../src/llm/mock-llm.js';

const cleaned: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `panqu-pr-${label}-`));
  cleaned.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleaned.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败忽略 */
    }
  }
});

/** 注册真实 Worker（与 smoke/CLI 语义一致）：Mock LLM 经遥测装饰器 → 真实成本 */
function registerExecWorker(bundle: PlatformBundle): void {
  const provider = withLLMTelemetry(new MockLLMProvider(), bundle.telemetry);
  bundle.registerWorkerExecutor('pr-worker', async (job: unknown) => {
    const j = job as { runId: string; projectId: string; environment: string; feature?: string };
    await runContext.run({ runId: j.runId, projectId: j.projectId, feature: j.feature }, async () => {
      await bundle.service.startRun(j.runId);
      await bundle.telemetry.recordExecution({ runId: j.runId, projectId: j.projectId, feature: j.feature, phase: 'pipeline', result: 'success' });
      await provider.generate({ messages: [{ role: 'user', content: '生产就绪测试：分析' }] });
      await provider.generate({ messages: [{ role: 'user', content: '生产就绪测试：修复' }] });
      await bundle.service.completeRun(j.runId);
    });
  });
}

async function dispatchUntilIdle(bundle: PlatformBundle, maxIters = 200): Promise<void> {
  let iters = 0;
  while (iters < maxIters) {
    const assigned = await bundle.pool.dispatch();
    await bundle.pool.drain();
    const pending = await bundle.scheduler.pendingCount();
    if (assigned === 0 && pending === 0) return;
    iters += 1;
  }
  throw new Error('派发未排空');
}

describe('Phase 25.8 Production Readiness', () => {
  it('SQLite 迁移幂等：重复应用仅执行一次，_migrations 记录全部迁移', () => {
    const dir = tempDir('migrate');
    const db = createSqliteDatabase(sqliteDataFile(dir));
    // 首次应用：全部未执行
    const first = applySqliteMigrations(db);
    expect(first).toEqual(MIGRATIONS.map((m) => m.id));
    expect(listAppliedSqlite(db).sort()).toEqual(MIGRATIONS.map((m) => m.id).sort());
    // 再次应用：无新迁移（幂等）
    const second = applySqliteMigrations(db);
    expect(second).toEqual([]);
    // 集合表已建立：写入后可查询
    db.prepare('INSERT INTO "runs" (id, data) VALUES (?, ?)').run('r1', JSON.stringify({ id: 'r1' }));
    const rows = db.prepare('SELECT id FROM "runs"').all() as Array<{ id: string }>;
    expect(rows).toContainEqual({ id: 'r1' });
    db.close();
  });

  it('备份/恢复闭环：16 集合全量导出，恢复后计数与 id 一致（含 projects registry、test-assets）', async () => {
    const dirA = tempDir('bkp-a');
    const bundleA = createPlatformService({ seedProject: true, seedUsers: true, dataDir: dirA, storage: 'sqlite', jwtSecret: 'pr-secret' });
    await bundleA.auth.ensureSeeded();
    // 26.2：导入真实 Test Case 资产，验证其纳入备份/恢复
    await bundleA.testAssets.importCatalog();
    registerExecWorker(bundleA);
    const { runId } = await bundleA.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', feature: 'bkp-probe', actor: 'pr-test', role: 'ADMIN',
    });
    await dispatchUntilIdle(bundleA);

    const snapshot = await collectSnapshot(bundleA);
    expect(snapshot.version).toBe(1);
    expect(snapshot.stores).toHaveLength(16);
    // projects 来自 registry（至少 seed 项目 wan3）
    const projStore = snapshot.stores.find((s) => s.store === 'projects')!;
    expect(projStore.count).toBeGreaterThanOrEqual(1);
    // 遥测真实数据已入快照
    const teleStore = snapshot.stores.find((s) => s.store === 'telemetry-events')!;
    expect(teleStore.count).toBeGreaterThan(0);
    const costStore = snapshot.stores.find((s) => s.store === 'cost-ledger')!;
    expect(costStore.count).toBeGreaterThan(0);
    // 26.2 真实 Test Case 资产（纳入备份/恢复）
    const assetStore = snapshot.stores.find((s) => s.store === 'test-assets')!;
    expect(assetStore.count).toBeGreaterThan(0);
    const totalBefore = snapshotTotal(snapshot);

    // 恢复进全新 bundle（独立数据目录）
    const dirB = tempDir('bkp-b');
    const bundleB = createPlatformService({ seedProject: true, seedUsers: true, dataDir: dirB, storage: 'sqlite', jwtSecret: 'pr-secret' });
    const result = await restoreSnapshot(bundleB, snapshot);
    expect(result.stores).toBe(16);
    expect(result.restored).toBe(totalBefore);

    const after = await collectSnapshot(bundleB);
    expect(snapshotTotal(after)).toBe(totalBefore);
    // run id 原样保留
    const runB = await bundleB.service.getRun(runId);
    expect(runB?.runId).toBe(runId);
    expect(runB?.status).toBe('COMPLETED');
    // projects 恢复：wan3 存在
    expect(bundleB.projects.getProject('wan3')).not.toBeNull();
  });

  it('冒烟：真实运营闭环（Run COMPLETED + 遥测事件 + 成本账本 + 指标激活）', async () => {
    const result = await runPlatformSmoke();
    expect(result.ok).toBe(true);
    expect(result.runStatus).toBe('COMPLETED');
    expect(result.telemetryEvents).toBeGreaterThan(0);
    expect(result.costEntries).toBeGreaterThan(0);
    expect(result.totalCostYuan).toBeGreaterThan(0);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('Preflight：正常环境无 BLOCK 级检查项', async () => {
    const checks = await runPlatformPreflight({ checkPostgres: true });
    const summary = preflightSummary(checks);
    expect(summary.block).toBe(0);
    expect(summary.ok).toBe(true);
    // 结构断言：全部检查项带 level/detail
    for (const c of checks) {
      expect(['PASS', 'WARN', 'BLOCK']).toContain(c.level);
      expect(typeof c.detail).toBe('string');
    }
  });
});
