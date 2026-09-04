import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEVTEST_CONFIG_FILE = '.devtest.json';
export const DEVTEST_WORKFLOW_FILE = path.join('.github', 'workflows', 'devtest.yml');

export interface DevTestProjectConfig {
  version: 1;
  requirements: { include: string[] };
  runtime: {
    environment: 'test' | 'sandbox';
    output: string;
    baseUrlEnv: string;
    actorHeadersEnv: string;
    runtimeModuleEnv: string;
    allowWritesEnv: string;
    sandboxEnv: string;
    approvalEnv: string;
  };
  github: {
    checkName: string;
    commentMarker: string;
    requirementFileEnv: string;
  };
}

export const DEFAULT_DEVTEST_CONFIG: DevTestProjectConfig = {
  version: 1,
  requirements: {
    include: ['requirements/**/*.md', 'docs/requirements/**/*.md', 'requirement*.md'],
  },
  runtime: {
    environment: 'test',
    output: 'devtest-results',
    baseUrlEnv: 'DEVTEST_BASE_URL',
    actorHeadersEnv: 'DEVTEST_ACTOR_HEADERS_JSON',
    runtimeModuleEnv: 'DEVTEST_RUNTIME_MODULE',
    allowWritesEnv: 'DEVTEST_ALLOW_WRITES',
    sandboxEnv: 'DEVTEST_SANDBOX',
    approvalEnv: 'DEVTEST_APPROVAL_ID',
  },
  github: {
    checkName: 'DevTest',
    commentMarker: '<!-- devtest-report -->',
    requirementFileEnv: 'DEVTEST_REQUIREMENT_FILE',
  },
};

export const DEVTEST_GITHUB_WORKFLOW = `name: DevTest

on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      requirement:
        description: Requirement file relative to the repository root
        required: false
        type: string
      allow_writes:
        description: Allow business writes only in a declared test or sandbox environment
        required: false
        default: false
        type: boolean

permissions:
  contents: read
  checks: write
  pull-requests: write

defaults:
  run:
    shell: bash

jobs:
  devtest:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      DEVTEST_REQUIREMENT_FILE: \${{ inputs.requirement || '' }}
      DEVTEST_BASE_URL: \${{ secrets.DEVTEST_BASE_URL }}
      DEVTEST_ACTOR_HEADERS_JSON: \${{ secrets.DEVTEST_ACTOR_HEADERS_JSON }}
      DATABASE_URL: \${{ secrets.DEVTEST_DATABASE_URL }}
      DEVTEST_RUNTIME_MODULE: \${{ vars.DEVTEST_RUNTIME_MODULE }}
      DEVTEST_ENVIRONMENT_KIND: \${{ vars.DEVTEST_ENVIRONMENT_KIND }}
      DEVTEST_ALLOW_WRITES: \${{ github.event_name == 'workflow_dispatch' && inputs.allow_writes && (vars.DEVTEST_ENVIRONMENT_KIND == 'test' || vars.DEVTEST_ENVIRONMENT_KIND == 'sandbox') }}
      DEVTEST_SANDBOX: \${{ vars.DEVTEST_ENVIRONMENT_KIND == 'sandbox' }}
      DEVTEST_APPROVAL_ID: \${{ github.run_id }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - name: Install project dependencies
        run: |
          set -Eeuo pipefail
          npm ci
      - name: Runtime readiness
        run: |
          set -Eeuo pipefail
          npx --no-install devtest doctor --github
      - name: Generate, execute, verify, and report
        id: devtest
        continue-on-error: true
        # GitHub sends SIGTERM on cancellation. The CLI maps it to the existing
        # Runner AbortSignal so Scenario/lifecycle cleanup finally hooks run.
        run: |
          set -Eeuo pipefail
          npx --no-install devtest run --github
      - name: Upload report, cases, evidence, and problems
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: devtest-report-cases-evidence-problems
          path: devtest-results/
          if-no-files-found: error
          retention-days: 14
      - name: Enforce DevTest conclusion
        if: always()
        env:
          DEVTEST_STEP_OUTCOME: \${{ steps.devtest.outcome }}
        run: |
          set -Eeuo pipefail
          test "$DEVTEST_STEP_OUTCOME" = success
`;

function isEnvName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value);
}

function isRelativePortablePath(value: string): boolean {
  return !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export function validateDevTestConfig(value: unknown): DevTestProjectConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DEVTEST_CONFIG_INVALID：配置必须是对象');
  const input = value as Partial<DevTestProjectConfig>;
  if (input.version !== 1) throw new Error('DEVTEST_CONFIG_INVALID：仅支持 version=1');
  if (!input.requirements?.include?.length || input.requirements.include.some((item) => !isRelativePortablePath(item))) {
    throw new Error('DEVTEST_CONFIG_INVALID：Requirement include 只能使用仓库内相对路径');
  }
  if (!input.runtime || !['test', 'sandbox'].includes(input.runtime.environment)) {
    throw new Error('DEVTEST_CONFIG_INVALID：runtime.environment 仅支持 test/sandbox');
  }
  if (!isRelativePortablePath(input.runtime.output)) throw new Error('DEVTEST_CONFIG_INVALID：runtime.output 必须是仓库内相对路径');
  for (const key of ['baseUrlEnv', 'actorHeadersEnv', 'runtimeModuleEnv', 'allowWritesEnv', 'sandboxEnv', 'approvalEnv'] as const) {
    if (!isEnvName(input.runtime[key])) throw new Error(`DEVTEST_CONFIG_INVALID：runtime.${key} 必须是环境变量名`);
  }
  if (!input.github || !input.github.checkName?.trim() || !input.github.commentMarker?.trim()
    || !isEnvName(input.github.requirementFileEnv)) {
    throw new Error('DEVTEST_CONFIG_INVALID：GitHub 配置缺失或包含非法环境变量引用');
  }
  const serialized = JSON.stringify(input);
  if (/(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\//i.test(serialized)
    || /\/(?:Users|home)\/[^/"\\]+/i.test(serialized)) {
    throw new Error('DEVTEST_CONFIG_SECRET_LITERAL：URL、连接串和本机路径只能通过环境变量引用');
  }
  return input as DevTestProjectConfig;
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

export async function loadDevTestConfig(root = process.cwd(), required = true): Promise<DevTestProjectConfig> {
  const file = path.join(root, DEVTEST_CONFIG_FILE);
  if (!(await exists(file))) {
    if (required) throw new Error(`DEVTEST_CONFIG_MISSING：先运行 devtest init --github（缺少 ${DEVTEST_CONFIG_FILE}）`);
    return DEFAULT_DEVTEST_CONFIG;
  }
  try {
    return validateDevTestConfig(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if ((error as Error).message.startsWith('DEVTEST_CONFIG_')) throw error;
    throw new Error(`DEVTEST_CONFIG_INVALID：${(error as Error).message}`);
  }
}

export async function initializeDevTestProject(input: {
  root?: string;
  github: boolean;
  force?: boolean;
}): Promise<{ created: string[]; unchanged: string[] }> {
  const root = path.resolve(input.root ?? process.cwd());
  const targets: Array<{ relative: string; content: string }> = [{
    relative: DEVTEST_CONFIG_FILE,
    content: `${JSON.stringify(DEFAULT_DEVTEST_CONFIG, null, 2)}\n`,
  }];
  if (input.github) targets.push({ relative: DEVTEST_WORKFLOW_FILE, content: DEVTEST_GITHUB_WORKFLOW });
  const created: string[] = [];
  const unchanged: string[] = [];
  for (const target of targets) {
    const file = path.join(root, target.relative);
    await mkdir(path.dirname(file), { recursive: true });
    if (await exists(file)) {
      if (!input.force) { unchanged.push(target.relative); continue; }
    }
    await writeFile(file, target.content, 'utf8');
    created.push(target.relative);
  }
  return { created, unchanged };
}

function globPattern(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let source = '';
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') { source += '(?:.*/)?'; index += 2; }
      else { source += '.*'; index += 1; }
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

async function repositoryFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', 'devtest-results']);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else output.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  await walk(root);
  return output;
}

export async function gitChangedFiles(root = process.cwd(), baseSha?: string, headSha?: string): Promise<string[]> {
  try {
    const args = baseSha && headSha
      ? ['diff', '--name-only', '--diff-filter=ACMR', `${baseSha}...${headSha}`]
      : ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD~1', 'HEAD'];
    const { stdout } = await execFileAsync('git', args, { cwd: root });
    return stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  } catch { return []; }
}

export async function resolveRequirementFile(input: {
  root?: string;
  config: DevTestProjectConfig;
  explicit?: string;
  changedFiles?: readonly string[];
}): Promise<string> {
  const root = path.resolve(input.root ?? process.cwd());
  const explicit = input.explicit ?? process.env[input.config.github.requirementFileEnv];
  if (explicit) {
    if (!isRelativePortablePath(explicit) && !path.isAbsolute(explicit)) throw new Error('DEVTEST_REQUIREMENT_INVALID：Requirement 路径非法');
    const file = path.resolve(root, explicit);
    if (!(file === root || file.startsWith(`${root}${path.sep}`))) throw new Error('DEVTEST_REQUIREMENT_INVALID：Requirement 必须位于仓库内');
    if (!(await exists(file))) throw new Error(`DEVTEST_REQUIREMENT_NOT_FOUND：${explicit}`);
    return file;
  }
  const patterns = input.config.requirements.include.map(globPattern);
  const matches = (input.changedFiles ?? []).filter((file) => patterns.some((pattern) => pattern.test(file.replace(/\\/g, '/'))));
  if (matches.length === 1) return path.join(root, matches[0]);
  if (matches.length > 1) throw new Error(`DEVTEST_REQUIREMENT_AMBIGUOUS：变更中存在多个 Requirement：${matches.join(', ')}`);
  const all = (await repositoryFiles(root)).filter((file) => patterns.some((pattern) => pattern.test(file)));
  if (all.length === 1) return path.join(root, all[0]);
  if (!all.length) throw new Error(`DEVTEST_REQUIREMENT_NOT_FOUND：未匹配 ${input.config.requirements.include.join(', ')}`);
  throw new Error(`DEVTEST_REQUIREMENT_AMBIGUOUS：仓库中存在多个 Requirement，请设置 ${input.config.github.requirementFileEnv}`);
}

export interface DevTestDoctorResult {
  status: 'READY' | 'BLOCKED';
  checks: Array<{ name: string; status: 'READY' | 'BLOCKED' | 'OPTIONAL'; detail: string }>;
}

export async function doctorDevTestProject(input: {
  root?: string;
  github?: boolean;
  config?: DevTestProjectConfig;
  changedFiles?: readonly string[];
}): Promise<DevTestDoctorResult> {
  const root = path.resolve(input.root ?? process.cwd());
  const checks: DevTestDoctorResult['checks'] = [];
  let config: DevTestProjectConfig;
  try {
    config = input.config ?? await loadDevTestConfig(root);
    checks.push({ name: 'config', status: 'READY', detail: DEVTEST_CONFIG_FILE });
  } catch (error) {
    checks.push({ name: 'config', status: 'BLOCKED', detail: (error as Error).message });
    return { status: 'BLOCKED', checks };
  }
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', status: major >= 24 ? 'READY' : 'BLOCKED', detail: process.versions.node });
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
    checks.push({ name: 'git', status: 'READY', detail: 'repository detected' });
  } catch { checks.push({ name: 'git', status: 'BLOCKED', detail: 'not a Git repository' }); }
  try {
    const requirement = await resolveRequirementFile({ root, config, changedFiles: input.changedFiles });
    checks.push({ name: 'requirement', status: 'READY', detail: path.relative(root, requirement) });
  } catch (error) { checks.push({ name: 'requirement', status: 'BLOCKED', detail: (error as Error).message }); }
  const baseUrlPresent = Boolean(process.env[config.runtime.baseUrlEnv]);
  checks.push({ name: 'environment', status: baseUrlPresent ? 'READY' : 'OPTIONAL',
    detail: `${config.runtime.baseUrlEnv} ${baseUrlPresent ? 'is set' : 'is not set; run will be DESIGNED_ONLY/BLOCKED'}` });
  const runtimePresent = Boolean(process.env[config.runtime.runtimeModuleEnv]);
  checks.push({ name: 'runtime', status: runtimePresent ? 'READY' : 'OPTIONAL',
    detail: `${config.runtime.runtimeModuleEnv} ${runtimePresent ? 'is set' : 'is not set; DB/Log/Queue observers may be BLOCKED'}` });
  if (input.github) {
    for (const variable of ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_EVENT_NAME']) {
      checks.push({ name: variable, status: process.env[variable] ? 'READY' : 'BLOCKED', detail: process.env[variable] ? 'is set' : 'is not set' });
    }
    checks.push({ name: 'GITHUB_TOKEN', status: process.env.GITHUB_TOKEN ? 'READY' : 'BLOCKED',
      detail: process.env.GITHUB_TOKEN ? 'is set' : 'is not set' });
  }
  return { status: checks.some((check) => check.status === 'BLOCKED') ? 'BLOCKED' : 'READY', checks };
}
