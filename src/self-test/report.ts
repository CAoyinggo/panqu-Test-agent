import type { Scenario, ScenarioResult, ScenarioResultStatus } from '../acceptance/scenario-contract.js';
import type { SelfTestFeatureResult, SelfTestScenarioResult, SelfTestUnknown } from './types.js';

function passComplete(scenario: Scenario, result: ScenarioResult): boolean {
  const required = scenario.evidenceRequirements.filter((item) => item.requiredForPass);
  return result.status === 'PASS' && result.executed && result.processorInvoked
    && scenario.assertions.length > 0 && result.passedAssertions === scenario.assertions.length
    && required.every((requirement) => result.evidence.some((item) => item.id === requirement.id && item.verified));
}

export function deriveFeatureResult(results: readonly SelfTestScenarioResult[]): SelfTestFeatureResult {
  const p0 = results.filter((item) => item.scenario.priority === 'P0');
  if (!p0.length) return 'BLOCKED';
  if (p0.some((item) => item.result.status === 'FAIL')) return 'FAILED';
  const passed = p0.filter((item) => passComplete(item.scenario, item.result)).length;
  if (passed === p0.length) return 'READY';
  if (passed > 0) return 'PARTIAL';
  return 'BLOCKED';
}

export function terminalScenarioResult(scenario: Scenario, status: Extract<ScenarioResultStatus, 'BLOCKED' | 'NOT_EXECUTED'>, reasons: string[], runId: string): ScenarioResult {
  const now = new Date().toISOString();
  return {
    scenarioId: scenario.id, runId, status, executionMode: scenario.executionMode,
    executed: false, processorInvoked: false, processors: [], assertions: scenario.assertions.length,
    passedAssertions: 0, failedAssertions: 0, evidence: [],
    blockedReasons: reasons.map((message) => ({
      code: status === 'NOT_EXECUTED' ? 'EXECUTION_ABORTED' : 'POLICY_BLOCKED', stage: 'POLICY', message, details: {}, recoverable: true,
    })),
    operationResults: scenario.operations.map((operation) => ({
      operationId: operation.id, status, executed: false, processor: operation.processor,
      processorInvoked: false, evidence: [], blockedReasons: [],
    })),
    startedAt: now, finishedAt: now, durationMs: 0, summary: `${status}：${reasons.join('；')}`,
  };
}

export function inferUnknowns(results: readonly SelfTestScenarioResult[]): SelfTestUnknown[] {
  const unknowns: SelfTestUnknown[] = [];
  const add = (value: SelfTestUnknown): void => {
    if (!unknowns.some((item) => item.type === value.type && item.relatedId === value.relatedId)) unknowns.push(value);
  };
  for (const item of results) {
    const text = [...item.safety.reasons, ...item.result.blockedReasons.map((reason) => `${reason.code} ${reason.message}`)].join(' ');
    if (/CONTRACT|MISSING_CONTRACT|STALE|DRIFT/i.test(text)) add({ type: 'UNKNOWN_CONTRACT', reason: text, relatedId: item.scenario.id, requiredCapability: 'ACTIVE conflict-free Contract' });
    if (/API|METHOD|PATH|OPERATION/i.test(text)) add({ type: 'UNKNOWN_API', reason: text, relatedId: item.scenario.id, requiredCapability: 'Backend/OpenAPI/Runtime operation truth' });
    if (/STATE|DATABASE|RESOURCE/i.test(text)) add({ type: 'UNKNOWN_STATE', reason: text, relatedId: item.scenario.id, requiredCapability: 'State/Database Observer' });
    if (item.scenario.tags?.includes('async-state') && item.result.status !== 'PASS') add({
      type: 'UNKNOWN_STATE', reason: text || 'Async terminal state 未被证明', relatedId: item.scenario.id,
      requiredCapability: 'Task state Contract and terminal-state Observer',
    });
    if (/SIDE_EFFECT|PROVIDER|IDEMPOT/i.test(text)) add({ type: 'UNKNOWN_SIDE_EFFECT', reason: text, relatedId: item.scenario.id, requiredCapability: 'Provider/Event/Audit Observer' });
    if (/BILLING|CHARGE|COST/i.test(text)) add({ type: 'UNKNOWN_BILLING', reason: text, relatedId: item.scenario.id, requiredCapability: 'Billing ledger and balance Observer' });
    if (/AUTH|ACTOR|CREDENTIAL/i.test(text)) add({ type: 'UNKNOWN_AUTH', reason: text, relatedId: item.scenario.id, requiredCapability: 'Credential reference and auth Contract' });
    if (/UI|BROWSER|SCREENSHOT/i.test(text)) add({ type: 'UNKNOWN_UI_STATE', reason: text, relatedId: item.scenario.id, requiredCapability: 'Browser Observer' });
    if (/ENVIRONMENT|BASE_URL/i.test(text)) add({ type: 'UNKNOWN_ENVIRONMENT', reason: text, relatedId: item.scenario.id, requiredCapability: 'Reachable test environment' });
  }
  return unknowns;
}

export function evidenceSummary(results: readonly SelfTestScenarioResult[]): { total: number; kinds: Record<string, number>; completePasses: number } {
  const evidence = results.flatMap((item) => item.result.evidence);
  const kinds: Record<string, number> = {};
  for (const item of evidence) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
  return { total: evidence.length, kinds, completePasses: results.filter((item) => passComplete(item.scenario, item.result)).length };
}
