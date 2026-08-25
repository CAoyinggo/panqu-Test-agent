import { CodedError, ErrorCode } from '../../core/errors.js';
import type { PlatformRunExecutionRecord, TestRun } from './run-schema.js';

export interface RunCompletionEligibility {
  eligible: boolean;
  reasons: string[];
}

const COMPLETABLE_OUTCOMES = new Set(['PASSED', 'FAILED']);

/**
 * COMPLETED 的唯一确定性契约。任何调用方、Worker 或测试均不能绕过此 Guard。
 */
export function evaluateRunCompletionEligibility(run: TestRun): RunCompletionEligibility {
  const reasons: string[] = [];
  const record = run.executionRecord;

  if (run.executionMode !== 'VERIFIED_AGENT') reasons.push('executionMode 不是 VERIFIED_AGENT');
  if (!record || record.executionMode !== 'VERIFIED_AGENT') reasons.push('缺少 VERIFIED_AGENT 执行记录');
  if (!record?.requirementEvidence?.exists || !record.requirementEvidence.requirementId?.trim()) {
    reasons.push('缺少 Requirement Evidence');
  }
  if (record?.policyGate?.status !== 'ALLOW') reasons.push('Policy Gate 未 ALLOW');
  if (!record?.execution?.executionId?.trim() || record.execution.started !== true || record.execution.finished !== true) {
    reasons.push('Execution 未完整开始并结束');
  }
  if (!Array.isArray(record?.evidence) || record.evidence.length === 0) reasons.push('缺少 Execution Evidence');
  if (!record?.outcome?.exists || !record.outcome.outcomeId?.trim()) reasons.push('缺少 Outcome');
  if (!record?.outcome || !COMPLETABLE_OUTCOMES.has(record.outcome.executionStatus)) {
    reasons.push(`Outcome 状态不可完成：${record?.outcome?.executionStatus ?? 'MISSING'}`);
  }
  if (!record?.outcome || record.outcome.executedCount <= 0) reasons.push('Outcome executedCount 必须大于 0');

  const evidenceIds = new Set<string>();
  const executableEvidence = record?.evidence?.filter((item) => {
    const businessAssertions = item.assertionResults.filter((assertion) => (
      assertion.kind === 'BUSINESS'
      || (assertion.kind === undefined && !/^执行后核对[:：]/.test(assertion.name))
    ));
    const identityValid = Boolean(
      item.evidenceId?.trim()
      && item.caseId?.trim()
      && item.runId === run.runId
      && item.processor?.trim()
      && item.timestamp?.trim(),
    );
    if (item.evidenceId?.trim()) evidenceIds.add(item.evidenceId);
    const assertionsValid = businessAssertions.length > 0
      && item.effectiveAssertions === businessAssertions.length;
    const statusValid = item.executionStatus === 'PASS'
      ? businessAssertions.every((assertion) => assertion.pass)
      : item.executionStatus === 'FAIL'
        ? businessAssertions.some((assertion) => !assertion.pass)
        : false;
    return identityValid
      && item.executed === true
      && item.processorInvoked === true
      && assertionsValid
      && statusValid;
  }) ?? [];
  if (record?.evidence && evidenceIds.size !== record.evidence.length) {
    reasons.push('Evidence ID 缺失或重复');
  }
  if (record?.evidence && executableEvidence.length !== record.evidence.length) {
    reasons.push('存在未绑定当前 Run 或缺少真实 Processor/Assertion 的 Evidence');
  }
  if (record?.outcome && executableEvidence.length !== record.outcome.executedCount) {
    reasons.push('executedCount 与可执行 Evidence 数量不一致');
  }
  if (record?.outcome?.executionStatus === 'PASSED') {
    const invalidPass = executableEvidence.some((item) => item.executionStatus !== 'PASS');
    if (invalidPass || record.result !== 'PASS') reasons.push('PASSED Outcome 与断言/结果不一致');
  }
  if (record?.outcome?.executionStatus === 'FAILED') {
    const hasFailedEvidence = executableEvidence.some((item) => item.executionStatus === 'FAIL');
    if (!hasFailedEvidence || record.result !== 'FAIL') reasons.push('FAILED Outcome 与断言/结果不一致');
  }

  return { eligible: reasons.length === 0, reasons };
}

export function assertRunCompletionEligibility(run: TestRun): PlatformRunExecutionRecord {
  const result = evaluateRunCompletionEligibility(run);
  if (!result.eligible || !run.executionRecord) {
    throw new CodedError(
      ErrorCode.CONFLICT,
      `Run ${run.runId} 不满足 Completion Contract：${result.reasons.join('；')}`,
    );
  }
  return run.executionRecord;
}
