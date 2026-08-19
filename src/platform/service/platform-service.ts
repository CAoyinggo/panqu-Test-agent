// Platform Service（Phase 24.7）：统一 Service Layer
// API 与 CLI 共用；Scheduler / Worker / Dashboard / Audit 也统一从这里进出。
// 职责：Project / Run 生命周期 / 调度入队 / 审批 / 权限门禁 / 事件发布 / 审计 / 幂等 / 平台运维视图。

import type { ProjectService } from '../projects/project-service.js';
import type { Project } from '../projects/project-schema.js';
import type { RunService } from '../runs/run-service.js';
import type { TestRun, CreateRunInput, RunTrigger } from '../runs/run-schema.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { TestJob } from '../scheduler/test-job.js';
import type { WorkerRegistry } from '../workers/worker-registry.js';
import type { WorkerPool } from '../workers/worker-pool.js';
import type { ApprovalCenter } from '../approval-center/approval-center.js';
import type { ApprovalRequest } from '../approval-center/approval-schema.js';
import type { PlatformGate } from '../rbac/platform-gate.js';
import { hasPermission, type Role, type Permission } from '../rbac/rbac.js';
import { assertRunAccess } from '../rbac/scopes.js';
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
  change?: RunChange;
  actor: string;
  role: Role;
  /** 25.3 资源作用域（JWT 认证用户带入）；缺省不做项目/环境隔离 */
  scopes?: Scopes;
  idempotencyKey?: string;
}

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
}

export class PlatformService {
  /** API / Gate 延迟样本（毫秒，运维指标用；内存环形采样） */
  private apiLatencySamples: number[] = [];
  private gateLatencySamples: number[] = [];

  constructor(public readonly deps: PlatformServiceDeps) {}

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
      throw new Error(`角色 ${role} 缺少权限 ${permission}`);
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
  /** 创建 Run：RBAC → 项目/环境作用域 → 校验项目/环境 → 幂等去重 → 调度入队 → 事件 → 审计 */
  async createRun(req: CreateRunRequest): Promise<{ runId: string; status: 'QUEUED' }> {
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
        if (run) return { runId: run.runId, status: run.status as 'QUEUED' };
      }
    }
    const runId = generatePlatformRunId('run');
    const input: CreateRunInput = {
      runId,
      projectId: req.projectId,
      businessId: req.businessId,
      feature: req.feature ?? req.change?.target,
      environment: req.environment,
      trigger: req.trigger,
    };
    const run = await this.deps.runs.create(input);
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

  async pauseRun(runId: string, actor: string, role: Role): Promise<TestRun> {
    this.assertPermission(role, 'TEST_RUN');
    const run = await this.deps.runs.pause(runId);
    await this.emit('RunPaused', { progress: run.progress }, { runId });
    await this.audit({ actor, role, action: 'run.pause', resource: runId, environment: run.environment, result: 'success', traceId: runId });
    return run;
  }

  async resumeRun(runId: string, actor: string, role: Role): Promise<TestRun> {
    this.assertPermission(role, 'TEST_RUN');
    const run = await this.deps.runs.resume(runId);
    await this.emit('RunResumed', { progress: run.progress }, { runId });
    await this.audit({ actor, role, action: 'run.resume', resource: runId, environment: run.environment, result: 'success', traceId: runId });
    return run;
  }

  async cancelRun(runId: string, actor: string, role: Role): Promise<TestRun> {
    this.assertPermission(role, 'TEST_CANCEL');
    const run = await this.deps.runs.cancel(runId);
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
    await this.emit('RunCompleted', { progress: run.progress }, { runId });
    return run;
  }

  async failRun(runId: string, reason?: string): Promise<TestRun> {
    const run = await this.deps.runs.fail(runId);
    // 26.7：RunFailed 通知含丰富上下文（environment / projectId）
    await this.emit('RunFailed', { reason, environment: run.environment, projectId: run.projectId }, { runId });
    return run;
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
  async listApprovals(filter?: Partial<ApprovalRequest>): Promise<ApprovalRequest[]> {
    return this.deps.approvals.list(filter);
  }

  async approveApproval(approvalId: string, actor: string, role: Role): Promise<ApprovalRequest> {
    const approval = await this.deps.gate.approve(approvalId, actor, role);
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
    const probe = async (fn: () => Promise<string> | string): Promise<string> => {
      const detail = await fn();
      return detail;
    };
    const checks: Check[] = [];

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
    const status: 'HEALTHY' | 'DEGRADED' | 'DOWN' = failed.length === 0 ? 'HEALTHY' : failed.length === checks.length ? 'DOWN' : 'DEGRADED';
    return { ok: failed.length === 0, status, checks };
  }
}
