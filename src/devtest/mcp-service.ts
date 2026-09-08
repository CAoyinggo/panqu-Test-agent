import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AcceptanceExecutionPlanIdentity } from '../acceptance/acceptance-execution-plan.js';
import { artifactSafe } from './artifacts.js';
import { doctorDevTestProject, loadDevTestConfig, type DevTestProjectConfig } from './cli-config.js';
import { runDevTest } from './devtest-runner.js';
import { loadDevTestRuntime } from './runtime-loader.js';
import type { DevTestRunResult } from './types.js';
import { devTestNextAction } from './interaction-guidance.js';

const execFileAsync = promisify(execFile);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const EXECUTION_POLICY = 'NO_SILENT_REQUIREMENT_GAPS_V1';

/** MCP is a control surface. Case schemas and execution semantics remain in TEST_CASE_V2. */
export const DEVTEST_MCP_TOOL = {
  name: 'devtest',
  description: 'Use the installed DevTest kernel to inspect readiness, generate a requirement-derived TEST_CASE_V2 plan, execute a confirmed plan, or read its evidence-backed result. Never accepts model-authored cases or credentials.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['doctor', 'plan', 'execute', 'status'] },
      requirement: { type: 'string', description: 'Repository-relative Markdown or text requirement file; required for plan.' },
      plan_id: { type: 'string' },
      expected_plan_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      idempotency_key: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
    },
    required: ['action'],
    allOf: [
      { if: { properties: { action: { const: 'plan' } } }, then: { required: ['requirement'] } },
      { if: { properties: { action: { const: 'execute' } } }, then: { required: ['plan_id', 'expected_plan_hash', 'idempotency_key'] } },
      { if: { properties: { action: { const: 'status' } } }, then: { required: ['plan_id'] } },
    ],
  },
};

interface PlanRecord {
  executionPolicy: string;
  planId: string;
  requirement: string;
  sourceDigest: string;
  configDigest: string;
  contextDigest: string;
  targetDigest: string;
  executionPlan: AcceptanceExecutionPlanIdentity;
  planHash: string;
  preview: Record<string, unknown>;
}

interface RunRecord {
  state: 'RUNNING' | 'COMPLETED' | 'BLOCKED';
  idempotencyKey: string;
  result?: Record<string, unknown>;
}

function planHash(record: Omit<PlanRecord, 'planHash' | 'preview'>): string {
  return digest(JSON.stringify(record));
}

function token(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`INVALID_INPUT: ${name}`);
  return value;
}

function validateInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT: expected an object');
  const input = value as Record<string, unknown>;
  const keys: Record<string, string[]> = {
    doctor: ['action'], plan: ['action', 'requirement'],
    execute: ['action', 'plan_id', 'expected_plan_hash', 'idempotency_key'], status: ['action', 'plan_id'],
  };
  const allowed = typeof input.action === 'string' ? keys[input.action] : undefined;
  if (!allowed || Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('INVALID_INPUT: unknown action or field');
  if (input.action === 'execute' || input.action === 'status') token(input.plan_id, 'plan_id');
  if (input.action === 'execute') {
    token(input.idempotency_key, 'idempotency_key');
    if (typeof input.expected_plan_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_plan_hash)) throw new Error('INVALID_INPUT: expected_plan_hash');
  }
  return input;
}

/** Resolve symlinks, including in the parent of a not-yet-created output directory. */
async function within(root: string, relative: string, mustExist = true): Promise<string> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('PATH_OUTSIDE_PROJECT');
  const candidate = path.resolve(root, relative);
  let resolved: string;
  try { resolved = await realpath(candidate); }
  catch (error) {
    if (mustExist || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(relative);
    resolved = path.join(parent === '.' ? root : await within(root, parent, false), path.basename(relative));
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('PATH_OUTSIDE_PROJECT');
  return resolved;
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

function summary(result: DevTestRunResult, root: string): Record<string, unknown> {
  return artifactSafe({
    run_id: result.runId, conclusion: result.conclusion,
    counts: result.deliveryCoverage.cases,
    evidence: result.deliveryCoverage.evidence,
    oracle: result.oracleResults,
    plan: result.plan,
    execution_estimate: result.executionEstimate,
    selected_case_ids: result.executionPlan.selectedCaseIds,
    requirement_coverage: result.requirementCoverage,
    requirement_assurance: result.requirementAssurance,
    unknown_fact_ids: result.requirementModel.unknownFactIds,
    unknowns: result.requirementModel.facts.filter((fact) => result.requirementModel.unknownFactIds.includes(fact.id))
      .map(({ id, statement, status, source }) => ({ id, statement, status, source })),
    problems: result.problems,
    readiness: result.environmentPreflight.status,
    readiness_detail: { target_selected: result.environmentPreflight.checks.baseUrl === 'READY',
      reason: result.environmentPreflight.reason },
    dimensions: result.dimensionApplicability,
    business_flows: result.businessFlowGraph,
    data_lifecycle: result.dataLifecycle,
    paths: Object.fromEntries(Object.entries(result.artifacts).filter(([, value]) => typeof value === 'string')
      .map(([name, value]) => [name, path.relative(root, value as string)])),
  }) as Record<string, unknown>;
}

/** All actions share the same local project and operator configuration. No shell input from the agent. */
export class DevTestMcpService {
  constructor(private readonly projectRoot: string) {}

  private async targetDigest(root: string, config: DevTestProjectConfig): Promise<string> {
    const moduleRef = process.env[config.runtime.runtimeModuleEnv] || '';
    // Bind operator-selected targets and runtime code without persisting URLs or credentials.
    const moduleDigest = moduleRef ? digest(await readFile(await within(root, moduleRef), 'utf8')) : '';
    return digest(JSON.stringify({
      baseUrl: process.env[config.runtime.baseUrlEnv] || '',
      fallbackBaseUrls: [process.env.TESTFLOW_BASE_URL || '', process.env.TEST_BASE_URL || ''],
      moduleRef, moduleDigest,
    }));
  }

  private async contextDigest(root: string, config: DevTestProjectConfig): Promise<string> {
    // Include tracked and untracked source content; output, dependencies and secrets are never read.
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 10_000,
    });
    const records: string[] = [];
    for (const file of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
      if (file.startsWith(`${config.runtime.output}/`) || /(?:^|\/)(?:node_modules|dist|\.git|\.env[^/]*|devtest-results)(?:\/|$)/.test(file)) continue;
      if (!/\.(?:[cm]?[jt]sx?|md|txt|json|ya?ml|prisma|graphql)$/.test(file)) continue;
      try { records.push(`${file}:${digest(await readFile(await within(root, file), 'utf8'))}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') records.push(`${file}:deleted`); else throw error; }
    }
    return digest(records.join('\n'));
  }

  async call(value: unknown): Promise<Record<string, unknown>> {
    try {
      const input = validateInput(value);
      const result = await this.dispatch(input);
      return { ...result, next_action: devTestNextAction(result, input) };
    }
    catch (error) {
      const result = artifactSafe({ ok: false, status: 'BLOCKED', message: (error as Error).message }) as Record<string, unknown>;
      const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      return { ...result, next_action: devTestNextAction(result, input) };
    }
  }

  private async dispatch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const root = await realpath(this.projectRoot);
    const config = await loadDevTestConfig(root);
    if (input.action === 'doctor') {
      const result = await doctorDevTestProject({ root, config });
      return { ok: result.status === 'READY', ...result };
    }
    const output = await within(root, config.runtime.output, false);
    const storage = await within(root, path.relative(root, path.join(output, '.mcp')), false);
    await mkdir(storage, { recursive: true, mode: 0o700 });

    // Serialize plans/runs across processes to protect shared test state and baselines.
    const lockFile = path.join(storage, 'execution.lock');
    if (input.action === 'status') {
      const planId = token(input.plan_id, 'plan_id');
      const record = JSON.parse(await readFile(await within(root, path.relative(root, path.join(storage, `${planId}.json`))), 'utf8')) as PlanRecord;
      try {
        const run = JSON.parse(await readFile(await within(root, path.relative(root, path.join(storage, `${planId}.run.json`))), 'utf8')) as RunRecord;
        return { ok: run.state === 'COMPLETED', plan_id: planId, status: run.state, ...run.result };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return { ok: true, plan_id: planId, plan_hash: record.planHash, status: 'NOT_EXECUTED', ...record.preview };
      }
    }
    let lock;
    try { lock = await open(lockFile, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('RUN_IN_PROGRESS: project is locked; query status before retrying');
      throw error;
    }
    try {
      if (input.action === 'plan') {
        if (typeof input.requirement !== 'string' || !/\.(?:md|txt)$/i.test(input.requirement)) throw new Error('INVALID_INPUT: repository-relative requirement file is required');
        const file = await within(root, input.requirement);
        const markdown = await readFile(file, 'utf8');
        const contextDigest = await this.contextDigest(root, config);
        const targetDigest = await this.targetDigest(root, config);
        const result = await runDevTest({ markdown, documentId: input.requirement, projectRoot: root,
          project: path.basename(root), environment: config.runtime.environment,
          baseUrl: process.env[config.runtime.baseUrlEnv] || undefined, mode: 'SAFE', plan: true, outDir: output });
        const unsigned = {
          executionPolicy: EXECUTION_POLICY,
          planId: `PLAN-${randomUUID()}`, requirement: input.requirement, sourceDigest: digest(markdown),
          configDigest: digest(JSON.stringify(config)), contextDigest, targetDigest, executionPlan: result.executionPlan,
        };
        const record: PlanRecord = { ...unsigned, planHash: planHash(unsigned), preview: summary(result, root) };
        await atomicJson(path.join(storage, `${record.planId}.json`), record);
        return { ok: true, status: 'NOT_EXECUTED', plan_id: record.planId, plan_hash: record.planHash, ...record.preview };
      }

      const planId = token(input.plan_id, 'plan_id');
      const idempotencyKey = token(input.idempotency_key, 'idempotency_key');
      const record = JSON.parse(await readFile(await within(root, path.relative(root, path.join(storage, `${planId}.json`))), 'utf8')) as PlanRecord;
      const { preview: _preview, planHash: expectedHash, ...unsigned } = record;
      if (record.executionPolicy !== EXECUTION_POLICY) throw new Error('STALE_PLAN: execution policy changed; create a new plan');
      if (planHash(unsigned) !== expectedHash || expectedHash !== input.expected_plan_hash || record.planId !== planId) throw new Error('STALE_PLAN: confirmation does not match the saved plan');
      const runFile = await within(root, path.relative(root, path.join(storage, `${planId}.run.json`)), false);
      let previous: RunRecord | undefined;
      try { previous = JSON.parse(await readFile(runFile, 'utf8')) as RunRecord; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (previous) {
        if (previous.idempotencyKey !== idempotencyKey) throw new Error('PLAN_ALREADY_EXECUTED: create a new plan for a new execution');
        return { ok: previous.state === 'COMPLETED', status: previous.state, plan_id: planId, replayed: true, ...previous.result };
      }
      const markdown = await readFile(await within(root, record.requirement), 'utf8');
      if (digest(markdown) !== record.sourceDigest || digest(JSON.stringify(config)) !== record.configDigest
        || await this.contextDigest(root, config) !== record.contextDigest
        || await this.targetDigest(root, config) !== record.targetDigest) throw new Error('STALE_PLAN: requirement, config, project source or runtime target changed; create a new plan');
      // The first implementation exposes read-only local execution. Business writes remain in the approved CI path.
      await atomicJson(runFile, { state: 'RUNNING', idempotencyKey });
      try {
        const runtime = await loadDevTestRuntime({ root, environment: config.runtime.environment,
          moduleRef: process.env[config.runtime.runtimeModuleEnv] });
        const headersRaw = process.env[config.runtime.actorHeadersEnv];
        const headers = headersRaw ? JSON.parse(headersRaw) as Record<string, Record<string, string>> : {};
        const result = await runDevTest({ ...runtime, actorHeaders: { ...headers, ...runtime.actorHeaders },
          markdown, documentId: record.requirement, projectRoot: root, project: path.basename(root),
          baseUrl: process.env[config.runtime.baseUrlEnv] || undefined, environment: config.runtime.environment,
          mode: 'SAFE', confirmMutations: false, sandbox: false, expectedExecutionPlan: record.executionPlan,
          outDir: output, maxRuntimeMs: 15 * 60 * 1000 });
        const outcome = { ...summary(result, root), status: result.conclusion === 'BLOCKED' ? 'BLOCKED' : 'COMPLETED' };
        await atomicJson(runFile, { state: 'COMPLETED', idempotencyKey, result: outcome });
        return { ok: true, plan_id: planId, ...outcome };
      } catch (error) {
        const outcome = artifactSafe({ status: 'BLOCKED', message: (error as Error).message }) as Record<string, unknown>;
        await atomicJson(runFile, { state: 'BLOCKED', idempotencyKey, result: outcome });
        return { ok: false, plan_id: planId, ...outcome };
      }
    } finally {
      await lock.close();
      await rm(lockFile);
    }
  }
}
