// Phase 26.6 Backup / Restore Drill — E2E（真实 SQLite 数据目录）
// 验证：
// - 真实数据（真实 Run / 遥测 / 成本 / 审批）全量快照导出 → Count / Checksum / Key ID 一致
// - Restore 后禁止自动重触发：遗留 QUEUED/RETRY/RUNNING Job 置 CANCELLED，
//   即使注册 Worker + dispatch 也不执行该 Run；不新增 Run；已终态 Run 不重跑。

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import {
  collectSnapshot,
  restoreSnapshot,
  verifyRestore,
  snapshotTotal,
} from '../../src/platform/ops/backup.js';
import { makeRealRunExecutor } from '../../src/platform/ops/real-run.js';

const cleaned: string[] = [];
function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `panqu-br-${label}-`));
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

function makeSqliteBundle(dir: string): PlatformBundle {
  return createPlatformService({ seedProject: true, seedUsers: true, dataDir: dir, storage: 'sqlite', jwtSecret: 'br-secret' });
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
  throw new Error('派发未在迭代上限内排空队列');
}

/** 制造真实数据：sanity + regression 真实 Run（全终态）+ PENDING 审批 + 遥测/成本 */
async function seedRealData(bundle: PlatformBundle): Promise<string[]> {
  await bundle.auth.ensureSeeded();
  await bundle.testAssets.importCatalog();
  const runIds: string[] = [];
  bundle.registerWorkerExecutor('br-sanity-worker', makeRealRunExecutor(bundle, 'sanity', { environment: 'test' }));
  const { runId: r1 } = await bundle.service.createRun({
    projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'br-test', role: 'ADMIN', feature: 'br-sanity',
  });
  await dispatchUntilIdle(bundle);
  runIds.push(r1);

  bundle.registerWorkerExecutor('br-regression-worker', makeRealRunExecutor(bundle, 'regression', { environment: 'test' }));
  const { runId: r2 } = await bundle.service.createRun({
    projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'br-test', role: 'ADMIN', feature: 'br-regression',
  });
  await dispatchUntilIdle(bundle);
  runIds.push(r2);

  // PENDING 审批（真实数据之一）
  await bundle.approvals.request({ runId: r2, action: 'release', riskLevel: 'risky', environment: 'test', requester: 'br-test', reason: 'drill' });
  return runIds;
}

describe('26.6.1 真实备份/恢复闭环（Count / Checksum / Key ID 一致）', () => {
  it('全量快照导出 → 恢复进全新 SQLite 目录 → 校验三一致且 Restore 不自动重触发', async () => {
    const dirA = tempDir('a');
    const a = makeSqliteBundle(dirA);
    const runIds = await seedRealData(a);

    const snapshot = await collectSnapshot(a);
    expect(snapshot.version).toBe(1);
    expect(snapshot.checksum).toBeTruthy();
    expect(snapshot.stores).toHaveLength(16);
    expect(snapshotTotal(snapshot)).toBeGreaterThan(0);
    // 真实数据已入快照：telemetry 事件、成本账本、审计、test-assets、审批
    const store = (name: string) => snapshot.stores.find((s) => s.store === name)?.count ?? 0;
    expect(store('telemetry-events')).toBeGreaterThan(0);
    expect(store('cost-ledger')).toBeGreaterThan(0);
    expect(store('audit')).toBeGreaterThan(0);
    expect(store('test-assets')).toBeGreaterThan(0);
    expect(store('approvals')).toBeGreaterThan(0);

    const dirB = tempDir('b');
    const b = makeSqliteBundle(dirB);
    await b.auth.ensureSeeded();
    const result = await restoreSnapshot(b, snapshot);
    expect(result.stores).toBe(16);
    expect(result.restored).toBe(snapshotTotal(snapshot));
    // 全终态数据：无遗留待执行 Job → cancelledJobs=0
    expect(result.cancelledJobs).toBe(0);

    const verify = await verifyRestore(b, snapshot);
    expect(verify.ok).toBe(true);
    expect(verify.countMatch).toBe(true);
    expect(verify.checksumMatch).toBe(true);
    expect(verify.idMismatch).toEqual([]);
    expect(verify.countBefore).toBe(snapshotTotal(snapshot));
    expect(verify.countAfter).toBe(verify.countBefore);

    // Key ID 一致：run id 原样保留且状态一致
    for (const rid of runIds) {
      const run = await b.service.getRun(rid);
      expect(run?.runId).toBe(rid);
      expect(run?.status).toBe('COMPLETED');
    }
    // 审批 PENDING 原样保留（真实数据维度一致）
    expect(await b.approvals.pendingCount()).toBe(1);

    // Restore 后禁止自动重触发：pendingCount=0、Run 总数不变（无新增 Run）
    expect(await b.scheduler.pendingCount()).toBe(0);
    expect((await b.service.listRuns()).length).toBe(runIds.length);
  });
});

describe('26.6.2 Restore 后禁止自动重触发（遗留 QUEUED Job）', () => {
  it('快照含 QUEUED Job → 恢复后置 CANCELLED；即使 Worker + dispatch 也不执行该 Run', async () => {
    const dirA = tempDir('qa');
    const a = makeSqliteBundle(dirA);
    await a.auth.ensureSeeded();
    await a.testAssets.importCatalog();
    // 制造遗留待执行 Job：createRun 后不 dispatch（job 保持 QUEUED）
    const { runId: q1 } = await a.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'br-test', role: 'ADMIN', feature: 'br-queued',
    });
    const jobsBefore = await a.scheduler.list({ runId: q1 } as never);
    expect(jobsBefore.some((j) => j.status === 'QUEUED')).toBe(true);
    const snapshot = await collectSnapshot(a);

    const dirB = tempDir('qb');
    const b = makeSqliteBundle(dirB);
    await b.auth.ensureSeeded();
    const result = await restoreSnapshot(b, snapshot);
    expect(result.cancelledJobs).toBeGreaterThanOrEqual(1);

    // 该 Job 已被置 CANCELLED（禁止恢复后自动重触发）
    const restoredJobs = await b.scheduler.list({ runId: q1 } as never);
    const restoredJob = restoredJobs.find((j) => j.runId === q1);
    expect(restoredJob?.status).toBe('CANCELLED');
    expect(restoredJob?.error).toBe('restored-no-auto-retrigger');
    expect(await b.scheduler.pendingCount()).toBe(0);

    // 即使注册 Worker 并 dispatch，该 Run 也不会被自动执行（保持 QUEUED，未被领取）
    b.registerWorkerExecutor('br-boot-worker', makeRealRunExecutor(b, 'smoke', { environment: 'test' }));
    await dispatchUntilIdle(b);
    const runAfter = await b.service.getRun(q1);
    expect(runAfter?.status).toBe('QUEUED');
  });
});
