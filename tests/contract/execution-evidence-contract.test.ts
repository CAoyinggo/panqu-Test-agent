import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDslExecutable, normalizeTestCase } from '../../src/agents/test-design/testcase-schema.js';
import { computeOutcome } from '../../src/agents/execution/execution-schema.js';
import { computeAnalysisSummary } from '../../src/agents/analysis/analysis-schema.js';
import { evaluateCoreExecution } from '../../src/core/execution-status.js';
import { dbCheck } from '../../src/assertions/db-check.js';
import { accountCheck } from '../../src/assertions/account-check.js';
import { chaosCheck } from '../../src/assertions/chaos-check.js';
import { operationOutcomeCheck } from '../../src/assertions/operation-outcome-check.js';
import { runTeardownCheck } from '../../src/core/teardown.js';
import type { ReportData, RunContext } from '../../src/core/types.js';
import { JunitReporter } from '../../src/reports/junit-reporter.js';
import { computeCiResult } from '../../src/qa/ci-result.js';
import { decideRelease } from '../../src/release-decision/release-decision-engine.js';
import { releaseExitCode } from '../../src/release-ci/release-ci.js';
import { evaluateReleaseGate } from '../../src/operations/release-gate.js';
import { evaluateCase } from '../../src/platform/ops/real-run.js';
import type { PlatformTestAsset } from '../../src/platform/test-assets/platform-test-assets.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function videoCase(assertions: unknown[] = []) {
  return normalizeTestCase({
    id: 'evidence-video-1',
    feature: 'wan3',
    name: 'video without business assertion',
    priority: 'P0',
    tags: ['P0'],
    steps: [{ action: 'submit', scene: 'video', input: { prompt: 'contract probe' } }],
    assertions,
  });
}

function reportData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    title: 'execution evidence contract',
    env: 'test',
    taskDef: { name: 'unsupported', scene: 'unknown' },
    submit: {},
    billingData: {},
    impact: [],
    checks: [],
    responses: [],
    manual: [],
    issues: [{ level: '阻塞', title: 'NOT_EXECUTED', desc: 'processor missing' }],
    passRate: 0,
    executed: false,
    executionStatus: 'NOT_EXECUTED',
    assetInfo: { exists: false, resolved: [] },
    ...overrides,
  };
}

function platformAsset(category: 'p0' | 'p1'): PlatformTestAsset {
  return {
    id: `asset-${category}`,
    type: 'test-case',
    projectId: 'wan3',
    feature: 'wan3/text-to-video',
    business: 'text-to-video',
    title: `${category} execution evidence probe`,
    priority: category === 'p0' ? 'P0' : 'P1',
    category,
    status: 'ACTIVE',
    source: 'contract',
    content: { preconditions: 'none', steps: ['submit'], expected: 'real evidence' },
    createdAt: '2026-08-22T00:00:00.000Z',
  };
}

describe('Execution Evidence Contract', () => {
  it('[P0-01] empty business assertions make the DSL non-executable', () => {
    const result = checkDslExecutable(videoCase([]));
    expect(result.executable).toBe(false);
    expect(result.problems).toContain('缺少有效业务断言');
  });

  it('[P0-01] informational teardown checks cannot satisfy effectiveAssertions', () => {
    const context = {
      taskId: 1001,
      submit: { taskId: 1001, status: '成功' },
    } as unknown as RunContext;
    const informationalChecks = runTeardownCheck(context, {});
    expect(informationalChecks.length).toBeGreaterThan(0);
    expect(informationalChecks.every((check) => check.pass)).toBe(true);

    const result = evaluateCoreExecution({
      hasProcessor: true,
      processorInvoked: true,
      checks: informationalChecks,
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.passRate).toBe(0);
  });

  it('[P0-01] skipped/account/diagnostic defaults cannot turn an unproved failed submission into PASS', () => {
    const task = { name: 'legacy failure', scene: 'video', expected_points: 0 };
    const submit = { status: '提交失败', err: 'provider rejected' };
    const weakChecks = [
      ...dbCheck(task, submit, {}),
      ...accountCheck(task, submit, {}),
      ...chaosCheck(task, submit, {}),
    ];
    expect(evaluateCoreExecution({ hasProcessor: true, processorInvoked: true, checks: weakChecks }).status).toBe('BLOCKED');

    const checks = [...weakChecks, ...operationOutcomeCheck(task, submit, {})];
    expect(evaluateCoreExecution({ hasProcessor: true, processorInvoked: true, checks })).toMatchObject({ status: 'FAIL', passRate: 0 });
  });

  it('[P0-02/P0-03] unsupported scene or missing Processor is NOT_EXECUTED', () => {
    const result = evaluateCoreExecution({
      hasProcessor: false,
      processorInvoked: false,
      checks: [],
    });
    expect(result).toMatchObject({ executed: false, status: 'NOT_EXECUTED', passRate: 0 });
  });

  it('[P0-02] JUnit preserves NOT_EXECUTED as a failing testcase', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-junit-'));
    temporaryDirectories.push(directory);
    const [file] = new JunitReporter().write(directory, 'unsupported', reportData());
    const xml = fs.readFileSync(file, 'utf8');

    expect(xml).toContain('<failure');
    expect(xml).not.toContain('无断言，视为通过');
  });

  it('[P0-04] Platform real-run cannot infer PASS from p0/p1 category', () => {
    const verdicts = [evaluateCase(platformAsset('p0')), evaluateCase(platformAsset('p1'))];
    expect(verdicts.filter((verdict) => verdict.result === 'PASS')).toHaveLength(0);
  });

  it('[P0-06] empty Outcome is explicitly non-executed', () => {
    const outcome = computeOutcome('wan3', []);
    expect(outcome).toMatchObject({ total: 0, passed: 0, executed: false, passRate: 0 });
  });

  it('[P0-06] empty Analysis is INCONCLUSIVE/BLOCKED rather than pass', () => {
    const analysis = computeAnalysisSummary(0, 0, 0, 0);
    expect(analysis.overall).not.toBe('pass');
    expect(analysis.exitCode).not.toBe(0);
  });

  it('[P0-06] empty CI result is not PASS', () => {
    const ci = computeCiResult(computeOutcome('wan3', []));
    expect(ci.verdict).not.toBe('PASS');
  });

  it('[P0-06] empty autonomous release decision is not PASS and has non-zero exit', () => {
    const decision = decideRelease({
      p0: { total: 0, passed: 0 },
      p1: { total: 0, passed: 0 },
      coverage: 1,
      criticalDefects: 0,
    });
    expect(decision.decision).not.toBe('PASS');
    expect(releaseExitCode(decision.decision)).not.toBe(0);
  });

  it('[P0-06] empty operations release gate is BLOCK', () => {
    const gate = evaluateReleaseGate({
      p0: { total: 0, passed: 0 },
      p1: { total: 0, passed: 0 },
      coverage: 1,
      criticalDefects: 0,
    });
    expect(gate.release).toBe('BLOCK');
  });
});
