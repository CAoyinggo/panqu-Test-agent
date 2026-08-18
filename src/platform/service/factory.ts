// Platform Service 工厂（Phase 24.7）：一次性装配全部依赖
// API / CLI / 测试共用同一装配入口，保证单一业务逻辑。

import path from 'node:path';
import { ProjectService } from '../projects/project-service.js';
import { standardEnvironments } from '../projects/project-schema.js';
import { createRepository, type StorageKind } from '../storage/index.js';
import { RunService } from '../runs/run-service.js';
import type { RunEntity } from '../runs/run-service.js';
import { CheckpointStore, type RunCheckpoint } from '../runs/checkpoint.js';
import { Scheduler } from '../scheduler/scheduler.js';
import type { TestJob } from '../scheduler/test-job.js';
import { WorkerRegistry, WorkerPool } from '../workers/index.js';
import { ApprovalCenter } from '../approval-center/approval-center.js';
import type { ApprovalRequest } from '../approval-center/approval-schema.js';
import { PlatformGate } from '../rbac/platform-gate.js';
import { EventBus } from '../events/event-bus.js';
import { NotificationDispatcher, consoleChannel } from '../notifications/index.js';
import { AuditLog } from '../audit/audit-log.js';
import type { AuditEntry } from '../audit/audit-log.js';
import { IdempotencyStore } from './idempotency.js';
import type { IdempotencyRecord } from './idempotency.js';
import { PlatformService } from './platform-service.js';

export interface PlatformFactoryOptions {
  /** 是否初始化一个演示项目（默认 true，便于开箱即用） */
  seedProject?: boolean;
  /** 时间源（测试确定性） */
  now?: () => string;
  /** 项目 JSON 持久化文件 */
  projectsFile?: string;
  /** 存储后端：memory | json（默认 memory；CLI 可传 json 实现跨进程持久化） */
  storage?: StorageKind;
}

export interface PlatformBundle {
  service: PlatformService;
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
  /** 注入 Worker 执行器（执行真实 Job 的逻辑；不注入则 Worker 不可执行） */
  registerWorkerExecutor: (workerId: string, exec: (job: unknown) => Promise<unknown>) => void;
}

/** 装配平台（Modular Monolith，单进程内存态 + JSON 持久化可替换） */
export function createPlatformService(opts: PlatformFactoryOptions = {}): PlatformBundle {
  const now = opts.now ?? (() => new Date().toISOString());
  const storage: StorageKind = opts.storage ?? 'memory';
  const dataDir = platformDataDir();

  const projects = new ProjectService({
    persist: storage === 'json',
    file: opts.projectsFile ?? (storage === 'json' ? path.join(dataDir, 'projects.json') : undefined),
    now,
  });

  const runsRepo = createRepository<RunEntity>(storage, { collection: 'runs', dir: dataDir });
  const checkpoints = new CheckpointStore(createRepository<RunCheckpoint>(storage, { collection: 'checkpoints', dir: dataDir }));
  const runs = new RunService(runsRepo, projects, checkpoints, { now });

  const jobsRepo = createRepository<TestJob>(storage, { collection: 'jobs', dir: dataDir });
  const scheduler = new Scheduler(jobsRepo, { now });

  // 单一时钟源：nowMs 由 now() 派生，避免固定时间注入时 Worker 被误判 DOWN
  const workers = new WorkerRegistry({ heartbeatTimeoutMs: 10_000, now, nowMs: () => Date.parse(now()) });
  const pool = new WorkerPool(workers, scheduler);

  const approvalsRepo = createRepository<ApprovalRequest>(storage, { collection: 'approvals', dir: dataDir });
  const approvals = new ApprovalCenter(approvalsRepo, { now });
  const gate = new PlatformGate(approvals);

  const bus = new EventBus({ now });
  const notifier = new NotificationDispatcher();
  notifier.register(consoleChannel('console'));

  const audit = new AuditLog(createRepository<AuditEntry>(storage, { collection: 'audit', dir: dataDir }), { now });
  const idempotency = new IdempotencyStore(createRepository<IdempotencyRecord>(storage, { collection: 'idempotency', dir: dataDir }), { now });

  if (opts.seedProject ?? true) {
    // 幂等种子：仅当项目不存在时创建（JSON 持久化下跨进程不重复）
    if (!projects.getProject('wan3')) {
      const seed = projects.createProject({
        id: 'wan3',
        name: 'WAN3 文生视频',
        businesses: ['text-to-video', 'video-editor'],
        environments: standardEnvironments(),
      });
      void seed;
    }
  }

  const service = new PlatformService({ projects, runs, scheduler, workers, pool, approvals, gate, bus, notifier, audit, idempotency });

  const registerWorkerExecutor = (workerId: string, exec: (job: unknown) => Promise<unknown>): void => {
    workers.register(
      { workerId, capabilities: ['general'], environments: ['test', 'staging', 'dev'], maxConcurrency: 2 },
      exec,
    );
  };

  return { service, projects, runs, scheduler, workers, pool, approvals, gate, bus, notifier, audit, idempotency, registerWorkerExecutor };
}

/** 默认平台数据目录（运维脚本用） */
export function platformDataDir(): string {
  return path.join(process.env.TESTFLOW_OUTPUT_DIR || 'output', 'platform');
}
