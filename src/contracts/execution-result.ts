/**
 * Canonical Execution Result Contracts
 * 零业务依赖的唯一执行事实契约层
 *
 * 核心设计原则：
 * 1. 状态与覆盖率由权威入口只计算一次，其他模块只读或做无损格式投影；
 * 2. 外部仅支持四种 ExecutionStatus：PASS | FAIL | BLOCKED | NOT_EXECUTED；
 * 3. SKIPPED 不是独立公共状态，必须作为 NOT_EXECUTED 的 reason 保存；
 * 4. 流程生命周期 COMPLETED 与用例 ExecutionStatus 正交，COMPLETED 不表示全部用例 PASS；
 * 5. 稳定 ID（requirement_id, case_id, run_id）与 ISO 8601 时间戳，在适配过程中严格保持身份不变。
 */

export const CANONICAL_EXECUTION_STATUSES = [
  'PASS',
  'FAIL',
  'BLOCKED',
  'NOT_EXECUTED',
] as const;

export type ExecutionStatus = (typeof CANONICAL_EXECUTION_STATUSES)[number];

export const CANONICAL_RUN_LIFECYCLE_STATUSES = [
  'NOT_STARTED',
  'RUNNING',
  'COMPLETED',
  'BLOCKED',
  'FAILED',
] as const;

export type RunLifecycleStatus = (typeof CANONICAL_RUN_LIFECYCLE_STATUSES)[number];

export interface ExecutionEvidenceRef {
  type: string;
  ref?: string;
  digest?: string;
  detail?: string;
}

export interface CaseResult {
  case_id: string;
  requirement_ids: string[];
  execution_status: ExecutionStatus;
  executed: boolean;
  evidence?: ExecutionEvidenceRef[];
  blocked_reason?: string;
  non_execution_reason?: string;
  started_at?: string;
  completed_at?: string;
}

export interface RequirementResult {
  requirement_id: string;
  case_ids: string[];
  status: ExecutionStatus;
  coverage_status: 'COVERED' | 'PARTIALLY_COVERED' | 'UNCOVERED' | 'BLOCKED';
  uncovered_or_blocked_reason?: string;
}

export interface CoverageResult {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  not_executed: number;
  covered_requirements: number;
  uncovered_requirements: number;
  reconciliation_status: 'MATCH' | 'MISMATCH' | 'NOT_COMPARABLE';
}

export interface RunResult {
  run_id: string;
  lifecycle_status: RunLifecycleStatus;
  conclusion: string;
  requirement_results: RequirementResult[];
  case_results: CaseResult[];
  coverage: CoverageResult;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  reconciliation?: {
    status: 'MATCH' | 'MISMATCH' | 'NOT_COMPARABLE';
    reconciled: boolean;
    mismatches: string[];
  };
}

/**
 * 校验 CaseResult 的核心不变量约束
 */
export function assertValidCaseResult(caseResult: CaseResult): void {
  if (!caseResult.case_id) {
    throw new Error('INVALID_CASE_RESULT: case_id must not be empty');
  }
  if (!CANONICAL_EXECUTION_STATUSES.includes(caseResult.execution_status)) {
    throw new Error(`INVALID_CASE_RESULT: unknown execution_status "${caseResult.execution_status}"`);
  }
  if ((caseResult.execution_status === 'PASS' || caseResult.execution_status === 'FAIL') && !caseResult.executed) {
    throw new Error(`INVALID_CASE_RESULT: status ${caseResult.execution_status} requires executed = true`);
  }
  if (caseResult.execution_status === 'NOT_EXECUTED' && caseResult.executed) {
    throw new Error('INVALID_CASE_RESULT: status NOT_EXECUTED requires executed = false');
  }
}

/**
 * 校验 CoverageResult 的计数恒等式与核心不变量
 */
export function assertValidCoverageResult(coverage: CoverageResult): void {
  const sum = coverage.passed + coverage.failed + coverage.blocked + coverage.not_executed;
  if (sum !== coverage.total) {
    throw new Error(
      `INVALID_COVERAGE_RESULT: sum of status counts (${sum}) does not match total (${coverage.total})`,
    );
  }
}

/**
 * 校验 RunResult 的整体一致性
 */
export function assertValidRunResult(runResult: RunResult): void {
  if (!runResult.run_id) {
    throw new Error('INVALID_RUN_RESULT: run_id must not be empty');
  }
  if (!CANONICAL_RUN_LIFECYCLE_STATUSES.includes(runResult.lifecycle_status)) {
    throw new Error(`INVALID_RUN_RESULT: unknown lifecycle_status "${runResult.lifecycle_status}"`);
  }
  assertValidCoverageResult(runResult.coverage);
  for (const c of runResult.case_results) {
    assertValidCaseResult(c);
  }
}
