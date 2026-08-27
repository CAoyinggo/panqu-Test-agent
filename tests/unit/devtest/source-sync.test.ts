import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { synchronizeDevTestSource, type DevTestGitRunner } from '../../../src/devtest/source-sync.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.stdout.trim();
}

async function commit(cwd: string, message: string): Promise<void> {
  await git(cwd, 'add', '.');
  await git(cwd, '-c', 'user.name=DevTest', '-c', 'user.email=devtest@example.invalid', 'commit', '-m', message);
}

describe('DevTest source sync', () => {
  it('force-overlays every repository with its latest tracked remote commit', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'devtest-source-sync-'));
    const root = path.join(temp, 'panqu-ai');
    const remote = path.join(temp, 'worker.git');
    const seed = path.join(temp, 'seed');
    const updater = path.join(temp, 'updater');
    const repository = path.join(root, 'worker');
    await mkdir(root, { recursive: true });
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['clone', remote, seed]);
    await writeFile(path.join(seed, 'version.txt'), 'v1\n');
    await commit(seed, 'initial');
    await git(seed, 'branch', '-M', 'main');
    await git(seed, 'push', '-u', 'origin', 'main');
    await execFileAsync('git', ['clone', '--branch', 'main', remote, repository]);

    await writeFile(path.join(repository, 'local-only.txt'), 'discard me\n');
    await commit(repository, 'local ahead commit');
    await writeFile(path.join(repository, 'untracked.txt'), 'discard me too\n');

    await execFileAsync('git', ['clone', '--branch', 'main', remote, updater]);
    await writeFile(path.join(updater, 'version.txt'), 'v2\n');
    await commit(updater, 'remote update');
    await git(updater, 'push', 'origin', 'main');
    const remoteCommit = await git(updater, 'rev-parse', 'HEAD');

    const result = await synchronizeDevTestSource({ root, cleanUntracked: true });

    expect(result.status).toBe('SYNCED');
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]).toMatchObject({
      name: 'worker', branch: 'main', upstream: 'origin/main', afterCommit: remoteCommit,
      updated: true, discardedWorktreeEntries: 1,
    });
    expect(await readFile(path.join(repository, 'version.txt'), 'utf8')).toBe('v2\n');
    expect(await git(repository, 'status', '--porcelain')).toBe('');
    await expect(readFile(path.join(repository, 'local-only.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(repository, 'untracked.txt'), 'utf8')).rejects.toThrow();
  });

  it('does not reset any repository when the read/fetch phase fails', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'devtest-source-sync-fail-'));
    for (const name of ['a', 'b']) await mkdir(path.join(temp, name, '.git'), { recursive: true });
    const calls: Array<{ repository: string; args: readonly string[] }> = [];
    const runner: DevTestGitRunner = async (repository, args) => {
      calls.push({ repository, args });
      if (path.basename(repository) === 'b' && args[0] === 'fetch') throw Object.assign(new Error('network'), { stderr: 'offline' });
      const stdout = args[0] === 'symbolic-ref' ? 'main\n'
        : args[0] === 'status' ? ' M local.txt\n'
          : args[0] === 'rev-parse' && args.includes('--abbrev-ref') ? 'origin/main\n'
            : '1111111111111111111111111111111111111111\n';
      return { stdout, stderr: '' };
    };

    await expect(synchronizeDevTestSource({ root: temp }, runner)).rejects.toThrow('DEVTEST_SOURCE_SYNC_GIT_FAILED：b git fetch 失败');
    expect(calls.some((call) => call.args[0] === 'reset' || call.args[0] === 'clean')).toBe(false);
  });

  it('fails closed when the configured root contains no git repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'devtest-source-sync-empty-'));
    await expect(synchronizeDevTestSource({ root })).rejects.toThrow('DEVTEST_SOURCE_SYNC_NO_REPOSITORY');
  });
});
