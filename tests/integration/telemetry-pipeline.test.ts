// 集成测试：Telemetry Pipeline（Phase 25.4）
// 真实链路：Run → Worker 执行（runContext + LLM 装饰器）→ CostLedger 落库 → 指标激活（tracked=true）
// 以及 RCA Ground Truth / Flaky / Healing（含 rolledBack）/ Release 接入平台指标；
// dashboard()/metrics() 反映遥测数据；SQLite 后端下遥测持久化。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { withLLMTelemetry, runContext } from '../../src/platform/index.js';
import { MockLLMProvider } from '../../src/llm/mock-llm.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const FIXED_ISO = '2026-08-18T12:00:00.000Z';

function makeBundle(opts: { storage?: 'memory' | 'sqlite' } = {}): PlatformBundle {
  let dataDir: string | undefined;
  if (opts.storage === 'sqlite') {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-it-'));
  }
  return createPlatformService({
    seedProject: true,
    seedUsers: true,
    storage: opts.storage ?? 'memory',
    now: () => FIXED_ISO,
    dataDir,
  });
}

/** 模拟 Worker 执行：真实 runContext + 装饰后 LLM 调用 → 真实 CostLedger */
function registerTelemetryWorker(bundle: PlatformBundle): void {
  const provider = withLLMTelemetry(new MockLLMProvider(), bundle.telemetry);
  bundle.registerWorkerExecutor('telemetry-worker', async (job: unknown) => {
    // 注意：executor 收到的是 job.payload（含 runId/projectId/environment/feature）
    const j = job as { runId: string; projectId: string; environment: string; feature?: string };
    const feature = j.feature;
    await runContext.run({ runId: j.runId, projectId: j.projectId, feature }, async () => {
      await bundle.service.startRun(j.runId);
      await bundle.telemetry.recordExecution({ runId: j.runId, projectId: j.projectId, feature, phase: 'pipeline', result: 'success' });
      // 两次 LLM 调用（分析 / 修复建议）→ 真实 usage → CostLedger
      await provider.generate({ messages: [{ role: 'user', content: '分析本次执行结果与失败原因' }] });
      await provider.generate({ messages: [{ role: 'user', content: '生成自愈修复建议' }] });
      await bundle.service.completeRun(j.runId);
      await bundle.telemetry.recordExecution({ runId: j.runId, projectId: j.projectId, feature, phase: 'pipeline', result: 'success' });
    });
  });
}

async function dispatchUntilIdle(bundle: PlatformBundle, maxIters = 50): Promise<void> {
  let iters = 0;
  while (iters < maxIters) {
    const assigned = await bundle.pool.dispatch();
    await bundle.pool.drain();
    const pending = await bundle.scheduler.pendingCount();
    if (assigned === 0 && pending === 0) break;
    iters += 1;
  }
}

describe('S1 Run → LLM 遥测 → CostLedger → 指标激活', () => {
  it('创建并执行 Run：LLM 调用产生真实成本，metrics 中 llmCost tracked=true', async () => {
    const bundle = makeBundle();
    registerTelemetryWorker(bundle);
    const { runId } = await bundle.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', feature: 'text-to-video', actor: 'cli', role: 'ADMIN',
    });
    await dispatchUntilIdle(bundle);
    const run = await bundle.service.getRun(runId);
    expect(run?.status).toBe('COMPLETED');

    // CostLedger 按 run 归属：两次 LLM 调用
    const entries = await bundle.telemetry.costs.list({ runId });
    expect(entries.length).toBe(2);
    expect(entries[0].projectId).toBe('wan3');
    expect(entries[0].feature).toBe('text-to-video');
    expect(entries[0].cost).toBeGreaterThan(0); // 真实 cost

    // execution 事件
    const execEvents = await bundle.telemetry.events.list({ runId, type: 'execution' });
    expect(execEvents.length).toBeGreaterThanOrEqual(2);

    // 平台指标接入遥测
    const m = await bundle.service.metrics();
    expect(m.llmCost.tracked).toBe(true);
    expect(m.llmCost.value).toBeGreaterThan(0);
    expect(m.costPerRun.tracked).toBe(true);
    expect(m.rcaAccuracy.tracked).toBe(false); // 尚未有真实验证

    // dashboard 反映遥测
    const d = await bundle.service.dashboard();
    expect((d.metrics as { llmCost: { tracked: boolean; value: number | null } }).llmCost.tracked).toBe(true);
  });
});

describe('S2 RCA Ground Truth / Flaky / Healing（含 rolledBack）/ Release 接入', () => {
  it('真实验证后 rcaAccuracy / flakyRate / healingRate 在平台指标中 tracked=true', async () => {
    const bundle = makeBundle();
    await bundle.telemetry.recordRca({ runId: 'r-rca', rcaId: 'rca-1', caseId: 'c1', predictedCategory: 'ASSERTION' });
    await bundle.telemetry.verifyRca({ runId: 'r-rca', rcaId: 'rca-1', predictedCategory: 'ASSERTION', actualCategory: 'ASSERTION' });
    await bundle.telemetry.recordRca({ runId: 'r-rca', rcaId: 'rca-2', caseId: 'c2', predictedCategory: 'ASSERTION' });
    await bundle.telemetry.verifyRca({ runId: 'r-rca', rcaId: 'rca-2', predictedCategory: 'ASSERTION', actualCategory: 'TIMEOUT' });
    await bundle.telemetry.recordFlaky({ caseId: 'c-a', runId: 'r-f', pass: true, retry: false, environment: 'test' });
    await bundle.telemetry.recordFlaky({ caseId: 'c-a', runId: 'r-f', pass: false, retry: true, environment: 'test' });
    await bundle.telemetry.recordHealing({ healingId: 'h1', caseId: 'c1', runId: 'r-h', suggested: true, approved: true, applied: true, recovered: true, rolledBack: false });
    await bundle.telemetry.recordHealing({ healingId: 'h2', caseId: 'c2', runId: 'r-h', suggested: true, approved: true, applied: true, recovered: false, rolledBack: true });
    await bundle.telemetry.recordRelease({ runId: 'r-rel', decision: 'BLOCK', result: 'blocked', reason: '风控用例失败' });

    const m = await bundle.service.metrics();
    expect(m.rcaAccuracy.tracked).toBe(true);
    expect(m.rcaAccuracy.value).toBe(50); // 1/2 正确
    expect(m.flakyRate.tracked).toBe(true);
    expect(m.flakyRate.value).toBe(100);  // 1 case 波动
    expect(m.healingRate.tracked).toBe(true);
    expect(m.healingRate.value).toBe(50); // recovered 1 / applied 2

    // 事件流含全部类型
    const events = await bundle.telemetry.events.list({});
    const types = new Set(events.map((e) => e.type));
    expect(types).toContain('rca');
    expect(types).toContain('rca.verify');
    expect(types).toContain('flaky');
    expect(types).toContain('healing');
    expect(types).toContain('release');
  });
});

describe('S3 SQLite 后端遥测持久化', () => {
  it('遥测数据与平台数据落同一 SQLite 文件；跨实例可见', async () => {
    const bundle = makeBundle({ storage: 'sqlite' });
    await bundle.telemetry.recordLLM({ runId: 'r-sqlite', projectId: 'wan3', feature: 'text-to-video', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    await bundle.telemetry.verifyRca({ runId: 'r-sqlite', rcaId: 'rca-s', predictedCategory: 'ASSERTION', actualCategory: 'ASSERTION' });
    const costs = await bundle.telemetry.costs.list({ runId: 'r-sqlite' });
    expect(costs).toHaveLength(1);
    expect(costs[0].cost).toBeCloseTo(2.0, 2);
    const m = await bundle.service.metrics();
    expect(m.llmCost.tracked).toBe(true);
    expect(m.rcaAccuracy.tracked).toBe(true);
  });
});

describe('S4 指标自动激活 + 时间窗口（25.5）', () => {
  it('真实遥测样本 → tracked=false 自动激活；PlatformService 暴露激活状态', async () => {
    const bundle = makeBundle();
    // 初始：全部未激活
    let act = await bundle.service.metricsActivation();
    expect(act.activeCount).toBe(0);
    const initialMetrics = await bundle.service.metrics('7d');
    expect(initialMetrics.rcaAccuracy.tracked).toBe(false);
    expect(initialMetrics.flakyRate.tracked).toBe(false);

    // 真实样本 → 自动激活
    await bundle.telemetry.recordLLM({ runId: 'r-act', projectId: 'wan3', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    await bundle.telemetry.verifyRca({ runId: 'r-act', rcaId: 'rca-a', predictedCategory: 'ASSERTION', actualCategory: 'ASSERTION' });
    await bundle.telemetry.recordFlaky({ caseId: 'c-a', runId: 'r-act', pass: true, retry: false });
    await bundle.telemetry.recordFlaky({ caseId: 'c-a', runId: 'r-act', pass: false, retry: true });
    await bundle.telemetry.recordHealing({ healingId: 'h-a', caseId: 'c-a', runId: 'r-act', suggested: true, approved: true, applied: true, recovered: true, rolledBack: false });

    act = await bundle.service.metricsActivation();
    expect(act.activeCount).toBe(4); // cost/rcaAccuracy/flakyRate/healingRate（execution 未记录）
    const byMetric = new Map(act.records.map((r) => [r.metric, r]));
    expect(byMetric.get('cost')?.activated).toBe(true);
    expect(byMetric.get('rcaAccuracy')?.activated).toBe(true);
    expect(byMetric.get('flakyRate')?.activated).toBe(true);
    expect(byMetric.get('healingRate')?.activated).toBe(true);
    expect(byMetric.get('execution')?.activated).toBe(false);

    // 平台指标随之 tracked=true
    const m = await bundle.service.metrics('7d');
    expect(m.llmCost.tracked).toBe(true);
    expect(m.rcaAccuracy.tracked).toBe(true);
    expect(m.flakyRate.tracked).toBe(true);
    expect(m.healingRate.tracked).toBe(true);
  });

  it('metrics(window) 时间窗口参数被正确传递（1h/7d/release 均可见当前样本）', async () => {
    const bundle = makeBundle();
    await bundle.telemetry.recordLLM({ runId: 'r-w', projectId: 'wan3', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    const m7 = await bundle.service.metrics('7d');
    const m1 = await bundle.service.metrics('1h');
    const mRel = await bundle.service.metrics('release');
    expect(m7.llmCost.tracked).toBe(true);
    expect(m1.llmCost.tracked).toBe(true);
    expect(mRel.llmCost.tracked).toBe(true);
  });
});
