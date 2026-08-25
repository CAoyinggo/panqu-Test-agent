// Phase 26.4 Failure / Recovery Drill — E2E
// 受控故障实验：S1 Worker 崩溃、S2 LLM 异常、S3 Storage/DB 短暂异常
// 验证：恢复后 Run/TestCase 不丢失（Lost=0）、Health=DEGRADED、Scheduler=PAUSED、
//       Fallback 链路（主→备→确定性回退）、P0 故障注入产生真实 BLOCK（26.5 Gate 前置）。
// 证据：offline-drill（隔离临时目录演练）；staging-real 由 CLI 对 staging 数据目录执行。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createBreaker } from '../../src/platform/storage/faulty-repository.js';
import { makeRealRunExecutor } from '../../src/platform/ops/real-run.js';
import {
  drillWorkerCrash,
  drillLlmChain,
  drillLlmRunRecovery,
  drillStorageOutage,
  recoverySummary,
  makeFlakyProvider,
} from '../../src/platform/ops/recovery-drill.js';
import { FallbackLLMProvider } from '../../src/llm/fallback-provider.js';
import { MockLLMProvider } from '../../src/llm/mock-llm.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

async function importAssets(b: PlatformBundle): Promise<void> {
  await b.testAssets.importCatalog();
}

describe('26.4.1 S1 Worker 崩溃恢复', () => {
  it('RUNNING → Kill → 心跳超时/回收 → Retry → Worker 2 → COMPLETED；Lost Run=0、Lost TestCase=0', async () => {
    const b = makeBundle();
    await importAssets(b);
    const m = await drillWorkerCrash(b, { environment: 'test', tag: 's1' });
    const d = m.detail as { finalStatus: string; recoveredOrphans: number; requeued: number; runId: string };
    expect(m.ok).toBe(true);
    expect(d.finalStatus).toBe('COMPLETED');
    expect(d.recoveredOrphans).toBe(1);
    expect(d.requeued).toBe(1);
    expect(m.retryCount).toBeGreaterThanOrEqual(1);
    expect(m.lostRuns).toBe(0);
    expect(m.lostCases).toBe(0);
    expect(m.recoverySuccessRate).toBe(100);
    // 调度器语义：原 Job 先 RETRY 再 QUEUED，未丢
    const run = await b.service.getRun(d.runId);
    expect(run?.status).toBe('COMPLETED');
  });

  it('Scheduler 全局暂停语义：PAUSED 期间 next() 不领取，Job 保留不丢失', async () => {
    const b = makeBundle();
    b.scheduler.pauseDispatch();
    expect(b.scheduler.isDispatchPaused()).toBe(true);
    // 暂停后入队：Job 保留（QUEUED），next() 返回 null（不领取）
    const { runId } = await b.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA', feature: 'drill-paused',
    });
    const job = (await b.scheduler.list({ runId }))[0];
    expect(job?.status).toBe('QUEUED');
    expect(await b.scheduler.next()).toBeNull();
    // 恢复后可领取
    b.scheduler.resumeDispatch();
    const claimed = await b.scheduler.next();
    expect(claimed?.jobId).toBe(job?.jobId);
  });
});

describe('26.4.2 S2 LLM 异常恢复', () => {
  it('Fallback 链路：Timeout/429/500 → 备模型；主备皆失败 → 确定性回退；401 不可重试不触发回退', async () => {
    const m = await drillLlmChain({});
    expect(m.ok).toBe(true);
    expect(m.results.every((r) => r.ok)).toBe(true);
    // 三种可重试故障均恢复
    expect(m.results.filter((r) => r.recoveredTo === 'mock').length).toBe(3);
    expect(m.results.some((r) => r.mode === 'both-fail' && r.recoveredTo === 'deterministic-fallback')).toBe(true);
    expect(m.results.some((r) => r.mode === '401' && r.recoveredTo === 'error' && !r.retryable)).toBe(true);
    expect(m.recoverySuccessRate).toBeGreaterThan(0);
  });

  it('Run 级恢复：LLM Provider 连续失败（500）→ Pipeline 确定性回退 → COMPLETED；无重复 Job 执行', async () => {
    const b = makeBundle();
    await importAssets(b);
    const m = await drillLlmRunRecovery(b, { environment: 'test', tag: 's2', profile: 'smoke', failMode: '500', failCount: 2 });
    const d = m.detail as { firstStatus: string; finalStatus: string; llmFailures: number };
    expect(m.ok).toBe(true);
    expect(d.firstStatus).toBe('SUCCESS');
    expect(m.retryCount).toBe(0);
    expect(d.finalStatus).toBe('COMPLETED');
    expect(d.llmFailures).toBeGreaterThanOrEqual(2);
    expect(m.lostRuns).toBe(0);
    expect(m.lostCases).toBe(0);
  });

  it('429 与 Timeout 故障同样经 Pipeline 确定性回退恢复（多次采样）', async () => {
    const b = makeBundle();
    await importAssets(b);
    const m429 = await drillLlmRunRecovery(b, { environment: 'test', tag: 's2a', profile: 'smoke', failMode: '429', failCount: 1 });
    const d429 = m429.detail as { finalStatus: string };
    expect(m429.ok).toBe(true);
    expect(d429.finalStatus).toBe('COMPLETED');
    const b2 = makeBundle();
    await importAssets(b2);
    const mT = await drillLlmRunRecovery(b2, { environment: 'test', tag: 's2b', profile: 'smoke', failMode: 'timeout', failCount: 1 });
    const dT = mT.detail as { finalStatus: string };
    expect(mT.ok).toBe(true);
    expect(dT.finalStatus).toBe('COMPLETED');
  });
});

describe('26.4.3 S3 Storage/DB 短暂异常', () => {
  it('Health=DEGRADED、Scheduler=PAUSED、Run 不丢失、恢复后继续（数据未清空）', async () => {
    const breakers = createBreaker();
    const b = createPlatformService({
      seedProject: true,
      now: () => FIXED_ISO,
      wrapRepository: (name, repo) => breakers.wrap(name, repo),
    });
    await importAssets(b);
    const m = await drillStorageOutage(b, { environment: 'test', tag: 's3', breaker: breakers });
    const d = m.detail as {
      healthDuring: string; healthAfter: string; schedulerPaused: boolean;
      runsDuring: number; finalRuns: number; afterStatus: string;
    };
    expect(m.ok).toBe(true);
    expect(d.healthDuring).toBe('DEGRADED');
    expect(d.healthAfter).toBe('HEALTHY');
    expect(d.schedulerPaused).toBe(true);
    expect(d.runsDuring).toBeGreaterThanOrEqual(1);
    expect(d.finalRuns).toBe(d.runsDuring + 1); // 新增 1 条，历史未丢未清空
    expect(d.afterStatus).toBe('COMPLETED');
    expect(m.lostRuns).toBe(0);
    expect(m.lostCases).toBe(0);
    expect(m.recoverySuccessRate).toBe(100);
  });
});

describe('26.4.4 故障注入 → 真实 BLOCK（26.5 Release Gate 前置）', () => {
  it('注入 P0 FAIL → 真实 FAILED outcome 合法完成、release 记录 BLOCK、不能绕过 Gate', async () => {
    const b = makeBundle();
    await importAssets(b);
    const { runId } = await b.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA', feature: 'drill-p0-block',
    });
    const exec = makeRealRunExecutor(b, 'sanity', {
      environment: 'test',
      now: () => FIXED_ISO,
      failCases: ['WAN3-CORE-001'], // 注入 P0 回归缺陷
      failReason: '故障注入（drill）：P0 核心链路回归',
    });
    const summary = await exec({ runId, projectId: 'wan3', environment: 'test', feature: 'drill-p0-block' });
    expect(summary.decision).toBe('BLOCK');
    expect(summary.exitCode).toBe(1);
    expect(summary.p0Fail).toBeGreaterThan(0);
    expect(summary.fail).toBeGreaterThan(0);
    expect((await b.service.getRun(runId))?.status).toBe('COMPLETED');
    expect((await b.service.getRun(runId))?.executionRecord?.outcome.executionStatus).toBe('FAILED');
    // Release 事件真实记录 BLOCK（Gate 依据，Autonomous 无法绕过）
    const releaseEvents = (await b.telemetry.eventsByRun(runId)).filter((e) => e.type === 'release');
    expect(releaseEvents.length).toBe(1);
    expect(releaseEvents[0].metadata?.decision).toBe('BLOCK');
    // 审计：release 决策（BLOCK=denied）已落库
    const audit = await b.audit.search({ runId });
    const releaseAudit = audit.find((e) => e.action === 'release');
    expect(releaseAudit).toBeDefined();
    expect(releaseAudit?.result).toBe('denied');
    expect((releaseAudit?.detail as { decision?: string })?.decision).toBe('BLOCK');
  });
});

describe('26.4.5 恢复指标聚合', () => {
  it('recoverySummary 汇总 MTTD/MTTR/Retry/Lost，且 Lost Run=0、Lost TestCase=0', async () => {
    const b = makeBundle();
    await importAssets(b);
    const m1 = await drillWorkerCrash(b, { environment: 'test', tag: 'sum1' });
    const b2 = makeBundle();
    await importAssets(b2);
    const m2 = await drillLlmRunRecovery(b2, { environment: 'test', tag: 'sum2', profile: 'smoke', failMode: '500', failCount: 1 });
    const summary = recoverySummary([m1, m2]);
    expect(summary.ok).toBe(true);
    expect(summary.totalDrills).toBe(2);
    expect(summary.successful).toBe(2);
    expect(summary.lostRuns).toBe(0);
    expect(summary.lostCases).toBe(0);
    expect(summary.retryCount).toBeGreaterThanOrEqual(1);
    expect(summary.avgMttdMs).toBeGreaterThanOrEqual(0);
    expect(summary.avgMttrMs).toBeGreaterThanOrEqual(0);
  });
});
