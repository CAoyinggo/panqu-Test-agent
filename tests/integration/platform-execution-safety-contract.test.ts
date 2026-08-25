import { describe, expect, it } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import { createPlatformAgentWorkerExecutor } from '../../src/integrations/platform-agent-worker.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import { computeOutcome } from '../../src/agents/execution/execution-schema.js';
import type { DataFactory } from '../../src/core/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Platform Worker execution safety contract', () => {
  it('[P0-Platform] VERIFIED_AGENT Run cannot complete without the execution record', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const { runId } = await bundle.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA',
    });
    await bundle.service.startRun(runId);
    await expect(bundle.service.completeRun(runId)).rejects.toThrow(/不满足 Completion Contract/);
    expect((await bundle.service.getRun(runId))?.status).toBe('PLANNING');
  });

  it('[P0-Platform] Scheduler Worker enters Agent Pipeline and persists Requirement/Gate/Evidence/Outcome before COMPLETED', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const dataFactory: DataFactory = {
      async setup() { return {}; },
      async teardown() { /* test fixture has no external resource */ },
      async generate() {
        return { account: { id: 'platform-agent', nickname: 'qa', project_id: 1 } };
      },
    };
    const runner = async (cases: Parameters<import('../../src/agents/execution/execution-run-tool.js').ExecutionRunner>[0]) => {
      const results = cases.map((item) => ({
        caseId: String(item.def.extra?.agentTestCaseId ?? item.name),
        name: item.name,
        feature: item.feature,
        scene: item.def.scene,
        processor: 'contract-video-processor',
        processorInvoked: true,
        requestId: `request-${String(item.def.extra?.agentTestCaseId ?? item.name)}`,
        timestamp: '2026-08-23T00:00:00.000Z',
        executed: true,
        status: 'PASS' as const,
        pass: true,
        passRate: 100,
        checks: [{ name: '真实业务响应符合预期', pass: true, detail: 'processor response verified', kind: 'BUSINESS' as const }],
      }));
      return computeOutcome('wan3', results, { executed: true });
    };
    bundle.registerWorkerExecutor('agent-pipeline-worker', createPlatformAgentWorkerExecutor(bundle, {
      runner,
      dataFactoryResolver: () => dataFactory,
      pipelineOptions: {
        executionApproval: { id: 'platform-contract-approval', status: 'APPROVED', approvedBy: 'qa-reviewer' },
      },
    }));

    const { runId } = await bundle.service.createRun({
      projectId: 'wan3',
      environment: 'test',
      trigger: 'manual',
      feature: 'wan3',
      requirementText: '测试 WAN3 文生视频功能，验证任务提交成功',
      actor: 'qa',
      role: 'QA',
    });
    await bundle.pool.dispatch();
    await bundle.pool.drain();

    const run = await bundle.service.getRun(runId);
    expect(run?.status).toBe('COMPLETED');
    expect(run?.executionRecord?.result).toBe('PASS');
    expect(run?.executionRecord?.requirementEvidence.value).toMatchObject({ feature: 'wan3' });
    expect(run?.executionRecord?.policyGate).toMatchObject({ status: 'ALLOW', value: { allowed: true } });
    expect(run?.executionRecord?.evidence.length).toBeGreaterThan(0);
    expect(run?.executionRecord?.evidence.every((item) => (
      item.processorInvoked && item.effectiveAssertions > 0 && item.executionStatus === 'PASS'
    ))).toBe(true);
    expect(run?.executionRecord?.outcome).toMatchObject({ executionStatus: 'PASSED', executedCount: expect.any(Number) });
    expect(run?.executionRecord?.completionGuardPassed).toBe(true);
    expect((await bundle.service.getRunReport(runId)).checkpoint).toMatchObject({ stage: 'agent-pipeline' });
  });

  it('[P1-Platform-HTTP] POST /runs auto-dispatches into the verified Agent Pipeline executor', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const dataFactory: DataFactory = {
      async setup() { return {}; },
      async teardown() { /* no external resource */ },
      async generate() { return { account: { id: 'http-agent', nickname: 'qa', project_id: 1 } }; },
    };
    bundle.registerWorkerExecutor('http-agent-worker', createPlatformAgentWorkerExecutor(bundle, {
      dataFactoryResolver: () => dataFactory,
      pipelineOptions: {
        executionApproval: { id: 'http-contract-approval', status: 'APPROVED', approvedBy: 'qa-reviewer' },
      },
      runner: async (cases) => computeOutcome('wan3', cases.map((item) => ({
        caseId: String(item.def.extra?.agentTestCaseId ?? item.name),
        name: item.name,
        feature: item.feature,
        scene: item.def.scene,
        processor: 'http-video-processor',
        processorInvoked: true,
        requestId: `http-${String(item.def.extra?.agentTestCaseId ?? item.name)}`,
        timestamp: '2026-08-23T00:00:00.000Z',
        executed: true,
        status: 'PASS' as const,
        pass: true,
        passRate: 100,
        checks: [{ name: 'HTTP 主链业务断言', pass: true, detail: 'verified', kind: 'BUSINESS' as const }],
      })), { executed: true }),
    }));
    const server = createPlatformServer({ service: bundle.service, token: 'http-contract-token' });
    const { url } = await server.listen();
    try {
      const response = await fetch(`${url}/runs`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer http-contract-token',
          'Content-Type': 'application/json',
          'X-Actor': 'qa',
          'X-Role': 'QA',
        },
        body: JSON.stringify({
          projectId: 'wan3',
          environment: 'test',
          trigger: 'manual',
          feature: 'wan3',
          requirementText: '测试 WAN3 文生视频功能，验证任务提交成功',
        }),
      });
      expect(response.status).toBe(200);
      const created = await response.json() as { runId: string };
      await bundle.pool.drain();
      const run = await bundle.service.getRun(created.runId);
      expect(run?.status).toBe('COMPLETED');
      expect(run?.executionRecord).toMatchObject({
        result: 'PASS',
        requirementEvidence: { value: { feature: 'wan3' } },
        policyGate: { status: 'ALLOW', value: { allowed: true } },
        completionGuardPassed: true,
      });
      expect(run?.executionRecord?.evidence.every((item) => (
        item.processor === 'http-video-processor'
        && item.processorInvoked
        && Boolean(item.requestId)
        && item.effectiveAssertions > 0
      ))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('[P0-07] production release without approval is blocked before the Platform Worker executor', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const sideEffects = { dataPrepare: 0, tool: 0, httpSubmit: 0 };
    bundle.workers.register({
      workerId: 'production-side-effect-probe',
      capabilities: ['general', 'secure'],
      environments: ['production'],
      maxConcurrency: 1,
    }, async () => {
      sideEffects.dataPrepare += 1;
      sideEffects.tool += 1;
      sideEffects.httpSubmit += 1;
    });

    const { runId } = await bundle.service.createRun({
      projectId: 'wan3',
      environment: 'production',
      trigger: 'release',
      actor: 'qa-without-production-approval',
      role: 'QA',
    });
    await bundle.pool.dispatch();
    await bundle.pool.drain();

    expect(sideEffects).toEqual({ dataPrepare: 0, tool: 0, httpSubmit: 0 });
    expect((await bundle.scheduler.list({ runId }))[0].status).not.toBe('SUCCESS');
  });

  it('[P0-11] cancelling a RUNNING Job aborts the Executor and prevents later writes/completion', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const started = deferred();
    const continueExecution = deferred();
    let writes = 0;

    bundle.registerWorkerExecutor('cancel-probe', async (_job, signal) => {
      started.resolve();
      await continueExecution.promise;
      if (signal?.aborted) return;
      writes += 1;
    });
    const { runId } = await bundle.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA',
    });
    await bundle.pool.dispatch();
    await started.promise;
    const [job] = await bundle.scheduler.list({ runId });

    await bundle.scheduler.cancel(job.jobId);
    continueExecution.resolve();
    await bundle.pool.drain();

    expect(writes).toBe(0);
    expect((await bundle.scheduler.get(job.jobId))?.status).toBe('CANCELLED');
  });

  it('[P0-11] timeout sweep aborts the Executor and prevents later writes/completion', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const started = deferred();
    const continueExecution = deferred();
    let writes = 0;

    bundle.registerWorkerExecutor('timeout-probe', async (_job, signal) => {
      started.resolve();
      await continueExecution.promise;
      if (signal?.aborted) return;
      writes += 1;
    });
    const { job } = await bundle.scheduler.enqueue({
      runId: 'timeout-run',
      projectId: 'wan3',
      environment: 'test',
      payload: { runId: 'timeout-run' },
      timeoutMs: 10,
      maxRetries: 0,
    });
    await bundle.pool.dispatch();
    await started.promise;

    await bundle.scheduler.sweepTimeouts(Date.parse(job.createdAt) + 20);
    continueExecution.resolve();
    await bundle.pool.drain();

    expect(writes).toBe(0);
    expect((await bundle.scheduler.get(job.jobId))?.status).toBe('FAILED');
  });

  it('[P0-13] Worker retry does not duplicate an already-committed business side effect', async () => {
    const bundle = createPlatformService({ seedProject: true });
    let executorAttempts = 0;
    let committedBusinessTasks = 0;
    let committedCharges = 0;

    bundle.registerWorkerExecutor('idempotency-probe', async (_job, _signal, execution) => {
      executorAttempts += 1;
      await execution?.runOnce('create-business-task', async () => {
        committedBusinessTasks += 1;
        return { taskId: 'task-1' };
      });
      await execution?.runOnce('charge', async () => {
        committedCharges += 1;
        return { chargeId: 'charge-1' };
      });
      if (executorAttempts === 1) throw new Error('response lost after commit');
    });
    const { runId } = await bundle.service.createRun({
      projectId: 'wan3',
      environment: 'test',
      trigger: 'manual',
      actor: 'qa',
      role: 'QA',
      idempotencyKey: 'business-operation-key-1',
    });

    await bundle.pool.dispatch();
    await bundle.pool.drain();
    await bundle.scheduler.requeueRetries();
    await bundle.pool.dispatch();
    await bundle.pool.drain();

    expect((await bundle.scheduler.list({ runId }))[0].status).toBe('SUCCESS');
    expect(executorAttempts).toBe(2);
    expect(committedBusinessTasks).toBe(1);
    expect(committedCharges).toBe(1);
  });
});
