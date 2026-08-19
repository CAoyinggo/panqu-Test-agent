// Run Service（Phase 24.3）：统一 Run 生命周期（create/start/pause/resume/cancel/retry/checkpoint）
// 供 Scheduler / API / CLI 共用；校验 Project + Environment 经 ProjectService。

import type { Entity, Repository } from '../storage/repository.js';
import type { ProjectService } from '../projects/project-service.js';
import {
  transitionRun,
  isTerminal,
  generatePlatformRunId,
  type CreateRunInput,
  type RunStatus,
  type TestRun,
} from './run-schema.js';
import { CheckpointStore, type CheckpointInput } from './checkpoint.js';

/** 存储实体：id 与 runId 一致 */
export type RunEntity = TestRun & Entity;

export interface RunServiceOptions {
  now?: () => string;
}

export class RunService {
  constructor(
    private readonly runs: Repository<RunEntity>,
    private readonly projects: ProjectService,
    private readonly checkpoints: CheckpointStore,
    private readonly opts: RunServiceOptions = {},
  ) {}

  private nowIso(): string {
    return this.opts.now ? this.opts.now() : new Date().toISOString();
  }

  /** 创建 Run（校验项目与环境存在），状态 QUEUED */
  async create(input: CreateRunInput): Promise<TestRun> {
    if (!this.projects.getProject(input.projectId)) {
      throw new Error(`Project 不存在：${input.projectId}`);
    }
    if (!this.projects.getEnvironment(input.projectId, input.environment)) {
      throw new Error(`Project ${input.projectId} 下无环境 ${input.environment}`);
    }
    const runId = input.runId ?? generatePlatformRunId();
    const run: RunEntity = {
      id: runId,
      runId,
      projectId: input.projectId,
      businessId: input.businessId,
      feature: input.feature,
      environment: input.environment,
      trigger: input.trigger,
      status: 'QUEUED',
      progress: 0,
      createdAt: this.nowIso(),
      planId: input.planId,
      suiteIds: input.suiteIds,
      templateId: input.templateId,
      mode: input.mode,
      budget: input.budget,
      releaseGate: input.releaseGate,
      assetVersion: input.assetVersion,
    };
    await this.runs.create(run);
    return run;
  }

  async get(runId: string): Promise<TestRun | null> {
    return this.runs.get(runId);
  }

  async list(filter?: Partial<TestRun>): Promise<TestRun[]> {
    return this.runs.query(filter as Partial<RunEntity>);
  }

  private async setStatus(runId: string, next: RunStatus, patch: Partial<RunEntity> = {}): Promise<TestRun> {
    const cur = await this.runs.get(runId);
    if (!cur) throw new Error(`Run 不存在：${runId}`);
    transitionRun(cur.status, next);
    return this.runs.update(runId, { status: next, ...patch });
  }

  async start(runId: string): Promise<TestRun> {
    // 26.4：幂等——Worker 崩溃恢复后另一 Worker 重跑同一 Run（已 RUNNING）不报非法迁移
    const cur = await this.runs.get(runId);
    if (cur?.status === 'RUNNING') return cur;
    return this.setStatus(runId, 'RUNNING', { startedAt: this.nowIso() });
  }

  async pause(runId: string): Promise<TestRun> {
    return this.setStatus(runId, 'PAUSED');
  }

  async resume(runId: string): Promise<TestRun> {
    return this.setStatus(runId, 'RUNNING');
  }

  async complete(runId: string, progress = 100): Promise<TestRun> {
    return this.setStatus(runId, 'COMPLETED', { progress, finishedAt: this.nowIso() });
  }

  async fail(runId: string): Promise<TestRun> {
    return this.setStatus(runId, 'FAILED', { finishedAt: this.nowIso() });
  }

  async cancel(runId: string): Promise<TestRun> {
    return this.setStatus(runId, 'CANCELLED', { finishedAt: this.nowIso() });
  }

  /** Retry：允许对 FAILED/CANCELLED/COMPLETED 重新排队（新建 QUEUED Run，复制上下文） */
  async retry(runId: string): Promise<TestRun> {
    const cur = await this.runs.get(runId);
    if (!cur) throw new Error(`Run 不存在：${runId}`);
    if (!isTerminal(cur.status)) {
      throw new Error(`仅终态可 Retry（当前 ${cur.status}）`);
    }
    const fresh = await this.create({
      projectId: cur.projectId,
      businessId: cur.businessId,
      feature: cur.feature,
      environment: cur.environment,
      trigger: cur.trigger,
      planId: cur.planId,
      suiteIds: cur.suiteIds,
      templateId: cur.templateId,
      mode: cur.mode,
      budget: cur.budget,
      releaseGate: cur.releaseGate,
      assetVersion: cur.assetVersion,
    });
    return fresh;
  }

  async updateProgress(runId: string, progress: number): Promise<TestRun> {
    const p = Math.min(100, Math.max(0, progress));
    return this.runs.update(runId, { progress: p });
  }

  // ── Checkpoint（Pause 时保存，Resume 时恢复，不重新生成 Test Plan）──
  async saveCheckpoint(input: CheckpointInput): Promise<unknown> {
    return this.checkpoints.save(input);
  }

  async loadCheckpoint(runId: string): Promise<unknown> {
    return this.checkpoints.load(runId);
  }
}
