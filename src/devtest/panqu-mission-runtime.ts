import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { missionAssert, verifyMissionPlan, validMilliCredits } from './panqu-mission-plan.js';
import type { PanquMissionApproval, PanquMissionDriver, PanquMissionJournal, PanquMissionPlan, PanquMissionState } from './panqu-mission-types.js';

/** The ledger remains private; credentials, raw responses and signed asset URLs are never stored in it. */
async function save(file: string, journal: PanquMissionJournal): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(journal, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
}
function event(journal: PanquMissionJournal, state: PanquMissionState, code: string, detail: string): void {
  journal.state = state;
  journal.events.push({ sequence: journal.events.length + 1, at: new Date().toISOString(), state, code, detail });
  journal.nextAction = state === 'SUBMISSION_UNKNOWN' ? 'RECONCILE_SUBMISSION' : ['POLLING', 'VERIFYING'].includes(state) ? 'RESUME_OBSERVATION'
    : ['PASSED', 'FAILED'].includes(state) ? 'REVIEW_EVIDENCE' : 'RESOLVE_BLOCKER';
}
function validateApproval(plan: PanquMissionPlan, approval: PanquMissionApproval, driver: PanquMissionDriver): void {
  missionAssert(approval && /^[\w.-]{1,120}$/.test(approval.approvalId) && approval.planHash === plan.hash, 'MISSION_EXACT_APPROVAL_REQUIRED');
  missionAssert(validMilliCredits(approval.maxMilliCredits) && approval.maxMilliCredits >= plan.variant.maxMilliCredits
    && approval.maxMilliCredits <= plan.maxMilliCredits, 'MISSION_APPROVAL_BUDGET_INVALID');
  missionAssert(['local', 'test', 'integration'].includes(approval.environment) && approval.retainTestAssets === true, 'MISSION_ENVIRONMENT_OR_RETENTION_UNAPPROVED');
  missionAssert(Date.parse(approval.expiresAt) > Date.now(), 'MISSION_APPROVAL_EXPIRED');
  const url = new URL(driver.origin);
  missionAssert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'MISSION_ORIGIN_INVALID');
  missionAssert(url.origin === approval.allowedOrigin && driver.profile === plan.profile, 'MISSION_DRIVER_ORIGIN_MISMATCH');
  if (approval.environment === 'local') missionAssert(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname), 'MISSION_LOCAL_TARGET_INVALID');
}

/** One bounded dispatch/observe cycle. Repeated calls resume a saved task and cannot re-submit it. */
export async function runPanquMission(input: {
  plan: PanquMissionPlan; approval: PanquMissionApproval; driver: PanquMissionDriver; journalDirectory: string;
  maxPolls?: number; pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal; recoverDeadLock?: boolean;
}): Promise<PanquMissionJournal> {
  const { driver, approval } = input;
  const plan = JSON.parse(JSON.stringify(input.plan)) as PanquMissionPlan;
  verifyMissionPlan(plan); validateApproval(plan, approval, driver);
  const maxPolls = input.maxPolls ?? 3; const interval = input.pollIntervalMs ?? 2000; const timeout = input.timeoutMs ?? 15000;
  missionAssert(Number.isSafeInteger(maxPolls) && maxPolls > 0 && maxPolls <= 30 && Number.isFinite(interval) && interval >= 0 && interval <= 10000
    && Number.isFinite(timeout) && timeout >= 1 && timeout <= 60000, 'MISSION_EXECUTION_BOUNDS_INVALID');
  const directory = path.resolve(input.journalDirectory);
  for (let part = directory; ; part = path.dirname(part)) {
    try { missionAssert(!(await lstat(part)).isSymbolicLink(), 'MISSION_JOURNAL_SYMLINK'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (path.dirname(part) === part) break;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${plan.hash}.json`); const lockFile = `${file}.lock`;
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    missionAssert(input.recoverDeadLock === true, 'MISSION_RUN_IN_PROGRESS');
    // Serialize recovery itself: two resumptions must not rename each other's newly acquired live lock.
    let recovery;
    try { recovery = await open(`${lockFile}.recovery`, 'wx', 0o600); } catch { throw new Error('MISSION_RUN_IN_PROGRESS'); }
    try {
      missionAssert(!(await lstat(lockFile)).isSymbolicLink(), 'MISSION_JOURNAL_SYMLINK');
      const owner = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number; host: string; planHash: string };
      missionAssert(owner.host === hostname() && owner.planHash === plan.hash && Number.isSafeInteger(owner.pid) && owner.pid > 0, 'MISSION_LOCK_OWNER_UNVERIFIED');
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (failure) { dead = (failure as NodeJS.ErrnoException).code === 'ESRCH'; }
      missionAssert(dead, 'MISSION_RUN_IN_PROGRESS');
      await rename(lockFile, `${lockFile}.abandoned.${randomUUID()}`);
      lock = await open(lockFile, 'wx', 0o600);
    } finally { await recovery.close(); await unlink(`${lockFile}.recovery`); }
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), planHash: plan.hash })); await lock.sync();
  try {
    let journal: PanquMissionJournal;
    try {
      missionAssert(!(await lstat(file)).isSymbolicLink(), 'MISSION_JOURNAL_SYMLINK');
      journal = JSON.parse(await readFile(file, 'utf8')) as PanquMissionJournal;
      missionAssert(journal.schema === 'panqu.mission-journal.v1' && journal.planHash === plan.hash && journal.driverIdentity === driver.identity
        && journal.origin === driver.origin && Array.isArray(journal.events) && Number.isSafeInteger(journal.submissionAttempts)
        && journal.submissionAttempts >= 0 && journal.submissionAttempts <= 1 && journal.reservedMilliCredits === plan.variant.maxMilliCredits, 'MISSION_JOURNAL_BINDING_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      journal = { schema: 'panqu.mission-journal.v1', planHash: plan.hash, driverIdentity: driver.identity, origin: driver.origin,
        approvalId: approval.approvalId, state: 'PLANNED', submissionAttempts: 0, reservedMilliCredits: plan.variant.maxMilliCredits, events: [], nextAction: 'CONFIRM_PLAN' };
      event(journal, 'PLANNED', 'BUDGET_RESERVED', `${plan.variant.maxMilliCredits} milli-credits reserved before submission.`);
      await save(file, journal);
    }
    if (['PASSED', 'FAILED', 'SUBMISSION_UNKNOWN'].includes(journal.state)) return journal;
    if (journal.state === 'SUBMITTING') {
      event(journal, 'SUBMISSION_UNKNOWN', 'INTERRUPTED_SUBMISSION', 'The request may have reached the server. No automatic resubmission is permitted.');
      await save(file, journal); return journal;
    }
    await driver.preflight(plan, approval);
    // Source/media checks can outlive approval. Recheck before creating any network signal.
    validateApproval(plan, approval, driver);
    const authorizationWindow = Math.max(1, Math.min(timeout, Date.parse(approval.expiresAt) - Date.now()));
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(authorizationWindow)]) : AbortSignal.timeout(authorizationWindow);
    if (!journal.taskId) {
      missionAssert(journal.submissionAttempts === 0, 'MISSION_SUBMISSION_ALREADY_ATTEMPTED');
      missionAssert(Date.parse(plan.quote.expiresAt) > Date.now(), 'MISSION_QUOTE_EXPIRED');
      missionAssert(!signal.aborted, 'MISSION_CANCELLED_BEFORE_SUBMIT');
      // fsync before the external side effect: a crash cannot turn uncertainty into permission to retry.
      journal.submissionAttempts = 1;
      event(journal, 'SUBMITTING', 'SUBMISSION_INTENT_DURABLE', 'Exactly one submission attempt authorized.'); await save(file, journal);
      try {
        const submitted = await driver.submit(plan, signal);
        missionAssert(typeof submitted.taskId === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(submitted.taskId), 'MISSION_TASK_ID_INVALID');
        journal.taskId = submitted.taskId;
        event(journal, 'POLLING', 'TASK_BOUND', 'Submission returned a task identity; generation is not yet verified.'); await save(file, journal);
      } catch {
        event(journal, 'SUBMISSION_UNKNOWN', 'SUBMISSION_OUTCOME_UNKNOWN', 'The request may have committed. Reserved credits remain held; query the server before any new submission.');
        await save(file, journal); return journal;
      }
    }
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      if (signal.aborted) break;
      try {
        const observed = await driver.observe(journal.taskId!, plan, signal);
        missionAssert(observed.taskId === journal.taskId && (observed.projectId === undefined || observed.projectId === plan.projectId), 'MISSION_FOREIGN_TASK_REJECTED');
        if (observed.chargedMilliCredits !== undefined) {
          missionAssert(validMilliCredits(observed.chargedMilliCredits), 'MISSION_CHARGE_RECEIPT_INVALID');
          journal.chargedMilliCredits = observed.chargedMilliCredits;
          if (observed.chargedMilliCredits > journal.reservedMilliCredits || observed.chargedMilliCredits > approval.maxMilliCredits) {
            event(journal, 'FAILED', 'BUDGET_OVERRUN_OBSERVED', 'Actual task-bound debit exceeded the approved quote/budget. No additional submissions are allowed.'); await save(file, journal); return journal;
          }
        }
        if (observed.state === 'failed') {
          event(journal, 'FAILED', 'REMOTE_TASK_FAILED', 'The bound task failed; no automatic generation retry.'); await save(file, journal); return journal;
        }
        if (observed.state === 'success') {
          event(journal, 'VERIFYING', 'RESULT_REQUIRES_PROOF', 'Server success requires independently decoded asset and billing evidence.'); await save(file, journal);
          const asset = await driver.verifyAsset(observed, plan, signal);
          const params = plan.variant.parameters;
          missionAssert(asset.decoded === true && asset.bytes > 0 && /^[a-f0-9]{64}$/.test(asset.sha256) && asset.kind === plan.requirement.kind, 'MISSION_ASSET_UNVERIFIED');
          journal.asset = asset;
          missionAssert(asset.width === params.width && asset.height === params.height && params.count === 1, 'MISSION_OUTPUT_DIMENSION_OR_COUNT_MISMATCH');
          if (params.durationSeconds !== undefined) missionAssert(asset.durationSeconds !== undefined && Math.abs(asset.durationSeconds - params.durationSeconds) <= 0.1, 'MISSION_OUTPUT_DURATION_MISMATCH');
          if (journal.chargedMilliCredits === undefined) {
            event(journal, 'BLOCKED', 'BILLING_EVIDENCE_MISSING', 'Media was verified, but no task-bound debit receipt is available. Reserved cost is not treated as actual cost.');
          } else event(journal, 'PASSED', 'REAL_OUTPUT_AND_COST_VERIFIED', 'One bound task, decoded matching media and task-bound debit verified.');
          await save(file, journal); return journal;
        }
        event(journal, 'POLLING', observed.state === 'unknown' ? 'UNKNOWN_REMOTE_STATE' : 'TASK_IN_PROGRESS', 'Keep observing the same task; no new generation submission.'); await save(file, journal);
      } catch (error) {
        const code = error instanceof Error && /^MISSION_[A-Z_]+$/.test(error.message) ? error.message : 'MISSION_OBSERVATION_UNAVAILABLE';
        event(journal, code.startsWith('MISSION_OUTPUT_') ? 'FAILED' : 'BLOCKED', code,
          code.startsWith('MISSION_OUTPUT_') ? 'Decoded output contradicts the approved output requirement.' : 'Observation or media verification was inconclusive. Resume the same task; do not re-submit.'); await save(file, journal); return journal;
      }
      if (attempt + 1 < maxPolls && interval) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, interval); signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish();
      });
    }
    event(journal, 'POLLING', 'OBSERVATION_WINDOW_ENDED', 'Resume observation in the next bounded cycle without repeating submission.'); await save(file, journal); return journal;
  } finally { await lock.close(); await unlink(lockFile); }
}

/** Evidence summary is usable without an LLM, including recovery instructions and exact cost uncertainty. */
export function renderPanquMission(journal: PanquMissionJournal): string {
  return [`# Panqu Mission ${journal.planHash.slice(0, 12)}`, '', `State: ${journal.state}`, `Next action: ${journal.nextAction}`,
    `Submission attempts: ${journal.submissionAttempts}`, `Reserved credits: ${journal.reservedMilliCredits / 1000}`,
    `Observed debit: ${journal.chargedMilliCredits === undefined ? 'UNKNOWN' : journal.chargedMilliCredits / 1000}`, '',
    '| Step | State | Evidence |', '| --- | --- | --- |', ...journal.events.map(item => `| ${item.sequence} | ${item.state} | ${item.code}: ${item.detail} |`), ''].join('\n');
}
