// Phase 26.3 Real Test Run — E2E
// 验证：smoke/sanity/regression/autonomous 四种形态的真实 Run 执行
// → 自然产生 PASS/REVIEW 决策（BLOCK 由 26.4/26.5 真实故障注入触发，此处验证规则层）
// → 完整链路（审计 / 遥测 / 成本 / Checkpoint / Release Record）真实落库。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { makeRealRunExecutor, computeReleaseDecision, RELEASE_COVERAGE_THRESHOLD } from '../../src/platform/ops/real-run.js';
import type { RealCaseVerdict } from '../../src/platform/ops/real-run.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

async function runReal(b: PlatformBundle, profile: 'smoke' | 'sanity' | 'regression' | 'autonomous', label: string) {
  await b.testAssets.importCatalog();
  const { runId } = await b.service.createRun({
    projectId: 'wan3', environment: 'test', trigger: profile === 'autonomous' ? 'autonomous' : 'manual', actor: 'qa', role: 'QA', feature: `real-run-${profile}`,
  });
  const exec = makeRealRunExecutor(b, profile, { environment: 'test', now: () => FIXED_ISO });
  const summary = await exec({ runId, projectId: 'wan3', environment: 'test', feature: `real-run-${profile}` });
  return { summary, runId };
}

afterEach(() => {});

describe('26.3.1 Smoke Run（核心文生视频链路）', () => {
  it('真实执行 1 个 P0 核心 case → decision=PASS、exit=0、run COMPLETED', async () => {
    const b = makeBundle();
    const { summary, runId } = await runReal(b, 'smoke', 'run-smoke-1');
    expect(summary.decision).toBe('PASS');
    expect(summary.exitCode).toBe(0);
    expect(summary.pass).toBe(1);
    expect(summary.coverage).toBe(1);
    expect(summary.totalCases).toBe(1);
    expect((await b.service.getRun(runId))?.status).toBe('COMPLETED');
    expect(summary.evidence).toBe('deterministic-rule');
  });
});

describe('26.3.2 Sanity Run（P0 + P1 子集）', () => {
  it('10 个平台闭环 case 全 PASS → decision=PASS、exit=0', async () => {
    const b = makeBundle();
    const { summary } = await runReal(b, 'sanity', 'run-sanity-1');
    expect(summary.decision).toBe('PASS');
    expect(summary.exitCode).toBe(0);
    expect(summary.totalCases).toBe(10);
    expect(summary.pass).toBe(10);
    expect(summary.coverage).toBe(1);
  });
});

describe('26.3.3 Regression Run（全量 50）', () => {
  it('P0/P1 闭环 PASS + 外部服务依赖 case REVIEW → coverage<threshold → decision=REVIEW、exit=2', async () => {
    const b = makeBundle();
    const { summary } = await runReal(b, 'regression', 'run-regression-1');
    expect(summary.decision).toBe('REVIEW');
    expect(summary.exitCode).toBe(2);
    expect(summary.totalCases).toBe(50);
    expect(summary.pass).toBe(10);
    expect(summary.review).toBe(40);
    expect(summary.coverage).toBeLessThan(RELEASE_COVERAGE_THRESHOLD);
  });
});

describe('26.3.4 Autonomous Run（P0 + AI 场景）', () => {
  it('coverage 低于门槛 → decision=REVIEW、exit=2（需人工审批）', async () => {
    const b = makeBundle();
    const { summary } = await runReal(b, 'autonomous', 'run-autonomous-1');
    expect(summary.decision).toBe('REVIEW');
    expect(summary.exitCode).toBe(2);
    expect(summary.totalCases).toBe(15);
    expect(summary.pass).toBe(5);
    expect(summary.review).toBe(10);
  });
});

describe('26.3.5 Release Decision 规则真实性（26.5 Gate 前置）', () => {
  it('P0 FAIL → BLOCK（exit=1）；Critical Defect → BLOCK；无 P0 fail 且 coverage 足够 → PASS', () => {
    const base: RealCaseVerdict = { caseId: 'c', category: 'p0', priority: 'P0', business: 'b', feature: 'f', title: 't', result: 'PASS', reason: '', durationMs: 0, retries: 0, executed: true, processorInvoked: true, assertionCount: 1 };
    // P0 FAIL → BLOCK
    const withP0Fail = computeReleaseDecision([{ ...base, result: 'FAIL' }, { ...base, caseId: 'c2', result: 'PASS' }]);
    expect(withP0Fail.decision).toBe('BLOCK');
    expect(withP0Fail.exitCode).toBe(1);
    // Critical Defect（history FAIL）→ BLOCK
    const withCritical = computeReleaseDecision([{ ...base, caseId: 'c', category: 'history', priority: 'P1', result: 'FAIL' }, { ...base, caseId: 'c2', result: 'PASS' }]);
    expect(withCritical.decision).toBe('BLOCK');
    expect(withCritical.exitCode).toBe(1);
    // coverage 足够且无 fail → PASS
    const allPass = computeReleaseDecision([{ ...base, caseId: 'c1' }, { ...base, caseId: 'c2' }, { ...base, caseId: 'c3' }]);
    expect(allPass.decision).toBe('PASS');
    expect(allPass.exitCode).toBe(0);
    // 无 fail 但 coverage 不足 → REVIEW（exit=2，需审批）
    const lowCoverage = computeReleaseDecision([{ ...base, result: 'REVIEW', reason: 'external' }, { ...base, caseId: 'c2', result: 'PASS' }]);
    expect(lowCoverage.decision).toBe('REVIEW');
    expect(lowCoverage.exitCode).toBe(2);
  });
});

describe('26.3.6 完整链路真实落库（审计/遥测/成本/Checkpoint/Release）', () => {
  it('一次真实 Run 产生 run.create 审计 + execution/rca/flaky/release 遥测 + 成本账本 + Checkpoint', async () => {
    const b = makeBundle();
    const { summary, runId } = await runReal(b, 'autonomous', 'run-chain-1');
    // 审计：run.create 存在（service.createRun 自动记录；AuditLog 按 resource=runId 关联）
    const audit = await b.audit.search({ runId });
    expect(audit.some((e) => e.action === 'run.create')).toBe(true);
    // 遥测：事件包含 execution / rca / flaky / release / llm / cost
    const events = await b.telemetry.eventsByRun(runId);
    const types = new Set(events.map((e) => e.type));
    expect(types.has('execution')).toBe(true);
    expect(types.has('rca')).toBe(true);
    expect(types.has('flaky')).toBe(true);
    expect(types.has('release')).toBe(true);
    expect(types.has('llm')).toBe(true);
    expect(summary.telemetryEvents).toBe(events.length);
    // 成本：mock token 经遥测装饰器真实记账（离线成本）
    expect(summary.costEntries).toBeGreaterThan(0);
    expect(summary.totalCostYuan).toBeGreaterThan(0);
    // Checkpoint：autonomous 阶段已保存，含 decisionState
    const ck = (await b.service.loadCheckpoint(runId)) as { stage: string; decisionState: { decision: string } };
    expect(ck.stage).toBe('autonomous');
    expect(ck.decisionState.decision).toBe('REVIEW');
    // Release Record：REVIEW 已通过 telemetry 事件落库（metadata.decision）
    const releaseEvents = events.filter((e) => e.type === 'release');
    expect(releaseEvents.length).toBe(1);
    expect(releaseEvents[0].metadata?.decision).toBe('REVIEW');
  });
});
