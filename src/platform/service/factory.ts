// Platform Service 工厂（Phase 24.7）：一次性装配全部依赖
// API / CLI / 测试共用同一装配入口，保证单一业务逻辑。

import path from 'node:path';
import { ProjectService } from '../projects/project-service.js';
import { standardEnvironments } from '../projects/project-schema.js';
import { createRepository, type StorageKind, type Repository, type Entity } from '../storage/index.js';
import { createSqliteDatabase, sqliteDataFile } from '../storage/sqlite/database.js';
import { createPostgresPool, requirePostgresConnectionString } from '../storage/postgres/pg-database.js';
import { applySqliteMigrations } from '../ops/migrations.js';
import type { Pool } from 'pg';
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
import { NotificationDispatcher, consoleChannel, feishuChannel } from '../notifications/index.js';
import { AuditLog } from '../audit/audit-log.js';
import type { AuditEntry } from '../audit/audit-log.js';
import { IdempotencyStore } from './idempotency.js';
import type { IdempotencyRecord } from './idempotency.js';
import { PlatformService } from './platform-service.js';
import { UserStore, AuthService } from '../auth/index.js';
import type { UserRecord } from '../auth/index.js';
import { redactSensitiveText } from '../../core/redact.js';
import { PlatformTestAssets } from '../test-assets/platform-test-assets.js';
import { TelemetryService, TelemetryEventStore, CostLedger, RcaVerificationStore, FlakyRecordStore, HealingRecordStore, ReleaseRecordStore, MetricActivationTracker } from '../telemetry/index.js';
import { isProductionLike, requireSecureJwtSecret, resolveAllowDefaultCredentials, resolvePlatformMode, type PlatformMode } from '../security/index.js';
// Phase 39：QA Workflow 模块（Test Suite / Plan / Template / Versioning / Collaboration / Report / QA Home）
// Phase 40.2：Defect 管理
import {
  WorkflowService,
  TestSuiteService,
  TestPlanService,
  RunTemplateService,
  AssetVersioningService,
  CollaborationService,
  RunReportService,
  QaHomeService,
  DefectService,
} from '../workflow/index.js';
import type { TestSuite } from '../workflow/test-suite.js';
import type { TestPlan } from '../workflow/test-plan.js';
import type { RunTemplate } from '../workflow/run-template.js';
import type { AssetVersion } from '../workflow/asset-versioning.js';
import type { CollaborationItem } from '../workflow/collaboration.js';
import type { RunShare } from '../workflow/run-report.js';
import type { Defect } from '../workflow/defects.js';
import type {
  TelemetryEvent,
  CostLedgerEntry,
  RcaVerification,
  FlakyRecord,
  HealingRecord,
  ReleaseRecord,
  MetricActivationRecord,
} from '../telemetry/index.js';
import { PostgresStartup, createReadyStartup, type PlatformStartupStatus } from './startup.js';

export interface PlatformFactoryOptions {
  /** 是否初始化一个演示项目（默认 true，便于开箱即用） */
  seedProject?: boolean;
  /** 时间源（测试确定性） */
  now?: () => string;
  /** 项目 JSON 持久化文件 */
  projectsFile?: string;
  /** 平台数据目录（默认 output/platform；测试可隔离） */
  dataDir?: string;
  /** 存储后端：memory | json | sqlite | postgres（默认 memory；CLI 默认 sqlite 实现跨进程持久化） */
  storage?: StorageKind;
  /** PostgreSQL 连接串；未传时读取 DATABASE_URL。选择 postgres 时必须显式存在。 */
  databaseUrl?: string;
  /** 已构造的连接池（测试/嵌入场景）；仍必须提供 databaseUrl/DATABASE_URL 完成配置校验。 */
  postgresPool?: Pool;
  /** JWT 签名密钥（缺省用 JWT_SECRET 或开发默认值） */
  jwtSecret?: string;
  /** 是否种子默认用户（默认 true；production 由运维显式创建） */
  seedUsers?: boolean;
  /** 是否允许默认口令登录（默认 true；production 必须 false） */
  allowDefaultCredentials?: boolean;
  /** 26.4：仓储包装器（故障注入/观测用）；默认恒等。收到集合名与仓储，返回包装后的仓储 */
  wrapRepository?: <T extends Entity>(name: string, repo: Repository<T>) => Repository<T>;
  /** 26.7：真实飞书自定义机器人 Webhook URL（如 https://open.feishu.cn/open-apis/bot/v2/hook/xxx）；
   *  配置后平台事件（6 类关键通知等）真实投递飞书；缺省仅 console。 */
  feishuWebhookUrl?: string;
  /** 27.1：运行模式（缺省按 PLATFORM_MODE 解析；development/test 允许开发回退，production/staging 强制安全约束） */
  mode?: PlatformMode;
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
  /** 用户存储（25.3） */
  users: UserStore;
  /** JWT 认证服务（25.3）：login / logout / refresh / info / verify */
  auth: AuthService;
  /** 遥测服务（25.4）：真实 LLM 成本 / RCA 真值 / Flaky / Healing / Release */
  telemetry: TelemetryService;
  /** 原始数据仓库映射（25.8）：15 集合 → Repository<T>；供备份/恢复/运维直接访问 */
  repositories: Record<string, Repository<Entity>>;
  /** 测试资产库（26.2）：真实 Test Case 资产（查询/统计/导入；同存储后端持久化） */
  testAssets: PlatformTestAssets;
  /** QA Workflow（Phase 39）：Suite / Plan / Template / Versioning / Collaboration / Report / QA Home */
  workflow: WorkflowService;
  /** 27.1：生效的运行模式（安全约束依据；development/test 允许回退，production/staging 强制） */
  mode: PlatformMode;
  /** 执行启动屏障；PostgreSQL 下连接和迁移全部成功后才返回。 */
  start: () => Promise<void>;
  /** 释放 PostgreSQL pool 等资源（幂等）。 */
  close: () => Promise<void>;
  /** 当前启动状态。 */
  startupStatus: () => PlatformStartupStatus;
  /** 注入 Worker 执行器（执行真实 Job 的逻辑；不注入则 Worker 不可执行） */
  registerWorkerExecutor: (workerId: string, exec: import('../workers/worker.js').WorkerExecutor) => void;
}

/** 装配平台（Modular Monolith，单进程内存态 + JSON / SQLite 持久化可替换） */
export function createPlatformService(opts: PlatformFactoryOptions = {}): PlatformBundle {
  const now = opts.now ?? (() => new Date().toISOString());
  const storage: StorageKind = opts.storage ?? 'memory';
  const dataDir = opts.dataDir ?? platformDataDir();
  // 27.1：运行模式统一解析；生产安全约束在装配期强制（JWT_SECRET / 默认口令）
  const mode: PlatformMode = opts.mode ?? resolvePlatformMode();
  const jwtSecret = requireSecureJwtSecret(mode, opts.jwtSecret ?? process.env.JWT_SECRET);
  const allowDefaultCredentials = resolveAllowDefaultCredentials(mode, opts.allowDefaultCredentials);
  // sqlite：单进程共享一个连接（所有集合在同一 .sqlite 文件）
  const sqliteDb = storage === 'sqlite' ? createSqliteDatabase(sqliteDataFile(dataDir)) : undefined;
  // postgres：必须显式 DATABASE_URL；生产类模式额外拒绝 postgres/postgres 弱默认凭据。
  const databaseUrl = storage === 'postgres'
    ? requirePostgresConnectionString(opts.databaseUrl ?? process.env.DATABASE_URL, isProductionLike(mode))
    : undefined;
  const pgPool = storage === 'postgres'
    ? (opts.postgresPool ?? createPostgresPool({ connectionString: databaseUrl, productionLike: isProductionLike(mode) }))
    : undefined;
  // SQLite 同步迁移可在装配期完成；PostgreSQL 必须由异步 startup gate 阻塞完成。
  if (sqliteDb) {
    const applied = applySqliteMigrations(sqliteDb);
    if (applied.length) console.warn(`[platform] 已应用 SQLite 迁移：${applied.join(', ')}`);
  }
  const startup = pgPool ? new PostgresStartup(pgPool) : createReadyStartup();
  const store = (collection: string) => ({ collection, dir: dataDir, db: sqliteDb, pool: pgPool });
  // 25.8：原始仓库映射（备份/恢复/运维直接访问全部集合）
  const repos: Record<string, Repository<Entity>> = {};
  const wrapRepository: <T extends Entity>(name: string, repo: Repository<T>) => Repository<T> =
    opts.wrapRepository ?? (<T extends Entity>(_name: string, repo: Repository<T>) => repo);
  const reg = <T extends Entity>(name: string, repo: Repository<T>): Repository<T> => {
    const wrapped = wrapRepository(name, repo);
    repos[name] = wrapped as Repository<Entity>;
    return wrapped;
  };

  const projects = new ProjectService({
    persist: storage !== 'memory',
    file: opts.projectsFile ?? (storage === 'json' ? path.join(dataDir, 'projects.json') : undefined),
    storage,
    sqliteDb,
    now,
  });

  const runsRepo = reg('runs', createRepository<RunEntity>(storage, store('runs')));
  const checkpoints = new CheckpointStore(reg('checkpoints', createRepository<RunCheckpoint>(storage, store('checkpoints'))));
  const runs = new RunService(runsRepo, projects, checkpoints, { now });

  const jobsRepo = reg('jobs', createRepository<TestJob>(storage, store('jobs')));
  const scheduler = new Scheduler(jobsRepo, { now });

  // 单一时钟源：nowMs 由 now() 派生，避免固定时间注入时 Worker 被误判 DOWN
  const workers = new WorkerRegistry({ heartbeatTimeoutMs: 10_000, now, nowMs: () => Date.parse(now()) });
  const pool = new WorkerPool(workers, scheduler);
  scheduler.setAbortHandler((jobId, reason) => pool.abort(jobId, reason));

  const approvalsRepo = reg('approvals', createRepository<ApprovalRequest>(storage, store('approvals')));
  const approvals = new ApprovalCenter(approvalsRepo, { now });
  const gate = new PlatformGate(approvals);

  const bus = new EventBus({ now });
  const notifier = new NotificationDispatcher();
  notifier.register(consoleChannel('console'));
  // 26.7：真实飞书通道（配置 FEISHU_WEBHOOK_URL 后平台事件真实投递飞书）
  if (opts.feishuWebhookUrl) {
    notifier.register(feishuChannel({ name: 'feishu', url: opts.feishuWebhookUrl }));
  }

  const audit = new AuditLog(reg('audit', createRepository<AuditEntry>(storage, store('audit'))), { now });
  const idempotency = new IdempotencyStore(reg('idempotency', createRepository<IdempotencyRecord>(storage, store('idempotency'))), { now });
  pool.setIdempotencyStore(idempotency);

  // 25.3：用户存储 + JWT 认证（用户落同一存储后端）
  const users = new UserStore(reg('users', createRepository<UserRecord>(storage, store('users'))));
  const auth = new AuthService(users, {
    secret: jwtSecret,
    now: () => Date.parse(now()),
    allowDefaultCredentials,
    // 27.1：生产/预发模式禁止开发密钥回退（双保险；装配期 requireSecureJwtSecret 已强制）
    requireSecureSecret: isProductionLike(mode),
    audit,
  });
  if (opts.seedUsers ?? true) {
    void auth.ensureSeeded().catch((err: Error) => {
      // 种子失败不使平台崩溃；调用方可稍后显式 ensureSeeded 重试
      console.warn(`[platform] 用户种子初始化失败（可稍后重试）：${redactSensitiveText(err.message)}`);
    });
  }

  // 25.4：遥测服务（事件 / 成本账本 / RCA 真值 / Flaky / Healing / Release 同后端落库）
  // 同步装配：6 个类型化 Store 全部基于 Repository<T>，与平台数据同一存储后端。
  // 25.5：指标激活跟踪器同后端持久化（tracked=false → 真实数据自动激活）。
  const telemetry = new TelemetryService({
    now,
    events: new TelemetryEventStore(reg('telemetry-events', createRepository<TelemetryEvent>(storage, store('telemetry-events')))),
    costs: new CostLedger(reg('cost-ledger', createRepository<CostLedgerEntry>(storage, store('cost-ledger')))),
    rca: new RcaVerificationStore(reg('rca-verifications', createRepository<RcaVerification>(storage, store('rca-verifications')))),
    flaky: new FlakyRecordStore(reg('flaky-records', createRepository<FlakyRecord>(storage, store('flaky-records')))),
    healing: new HealingRecordStore(reg('healing-records', createRepository<HealingRecord>(storage, store('healing-records')))),
    releases: new ReleaseRecordStore(reg('release-records', createRepository<ReleaseRecord>(storage, store('release-records')))),
    activation: new MetricActivationTracker(reg('metric-activations', createRepository<MetricActivationRecord>(storage, store('metric-activations'))), now),
  });

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

  // 26.2：WAN3 真实 Test Case 资产装配（导入由 onboarding 显式执行：CLI `platform assets import`）
  const testAssets = new PlatformTestAssets(reg('test-assets', createRepository<import('../test-assets/platform-test-assets.js').PlatformTestAsset>(storage, store('test-assets'))));

  // Phase 39：QA Workflow 装配（Suite / Plan / Template / Versioning / Collaboration / Report / QA Home）
  // 全部复用 Repository<T> 统一存储后端（自动纳入备份/恢复/迁移/审计）。
  const suites = new TestSuiteService(reg('test-suites', createRepository<TestSuite>(storage, store('test-suites'))));
  const plans = new TestPlanService(reg('test-plans', createRepository<TestPlan>(storage, store('test-plans'))));
  const templates = new RunTemplateService(reg('run-templates', createRepository<RunTemplate>(storage, store('run-templates'))));
  const versions = new AssetVersioningService(reg('asset-versions', createRepository<AssetVersion>(storage, store('asset-versions'))));
  const collaboration = new CollaborationService(reg('collaboration', createRepository<CollaborationItem>(storage, store('collaboration'))));
  const reports = new RunReportService(
    { runs, approvals, telemetry },
    reg('run-reports', createRepository<RunShare>(storage, store('run-reports'))),
  );
  const defects = new DefectService(reg('defects', createRepository<Defect>(storage, store('defects'))));
  const qaHome = new QaHomeService({ projects, runs, approvals, telemetry, suites, plans, templates, defects });
  const workflow = new WorkflowService({ suites, plans, templates, versions, collaboration, reports, qaHome, defects });

  const service = new PlatformService(
    { projects, runs, scheduler, workers, pool, approvals, gate, bus, notifier, audit, idempotency, telemetry, testAssets, workflow },
    startup,
  );

  const registerWorkerExecutor = (workerId: string, exec: import('../workers/worker.js').WorkerExecutor): void => {
    workers.register(
      { workerId, capabilities: ['general'], environments: ['test', 'staging', 'dev'], maxConcurrency: 2 },
      exec,
    );
  };

  return {
    service,
    projects,
    runs,
    scheduler,
    workers,
    pool,
    approvals,
    gate,
    bus,
    notifier,
    audit,
    idempotency,
    users,
    auth,
    telemetry,
    repositories: repos,
    testAssets,
    workflow,
    mode,
    start: () => service.start(),
    close: () => service.shutdown(),
    startupStatus: () => service.startupStatus(),
    registerWorkerExecutor,
  };
}

/** 默认平台数据目录（运维脚本用） */
export function platformDataDir(): string {
  return path.join(process.env.TESTFLOW_OUTPUT_DIR || 'output', 'platform');
}
