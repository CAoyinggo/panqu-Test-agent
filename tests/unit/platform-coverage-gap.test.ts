// 单元测试：Phase 30 覆盖率补齐（DEBT-08）
// 背景：将 `src/platform/**` 纳入 vitest coverage include 后，暴露以下缺口模块：
//   events/event-bus（clear/统计）、notifications/dispatcher（模板/上下文分支）、
//   ops/migrations（PostgreSQL 迁移）、projects/environment-policy（决策描述）、
//   scheduler（pause/resume 边界/clear/环境过滤重排）、workers/worker-registry（统计/执行器/健康边界）、
//   runs/checkpoint（删除/清理/空查询）。
// 目标：平台层业务模块行/函数/分支/语句覆盖趋向 80/80/75/80 门禁。
import { describe, it, expect, vi } from 'vitest';
import { Pool } from 'pg';
import { EventBus, type PlatformEvent } from '../../src/platform/events/index.js';
import {
  NotificationDispatcher,
  buildNotificationMessage,
  EVENT_NOTIFICATION_TEMPLATES,
} from '../../src/platform/notifications/index.js';
import type { NotificationChannel } from '../../src/platform/notifications/index.js';
import {
  applySqliteMigrations,
  applyPostgresMigrations,
  listAppliedPostgres,
  ensurePostgresMigrationsTable,
} from '../../src/platform/ops/migrations.js';
import { createSqliteDatabase } from '../../src/platform/storage/sqlite/database.js';
import { resolveEnvironmentDecision, describeDecision, isProductionLike } from '../../src/platform/projects/index.js';
import { Scheduler, isJobTerminal } from '../../src/platform/scheduler/index.js';
import type { TestJob } from '../../src/platform/scheduler/index.js';
import { InMemoryRepository } from '../../src/platform/storage/index.js';
import { WorkerRegistry, WorkerPool } from '../../src/platform/workers/index.js';
import { CheckpointStore, type RunCheckpoint } from '../../src/platform/runs/index.js';

/** 构造最小 PlatformEvent（data/timestamp 必填） */
function ev(type: PlatformEvent['type'], overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  return { type, data: {}, timestamp: '2026-08-18T00:00:00.000Z', ...overrides };
}

describe('EventBus：统计与清理（Phase 30 补齐）', () => {
  it('listenerCount(type)/无参、totalPublished、clear', async () => {
    const bus = new EventBus({ now: () => '2026-08-18T00:00:00.000Z' });
    const fn = vi.fn();
    bus.subscribe('RunCreated', fn);
    bus.subscribeAll(fn);
    expect(bus.listenerCount('RunCreated')).toBe(1);
    expect(bus.listenerCount('RunFailed')).toBe(0);
    expect(bus.listenerCount()).toBe(2);
    expect(bus.totalPublished()).toBe(0);
    await bus.publish(ev('RunCreated'));
    expect(bus.totalPublished()).toBe(1);
    // 类型订阅 + 全局订阅均收到
    expect(fn).toHaveBeenCalledTimes(2);
    bus.clear();
    expect(bus.listenerCount()).toBe(0);
    expect(bus.listenerCount('RunCreated')).toBe(0);
  });
});

describe('NotificationDispatcher：模板与上下文分支（Phase 30 补齐）', () => {
  it('notifyEvent 生成各类型消息并携带/省略上下文后缀', async () => {
    const dispatcher = new NotificationDispatcher();
    const sent: string[] = [];
    const channel: NotificationChannel = {
      name: 'spy',
      send: async (m) => {
        sent.push(`${m.title}|${m.severity}|${m.body}`);
        return { ok: true };
      },
    };
    dispatcher.register(channel);
    // 带 environment / projectId → 上下文后缀含 env / project
    await dispatcher.notifyEvent({
      type: 'ReleaseBlock', runId: 'r-1', data: { reason: 'x', environment: 'production', projectId: 'wan3' }, timestamp: 't',
    });
    // 无 runId / data 环境 → 上下文后缀回退 '-' 且不出现 env=
    await dispatcher.notifyEvent({ type: 'BudgetExhausted', data: { reason: 'y' }, timestamp: 't' });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('发布阻塞');
    expect(sent[0]).toContain('critical');
    expect(sent[0]).toContain('env=production');
    expect(sent[0]).toContain('project=wan3');
    expect(sent[1]).toContain('预算耗尽');
    expect(sent[1]).toContain('run=-');
    expect(sent[1]).not.toContain('env=');
  });

  it('buildNotificationMessage 覆盖全部模板类型（title/severity 非空）', () => {
    const types = Object.keys(EVENT_NOTIFICATION_TEMPLATES) as Array<PlatformEvent['type']>;
    expect(types.length).toBeGreaterThan(20);
    for (const type of types) {
      const msg = buildNotificationMessage(ev(type, { runId: `r-${type}` }));
      expect(msg.title.length).toBeGreaterThan(0);
      expect(msg.severity).toBeTruthy();
      expect(msg.eventType).toBe(type);
      expect(msg.runId).toBe(`r-${type}`);
    }
  });
});

describe('Migrations：PostgreSQL 迁移（Phase 30 补齐）', () => {
  /** mock Pool：追踪 _migrations 表状态与查询（pg-mem 不支持多列约束 DDL，改用 fake） */
  function fakePool(): Pool {
    const migrations: string[] = [];
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    return {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (sql.includes('SELECT id FROM "_migrations"')) return { rows: migrations.map((id) => ({ id })) };
        if (sql.includes('INSERT INTO "_migrations"')) {
          migrations.push(params![0] as string);
          return { rows: [] };
        }
        // 建表（_migrations / 各集合）与其余语句
        return { rows: [] };
      },
      async end() {},
    } as unknown as Pool;
  }

  it('ensurePostgresMigrationsTable / listAppliedPostgres / applyPostgresMigrations 幂等', async () => {
    const pool = fakePool();
    await ensurePostgresMigrationsTable(pool);
    expect(await listAppliedPostgres(pool)).toEqual([]);
    const first = await applyPostgresMigrations(pool);
    expect(first).toContain('v1');
    // 幂等：已记录后再次查询不再重新应用
    const second = await applyPostgresMigrations(pool);
    expect(second).toEqual([]);
    expect(await listAppliedPostgres(pool)).toContain('v1');
    await pool.end();
  });

  it('SQLite 迁移：应用后 _migrations 记录可查', () => {
    const db = createSqliteDatabase(':memory:');
    const inserted = applySqliteMigrations(db);
    expect(inserted).toContain('v1');
    const applied = db.prepare('SELECT id FROM "_migrations"').all() as Array<{ id: string }>;
    expect(applied.map((r) => r.id)).toContain('v1');
    db.close();
  });
});

describe('EnvironmentPolicy：决策描述与策略源兜底（Phase 30 补齐）', () => {
  it('describeDecision 覆盖三种决策', () => {
    expect(describeDecision('allow')).toBe('允许');
    expect(describeDecision('approval')).toBe('需审批');
    expect(describeDecision('deny')).toBe('拒绝');
  });

  it('resolveEnvironmentDecision 无 custom 时回退单一策略源', () => {
    expect(resolveEnvironmentDecision({ type: 'production', safetyPolicy: {} }, 'risky')).toBe('approval');
    expect(resolveEnvironmentDecision({ type: 'production', safetyPolicy: {} }, 'dangerous')).toBe('deny');
    expect(resolveEnvironmentDecision({ type: 'dev', safetyPolicy: {} }, 'dangerous')).toBe('approval');
  });

  it('isProductionLike 仅生产档位为 true', () => {
    expect(isProductionLike('dev')).toBe(false);
    expect(isProductionLike('test')).toBe(false);
    expect(isProductionLike('staging')).toBe(true);
    expect(isProductionLike('preprod')).toBe(true);
    expect(isProductionLike('production')).toBe(true);
  });
});

describe('Scheduler：暂停/恢复边界、环境过滤重排与清理（Phase 30 补齐）', () => {
  function makeScheduler(): Scheduler {
    const repo = new InMemoryRepository<TestJob>('job');
    return new Scheduler(repo, { now: () => '2026-08-18T00:00:00.000Z' });
  }

  it('pause 仅对 RUNNING 生效；resume 仅对 QUEUED 生效；其余态原样返回', async () => {
    const s = makeScheduler();
    const { job } = await s.enqueue({ runId: 'r-pause', projectId: 'wan3', environment: 'test', priority: 5 });
    // QUEUED 态 pause → 原样
    expect((await s.pause(job.jobId)).status).toBe('QUEUED');
    await s.next({});
    // RUNNING 态 pause → 回 QUEUED
    expect((await s.pause(job.jobId)).status).toBe('QUEUED');
    // QUEUED 态 resume → 原样
    expect((await s.resume(job.jobId)).status).toBe('QUEUED');
    await s.next({});
    await s.complete(job.jobId);
    // SUCCESS 态 resume → 原样
    expect((await s.resume(job.jobId)).status).toBe('SUCCESS');
  });

  it('requeueRetries 支持环境过滤；isJobTerminal 判定；clear 清空', async () => {
    const s = makeScheduler();
    await s.enqueue({ runId: 'r1', projectId: 'p', environment: 'test', priority: 5 });
    await s.enqueue({ runId: 'r2', projectId: 'p', environment: 'staging', priority: 5 });
    for (const j of await s.list()) await s.fail(j.jobId, 'boom');
    const requeued = await s.requeueRetries('test');
    expect(requeued).toBe(1);
    const all = await s.list();
    expect(all.find((j) => j.environment === 'test')!.status).toBe('QUEUED');
    expect(all.find((j) => j.environment === 'staging')!.status).toBe('RETRY');

    expect(isJobTerminal('SUCCESS')).toBe(true);
    expect(isJobTerminal('FAILED')).toBe(true);
    expect(isJobTerminal('CANCELLED')).toBe(true);
    expect(isJobTerminal('QUEUED')).toBe(false);
    expect(isJobTerminal('RUNNING')).toBe(false);
    expect(isJobTerminal('RETRY')).toBe(false);

    await s.clear();
    expect(await s.pendingCount()).toBe(0);
  });
});

describe('WorkerRegistry：统计、执行器与健康边界（Phase 30 补齐）', () => {
  const FIXED_MS = Date.parse('2026-08-18T00:00:00.000Z');

  function makeReg(nowMs: () => number = () => FIXED_MS): WorkerRegistry {
    return new WorkerRegistry({
      heartbeatTimeoutMs: 1000,
      now: () => new Date(nowMs()).toISOString(),
      nowMs,
    });
  }

  it('count / getExecutor / evaluateHealth 未注册→down / healthyWorkers 过滤 / release 下界 / down 心跳恢复', () => {
    const reg = makeReg();
    expect(reg.count()).toBe(0);
    expect(reg.getExecutor('missing')).toBeNull();
    expect(reg.evaluateHealth('missing')).toBe('down');
    expect(reg.healthyWorkers()).toHaveLength(0);

    reg.register({ workerId: 'w1', capabilities: ['general'], environments: ['test'], maxConcurrency: 2 }, async () => ({ ok: true }));
    expect(reg.count()).toBe(1);
    expect(reg.getExecutor('w1')).toBeTypeOf('function');
    expect(reg.healthyWorkers().map((w) => w.workerId)).toEqual(['w1']);

    // 占用/释放下界：busy 不降到负
    reg.acquire('w1');
    reg.release('w1');
    reg.release('w1');
    expect(reg.get('w1')!.busy).toBe(0);

    reg.markDown('w1', 'boom');
    expect(reg.healthyWorkers()).toHaveLength(0);
    expect(reg.evaluateHealth('w1')).toBe('down');
    // down 后心跳恢复 healthy
    reg.heartbeat('w1');
    expect(reg.get('w1')!.health).toBe('healthy');
  });

  it('缺省选项构造；心跳未超时保持健康；对不存在 Worker 的 acquire/release 静默', () => {
    const reg = new WorkerRegistry(); // 缺省 opts（真实时钟，默认 30s 超时）
    expect(reg.count()).toBe(0);
    reg.register({ workerId: 'w2', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async () => ({ ok: true }));
    // 不存在 Worker 的槽位操作静默
    reg.acquire('missing');
    reg.release('missing');
    // 注册即心跳（registeredAt=lastHeartbeatAt=now），未超时保持 healthy
    expect(reg.evaluateHealth('w2')).toBe('healthy');
    expect(reg.get('w2')!.health).toBe('healthy');
  });
});

describe('WorkerPool：异常执行器与孤儿回收边界（Phase 30 补齐）', () => {
  function makeEnv() {
    const FIXED_MS = Date.parse('2026-08-18T00:00:00.000Z');
    const nowIso = () => new Date(FIXED_MS).toISOString();
    const reg = new WorkerRegistry({ heartbeatTimeoutMs: 1000, now: nowIso, nowMs: () => FIXED_MS });
    const jobs = new InMemoryRepository<TestJob>('job');
    const sched = new Scheduler(jobs, { now: nowIso });
    const pool = new WorkerPool(reg, sched);
    return { reg, sched, pool };
  }

  it('执行器抛非 Error 值 → Job 置 FAILED 并记录原文', async () => {
    const { reg, sched, pool } = makeEnv();
    reg.register({ workerId: 'w', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async () => {
      throw 'boom-string'; // 非 Error 异常
    });
    const { job } = await sched.enqueue({ runId: 'r-err', projectId: 'p', environment: 'test', priority: 5, maxRetries: 0 });
    await pool.dispatch();
    await pool.drain();
    expect((await sched.get(job.jobId))!.status).toBe('FAILED');
    expect((await sched.get(job.jobId))!.error).toBe('boom-string');
  });

  it('recoverOrphans 回收 claimedBy 已注销/不存在的 RUNNING Job → RETRY', async () => {
    const { sched, pool } = makeEnv();
    await sched.enqueue({ runId: 'r-orphan', projectId: 'p', environment: 'test', priority: 5 });
    // 原子领取为 RUNNING，claimedBy 指向不存在的 Worker（模拟其已注销）
    await sched.next({ claimedBy: 'ghost' });
    const recovered = await pool.recoverOrphans();
    expect(recovered).toBe(1);
    const jobs = await sched.list();
    expect(jobs.find((j) => j.runId === 'r-orphan')!.status).toBe('RETRY');
  });
});

describe('CheckpointStore：删除、清理与空查询（Phase 30 补齐）', () => {
  function makeStore(): CheckpointStore {
    return new CheckpointStore(new InMemoryRepository<RunCheckpoint>('ckpt'));
  }

  it('load 无检查点返回 null；delete 存在项/不存在静默；clear 清空', async () => {
    const store = makeStore();
    expect(await store.load('r-missing')).toBeNull();
    await store.delete('r-missing'); // 不存在静默

    const c1 = await store.save({ runId: 'r1', stage: 's', completedCases: [], remainingCases: [], decisionState: {}, budgetState: {}, traceId: 't1' });
    expect((await store.load('r1'))!.id).toBe(c1.id);
    await store.delete('r1');
    expect(await store.load('r1')).toBeNull();

    const c2 = await store.save({ runId: 'r2', stage: 's', completedCases: [], remainingCases: [], decisionState: {}, budgetState: {}, traceId: 't2' });
    expect(c2.id).toMatch(/^ckpt-/);
    await store.clear();
    expect(await store.load('r2')).toBeNull();
  });
});
