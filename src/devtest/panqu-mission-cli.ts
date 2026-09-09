import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { compilePanquMission, missionAssert, verifyMissionPlan } from './panqu-mission-plan.js';
import { inventoryMissionMedia, prepareMissionReferenceClip, type PanquReferenceClipSpec } from './panqu-mission-media.js';
import { PanquHttpMissionDriver, type PanquHttpMissionConfig } from './panqu-mission-driver.js';
import { renderPanquMission, runPanquMission } from './panqu-mission-runtime.js';
import { artifactSafe } from './artifacts.js';
import type { PanquMissionApproval, PanquMissionCatalog, PanquMissionPlan, PanquMissionSpec, PanquMissionJournal } from './panqu-mission-types.js';

/** CLI-only operator entry; the existing MCP remains read-only and cannot mint billable approvals. */
export async function runPanquMissionCommand(argv: string[], root = process.cwd()): Promise<number> {
  const command = argv[0];
  missionAssert(['plan', 'run', 'resume', 'status', 'materials', 'prepare-media'].includes(command), 'MISSION_COMMAND_INVALID');
  const allowed: Record<string, string[]> = {
    plan: ['spec', 'catalog', 'output'], run: ['plan', 'config', 'approval', 'output'], resume: ['plan', 'config', 'approval', 'output'],
    materials: ['folder', 'ffprobe', 'ffmpeg'], status: ['plan', 'output'],
    'prepare-media': ['folder', 'spec', 'ffprobe', 'ffmpeg'],
  };
  const flags = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index].replace(/^--/, ''); const value = argv[index + 1];
    missionAssert(argv[index].startsWith('--') && allowed[command].includes(name) && value && !value.startsWith('--') && !flags.has(name), 'MISSION_ARGUMENT_INVALID');
    flags.set(name, value);
  }
  const required = (name: string): string => { const value = flags.get(name); missionAssert(value, `MISSION_${name.toUpperCase()}_REQUIRED`); return value; };
  async function json<T>(name: string): Promise<T> {
    const file = path.resolve(root, required(name)); const info = await lstat(file);
    missionAssert(!info.isSymbolicLink() && info.isFile() && info.size <= 2 * 1024 * 1024, 'MISSION_INPUT_FILE_INVALID');
    return JSON.parse(await readFile(file, 'utf8')) as T;
  }
  if (command === 'materials') {
    console.log(JSON.stringify(artifactSafe(await inventoryMissionMedia(path.resolve(root, required('folder')), { ffprobe: required('ffprobe'), ffmpeg: required('ffmpeg') })), null, 2));
    return 0;
  }
  if (command === 'prepare-media') {
    const result = await prepareMissionReferenceClip(path.resolve(root, required('folder')), await json<PanquReferenceClipSpec>('spec'),
      { ffprobe: required('ffprobe'), ffmpeg: required('ffmpeg') });
    console.log(JSON.stringify(artifactSafe({ ...result, directory: path.basename(result.directory), directory_base: 'SUPPLIED_FOLDER' }), null, 2)); return 0;
  }
  const output = path.resolve(root, required('output'));
  for (let part = output; ; part = path.dirname(part)) {
    try { missionAssert(!(await lstat(part)).isSymbolicLink(), 'MISSION_OUTPUT_SYMLINK'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (path.dirname(part) === part) break;
  }
  if (command === 'plan') {
    const plan = compilePanquMission(await json<PanquMissionSpec>('spec'), await json<PanquMissionCatalog>('catalog'));
    await mkdir(output, { recursive: true, mode: 0o700 });
    const file = path.join(output, `${plan.hash}.plan.json`); const content = JSON.stringify(plan, null, 2);
    try { await writeFile(file, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      missionAssert(!(await lstat(file)).isSymbolicLink() && await readFile(file, 'utf8') === content, 'MISSION_PLAN_FILE_CONFLICT');
    }
    console.log(JSON.stringify(artifactSafe({ state: 'PLANNED', plan_hash: plan.hash, plan_file: path.basename(file), plan_file_base: 'SUPPLIED_OUTPUT_DIRECTORY',
      profile: plan.profile, requirement: plan.requirement, parameters: plan.variant.parameters,
      reserved_credits: plan.variant.maxMilliCredits / 1000, budget_credits: plan.maxMilliCredits / 1000,
      decisions: plan.decisions, next_action: 'OPERATOR_CONFIRM_EXACT_PLAN_AND_BUDGET', scope: 'Generation smoke: media structure and task-bound debit; not full UI or semantic quality acceptance.' }), null, 2));
    return 0;
  }
  const plan = await json<PanquMissionPlan>('plan'); verifyMissionPlan(plan);
  if (command === 'status') {
    const file = path.join(output, `${plan.hash}.json`);
    const info = await lstat(file); missionAssert(!info.isSymbolicLink() && info.size < 2 * 1024 * 1024, 'MISSION_JOURNAL_FILE_INVALID');
    const journal = JSON.parse(await readFile(file, 'utf8')) as PanquMissionJournal;
    missionAssert(journal.schema === 'panqu.mission-journal.v1' && journal.planHash === plan.hash && Array.isArray(journal.events), 'MISSION_JOURNAL_BINDING_INVALID');
    console.log(renderPanquMission(journal)); return 0;
  }
  const approval = await json<PanquMissionApproval>('approval');
  const config = await json<Omit<PanquHttpMissionConfig, 'origin' | 'headers' | 'projectRoot'> & { originEnv: string; headersEnv: string; maxCycles?: number }>('config');
  missionAssert(/^[A-Z][A-Z0-9_]*$/.test(config.originEnv) && /^[A-Z][A-Z0-9_]*$/.test(config.headersEnv)
    && !Object.hasOwn(config, 'headers') && !Object.hasOwn(config, 'origin'), 'MISSION_CREDENTIAL_ENV_REFERENCES_REQUIRED');
  const origin = process.env[config.originEnv]; missionAssert(origin, 'MISSION_ORIGIN_ENV_MISSING');
  const headers = JSON.parse(process.env[config.headersEnv] || '{}') as Record<string, string>;
  missionAssert(headers && typeof headers === 'object' && !Array.isArray(headers) && Object.values(headers).every(value => typeof value === 'string'), 'MISSION_HEADERS_ENV_INVALID');
  const cycles = config.maxCycles ?? 1;
  missionAssert(Number.isSafeInteger(cycles) && cycles > 0 && cycles <= 20, 'MISSION_CYCLE_LIMIT_INVALID');
  const driver = new PanquHttpMissionDriver({ ...config, origin, headers, projectRoot: root });
  for (let cycle = 0; cycle < cycles; cycle++) {
    const journal = await runPanquMission({ plan, approval, driver, journalDirectory: output, recoverDeadLock: command === 'resume' });
    console.log(renderPanquMission(journal));
    if (journal.state !== 'POLLING') return journal.state === 'PASSED' ? 0 : journal.state === 'FAILED' ? 1 : 3;
  }
  return 3;
}
