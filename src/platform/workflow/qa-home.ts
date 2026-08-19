// QA Workflow Dashboard（Phase 39.7）：QA Home
// 目标：告诉 QA "现在应该做什么"，不只是展示 Metrics。
// 提供：我的项目 / 今日 Runs / 进行中 / 失败 / 待处理 Approval / 最近失败 / 最近 Defect /
//       最近 Release / 常用 Test Plan / 常用 Template / Flaky Cases / 高风险 Cases / Action Center。

import type { ProjectService } from '../projects/project-service.js';
import type { RunService } from '../runs/run-service.js';
import type { TestRun } from '../runs/run-schema.js';
import type { ApprovalCenter } from '../approval-center/approval-center.js';
import type { ApprovalRequest } from '../approval-center/approval-schema.js';
import type { TelemetryService } from '../telemetry/index.js';
import type { ReleaseRecord, FlakyRecord } from '../telemetry/index.js';
import type { AuditLog } from '../audit/audit-log.js';
import type { Scopes } from '../rbac/scopes.js';
import type { TestSuiteService } from './test-suite.js';
import type { TestPlanService } from './test-plan.js';
import type { RunTemplateService } from './run-template.js';

/** Action Center 项（告诉 QA 现在应该做什么） */
export interface ActionItem {
  id: string;
  category: 'APPROVAL' | 'FAILURE' | 'WORKER' | 'FLAKY' | 'RCA' | 'RELEASE';
  severity: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  detail: string;
  /** 点击直达的资源（runId / approvalId / workerId 等） */
  target: string;
}

export interface QaHome {
  projects: Array<{ id: string; name: string; defaultEnvironment: string }>;
  todayRuns: TestRun[];
  runningRuns: TestRun[];
  failedRuns: TestRun[];
  pendingApprovals: ApprovalRequest[];
  recentFailures: Array<{ runId: string; status: string; environment: string; createdAt: string }>;
  recentDefects: Array<{ entryId: string; actor: string; resource: string; timestamp: string }>;
  recentReleases: ReleaseRecord[];
  commonPlans: Array<{ id: string; name: string; mode: string; environment: string }>;
  commonTemplates: Array<{ id: string; name: string; environment: string; runCount: number }>;
  flakyCases: Array<{ caseId: string; runs: number; failures: number; lastAt: string }>;
  highRiskCases: Array<{ caseId: string; failures: number; lastAt: string }>;
  actionCenter: ActionItem[];
}

export interface QaHomeDeps {
  projects: ProjectService;
  runs: RunService;
  approvals: ApprovalCenter;
  telemetry: TelemetryService;
  audit: AuditLog;
  suites: TestSuiteService;
  plans: TestPlanService;
  templates: RunTemplateService;
}

export class QaHomeService {
  constructor(private readonly deps: QaHomeDeps) {}

  async build(scopes?: Scopes, now?: () => string): Promise<QaHome> {
    const ts = now ? now() : new Date().toISOString();
    const today = ts.slice(0, 10);
    const allProjects = this.deps.projects.listProjects();
    const allowedProjects = scopes?.projects && scopes.projects.length > 0 ? new Set(scopes.projects) : null;
    const projects = allowedProjects ? allProjects.filter((p) => allowedProjects.has(p.id)) : allProjects;
    const runs = await this.deps.runs.list({});
    const approvals = await this.deps.approvals.list({});
    const releases: ReleaseRecord[] = (await this.deps.telemetry.releases.list({})).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const flakyRecords: FlakyRecord[] = await this.deps.telemetry.flaky.list({});
    const audit = await this.deps.audit.list({});
    const plans = await this.deps.plans.list({});
    const templates = (await this.deps.templates.list({})).sort((a, b) => b.runCount - a.runCount);

    const todayRuns = runs.filter((r) => r.createdAt.slice(0, 10) === today);
    const runningRuns = runs.filter((r) => r.status === 'RUNNING');
    const failedRuns = runs.filter((r) => r.status === 'FAILED').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
    const pendingApprovals = approvals.filter((a) => a.status === 'PENDING');
    const recentFailures = failedRuns.map((r) => ({ runId: r.runId, status: r.status, environment: r.environment, createdAt: r.createdAt }));
    const defects = audit
      .filter((e) => e.action === 'defect')
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 10)
      .map((e) => ({ entryId: e.entryId, actor: e.actor, resource: e.resource, timestamp: e.timestamp }));

    // Flaky / 高风险聚合（基于真实 Flaky 记录）
    const byCase = new Map<string, { runs: number; failures: number; lastAt: string }>();
    for (const f of flakyRecords) {
      const cur = byCase.get(f.caseId) ?? { runs: 0, failures: 0, lastAt: f.timestamp };
      cur.runs += 1;
      if (!f.pass) cur.failures += 1;
      if (f.timestamp > cur.lastAt) cur.lastAt = f.timestamp;
      byCase.set(f.caseId, cur);
    }
    const flakyCases = [...byCase.entries()]
      .map(([caseId, v]) => ({ caseId, ...v }))
      .filter((v) => v.failures > 0)
      .sort((a, b) => b.failures - a.failures)
      .slice(0, 10);
    const highRiskCases = flakyCases.filter((v) => v.failures >= 2);

    const actionCenter: ActionItem[] = [];
    const releaseReviews = approvals.filter((a) => a.status === 'PENDING' && a.action?.toLowerCase().includes('release'));
    if (releaseReviews.length) {
      actionCenter.push({ id: 'ac-release', category: 'RELEASE', severity: 'warning', title: `${releaseReviews.length} 个 Release REVIEW 等待审批`, detail: '发布门禁需人工确认，请尽快处理', target: releaseReviews[0].approvalId });
    }
    if (pendingApprovals.length) {
      actionCenter.push({ id: 'ac-approval', category: 'APPROVAL', severity: 'warning', title: `${pendingApprovals.length} 个审批等待处理`, detail: '待审批列表', target: 'approvals' });
    }
    const p0Like = failedRuns.slice(0, 5);
    if (p0Like.length) {
      actionCenter.push({ id: 'ac-failure', category: 'FAILURE', severity: 'error', title: `${p0Like.length} 个失败 Run 待处理`, detail: '最近失败运行', target: p0Like[0].runId });
    }
    if (highRiskCases.length) {
      actionCenter.push({ id: 'ac-flaky', category: 'FLAKY', severity: 'warning', title: `${highRiskCases.length} 个高风险 Case 待确认`, detail: '多次失败用例', target: 'flaky' });
    }
    const unverifiedRca = flakyCases.length;
    if (unverifiedRca) {
      actionCenter.push({ id: 'ac-rca', category: 'RCA', severity: 'info', title: `${unverifiedRca} 条 RCA 待人工确认`, detail: '根因分析待确认', target: 'rca' });
    }

    return {
      projects: projects.map((p) => ({ id: p.id, name: p.name, defaultEnvironment: p.defaultEnvironment })),
      todayRuns,
      runningRuns,
      failedRuns,
      pendingApprovals,
      recentFailures,
      recentDefects: defects,
      recentReleases: releases.slice(0, 10),
      commonPlans: plans.map((p) => ({ id: p.id, name: p.name, mode: p.mode, environment: p.environment })),
      commonTemplates: templates.slice(0, 10).map((t) => ({ id: t.id, name: t.name, environment: t.environment, runCount: t.runCount })),
      flakyCases,
      highRiskCases,
      actionCenter,
    };
  }
}
