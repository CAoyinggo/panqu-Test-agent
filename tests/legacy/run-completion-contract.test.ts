import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPlatformService, type PlatformBundle } from '../../src/platform/service/index.js';
import type { PlatformRunExecutionRecord } from '../../src/platform/runs/run-schema.js';
import { restoreSnapshot, type PlatformSnapshot } from '../../src/platform/ops/backup.js';

const LEGACY_MODE = ['LEGACY', 'LIFECYCLE'].join('_');

function executionRecord(overrides: Record<string, unknown> = {}): PlatformRunExecutionRecord {
  const base = {
    executionMode: 'VERIFIED_AGENT',
    requirementEvidence: {
      exists: true,
      requirementId: 'req-1',
      value: { feature: 'wan3' },
    },
    policyGate: {
      status: 'ALLOW',
      value: { allowed: true, verdict: 'ALLOW' },
    },
    execution: {
      executionId: 'exec-1',
      started: true,
      finished: true,
      plan: { cases: ['case-1'] },
    },
    evidence: [{
      evidenceId: 'evidence-1',
      runId: 'placeholder',
      caseId: 'case-1',
      executed: true,
      processor: 'video-processor',
      processorInvoked: true,
      requestId: 'request-1',
      executionStatus: 'PASS',
      effectiveAssertions: 1,
      assertionResults: [{ name: '业务断言', pass: true, kind: 'BUSINESS' }],
      timestamp: '2026-08-23T00:00:00.000Z',
    }],
    outcome: {
      exists: true,
      outcomeId: 'outcome-1',
      executionStatus: 'PASSED',
      executedCount: 1,
      value: { total: 1, passed: 1, failed: 0 },
    },
    result: 'PASS',
    recordedAt: '2026-08-23T00:00:00.000Z',
  };
  return { ...base, ...overrides } as unknown as PlatformRunExecutionRecord;
}

async function planningRun(bundle: PlatformBundle): Promise<string> {
  const { runId } = await bundle.service.createRun({
    projectId: 'wan3',
    environment: 'test',
    trigger: 'manual',
    feature: 'wan3',
    requirementText: '测试 WAN3 文生视频',
    actor: 'qa',
    role: 'QA',
  });
  await bundle.service.startRun(runId);
  await bundle.service.markRunGated(runId);
  await bundle.service.beginRunExecution(runId);
  return runId;
}

async function persist(bundle: PlatformBundle, runId: string, record: PlatformRunExecutionRecord): Promise<void> {
  record.evidence.forEach((item) => {
    if (item.runId === 'placeholder') item.runId = runId;
  });
  await bundle.service.recordRunExecution(runId, record);
}

async function expectCompletionRejected(record: PlatformRunExecutionRecord): Promise<void> {
  const bundle = createPlatformService({ seedProject: true });
  const runId = await planningRun(bundle);
  await persist(bundle, runId, record);
  await expect(bundle.service.completeRun(runId)).rejects.toThrow();
  expect((await bundle.service.getRun(runId))?.status).not.toBe('COMPLETED');
}

describe('Run Completion Contract', () => {
  it('LEGACY_LIFECYCLE_ZERO_REFERENCE', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const files: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (/\.(?:ts|js|mjs)$/.test(entry.name)) files.push(target);
      }
    };
    visit(sourceRoot);
    const references = files.filter((file) => fs.readFileSync(file, 'utf8').includes(LEGACY_MODE));
    expect(references).toEqual([]);
  });

  it('COMPLETION_REQUIRES_VERIFIED_AGENT', async () => {
    await expectCompletionRejected(executionRecord({ executionMode: LEGACY_MODE }));
  });

  it('COMPLETION_REQUIRES_REQUIREMENT', async () => {
    await expectCompletionRejected(executionRecord({ requirementEvidence: { exists: false } }));
  });

  it('COMPLETION_REQUIRES_POLICY_GATE', async () => {
    await expectCompletionRejected(executionRecord({ policyGate: undefined }));
  });

  it('COMPLETION_REQUIRES_EXECUTION', async () => {
    await expectCompletionRejected(executionRecord({ execution: undefined }));
  });

  it('COMPLETION_REQUIRES_EVIDENCE', async () => {
    await expectCompletionRejected(executionRecord({ evidence: [] }));
  });

  it('COMPLETION_REQUIRES_OUTCOME', async () => {
    await expectCompletionRejected(executionRecord({ outcome: undefined }));
  });

  it('COMPLETION_REQUIRES_EXECUTED_CASE', async () => {
    await expectCompletionRejected(executionRecord({
      outcome: { exists: true, outcomeId: 'empty', executionStatus: 'PASSED', executedCount: 0 },
    }));
  });

  it('COMPLETION_REJECTS_ASSERTION_COUNT_FORGERY', async () => {
    const forged = executionRecord();
    forged.evidence[0].assertionResults = [];
    forged.evidence[0].effectiveAssertions = 1;
    await expectCompletionRejected(forged);
  });

  it('COMPLETION_REJECTS_EVIDENCE_FROM_ANOTHER_RUN', async () => {
    await expectCompletionRejected(executionRecord({
      evidence: [{
        evidenceId: 'foreign-evidence', runId: 'another-run', caseId: 'case-1', executed: true,
        processor: 'video-processor', processorInvoked: true, executionStatus: 'PASS',
        effectiveAssertions: 1,
        assertionResults: [{ name: '业务断言', pass: true, kind: 'BUSINESS' }],
        timestamp: '2026-08-23T00:00:00.000Z',
      }],
    }));
  });

  it.each(['BLOCKED', 'NOT_EXECUTED', 'TIMEOUT', 'CANCELLED', 'INCONCLUSIVE'])(
    '%s_CANNOT_COMPLETE',
    async (executionStatus) => {
      await expectCompletionRejected(executionRecord({
        outcome: { exists: true, outcomeId: `outcome-${executionStatus}`, executionStatus, executedCount: 1 },
      }));
    },
  );

  it('WORKER_SUCCESS_WITHOUT_EXECUTION_CANNOT_COMPLETE', async () => {
    const bundle = createPlatformService({ seedProject: true });
    bundle.registerWorkerExecutor('empty-success-worker', async () => ({ ok: true }));
    const { runId } = await bundle.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA',
    });
    await bundle.pool.dispatch();
    await bundle.pool.drain();
    expect((await bundle.service.getRun(runId))?.status).not.toBe('COMPLETED');
    await expect(bundle.service.completeRun(runId)).rejects.toThrow();
  });

  it('NON_EXECUTING_RUN_CANNOT_COMPLETE', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const { runId } = await bundle.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'perf', role: 'QA',
    }, { executionMode: 'NON_EXECUTING' });
    const run = await bundle.service.startRun(runId);
    expect(run.executionMode).toBe('NON_EXECUTING');
    await expect(bundle.service.completeRun(runId)).rejects.toThrow(/executionMode 不是 VERIFIED_AGENT/);
    expect((await bundle.service.getRun(runId))?.status).toBe('PLANNING');
  });

  it('MOCK_CHECKPOINT_CANNOT_DECLARE_COMPLETION', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const { runId } = await bundle.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA',
    });
    await bundle.service.startRun(runId);
    await bundle.service.saveCheckpoint({
      runId,
      stage: 'forged-completion',
      completedCases: ['case-1'],
      remainingCases: [],
      decisionState: { status: 'COMPLETED', category: 'p0' },
      knowledgeState: { outcome: { status: 'PASSED' } },
      budgetState: {},
      traceId: 'forged-completion-trace',
    });
    await expect(bundle.service.completeRun(runId)).rejects.toThrow(/Completion Contract/);
    expect((await bundle.service.getRun(runId))?.status).toBe('PLANNING');
  });

  it('RESTORE_FORGED_COMPLETED_CANNOT_BYPASS_GUARD', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const forged = {
      id: 'forged-run',
      runId: 'forged-run',
      projectId: 'wan3',
      environment: 'test',
      trigger: 'manual',
      status: 'COMPLETED',
      progress: 100,
      createdAt: '2026-08-23T00:00:00.000Z',
      executionMode: 'VERIFIED_AGENT',
    };
    const snapshot: PlatformSnapshot = {
      version: 1,
      exportedAt: '2026-08-23T00:00:00.000Z',
      stores: [{ store: 'runs', count: 1, data: [forged] }],
    };
    await expect(restoreSnapshot(bundle, snapshot)).rejects.toThrow(/Completion Contract/);
    expect(await bundle.service.getRun('forged-run')).toBeNull();
  });

  it('VALID_FAILED_OUTCOME_CAN_COMPLETE', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const runId = await planningRun(bundle);
    await persist(bundle, runId, executionRecord({
      evidence: [{
        evidenceId: 'failed-evidence', runId, caseId: 'case-fail', executed: true,
        processor: 'video-processor', processorInvoked: true, requestId: 'request-fail',
        executionStatus: 'FAIL', effectiveAssertions: 1,
        assertionResults: [{ name: '业务断言', pass: false, kind: 'BUSINESS' }],
        timestamp: '2026-08-23T00:00:00.000Z',
      }],
      outcome: { exists: true, outcomeId: 'failed-outcome', executionStatus: 'FAILED', executedCount: 1 },
      result: 'FAIL',
    }));
    const completed = await bundle.service.completeRun(runId);
    expect(completed.status).toBe('COMPLETED');
  });

  it('RESUME_REQUIRES_NEW_GATE', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const runId = await planningRun(bundle);
    const run = await bundle.service.getRun(runId);
    if (run?.status === 'RUNNING') await bundle.service.pauseRun(runId, 'qa', 'QA');
    const resumed = await bundle.service.resumeRun(runId, 'qa', 'QA');
    expect(resumed.status).not.toBe('COMPLETED');
    expect(resumed.executionRecord).toBeUndefined();
    await expect(bundle.service.completeRun(runId)).rejects.toThrow();
  });

  it('RETRY_CANNOT_DUPLICATE_COMPLETION', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const originalId = await planningRun(bundle);
    await persist(bundle, originalId, executionRecord());
    await bundle.service.completeRun(originalId);
    const retried = await bundle.service.retryRun(originalId, 'qa', 'QA');
    expect(retried.runId).not.toBe(originalId);
    expect(retried.executionRecord).toBeUndefined();
    expect(retried.status).toBe('QUEUED');
    await expect(bundle.service.completeRun(retried.runId)).rejects.toThrow();
    await bundle.service.startRun(retried.runId);
    await bundle.service.markRunGated(retried.runId);
    await bundle.service.beginRunExecution(retried.runId);
    const original = (await bundle.service.getRun(originalId))?.executionRecord;
    const copied = structuredClone(original!);
    delete copied.completionGuardPassed;
    copied.evidence.forEach((item) => { item.runId = retried.runId; });
    await expect(bundle.service.recordRunExecution(retried.runId, copied)).rejects.toThrow(/身份已被其他 Run 使用/);
    expect((await bundle.service.getRun(retried.runId))?.status).toBe('RUNNING');
  });
});
