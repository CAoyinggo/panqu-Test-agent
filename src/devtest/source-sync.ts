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
  /** @deprecated 保留调用兼容；安全同步不会清理或丢弃任何本地文件。 */
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

async function gitSucceeds(runner: DevTestGitRunner, repository: string, args: readonly string[]): Promise<boolean> {
  try {
    await runner(repository, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * 测试执行前的两阶段安全同步：先验证所有仓库工作树与上游关系，再 fetch，
 * 最后仅执行 fast-forward。任何本地改动、未跟踪文件、本地提交、分支分叉、
 * 认证或网络失败都会 fail-close；绝不 reset、clean、stash 或覆盖用户内容。
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
  }> = [];

  // Phase 1A：先检查所有工作树。任何仓库不干净时，不开始网络同步。
  for (const repository of repositories) {
    const branch = await gitText(runner, repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) throw new Error(`DEVTEST_SOURCE_SYNC_DETACHED_HEAD：${path.basename(repository)} 未处于分支`);
    const upstream = await gitText(runner, repository, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    const separator = upstream.indexOf('/');
    if (separator <= 0) throw new Error(`DEVTEST_SOURCE_SYNC_UPSTREAM_MISSING：${path.basename(repository)}:${branch}`);
    const remote = upstream.slice(0, separator);
    const beforeCommit = await gitText(runner, repository, ['rev-parse', 'HEAD']);
    const dirtyEntries = lines(await gitText(runner, repository, ['status', '--porcelain', '--untracked-files=normal'])).length;
    if (dirtyEntries > 0) {
      throw new Error(`DEVTEST_SOURCE_SYNC_DIRTY：${path.basename(repository)} 有 ${dirtyEntries} 项未提交或未跟踪改动；请先由用户处理，未执行 reset/clean/stash`);
    }
    inspected.push({ repository, branch, upstream, remote, beforeCommit, targetCommit: '' });
  }

  // Phase 1B：全部工作树安全后再 fetch，并验证只能快进到远端跟踪分支。
  for (const item of inspected) {
    await gitText(runner, item.repository, ['fetch', '--prune', item.remote]);
    item.targetCommit = await gitText(runner, item.repository, ['rev-parse', item.upstream]);
    if (item.beforeCommit !== item.targetCommit
      && !await gitSucceeds(runner, item.repository, ['merge-base', '--is-ancestor', item.beforeCommit, item.targetCommit])) {
      throw new Error(`DEVTEST_SOURCE_SYNC_NON_FAST_FORWARD：${path.basename(item.repository)}:${item.branch} 与 ${item.upstream} 已分叉或含本地提交；请先由用户处理`);
    }
  }

  // Phase 2：只允许快进，不丢弃任何本地内容。
  const synchronized: DevTestSourceRepositorySync[] = [];
  for (const item of inspected) {
    if (item.beforeCommit !== item.targetCommit) {
      await gitText(runner, item.repository, ['merge', '--ff-only', item.upstream]);
    }
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
      discardedWorktreeEntries: 0,
      updated: item.beforeCommit !== afterCommit,
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
