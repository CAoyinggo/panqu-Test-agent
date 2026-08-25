// Platform Service（Phase 24.7）：统一 Service Layer
// API 与 CLI 共用；Scheduler / Worker / Dashboard / Audit 也统一从这里进出。
// 职责：Project / Run 生命周期 / 调度入队 / 审批 / 权限门禁 / 事件发布 / 审计 / 幂等 / 平台运维视图。

import type { ProjectService } from '../projects/project-service.js';
import type { Project } from '../projects/project-schema.js';
import type { RunService } from '../runs/run-service.js';
import type { TestRun, CreateRunInput, RunTrigger, PlatformRunExecutionRecord, RunExecutionMode } from '../runs/run-schema.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { TestJob } from '../scheduler/test-job.js';
import type { WorkerRegistry } from '../workers/worker-registry.js';
import type { WorkerPool } from '../workers/worker-pool.js';
import type { ApprovalCenter } from '../approval-center/approval-center.js';
import type { ApprovalRequest } from '../approval-center/approval-schema.js';
import type { PlatformGate } from '../rbac/platform-gate.js';
import { hasPermission, type Role, type Permission } from '../rbac/rbac.js';
import { assertProjectAccess, assertRunAccess } from '../rbac/scopes.js';
import type { Scopes } from '../rbac/scopes.js';
import type { EventBus } from '../events/event-bus.js';
import type { PlatformEventType } from '../events/events.js';
import type { NotificationDispatcher } from '../notifications/dispatcher.js';
import type { AuditLog, AuditAction, AuditEntry } from '../audit/audit-log.js';
import { IdempotencyStore } from './idempotency.js';
import { generatePlatformRunId } from '../runs/run-schema.js';
import type { TestWorker } from '../workers/worker.js';
import {
  computePlatformMetrics,
  computePlatformSlo,
  type PlatformMetrics,
  type PlatformSlo,
  type MetricsTelemetryInput,
} from '../operations/metrics.js';
import type { TelemetryService, TelemetryPeriod, TelemetryEvent } from '../telemetry/index.js';
import { createReadyStartup, type PlatformStartup, type PlatformStartupStatus } from './startup.js';
import { CodedError, ErrorCode } from '../../core/errors.js';

/** 变更描述（驱动 autonomous 流水线） */
export interface RunChange {
  type: 'code' | 'model' | 'config' | 'env' | 'none';
  target: string;
  from?: string;
  to?: string;
}

/** 创建 Run 请求（API / CLI 共用） */
export interface CreateRunRequest {
  projectId: string;
  environment: string;
  trigger: RunTrigger;
  businessId?: string;
  feature?: string;
  /** 真实 Agent Pipeline 的需求正文；缺省由 feature/change 构造最小需求。 */
  requirementText?: string;
  change?: RunChange;
  actor: string;
  role: Role;
  /** 25.3 资源作用域（JWT 认证用户带入）；缺省不做项目/环境隔离 */
  scopes?: Scopes;
  idempotencyKey?: string;
  // Phase 39：QA Workflow 上下文（Run Again / Clone / Template 复用溯源）
  planId?: string;
  suiteIds?: string[];
  templateId?: string;
  mode?: string;
  budget?: number;
  releaseGate?: boolean;
  assetVersion?: Record<string, number>;
}

export type CreateRunStatus = 'QUEUED' | 'BLOCKED';

export interface PlatformServiceDeps {
  projects: ProjectService;
  runs: RunService;
  scheduler: Scheduler;
  workers: WorkerRegistry;
  pool: WorkerPool;
  approvals: ApprovalCenter;
  gate: PlatformGate;
  bus: EventBus;
  notifier: NotificationDispatcher;
  audit: AuditLog;
  idempotency: IdempotencyStore;
  /** 遥测服务（25.4）：真实成本 / RCA / Flaky / Healing 指标来源 */
  telemetry: TelemetryService;
  /** 测试资产库（26.2）：真实 Test Case 资产（查询/统计/导入） */
  testAssets: import('../test-assets/platform-test-assets.js').PlatformTestAssets;
  /** QA Workflow（Phase 39）：Suite / Plan / Template / Versioning / Collaboration / Report / QA Home */
  workflow: import('../workflow/index.js').WorkflowService;
}

export class PlatformService {
  /** API / Gate 延迟样本（毫秒，运维指标用；内存环形采样） */
  private apiLatencySamples: number[] = [];
  private gateLatencySamples: number[] = [];

  constructor(
    public readonly deps: PlatformServiceDeps,
    private readonly startup: PlatformStartup = createReadyStartup(),
  ) {}

  /**
   * 服务启动屏障。HTTP Server 必须 await 此方法后才允许绑定端口。
   * PostgreSQL 下内部严格执行 Connection → Migration → READY。
   */
  async start(): Promise<void> {
    await this.startup.start();
  }

  /** 当前启动/就绪状态（供 readiness 与运维检查使用）。 */
  startupStatus(): PlatformStartupStatus {
    return this.startup.status();
  }

  /** 释放数据库等启动期资源（幂等）。 */
  async shutdown(): Promise<void> {
    await this.startup.close();
  }

  /** 记录 API 请求延迟（HTTP Server 调用） */
  recordApiLatency(ms: number): void {
    this.apiLatencySamples.push(ms);
    if (this.apiLatencySamples.length > 1000) this.apiLatencySamples.shift();
  }

  /** 记录审批决策延迟（Gate 调用） */
  recordGateLatency(ms: number): void {
    this.gateLatencySamples.push(ms);
    if (this.gateLatencySamples.length > 1000) this.gateLatencySamples.shift();
  }

  private latencyStats(samples: number[]): { count: number; p95Ms: number | null; avgMs: number | null } {
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : null,
      avgMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    };
  }

  // ── 事件 + 通知 ──
  private async emit(type: PlatformEventType, data: Record<string, unknown>, meta: { runId?: string; traceId?: string; approvalId?: string } = {}): Promise<void> {
    await this.deps.bus.publish({ type, runId: meta.runId, traceId: meta.traceId, approvalId: meta.approvalId, data });
  }

  private async audit(record: {
    actor: string;
    role: string;
    action: AuditAction;
    resource: string;
    environment?: string;
    result: 'success' | 'denied' | 'error' | 'pending';
    approvalId?: string;
    traceId?: string;
    detail?: unknown;
  }): Promise<void> {
    await this.deps.audit.record(record);
  }

  /** 通知总线 → 通知通道 桥接（供 API Server 启动时调用） */
  wireNotifications(): () => void {
    return this.deps.bus.subscribeAll((e) => {
      void this.deps.notifier.notifyEvent(e);
    });
  }

  private assertPermission(role: Role, permission: Permission): void {
    if (!hasPermission(role, permission)) {
      throw new CodedError(ErrorCode.AUTH_FORBIDDEN, `角色 ${role} 缺少权限 ${permission}`);
    }
  }

  // ── Projects ──
  async createProject(input: { id: string; name: string; businesses?: string[] }): Promise<Project> {
    this.assertPermission('ADMIN', 'PROJECT_WRITE');
    const p = this.deps.projects.createProject({
      id: input.id,
      name: input.name,
      businesses: input.businesses ?? [],
    });
    await this.audit({ actor: 'system', role: 'ADMIN', action: 'configuration', resource: `project:${p.id}`, result: 'success', detail: { name: input.name } });
    return p;
  }

  listProjects(): Project[] {
    return this.deps.projects.listProjects();
  }

  // ── Runs ──
  /** 创建 Run：RBAC → 项目/环境作用域 → Policy Gate → 幂等去重 → 调度入队 → 事件 → 审计 */
  async createRun(
    req: CreateRunRequest,
    internalOptions: { executionMode?: RunExecutionMode } = {},
  ): Promise<{ runId: string; status: CreateRunStatus }> {
    this.assertPermission(req.role, 'TEST_RUN');
    // 25.3 项目隔离：JWT 用户作用域校验（QA-A 不可访问 project-b）
    if (req.scopes) {
      assertRunAccess({ roles: [req.role], scopes: req.scopes }, req.projectId, req.environment);
    }
    // 幂等：同一 idempotencyKey 只创建一个 Run
    if (req.idempotencyKey) {
      const idem = await this.deps.idempotency.begin('run', req.idempotencyKey);
      if (idem.repeated) {
        const run = await this.deps.runs.get(idem.resultId ?? '');
        if (run) return { runId: run.runId, status: run.status === 'QUEUED' ? 'QUEUED' : 'BLOCKED' };
      }
    }
    const runId = generatePlatformRunId('run');
    const environment = this.deps.projects.getEnvironment(req.projectId, req.environment);
    if (!this.deps.projects.getProject(req.projectId)) {
      throw new CodedError(ErrorCode.NOT_FOUND, `Project 不存在：${req.projectId}`);
    }
    if (!environment || !environment.enabled) {
      throw new CodedError(ErrorCode.VALIDATION_ERROR, `Project ${req.projectId} 下无可用环境 ${req.environment}`);
    }

    // 创建 Run 本身不产生业务副作用；真正入队前先执行平台 Policy Gate。
    // production 的真实 Run 一律按 risky 处理，默认要求人工审批。
    const gateOutcome = await this.deps.gate.execute({
      actor: req.actor,
      role: req.role,
      permission: 'TEST_RUN',
      action: environment.type === 'production' ? 'risky' : 'safe',
      environment,
      runId,
      reason: `${req.trigger} run @ ${environment.type}`,
      evidence: [{ projectId: req.projectId, feature: req.feature, trigger: req.trigger, change: req.change }],
    });
    const input: CreateRunInput = {
      runId,
      projectId: req.projectId,
      businessId: req.businessId,
      feature: req.feature ?? req.change?.target,
      environment: req.environment,
      trigger: req.trigger,
      planId: req.planId,
      suiteIds: req.suiteIds,
      templateId: req.templateId,
      mode: req.mode,
      budget: req.budget,
      releaseGate: req.releaseGate,
      assetVersion: req.assetVersion,
      executionMode: internalOptions.executionMode ?? 'VERIFIED_AGENT',
    };
    const run = await this.deps.runs.create(input);
    if (gateOutcome.verdict !== 'ALLOWED') {
      const reason = `POLICY_BLOCKED：${gateOutcome.decision.reason}`;
      // 仅记录一个终态审计 Job，不进入可领取队列，保证 Worker/Tool/Data Prepare 零调用。
      await this.deps.scheduler.recordBlocked({
        runId,
        projectId: req.projectId,
        environment: req.environment,
        priority: 1,
        requiredCapability: 'general',
        idempotencyKey: req.idempotencyKey ? `blocked-job:${req.idempotencyKey}` : undefined,
        payload: { runId, policyBlocked: true, reason, trigger: req.trigger },
      }, reason);
      if (req.idempotencyKey) await this.deps.idempotency.complete('run', req.idempotencyKey, runId);
      if (gateOutcome.verdict === 'APPROVAL_REQUIRED') {
        await this.emit('ApprovalRequested', {
          approvalId: gateOutcome.approval.approvalId,
          environment: req.environment,
          projectId: req.projectId,
          reason,
        }, { runId, approvalId: gateOutcome.approval.approvalId });
      }
      await this.audit({
        actor: req.actor,
        role: req.role,
        action: 'run.create',
        resource: runId,
        environment: req.environment,
        result: gateOutcome.verdict === 'DENIED' ? 'denied' : 'pending',
        approvalId: gateOutcome.verdict === 'APPROVAL_REQUIRED' ? gateOutcome.approval.approvalId : undefined,
        detail: { trigger: req.trigger, reason },
        traceId: runId,
      });
      void run;
      return { runId, status: 'BLOCKED' };
    }
    // 调度入队（同一 Run 不重复执行由 Scheduler 保证）
    await this.deps.scheduler.enqueue({
      runId,
      projectId: req.projectId,
      environment: req.environment,
      priority: req.trigger === 'release' || req.trigger === 'pr' ? 1 : 5,
      requiredCapability: 'general',
      maxRetries: 2,
      idempotencyKey: req.idempotencyKey ? `job:${req.idempotencyKey}` : undefined,
      payload: {
        runId,
        projectId: req.projectId,
        environment: req.environment,
        trigger: req.trigger,
        change: req.change ?? { type: 'none', target: req.feature ?? req.projectId },
        businessId: req.businessId,
        feature: req.feature,
        requirementText: req.requirementText,
      },
    });
    if (req.idempotencyKey) await this.deps.idempotency.complete('run', req.idempotencyKey, runId);
    await this.emit('RunCreated', { projectId: req.projectId, environment: req.environment, trigger: req.trigger, change: req.change }, { runId });
    await this.audit({ actor: req.actor, role: req.role, action: 'run.create', resource: runId, environment: req.environment, result: 'success', detail: { trigger: req.trigger, change: req.change }, traceId: runId });
    return { runId, status: 'QUEUED' };
  }

  /** 供 Worker 调用：开始执行 */
  async startRun(runId: string): Promise<TestRun> {
    const run = await this.deps.runs.start(runId);
    await this.emit('RunStarted', { environment: run.environment }, { runId });
    return run;
  }

  async markRunGated(runId: string): Promise<TestRun> {
    return this.deps.runs.markGated(runId);
  }

  async beginRunExecution(runId: string): Promise<TestRun> {
    return this.deps.runs.beginExecution(runId);
  }

  async pauseRun(runId: string, actor: string, role: Role): Promise<TestRun> {
    this.assertPermission(role, 'TEST_RUN');
    const run = await this.deps.runs.pause(runId);
    const jobs = await this.deps.scheduler.list({ runId });
    await Promise.all(jobs.filter((job) => job.status === 'RUNNING').map((job) => this.deps.scheduler.pause(job.jobId)));
    await this.emit('RunPaused', { progress: run.progress }, { runId });
    await this.audit({ actor, role, action: 'run.pause', resource: runId, environment: run.environment, result: 'success', traceId: runId });
    return run;
  }

  async resumeRun(runId: string, actor: string, role: Role): Promise<TestRun> {
    this.assertPermission(role, 'TEST_RUN');
    const run = await this.deps.runs.resume(runId);
    const jobs = await this.deps.scheduler.list({ runId });
    await Promise.all(jobs.filter((job) => job.status === 'QUEUED').map((job) => this.deps.scheduler.resume(job.jobId)));
    await this.deps.pool.dispatch();
    await this.emit('RunResumed', { progress: run.progress }, { runId });
    await this.audit({ actor, role, action: 'run.resume', resource: runId, environment: run.environment, result: 'success', traceId: runId });
    return run;
  }

  async cancelRun(runId: string, actor: string, role: Role): Promise<TestRun> {
    this.assertPermission(role, 'TEST_CANCEL');
    const run = await this.deps.runs.cancel(runId);
    const jobs = await this.deps.scheduler.list({ runId });
    await Promise.all(jobs
      .filter((job) => job.status === 'QUEUED' || job.status === 'RUNNING' || job.status === 'RETRY')
      .map((job) => this.deps.scheduler.cancel(job.jobId)));
    await this.emit('RunFailed', { reason: 'cancelled' }, { runId });
    await this.audit({ actor, role, action: 'run.cancel', resource: runId, environment: run.environment, result: 'success', traceId: runId });
    return run;
  }

  async retryRun(runId: string, actor: string, role: Role): Promise<TestRun> {
    this.assertPermission(role, 'TEST_RETRY');
    const run = await this.deps.runs.retry(runId);
    await this.deps.scheduler.enqueue({
      runId: run.runId,
      projectId: run.projectId,
      environment: run.environment,
      requiredCapability: 'general',
      maxRetries: 2,
      payload: { runId: run.runId, projectId: run.projectId, environment: run.environment, trigger: run.trigger, change: { type: 'none', target: run.feature ?? run.projectId } },
    });
    await this.emit('RunCreated', { trigger: run.trigger, retry: true }, { runId: run.runId });
    await this.audit({ actor, role, action: 'run.retry', resource: runId, environment: run.environment, result: 'success', traceId: runId });
    return run;
  }

  async completeRun(runId: string, progress = 100): Promise<TestRun> {
    const run = await this.deps.runs.complete(runId, progress);
    await this.emit('RunCompleted', {
      progress: run.progress,
      environment: run.environment,
      projectId: run.projectId,
    }, { runId });
    return run;
  }

  async failRun(runId: string, reason?: string): Promise<TestRun> {
    const run = await this.deps.runs.fail(runId);
    // 26.7：RunFailed 通知含丰富上下文（environment / projectId）
    await this.emit('RunFailed', { reason, environment: run.environment, projectId: run.projectId }, { runId });
    return run;
  }

  async blockRun(runId: string, reason?: string): Promise<TestRun> {
    const run = await this.deps.runs.block(runId);
    await this.emit('RunFailed', { reason: reason ?? 'blocked', environment: run.environment, projectId: run.projectId }, { runId });
    return run;
  }

  async timeoutRun(runId: string, reason?: string): Promise<TestRun> {
    const run = await this.deps.runs.timeout(runId);
    await this.emit('RunFailed', { reason: reason ?? 'timeout', environment: run.environment, projectId: run.projectId }, { runId });
    return run;
  }

  async recordRunExecution(runId: string, record: PlatformRunExecutionRecord): Promise<TestRun> {
    return this.deps.runs.recordExecution(runId, record);
  }

  /** HTTP/API 调度入口；只触发当前可领取任务，不等待长任务完成。 */
  async dispatchJobs(): Promise<number> {
    return this.deps.pool.dispatch();
  }

  async getRun(runId: string): Promise<TestRun | null> {
    return this.deps.runs.get(runId);
  }

  async listRuns(filter?: Partial<TestRun>): Promise<TestRun[]> {
    return this.deps.runs.list(filter);
  }

  async getRunReport(runId: string): Promise<{ runId: string; checkpoint: unknown; jobs: TestJob[] }> {
    const checkpoint = await this.deps.runs.loadCheckpoint(runId);
    const jobs = (await this.deps.scheduler.list({ runId } as Partial<TestJob>));
    return { runId, checkpoint, jobs };
  }

  async getRunTrace(runId: string): Promise<{ runId: string; audit: unknown[] }> {
    const audit = await this.deps.audit.search({ runId });
    return { runId, audit };
  }

  // ── Checkpoint（Pause 保存 / Resume 恢复）──
  async saveCheckpoint(input: Parameters<RunService['saveCheckpoint']>[0]): Promise<unknown> {
    return this.deps.runs.saveCheckpoint(input);
  }

  async loadCheckpoint(runId: string): Promise<unknown> {
    return this.deps.runs.loadCheckpoint(runId);
  }

  // ── Workers ──
  listWorkers() {
    return this.deps.workers.list().map((w) => ({
      workerId: w.workerId,
      capabilities: w.capabilities,
      environments: w.environments,
      maxConcurrency: w.maxConcurrency,
      busy: w.busy,
      health: w.health,
      lastHeartbeatAt: w.lastHeartbeatAt,
    }));
  }

  // ── Approvals ──
  async listApprovals(filter?: Partial<ApprovalRequest>, scopes?: Scopes): Promise<ApprovalRequest[]> {
    const all = await this.deps.approvals.list(filter);
    // Phase 40.1：审批列表 Project Scope（approval → run → projectId）
    if (scopes?.projects && scopes.projects.length > 0) {
      const allowed = new Set(scopes.projects);
      const out: ApprovalRequest[] = [];
      for (const a of all) {
        if (!a.runId) { out.push(a); continue; }
        const run = await this.deps.runs.get(a.runId);
        if (!run || allowed.has(run.projectId)) out.push(a);
      }
      return out;
    }
    return all;
  }

  async approveApproval(approvalId: string, actor: string, role: Role): Promise<ApprovalRequest> {
    const approval = await this.deps.gate.approve(approvalId, actor, role);
    // 审批完成后才创建可领取 Job；createRun 阶段的 blocked Job 只是终态审计记录。
    if (approval.runId && approval.runId !== 'n/a') {
      const run = await this.deps.runs.get(approval.runId);
      if (run?.status === 'QUEUED') {
        const jobs = await this.deps.scheduler.list({ runId: run.runId });
        const hasActiveJob = jobs.some((job) => job.status === 'QUEUED' || job.status === 'RUNNING' || job.status === 'RETRY');
        if (!hasActiveJob) await this.deps.scheduler.enqueue({
          runId: run.runId,
          projectId: run.projectId,
          environment: run.environment,
          priority: 1,
          requiredCapability: 'general',
          maxRetries: 2,
          idempotencyKey: `approved-job:${approval.approvalId}`,
          payload: {
            runId: run.runId,
            projectId: run.projectId,
            environment: run.environment,
            trigger: run.trigger,
            feature: run.feature,
            approvalId: approval.approvalId,
          },
        });
      }
    }
    await this.emit('ApprovalCompleted', { status: 'APPROVED', decidedBy: actor, environment: approval.environment }, { runId: approval.runId, approvalId });
    await this.audit({ actor, role, action: 'approval', resource: approvalId, environment: approval.environment, result: 'success', approvalId, traceId: approval.runId });
    return approval;
  }

  async rejectApproval(approvalId: string, actor: string, role: Role): Promise<ApprovalRequest> {
    const approval = await this.deps.gate.reject(approvalId, actor, role);
    await this.emit('ApprovalCompleted', { status: 'REJECTED', decidedBy: actor, environment: approval.environment }, { runId: approval.runId, approvalId });
    await this.audit({ actor, role, action: 'approval', resource: approvalId, environment: approval.environment, result: 'success', approvalId, traceId: approval.runId });
    return approval;
  }

  // ── Platform Ops（24.8 视图）──
  async dashboard(): Promise<Record<string, unknown>> {
    const runs = await this.deps.runs.list({});
    const jobs = await this.deps.scheduler.list({});
    const approvals = await this.deps.approvals.list({});
    const workers = this.deps.workers.list();
    const audit = await this.deps.audit.list({});
    const byStatus: Record<string, number> = {};
    for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const metrics = await this.metrics();
    return {
      projects: this.deps.projects.listProjects().length,
      projectsList: this.deps.projects.listProjects(),
      runs: runs.length,
      runsByStatus: byStatus,
      queue: {
        queued: jobs.filter((j) => j.status === 'QUEUED').length,
        running: jobs.filter((j) => j.status === 'RUNNING').length,
        failed: jobs.filter((j) => j.status === 'FAILED').length,
      },
      workers: workers.length,
      workersOnline: workers.filter((w) => w.health === 'healthy').length,
      approvalsPending: approvals.filter((a) => a.status === 'PENDING').length,
      auditEntries: audit.length,
      successRate: runs.length ? Number(((runs.filter((r) => r.status === 'COMPLETED').length / runs.length) * 100).toFixed(1)) : 0,
      metrics,
      slo: computePlatformSlo({
        runs, jobs, workers, approvals, audit,
        apiLatencyMs: this.apiLatencySamples,
        gateLatencyMs: this.gateLatencySamples,
      }),
    };
  }

  /** 平台核心指标（任务书 16）：遥测驱动指标从 TelemetryService 真实数据计算（25.5 支持时间窗口） */
  async metrics(window: TelemetryPeriod = '7d'): Promise<PlatformMetrics> {
    const runs = await this.deps.runs.list({});
    const jobs = await this.deps.scheduler.list({});
    const workers = this.deps.workers.list();
    const approvals = await this.deps.approvals.list({});
    const audit = await this.deps.audit.list({});
    const telemetry = await this.telemetryMetricsInput(window);
    return computePlatformMetrics({
      runs, jobs, workers, approvals, audit,
      apiLatencyMs: this.apiLatencySamples,
      gateLatencyMs: this.gateLatencySamples,
      telemetry,
    });
  }

  /** 指标激活状态（25.5）：tracked=false 指标按真实遥测自动激活 */
  async metricsActivation(): Promise<{ records: Array<{ metric: string; activated: boolean; firstActivatedAt: string | null; lastSampleAt: string | null; sampleCount: number }>; activeCount: number }> {
    const status = await this.deps.telemetry.activationStatus();
    return { records: status.records, activeCount: status.activeCount };
  }

  /** 遥测快照（25.6 供 Dashboard）：cost / rcaAccuracy / flakyRate / healing */
  async telemetrySnapshot(window: TelemetryPeriod = '7d'): Promise<ReturnType<TelemetryService['metricsSnapshot']>> {
    return this.deps.telemetry.metricsSnapshot(window);
  }

  /** 成本汇总（25.6 供 Dashboard） */
  async telemetryCost(window: TelemetryPeriod = '7d'): Promise<ReturnType<TelemetryService['costMetrics']>> {
    return this.deps.telemetry.costMetrics(window);
  }

  /** 遥测事件（25.6 供 Dashboard；runId 可选） */
  async telemetryEvents(runId?: string): Promise<TelemetryEvent[]> {
    return runId ? this.deps.telemetry.eventsByRun(runId) : this.deps.telemetry.events.list({});
  }

  /** 调度任务（25.6 供 Dashboard） */
  async listJobs(): Promise<TestJob[]> {
    return this.deps.scheduler.list({});
  }

  /** 审计日志（25.6 供 Dashboard） */
  async listAudit(): Promise<AuditEntry[]> {
    return this.deps.audit.list({});
  }

  /** 从遥测服务汇总真实指标（无数据一律 tracked=false，禁止虚构） */
  private async telemetryMetricsInput(window: TelemetryPeriod = '7d'): Promise<MetricsTelemetryInput> {
    const snap = await this.deps.telemetry.metricsSnapshot(window);
    return {
      cost: snap.cost.total,
      // 执行侧成本（计算/Agent 时长折算）在本阶段未单独计费；不虚构，保持 tracked=false
      executionCost: { value: null, tracked: false, unit: 'CNY' },
      costPerRun: snap.cost.perRun,
      costPerFeature: snap.cost.perFeature,
      rcaAccuracy: snap.rcaAccuracy,
      flakyRate: snap.flakyRate,
      healingRate: snap.healing.successRate,
    };
  }

  /** Run Detail：Run + Checkpoint + Trace（阶段链路） */
  async runDetail(runId: string): Promise<Record<string, unknown> | null> {
    const run = await this.deps.runs.get(runId);
    if (!run) return null;
    const checkpoint = await this.loadCheckpoint(runId);
    const trace = await this.getRunTrace(runId);
    const approvals = (await this.deps.approvals.list({ runId })).map((a) => ({
      approvalId: a.approvalId,
      action: a.action,
      riskLevel: a.riskLevel,
      status: a.status,
      decidedBy: a.decidedBy,
      decidedAt: a.decidedAt,
    }));
    return { run, checkpoint, trace, approvals };
  }

  // ═══════════════════════ QA Workflow（Phase 39）═══════════════════════
  // 复用既有 RBAC / Repository / Notification / Audit / Telemetry，不新增第二套权限。
  // 所有变更操作记录审计；列表操作按 scopes 过滤项目（跨项目隔离）。

  // ── Test Suite（39.1）──
  async createSuite(input: { projectId: string; name: string; description?: string; caseIds?: string[]; tags?: string[]; createdBy: string }, role: Role): Promise<import('../workflow/index.js').TestSuite> {
    this.assertPermission(role, 'ASSET_WRITE');
    const suite = await this.deps.workflow.suites.create(input);
    await this.audit({ actor: input.createdBy, role, action: 'configuration', resource: `suite:${suite.id}`, result: 'success', detail: { action: 'create', name: suite.name, projectId: suite.projectId } });
    return suite;
  }

  async listSuites(filter?: Partial<import('../workflow/index.js').TestSuite>, scopes?: Scopes): Promise<import('../workflow/index.js').TestSuite[]> {
    const all = await this.deps.workflow.suites.list(filter);
    return this.filterByScopes(all, scopes, (s) => s.projectId);
  }

  async getSuite(id: string, scopes?: Scopes): Promise<import('../workflow/index.js').TestSuite | null> {
    const suite = await this.deps.workflow.suites.get(id);
    if (!suite) return null;
    // Phase 40.1：单资源读端点 Project Scope（JWT 用户不能越权读取其它项目 Suite）
    if (scopes) assertRunAccess({ roles: ['VIEWER'], scopes }, suite.projectId, 'test');
    return suite;
  }

  async updateSuite(id: string, input: { name?: string; description?: string; tags?: string[] }, actor: string, role: Role): Promise<import('../workflow/index.js').TestSuite> {
    this.assertPermission(role, 'ASSET_WRITE');
    const suite = await this.deps.workflow.suites.update(id, input);
    await this.audit({ actor, role, action: 'configuration', resource: `suite:${id}`, result: 'success', detail: { action: 'update', ...input } });
    return suite;
  }

  async addSuiteCases(id: string, caseIds: string[], actor: string, role: Role): Promise<import('../workflow/index.js').TestSuite> {
    this.assertPermission(role, 'ASSET_WRITE');
    const suite = await this.deps.workflow.suites.addCases(id, caseIds);
    await this.audit({ actor, role, action: 'configuration', resource: `suite:${id}`, result: 'success', detail: { action: 'addCases', count: caseIds.length } });
    return suite;
  }

  async removeSuiteCases(id: string, caseIds: string[], actor: string, role: Role): Promise<import('../workflow/index.js').TestSuite> {
    this.assertPermission(role, 'ASSET_WRITE');
    const suite = await this.deps.workflow.suites.removeCases(id, caseIds);
    await this.audit({ actor, role, action: 'configuration', resource: `suite:${id}`, result: 'success', detail: { action: 'removeCases', count: caseIds.length } });
    return suite;
  }

  async archiveSuite(id: string, actor: string, role: Role): Promise<import('../workflow/index.js').TestSuite> {
    this.assertPermission(role, 'ASSET_WRITE');
    const suite = await this.deps.workflow.suites.archive(id);
    await this.audit({ actor, role, action: 'configuration', resource: `suite:${id}`, result: 'success', detail: { action: 'archive' } });
    return suite;
  }

  async restoreSuite(id: string, actor: string, role: Role): Promise<import('../workflow/index.js').TestSuite> {
    this.assertPermission(role, 'ASSET_WRITE');
    const suite = await this.deps.workflow.suites.restore(id);
    await this.audit({ actor, role, action: 'configuration', resource: `suite:${id}`, result: 'success', detail: { action: 'restore' } });
    return suite;
  }

  async copySuite(id: string, by: string, role: Role): Promise<import('../workflow/index.js').TestSuite> {
    this.assertPermission(role, 'ASSET_WRITE');
    const suite = await this.deps.workflow.suites.copy(id, by);
    await this.audit({ actor: by, role, action: 'configuration', resource: `suite:${id}`, result: 'success', detail: { action: 'copy', copyId: suite.id } });
    return suite;
  }

  async listSuitesByTag(tags: string[], scopes?: Scopes): Promise<import('../workflow/index.js').TestSuite[]> {
    const all = await this.deps.workflow.suites.listByTags(tags);
    return this.filterByScopes(all, scopes, (s) => s.projectId);
  }

  // ── Test Plan（39.2）──
  async createPlan(input: { projectId: string; name: string; suiteIds?: string[]; environment: string; mode: import('../workflow/index.js').TestPlanMode; budget?: unknown; releaseGate?: unknown; createdBy: string }, role: Role): Promise<import('../workflow/index.js').TestPlan> {
    this.assertPermission(role, 'ASSET_WRITE');
    const plan = await this.deps.workflow.plans.create(input);
    await this.audit({ actor: input.createdBy, role, action: 'configuration', resource: `plan:${plan.id}`, result: 'success', detail: { action: 'create', name: plan.name, projectId: plan.projectId, mode: plan.mode } });
    return plan;
  }

  async listPlans(filter?: Partial<import('../workflow/index.js').TestPlan>, scopes?: Scopes): Promise<import('../workflow/index.js').TestPlan[]> {
    const all = await this.deps.workflow.plans.list(filter);
    return this.filterByScopes(all, scopes, (p) => p.projectId);
  }

  async getPlan(id: string, scopes?: Scopes): Promise<import('../workflow/index.js').TestPlan | null> {
    const plan = await this.deps.workflow.plans.get(id);
    if (!plan) return null;
    if (scopes) assertRunAccess({ roles: ['VIEWER'], scopes }, plan.projectId, plan.environment);
    return plan;
  }

  async updatePlan(id: string, input: { name?: string; suiteIds?: string[]; environment?: string; mode?: import('../workflow/index.js').TestPlanMode; budget?: unknown; releaseGate?: unknown }, actor: string, role: Role): Promise<import('../workflow/index.js').TestPlan> {
    this.assertPermission(role, 'ASSET_WRITE');
    const plan = await this.deps.workflow.plans.update(id, input);
    await this.audit({ actor, role, action: 'configuration', resource: `plan:${id}`, result: 'success', detail: { action: 'update', ...input } });
    return plan;
  }

  /** 解析 Plan → 去重 Case 列表（API/CLI 预览用） */
  async planCases(planId: string, scopes?: Scopes): Promise<{ planId: string; caseIds: string[] }> {
    const plan = await this.deps.workflow.plans.get(planId);
    if (!plan) throw new CodedError(ErrorCode.NOT_FOUND, `Test Plan 不存在：${planId}`);
    if (scopes) assertRunAccess({ roles: ['VIEWER'], scopes }, plan.projectId, plan.environment);
    const caseIds = await this.deps.workflow.suites.resolveCaseIds(plan.suiteIds);
    return { planId, caseIds };
  }

  /** 按 Plan 直接运行（39.2 核心路径：Plan → Suite → TestCase → Run） */
  async runPlan(planId: string, actor: string, role: Role, scopes?: Scopes): Promise<{ runId: string; status: string }> {
    this.assertPermission(role, 'TEST_RUN');
    const plan = await this.deps.workflow.plans.get(planId);
    if (!plan) throw new CodedError(ErrorCode.NOT_FOUND, `Test Plan 不存在：${planId}`);
    const caseIds = await this.deps.workflow.suites.resolveCaseIds(plan.suiteIds);
    const assetVersion: Record<string, number> = {};
    for (const cid of caseIds) assetVersion[cid] = await this.deps.workflow.versions.latestVersion(cid);
    const trigger: RunTrigger = plan.mode === 'AUTONOMOUS' ? 'autonomous' : 'manual';
    const created = await this.createRun({
      projectId: plan.projectId,
      environment: plan.environment,
      trigger,
      feature: plan.name,
      actor, role, scopes,
      planId,
      suiteIds: plan.suiteIds,
      mode: plan.mode,
      budget: plan.budget as number | undefined,
      releaseGate: plan.releaseGate as boolean | undefined,
      assetVersion,
    });
    await this.audit({ actor, role, action: 'run.create', resource: created.runId, environment: plan.environment, result: 'success', detail: { via: 'plan', planId }, traceId: created.runId });
    return created;
  }

  // ── Run Template（39.3）──
  async createTemplate(input: { projectId: string; name: string; description?: string; environment: string; suiteIds: string[]; mode: import('../workflow/index.js').TestPlanMode; budget?: number; releaseGate?: boolean; createdBy: string }, role: Role): Promise<import('../workflow/index.js').RunTemplate> {
    this.assertPermission(role, 'ASSET_WRITE');
    const t = await this.deps.workflow.templates.create(input);
    await this.audit({ actor: input.createdBy, role, action: 'configuration', resource: `template:${t.id}`, result: 'success', detail: { action: 'create', name: t.name } });
    return t;
  }

  async listTemplates(filter?: Partial<import('../workflow/index.js').RunTemplate>, scopes?: Scopes): Promise<import('../workflow/index.js').RunTemplate[]> {
    const all = await this.deps.workflow.templates.list(filter);
    return this.filterByScopes(all, scopes, (t) => t.projectId);
  }

  async getTemplate(id: string, scopes?: Scopes): Promise<import('../workflow/index.js').RunTemplate | null> {
    const t = await this.deps.workflow.templates.get(id);
    if (!t) return null;
    if (scopes) assertRunAccess({ roles: ['VIEWER'], scopes }, t.projectId, t.environment);
    return t;
  }

  async updateTemplate(id: string, input: Partial<Pick<import('../workflow/index.js').RunTemplate, 'name' | 'description' | 'environment' | 'suiteIds' | 'mode' | 'budget' | 'releaseGate'>>, actor: string, role: Role): Promise<import('../workflow/index.js').RunTemplate> {
    this.assertPermission(role, 'ASSET_WRITE');
    const t = await this.deps.workflow.templates.update(id, input);
    await this.audit({ actor, role, action: 'configuration', resource: `template:${id}`, result: 'success', detail: { action: 'update', ...input } });
    return t;
  }

  /** Save as Template：只复制 Configuration（不复制结果/RCA/门禁决策） */
  async saveTemplateFromRun(runId: string, name: string, actor: string, role: Role, scopes?: Scopes): Promise<import('../workflow/index.js').RunTemplate> {
    this.assertPermission(role, 'ASSET_WRITE');
    const run = await this.deps.runs.get(runId);
    if (!run) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    if (scopes) assertRunAccess({ roles: [role], scopes }, run.projectId, run.environment);
    const t = await this.deps.workflow.templates.saveFromRun(
      { projectId: run.projectId, environment: run.environment, suiteIds: run.suiteIds ?? [], mode: (run.mode as import('../workflow/index.js').TestPlanMode) ?? 'MANUAL', budget: run.budget, releaseGate: run.releaseGate },
      { name, createdBy: actor },
    );
    await this.audit({ actor, role, action: 'configuration', resource: `template:${t.id}`, result: 'success', detail: { action: 'saveFromRun', runId }, traceId: runId });
    return t;
  }

  /** Run Template：直接生成新 Run（仅 Configuration；复用计数 +1） */
  async runTemplate(templateId: string, actor: string, role: Role, scopes?: Scopes): Promise<{ runId: string; status: string }> {
    this.assertPermission(role, 'TEST_RUN');
    const config = await this.deps.workflow.templates.resolve(templateId);
    if (scopes) assertRunAccess({ roles: [role], scopes }, config.projectId, config.environment);
    const caseIds = await this.deps.workflow.suites.resolveCaseIds(config.suiteIds);
    const assetVersion: Record<string, number> = {};
    for (const cid of caseIds) assetVersion[cid] = await this.deps.workflow.versions.latestVersion(cid);
    const trigger: RunTrigger = config.mode === 'AUTONOMOUS' ? 'autonomous' : 'manual';
    const created = await this.createRun({
      projectId: config.projectId,
      environment: config.environment,
      trigger,
      feature: config.suiteIds.length ? `template:${config.suiteIds.join(',')}` : undefined,
      actor, role, scopes,
      suiteIds: config.suiteIds,
      templateId,
      mode: config.mode,
      budget: config.budget,
      releaseGate: config.releaseGate,
      assetVersion,
    });
    await this.deps.workflow.templates.recordRun(templateId);
    await this.audit({ actor, role, action: 'run.create', resource: created.runId, environment: config.environment, result: 'success', detail: { via: 'template', templateId }, traceId: created.runId });
    return created;
  }

  // ── Run 复用（39.3/39.7：Run Again / Clone Configuration）──
  /** Run Again：只复制 project / environment / suite / plan / mode / budget（不复制结果/RCA/门禁决策） */
  async rerunRun(runId: string, actor: string, role: Role, scopes?: Scopes): Promise<{ runId: string; status: string }> {
    this.assertPermission(role, 'TEST_RETRY');
    const run = await this.deps.runs.get(runId);
    if (!run) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    if (scopes) assertRunAccess({ roles: [role], scopes }, run.projectId, run.environment);
    const created = await this.createRun({
      projectId: run.projectId,
      environment: run.environment,
      trigger: run.trigger,
      actor, role, scopes,
      planId: run.planId,
      suiteIds: run.suiteIds,
      templateId: run.templateId,
      mode: run.mode,
      budget: run.budget,
      releaseGate: run.releaseGate,
      assetVersion: run.assetVersion,
    });
    await this.audit({ actor, role, action: 'run.retry', resource: created.runId, environment: run.environment, result: 'success', detail: { via: 'rerun', sourceRun: runId }, traceId: created.runId });
    return created;
  }

  /** Clone Configuration：允许修改 environment / budget / releaseGate（禁止复用旧状态/结果/追踪） */
  async cloneRun(runId: string, overrides: { environment?: string; budget?: number; releaseGate?: boolean }, actor: string, role: Role, scopes?: Scopes): Promise<{ runId: string; status: string }> {
    this.assertPermission(role, 'TEST_RETRY');
    const run = await this.deps.runs.get(runId);
    if (!run) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    if (scopes) assertRunAccess({ roles: [role], scopes }, run.projectId, run.environment);
    const created = await this.createRun({
      projectId: run.projectId,
      environment: overrides.environment ?? run.environment,
      trigger: run.trigger,
      actor, role, scopes,
      planId: run.planId,
      suiteIds: run.suiteIds,
      templateId: run.templateId,
      mode: run.mode,
      budget: overrides.budget ?? run.budget,
      releaseGate: overrides.releaseGate ?? run.releaseGate,
      assetVersion: run.assetVersion,
    });
    await this.audit({ actor, role, action: 'run.retry', resource: created.runId, environment: overrides.environment ?? run.environment, result: 'success', detail: { via: 'clone', sourceRun: runId, overrides }, traceId: created.runId });
    return created;
  }

  // ── Test Asset Versioning（39.4）──
  async assetVersions(assetId: string, scopes?: Scopes): Promise<import('../workflow/index.js').AssetVersionSummary[]> {
    const versions = await this.deps.workflow.versions.history(assetId);
    // Phase 40.1：单资源读端点 Project Scope（JWT 用户不能越权读取其它项目资产版本）
    if (versions.length && scopes?.projects && scopes.projects.length > 0) {
      const projectId = await this.resolveAssetProject(assetId, versions[versions.length - 1].assetType);
      if (projectId) assertRunAccess({ roles: ['VIEWER'], scopes }, projectId, 'test');
    }
    return versions;
  }

  /** 解析资产所属项目（suite/plan/test-case；解析不到则放行——无法证明跨项目） */
  private async resolveAssetProject(assetId: string, assetType: import('../workflow/index.js').AssetType): Promise<string | null> {
    if (assetType === 'suite') {
      const s = await this.deps.workflow.suites.get(assetId);
      return s?.projectId ?? null;
    }
    if (assetType === 'plan') {
      const p = await this.deps.workflow.plans.get(assetId);
      return p?.projectId ?? null;
    }
    const c = await this.deps.testAssets.get(assetId);
    return c?.projectId ?? null;
  }

  async assetCompare(assetId: string, fromVersion: number, toVersion: number): Promise<import('../workflow/index.js').AssetDiff> {
    return this.deps.workflow.versions.compare(assetId, fromVersion, toVersion);
  }

  /** 资产新版本：snapshot 为完整新状态；返回新版本记录 */
  async recordAssetVersion(input: { assetType: import('../workflow/index.js').AssetType; assetId: string; snapshot: Record<string, unknown>; createdBy: string; changeReason?: string }, role: Role): Promise<import('../workflow/index.js').AssetVersion> {
    this.assertPermission(role, 'ASSET_WRITE');
    const v = await this.deps.workflow.versions.recordVersion(input);
    await this.audit({ actor: input.createdBy, role, action: 'configuration', resource: `asset:${input.assetId}`, result: 'success', detail: { action: 'newVersion', version: v.version, reason: input.changeReason } });
    return v;
  }

  /** 回滚取快照（调用方应用） */
  async assetRollbackSnapshot(assetId: string, version: number): Promise<Record<string, unknown>> {
    return this.deps.workflow.versions.rollbackSnapshot(assetId, version);
  }

  // ── Collaboration（39.5）──
  async addRunComment(runId: string, body: string, actor: string, role: Role, scopes?: Scopes): Promise<{ comment: import('../workflow/index.js').CommentEntry; mentions: string[] }> {
    const run = await this.deps.runs.get(runId);
    if (!run) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    if (scopes) assertRunAccess({ roles: [role], scopes }, run.projectId, run.environment);
    const { item, mentions } = await this.deps.workflow.collaboration.addComment({ resourceType: 'run', resourceId: runId, projectId: run.projectId, author: actor, body });
    const preview = body.length > 60 ? `${body.slice(0, 60)}…` : body;
    await this.emit('CollaborationComment', { author: actor, resourceType: 'run', resourceId: runId, preview }, { runId });
    for (const u of mentions) {
      await this.emit('CollaborationMention', { author: actor, resourceType: 'run', resourceId: runId, mention: u, preview }, { runId });
    }
    await this.audit({ actor, role, action: 'collaboration.comment', resource: `run:${runId}`, environment: run.environment, result: 'success', detail: { mentions }, traceId: runId });
    void item;
    return { comment: item.comments[item.comments.length - 1], mentions };
  }

  async listRunComments(runId: string, scopes?: Scopes, role: Role = 'VIEWER'): Promise<import('../workflow/index.js').CommentEntry[]> {
    const run = await this.deps.runs.get(runId);
    if (!run) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    if (scopes) assertRunAccess({ roles: [role], scopes }, run.projectId, run.environment);
    return this.deps.workflow.collaboration.comments('run', runId);
  }

  async assignRun(runId: string, assignees: string[], actor: string, role: Role, scopes?: Scopes): Promise<import('../workflow/index.js').CollaborationItem> {
    const run = await this.deps.runs.get(runId);
    if (!run) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    if (scopes) assertRunAccess({ roles: [role], scopes }, run.projectId, run.environment);
    const item = await this.deps.workflow.collaboration.assign({ resourceType: 'run', resourceId: runId, projectId: run.projectId, assignees });
    await this.audit({ actor, role, action: 'collaboration.assign', resource: `run:${runId}`, environment: run.environment, result: 'success', detail: { assignees }, traceId: runId });
    return item;
  }

  // ── Defect 管理（40.2）──
  async createDefect(input: {
    projectId: string;
    title: string;
    severity?: import('../workflow/index.js').DefectSeverity;
    environment?: string;
    runId?: string;
    caseId?: string;
    description?: string;
    evidence?: unknown[];
    createdBy: string;
  }, role: Role, scopes?: Scopes): Promise<import('../workflow/index.js').Defect> {
    this.assertPermission(role, 'DEFECT_CREATE');
    if (scopes) assertProjectAccess({ roles: [role], scopes }, input.projectId);
    const d = await this.deps.workflow.defects.create(input);
    await this.emit('DefectCreated', { defectId: d.defectId, title: d.title, severity: d.severity, projectId: d.projectId, runId: d.runId, caseId: d.caseId, reason: d.description }, { runId: d.runId });
    await this.audit({ actor: input.createdBy, role, action: 'defect', resource: `defect:${d.defectId}`, environment: d.environment, result: 'success', detail: { action: 'create', title: d.title, severity: d.severity }, traceId: d.runId });
    return d;
  }

  async listDefects(filter?: Partial<import('../workflow/index.js').Defect>, scopes?: Scopes): Promise<import('../workflow/index.js').Defect[]> {
    const all = await this.deps.workflow.defects.list(filter);
    return this.filterByScopes(all, scopes, (d) => d.projectId);
  }

  async getDefect(id: string, scopes?: Scopes): Promise<import('../workflow/index.js').Defect | null> {
    const d = await this.deps.workflow.defects.get(id);
    if (!d) return null;
    if (scopes) assertProjectAccess({ roles: ['VIEWER'], scopes }, d.projectId);
    return d;
  }

  async updateDefectStatus(id: string, status: import('../workflow/index.js').DefectStatus, resolution: string | undefined, actor: string, role: Role, scopes?: Scopes): Promise<import('../workflow/index.js').Defect> {
    this.assertPermission(role, 'ASSET_WRITE');
    const d = await this.deps.workflow.defects.get(id);
    if (!d) throw new CodedError(ErrorCode.NOT_FOUND, `缺陷不存在：${id}`);
    if (scopes) assertProjectAccess({ roles: [role], scopes }, d.projectId);
    const updated = await this.deps.workflow.defects.updateStatus(id, status, resolution);
    await this.audit({ actor, role, action: 'defect', resource: `defect:${id}`, environment: d.environment, result: 'success', detail: { action: 'updateStatus', from: d.status, to: status }, traceId: d.runId });
    return updated;
  }

  async assignDefect(id: string, assignee: string, actor: string, role: Role, scopes?: Scopes): Promise<import('../workflow/index.js').Defect> {
    this.assertPermission(role, 'ASSET_WRITE');
    const d = await this.deps.workflow.defects.get(id);
    if (!d) throw new CodedError(ErrorCode.NOT_FOUND, `缺陷不存在：${id}`);
    if (scopes) assertProjectAccess({ roles: [role], scopes }, d.projectId);
    const updated = await this.deps.workflow.defects.assign(id, assignee);
    await this.audit({ actor, role, action: 'defect', resource: `defect:${id}`, environment: d.environment, result: 'success', detail: { action: 'assign', assignee }, traceId: d.runId });
    return updated;
  }

  // ── Report / Share（39.6）──
  async runReport(runId: string): Promise<import('../workflow/index.js').RunReportSummary> {
    const run = await this.deps.runs.get(runId);
    if (!run) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    return this.deps.workflow.reports.buildSummary(run);
  }

  async shareRun(runId: string, actor: string, role: Role, scopes?: Scopes): Promise<{ token: string; url: string; share: import('../workflow/index.js').RunShare }> {
    const run = await this.deps.runs.get(runId);
    if (!run) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    if (scopes) assertRunAccess({ roles: [role], scopes }, run.projectId, run.environment);
    const share = await this.deps.workflow.reports.share(run, actor);
    await this.audit({ actor, role, action: 'configuration', resource: `run:${runId}`, environment: run.environment, result: 'success', detail: { action: 'share' }, traceId: runId });
    // Phase 40.3：返回契约补 token 顶层字段（前端 RunDetail 依赖 { token, url }；share 保留兼容 CLI/report-share 测试）
    return { token: share.token, url: `/runs/${runId}/report?share=${share.token}`, share };
  }

  async verifyShare(runId: string, token: string): Promise<boolean> {
    return this.deps.workflow.reports.verifyShare(runId, token);
  }

  async exportReportJson(runId: string): Promise<string> {
    const run = await this.deps.runs.get(runId);
    if (!run) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    return this.deps.workflow.reports.exportJson(run);
  }

  async exportReportHtml(runId: string): Promise<string> {
    const run = await this.deps.runs.get(runId);
    if (!run) throw new CodedError(ErrorCode.NOT_FOUND, `Run 不存在：${runId}`);
    return this.deps.workflow.reports.exportHtml(run);
  }

  // ── QA Workflow Dashboard（39.7）──
  async qaHome(scopes?: Scopes): Promise<import('../workflow/index.js').QaHome> {
    return this.deps.workflow.qaHome.build(scopes);
  }

  /** 通用项目作用域过滤（JWT 用户跨项目隔离） */
  private filterByScopes<T>(items: T[], scopes: Scopes | undefined, projectOf: (item: T) => string): T[] {
    if (!scopes?.projects || scopes.projects.length === 0) return items;
    const allowed = new Set(scopes.projects);
    return items.filter((i) => allowed.has(projectOf(i)));
  }


  /** 测试资产（26.2）：真实 Test Case 列表 */
  async listTestAssets(filter?: Partial<import('../test-assets/platform-test-assets.js').PlatformTestAsset>): Promise<import('../test-assets/platform-test-assets.js').PlatformTestAsset[]> {
    return this.deps.testAssets.list(filter);
  }

  /** 测试资产统计（26.2）：total / byCategory / byPriority / bySource */
  async testAssetStats(): Promise<import('../test-assets/platform-test-assets.js').TestAssetStats> {
    return this.deps.testAssets.stats();
  }

  /** 平台健康检查（26.4 升级）：逐项探针容错 → HEALTHY / DEGRADED / DOWN；报告调度暂停状态 */
  async health(): Promise<{ ok: boolean; status: 'HEALTHY' | 'DEGRADED' | 'DOWN'; checks: Array<{ name: string; ok: boolean; detail: string }> }> {
    type Check = { name: string; ok: boolean; detail: string };
    const startup = this.startup.status();
    if (!startup.ready) {
      return {
        ok: false,
        status: 'DOWN',
        checks: [{
          name: 'startup',
          ok: false,
          detail: `${startup.storage}:${startup.state}${startup.error ? `（${startup.error}）` : ''}`,
        }],
      };
    }
    const probe = async (fn: () => Promise<string> | string): Promise<string> => {
      const detail = await fn();
      return detail;
    };
    const checks: Check[] = [{
      name: 'startup',
      ok: true,
      detail: `${startup.storage}:${startup.state}${startup.appliedMigrations.length ? `（本次迁移 ${startup.appliedMigrations.join(', ')}）` : ''}`,
    }];

    const names: Array<{ name: string; run: () => Promise<string> | string }> = [
      { name: 'projects', run: () => `${this.deps.projects.listProjects().length} 个` },
      { name: 'runs', run: async () => `${(await this.deps.runs.list({})).length} 个` },
      {
        name: 'scheduler',
        run: async () => `${(await this.deps.scheduler.list({})).length} 个 Job${this.deps.scheduler.isDispatchPaused() ? '（PAUSED）' : ''}`,
      },
      {
        name: 'workers',
        run: () => {
          const ws = this.deps.workers.list();
          return `${ws.length} 个（online ${ws.filter((w) => w.health === 'healthy').length}）`;
        },
      },
      { name: 'approvals', run: async () => `${(await this.deps.approvals.list({})).length} 个` },
      { name: 'audit', run: async () => `${(await this.deps.audit.list({})).length} 条` },
      { name: 'telemetry', run: async () => `${(await this.deps.telemetry.events.list({})).length} 事件 / ${(await this.deps.telemetry.costs.list({})).length} 成本` },
      { name: 'activation', run: async () => `${(await this.deps.telemetry.activationStatus()).activeCount} 指标激活` },
      { name: 'test-assets', run: async () => `${(await this.deps.testAssets.count())} 个 Test Case` },
    ];

    for (const c of names) {
      try {
        const detail = await probe(c.run);
        // workers 单项允许为空（无 Worker 在线不视为平台故障）
        const ok = c.name === 'workers' ? this.deps.workers.list().length === 0 || this.deps.workers.list().some((w) => w.health === 'healthy') : true;
        checks.push({ name: c.name, ok, detail });
      } catch (err) {
        checks.push({ name: c.name, ok: false, detail: `不可用：${(err as Error).message}` });
      }
    }

    const failed = checks.filter((c) => !c.ok);
    const failedProbes = checks.slice(1).filter((c) => !c.ok);
    const status: 'HEALTHY' | 'DEGRADED' | 'DOWN' = failed.length === 0
      ? 'HEALTHY'
      : failedProbes.length === checks.length - 1
        ? 'DOWN'
        : 'DEGRADED';
    return { ok: failed.length === 0, status, checks };
  }
}
