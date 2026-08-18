// 集成测试：Platform SQLite 持久化（Phase 25.1）
// 覆盖：以 sqlite 后端运行平台全链路（createRun → 入队 → complete），
//       数据跨工厂实例可恢复（近似跨进程），与其他后端行为一致。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createSqliteDatabase } from '../../src/platform/storage/sqlite/index.js';
import { createRepository } from '../../src/platform/storage/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

interface Snapshot {
  runs: number;
  audit: number;
  approvals: number;
  jobs: number;
  projectIds: string[];
}

function sqliteDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p25i-'));
}

function makeBundle(dir: string): PlatformBundle {
  return createPlatformService({
    seedProject: true,
    storage: 'sqlite',
    now: () => FIXED_ISO,
    dataDir: dir,
  });
}

describe('Platform SQLite 集成', () => {
  it('sqlite 后端：createRun → 入队 → start → complete 全链路', async () => {
    const dir = sqliteDir();
    const b = makeBundle(dir);
    const { runId } = await b.service.createRun({
      projectId: 'wan3',
      environment: 'test',
      trigger: 'autonomous',
      change: { type: 'model', target: 'wan3/text-to-video' },
      actor: 'qa',
      role: 'QA',
    });
    expect(runId).toMatch(/^run-/);
    expect(await b.scheduler.pendingCount()).toBe(1);
    await b.service.startRun(runId);
    expect((await b.service.getRun(runId))?.status).toBe('RUNNING');
    await b.service.completeRun(runId);
    expect((await b.service.getRun(runId))?.status).toBe('COMPLETED');
  });

  it('sqlite 后端数据跨工厂实例可恢复（Runs / Audit / Approvals / Jobs / Projects）', async () => {
    const dir = sqliteDir();
    const a = makeBundle(dir);
    // 制造各类实体
    const { runId } = await a.service.createRun({
      projectId: 'wan3',
      environment: 'test',
      trigger: 'manual',
      actor: 'qa',
      role: 'QA',
    });
    await a.service.startRun(runId);
    await a.service.completeRun(runId);
    // 一个待审批请求（通过 ApprovalCenter 直接创建，模拟门禁）
    const approval = await a.approvals.request({
      runId,
      environment: 'production',
      action: 'release',
      requester: 'qa',
      riskLevel: 'HIGH',
      reason: '集成测试审批',
    });
    void approval;

    const snapBefore = await snapshot(a);
    expect(snapBefore.runs).toBeGreaterThanOrEqual(1);
    expect(snapBefore.audit).toBeGreaterThanOrEqual(1);
    expect(snapBefore.approvals).toBeGreaterThanOrEqual(1);
    expect(snapBefore.projectIds).toContain('wan3');

    // 新实例（同一 sqlite 文件）读回
    const b = makeBundle(dir);
    const snapAfter = await snapshot(b);
    expect(snapAfter.runs).toBe(snapBefore.runs);
    expect(snapAfter.audit).toBe(snapBefore.audit);
    expect(snapAfter.approvals).toBe(snapBefore.approvals);
    expect(snapAfter.jobs).toBe(snapBefore.jobs);
    expect(snapAfter.projectIds.sort()).toEqual(snapBefore.projectIds.sort());
    const run = await b.service.getRun(runId);
    expect(run?.status).toBe('COMPLETED');
  });

  it('不同后端（memory/json/sqlite）行为一致：runs 计数相同', async () => {
    const dir = sqliteDir();
    const mem = createPlatformService({ storage: 'memory', now: () => FIXED_ISO });
    const json = createPlatformService({ storage: 'json', now: () => FIXED_ISO, dataDir: path.join(dir, 'json') });
    const sqlite = createPlatformService({ storage: 'sqlite', now: () => FIXED_ISO, dataDir: path.join(dir, 'sqlite') });
    for (const b of [mem, json, sqlite]) {
      await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA' });
    }
    expect(await mem.runs.list({})).toHaveLength(1);
    expect(await json.runs.list({})).toHaveLength(1);
    expect(await sqlite.runs.list({})).toHaveLength(1);
  });
});

/** 从平台抽取各实体计数快照 */
async function snapshot(b: PlatformBundle): Promise<Snapshot> {
  return {
    runs: (await b.service.listRuns()).length,
    audit: (await b.audit.list({})).length,
    approvals: (await b.approvals.list({})).length,
    jobs: (await b.scheduler.list({})).length,
    projectIds: b.service.listProjects().map((p) => p.id),
  };
}
