/**
 * Agent Execution Canonical Adapter
 *
 * 职责：
 * 将 canonical CaseResult 最薄转换为 Agent 层所需的 CaseExecutionResult。
 * 纯只读无副作用转换，不重新派生状态或覆盖率，保持 ID 稳定。
 */

import type { CaseResult } from '../../contracts/execution-result.js';
import type { CaseExecutionResult } from './execution-schema.js';

export function toAgentCaseResult(
  canonical: CaseResult,
  fallbackName?: string,
): CaseExecutionResult {
  const isPass = canonical.execution_status === 'PASS';
  const isFail = canonical.execution_status === 'FAIL';

  return {
    caseId: canonical.case_id,
    name: fallbackName ?? canonical.case_id,
    pass: isPass,
    passRate: isPass ? 1 : 0,
    executed: canonical.executed,
    status: canonical.execution_status,
    timestamp: canonical.completed_at ?? canonical.started_at,
    blockedReason: canonical.blocked_reason ?? canonical.non_execution_reason,
  };
}
