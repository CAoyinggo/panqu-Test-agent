// 平台冒烟测试（Phase 25.8）：真实运营闭环快速验证
// 流程：创建临时 SQLite 平台 → 注册真实 Worker（Mock LLM + 遥测装饰器）
//       → 创建 Run → 派发执行至 COMPLETED → 断言产生真实 TelemetryEvent / CostLedger。
// 供 CLI `smoke` 命令与集成测试共用；可独立运行（node dist/src/platform/ops/smoke.js）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformService, type PlatformBundle } from '../service/factory.js';
import { withLLMTelemetry } from '../telemetry/index.js';
import { MockLLMProvider } from '../../llm/mock-llm.js';
import { redactSensitive, redactSensitiveText } from '../../core/redact.js';
import { makeRealRunExecutor } from './real-run.js';

export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeResult {
  ok: boolean;
  runId: string;
  runStatus: string;
  telemetryEvents: number;
  costEntries: number;
  totalCostYuan: number | null;
  checks: SmokeCheck[];
  dataDir: string;
  message?: string;
}

/** 派发直至队列排空（与 CLI 共用语义） */
async function dispatchUntilIdle(bundle: PlatformBundle, maxIters = 200): Promise<void> {
  let iters = 0;
  while (iters < maxIters) {
    const assigned = await bundle.pool.dispatch();
    await bundle.pool.drain();
    const pending = await bundle.scheduler.pendingCount();
    if (assigned === 0 && pending === 0) return;
    iters += 1;
  }
  throw new Error('派发未在迭代上限内排空队列');
}

/** 运行平台冒烟（独立数据目录；默认系统临时目录） */
export async function runPlatformSmoke(opts: { dataDir?: string } = {}): Promise<SmokeResult> {
  const checks: SmokeCheck[] = [];
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'panqu-smoke-'));
  const ok = (name: string, detail: string, pass: boolean): void => {
    checks.push({ name, ok: pass, detail });
  };
  let bundle: PlatformBundle | undefined;
  let runId = '';
  let runStatus = '';
  try {
    bundle = createPlatformService({ seedProject: true, seedUsers: true, dataDir, storage: 'sqlite' });
    await bundle.auth.ensureSeeded();
    ok('平台装配', `SQLite 数据目录：${dataDir}`, true);

    // 注册真实 Worker：Mock LLM 经遥测装饰器 → 真实 token 用量 → CostLedger / TelemetryEvent
    const provider = withLLMTelemetry(new MockLLMProvider(), bundle.telemetry);
    await bundle.testAssets.importCatalog();
    bundle.registerWorkerExecutor('smoke-worker', makeRealRunExecutor(bundle, 'smoke', { provider }));
    ok('Worker 注册', 'smoke-worker（general / test,staging,dev）', true);

    // 确保项目存在（幂等）
    if (!bundle.projects.getProject('wan3')) {
      bundle.projects.createProject({ id: 'wan3', name: '冒烟项目', businesses: ['smoke'] });
    }

    const { runId: rid } = await bundle.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', feature: 'smoke-probe', actor: 'smoke', role: 'ADMIN',
    });
    runId = rid;
    ok('Run 创建', `runId=${rid}`, true);

    await dispatchUntilIdle(bundle);
    const run = await bundle.service.getRun(runId);
    runStatus = run?.status ?? 'UNKNOWN';
    ok('Run 完成', `status=${runStatus}`, runStatus === 'COMPLETED');

    // 真实遥测断言：事件 / 成本账本 / 指标激活
    const events = await bundle.telemetry.eventsByRun(runId);
    const cost = await bundle.telemetry.costMetrics('7d');
    const activation = await bundle.telemetry.activationStatus();
    const costTracked = cost.total.tracked && (cost.total.value ?? 0) > 0;
    ok('遥测事件', `${events.length} 条（含 llm/execution）`, events.length > 0);
    ok('成本账本', `共 ${cost.total.sampleCount} 条，合计 ¥${cost.total.value ?? 0}`, costTracked);
    ok('指标激活', `已激活：${activation.activeCount}`, activation.activeCount >= 2);

    return { ok: checks.every((c) => c.ok), runId, runStatus, telemetryEvents: events.length, costEntries: cost.total.sampleCount, totalCostYuan: cost.total.value, checks, dataDir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ok('冒烟执行', `异常：${message}`, false);
    return { ok: false, runId, runStatus, telemetryEvents: 0, costEntries: 0, totalCostYuan: null, checks, dataDir, message };
  } finally {
    // 清理临时数据目录（冒烟不留脏数据）
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* 清理失败忽略 */
    }
  }
}

// 独立执行入口（tsx 或编译后 node 直接运行）
const isMain = !!process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1] ?? ''));
if (isMain) {
  runPlatformSmoke()
    .then((r) => {
      console.log(JSON.stringify(redactSensitive(r), null, 2));
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e: Error) => {
      console.error('冒烟失败：', redactSensitiveText(e.message));
      process.exit(1);
    });
}
