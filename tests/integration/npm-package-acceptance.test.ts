import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
let temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function command(file: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, args, { cwd, timeout: 180_000, maxBuffer: 20 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === 'number' ? failed.code : 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? failed.message };
  }
}

async function textFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(?:js|json|md|d\.ts)$/.test(entry.name)) files.push(full);
    }
  };
  await walk(root);
  return files;
}

describe('npm tarball installation acceptance', () => {
  it('packs a strict whitelist and runs init, doctor, run, and status from an installed tarball', async () => {
    const packRoot = await mkdtemp(path.join(os.tmpdir(), 'devtest-pack-'));
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'devtest-project-'));
    temporaryRoots.push(packRoot, projectRoot);
    const packed = await command('npm', ['pack', '--json', '--pack-destination', packRoot], repositoryRoot);
    expect(packed.code, packed.stderr).toBe(0);
    const metadataJson = packed.stdout.slice(Math.max(0, packed.stdout.lastIndexOf('\n[') + 1));
    const metadata = JSON.parse(metadataJson) as Array<{ filename: string; size: number; unpackedSize: number; files: Array<{ path: string }> }>;
    expect(metadata).toHaveLength(1);
    expect(metadata[0].size).toBeLessThan(10 * 1024 * 1024);
    expect(metadata[0].unpackedSize).toBeLessThan(40 * 1024 * 1024);
    const entries = metadata[0].files.map((file) => file.path);
    expect(entries).toContain('dist/bin/run-devtest.js');
    expect(entries).toContain('dist/src/devtest/index.js');
    expect(entries).toContain('packages/panqu-agent-cli/bin/panqu-test-agent.mjs');
    expect(entries).toContain('scripts/prepare.mjs');
    expect(entries.some((file) => file.startsWith('dist/tests/'))).toBe(false);
    expect(entries.some((file) => file.startsWith('tests/'))).toBe(false);
    expect(entries.some((file) => file.includes('node_modules/'))).toBe(false);
    const runtimeRoots = [
      'dist/src/devtest/', 'dist/src/acceptance/', 'dist/src/contracts/', 'dist/src/core/', 'dist/src/discovery/',
    ];
    const runtimeFiles = new Set([
      'dist/src/utils/run-id.js', 'dist/src/utils/run-id.d.ts',
      'dist/src/agents/execution/execution-schema.js', 'dist/src/agents/execution/execution-schema.d.ts',
      'dist/src/agents/test-design/testcase-schema.js', 'dist/src/agents/test-design/testcase-schema.d.ts',
      'dist/src/agents/analysis/root-cause-schema.d.ts', 'dist/src/agents/defect/defect-schema.d.ts',
      'dist/src/agents/requirement/requirement-schema.d.ts', 'dist/src/cases/loader.d.ts',
    ]);
    expect(entries.every((file) => file === 'package.json' || file === 'README.md'
      || file.startsWith('dist/bin/run-devtest.') || runtimeRoots.some((root) => file.startsWith(root))
      || runtimeFiles.has(file) || file.startsWith('packages/panqu-agent-cli/')
      || file === 'scripts/prepare.mjs')).toBe(true);
    expect(entries.length).toBeLessThan(400);

    const tarball = path.join(packRoot, metadata[0].filename);
    const extracted = path.join(packRoot, 'extracted');
    await mkdir(extracted);
    expect((await command('tar', ['-xzf', tarball, '-C', extracted], packRoot)).code).toBe(0);
    const publishedTexts = await textFiles(path.join(extracted, 'package'));
    const publishedContent = (await Promise.all(publishedTexts.map((file) => readFile(file, 'utf8')))).join('\n');
    expect(publishedContent).not.toContain('/Users/mac');
    expect(publishedContent).not.toContain('DEL01_panqu');
    const publishedPackage = JSON.parse(await readFile(path.join(extracted, 'package', 'package.json'), 'utf8')) as {
      version?: string; bin?: Record<string, string>;
    };
    expect(publishedPackage.version).toBe('4.29.2');
    expect(publishedPackage.bin).toMatchObject({
      devtest: './dist/bin/run-devtest.js',
      'panqu-test-agent': 'packages/panqu-agent-cli/bin/panqu-test-agent.mjs',
    });

    await writeFile(path.join(projectRoot, 'package.json'), `${JSON.stringify({
      name: 'devtest-tarball-acceptance', private: true, version: '1.0.0',
      dependencies: { 'test-flow': `file:${tarball}` },
    }, null, 2)}\n`, 'utf8');
    await mkdir(path.join(projectRoot, 'requirements'));
    await writeFile(path.join(projectRoot, 'requirements', 'feature.md'), `# Package Smoke

## API
GET /health

## Acceptance Criteria
AC-1 GET /health returns HTTP 200.
`, 'utf8');
    expect((await command('git', ['init'], projectRoot)).code).toBe(0);
    const installed = await command('npm', [
      'install', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund',
    ], projectRoot);
    expect(installed.code, installed.stderr).toBe(0);
    const executable = path.join(projectRoot, 'node_modules', '.bin', 'devtest');
    const version = await command(executable, ['--version'], projectRoot);
    expect(version).toMatchObject({ code: 0, stdout: '4.29.2\n' });
    const initialized = await command(executable, ['init', '--github'], projectRoot);
    expect(initialized.code, initialized.stderr).toBe(0);
    expect(await readFile(path.join(projectRoot, '.devtest.json'), 'utf8')).not.toMatch(/https?:\/\//);
    const workflow = await readFile(path.join(projectRoot, '.github', 'workflows', 'devtest.yml'), 'utf8');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow).toContain('npx --no-install devtest run --github');
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('DEVTEST_ALLOW_WRITES: ${{ github.event_name == \'workflow_dispatch\'');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('set -Eeuo pipefail');
    expect(workflow).not.toContain('push:');
    expect(workflow).not.toMatch(/file:.*\.tgz/);

    const doctor = await command(executable, ['doctor'], projectRoot);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain('Doctor: READY');
    const run = await command(executable, ['run', '--requirement', 'requirements/feature.md', '--env', 'test'], projectRoot);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('BLOCKED');
    const runDirectories = (await readdir(path.join(projectRoot, 'devtest-results'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('RUN-')).map((entry) => entry.name);
    expect(runDirectories).toHaveLength(1);
    const status = await command(executable, ['status', '--run', runDirectories[0]], projectRoot);
    expect(status.code).toBe(1);
    expect(status.stdout).toMatch(/GENERATED \d+ · EXECUTABLE \d+ · EXECUTED \d+ · VERIFIED \d+/);
    const reportFiles = await readdir(path.join(projectRoot, 'devtest-results'), { recursive: true }) as string[];
    expect(reportFiles).toEqual(expect.arrayContaining([
      expect.stringMatching(/report\.json$/), expect.stringMatching(/evidence\.json$/),
      expect.stringMatching(/cases\.csv$/), expect.stringMatching(/problems\.md$/),
    ]));
  }, 240_000);
});
