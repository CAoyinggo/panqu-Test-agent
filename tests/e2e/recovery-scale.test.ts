import { describe, expect, it } from 'vitest';
import { EvaluationCheckpointStore, RecoveryCoordinator, runResumableEvaluation } from '../../src/eval/recovery/index.js';

describe('Phase 51 Recovery scale E2E', () => {
  it('500 cases 在 #201 process kill 后恢复，500 case 恰好各执行一次', async () => {
    const caseIds = Array.from({ length: 500 }, (_, index) => `case-${index + 1}`);
    let checkpoints = new EvaluationCheckpointStore();
    const recovery = new RecoveryCoordinator();
    const counts = new Map<string, number>();
    let killed = false;
    const execute = (caseId: string): void => {
      if (caseId === 'case-201' && !killed) { killed = true; throw new Error('SIMULATED process kill'); }
      counts.set(caseId, (counts.get(caseId) ?? 0) + 1);
    };
    const input = { jobId: 'scale-recovery', projectId: 'p1', caseIds, benchmark: 'SCALE_v1', benchmarkChecksum: 'sha256-ok', groundTruthVersion: 'gt-v1' };
    expect((await runResumableEvaluation(input, { checkpoints, recovery, executeCase: execute })).completedCaseIds).toHaveLength(200);
    checkpoints = EvaluationCheckpointStore.restore(checkpoints.snapshot());
    recovery.recover('WORKER');
    const completed = await runResumableEvaluation(input, { checkpoints, recovery, executeCase: execute });
    expect(completed.state).toBe('COMPLETED');
    expect(completed.completedCaseIds).toHaveLength(500);
    expect(counts.size).toBe(500);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
    expect(recovery.status().recoveryRate).toBe(1);
  });
});
