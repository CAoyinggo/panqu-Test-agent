#!/usr/bin/env node
// Platform CLI（Phase 24.7）：与 HTTP API 共用 Service Layer
// 用法：
//   node dist/bin/platform-cli.js project list
//   node dist/bin/platform-cli.js project create <id> --name <name> [--business b1,b2]
//   node dist/bin/platform-cli.js run create --project wan3 --environment test --trigger manual [--feature x] [--no-execute]
//   node dist/bin/platform-cli.js run list [--status QUEUED]
//   node dist/bin/platform-cli.js run get <id>
//   node dist/bin/platform-cli.js run pause <id>
//   node dist/bin/platform-cli.js run resume <id>
//   node dist/bin/platform-cli.js run cancel <id>
//   node dist/bin/platform-cli.js run retry <id>
//   node dist/bin/platform-cli.js worker list
//   node dist/bin/platform-cli.js approval list
//   node dist/bin/platform-cli.js platform health
//   node dist/bin/platform-cli.js platform dashboard
// 身份：PLATFORM_ACTOR（默认 cli）/ PLATFORM_ROLE（默认 ADMIN）
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createPlatformService, createPlatformServer } from '../src/platform/index.js';
import type { PlatformBundle } from '../src/platform/index.js';
import type { RunTrigger, Role, TelemetryPeriod } from '../src/platform/index.js';
import { withLLMTelemetry, runContext } from '../src/platform/index.js';
import { MockLLMProvider } from '../src/llm/mock-llm.js';
import { createSqliteDatabase, sqliteDataFile } from '../src/platform/storage/sqlite/database.js';
import { createPostgresPool } from '../src/platform/storage/postgres/pg-database.js';
import {
  applySqliteMigrations,
  applyPostgresMigrations,
  listAppliedSqlite,
  listAppliedPostgres,
  MIGRATIONS,
} from '../src/platform/ops/migrations.js';
import { collectSnapshot, restoreSnapshot, snapshotTotal } from '../src/platform/ops/backup.js';
import { runPlatformSmoke } from '../src/platform/ops/smoke.js';
import { runPlatformPreflight, preflightSummary } from '../src/platform/ops/preflight.js';
import { platformDataDir } from '../src/platform/index.js';

function actor(): string {
  return process.env.PLATFORM_ACTOR ?? 'cli';
}
function role(): Role {
  return (process.env.PLATFORM_ROLE as Role) ?? 'ADMIN';
}

/** 解析存储后端：STORAGE_BACKEND=json|memory|sqlite|postgres；未指定默认 sqlite（Phase 25.1/25.2） */
function resolveStorageKind(v: string | undefined): 'json' | 'memory' | 'sqlite' | 'postgres' {
  if (v === 'json' || v === 'memory' || v === 'sqlite' || v === 'postgres') return v;
  if (v) {
    console.warn(`[platform] 未知 STORAGE_BACKEND=${v}，回退 sqlite`);
  }
  return 'sqlite';
}

/** 简单 --key value 解析 */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i > -1 && args[i + 1] ? args[i + 1] : undefined;
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** 队列排空：注册了 Worker 时把 Run 执行到完成 */
async function dispatchUntilIdle(bundle: PlatformBundle, maxIters = 200): Promise<number> {
  let iters = 0;
  while (iters < maxIters) {
    const assigned = await bundle.pool.dispatch();
    await bundle.pool.drain();
    const pending = await bundle.scheduler.pendingCount();
    if (assigned === 0 && pending === 0) break;
    iters += 1;
  }
  return iters;
}

/** 注册演示 Worker：模拟自治流水线（start → LLM 环节 → checkpoint → complete），
 * 真实执行 + LLM 调用经遥测装饰器记录到 CostLedger / TelemetryEvent。 */
function registerCliWorker(bundle: PlatformBundle): void {
  // LLM（离线 Mock）经遥测装饰器：真实 token 用量 → CostLedger / cost / llm 事件
  const provider = withLLMTelemetry(new MockLLMProvider(), bundle.telemetry);
  bundle.registerWorkerExecutor('cli-worker', async (job: unknown) => {
    // 注意：executor 收到的是 job.payload（含 runId/projectId/environment/feature）
    const j = job as { runId: string; projectId: string; environment: string; feature?: string };
    const feature = j.feature;
    await runContext.run({ runId: j.runId, projectId: j.projectId, feature }, async () => {
      await bundle.service.startRun(j.runId);
      await bundle.telemetry.recordExecution({ runId: j.runId, projectId: j.projectId, feature, phase: 'pipeline', result: 'success' });
      // 模拟自治流水线 LLM 环节（执行分析 / 修复建议），产生真实 usage → 成本
      await provider.generate({ messages: [{ role: 'user', content: '分析本次执行结果与失败原因' }] });
      await provider.generate({ messages: [{ role: 'user', content: '生成自愈修复建议' }] });
      await bundle.service.saveCheckpoint({
        runId: j.runId,
        stage: 'autonomous-pipeline',
        completedCases: [],
        remainingCases: [],
        decisionState: {},
        budgetState: {},
        traceId: `trace-${j.runId}`,
      });
      await bundle.service.completeRun(j.runId);
      await bundle.telemetry.recordExecution({ runId: j.runId, projectId: j.projectId, feature, phase: 'pipeline', result: 'success' });
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('用法见文件头注释。示例：node dist/bin/platform-cli.js platform health');
    return;
  }
  const bundle = createPlatformService({
    seedProject: true,
    // 默认 SQLite 持久化（跨进程保留平台状态，Production 模式唯一允许的本地后端）。
    // 可用 STORAGE_BACKEND=json|memory|sqlite 覆盖；旧别名 PLATFORM_STORAGE 仍兼容。
    storage: resolveStorageKind(process.env.STORAGE_BACKEND ?? process.env.PLATFORM_STORAGE),
  });
  await bundle.auth.ensureSeeded();
  const wire = bundle.service.wireNotifications();
  const [group, sub] = args;

  try {
    if (group === 'project') {
      if (sub === 'list') {
        console.log(JSON.stringify(bundle.service.listProjects(), null, 2));
      } else if (sub === 'create') {
        const id = args[2];
        if (!id) throw new Error('缺少 project id');
        const name = flagValue(args, '--name') ?? id;
        const businesses = (flagValue(args, '--business') ?? '').split(',').filter(Boolean);
        const p = await bundle.service.createProject({ id, name, businesses });
        console.log(JSON.stringify(p, null, 2));
      } else throw new Error(`未知 project 子命令：${sub}`);
    } else if (group === 'run') {
      if (sub === 'create') {
        const projectId = flagValue(args, '--project') ?? 'wan3';
        const environment = flagValue(args, '--environment') ?? 'test';
        const trigger = (flagValue(args, '--trigger') ?? 'manual') as RunTrigger;
        const feature = flagValue(args, '--feature');
        const execute = !hasFlag(args, '--no-execute');
        registerCliWorker(bundle);
        const { runId, status } = await bundle.service.createRun({
          projectId, environment, trigger, feature, actor: actor(), role: role(),
        });
        console.log(JSON.stringify({ runId, status }, null, 2));
        if (execute) {
          const iters = await dispatchUntilIdle(bundle);
          const run = await bundle.service.getRun(runId);
          console.log(JSON.stringify({ runId, result: run?.status, dispatchIterations: iters }, null, 2));
        }
      } else if (sub === 'list') {
        const status = flagValue(args, '--status');
        const runs = await bundle.service.listRuns(status ? { status: status as never } : undefined);
        console.log(JSON.stringify(runs, null, 2));
      } else if (sub === 'get' || sub === 'detail') {
        const id = args[2];
        if (!id) throw new Error('缺少 run id');
        if (sub === 'get') {
          console.log(JSON.stringify(await bundle.service.getRun(id), null, 2));
        } else {
          console.log(JSON.stringify(await bundle.service.runDetail(id), null, 2));
        }
      } else if (sub === 'pause' || sub === 'resume' || sub === 'cancel' || sub === 'retry') {
        const id = args[2];
        if (!id) throw new Error('缺少 run id');
        const methodMap = {
          pause: 'pauseRun',
          resume: 'resumeRun',
          cancel: 'cancelRun',
          retry: 'retryRun',
        } as const;
        const r = await bundle.service[methodMap[sub as keyof typeof methodMap]](id, actor(), role());
        console.log(JSON.stringify(r, null, 2));
      } else throw new Error(`未知 run 子命令：${sub}`);
    } else if (group === 'worker') {
      if (sub === 'list') {
        console.log(JSON.stringify(bundle.service.listWorkers(), null, 2));
      } else throw new Error(`未知 worker 子命令：${sub}`);
    } else if (group === 'auth') {
      if (sub === 'login') {
        const username = args[2] ?? process.env.PLATFORM_USER;
        const password = args[3] ?? process.env.PLATFORM_PASSWORD;
        if (!username || !password) throw new Error('用法：auth login <username> <password>');
        const tokens = await bundle.auth.login(username, password);
        console.log(JSON.stringify(tokens, null, 2));
      } else if (sub === 'refresh') {
        const refreshToken = args[2] ?? process.env.PLATFORM_REFRESH_TOKEN;
        if (!refreshToken) throw new Error('用法：auth refresh <refreshToken>');
        console.log(JSON.stringify(await bundle.auth.refresh(refreshToken), null, 2));
      } else if (sub === 'logout') {
        const refreshToken = args[2];
        await bundle.auth.logout(refreshToken);
        console.log(JSON.stringify({ ok: true }));
      } else if (sub === 'info') {
        const token = args[2];
        if (!token) throw new Error('用法：auth info <accessToken>');
        console.log(JSON.stringify(await bundle.auth.info(token), null, 2));
      } else if (sub === 'users') {
        console.log(JSON.stringify(await bundle.users.list(), null, 2));
      } else throw new Error(`未知 auth 子命令：${sub}`);
    } else if (group === 'approval') {
      if (sub === 'list') {
        console.log(JSON.stringify(await bundle.service.listApprovals(), null, 2));
      } else throw new Error(`未知 approval 子命令：${sub}`);
    } else if (group === 'telemetry') {
      const period = (flagValue(args, '--period') ?? flagValue(args, '--window') ?? '7d') as TelemetryPeriod;
      if (sub === 'events') {
        const runId = flagValue(args, '--run');
        const events = runId
          ? await bundle.telemetry.eventsByRun(runId)
          : await bundle.telemetry.events.list({});
        console.log(JSON.stringify(events, null, 2));
      } else if (sub === 'cost') {
        console.log(JSON.stringify(await bundle.telemetry.costMetrics(period), null, 2));
      } else if (sub === 'metrics') {
        console.log(JSON.stringify(await bundle.telemetry.metricsSnapshot(period), null, 2));
      } else if (sub === 'activation') {
        console.log(JSON.stringify(await bundle.service.metricsActivation(), null, 2));
      } else throw new Error(`未知 telemetry 子命令：${sub}`);
    } else if (group === 'platform') {
      if (sub === 'health') {
        console.log(JSON.stringify(await bundle.service.health(), null, 2));
      } else if (sub === 'dashboard') {
        console.log(JSON.stringify(await bundle.service.dashboard(), null, 2));
      } else if (sub === 'metrics') {
        console.log(JSON.stringify(await bundle.service.metrics(), null, 2));
      } else throw new Error(`未知 platform 子命令：${sub}`);
    } else if (group === 'migrate') {
      // 25.8：显式执行 / 查看 schema 迁移（工厂启动已自动应用；本命令供运维手动执行与检查）
      if (sub === 'sqlite') {
        const dir = flagValue(args, '--data-dir') ?? platformDataDir();
        const db = createSqliteDatabase(sqliteDataFile(dir));
        const applied = applySqliteMigrations(db);
        db.close();
        console.log(JSON.stringify({ ok: true, dir, appliedNow: applied, detail: `SQLite 迁移完成（本次应用 ${applied.length} 项）` }, null, 2));
      } else if (sub === 'postgres') {
        const applied = await applyPostgresMigrations(createPostgresPool());
        console.log(JSON.stringify({ ok: true, appliedNow: applied, detail: `PostgreSQL 迁移完成（本次应用 ${applied.length} 项）` }, null, 2));
      } else if (sub === 'check') {
        // 尽力而为：sqlite 直接读；postgres 失败仅提示
        const dir = flagValue(args, '--data-dir') ?? platformDataDir();
        const db = createSqliteDatabase(sqliteDataFile(dir));
        const sqliteApplied = listAppliedSqlite(db);
        db.close();
        let pgApplied: string[] = [];
        let pgOk = true;
        try {
          pgApplied = await listAppliedPostgres(createPostgresPool());
        } catch {
          pgOk = false;
        }
        const all = MIGRATIONS.map((m) => m.id);
        console.log(JSON.stringify({
          total: all.length,
          sqlite: { applied: sqliteApplied, unapplied: all.filter((id) => !sqliteApplied.includes(id)) },
          postgres: pgOk
            ? { applied: pgApplied, unapplied: all.filter((id) => !pgApplied.includes(id)) }
            : { error: 'PostgreSQL 不可连接（跳过）' },
        }, null, 2));
      } else throw new Error(`未知 migrate 子命令：${sub}`);
    } else if (group === 'backup') {
      // 25.8：全量快照备份 / 恢复
      if (sub === 'save') {
        const file = args[2];
        if (!file) throw new Error('用法：backup save <file.json>');
        const snapshot = await collectSnapshot(bundle);
        fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf-8');
        console.log(JSON.stringify({ ok: true, file, total: snapshotTotal(snapshot), stores: snapshot.stores.length, exportedAt: snapshot.exportedAt }, null, 2));
      } else if (sub === 'restore') {
        const file = args[2];
        if (!file) throw new Error('用法：backup restore <file.json>');
        const snapshot = JSON.parse(fs.readFileSync(file, 'utf-8')) as Parameters<typeof restoreSnapshot>[1];
        const result = await restoreSnapshot(bundle, snapshot);
        console.log(JSON.stringify({ ok: true, file, ...result }, null, 2));
      } else if (sub === 'summary') {
        const snapshot = await collectSnapshot(bundle);
        console.log(JSON.stringify({ total: snapshotTotal(snapshot), stores: snapshot.stores }, null, 2));
      } else throw new Error(`未知 backup 子命令：${sub}`);
    } else if (group === 'preflight') {
      // 25.8：平台上线前环境自检
      const checks = await runPlatformPreflight({ checkPostgres: hasFlag(args, '--check-postgres') });
      const summary = preflightSummary(checks);
      if (hasFlag(args, '--json')) {
        console.log(JSON.stringify({ ok: summary.ok, checks, summary }, null, 2));
      } else {
        console.log('════════ PANQU Platform Preflight ════════');
        for (const c of checks) {
          const icon = c.level === 'PASS' ? 'PASS' : c.level === 'WARN' ? 'WARN' : 'BLOCK';
          console.log(`  [${icon}] ${c.name}：${c.detail}`);
        }
        console.log(`结果：PASS ${summary.pass} / WARN ${summary.warn} / BLOCK ${summary.block}`);
        console.log('══════════════════════════════════════');
      }
      if (!summary.ok) process.exitCode = 1;
    } else if (group === 'smoke') {
      // 25.8：真实运营闭环冒烟（独立 SQLite 数据目录，不污染生产数据）
      const result = await runPlatformSmoke();
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } else if (group === 'serve') {
      // 25.6：启动 Platform API + Web Dashboard（长驻进程）
      const port = Number(flagValue(args, '--port') ?? process.env.PLATFORM_PORT ?? 8787);
      const host = flagValue(args, '--host') ?? '127.0.0.1';
      const webDir = flagValue(args, '--web') ?? path.join(process.cwd(), 'web', 'dist');
      const hasWeb = fs.existsSync(path.join(webDir, 'index.html'));
      registerCliWorker(bundle);
      const server = createPlatformServer({
        service: bundle.service,
        auth: bundle.auth,
        mode: (process.env.PLATFORM_MODE as never) ?? 'development',
        port,
        host,
        now: () => new Date().toISOString(),
        webDir,
      });
      const { url } = await server.listen();
      console.log('════════ PANQU Platform ════════');
      console.log(`API + Web Dashboard：${url}`);
      console.log(`Web 构建：${hasWeb ? '已构建（npm run build:web）' : '未构建（运行 npm run build:web 后重试）'}`);
      console.log(`默认账号：admin / admin123（seed 用户）`);
      console.log(`自动派发：新建 Run 由 CLI Worker 真实执行（产生真实遥测）`);
      console.log('Ctrl+C 退出');
      console.log('════════════════════════════════');
      // 自动派发循环：Dashboard 新建的 Run → 调度 → Worker 真实执行（LLM 遥测 → 成本 → 指标激活）
      const dispatchTimer = setInterval(() => {
        void (async () => {
          try {
            await bundle.pool.dispatch();
            await bundle.pool.drain();
          } catch (e) {
            console.warn(`[serve] 派发异常：${(e as Error).message}`);
          }
        })();
      }, 1000);
      await new Promise<void>((resolve) => {
        const shutdown = async (): Promise<void> => {
          clearInterval(dispatchTimer);
          await server.close();
          wire();
          resolve();
        };
        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
      });
      return;
    } else {
      throw new Error(`未知命令组：${group}`);
    }
  } finally {
    wire();
    void bundle;
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e: Error) => {
    console.error('Platform CLI 执行出错：', e.message);
    process.exit(1);
  });
}
