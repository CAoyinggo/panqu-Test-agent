// Run Report / Share（Phase 39.6）：每个 Run 一份可分享报告
// 报告首页突出关键结论：Release Decision / Risk / Coverage / Failures / Critical Defects /
// RCA / Cost / Duration；并复用 DecisionTrace（checkpoint decisionState）解释"为什么"。
// 分享：生成 share token；访问经 Project Scope + RBAC 校验（不可按 URL 猜测跨项目报告）。
// 导出：JSON（结构化）/ HTML（自包含单页，浏览器直接打开）。

import type { Entity, Repository } from '../storage/repository.js';
import { generateEntityId } from '../storage/repository.js';
import type { RunService } from '../runs/run-service.js';
import type { TestRun } from '../runs/run-schema.js';
import type { ApprovalCenter } from '../approval-center/approval-center.js';
import type { ApprovalRequest } from '../approval-center/approval-schema.js';
import type { TelemetryService } from '../telemetry/index.js';
import type { CostLedgerEntry, RcaVerification, ReleaseRecord } from '../telemetry/index.js';

/** 分享记录 */
export interface RunShare extends Entity {
  id: string;
  runId: string;
  projectId: string;
  createdBy: string;
  token: string;
  createdAt: string;
}

/** 报告覆盖 */
export interface ReportCoverage {
  total: number;
  completed: number;
  failed: number;
  remaining: number;
}

/** 报告失败项 */
export interface ReportFailure {
  caseId?: string;
  reason?: string;
  category?: string;
}

/** 报告风险等级 */
export type ReportRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

/** Run 报告摘要 */
export interface RunReportSummary {
  runId: string;
  projectId: string;
  environment: string;
  trigger: string;
  status: string;
  progress: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  releaseDecision: ReleaseRecord | null;
  coverage: ReportCoverage;
  failures: ReportFailure[];
  rca: Array<{ caseId?: string; category: string; verified: boolean }>;
  cost: { value: number | null; tracked: boolean; unit: string };
  approvals: Array<{ approvalId: string; action: string; status: string }>;
  risk: ReportRisk;
  /** DecisionTrace（Phase 23 决策追踪；checkpoint.decisionState 原样透出，供"为什么"解释） */
  decisionTrace: unknown;
}

export interface RunReportServiceDeps {
  runs: RunService;
  approvals: ApprovalCenter;
  telemetry: TelemetryService;
}

export class RunReportService {
  constructor(
    private readonly deps: RunReportServiceDeps,
    private readonly shares: Repository<RunShare>,
  ) {}

  /** 构建报告摘要（真实数据聚合；无数据返回 tracked=false / 空数组，不虚构） */
  async buildSummary(run: TestRun): Promise<RunReportSummary> {
    const checkpoint = (await this.deps.runs.loadCheckpoint(run.runId)) as {
      completedCases?: string[];
      remainingCases?: string[];
      decisionState?: unknown;
    } | null;
    const completedCases = checkpoint?.completedCases ?? [];
    const remainingCases = checkpoint?.remainingCases ?? [];
    const total = completedCases.length + remainingCases.length;
    const decisionState = checkpoint?.decisionState;
    const decision = decisionState as { decision?: string; result?: string; reason?: string; timestamp?: string } | null;
    const relResult = decision?.result === 'success' || decision?.result === 'blocked' ? decision.result : 'review';
    const release: ReleaseRecord | null = decision?.decision
      ? {
          id: `${run.runId}-decision`,
          runId: run.runId,
          decision: decision.decision === 'PASS' || decision.decision === 'REVIEW' || decision.decision === 'BLOCK' ? decision.decision : 'REVIEW',
          result: relResult,
          reason: decision.reason,
          timestamp: decision.timestamp ?? run.finishedAt ?? run.createdAt,
        }
      : null;
    const failures: ReportFailure[] = [];
    const rcaList: Array<{ caseId?: string; category: string; verified: boolean }> = [];
    const rcaRecords: RcaVerification[] = await this.deps.telemetry.rca.list({ runId: run.runId });
    for (const r of rcaRecords) {
      rcaList.push({ category: r.predictedCategory, verified: !!r.verifiedBy });
    }
    const costEntries: CostLedgerEntry[] = await this.deps.telemetry.costs.list({ runId: run.runId });
    const costValue = costEntries.length ? Number(costEntries.reduce((a, b) => a + b.cost, 0).toFixed(4)) : null;
    const approvals: ApprovalRequest[] = await this.deps.approvals.list({ runId: run.runId });
    const started = run.startedAt ? Date.parse(run.startedAt) : null;
    const finished = run.finishedAt ? Date.parse(run.finishedAt) : null;
    const risk: ReportRisk = run.status === 'FAILED' ? 'HIGH' : release?.decision === 'BLOCK' ? 'HIGH' : release?.decision === 'REVIEW' ? 'MEDIUM' : total === 0 ? 'UNKNOWN' : 'LOW';
    return {
      runId: run.runId,
      projectId: run.projectId,
      environment: run.environment,
      trigger: run.trigger,
      status: run.status,
      progress: run.progress,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: started && finished ? Math.max(0, finished - started) : undefined,
      releaseDecision: release,
      coverage: {
        total,
        completed: completedCases.length,
        failed: run.status === 'FAILED' ? 1 : 0,
        remaining: remainingCases.length,
      },
      failures,
      rca: rcaList,
      cost: { value: costValue, tracked: costEntries.length > 0, unit: 'CNY' },
      approvals: approvals.map((a) => ({ approvalId: a.approvalId, action: a.action, status: a.status })),
      risk,
      decisionTrace: decisionState,
    };
  }

  /** 创建分享（幂等：同一 run 复用 token） */
  async share(run: TestRun, by: string, now?: () => string): Promise<RunShare> {
    const ts = now ? now() : new Date().toISOString();
    const existing = await this.shares.query({ runId: run.runId });
    if (existing[0]) return existing[0];
    const share: RunShare = {
      id: generateEntityId('share'),
      runId: run.runId,
      projectId: run.projectId,
      createdBy: by,
      token: generateEntityId('tok'),
      createdAt: ts,
    };
    await this.shares.create(share);
    return share;
  }

  async shareInfo(runId: string): Promise<RunShare | null> {
    const rows = await this.shares.query({ runId });
    return rows[0] ?? null;
  }

  /** 校验 share token 归属（防跨项目猜测） */
  async verifyShare(runId: string, token: string): Promise<boolean> {
    const share = await this.shareInfo(runId);
    return !!share && share.token === token;
  }

  /** 导出 JSON */
  async exportJson(run: TestRun): Promise<string> {
    const summary = await this.buildSummary(run);
    return JSON.stringify({ report: summary, exportedAt: new Date().toISOString() }, null, 2);
  }

  /** 导出 HTML（自包含单页；中文粗体优先系统字体） */
  async exportHtml(run: TestRun): Promise<string> {
    const s = await this.buildSummary(run);
    const esc = (v: unknown): string =>
      String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const rows = [
      ['Run ID', s.runId],
      ['Project', s.projectId],
      ['Environment', s.environment],
      ['Trigger', s.trigger],
      ['Status', s.status],
      ['Progress', `${s.progress}%`],
      ['Risk', s.risk],
      ['Release Decision', s.releaseDecision?.decision ?? 'N/A'],
      ['Cost (CNY)', s.cost.tracked ? String(s.cost.value) : '未采集'],
      ['Duration (ms)', s.durationMs === undefined ? 'N/A' : String(s.durationMs)],
    ]
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
      .join('');
    const rcaRows = s.rca.length
      ? s.rca.map((r) => `<tr><td>${esc(r.category)}</td><td>${r.verified ? '已验证' : '待验证'}</td></tr>`).join('')
      : '<tr><td colspan="2">无 RCA 记录</td></tr>';
    return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>Run Report ${esc(s.runId)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;margin:0;background:#f5f7fa;color:#1f2937}
.wrap{max-width:880px;margin:0 auto;padding:32px 20px}
h1{font-size:22px} .card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:20px;margin:16px 0}
table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef1f5;font-size:14px}
th{width:180px;color:#6b7280;font-weight:500}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
</style></head>
<body><div class="wrap">
<h1>Run Report</h1>
<div class="card"><table>${rows}</table></div>
<div class="card"><h3>RCA（根因分析）</h3><table><tr><th>Category</th><th>Verification</th></tr>${rcaRows}</table></div>
<div class="card"><h3>Decision Trace</h3><pre style="white-space:pre-wrap;font-size:12px">${esc(JSON.stringify(s.decisionTrace, null, 2))}</pre></div>
</div></body></html>`;
  }
}
