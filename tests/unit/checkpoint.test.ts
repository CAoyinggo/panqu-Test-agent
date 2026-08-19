// 单元测试：Run Checkpoint / 状态机 / Run Service（Phase 24.3）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CheckpointStore,
  RunService,
  transitionRun,
  canTransition,
  isTerminal,
  generatePlatformRunId,
} from '../../src/platform/runs/index.js';
import { ProjectService } from '../../src/platform/projects/index.js';
import { InMemoryRepository } from '../../src/platform/storage/index.js';
import type { RunCheckpoint, TestRun } from '../../src/platform/runs/index.js';

function makeEnv(): { svc: RunService; projects: ProjectService } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p24r-'));
  const projects = new ProjectService({ file: path.join(dir, 'p.json'), persist: false });
  projects.createProject({ id: 'wan3', name: 'WAN3' });
  const runs = new InMemoryRepository<TestRun & { id: string }>('run');
  const ckpts = new InMemoryRepository<RunCheckpoint>('ckpt');
  const checkpoints = new CheckpointStore(ckpts);
  const svc = new RunService(runs, projects, checkpoints, { now: () => '2026-08-18T00:00:00.000Z' });
  return { svc, projects };
}

describe('Run 状态机', () => {
  it('合法迁移：QUEUED→RUNNING→PAUSED→RUNNING→COMPLETED', () => {
    expect(transitionRun('QUEUED', 'RUNNING')).toBe('RUNNING');
    expect(transitionRun('RUNNING', 'PAUSED')).toBe('PAUSED');
    expect(transitionRun('PAUSED', 'RUNNING')).toBe('RUNNING');
    expect(transitionRun('RUNNING', 'COMPLETED')).toBe('COMPLETED');
  });

  it('非法迁移抛错：QUEUED→COMPLETED、COMPLETED→RUNNING', () => {
    expect(() => transitionRun('QUEUED', 'COMPLETED')).toThrow(/非法 Run 状态迁移/);
    expect(() => transitionRun('COMPLETED', 'RUNNING')).toThrow(/非法 Run 状态迁移/);
  });

  it('canTransition / isTerminal', () => {
    expect(canTransition('QUEUED', 'CANCELLED')).toBe(true);
    expect(canTransition('RUNNING', 'COMPLETED')).toBe(true);
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('RUNNING')).toBe(false);
  });

  it('generatePlatformRunId 统一口径（29.3：碰撞安全随机尾）', () => {
    const id = generatePlatformRunId();
    expect(id).toMatch(/^run-\d{14}-[0-9a-f]{32}$/);
  });
});

describe('RunService 生命周期', () => {
  it('create：校验 Project + Environment，状态 QUEUED', async () => {
    const { svc } = makeEnv();
    const run = await svc.create({ projectId: 'wan3', environment: 'test', trigger: 'autonomous', feature: 'wan3/text-to-video' });
    expect(run.status).toBe('QUEUED');
    expect(run.progress).toBe(0);
    expect(run.trigger).toBe('autonomous');
    await expect(svc.create({ projectId: 'missing', environment: 'test', trigger: 'manual' })).rejects.toThrow(/Project 不存在/);
    await expect(svc.create({ projectId: 'wan3', environment: 'nope', trigger: 'manual' })).rejects.toThrow(/无环境/);
  });

  it('start / pause / resume / complete 状态流转', async () => {
    const { svc } = makeEnv();
    const run = await svc.create({ projectId: 'wan3', environment: 'test', trigger: 'manual' });
    const started = await svc.start(run.runId);
    expect(started.status).toBe('RUNNING');
    expect(started.startedAt).toBeTruthy();
    const paused = await svc.pause(run.runId);
    expect(paused.status).toBe('PAUSED');
    await svc.resume(run.runId);
    const done = await svc.complete(run.runId, 100);
    expect(done.status).toBe('COMPLETED');
    expect(done.finishedAt).toBeTruthy();
    // 终态后不可再迁移
    await expect(svc.start(run.runId)).rejects.toThrow(/非法 Run 状态迁移/);
  });

  it('cancel / retry', async () => {
    const { svc } = makeEnv();
    const run = await svc.create({ projectId: 'wan3', environment: 'test', trigger: 'pr' });
    await svc.cancel(run.runId);
    expect((await svc.get(run.runId))!.status).toBe('CANCELLED');
    const fresh = await svc.retry(run.runId);
    expect(fresh.status).toBe('QUEUED');
    expect(fresh.runId).not.toBe(run.runId);
    // 非终态不可 retry
    await expect(svc.retry(fresh.runId)).rejects.toThrow(/仅终态可 Retry/);
  });

  it('updateProgress 限制 0-100', async () => {
    const { svc } = makeEnv();
    const run = await svc.create({ projectId: 'wan3', environment: 'test', trigger: 'manual' });
    await svc.updateProgress(run.runId, 150);
    expect((await svc.get(run.runId))!.progress).toBe(100);
    await svc.updateProgress(run.runId, -5);
    expect((await svc.get(run.runId))!.progress).toBe(0);
  });
});

describe('Checkpoint：Pause 保存 / Resume 恢复（不重新生成 Test Plan）', () => {
  it('save / load：completed 与 remaining 一致', async () => {
    const { svc } = makeEnv();
    const run = await svc.create({ projectId: 'wan3', environment: 'test', trigger: 'autonomous' });
    await svc.saveCheckpoint({
      runId: run.runId,
      stage: 'execution',
      completedCases: ['A', 'B', 'C'],
      remainingCases: ['D', 'E'],
      decisionState: { budgetUsed: 3 },
      budgetState: { limit: 20 },
      traceId: `task-${run.runId}`,
    });
    const ck = (await svc.loadCheckpoint(run.runId)) as RunCheckpoint;
    expect(ck.stage).toBe('execution');
    expect(ck.completedCases).toEqual(['A', 'B', 'C']);
    expect(ck.remainingCases).toEqual(['D', 'E']);
    expect(ck.decisionState).toEqual({ budgetUsed: 3 });
  });

  it('save 覆盖更新同 Run 检查点（恢复后继续，不重复执行已完成 Case）', async () => {
    const { svc } = makeEnv();
    const run = await svc.create({ projectId: 'wan3', environment: 'test', trigger: 'autonomous' });
    await svc.saveCheckpoint({
      runId: run.runId, stage: 's1', completedCases: ['A'], remainingCases: ['B'], decisionState: {}, budgetState: {}, traceId: 't1',
    });
    await svc.saveCheckpoint({
      runId: run.runId, stage: 's2', completedCases: ['A', 'B'], remainingCases: [], decisionState: {}, budgetState: {}, traceId: 't1',
    });
    const ck = (await svc.loadCheckpoint(run.runId)) as RunCheckpoint;
    expect(ck.stage).toBe('s2');
    expect(ck.completedCases).toEqual(['A', 'B']);
  });
});
