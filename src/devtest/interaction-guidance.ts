/** UI guidance, not proof of human authorization. Runtime gates remain authoritative. */
export function devTestNextAction(result: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if ([
    'doctor', 'quick_verify', 'audit_billing', 'diagnose_diversion', 'self_test_plan',
    'probe_environment', 'export_repro', 'extract_model_matrix',
    'analyze_git_impact', 'watch_task', 'simulate_chaos', 'audit_config_drift',
    'audit_margin', 'review_pr', 'export_ci_workflow', 'propose_fix_pr', 'report_check_run', 'handle_pr_command', 'post_merge_release',
  ].includes(String(input.action))) return undefined;
  const planId = typeof result.plan_id === 'string' ? result.plan_id : input.plan_id;
  const statusArguments = typeof planId === 'string' ? { action: 'status', plan_id: planId } : undefined;
  if (result.status === 'RUNNING' || String(result.message ?? '').startsWith('RUN_IN_PROGRESS')) {
    if (!statusArguments) return { kind: 'RESOLVE_BLOCKER', reason: '项目有运行中的任务，但当前没有原计划 ID；先取得原计划 ID，不能猜测或删除锁。' };
    return { kind: 'WAIT_FOR_RESULT', status_arguments: statusArguments,
      reason: '先恢复原计划状态；不要重新执行、换幂等键或删除锁。' };
  }

  // 1. 已执行态 (COMPLETED / BLOCKED) 严格对账门禁
  if (result.status !== 'NOT_EXECUTED') {
    const rec = result.reconciliation as { status?: string; difference_reason?: string; mismatches?: string[] } | undefined;
    if (rec?.status === 'MISMATCH') {
      return {
        kind: 'RESOLVE_BLOCKER',
        reason: `报告与账本对账不一致 (MISMATCH)：${rec.difference_reason ?? '分类与数量对账失败'}；禁止判定通过，必须排查对账差异。`,
        mismatches: rec.mismatches,
      };
    }
    return { kind: result.run_id && result.status !== 'BLOCKED' ? 'REVIEW_RESULT' : 'RESOLVE_BLOCKER',
      reason: (result.message as string) ?? '只解释本轮证据和剩余缺口；工具调用完成不等于测试通过。' };
  }

  // 2. 规划态优先级收敛：CLARIFY_REQUIREMENTS -> RESOLVE_BLOCKER -> CONFIRM_EXECUTION
  const assurance = result.requirement_assurance as { entries?: Array<Record<string, unknown>> } | undefined;

  // (1) 需求澄清最高优先级
  if (Array.isArray(assurance?.entries)) {
    const questions = assurance.entries.filter((entry) => ['NEEDS_CONFIRMATION', 'NOT_UNDERSTOOD'].includes(String(entry.status)))
      .map(({ id, statement, source, caseIds, question, reason }) => ({ id, statement, source, case_ids: caseIds, question: question ?? reason }));
    if (questions.length) return { kind: 'CLARIFY_REQUIREMENTS', questions,
      reason: '先保留原文并取得业务答案，更新需求后重新规划；执行授权不能确认业务语义。' };
  }

  // (2) 阻断门禁第二优先级
  const rec = result.reconciliation as { status?: string; difference_reason?: string; mismatches?: string[] } | undefined;
  if (rec?.status === 'MISMATCH') {
    return {
      kind: 'RESOLVE_BLOCKER',
      reason: `报告与账本对账不一致 (MISMATCH)：${rec.difference_reason ?? '分类与数量对账失败'}；排查对账差异。`,
      mismatches: rec.mismatches,
    };
  }

  const project = result.project_assessment as { blockers?: Array<Record<string, unknown>> } | undefined;
  const rawBlockers = project?.blockers ?? [];
  const globalBlockers = rawBlockers.filter((b) =>
    b.scope === 'GLOBAL' || (!b.scope && !b.operationKey && !b.caseId && (!Array.isArray(b.affectedCases) || b.affectedCases.length === 0))
  );
  if (globalBlockers.length) return { kind: 'RESOLVE_BLOCKER', blockers: rawBlockers,
    reason: '项目存在全局阻断；先解决冲突或补齐依赖，不能靠执行确认忽略冲突。' };
  if (!Array.isArray(assurance?.entries)) return { kind: 'RESOLVE_BLOCKER', reason: '需求完整性门禁缺失，需要更新内核。' };

  const counts = result.counts as { executable?: number } | undefined;
  const selected = Array.isArray(result.selected_case_ids) ? (result.selected_case_ids as string[]) : [];
  const readiness = result.readiness_detail as { target_selected?: boolean; reason?: string } | undefined;
  // A zero-network plan deliberately has no connectivity evidence. This is not a runtime PASS.
  const deferredProbe = readiness?.target_selected === true && readiness.reason?.startsWith('DRY_RUN_ENVIRONMENT_NOT_PROBED') === true;

  // 区分全局与局部受阻用例
  const testBlockers = Array.isArray(result.test_blockers) ? (result.test_blockers as Array<Record<string, unknown>>)
    : Array.isArray((result.four_lists as Record<string, unknown>)?.test_blockers)
      ? ((result.four_lists as Record<string, unknown>).test_blockers as Array<Record<string, unknown>>)
      : [];
  const blockedCaseIdSet = new Set<string>();
  for (const tb of testBlockers) {
    if (tb.reason_code === 'PREFLIGHT_BLOCKED' && deferredProbe) continue;
    if (typeof tb.case_id === 'string') blockedCaseIdSet.add(tb.case_id);
  }
  for (const b of rawBlockers) {
    if (Array.isArray(b.affectedCases)) {
      for (const id of b.affectedCases) if (typeof id === 'string') blockedCaseIdSet.add(id);
    } else if (typeof b.caseId === 'string') {
      blockedCaseIdSet.add(b.caseId);
    } else if (b.operationKey || b.scope === 'OPERATION') {
      if (selected.length === 1) blockedCaseIdSet.add(selected[0]);
    }
  }

  const runnableCaseIds = selected.filter((id) => !blockedCaseIdSet.has(id));
  const blockedCases = selected.filter((id) => blockedCaseIdSet.has(id)).map((id) => {
    const matchTb = testBlockers.find((tb) => tb.case_id === id);
    const matchB = rawBlockers.find((b) =>
      (Array.isArray(b.affectedCases) && b.affectedCases.includes(id)) || b.caseId === id || (!b.affectedCases && selected.length === 1)
    );
    return {
      case_id: id,
      reason_code: String(matchTb?.reason_code ?? matchB?.code ?? 'TEST_BLOCKED'),
      reason: String(matchTb?.reason ?? matchB?.message ?? '用例处于局部阻断状态'),
    };
  });

  const untestedItems = Array.isArray(result.untested_items) ? (result.untested_items as Array<Record<string, unknown>>)
    : Array.isArray((result.four_lists as Record<string, unknown>)?.untested_items)
      ? ((result.four_lists as Record<string, unknown>).untested_items as Array<Record<string, unknown>>)
      : [];
  const unselectedCases = untestedItems
    .filter((item) => String(item.reason_code ?? '').startsWith('NOT_SELECTED'))
    .map((item) => ({
      case_id: String(item.case_id),
      reason_code: String(item.reason_code),
      reason: String(item.reason ?? item.status_reason ?? '未入选当前调度批次'),
    }));

  if (result.readiness === 'BLOCKED' && !deferredProbe || !counts?.executable || !selected.length
    || runnableCaseIds.length === 0 || typeof planId !== 'string' || typeof result.plan_hash !== 'string') {
    return {
      kind: 'RESOLVE_BLOCKER',
      blockers: rawBlockers.length ? rawBlockers : undefined,
      reason: runnableCaseIds.length === 0 && selected.length > 0
        ? '计划中全部已选用例均被局部阻断，无任何可用用例可执行；先排查阻断原因。'
        : '没有可确认的可执行计划或环境未就绪；保留缺口，补齐后重新规划。',
    };
  }

  // (3) 准入确认（局部 blocker 放行，但在确认载荷中清楚拆分展示）
  return {
    kind: 'CONFIRM_EXECUTION',
    requires_user_confirmation: true,
    runtime_preflight_after_confirmation: deferredProbe,
    reason: '展示本轮范围、SAFE 只读边界、预算及全部剩余缺口；用户确认同一计划后立即调用下面参数，不重复询问。',
    runnable_cases: runnableCaseIds,
    blocked_cases: blockedCases,
    unselected_cases: unselectedCases,
    remaining_gap_ids: assurance.entries.filter((entry) => !['CONTEXT', 'PASS', 'FAIL'].includes(String(entry.status))).map((entry) => entry.id),
    execute_arguments: { action: 'execute', plan_id: planId, expected_plan_hash: result.plan_hash,
      idempotency_key: planId },
    status_arguments: statusArguments,
  };
}
