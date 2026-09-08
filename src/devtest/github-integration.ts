import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { redactSensitiveText } from '../core/redact.js';
import { gitChangedFiles, type DevTestProjectConfig } from './cli-config.js';
import type { DevTestRunResult } from './types.js';

export interface DevTestGitHubContext {
  eventName: string;
  repository: string;
  sha: string;
  baseSha?: string;
  pullRequestNumber?: number;
  fork: boolean;
  runId?: string;
}

export interface DevTestGitHubInputs {
  eventName: string;
  baseSha?: string;
  headSha: string;
  diffRange?: string;
  pullRequestNumber?: number;
  fork: boolean;
  changedFiles: string[];
  requirementFiles: string[];
  openApiFiles: string[];
  routeFiles: string[];
  schemaFiles: string[];
  testCapabilities: Array<{ name: string; available: boolean; source: string }>;
}

type GitHubEvent = {
  pull_request?: {
    number?: number;
    base?: { sha?: string };
    head?: { sha?: string; repo?: { full_name?: string; fork?: boolean } };
  };
  number?: number;
};

async function readEvent(): Promise<GitHubEvent> {
  if (!process.env.GITHUB_EVENT_PATH) return {};
  try { return JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) as GitHubEvent; }
  catch (error) { throw new Error(`GITHUB_EVENT_INVALID：${(error as Error).message}`); }
}

export async function readDevTestGitHubContext(): Promise<DevTestGitHubContext> {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!repository || !sha || !eventName) throw new Error('GITHUB_CONTEXT_MISSING：缺少 GITHUB_REPOSITORY/GITHUB_SHA/GITHUB_EVENT_NAME');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error('GITHUB_CONTEXT_INVALID：GITHUB_REPOSITORY 格式非法');
  const event = await readEvent();
  const headRepository = event.pull_request?.head?.repo?.full_name;
  return {
    eventName,
    repository,
    sha: event.pull_request?.head?.sha ?? sha,
    baseSha: event.pull_request?.base?.sha,
    pullRequestNumber: event.pull_request?.number ?? event.number,
    fork: Boolean(event.pull_request && (event.pull_request.head?.repo?.fork === true
      || headRepository && headRepository !== repository)),
    runId: process.env.GITHUB_RUN_ID,
  };
}

function matchesRequirement(file: string, config: DevTestProjectConfig): boolean {
  const normalized = file.toLowerCase();
  return normalized.endsWith('.md') && (normalized.includes('requirement')
    || config.requirements.include.some((pattern) => {
      const prefix = pattern.split('*')[0].replace(/\/$/, '').toLowerCase();
      return Boolean(prefix && normalized.startsWith(prefix));
    }));
}

async function packageCapabilities(root: string): Promise<DevTestGitHubInputs['testCapabilities']> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    return [
      { name: 'build', available: Boolean(scripts.build), source: 'package.json#scripts.build' },
      { name: 'test', available: Boolean(scripts.test), source: 'package.json#scripts.test' },
      { name: 'acceptance', available: Boolean(scripts.acceptance || scripts['acceptance:test']), source: 'package.json#scripts' },
      { name: 'devtest', available: Boolean(scripts.devtest || scripts['devtest:test']), source: 'package.json#scripts' },
    ];
  } catch {
    return [{ name: 'package-scripts', available: false, source: 'package.json unavailable' }];
  }
}

export async function collectDevTestGitHubInputs(input: {
  root?: string;
  context: DevTestGitHubContext;
  config: DevTestProjectConfig;
}): Promise<DevTestGitHubInputs> {
  const root = path.resolve(input.root ?? process.cwd());
  const changedFiles = await gitChangedFiles(root, input.context.baseSha, input.context.sha);
  const classify = (pattern: RegExp): string[] => changedFiles.filter((file) => pattern.test(file));
  return {
    eventName: input.context.eventName,
    baseSha: input.context.baseSha,
    headSha: input.context.sha,
    diffRange: input.context.baseSha ? `${input.context.baseSha}...${input.context.sha}` : undefined,
    pullRequestNumber: input.context.pullRequestNumber,
    fork: input.context.fork,
    changedFiles,
    requirementFiles: changedFiles.filter((file) => matchesRequirement(file, input.config)),
    openApiFiles: classify(/(?:openapi|swagger).*(?:ya?ml|json)$|\.(?:openapi|swagger)\.(?:ya?ml|json)$/i),
    routeFiles: classify(/(?:^|\/)(?:routes?|routers?|controllers?)(?:\/|\.|-)|\.(?:route|router|controller)\.[cm]?[jt]sx?$/i),
    schemaFiles: classify(/(?:^|\/)(?:schemas?|models?)(?:\/|\.|-)|\.(?:schema|model)\.[cm]?[jt]sx?$|\.(?:prisma|graphql)$/i),
    testCapabilities: await packageCapabilities(root),
  };
}

export function githubBusinessWritePolicy(input: {
  context: DevTestGitHubContext;
  config: DevTestProjectConfig;
}): { allowed: boolean; sandbox: boolean; reason: string } {
  const requested = /^(?:1|true|yes)$/i.test(process.env[input.config.runtime.allowWritesEnv] ?? '');
  const environmentKind = (process.env.DEVTEST_ENVIRONMENT_KIND ?? '').toLowerCase();
  const safeEnvironment = environmentKind === 'test' || environmentKind === 'sandbox';
  const sandbox = environmentKind === 'sandbox'
    && /^(?:1|true|yes)$/i.test(process.env[input.config.runtime.sandboxEnv] ?? '');
  if (input.context.fork) return { allowed: false, sandbox: false, reason: 'FORK_PR_WRITE_BLOCKED' };
  if (!requested) return { allowed: false, sandbox, reason: 'WRITE_NOT_EXPLICITLY_ENABLED' };
  if (!safeEnvironment) return { allowed: false, sandbox: false, reason: 'TEST_OR_SANDBOX_ENVIRONMENT_REQUIRED' };
  return { allowed: true, sandbox, reason: 'EXPLICIT_TEST_WRITE_ENABLED' };
}

function safeText(value: string): string {
  return redactSensitiveText(value)
    .replace(/https?:\/\/[^\s)\]}>,]+/gi, '[ENV:DEVTEST_BASE_URL]')
    .replace(/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s)\]}>,]+/gi, '[ENV:DATABASE_URL]');
}

function evidenceCount(result: DevTestRunResult, channels: readonly string[]): { required: number; collected: number; verified: number } {
  const traces = result.acceptanceTraces.filter((trace) => trace.evidence.required.some((channel) => channels.includes(channel)));
  return {
    required: traces.length,
    collected: traces.filter((trace) => trace.evidence.collected.some((channel) => channels.includes(channel))).length,
    verified: traces.filter((trace) => (trace.result === 'PASS' || trace.result === 'FAIL')
      && trace.evidence.collected.some((channel) => channels.includes(channel))).length,
  };
}

export function renderGitHubDevTestSummary(result: DevTestRunResult, marker = '<!-- devtest-report -->'): string {
  const response = evidenceCount(result, ['API_RESPONSE']);
  const state = evidenceCount(result, ['DATABASE_STATE', 'RESOURCE_STATE', 'STATE_CHANGE', 'DATA_DIFF']);
  const sideEffect = evidenceCount(result, ['EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD', 'LOG']);
  const nonMutation = result.invariants.filter((item) => item.kind === 'NON_MUTATION');
  const lifecycle = result.dataLifecycle;
  const lines = [
    marker,
    '## DevTest',
    '',
    `**${result.conclusion}** · Run \`${result.runId}\``,
    '',
    '| Delivery stage | Count |',
    '| --- | ---: |',
    `| GENERATED | ${result.deliveryCoverage.cases.generated} |`,
    `| EXECUTABLE | ${result.deliveryCoverage.cases.executable} |`,
    `| EXECUTED | ${result.deliveryCoverage.cases.executed} |`,
    `| VERIFIED | ${result.deliveryCoverage.cases.verified} |`,
    '',
    '| Evidence | Required | Collected | Verified |',
    '| --- | ---: | ---: | ---: |',
    `| Response | ${response.required} | ${response.collected} | ${response.verified} |`,
    `| State / DB | ${state.required} | ${state.collected} | ${state.verified} |`,
    `| Non-Mutation | ${nonMutation.length} | ${nonMutation.filter((item) => item.status !== 'DESIGNED').length} | ${nonMutation.filter((item) => item.status === 'VERIFIED').length} |`,
    `| Side Effect / Log / Queue | ${sideEffect.required} | ${sideEffect.collected} | ${sideEffect.verified} |`,
    '',
    `Oracle: PASS ${result.oracleResults.filter((item) => item.verdict === 'PASS').length} · FAIL ${result.oracleResults.filter((item) => item.verdict === 'FAIL').length} · BLOCKED/UNKNOWN ${result.oracleResults.filter((item) => item.verdict === 'BLOCKED' || item.verdict === 'UNKNOWN').length}`,
    '',
    `Cleanup: ${lifecycle.cleanupStatus} · Evidence coverage: ${result.deliveryCoverage.evidence.coverage}%`,
    '',
    `Cases: PASS ${result.deliveryCoverage.cases.passed} · FAIL ${result.deliveryCoverage.cases.failed} · BLOCKED ${result.deliveryCoverage.cases.blocked} · NOT_EXECUTED ${result.deliveryCoverage.cases.notTested}`,
  ];
  return safeText(lines.join('\n'));
}

interface GitHubCheckRun {
  id: number;
  external_id?: string;
}

interface GitHubComment {
  id: number;
  body?: string;
}

export class DevTestGitHubClient {
  readonly #token: string;
  readonly #repository: string;
  readonly #apiBase: string;
  readonly #fetch: typeof fetch;

  constructor(input: { token: string; repository: string; apiBase?: string; fetchImpl?: typeof fetch }) {
    this.#token = input.token;
    this.#repository = input.repository;
    this.#apiBase = (input.apiBase ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async #request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(`${this.#apiBase}${pathname}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.#token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`GITHUB_API_FAILED：${init.method ?? 'GET'} ${pathname} -> ${response.status}`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  async upsertCheck(input: {
    sha: string;
    name: string;
    externalId: string;
    conclusion: 'success' | 'failure' | 'neutral';
    summary: string;
  }): Promise<{ id: number; created: boolean }> {
    const encodedName = encodeURIComponent(input.name);
    const listed = await this.#request<{ check_runs: GitHubCheckRun[] }>(
      `/repos/${this.#repository}/commits/${input.sha}/check-runs?check_name=${encodedName}`,
    );
    const existing = listed.check_runs.find((item) => item.external_id === input.externalId);
    const body = JSON.stringify({
      name: input.name,
      head_sha: input.sha,
      external_id: input.externalId,
      status: 'completed',
      conclusion: input.conclusion,
      completed_at: new Date().toISOString(),
      output: { title: `DevTest ${input.conclusion.toUpperCase()}`, summary: input.summary.slice(0, 65_000) },
    });
    if (existing) {
      const updated = await this.#request<GitHubCheckRun>(`/repos/${this.#repository}/check-runs/${existing.id}`, { method: 'PATCH', body });
      return { id: updated.id, created: false };
    }
    const created = await this.#request<GitHubCheckRun>(`/repos/${this.#repository}/check-runs`, { method: 'POST', body });
    return { id: created.id, created: true };
  }

  async upsertPullRequestComment(input: { pullRequestNumber: number; marker: string; body: string }): Promise<{ id: number; created: boolean }> {
    const comments = await this.#request<GitHubComment[]>(`/repos/${this.#repository}/issues/${input.pullRequestNumber}/comments?per_page=100`);
    const existing = comments.find((comment) => comment.body?.includes(input.marker));
    const body = JSON.stringify({ body: input.body });
    if (existing) {
      const updated = await this.#request<GitHubComment>(`/repos/${this.#repository}/issues/comments/${existing.id}`, { method: 'PATCH', body });
      return { id: updated.id, created: false };
    }
    const created = await this.#request<GitHubComment>(`/repos/${this.#repository}/issues/${input.pullRequestNumber}/comments`, { method: 'POST', body });
    return { id: created.id, created: true };
  }
}

export async function publishDevTestToGitHub(input: {
  context: DevTestGitHubContext;
  config: DevTestProjectConfig;
  result: DevTestRunResult;
  fetchImpl?: typeof fetch;
}): Promise<{ skipped?: string; check?: { id: number; created: boolean }; comment?: { id: number; created: boolean } }> {
  if (input.context.fork) return { skipped: 'FORK_PR_GITHUB_WRITE_SKIPPED' };
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN_MISSING：无法回写 Check Run/PR 评论');
  const client = new DevTestGitHubClient({ token, repository: input.context.repository, fetchImpl: input.fetchImpl });
  const summary = renderGitHubDevTestSummary(input.result, input.config.github.commentMarker);
  const externalId = `devtest:${input.context.repository}:${input.context.sha}`;
  const conclusion = input.result.conclusion === 'READY' ? 'success'
    : input.result.conclusion === 'NOT_READY' ? 'failure' : 'neutral';
  const check = await client.upsertCheck({ sha: input.context.sha, name: input.config.github.checkName, externalId, conclusion, summary });
  const comment = input.context.pullRequestNumber
    ? await client.upsertPullRequestComment({ pullRequestNumber: input.context.pullRequestNumber,
      marker: input.config.github.commentMarker, body: summary })
    : undefined;
  return { check, comment };
}

export async function writeGitHubInputsArtifact(directory: string, inputs: DevTestGitHubInputs): Promise<string> {
  const file = path.join(directory, 'github-context.json');
  await writeFile(file, `${JSON.stringify(inputs, null, 2)}\n`, 'utf8');
  return file;
}
