// Phase 26.8 Production Pilot — E2E
// 验证生产试运行：≥30 个真实 Run（smoke/sanity/regression/autonomous）在真实平台链路执行完成，
// 聚合生产 KPI（完成率 / 决策分布 / 覆盖率 / 遥测 / 成本 / 审计），
// 并产出 10 条「人工 QA 对照」：人工核验的期望决策 vs 平台真实决策全部一致（不伪造）。
//
// 诚实原则：每个 Run 走真实调度/Worker 路径（makeRealRunExecutor + dispatchUntilIdle），
// decision / pass / fail / coverage 全部来自真实执行统计；人工 QA 期望为人工核验的业务语义参考。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { runPilot, PILOT_MANUAL_QA_EXPECTATIONS } from '../../src/platform/ops/pilot.js';

const FIXED_ISO = '2026-08-19T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

describe('26.8.1 生产试运行：≥30 个真实 Run 全部形成可信终态', () => {
  it('可执行形态 COMPLETED，缺少 Processor 的 REVIEW 形态 BLOCKED', async () => {
    const b = makeBundle();
    const result = await runPilot(b, { environment: 'staging', evidence: 'offline-drill', now: () => FIXED_ISO });
    expect(result.runs.length).toBeGreaterThanOrEqual(30);
    expect(result.evidence).toBe('offline-drill');
    // smoke/sanity 有真实 Processor；regression/autonomous 含未支持资产，禁止假完成。
    for (const r of result.runs) {
      expect(r.status, `${r.runId} 终态与实际执行不一致`).toBe(
        r.decision === 'REVIEW' ? 'BLOCKED' : 'COMPLETED',
      );
    }
    // 形态分布
    expect(result.kpi.byProfile).toMatchObject({ smoke: 6, sanity: 8, regression: 8, autonomous: 8 });
    expect(result.kpi.completed).toBe(14);
    expect(result.kpi.blocked).toBe(16);
    expect(result.kpi.failed).toBe(0);
    expect(result.kpi.completionRate).toBeCloseTo(14 / 30, 4);
    expect(result.ok).toBe(true);
  }, 30_000);
});

describe('26.8.2 生产 KPI：真实统计聚合', () => {
  it('决策分布 / 覆盖率 / 遥测 / 成本 / 审计全部来自真实执行', async () => {
    const b = makeBundle();
    const result = await runPilot(b, { environment: 'staging', evidence: 'offline-drill', now: () => FIXED_ISO });
    const kpi = result.kpi;
    // 决策分布：smoke+sanity → PASS（14）；regression+autonomous → REVIEW（16）；无 BLOCK（未注入故障）
    expect(kpi.decisions.PASS).toBe(14);
    expect(kpi.decisions.REVIEW).toBe(16);
    expect(kpi.decisions.BLOCK).toBe(0);
    // 覆盖率：单 Run 覆盖率为 1（PASS 形态）或 <1（REVIEW 形态），均值 > 0
    expect(kpi.avgCoverage).toBeGreaterThan(0);
    // 真实遥测 / 成本 / 审计
    expect(kpi.telemetryEvents).toBeGreaterThan(0);
    expect(kpi.costEntries).toBeGreaterThan(0);
    expect(kpi.totalCostYuan).toBeGreaterThan(0);
    expect(kpi.auditReleaseRecords).toBeGreaterThanOrEqual(kpi.totalRuns);
    // 每个 Run 均产生遥测事件与成本入账
    for (const r of result.runs) {
      expect(r.telemetryEvents, `${r.runId} 无遥测`).toBeGreaterThan(0);
      expect(r.costEntries, `${r.runId} 无成本`).toBeGreaterThan(0);
    }
  }, 30_000);
});

describe('26.8.3 人工 QA 对照：10 条人工期望 vs 平台真实决策', () => {
  it('10 条对照全部 match（平台真实决策符合人工核验期望）', async () => {
    const b = makeBundle();
    const result = await runPilot(b, { environment: 'staging', evidence: 'offline-drill', now: () => FIXED_ISO });
    expect(PILOT_MANUAL_QA_EXPECTATIONS).toHaveLength(10);
    expect(result.manualQa).toHaveLength(10);
    const runIds = new Set(result.runs.map((r) => r.runId));
    for (const q of result.manualQa) {
      expect(runIds.has(q.runId), `对照 ${q.index} 指向真实 Run`).toBe(true);
      expect(q.match, `对照 ${q.index}（${q.profile}）平台决策 ${q.actualDecision} 与人工期望 ${q.expectedDecision} 不一致`).toBe(true);
      expect(q.note.length).toBeGreaterThan(0);
    }
    // 覆盖形态：10 条对照覆盖全部 4 种形态
    const profiles = new Set(result.manualQa.map((q) => q.profile));
    for (const p of ['smoke', 'sanity', 'regression', 'autonomous']) expect(profiles.has(p as never)).toBe(true);
  }, 30_000);
});

describe('26.8.4 真实链路落库：审计 / 遥测 / Checkpoint / Release', () => {
  it('抽查 Run：run.create 审计 + release 审计 + Checkpoint + Release Record 真实落库', async () => {
    const b = makeBundle();
    const result = await runPilot(b, { environment: 'staging', evidence: 'offline-drill', now: () => FIXED_ISO });
    const regression = result.runs.find((r) => r.profile === 'regression')!;
    const runId = regression.runId;
    // 审计：run.create + release（decision=REVIEW → result=pending）
    const audit = await b.audit.search({ runId });
    expect(audit.some((e) => e.action === 'run.create')).toBe(true);
    const releaseAudit = audit.find((e) => e.action === 'release');
    expect(releaseAudit).toBeTruthy();
    expect(releaseAudit!.result).toBe('pending');
    // 遥测：execution / rca / flaky / release / llm
    const events = await b.telemetry.eventsByRun(runId);
    const types = new Set(events.map((e) => e.type));
    expect(types.has('execution')).toBe(true);
    expect(types.has('release')).toBe(true);
    expect(types.has('llm')).toBe(true);
    // Checkpoint：decisionState.decision = REVIEW
    const ck = (await b.service.loadCheckpoint(runId)) as { stage: string; decisionState: { decision: string } };
    expect(ck.decisionState.decision).toBe('REVIEW');
    // Release Record：REVIEW 真实落库
    const release = events.find((e) => e.type === 'release');
    expect(release?.metadata?.decision).toBe('REVIEW');
  }, 30_000);
});
