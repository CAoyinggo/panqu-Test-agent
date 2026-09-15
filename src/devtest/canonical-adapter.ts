/**
 * DevTest Canonical Adapter
 *
 * 职责：
 * 将 DevTest 权威账本（CoverageLedger）无损转换为 canonical RunResult。
 * 不重新计算用例状态，不重新遍历计算覆盖率，严格保留原始 ID 与时间戳。
 */

import type {
  CaseResult,
  CoverageResult,
  RequirementResult,
  RunResult,
  RunLifecycleStatus,
} from '../contracts/execution-result.js';
import type {
  CoverageLedgerSummary,
  TestPointCoverageLedgerItem,
  RequirementFactCoverageLedgerItem,
  CoverageLedgerReconciliation,
} from './coverage-ledger.js';

export interface CoverageLedgerAdapterInput {
  runId: string;
  lifecycleStatus?: RunLifecycleStatus;
  conclusion?: string;
  items: TestPointCoverageLedgerItem[];
  requirementLedger?: RequirementFactCoverageLedgerItem[];
  summary: CoverageLedgerSummary;
  reconciliation: CoverageLedgerReconciliation;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
}

export function coverageLedgerToCanonicalRunResult(
  input: CoverageLedgerAdapterInput,
): RunResult {
  const caseResults: CaseResult[] = input.items.map((item) => ({
    case_id: item.caseId,
    requirement_ids: item.requirementId === 'UNTRACED_CASE' ? [] : [item.requirementId],
    execution_status: item.finalStatus,
    executed: item.executed,
    evidence: item.collectedEvidence.map((ref) => ({ type: 'EVIDENCE', ref })),
    blocked_reason: item.finalStatus === 'BLOCKED' ? item.statusReason : undefined,
    non_execution_reason: item.finalStatus === 'NOT_EXECUTED' ? item.statusReason : undefined,
  }));

  const requirementResults: RequirementResult[] = (input.requirementLedger ?? []).map((req) => ({
    requirement_id: req.factId,
    case_ids: req.linkedCaseIds,
    status:
      req.status === 'PASSED'
        ? 'PASS'
        : req.status === 'CONFIRMED_BUG'
          ? 'FAIL'
          : req.status === 'TEST_BLOCKED'
            ? 'BLOCKED'
            : 'NOT_EXECUTED',
    coverage_status:
      req.status === 'PASSED'
        ? 'COVERED'
        : req.status === 'TEST_BLOCKED'
          ? 'BLOCKED'
          : req.linkedCaseIds.length > 0
            ? 'PARTIALLY_COVERED'
            : 'UNCOVERED',
    uncovered_or_blocked_reason: req.statusReason,
  }));

  const coverage: CoverageResult = {
    total: input.summary.totalPlanned,
    passed: input.summary.totalPassed,
    failed: input.summary.totalConfirmedBugs,
    blocked: input.summary.totalTestBlocked,
    not_executed: input.summary.totalUntested,
    covered_requirements: (input.requirementLedger ?? []).filter((r) => r.status === 'PASSED').length,
    uncovered_requirements: (input.requirementLedger ?? []).filter((r) => r.status !== 'PASSED').length,
    reconciliation_status: input.reconciliation.status,
  };

  return {
    run_id: input.runId,
    lifecycle_status: input.lifecycleStatus ?? (input.reconciliation.status === 'MISMATCH' ? 'BLOCKED' : 'COMPLETED'),
    conclusion: input.conclusion ?? 'COMPLETED',
    requirement_results: requirementResults,
    case_results: caseResults,
    coverage,
    created_at: input.createdAt ?? new Date().toISOString(),
    started_at: input.startedAt,
    completed_at: input.completedAt,
    reconciliation: {
      status: input.reconciliation.status,
      reconciled: input.reconciliation.reconciled,
      mismatches: input.reconciliation.mismatches ?? [],
    },
  };
}
