import { missionAssert, missionDigest, validMilliCredits } from './panqu-mission-plan.js';
import type { PanquMissionApproval, PanquMissionDriver, PanquMissionEvidence, PanquMissionJournal, PanquMissionObservation, PanquMissionPlan, PanquMissionState } from './panqu-mission-types.js';

type Persist = (state: PanquMissionState, code: string, detail: string) => Promise<void>;
const terminal = (state: string | undefined) => state === 'success' || state === 'failed';
const safeCode = (error: unknown) => error instanceof Error && /^MISSION_[A-Z_]+$/.test(error.message) ? error.message : 'MISSION_EVIDENCE_UNAVAILABLE';
const remember = (items: string[], code: string) => { if (!items.includes(code)) items.push(code); };

/** Initialize missing evidence conservatively; historical amounts or media are not final settlement proof. */
export function createPanquMissionEvidence(taskId: string): PanquMissionEvidence {
  return { schema: 'panqu.mission-evidence.v1', media: { state: 'unverified' }, settlement: { taskId, state: 'unknown' },
    failures: [], conflicts: [], requests: { task: 0, media: 0, settlement: 0 }, next: { action: 'OBSERVE_TASK', missing: ['TASK', 'MEDIA', 'FINAL_SETTLEMENT'] } };
}

/** Merge source-versioned task observations without letting stale polling or conflicting terminal facts erase evidence. */
export function acceptPanquTaskEvidence(evidence: PanquMissionEvidence, observed: PanquMissionObservation, plan: PanquMissionPlan): boolean {
  missionAssert(observed.taskId === evidence.settlement.taskId && (observed.projectId === undefined || observed.projectId === plan.projectId), 'MISSION_FOREIGN_TASK_REJECTED');
  missionAssert(['pending', 'running', 'success', 'failed', 'unknown'].includes(observed.state), 'MISSION_TASK_STATE_INVALID');
  if (observed.requestId !== undefined) missionAssert(observed.requestId === plan.hash, 'MISSION_TASK_REQUEST_BINDING_MISMATCH');
  if (observed.nodeId !== undefined) missionAssert(observed.nodeId === plan.nodeId, 'MISSION_TASK_NODE_BINDING_MISMATCH');
  if (plan.variant.preparation) missionAssert(observed.requestId === plan.hash && observed.nodeId === plan.nodeId, 'MISSION_TASK_REQUEST_BINDING_MISMATCH');
  if (observed.updatedAt !== undefined) missionAssert(Number.isFinite(Date.parse(observed.updatedAt)), 'MISSION_TASK_VERSION_INVALID');
  const updatedAt = observed.updatedAt === undefined ? undefined : new Date(observed.updatedAt).toISOString();
  const old = evidence.task;
  if (old?.updatedAt && updatedAt && Date.parse(updatedAt) < Date.parse(old.updatedAt)) return false;
  if (old && terminal(old.state) && old.state !== observed.state) {
    remember(evidence.conflicts, 'MISSION_TASK_TERMINAL_CONFLICT'); return false;
  }
  if (old?.updatedAt && updatedAt === old.updatedAt && old.state !== observed.state) {
    remember(evidence.conflicts, 'MISSION_TASK_VERSION_CONFLICT'); return false;
  }
  evidence.task = { state: observed.state, requestId: observed.requestId, nodeId: observed.nodeId, updatedAt,
    observedAt: new Date().toISOString() };
  if (observed.state === 'failed') remember(evidence.failures, 'REMOTE_TASK_FAILED');
  return true;
}

/** Derive the next bounded business action from facts, not from a model's PASS claim or a single remote status. */
function decision(journal: PanquMissionJournal): { state: PanquMissionState; code: string; detail: string } {
  const evidence = journal.evidence!;
  const settled = evidence.settlement.state === 'final';
  const failed = evidence.failures.length > 0;
  const missing: string[] = [];
  if (!terminal(evidence.task?.state)) missing.push('TASK');
  if (evidence.task?.state === 'success' && evidence.media.state !== 'verified' && !failed) missing.push('MEDIA');
  if (!settled) missing.push('FINAL_SETTLEMENT');
  if (evidence.conflicts.length) {
    evidence.next = { action: 'RESOLVE_EVIDENCE_CONFLICT', missing: [...missing, 'EVIDENCE_CONFLICT'] };
    return { state: 'BLOCKED', code: evidence.conflicts[0], detail: 'Conflicting business evidence is retained. No automatic resubmission or evidence overwrite.' };
  }
  if (!terminal(evidence.task?.state)) {
    evidence.next = { action: 'OBSERVE_TASK', missing };
    return { state: 'POLLING', code: 'TASK_IN_PROGRESS', detail: 'Observe the same task; a pending state is not permission to submit again.' };
  }
  if (evidence.task?.state === 'success' && evidence.media.state !== 'verified' && !failed) {
    evidence.next = { action: 'VERIFY_MEDIA', missing };
    return { state: 'BLOCKED', code: evidence.media.code ?? 'MISSION_ASSET_UNVERIFIED', detail: 'Task completion was retained, but its output still needs independent verification.' };
  }
  if (!settled) {
    evidence.next = { action: 'OBSERVE_SETTLEMENT', missing };
    return { state: evidence.settlement.state === 'pending' ? 'SETTLING' : 'BLOCKED', code: evidence.settlement.reason ?? 'MISSION_SETTLEMENT_PENDING',
      detail: failed ? 'Generation/output has a confirmed failure. Its final cost/refund remains unresolved; observe billing only.'
        : 'Verified media is retained. Only final task-bound settlement remains; do not download or generate again.' };
  }
  evidence.next = { action: 'REVIEW_EVIDENCE', missing: [] };
  return { state: failed ? 'FAILED' : 'PASSED', code: failed ? evidence.failures[0] : 'REAL_OUTPUT_AND_FINAL_SETTLEMENT_VERIFIED',
    detail: failed ? 'Confirmed failure and final task-bound cost/refund evidence retained. No generation retry.'
      : 'One bound task, independently decoded matching media and explicit final settlement verified.' };
}

/** One durable evidence sweep. Each external read is counted before dispatch and only missing facts are requested. */
export async function advancePanquMissionEvidence(input: {
  journal: PanquMissionJournal; plan: PanquMissionPlan; approval: PanquMissionApproval; driver: PanquMissionDriver; signal: AbortSignal; persist: Persist;
}): Promise<PanquMissionState> {
  const { journal, plan, approval, driver, signal, persist } = input;
  const evidence = journal.evidence ??= createPanquMissionEvidence(journal.taskId!);
  missionAssert(evidence.schema === 'panqu.mission-evidence.v1' && evidence.settlement.taskId === journal.taskId, 'MISSION_EVIDENCE_BINDING_INVALID');
  const finish = async () => { const next = decision(journal); await persist(next.state, next.code, next.detail); return next.state; };
  if (evidence.conflicts.length) return finish();
  let observed: PanquMissionObservation | undefined;
  // Re-read terminal success only while an output is still missing, e.g. delayed storage or expired signed URL.
  if (!terminal(evidence.task?.state) || evidence.task?.state === 'success' && evidence.media.state === 'unverified' && !evidence.failures.length) {
    try {
      missionAssert(!signal.aborted, 'MISSION_EVIDENCE_WINDOW_ENDED');
      evidence.requests.task++;
      await persist('POLLING', 'TASK_READ_INTENT', 'Read the bound task; task IDs and source versions are validated before merging.');
      const incoming = await driver.observe(journal.taskId!, plan, signal);
      if (acceptPanquTaskEvidence(evidence, incoming, plan)) observed = incoming;
      await persist('POLLING', observed ? 'TASK_FACT_RETAINED' : 'STALE_OR_CONFLICTING_TASK_FACT', 'Task observation merged without retaining raw response or asset URL.');
    } catch (error) {
      const code = safeCode(error);
      if (/FOREIGN_TASK|BINDING_MISMATCH|TERMINAL_CONFLICT|VERSION_CONFLICT/.test(code)) remember(evidence.conflicts, code);
      decision(journal);
      await persist('BLOCKED', code, 'Task observation could not be verified. Previously retained evidence remains intact.');
      return 'BLOCKED';
    }
  }
  if (evidence.conflicts.length || !terminal(evidence.task?.state)) return finish();
  // Settlement may lag task completion or failure. Its outage must not suppress known task/media facts.
  if (evidence.settlement.state !== 'final') {
    try {
      missionAssert(!signal.aborted, 'MISSION_EVIDENCE_WINDOW_ENDED');
      if (!driver.observeSettlement) evidence.settlement = { taskId: journal.taskId!, state: 'unknown', reason: 'MISSION_SETTLEMENT_ADAPTER_MISSING' };
      else {
        evidence.requests.settlement++;
        await persist('SETTLING', 'SETTLEMENT_READ_INTENT', 'Read finality and net cost/refund for the exact submitted task namespace.');
        const settled = await driver.observeSettlement(journal.taskId!, plan, signal);
        missionAssert(settled.taskId === journal.taskId, 'MISSION_RECEIPT_TASK_MISMATCH');
        missionAssert(['pending', 'final', 'unknown'].includes(settled.state), 'MISSION_SETTLEMENT_STATE_INVALID');
        if (settled.state === 'final') {
          missionAssert(validMilliCredits(settled.netMilliCredits) && typeof settled.evidenceHash === 'string' && /^[a-f0-9]{64}$/.test(settled.evidenceHash), 'MISSION_FINAL_SETTLEMENT_INVALID');
          if (settled.debitMilliCredits !== undefined || settled.refundedMilliCredits !== undefined) missionAssert(validMilliCredits(settled.debitMilliCredits)
            && validMilliCredits(settled.refundedMilliCredits) && settled.refundedMilliCredits! <= settled.debitMilliCredits!
            && settled.netMilliCredits === settled.debitMilliCredits! - settled.refundedMilliCredits!, 'MISSION_REFUND_RECEIPT_INVALID');
          journal.chargedMilliCredits = settled.netMilliCredits;
          if (settled.netMilliCredits! > journal.reservedMilliCredits || settled.netMilliCredits! > approval.maxMilliCredits) remember(evidence.failures, 'BUDGET_OVERRUN_OBSERVED');
        }
        // Only whitelisted scalar evidence is persisted, including for custom drivers.
        evidence.settlement = { taskId: settled.taskId, state: settled.state, ...(settled.state === 'final'
          ? { netMilliCredits: settled.netMilliCredits, debitMilliCredits: settled.debitMilliCredits, refundedMilliCredits: settled.refundedMilliCredits, evidenceHash: settled.evidenceHash }
          : { reason: settled.reason && /^(MISSION_[A-Z_]+|BILLING_EVIDENCE_MISSING)$/.test(settled.reason) ? settled.reason : undefined }) };
      }
    } catch (error) {
      const code = safeCode(error);
      if (code === 'MISSION_RECEIPT_TASK_MISMATCH') remember(evidence.conflicts, code);
      evidence.settlement = { taskId: journal.taskId!, state: 'unknown', reason: code };
    }
    await persist('SETTLING', 'SETTLEMENT_FACT_RETAINED', 'Final, pending or missing settlement is recorded independently from task completion.');
  }
  if (evidence.conflicts.length) return finish();
  if (evidence.task?.state === 'success' && evidence.media.state === 'unverified' && !evidence.failures.length && observed?.state === 'success') {
    try {
      missionAssert(!signal.aborted, 'MISSION_EVIDENCE_WINDOW_ENDED');
      evidence.requests.media++;
      await persist('VERIFYING', 'MEDIA_VERIFY_INTENT', 'Independently fetch and decode only the target output; no application credentials are forwarded.');
      const asset = await driver.verifyAsset(observed, plan, signal);
      missionAssert(asset.decoded === true && asset.bytes > 0 && /^[a-f0-9]{64}$/.test(asset.sha256) && asset.kind === plan.requirement.kind, 'MISSION_ASSET_UNVERIFIED');
      journal.asset = { sha256: asset.sha256, bytes: asset.bytes, kind: asset.kind, width: asset.width, height: asset.height, durationSeconds: asset.durationSeconds, decoded: true };
      const params = plan.variant.parameters;
      missionAssert(asset.width === params.width && asset.height === params.height && params.count === 1, 'MISSION_OUTPUT_DIMENSION_OR_COUNT_MISMATCH');
      if (params.durationSeconds !== undefined) missionAssert(asset.durationSeconds !== undefined && Math.abs(asset.durationSeconds - params.durationSeconds) <= 0.1, 'MISSION_OUTPUT_DURATION_MISMATCH');
      evidence.media = { state: 'verified', assetIdentityHash: missionDigest({ taskId: journal.taskId, nodeId: plan.nodeId, sha256: asset.sha256 }) };
    } catch (error) {
      const code = safeCode(error);
      evidence.media = { state: code.startsWith('MISSION_OUTPUT_') ? 'failed' : 'unverified', code };
      if (evidence.media.state === 'failed') remember(evidence.failures, code);
    }
    await persist('VERIFYING', 'MEDIA_FACT_RETAINED', 'Verified metadata or the precise verification gap is durable; billing retries do not repeat successful media checks.');
  }
  return finish();
}
