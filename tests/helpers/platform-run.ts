import type { PlatformRunExecutionRecord } from '../../src/platform/runs/run-schema.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';

export function verifiedExecutionRecord(
  runId: string,
  options: { result?: 'PASS' | 'FAIL'; caseId?: string } = {},
): PlatformRunExecutionRecord {
  const result = options.result ?? 'PASS';
  const caseId = options.caseId ?? 'fixture-case';
  const pass = result === 'PASS';
  return {
    executionMode: 'VERIFIED_AGENT',
    requirementEvidence: {
      exists: true,
      requirementId: `requirement:${runId}`,
      value: { feature: 'test-fixture' },
    },
    policyGate: { status: 'ALLOW', value: { allowed: true, verdict: 'ALLOW' } },
    execution: {
      executionId: `execution:${runId}`,
      started: true,
      finished: true,
      plan: { cases: [caseId] },
    },
    evidence: [{
      evidenceId: `evidence:${runId}:${caseId}`,
      runId,
      caseId,
      executed: true,
      processor: 'test-fixture-processor',
      processorInvoked: true,
      requestId: `request:${runId}:${caseId}`,
      executionStatus: result,
      effectiveAssertions: 1,
      assertionResults: [{ name: 'fixture business assertion', pass, kind: 'BUSINESS' }],
      timestamp: new Date().toISOString(),
    }],
    outcome: {
      exists: true,
      outcomeId: `outcome:${runId}`,
      executionStatus: pass ? 'PASSED' : 'FAILED',
      executedCount: 1,
      value: { total: 1, passed: pass ? 1 : 0, failed: pass ? 0 : 1 },
    },
    result,
    recordedAt: new Date().toISOString(),
  };
}

export async function advanceVerifiedRunToRunning(bundle: PlatformBundle, runId: string): Promise<void> {
  let run = await bundle.service.getRun(runId);
  if (run?.status === 'QUEUED') run = await bundle.service.startRun(runId);
  if (run?.status === 'PLANNING') run = await bundle.service.markRunGated(runId);
  if (run?.status === 'GATED') await bundle.service.beginRunExecution(runId);
}

export async function completeVerifiedRun(
  bundle: PlatformBundle,
  runId: string,
  options: { result?: 'PASS' | 'FAIL'; caseId?: string } = {},
): Promise<void> {
  await advanceVerifiedRunToRunning(bundle, runId);
  await bundle.service.recordRunExecution(runId, verifiedExecutionRecord(runId, options));
  await bundle.service.completeRun(runId);
}
