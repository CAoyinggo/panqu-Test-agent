import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { DevTestDiscoveryResult, DevTestFeatureModel } from './types.js';

const execFileAsync = promisify(execFile);

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export async function workspaceCacheFingerprint(projectRoot: string): Promise<string> {
  try {
    const [{ stdout: diff }, { stdout: untracked }] = await Promise.all([
      execFileAsync('git', ['diff', '--no-ext-diff', 'HEAD'], { cwd: projectRoot, timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }),
      execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: projectRoot, timeout: 3_000, maxBuffer: 1024 * 1024 }),
    ]);
    const files = untracked.split(/\r?\n/).filter(Boolean);
    const content = await Promise.all(files.map(async (file) => {
      try { return `${file}:${await readFile(path.join(projectRoot, file), 'utf8')}`; } catch { return `${file}:unreadable`; }
    }));
    return hash(`${diff}\n${content.join('\n')}`);
  } catch { return hash('git-unavailable'); }
}

interface DiscoveryCacheRecord {
  schema: 'devtest.discovery-cache.v1';
  requirementFingerprint: string;
  workspaceFingerprint: string;
  discovery: DevTestDiscoveryResult;
  featureModel?: DevTestFeatureModel;
  writtenAt: string;
}

function cachePath(outDir: string, sourceKey: string): string {
  return path.join(outDir, '.devtest-cache', `discovery-${hash(sourceKey).slice(0, 24)}.json`);
}

export async function readDiscoveryStageCache(input: {
  outDir: string;
  sourceKey: string;
  requirementFingerprint: string;
  workspaceFingerprint: string;
}): Promise<{ status: 'HIT' | 'MISS' | 'INVALIDATED'; discovery?: DevTestDiscoveryResult; featureModel?: DevTestFeatureModel }> {
  try {
    const record = JSON.parse(await readFile(cachePath(input.outDir, input.sourceKey), 'utf8')) as DiscoveryCacheRecord;
    if (record.schema !== 'devtest.discovery-cache.v1') return { status: 'INVALIDATED' };
    if (record.requirementFingerprint !== input.requirementFingerprint || record.workspaceFingerprint !== input.workspaceFingerprint) {
      return { status: 'INVALIDATED' };
    }
    return { status: 'HIT', discovery: record.discovery, featureModel: record.featureModel };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISS' : 'INVALIDATED' };
  }
}

export async function writeDiscoveryStageCache(input: {
  outDir: string;
  sourceKey: string;
  requirementFingerprint: string;
  workspaceFingerprint: string;
  discovery: DevTestDiscoveryResult;
  featureModel: DevTestFeatureModel;
}): Promise<void> {
  const target = cachePath(input.outDir, input.sourceKey);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  const record: DiscoveryCacheRecord = { schema: 'devtest.discovery-cache.v1',
    requirementFingerprint: input.requirementFingerprint, workspaceFingerprint: input.workspaceFingerprint,
    discovery: input.discovery, featureModel: input.featureModel, writtenAt: new Date().toISOString() };
  await writeFile(temporary, `${JSON.stringify(record)}\n`, 'utf8');
  await rename(temporary, target);
}
