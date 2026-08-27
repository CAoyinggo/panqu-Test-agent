import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { redactSensitiveText } from '../core/redact.js';

const execFileAsync = promisify(execFile);

export interface DevTestSourceRepositorySync {
  name: string;
  path: string;
  branch: string;
  upstream: string;
  beforeCommit: string;
  targetCommit: string;
  afterCommit: string;
  discardedWorktreeEntries: number;
  updated: boolean;
}

export interface DevTestSourceSyncResult {
  status: 'SYNCED';
  root: string;
  startedAt: string;
  finishedAt: string;
  repositories: DevTestSourceRepositorySync[];
}

export interface DevTestSourceSyncOptions {
  root: string;
  /** 覆盖模式：丢弃 tracked 修改/本地提交，并删除非 ignored 的未跟踪文件。 */
  cleanUntracked?: boolean;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export type DevTestGitRunner = (repository: string, args: readonly string[]) => Promise<GitCommandResult>;

const defaultGitRunner: DevTestGitRunner = async (repository, args) => {
  const result = await execFileAsync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

async function isDirectory(candidate: string): Promise<boolean> {
  try { return (await stat(candidate)).isDirectory(); } catch { return false; }
}

async function repositoriesAt(root: string): Promise<string[]> {
  const repositories: string[] = [];
  if (await isDirectory(path.join(root, '.git'))) repositories.push(root);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = path.join(root, entry.name);
    if (await isDirectory(path.join(candidate, '.git'))) repositories.push(candidate);
  }
  return [...new Set(repositories)].sort((left, right) => left.localeCompare(right));
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function gitText(runner: DevTestGitRunner, repository: string, args: readonly string[]): Promise<string> {
  try {
    return (await runner(repository, args)).stdout.trim();
  } catch (error) {
    const stderr = typeof error === 'object' && error && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '').trim() : '';
    throw new Error(`DEVTEST_SOURCE_SYNC_GIT_FAILED：${path.basename(repository)} git ${args[0]} 失败${stderr ? `：${redactSensitiveText(stderr)}` : ''}`);
  }
}

/**
 * 测试执行前的两阶段强制同步：先让所有仓库 fetch/解析成功，再开始覆盖。
 * 这样认证或网络失败不会先覆盖一半仓库。ignored 依赖（如 node_modules）保留。
 */
export async function synchronizeDevTestSource(
  options: DevTestSourceSyncOptions,
  runner: DevTestGitRunner = defaultGitRunner,
): Promise<DevTestSourceSyncResult> {
  const startedAt = new Date().toISOString();
  let root: string;
  try { root = await realpath(options.root); } catch {
    throw new Error(`DEVTEST_SOURCE_SYNC_ROOT_NOT_FOUND：${options.root}`);
  }
  const repositories = await repositoriesAt(root);
  if (!repositories.length) throw new Error(`DEVTEST_SOURCE_SYNC_NO_REPOSITORY：${root} 下没有可同步的 Git 仓库`);

  const inspected: Array<{
    repository: string;
    branch: string;
    upstream: string;
    remote: string;
    beforeCommit: string;
    targetCommit: string;
    dirtyEntries: number;
  }> = [];

  // Phase 1：只读检查 + fetch。任一仓库失败时尚未 reset/clean。
  for (const repository of repositories) {
    const branch = await gitText(runner, repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) throw new Error(`DEVTEST_SOURCE_SYNC_DETACHED_HEAD：${path.basename(repository)} 未处于分支`);
    const upstream = await gitText(runner, repository, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    const separator = upstream.indexOf('/');
    if (separator <= 0) throw new Error(`DEVTEST_SOURCE_SYNC_UPSTREAM_MISSING：${path.basename(repository)}:${branch}`);
    const remote = upstream.slice(0, separator);
    const beforeCommit = await gitText(runner, repository, ['rev-parse', 'HEAD']);
    const dirtyEntries = lines(await gitText(runner, repository, ['status', '--porcelain', '--untracked-files=normal'])).length;
    await gitText(runner, repository, ['fetch', '--prune', remote]);
    const targetCommit = await gitText(runner, repository, ['rev-parse', upstream]);
    inspected.push({ repository, branch, upstream, remote, beforeCommit, targetCommit, dirtyEntries });
  }

  // Phase 2：用户要求的覆盖语义。
  const synchronized: DevTestSourceRepositorySync[] = [];
  for (const item of inspected) {
    await gitText(runner, item.repository, ['reset', '--hard', item.upstream]);
    if (options.cleanUntracked !== false) await gitText(runner, item.repository, ['clean', '-fd']);
    const afterCommit = await gitText(runner, item.repository, ['rev-parse', 'HEAD']);
    const remaining = lines(await gitText(runner, item.repository, ['status', '--porcelain', '--untracked-files=normal']));
    if (afterCommit !== item.targetCommit || remaining.length) {
      throw new Error(`DEVTEST_SOURCE_SYNC_VERIFY_FAILED：${path.basename(item.repository)} 未精确对齐 ${item.upstream}`);
    }
    synchronized.push({
      name: path.basename(item.repository),
      path: item.repository,
      branch: item.branch,
      upstream: item.upstream,
      beforeCommit: item.beforeCommit,
      targetCommit: item.targetCommit,
      afterCommit,
      discardedWorktreeEntries: item.dirtyEntries,
      updated: item.beforeCommit !== afterCommit || item.dirtyEntries > 0,
    });
  }

  return {
    status: 'SYNCED',
    root,
    startedAt,
    finishedAt: new Date().toISOString(),
    repositories: synchronized,
  };
}
