import type { BlockedReason, EvidenceRequirement, Scenario, ScenarioAssertion } from '../acceptance/scenario-contract.js';
import { contractDependency } from '../contracts/dependency-index.js';
import type { Contract } from '../contracts/types.js';
import type { ResolvedDiscoveredOperation } from '../discovery/types.js';
import type { FeatureRiskSummary, SelfTestPack } from './types.js';

function blocked(code: BlockedReason['code'], message: string, details: Record<string, unknown> = {}): BlockedReason {
  return { code, stage: 'DESIGN', message, details, recoverable: true };
}

function expectedStatus(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.observedStatus === 'number') return record.observedStatus;
  const responses = record.responseSchema;
  if (responses && typeof responses === 'object' && !Array.isArray(responses)) {
    const statuses = Object.keys(responses as object).filter((key) => /^\d{3}$/.test(key)).map(Number).sort((left, right) => left - right);
    return statuses.find((status) => status >= 200 && status < 300) ?? statuses[0];
  }
  return undefined;
}

function scenarioId(feature: string, operationId: string, purpose: string): string {
  return `self-test.${feature}.${operationId}.${purpose}`.replace(/[^a-zA-Z0-9._-]+/g, '-').toLowerCase();
}

function makeScenario(
  feature: string,
  item: ResolvedDiscoveredOperation,
  purpose: 'happy' | 'validation' | 'authorization' | 'persistence' | 'non-mutation' | 'idempotency' | 'ui' | 'async-state',
): Scenario {
  const id = scenarioId(feature, item.operation.id, purpose);
  const ac = `AC-${purpose.toUpperCase()}`;
  const responseEvidenceId = `${id}:response`;
  const responseAssertionId = `${id}:status`;
  const value = item.resolution.contract?.value;
  const status = expectedStatus(value);
  const reasons: BlockedReason[] = [];
  if (item.resolution.status !== 'RESOLVED' || !item.resolution.contract) {
    reasons.push(blocked(item.resolution.status === 'CONFLICT' ? 'CONTRACT_CONFLICT' : item.resolution.status === 'STALE' ? 'CONTRACT_STALE' : 'MISSING_CONTRACT',
      `${item.operation.id} Contract=${item.resolution.status}`, { reason: item.resolution.reason }));
  }
  if (status === undefined) reasons.push(blocked('AMBIGUOUS_ORACLE', `${item.operation.id} 没有可验证的响应状态 Oracle`));
  if (purpose === 'authorization' && item.operation.auth === undefined) reasons.push(blocked('MISSING_AUTHENTICATION', `${item.operation.id} 没有认证 Contract`));
  if (purpose === 'validation' && !(item.operation.safeProbe && item.operation.observed && item.operation.observed.status >= 400)) {
    reasons.push(blocked('MISSING_TEST_DATA', `${item.operation.id} 没有已证明 side-effect-free 的非法参数探针`));
  }
  const assertions: ScenarioAssertion[] = status === undefined ? [] : [{
    id: responseAssertionId, channel: 'RESPONSE', target: 'status', operator: 'EQUALS', expected: status,
    acceptanceCriteriaIds: [ac], operationId: 'action', evidenceRequirementIds: [responseEvidenceId], severity: 'P0',
  }];
  const evidence: EvidenceRequirement[] = status === undefined ? [] : [{
    id: responseEvidenceId, kind: 'RESPONSE', channel: 'RESPONSE', description: '真实 HTTP Response',
    requiredForPass: true, operationId: 'action', assertionIds: [responseAssertionId], retention: 'RUN',
  }];
  const patterns: string[] = ['API_CONTRACT'];
  if (purpose === 'persistence') {
    const assertionId = `${id}:state`;
    const evidenceId = `${id}:state-after`;
    assertions.push({ id: assertionId, channel: 'STATE', target: '', operator: 'EXISTS', acceptanceCriteriaIds: [ac], operationId: 'action', evidenceRequirementIds: [evidenceId], severity: 'P0' });
    evidence.push({ id: evidenceId, kind: 'STATE_AFTER', channel: 'STATE', description: '独立状态后置快照', requiredForPass: true, operationId: 'action', assertionIds: [assertionId] });
    patterns.push('PERSISTENCE');
  }
  if (purpose === 'ui') {
    const assertionId = `${id}:ui`;
    const evidenceId = `${id}:screenshot`;
    assertions.push({ id: assertionId, channel: 'UI', target: '', operator: 'EXISTS', acceptanceCriteriaIds: [ac], operationId: 'action', evidenceRequirementIds: [evidenceId], severity: 'P0' });
    evidence.push({ id: evidenceId, kind: 'SCREENSHOT', channel: 'UI', description: 'Browser DOM/Screenshot observation', requiredForPass: true, operationId: 'action', assertionIds: [assertionId] });
  }
  if (purpose === 'async-state') {
    reasons.push(blocked('AMBIGUOUS_ORACLE', 'Async Task 缺少可解析的终态 Contract；不能把一次状态查询当作终态证明'));
  }
  // Complex proof obligations are preserved as blocked design assets until a real oracle/observer binding exists.
  if (purpose === 'non-mutation') reasons.push(blocked('MISSING_STATE_OBSERVER', 'Non-Mutation 需要同一资源的 Before/After 比较绑定'));
  if (purpose === 'idempotency') reasons.push(blocked('MISSING_SIDE_EFFECT_OBSERVER', 'Idempotency 需要实体与副作用计数 Observer'));
  return {
    schemaVersion: 'self-test.v1', id, title: `${purpose}: ${item.operation.method} ${item.operation.path}`,
    domain: feature, requirement: feature, sources: [{ requirementId: feature, acceptanceCriteriaIds: [ac] }],
    acceptanceCriteriaIds: [ac], patternIds: patterns,
    scope: {}, preconditions: [], testData: [],
    operations: [{
      id: 'action', channel: 'API', description: `${item.operation.method} ${item.operation.path}`,
      processor: 'api', method: item.operation.method as 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: item.operation.path, apiSpecId: item.operation.id, acceptanceCriteriaIds: [ac], timeoutMs: 10_000,
    }],
    assertions, evidenceRequirements: evidence, prepare: [], cleanup: [],
    executionMode: reasons.length ? 'BLOCKED' : 'EXECUTABLE', blockedReasons: reasons,
    risks: (item.operation.sideEffects ?? []).map((effect, index) => ({ id: `risk-${index + 1}`, level: 'HIGH', category: 'side-effect', description: effect })),
    priority: 'P0', dependencies: [],
    contractDependencies: item.resolution.contract ? [contractDependency(item.resolution.contract)] : [],
    tags: ['developer-self-test', purpose],
    metadata: { purpose, operationId: item.operation.id, safeProbe: item.operation.safeProbe === true, sideEffects: item.operation.sideEffects ?? [] },
  };
}

export function generateMinimalSelfTestPack(
  featureId: string,
  resolved: readonly ResolvedDiscoveredOperation[],
  riskSummary: FeatureRiskSummary,
  featureContracts: readonly Contract[] = [],
): SelfTestPack {
  const scenarios: Scenario[] = [];
  for (const item of resolved.slice(0, 4)) {
    const invalidReject = item.operation.sideEffects?.includes('VALIDATION_REJECT_PROBE')
      && item.operation.observed !== undefined && item.operation.observed.status >= 400;
    scenarios.push(makeScenario(featureId, item, invalidReject ? 'validation' : 'happy'));
  }
  const mutation = resolved.find((item) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(item.operation.method));
  const auth = resolved.find((item) => item.operation.auth !== undefined) ?? resolved[0];
  const mutationIsRejectProbe = mutation?.operation.sideEffects?.includes('VALIDATION_REJECT_PROBE')
    && mutation.operation.observed !== undefined && mutation.operation.observed.status >= 400;
  if (mutation && !mutationIsRejectProbe && scenarios.length < 8) scenarios.push(makeScenario(featureId, mutation, 'validation'));
  if (auth && scenarios.length < 8) scenarios.push(makeScenario(featureId, auth, 'authorization'));
  if (mutation && !mutationIsRejectProbe && scenarios.length < 8) scenarios.push(makeScenario(featureId, mutation, 'persistence'));
  if (mutation && !mutationIsRejectProbe && scenarios.length < 8) scenarios.push(makeScenario(featureId, mutation, 'non-mutation'));
  if (mutation && !mutationIsRejectProbe && scenarios.length < 8) scenarios.push(makeScenario(featureId, mutation, 'idempotency'));
  if (riskSummary.risks.some((risk) => risk.type === 'ASYNC_TASK') && resolved[0] && scenarios.length < 8) scenarios.push(makeScenario(featureId, resolved[0], 'async-state'));
  if (riskSummary.risks.some((risk) => risk.type === 'UI_STATE') && resolved[0] && scenarios.length < 8) scenarios.push(makeScenario(featureId, resolved[0], 'ui'));
  if (riskSummary.risks.some((risk) => risk.type === 'BILLING')) {
    for (const scenario of scenarios.filter((item) => item.tags?.includes('validation') && item.executionMode === 'EXECUTABLE')) {
      const operationId = scenario.operations[0].id;
      const assertionId = `${scenario.id}:billing-unchanged`;
      const beforeId = `${scenario.id}:billing-before`;
      const afterId = `${scenario.id}:billing-after`;
      const recordId = `${scenario.id}:billing-record`;
      scenario.patternIds.push('NON_MUTATION');
      scenario.assertions.push({
        id: assertionId, channel: 'STATE', target: '', operator: 'UNCHANGED',
        expectedFrom: { evidenceId: beforeId }, acceptanceCriteriaIds: scenario.acceptanceCriteriaIds,
        operationId, evidenceRequirementIds: [beforeId, afterId, recordId], severity: 'P0',
      });
      scenario.evidenceRequirements.push(
        { id: beforeId, kind: 'STATE_BEFORE', channel: 'STATE', description: '扣费前账本快照', requiredForPass: true, operationId, assertionIds: [assertionId] },
        { id: afterId, kind: 'STATE_AFTER', channel: 'STATE', description: '拒绝后账本快照', requiredForPass: true, operationId, assertionIds: [assertionId] },
        { id: recordId, kind: 'BILLING_RECORD', channel: 'SIDE_EFFECT', description: '拒绝请求的账单记录证明', requiredForPass: true, operationId, assertionIds: [assertionId] },
      );
    }
  }
  const extraDependencies = featureContracts.map(contractDependency);
  for (const scenario of scenarios) {
    scenario.contractDependencies = [...(scenario.contractDependencies ?? []), ...extraDependencies]
      .filter((dependency, index, all) => all.findIndex((item) => item.contractId === dependency.contractId) === index);
    scenario.metadata = { ...(scenario.metadata ?? {}), resolvedFeatureContracts: featureContracts.map((contract) => contract.id) };
  }
  return {
    featureId, scenarios: scenarios.slice(0, 8), riskSummary,
    requiredApprovals: riskSummary.risks.some((risk) => ['BILLING', 'DATA_MUTATION', 'EXTERNAL_PROVIDER'].includes(risk.type)) ? ['LIVE_EXECUTION'] : [],
  };
}
