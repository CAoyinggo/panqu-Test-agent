// Phase 26.5 Release Gate Drill — 真实发布门禁演练
// 基于真实 Run 的 verdicts（computeReleaseDecision 同款规则）执行发布门禁：
// - PASS（exit=0）：P0 全 PASS、无 Critical Defect、coverage >= 60% → 允许部署
// - REVIEW（exit=2）：存在风险（coverage < 门槛）→ 需人工审批，未批准不部署
// - BLOCK（exit=1）：P0 FAIL / Critical Defect → CI FAILED、Deployment NOT EXECUTED
// 安全验证：Autonomous Agent 在存在 P0 Failure 时尝试继续发布 → Release Gate 仍 BLOCK（不能绕过）。
// 决策由真实执行统计计算（evidence=deterministic-rule + staging 真实落库），BLOCK 由故障注入真实触发。

import { makeRealRunExecutor, computeReleaseDecision, type RealRunSummary, type RunProfile } from './real-run.js';
import type { PlatformBundle } from '../service/factory.js';

export interface ReleaseGateDrillOptions {
  environment?: string;
  profile?: RunProfile;
  /** BLOCK 演练：强制指定 case FAIL（P0 核心链路 → 真实 BLOCK） */
  failCases?: string[];
  failReason?: string;
  /** REVIEW 演练：是否走批准流程（true → 批准后部署；false → 保持 PENDING 未部署） */
  approveReview?: boolean;
  /** 演练身份（Agent 防绕过验证用） */
  requester?: string;
  evidence?: 'staging-real' | 'offline-drill';
}

export interface ReleaseGateDrillResult {
  scenario: string;
  runId: string;
  decision: 'PASS' | 'REVIEW' | 'BLOCK';
  exitCode: number;
  pass: number;
  review: number;
  fail: number;
  totalCases: number;
  coverage: number;
  p0Fail: number;
  criticalDefects: number;
  approvalRequired: boolean;
  approvalId?: string;
  approvalStatus?: 'PENDING' | 'APPROVED' | 'REJECTED';
  deployment: { executed: boolean; reason: string };
  /** Agent 绕过尝试是否被 Gate 拦截 */
  bypassBlocked: boolean;
  audit: { result: string; deniedCount: number };
  evidence: string;
}

/** Release Gate 核心：决策 → 是否允许发布（Agent / 用户 / 平台统一走此入口，不可绕过） */
export function enforceReleaseGate(opts: {
  decision: 'PASS' | 'REVIEW' | 'BLOCK';
  approvalStatus?: 'PENDING' | 'APPROVED' | 'REJECTED';
  environment: string;
}): { allowed: boolean; reason: string } {
  if (opts.decision === 'BLOCK') {
    return { allowed: false, reason: `Release Gate：decision=BLOCK（exit=1）→ CI FAILED，Deployment NOT EXECUTED（${opts.environment}）` };
  }
  if (opts.decision === 'REVIEW' && opts.approvalStatus !== 'APPROVED') {
    return { allowed: false, reason: `Release Gate：decision=REVIEW（exit=2）→ 需人工审批（当前 ${opts.approvalStatus ?? '未审批'}），未批准不发布（${opts.environment}）` };
  }
  return { allowed: true, reason: `Release Gate：decision=${opts.decision} → 允许发布（${opts.environment}）` };
}

/**
 * 真实发布门禁演练：跑一个真实 Run → 真实统计决策 → 执行 Gate（审批 / 部署 / 拦截）
 * 返回结果含 approval 状态、部署是否执行、Agent 绕过是否被拦截、审计结果。
 */
export async function runReleaseGateDrill(
  bundle: PlatformBundle,
  opts: ReleaseGateDrillOptions = {},
): Promise<ReleaseGateDrillResult> {
  const environment = opts.environment ?? 'test';
  const profile = opts.profile ?? 'sanity';
  const evidence = opts.evidence ?? 'offline-drill';
  const requester = opts.requester ?? 'ai-test-platform';
  const failCases = opts.failCases ?? [];

  await bundle.testAssets.importCatalog();
  const { runId } = await bundle.service.createRun({
    projectId: 'wan3', environment, trigger: profile === 'autonomous' ? 'autonomous' : 'manual',
    feature: `release-gate-${profile}`, actor: requester, role: 'QA',
  });
  const exec = makeRealRunExecutor(bundle, profile, {
    environment, failCases, failReason: opts.failReason ?? '故障注入（release gate drill）：P0 核心链路回归',
  });
  const summary = await exec({ runId, projectId: 'wan3', environment, feature: `release-gate-${profile}` });
  const decision = summary.decision;

  let approvalId: string | undefined;
  let approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | undefined;
  let deploymentExecuted = false;
  let deploymentReason = '';

  if (decision === 'PASS') {
    const gate = enforceReleaseGate({ decision, environment });
    deploymentExecuted = gate.allowed;
    deploymentReason = gate.reason;
  } else if (decision === 'REVIEW') {
    // 创建审批（Approval Required），未批准不部署
    const { approval } = await bundle.approvals.request({
      runId, action: 'release', riskLevel: 'risky', environment,
      requester, reason: summary.decisionReason,
    });
    approvalId = approval.approvalId;
    approvalStatus = approval.status;
    // 26.7：审批请求真实发布通知（事件总线 → 飞书/多通道）
    await bundle.bus.publish({
      type: 'ApprovalRequested', runId, approvalId,
      data: { action: 'release', environment, reason: summary.decisionReason, projectId: 'wan3' },
    });
    if (opts.approveReview) {
      const decided = await bundle.approvals.approve(approval.approvalId, 'qa-lead');
      approvalStatus = decided.status;
    }
    const gate = enforceReleaseGate({ decision, environment, approvalStatus });
    deploymentExecuted = gate.allowed;
    deploymentReason = gate.reason;
  } else {
    // BLOCK：禁止部署；审计 denied 已在 real-run 记录（action=release result=denied）
    const gate = enforceReleaseGate({ decision, environment });
    deploymentExecuted = gate.allowed;
    deploymentReason = gate.reason;
  }

  // 安全验证：Autonomous Agent 在存在 P0 Failure 时仍尝试发布 → 必须被 Gate 拦截（不能绕过）
  const bypass = enforceReleaseGate({ decision, environment, approvalStatus });
  const bypassBlocked = !bypass.allowed;
  if (bypassBlocked) {
    await bundle.audit.record({
      actor: 'autonomous-agent', role: 'AUTONOMOUS', action: 'release',
      resource: runId, environment, result: 'denied',
      detail: { runId, decision, bypassAttempted: true, gateReason: bypass.reason }, traceId: `trace-${runId}`,
    });
  }

  const deniedAudits = (await bundle.audit.search({ runId })).filter(
    (a) => a.action === 'release' && a.result === 'denied',
  );

  return {
    scenario: `GATE-${profile}${failCases.length > 0 ? '-BLOCK' : ''}`,
    runId,
    decision,
    exitCode: summary.exitCode,
    pass: summary.pass,
    review: summary.review,
    fail: summary.fail,
    totalCases: summary.totalCases,
    coverage: summary.coverage,
    p0Fail: summary.p0Fail,
    criticalDefects: summary.criticalDefects,
    approvalRequired: decision === 'REVIEW',
    approvalId,
    approvalStatus,
    deployment: { executed: deploymentExecuted, reason: deploymentReason },
    bypassBlocked,
    audit: { result: decision === 'PASS' ? 'success' : decision === 'REVIEW' ? 'pending' : 'denied', deniedCount: deniedAudits.length },
    evidence,
  };
}

/** 汇总多个 Gate 演练（供 CLI / 报告） */
export function gateDrillSummary(results: ReleaseGateDrillResult[]): {
  total: number;
  pass: number;
  review: number;
  block: number;
  deploymentNotExecuted: number;
  bypassBlocked: number;
  allPass: boolean;
} {
  return {
    total: results.length,
    pass: results.filter((r) => r.decision === 'PASS').length,
    review: results.filter((r) => r.decision === 'REVIEW').length,
    block: results.filter((r) => r.decision === 'BLOCK').length,
    deploymentNotExecuted: results.filter((r) => !r.deployment.executed).length,
    bypassBlocked: results.filter((r) => r.bypassBlocked).length,
    allPass: results.every((r) =>
      (r.decision === 'PASS' && r.deployment.executed) ||
      (r.decision === 'REVIEW' && r.approvalRequired && r.approvalStatus === 'PENDING' && !r.deployment.executed) ||
      (r.decision === 'BLOCK' && !r.deployment.executed && r.bypassBlocked),
    ),
  };
}
