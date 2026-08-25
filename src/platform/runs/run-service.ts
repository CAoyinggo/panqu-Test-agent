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
  type PlatformRunExecutionRecord,
} from './run-schema.js';
import { assertRunCompletionEligibility, evaluateRunCompletionEligibility } from './run-completion.js';
import { CheckpointStore, type CheckpointInput } from './checkpoint.js';
import { CodedError, ErrorCode } from '../../core/errors.js';

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
      throw new CodedError(ErrorCode.NOT_FOUND, `Project 不存在：${input.projectId}`);
    }
    if (!this.projects.getEnvironment(input.projectId, input.environment)) {
      throw new CodedError(ErrorCode.VALIDATION_ERROR, `Project ${input.projectId} 下无环境 ${input.environment}`);
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
      executionMode: input.executionMode ?? 'VERIFIED_AGENT',
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
    if (!cur) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    transitionRun(cur.status, next);
    return this.runs.update(runId, { status: next, ...patch });
  }

  async start(runId: string): Promise<TestRun> {
    // Worker 领取后只进入 PLANNING；不能把“Worker 已启动”等价成业务执行已开始。
    const cur = await this.runs.get(runId);
    if (cur && ['PLANNING', 'GATED', 'RUNNING', 'EVIDENCE_READY'].includes(cur.status)) return cur;
    return this.setStatus(runId, 'PLANNING', { startedAt: this.nowIso() });
  }

  /** Agent Pipeline 的 Policy Gate 已真实放行。 */
  async markGated(runId: string): Promise<TestRun> {
    const cur = await this.runs.get(runId);
    if (cur && ['GATED', 'RUNNING', 'EVIDENCE_READY'].includes(cur.status)) return cur;
    return this.setStatus(runId, 'GATED');
  }

  /** Gate 放行后，Data Prepare / Runner 即将开始产生实际执行。 */
  async beginExecution(runId: string): Promise<TestRun> {
    const cur = await this.runs.get(runId);
    if (cur && ['RUNNING', 'EVIDENCE_READY'].includes(cur.status)) return cur;
    return this.setStatus(runId, 'RUNNING');
  }

  async pause(runId: string): Promise<TestRun> {
    return this.setStatus(runId, 'PAUSED');
  }

  async resume(runId: string): Promise<TestRun> {
    // Resume 不复用旧 Gate/Execution/Outcome，必须回到 PLANNING 重新过门禁。
    return this.setStatus(runId, 'PLANNING', {
      executionRecord: undefined,
      startedAt: this.nowIso(),
      finishedAt: undefined,
    });
  }

  async complete(runId: string, progress = 100): Promise<TestRun> {
    const cur = await this.runs.get(runId);
    if (!cur) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    const executionRecord = assertRunCompletionEligibility(cur);
    return this.setStatus(runId, 'COMPLETED', {
      progress,
      finishedAt: this.nowIso(),
      executionRecord: { ...executionRecord, completionGuardPassed: true },
    });
  }

  async fail(runId: string): Promise<TestRun> {
    return this.setStatus(runId, 'FAILED', { finishedAt: this.nowIso() });
  }

  async cancel(runId: string): Promise<TestRun> {
    return this.setStatus(runId, 'CANCELLED', { finishedAt: this.nowIso() });
  }

  async block(runId: string): Promise<TestRun> {
    return this.setStatus(runId, 'BLOCKED', { finishedAt: this.nowIso() });
  }

  async timeout(runId: string): Promise<TestRun> {
    return this.setStatus(runId, 'TIMEOUT', { finishedAt: this.nowIso() });
  }

  /** Retry：允许对 FAILED/CANCELLED/COMPLETED 重新排队（新建 QUEUED Run，复制上下文） */
  async retry(runId: string): Promise<TestRun> {
    const cur = await this.runs.get(runId);
    if (!cur) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    if (!isTerminal(cur.status)) {
      throw new CodedError(ErrorCode.CONFLICT, `仅终态可 Retry（当前 ${cur.status}）`);
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
      executionMode: 'VERIFIED_AGENT',
    });
    return fresh;
  }

  async updateProgress(runId: string, progress: number): Promise<TestRun> {
    const p = Math.min(100, Math.max(0, progress));
    return this.runs.update(runId, { progress: p });
  }

  /** 在终态迁移前持久化 Agent Pipeline 的 Requirement/Gate/Evidence/Outcome。 */
  async recordExecution(runId: string, executionRecord: PlatformRunExecutionRecord): Promise<TestRun> {
    const cur = await this.runs.get(runId);
    if (!cur) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    if (isTerminal(cur.status)) {
      throw new CodedError(ErrorCode.CONFLICT, `Run 已是终态，拒绝迟到执行记录：${runId}`);
    }
    if (executionRecord.completionGuardPassed !== undefined) {
      throw new CodedError(ErrorCode.CONFLICT, 'completionGuardPassed 只能由 Completion Guard 写入');
    }
    const executionId = executionRecord.execution?.executionId;
    const outcomeId = executionRecord.outcome?.outcomeId;
    const evidenceIds = new Set(executionRecord.evidence?.map((item) => item.evidenceId) ?? []);
    const others = (await this.runs.query({})).filter((run) => run.runId !== runId && run.executionRecord);
    const duplicate = others.find((run) => {
      const record = run.executionRecord!;
      return Boolean(
        (executionId && record.execution?.executionId === executionId)
        || (outcomeId && record.outcome?.outcomeId === outcomeId)
        || record.evidence?.some((item) => item.evidenceId && evidenceIds.has(item.evidenceId)),
      );
    });
    if (duplicate) {
      throw new CodedError(
        ErrorCode.CONFLICT,
        `Execution/Evidence/Outcome 身份已被其他 Run 使用：${duplicate.runId}`,
      );
    }
    const candidate: TestRun = { ...cur, executionRecord };
    const eligibility = evaluateRunCompletionEligibility(candidate);
    if (eligibility.eligible) {
      if (cur.status !== 'RUNNING') {
        throw new CodedError(ErrorCode.CONFLICT, `完整执行记录只能由 RUNNING Run 写入（当前 ${cur.status}）`);
      }
      transitionRun(cur.status, 'EVIDENCE_READY');
      return this.runs.update(runId, { executionRecord, status: 'EVIDENCE_READY' });
    }
    return this.runs.update(runId, { executionRecord });
  }

  // ── Checkpoint（Pause 时保存，Resume 时恢复，不重新生成 Test Plan）──
  async saveCheckpoint(input: CheckpointInput): Promise<unknown> {
    return this.checkpoints.save(input);
  }

  async loadCheckpoint(runId: string): Promise<unknown> {
    return this.checkpoints.load(runId);
  }
}
