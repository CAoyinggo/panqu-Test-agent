import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');
const stepHeader = '      - name: Run Trivy config scan and image guard\n        run: |\n';
const stepStart = workflow.indexOf(stepHeader);
const stepEnd = workflow.indexOf('\n      - name: Upload Trivy Artifact', stepStart);

function trivyStepScript(): string {
  if (stepStart < 0 || stepEnd < 0) throw new Error('Trivy workflow step not found');
  return workflow
    .slice(stepStart + stepHeader.length, stepEnd)
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
}

function runTrivyStep(status: number, report: string | undefined): { status: number | null; output: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'trivy-gate-test-'));
  try {
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    const docker = join(bin, 'docker');
    writeFileSync(
      docker,
      '#!/bin/sh\ncase " $* " in\n  *" config "*) if [ -n "${FAKE_REPORT+x}" ]; then printf "%s" "$FAKE_REPORT" > "$PWD/security-reports/trivy-config.json"; fi; exit "$FAKE_STATUS";;\n  *" convert "*) exit 0;;\nesac\nexit 2\n',
    );
    chmodSync(docker, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_STATUS: String(status),
    };
    if (report !== undefined) env.FAKE_REPORT = report;
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', trivyStepScript()], {
      cwd,
      env,
      encoding: 'utf8',
    });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('GitHub Trivy CI gate', () => {
  const noTargets = '{"SchemaVersion":2,"Results":[]}';

  it('fails when the scanner errors even if its report has no targets', () => {
    const result = runTrivyStep(2, noTargets);
    expect(result.status).toBe(2);
    expect(result.output).toContain('配置扫描异常退出');
  });

  it('fails when the scanner reports findings without a target', () => {
    expect(runTrivyStep(42, noTargets).status).toBe(2);
  });

  it('fails when the report is missing', () => {
    expect(runTrivyStep(0, undefined).status).toBe(2);
  });

  it('marks an empty successful scan as not run', () => {
    const result = runTrivyStep(0, noTargets);
    expect(result.status).toBe(0);
    expect(result.output).toContain('配置扫描未运行');
    expect(result.output).toContain('镜像扫描未运行');
  });

  it('retains the configured warning policy for findings with a real target', () => {
    const result = runTrivyStep(42, '{"SchemaVersion":2,"Results":[{"Target":"Dockerfile"}]}');
    expect(result.status).toBe(0);
    expect(result.output).toContain('发现 HIGH/CRITICAL 问题');
  });
});
