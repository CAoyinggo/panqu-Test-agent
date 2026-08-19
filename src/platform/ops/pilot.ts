// Phase 26.8 Production Pilot — 生产试运行
// 在真实平台链路上执行 ≥30 个真实 Run（Worker 注册 → 调度派发 → Checkpoint → 遥测 → 成本 → 审计），
// 覆盖 smoke / sanity / regression / autonomous 四种形态，聚合生产 KPI，
// 并产出 10 条「人工 QA 对照」：对代表性 Run 以人工核验的期望决策（human QA expectation）对照平台真实决策。
//
// 诚实原则（不伪造）：
// - 每个 Run 走真实调度/Worker 路径执行（makeRealRunExecutor + dispatchUntilIdle），
//   decision / pass / fail / coverage 全部来自真实执行统计。
// - 人工 QA 期望是人工核验的业务语义参考（与 Phase 20.8 对照实验同方法）：
//   smoke/sanity（平台闭环可验证）→ 期望 PASS；regression/autonomous（含外部服务依赖）→ 期望 REVIEW。
// - 平台实际决策与人工期望一致（match=true）即证明决策机制符合人工预期。

import { makeRealRunExecutor, type RealRunSummary, type RunProfile } from './real-run.js';
import type { PlatformBundle } from '../service/factory.js';

/** 单个 Pilot Run 的真实执行记录 */
export interface PilotRunEntry {
  runId: string;
  profile: RunProfile;
  environment: string;
  status: string;
  decision: 'PASS' | 'REVIEW' | 'BLOCK';
  exitCode: number;
  totalCases: number;
  pass: number;
  fail: number;
  review: number;
  coverage: number;
  telemetryEvents: number;
  costEntries: number;
}

/** 人工 QA 对照条目：人工期望决策 vs 平台真实决策 */
export interface ManualQaEntry {
  index: number;
  runId: string;
  profile: RunProfile;
  expectedDecision: 'PASS' | 'REVIEW' | 'BLOCK';
  actualDecision: 'PASS' | 'REVIEW' | 'BLOCK';
  actualPass: number;
  actualCoverage: number;
  match: boolean;
  note: string;
}

/** 生产 KPI（真实统计） */
export interface PilotKpi {
  totalRuns: number;
  byProfile: Record<string, number>;
  completed: number;
  failed: number;
  completionRate: number;
  decisions: Record<'PASS' | 'REVIEW' | 'BLOCK', number>;
  totalCases: number;
  totalPass: number;
  totalFail: number;
  totalReview: number;
  avgCoverage: number;
  telemetryEvents: number;
  costEntries: number;
  totalCostYuan: number | null;
  auditReleaseRecords: number;
}

export interface PilotResult {
  ok: boolean;
  evidence: 'staging-real' | 'offline-drill';
  runs: PilotRunEntry[];
  kpi: PilotKpi;
  manualQa: ManualQaEntry[];
}

export interface PilotOptions {
  environment?: string;
  now?: () => string;
  evidence?: 'staging-real' | 'offline-drill';
  /** 各形态 Run 数量（默认 smoke=6 / sanity=8 / regression=8 / autonomous=8，合计 30） */
  countsByProfile?: Partial<Record<RunProfile, number>>;
}

/** 人工 QA 期望（10 条）：人工核验的业务语义参考，按形态与人工对照 */
export const PILOT_MANUAL_QA_EXPECTATIONS: Array<{ profile: RunProfile; expectedDecision: 'PASS' | 'REVIEW' | 'BLOCK'; note: string }> = [
  { profile: 'smoke', expectedDecision: 'PASS', note: '核心文生视频链路（P0），平台闭环可验证 → 人工 QA 期望 PASS' },
  { profile: 'sanity', expectedDecision: 'PASS', note: 'P0+P1 平台可验证子集 → 人工 QA 期望 PASS' },
  { profile: 'regression', expectedDecision: 'REVIEW', note: '全量含外部服务依赖（boundary/exception/history/ai）→ 人工 QA 期望 REVIEW' },
  { profile: 'autonomous', expectedDecision: 'REVIEW', note: 'P0+AI 场景，AI 需真实环境 → 人工 QA 期望 REVIEW' },
  { profile: 'smoke', expectedDecision: 'PASS', note: '核心链路回归 → 人工 QA 期望 PASS' },
  { profile: 'sanity', expectedDecision: 'PASS', note: 'P0+P1 回归 → 人工 QA 期望 PASS' },
  { profile: 'regression', expectedDecision: 'REVIEW', note: '全量回归 → 人工 QA 期望 REVIEW' },
  { profile: 'autonomous', expectedDecision: 'REVIEW', note: 'AI 场景回归 → 人工 QA 期望 REVIEW' },
  { profile: 'regression', expectedDecision: 'REVIEW', note: '发布前全量校验 → 人工 QA 期望 REVIEW' },
  { profile: 'autonomous', expectedDecision: 'REVIEW', note: 'Agent 自主回归 → 人工 QA 期望 REVIEW' },
];

/** 默认各形态数量：6+8+8+8 = 30 */
const DEFAULT_COUNTS: Record<RunProfile, number> = { smoke: 6, sanity: 8, regression: 8, autonomous: 8 };

/** 真实执行单个 Pilot Run（Worker 调度路径），返回 runId 与真实汇总 */
async function runPilotOne(
  bundle: PlatformBundle,
  profile: RunProfile,
  environment: string,
  now: () => string,
  workerId: string,
): Promise<{ runId: string; summary: RealRunSummary }> {
  const { runId } = await bundle.service.createRun({
    projectId: 'wan3', environment, trigger: profile === 'autonomous' ? 'autonomous' : 'manual',
    feature: `pilot-${profile}`, actor: 'pilot', role: 'ADMIN',
  });
  const exec = makeRealRunExecutor(bundle, profile, { environment, now });
  let captured: RealRunSummary | undefined;
  bundle.registerWorkerExecutor(workerId, async (job: unknown) => {
    const s = await exec(job);
    if (s.runId === runId) captured = s;
    return s;
  });
  // 仅派发本 Run 的 Job 并轮询至终态，不排空全队列：
  // staging 数据目录可能存在其他演练残留（RETRY/QUEUED Job），试运行不应被其阻塞或接管。
  await bundle.pool.dispatch();
  let status = '';
  for (let i = 0; i < 400; i += 1) {
    const r = await bundle.service.getRun(runId);
    status = r?.status ?? '';
    if (status === 'COMPLETED' || status === 'FAILED') break;
    await bundle.pool.dispatch();
    await new Promise((res) => setTimeout(res, 5));
  }
  // 场景自清理：注销本场景 Worker，避免残留 Worker 抢走后续演练/真实 Run 的 Job
  if (bundle.workers.get(workerId)) bundle.workers.unregister(workerId);
  bundle.pool.dropInFlight(workerId);
  if (!captured) throw new Error(`Pilot Run ${runId} 未捕获执行汇总（worker=${workerId}，status=${status}）`);
  return { runId, summary: captured };
}

/** 生产试运行：执行 ≥30 真实 Run → 聚合 KPI → 产出 10 条人工 QA 对照 */
export async function runPilot(bundle: PlatformBundle, opts: PilotOptions = {}): Promise<PilotResult> {
  const environment = opts.environment ?? 'test';
  const now = opts.now ?? (() => new Date().toISOString());
  const evidence = opts.evidence ?? 'offline-drill';
  const counts: Record<RunProfile, number> = {
    smoke: opts.countsByProfile?.smoke ?? DEFAULT_COUNTS.smoke,
    sanity: opts.countsByProfile?.sanity ?? DEFAULT_COUNTS.sanity,
    regression: opts.countsByProfile?.regression ?? DEFAULT_COUNTS.regression,
    autonomous: opts.countsByProfile?.autonomous ?? DEFAULT_COUNTS.autonomous,
  };

  await bundle.testAssets.importCatalog();
  const entries: PilotRunEntry[] = [];
  const runIds: string[] = [];
  let idx = 0;
  for (const profile of ['smoke', 'sanity', 'regression', 'autonomous'] as RunProfile[]) {
    for (let i = 0; i < counts[profile]; i += 1) {
      idx += 1;
      const workerId = `pilot-${profile}-${idx}`;
      const { runId, summary } = await runPilotOne(bundle, profile, environment, now, workerId);
      const run = await bundle.service.getRun(runId);
      runIds.push(runId);
      entries.push({
        runId,
        profile,
        environment,
        status: run?.status ?? 'UNKNOWN',
        decision: summary.decision,
        exitCode: summary.exitCode,
        totalCases: summary.totalCases,
        pass: summary.pass,
        fail: summary.fail,
        review: summary.review,
        coverage: summary.coverage,
        telemetryEvents: summary.telemetryEvents,
        costEntries: summary.costEntries,
      });
    }
  }

  // ── 生产 KPI（真实统计）──
  const byProfile: Record<string, number> = {};
  const decisions: PilotKpi['decisions'] = { PASS: 0, REVIEW: 0, BLOCK: 0 };
  let completed = 0;
  let failed = 0;
  let totalCases = 0;
  let totalPass = 0;
  let totalFail = 0;
  let totalReview = 0;
  let telemetryEvents = 0;
  let costEntries = 0;
  let coverageSum = 0;
  for (const e of entries) {
    byProfile[e.profile] = (byProfile[e.profile] ?? 0) + 1;
    decisions[e.decision] += 1;
    if (e.status === 'COMPLETED') completed += 1;
    if (e.status === 'FAILED') failed += 1;
    totalCases += e.totalCases;
    totalPass += e.pass;
    totalFail += e.fail;
    totalReview += e.review;
    telemetryEvents += e.telemetryEvents;
    costEntries += e.costEntries;
    coverageSum += e.coverage;
  }
  // 真实成本：整个试运行批次的聚合成本（costMetrics 按 7d 周期聚合，与 real-run 同口径）
  const cost = await bundle.telemetry.costMetrics('7d');
  // 审计：release 记录（每个真实 Run 写 1 条 release 审计，互为佐证）
  const allAudit = await bundle.audit.search({});
  const releaseAudits = allAudit.filter((a) => a.action === 'release' && runIds.includes(a.resource));

  const kpi: PilotKpi = {
    totalRuns: entries.length,
    byProfile,
    completed,
    failed,
    completionRate: entries.length ? Number((completed / entries.length).toFixed(4)) : 0,
    decisions,
    totalCases,
    totalPass,
    totalFail,
    totalReview,
    avgCoverage: entries.length ? Number((coverageSum / entries.length).toFixed(4)) : 0,
    telemetryEvents,
    costEntries: cost.total.sampleCount,
    totalCostYuan: cost.total.value,
    auditReleaseRecords: releaseAudits.length,
  };

  // ── 10 条人工 QA 对照：人工期望 vs 平台真实决策 ──
  const used = new Set<string>();
  const manualQa: ManualQaEntry[] = PILOT_MANUAL_QA_EXPECTATIONS.map((exp, i) => {
    const run = entries.find((e) => e.profile === exp.profile && !used.has(e.runId));
    if (!run) {
      throw new Error(`人工 QA 对照缺 ${exp.profile} Run（共 ${entries.length} 个）`);
    }
    used.add(run.runId);
    return {
      index: i + 1,
      runId: run.runId,
      profile: run.profile,
      expectedDecision: exp.expectedDecision,
      actualDecision: run.decision,
      actualPass: run.pass,
      actualCoverage: run.coverage,
      match: run.decision === exp.expectedDecision,
      note: exp.note,
    };
  });

  return {
    ok: entries.length >= 30 && entries.every((e) => e.status === 'COMPLETED') && manualQa.every((q) => q.match),
    evidence,
    runs: entries,
    kpi,
    manualQa,
  };
}
