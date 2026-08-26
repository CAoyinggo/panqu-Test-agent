import type { AcceptanceCaseExecutionResult } from '../acceptance/api-processor.js';
import type { DevTestBaselineSnapshot } from './baseline.js';
import type { DevTestCaseReliability, DevTestReliabilitySummary } from './types.js';

export function buildTestReliability(input: {
  baseline?: DevTestBaselineSnapshot;
  results: readonly AcceptanceCaseExecutionResult[];
  now?: string;
}): DevTestReliabilitySummary {
  const previous = new Map((input.baseline?.cases ?? []).map((item) => [item.caseId, item.history ?? []]));
  const currentAt = input.now ?? new Date().toISOString();
  const ids = new Set([...previous.keys(), ...input.results.map((item) => item.caseId)]);
  const cases: DevTestCaseReliability[] = [...ids].map((caseId) => {
    const result = input.results.find((item) => item.caseId === caseId);
    const history = [...(previous.get(caseId) ?? []), ...(result ? [{ runId: result.runId ?? 'current', status: result.status,
      durationMs: result.durationMs ?? 0, at: currentAt }] : [])].slice(-20);
    const decisive = history.filter((item) => item.status === 'PASS' || item.status === 'FAIL');
    const passes = decisive.filter((item) => item.status === 'PASS').length;
    const failures = decisive.filter((item) => item.status === 'FAIL').length;
    let transitions = 0;
    for (let index = 1; index < decisive.length; index++) if (decisive[index].status !== decisive[index - 1].status) transitions += 1;
    const flakeRate = decisive.length > 1 ? transitions / (decisive.length - 1) : 0;
    const failureRate = decisive.length ? failures / decisive.length : 0;
    const status: DevTestCaseReliability['status'] = decisive.length < 2 ? 'UNKNOWN'
      : flakeRate >= 0.25 && passes > 0 && failures > 0 ? 'FLAKY'
        : failureRate >= 0.7 ? 'UNSTABLE' : 'STABLE';
    return { caseId, runs: history.length, passRate: decisive.length ? passes / decisive.length : 0,
      failureRate, flakeRate, avgDurationMs: history.length ? Math.round(history.reduce((sum, item) => sum + item.durationMs, 0) / history.length) : 0,
      lastRun: history.at(-1)?.at, status };
  });
  const stable = cases.filter((item) => item.status === 'STABLE').length;
  const flaky = cases.filter((item) => item.status === 'FLAKY').length;
  const unstable = cases.filter((item) => item.status === 'UNSTABLE').length;
  const unknown = cases.filter((item) => item.status === 'UNKNOWN').length;
  const known = stable + flaky + unstable;
  const score = known ? Math.round((stable + flaky * 0.5) / known * 100) : 100;
  return { score, stable, flaky, unstable, unknown, cases };
}
