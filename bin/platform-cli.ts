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
import { createPlatformService } from '../src/platform/index.js';
import type { PlatformBundle } from '../src/platform/index.js';
import type { RunTrigger, Role } from '../src/platform/index.js';

function actor(): string {
  return process.env.PLATFORM_ACTOR ?? 'cli';
}
function role(): Role {
  return (process.env.PLATFORM_ROLE as Role) ?? 'ADMIN';
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

/** 注册演示 Worker：模拟自治流水线（start → checkpoint → complete） */
function registerCliWorker(bundle: PlatformBundle): void {
  bundle.registerWorkerExecutor('cli-worker', async (job: unknown) => {
    const payload = job as { runId: string };
    await bundle.service.startRun(payload.runId);
    await bundle.service.saveCheckpoint({
      runId: payload.runId,
      stage: 'autonomous-pipeline',
      completedCases: [],
      remainingCases: [],
      decisionState: {},
      budgetState: {},
      traceId: `trace-${payload.runId}`,
    });
    await bundle.service.completeRun(payload.runId);
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
    // 默认 JSON 持久化（跨进程保留平台状态）；可用 PLATFORM_STORAGE=memory 关闭
    storage: process.env.PLATFORM_STORAGE === 'memory' ? 'memory' : 'json',
  });
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
    } else if (group === 'approval') {
      if (sub === 'list') {
        console.log(JSON.stringify(await bundle.service.listApprovals(), null, 2));
      } else throw new Error(`未知 approval 子命令：${sub}`);
    } else if (group === 'platform') {
      if (sub === 'health') {
        console.log(JSON.stringify(await bundle.service.health(), null, 2));
      } else if (sub === 'dashboard') {
        console.log(JSON.stringify(await bundle.service.dashboard(), null, 2));
      } else if (sub === 'metrics') {
        console.log(JSON.stringify(await bundle.service.metrics(), null, 2));
      } else throw new Error(`未知 platform 子命令：${sub}`);
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
