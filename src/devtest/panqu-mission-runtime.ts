import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { advancePanquMissionEvidence } from './panqu-mission-evidence.js';
import { missionAssert, verifyMissionPlan, validMilliCredits } from './panqu-mission-plan.js';
import type { PanquMissionApproval, PanquMissionDriver, PanquMissionJournal, PanquMissionPlan, PanquMissionState } from './panqu-mission-types.js';

/** The ledger remains private; credentials, raw responses and signed asset URLs are never stored in it. */
export async function savePanquMissionJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
}
const save = savePanquMissionJson;

/** Private task storage rejects symlink ancestry before creating any files. */
export async function ensurePanquMissionDirectory(directory: string): Promise<string> {
  directory = path.resolve(directory);
  for (let part = directory; ; part = path.dirname(part)) {
    try { missionAssert(!(await lstat(part)).isSymbolicLink(), 'MISSION_JOURNAL_SYMLINK'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (path.dirname(part) === part) break;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 }); return directory;
}

/** Serialize both intent refreshes and execution; only demonstrably dead local owners can be recovered. */
export async function withPanquMissionLock<T>(lockFile: string, key: string, recoverDeadLock: boolean, action: () => Promise<T>): Promise<T> {
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    missionAssert(recoverDeadLock, 'MISSION_RUN_IN_PROGRESS');
    let recovery;
    try { recovery = await open(`${lockFile}.recovery`, 'wx', 0o600); } catch { throw new Error('MISSION_RUN_IN_PROGRESS'); }
    try {
      missionAssert(!(await lstat(lockFile)).isSymbolicLink(), 'MISSION_JOURNAL_SYMLINK');
      const owner = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number; host: string; planHash: string };
      missionAssert(owner.host === hostname() && owner.planHash === key && Number.isSafeInteger(owner.pid) && owner.pid > 0, 'MISSION_LOCK_OWNER_UNVERIFIED');
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (failure) { dead = (failure as NodeJS.ErrnoException).code === 'ESRCH'; }
      missionAssert(dead, 'MISSION_RUN_IN_PROGRESS');
      await rename(lockFile, `${lockFile}.abandoned.${randomUUID()}`);
      lock = await open(lockFile, 'wx', 0o600);
    } finally { await recovery.close(); await unlink(`${lockFile}.recovery`); }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), planHash: key })); await lock.sync();
    return await action();
  } finally { await lock.close(); await unlink(lockFile); }
}

/** Read only a bounded regular task-state file; state files are never followed through symlinks. */
export async function readPanquMissionJson<T>(file: string): Promise<T> {
  const info = await lstat(file);
  missionAssert(info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024, 'MISSION_STATE_FILE_INVALID');
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
function event(journal: PanquMissionJournal, state: PanquMissionState, code: string, detail: string): void {
  journal.state = state;
  journal.events.push({ sequence: journal.events.length + 1, at: new Date().toISOString(), state, code, detail });
  journal.nextAction = state === 'SUBMISSION_UNKNOWN' ? 'RECONCILE_SUBMISSION' : ['POLLING', 'VERIFYING', 'SETTLING'].includes(state) ? 'RESUME_OBSERVATION'
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
type MissionRunInput = {
  plan: PanquMissionPlan; approval: PanquMissionApproval; driver: PanquMissionDriver; journalDirectory: string;
  maxPolls?: number; pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal; recoverDeadLock?: boolean;
};

/** Stable intent ownership prevents an old approval racing a refreshed plan or a second submission. */
export async function runPanquMission(input: MissionRunInput): Promise<PanquMissionJournal> {
  verifyMissionPlan(input.plan); validateApproval(input.plan, input.approval, input.driver);
  const preparation = input.plan.variant.preparation;
  if (!preparation) return runPanquMissionCycle(input);
  missionAssert(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(preparation.intentId), 'MISSION_INTENT_ID_INVALID');
  const directory = await ensurePanquMissionDirectory(input.journalDirectory);
  const registryFile = path.join(directory, `intent-${preparation.intentId}.json`);
  return withPanquMissionLock(`${registryFile}.lock`, preparation.intentId, input.recoverDeadLock === true, async () => {
    const registry = await readPanquMissionJson<{ schema: string; planHash: string; intentHash: string; contextHash: string }>(registryFile);
    missionAssert(registry.schema === 'panqu.mission-intent-registry.v1' && registry.planHash === input.plan.hash
      && registry.intentHash === preparation.intentHash && registry.contextHash === preparation.contextHash, 'MISSION_INTENT_PLAN_SUPERSEDED');
    return runPanquMissionCycle(input);
  });
}

async function runPanquMissionCycle(input: MissionRunInput): Promise<PanquMissionJournal> {
  const { driver, approval } = input;
  const plan = JSON.parse(JSON.stringify(input.plan)) as PanquMissionPlan;
  verifyMissionPlan(plan); validateApproval(plan, approval, driver);
  const maxPolls = input.maxPolls ?? 3; const interval = input.pollIntervalMs ?? 2000; const timeout = input.timeoutMs ?? 15000;
  missionAssert(Number.isSafeInteger(maxPolls) && maxPolls > 0 && maxPolls <= 30 && Number.isFinite(interval) && interval >= 0 && interval <= 10000
    && Number.isFinite(timeout) && timeout >= 1 && timeout <= 60000, 'MISSION_EXECUTION_BOUNDS_INVALID');
  const directory = await ensurePanquMissionDirectory(input.journalDirectory);
  const file = path.join(directory, `${plan.hash}.json`); const lockFile = `${file}.lock`;
  return withPanquMissionLock(lockFile, plan.hash, input.recoverDeadLock === true, async () => {
    let journal: PanquMissionJournal;
    try {
      missionAssert(!(await lstat(file)).isSymbolicLink(), 'MISSION_JOURNAL_SYMLINK');
      journal = await readPanquMissionJson<PanquMissionJournal>(file);
      missionAssert(journal.schema === 'panqu.mission-journal.v1' && journal.planHash === plan.hash && journal.driverIdentity === driver.identity
        && journal.origin === driver.origin && Array.isArray(journal.events) && Number.isSafeInteger(journal.submissionAttempts)
        && journal.submissionAttempts >= 0 && journal.submissionAttempts <= 1 && journal.reservedMilliCredits === plan.variant.maxMilliCredits
        && (journal.taskId === undefined || typeof journal.taskId === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(journal.taskId) && journal.submissionAttempts === 1), 'MISSION_JOURNAL_BINDING_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      journal = { schema: 'panqu.mission-journal.v1', planHash: plan.hash, driverIdentity: driver.identity, origin: driver.origin,
        approvalId: approval.approvalId, state: 'PLANNED', submissionAttempts: 0, reservedMilliCredits: plan.variant.maxMilliCredits, events: [], nextAction: 'CONFIRM_PLAN' };
      event(journal, 'PLANNED', 'BUDGET_RESERVED', `${plan.variant.maxMilliCredits} milli-credits reserved before submission.`);
      await save(file, journal);
    }
    if (['PASSED', 'FAILED'].includes(journal.state) && !journal.evidence) {
      event(journal, 'BLOCKED', 'MISSION_LEGACY_SETTLEMENT_UNVERIFIED', 'Historical result lacks staged/final settlement evidence. No submission repeated; explicit evidence migration is required.');
      await save(file, journal); return journal;
    }
    if (journal.events.some(item => item.code === 'MISSION_LEGACY_SETTLEMENT_UNVERIFIED')) return journal;
    if (['PASSED', 'FAILED', 'SUBMISSION_UNKNOWN'].includes(journal.state)) return journal;
    if (journal.state === 'SUBMITTING') {
      event(journal, 'SUBMISSION_UNKNOWN', 'INTERRUPTED_SUBMISSION', 'The request may have reached the server. No automatic resubmission is permitted.');
      await save(file, journal); return journal;
    }
    await driver.preflight(plan, approval, { resumeOnly: Boolean(journal.taskId) });
    // Source/media checks can outlive approval. Recheck before creating any network signal.
    validateApproval(plan, approval, driver);
    const authorizationWindow = Math.max(1, Math.min(timeout, Date.parse(approval.expiresAt) - Date.now()));
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(authorizationWindow)]) : AbortSignal.timeout(authorizationWindow);
    if (!journal.taskId) {
      missionAssert(driver.observeSettlement, 'MISSION_SETTLEMENT_ADAPTER_MISSING');
      missionAssert(journal.submissionAttempts === 0, 'MISSION_SUBMISSION_ALREADY_ATTEMPTED');
      missionAssert(Date.parse(plan.quote.expiresAt) > Date.now(), 'MISSION_QUOTE_EXPIRED');
      missionAssert(!signal.aborted, 'MISSION_CANCELLED_BEFORE_SUBMIT');
      if (driver.revalidate) {
        try { await driver.revalidate(plan, signal); }
        catch (error) {
          const code = error instanceof Error && /^MISSION_[A-Z_]+$/.test(error.message) ? error.message : 'MISSION_FRESHNESS_UNVERIFIED';
          event(journal, 'BLOCKED', code, 'Current model, canvas or quote evidence did not match the approved plan. No generation submitted; prepare and confirm a fresh plan.');
          await save(file, journal); return journal;
        }
      }
      validateApproval(plan, approval, driver);
      missionAssert(Date.parse(plan.quote.expiresAt) > Date.now() && !signal.aborted, 'MISSION_QUOTE_EXPIRED');
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
      const state = await advancePanquMissionEvidence({ journal, plan, approval, driver, signal,
        persist: async (state, code, detail) => { event(journal, state, code, detail); await save(file, journal); } });
      if (!['POLLING', 'SETTLING'].includes(state)) return journal;
      if (attempt + 1 < maxPolls && interval) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, interval); signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish();
      });
    }
    event(journal, journal.state === 'SETTLING' ? 'SETTLING' : 'POLLING', 'OBSERVATION_WINDOW_ENDED', 'Resume the missing evidence stage in the next bounded cycle without repeating submission.'); await save(file, journal); return journal;
  });
}

/** Evidence summary is usable without an LLM, including recovery instructions and exact cost uncertainty. */
export function renderPanquMission(journal: PanquMissionJournal): string {
  const legacyTerminal = ['PASSED', 'FAILED'].includes(journal.state) && !journal.evidence;
  return [`# Panqu Mission ${journal.planHash.slice(0, 12)}`, '', `State: ${legacyTerminal ? 'BLOCKED' : journal.state}`, `Next action: ${legacyTerminal ? 'RESOLVE_BLOCKER' : journal.nextAction}`,
    ...(legacyTerminal ? [`Historical state: ${journal.state}; final settlement was not verified under the current evidence policy.`] : []),
    `Submission attempts: ${journal.submissionAttempts}`, `Reserved credits: ${journal.reservedMilliCredits / 1000}`,
    `Observed debit: ${journal.chargedMilliCredits === undefined ? 'UNKNOWN' : journal.chargedMilliCredits / 1000}`, '',
    `Generation fact: ${journal.evidence?.task?.state ?? 'UNKNOWN'}`,
    `Media fact: ${journal.evidence?.media.state ?? 'UNVERIFIED'}`,
    `Settlement fact: ${journal.evidence?.settlement.state ?? 'UNVERIFIED'}`,
    `Observed refund: ${journal.evidence?.settlement.refundedMilliCredits === undefined ? 'UNKNOWN' : journal.evidence.settlement.refundedMilliCredits / 1000}`,
    `Known failures: ${journal.evidence?.failures.join(', ') || 'NONE_OBSERVED'}`,
    `Evidence action: ${journal.evidence?.next.action ?? 'REVIEW_LEGACY_SCOPE'}`,
    `Missing evidence: ${journal.evidence?.next.missing.join(', ') ?? 'LEGACY_FINALITY_UNVERIFIED'}`, '',
    '| Step | State | Evidence |', '| --- | --- | --- |', ...journal.events.map(item => `| ${item.sequence} | ${item.state} | ${item.code}: ${item.detail} |`), ''].join('\n');
}
