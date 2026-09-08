/** UI guidance, not proof of human authorization. Runtime gates remain authoritative. */
export function devTestNextAction(result: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (input.action === 'doctor') return undefined;
  const planId = typeof result.plan_id === 'string' ? result.plan_id : input.plan_id;
  const statusArguments = typeof planId === 'string' ? { action: 'status', plan_id: planId } : undefined;
  if (result.status === 'RUNNING' || String(result.message ?? '').startsWith('RUN_IN_PROGRESS')) {
    if (!statusArguments) return { kind: 'RESOLVE_BLOCKER', reason: '项目有运行中的任务，但当前没有原计划 ID；先取得原计划 ID，不能猜测或删除锁。' };
    return { kind: 'WAIT_FOR_RESULT', status_arguments: statusArguments,
      reason: '先恢复原计划状态；不要重新执行、换幂等键或删除锁。' };
  }
  if (result.status !== 'NOT_EXECUTED') {
    return { kind: result.run_id ? 'REVIEW_RESULT' : 'RESOLVE_BLOCKER',
      reason: result.message ?? '只解释本轮证据和剩余缺口；工具调用完成不等于测试通过。' };
  }
  const assurance = result.requirement_assurance as { entries?: Array<Record<string, unknown>> } | undefined;
  if (!Array.isArray(assurance?.entries)) return { kind: 'RESOLVE_BLOCKER', reason: '需求完整性门禁缺失，需要更新内核。' };
  const questions = assurance.entries.filter((entry) => ['NEEDS_CONFIRMATION', 'NOT_UNDERSTOOD'].includes(String(entry.status)))
    .map(({ id, statement, source, caseIds, question, reason }) => ({ id, statement, source, case_ids: caseIds, question: question ?? reason }));
  if (questions.length) return { kind: 'CLARIFY_REQUIREMENTS', questions,
    reason: '先保留原文并取得业务答案，更新需求后重新规划；执行授权不能确认业务语义。' };
  const counts = result.counts as { executable?: number } | undefined;
  const selected = result.selected_case_ids;
  const readiness = result.readiness_detail as { target_selected?: boolean; reason?: string } | undefined;
  // A zero-network plan deliberately has no connectivity evidence. This is not a runtime PASS.
  const deferredProbe = readiness?.target_selected === true && readiness.reason?.startsWith('DRY_RUN_ENVIRONMENT_NOT_PROBED') === true;
  if (result.readiness === 'BLOCKED' && !deferredProbe || !counts?.executable || !Array.isArray(selected) || !selected.length
    || typeof planId !== 'string' || typeof result.plan_hash !== 'string') {
    return { kind: 'RESOLVE_BLOCKER', reason: '没有可确认的可执行计划或环境未就绪；保留缺口，补齐后重新规划。' };
  }
  return { kind: 'CONFIRM_EXECUTION', requires_user_confirmation: true,
    runtime_preflight_after_confirmation: deferredProbe,
    reason: '展示本轮范围、SAFE 只读边界、预算及全部剩余缺口；用户确认同一计划后立即调用下面参数，不重复询问。',
    remaining_gap_ids: assurance.entries.filter((entry) => !['CONTEXT', 'PASS', 'FAIL'].includes(String(entry.status))).map((entry) => entry.id),
    execute_arguments: { action: 'execute', plan_id: planId, expected_plan_hash: result.plan_hash,
      idempotency_key: planId }, status_arguments: statusArguments };
}
