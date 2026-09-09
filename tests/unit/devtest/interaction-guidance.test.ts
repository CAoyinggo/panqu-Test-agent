import { describe, expect, it } from 'vitest';
import { devTestNextAction } from '../../../src/devtest/interaction-guidance.js';

const plan = {
  status: 'NOT_EXECUTED', plan_id: 'PLAN-confirm-once', plan_hash: 'a'.repeat(64),
  readiness: 'READY', counts: { executable: 1 }, selected_case_ids: ['CASE-1'],
  requirement_assurance: { entries: [{ id: 'F-1', statement: '返回 200', status: 'NOT_TESTED', caseIds: ['CASE-1'] }] },
};

describe('deterministic Trae next-action guidance', () => {
  it('does not ask for execution confirmation when Panqu source binding conflicts', () => {
    const blockers = [{ code: 'PANQU_METHOD_CONFLICT', operationKey: 'GET /submit' }];
    const next = devTestNextAction({ ...plan, project_assessment: { blockers } }, { action: 'plan' });
    expect(next).toMatchObject({ kind: 'RESOLVE_BLOCKER', blockers });
    expect(next).not.toHaveProperty('execute_arguments');
  });
  it('returns stable executable arguments from the actual plan, including on status recovery', () => {
    const next = devTestNextAction(plan, { action: 'plan' });
    expect(next).toMatchObject({ kind: 'CONFIRM_EXECUTION', requires_user_confirmation: true,
      execute_arguments: { action: 'execute', plan_id: plan.plan_id, expected_plan_hash: plan.plan_hash, idempotency_key: plan.plan_id } });
    expect(devTestNextAction(plan, { action: 'status', plan_id: plan.plan_id })).toEqual(next);
    expect(next?.remaining_gap_ids).toEqual(['F-1']);
  });

  it.each(['NEEDS_CONFIRMATION', 'NOT_UNDERSTOOD'])('routes %s to a sourced business question, with no execute arguments', (status) => {
    const entry = { id: 'UNKNOWN', statement: '删除后如何计费', source: { line: 7 }, status, caseIds: [], question: '是否停止计费？' };
    const next = devTestNextAction({ ...plan, requirement_assurance: { entries: [entry] } }, { action: 'plan' });
    expect(next).toMatchObject({ kind: 'CLARIFY_REQUIREMENTS', questions: [
      { id: entry.id, statement: entry.statement, source: entry.source, case_ids: [], question: entry.question },
    ] });
    expect(next).not.toHaveProperty('execute_arguments');
  });

  it.each([{ readiness: 'BLOCKED' }, { counts: { executable: 0 } }, { selected_case_ids: [] }, { requirement_assurance: undefined }])(
    'does not request execution approval when an essential prerequisite is absent: %j', (missing) => {
      const next = devTestNextAction({ ...plan, ...missing }, { action: 'plan' });
      expect(next?.kind).toBe('RESOLVE_BLOCKER'); expect(next).not.toHaveProperty('execute_arguments');
    });

  it('does not erase uncovered requirements when some clear checks can execute', () => {
    const gap = { id: 'UNCOVERED', status: 'UNCOVERED', statement: '需要审计证据', caseIds: [] };
    const next = devTestNextAction({ ...plan, requirement_assurance: { entries: [...plan.requirement_assurance.entries, gap] } }, { action: 'plan' });
    expect(next?.kind).toBe('CONFIRM_EXECUTION'); expect(next?.remaining_gap_ids).toContain(gap.id);
  });

  it('distinguishes zero-network planning from missing runtime, without marking the environment READY', () => {
    const notProbed = { ...plan, readiness: 'BLOCKED', readiness_detail: {
      target_selected: true, reason: 'DRY_RUN_ENVIRONMENT_NOT_PROBED: plan only' } };
    expect(devTestNextAction(notProbed, { action: 'plan' })).toMatchObject({
      kind: 'CONFIRM_EXECUTION', runtime_preflight_after_confirmation: true });
    expect(notProbed.readiness).toBe('BLOCKED');
    expect(devTestNextAction({ ...notProbed, readiness_detail: { target_selected: false,
      reason: 'DRY_RUN_ENVIRONMENT_NOT_PROBED' } }, { action: 'plan' })?.kind).toBe('RESOLVE_BLOCKER');
  });

  it.each([{ status: 'RUNNING' }, { status: 'BLOCKED', message: 'RUN_IN_PROGRESS: locked' }])(
    'recovers in-progress execution with status rather than another execute', (result) => {
      const next = devTestNextAction(result, { action: 'execute', plan_id: plan.plan_id });
      expect(next).toMatchObject({ kind: 'WAIT_FOR_RESULT', status_arguments: { action: 'status', plan_id: plan.plan_id } });
      expect(next).not.toHaveProperty('execute_arguments');
    });

  it('does not offer execution after a completed result or stale-plan failure', () => {
    expect(devTestNextAction({ status: 'COMPLETED', run_id: 'RUN-1' }, { action: 'execute' })?.kind).toBe('REVIEW_RESULT');
    const stale = devTestNextAction({ status: 'BLOCKED', message: 'STALE_PLAN: source changed' }, { action: 'execute' });
    expect(stale?.kind).toBe('RESOLVE_BLOCKER'); expect(stale).not.toHaveProperty('execute_arguments');
  });

  it('does not invent a status request when a competing run has no known plan ID', () => {
    const next = devTestNextAction({ status: 'BLOCKED', message: 'RUN_IN_PROGRESS: locked' }, { action: 'plan' });
    expect(next?.kind).toBe('RESOLVE_BLOCKER'); expect(next).not.toHaveProperty('status_arguments');
  });
});
