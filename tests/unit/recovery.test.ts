import { describe, expect, it } from 'vitest';
import { ContentAddressedBenchmarkStore } from '../../src/eval/benchmark/content-store.js';
import { EvaluationCheckpointStore, RecoveryCoordinator, runResumableEvaluation } from '../../src/eval/recovery/index.js';
import { EvaluationQueue } from '../../src/eval/scale/index.js';

const input = { jobId: 'job-1', projectId: 'p1', caseIds: ['c1', 'c2', 'c3', 'c4'], benchmark: 'RISK_v10', benchmarkChecksum: 'sum-v10', groundTruthVersion: 'gt-v10' };

describe('Phase 51.7 disaster / recovery', () => {
  it('process kill after Case #2 → checkpoint restore → resume Case #3，不重复执行', async () => {
    let checkpoints = new EvaluationCheckpointStore();
    const recovery = new RecoveryCoordinator();
    const executions: string[] = [];
    let killed = false;
    const first = await runResumableEvaluation(input, {
      checkpoints, recovery,
      executeCase: (caseId) => {
        if (caseId === 'c3' && !killed) { killed = true; throw new Error('SIMULATED process kill'); }
        executions.push(caseId);
      },
    });
    expect(first).toMatchObject({ state: 'PAUSED', completedCaseIds: ['c1', 'c2'], remainingCaseIds: ['c3', 'c4'] });

    checkpoints = EvaluationCheckpointStore.restore(checkpoints.snapshot());
    recovery.recover('WORKER');
    const resumed = await runResumableEvaluation(input, { checkpoints, recovery, executeCase: (caseId) => { executions.push(caseId); } });
    expect(resumed.state).toBe('COMPLETED');
    expect(executions).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('Ground Truth unavailable → PAUSED；恢复后 resume，禁止旧 GT fallback', async () => {
    const checkpoints = new EvaluationCheckpointStore();
    const recovery = new RecoveryCoordinator();
    recovery.detect('GROUND_TRUTH', 'SIMULATED store unavailable');
    const executed: string[] = [];
    const paused = await runResumableEvaluation(input, { checkpoints, recovery, executeCase: (id) => { executed.push(id); } });
    expect(paused).toMatchObject({ state: 'PAUSED', completedCaseIds: [] });
    expect(paused.reason).toContain('stale fallback forbidden');
    expect(executed).toEqual([]);
    recovery.recover('GROUND_TRUTH');
    expect((await runResumableEvaluation(input, { checkpoints, recovery, executeCase: (id) => { executed.push(id); } })).state).toBe('COMPLETED');
  });

  it.each(['STORAGE', 'QUEUE', 'TELEMETRY'] as const)('%s failure detect → alert → recover → resume', async (component) => {
    const checkpoints = new EvaluationCheckpointStore();
    const recovery = new RecoveryCoordinator();
    recovery.detect(component, `SIMULATED ${component} failure`);
    expect((await runResumableEvaluation(input, { checkpoints, recovery, executeCase: () => undefined })).state).toBe('PAUSED');
    expect(recovery.status().health).toBe('DEGRADED');
    recovery.beginRecovery(component);
    recovery.recover(component);
    expect((await runResumableEvaluation(input, { checkpoints, recovery, executeCase: () => undefined })).state).toBe('COMPLETED');
  });

  it('Benchmark corruption → BLOCK → v11 rollback target v10', async () => {
    const store = new ContentAddressedBenchmarkStore();
    const testCase = (id: string) => ({ id, domain: 'RISK' as const, input: { id }, groundTruth: { risk: true }, metadata: {} });
    store.createVersion({ name: 'RISK_BENCHMARK_v10', version: 'v10', domain: 'RISK', cases: [testCase('c10')], source: 'HUMAN' });
    store.createVersion({ name: 'RISK_BENCHMARK_v11', version: 'v11', domain: 'RISK', cases: [testCase('c11')], source: 'HUMAN' });
    const snapshot = store.snapshot();
    snapshot.manifests[1].caseCount = 9;
    const corrupted = ContentAddressedBenchmarkStore.import(snapshot);
    const recovery = new RecoveryCoordinator();
    recovery.detect('BENCHMARK', corrupted.integrity('RISK_BENCHMARK_v11').issues.join(','));
    const blocked = await runResumableEvaluation(input, { checkpoints: new EvaluationCheckpointStore(), recovery, executeCase: () => undefined });
    expect(blocked.state).toBe('BLOCKED');
    expect(corrupted.rollbackTarget('RISK_BENCHMARK_v11').version).toBe('v10');
  });

  it('Queue snapshot recovery 使 RUNNING job 原 ID requeue，旧 lease 失效', () => {
    const queue = new EvaluationQueue();
    queue.enqueue({ id: 'q1', projectId: 'p1', domains: ['RISK'] });
    const old = queue.claim('dead-worker')!;
    const restored = EvaluationQueue.restore(queue.snapshot());
    expect(restored.get('q1')).toMatchObject({ status: 'QUEUED', attempts: 1 });
    const next = restored.claim('new-worker')!;
    restored.complete('q1', next.token);
    expect(() => restored.complete('q1', old.token)).toThrow('lease 已失效');
  });

  it('恢复时 Benchmark/GT version 改变 → BLOCK，避免不同真值混算', async () => {
    const checkpoints = new EvaluationCheckpointStore();
    const recovery = new RecoveryCoordinator();
    await runResumableEvaluation(input, { checkpoints, recovery, executeCase: (id) => { if (id === 'c2') throw new Error('kill'); } });
    recovery.recover('WORKER');
    const changed = await runResumableEvaluation({ ...input, groundTruthVersion: 'gt-v11' }, { checkpoints, recovery, executeCase: () => undefined });
    expect(changed.state).toBe('BLOCKED');
  });
});
