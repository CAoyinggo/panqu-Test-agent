import type {
  BlockedReason,
  EvidenceEnvelope,
  Scenario,
  ScenarioResult,
  ScenarioResultStatus,
} from './scenario-contract.js';
import type { ScenarioExecutabilityGateResult } from './scenario-executability-gate.js';
import type { ScenarioQualityResult } from './scenario-quality.js';
import { findEvidenceForRequirement } from './scenario-evidence.js';

export interface ScenarioAcceptanceCriterionReport {
  id: string;
  operationIds: string[];
  assertionIds: string[];
  evidenceIds: string[];
  status: ScenarioResultStatus;
}

export interface ScenarioCoverageReport {
  requirementCoverage: number;
  scenarioCoverage: number;
  executableCoverage: number;
  assertionCoverage: number;
  evidenceCoverage: number;
}

export interface ScenarioExecutionReport {
  scenario: {
    id: string;
    title: string;
    domain?: string;
    priority: Scenario['priority'];
    executionMode: Scenario['executionMode'];
    patternIds: string[];
  };
  result: ScenarioResult;
  gate: ScenarioExecutabilityGateResult;
  quality: ScenarioQualityResult;
  acceptanceCriteria: ScenarioAcceptanceCriterionReport[];
  coverage: ScenarioCoverageReport;
  trace: Array<{
    acceptanceCriterionId: string;
    scenarioId: string;
    operationIds: string[];
    processorNames: string[];
    assertionIds: string[];
    evidenceIds: string[];
    status: ScenarioResultStatus;
  }>;
  blockedReasons: BlockedReason[];
  generatedAt: string;
}

function integrityProblems(scenario: Scenario, result: ScenarioResult): string[] {
  if (result.status !== 'PASS') return [];
  const problems: string[] = [];
  if (result.scenarioId !== scenario.id) problems.push('scenarioId 不匹配');
  if (result.executed !== true) problems.push('executed 不为 true');
  if (result.processorInvoked !== true || !result.processors.length) problems.push('Processor 调用证据缺失');
  if (result.operationResults.length !== scenario.operations.length
    || result.operationResults.some((operation) => !operation.executed || !operation.processorInvoked || operation.status !== 'PASS')) {
    problems.push('并非所有 Operation 都已实际完成');
  }
  const expectedOperationIds = new Set(scenario.operations.map((operation) => operation.id));
  const actualOperationIds = new Set(result.operationResults.map((operation) => operation.operationId));
  if (actualOperationIds.size !== expectedOperationIds.size
    || [...expectedOperationIds].some((id) => !actualOperationIds.has(id))) problems.push('Operation ID 集合不匹配');
  if (result.operationResults.some((operation) => !operation.processor
    || !result.processors.includes(operation.processor))) problems.push('Operation Processor 追溯不完整');
  if (result.assertions < 1) problems.push('有效业务断言为空');
  if (result.passedAssertions !== result.assertions || result.failedAssertions !== 0) problems.push('断言计数不满足全通过');
  const assertionResultsComplete = scenario.assertions.every((assertion) => result.evidence.some((item) => {
    if (item.scenarioId !== scenario.id || item.assertionId !== assertion.id || item.verified !== true) return false;
    if (assertion.operationId && item.operationId !== assertion.operationId) return false;
    if (!assertion.acceptanceCriteriaIds.every((id) => item.acceptanceCriteriaIds.includes(id))) return false;
    return Boolean(item.data && typeof item.data === 'object'
      && (item.data as Record<string, unknown>).pass === true);
  }));
  if (!assertionResultsComplete) problems.push('逐断言 verified PASS Evidence 不完整');
  const requiredEvidence = scenario.evidenceRequirements.filter((item) => item.requiredForPass);
  if (!requiredEvidence.every((requirement) => findEvidenceForRequirement(scenario, requirement, result.evidence))) {
    problems.push('Required Evidence identity/verified/trace 不完整');
  }
  return problems;
}

/** Report 层二次 fail-close；即便上游伪造 PASS，也会降为 BLOCKED。 */
export function enforceScenarioResultIntegrity(scenario: Scenario, input: ScenarioResult): ScenarioResult {
  const problems = integrityProblems(scenario, input);
  if (!problems.length) return input;
  const integrityReason: BlockedReason = {
    code: 'MISSING_EVIDENCE',
    stage: 'REPORT',
    message: `RESULT_INTEGRITY_VIOLATION：${problems.join('；')}`,
    details: { problems },
    recoverable: true,
  };
  return {
    ...input,
    status: 'BLOCKED',
    blockedReasons: [...input.blockedReasons, integrityReason],
    summary: `BLOCKED：${integrityReason.message}`,
  };
}

function enforceScenarioReportIntegrity(
  scenario: Scenario,
  input: ScenarioResult,
  gate: ScenarioExecutabilityGateResult,
): ScenarioResult {
  if (gate.allowed === true && gate.disposition === 'EXECUTABLE') {
    return enforceScenarioResultIntegrity(scenario, input);
  }
  if (input.status !== 'PASS') return input;
  const integrityReason: BlockedReason = {
    code: gate.reasons.find((item) => item.code === 'POLICY_BLOCKED')?.code ?? 'INVALID_SCENARIO',
    stage: 'REPORT',
    message: `RESULT_INTEGRITY_VIOLATION：Executability Gate=${gate.disposition}，禁止报告 PASS`,
    details: { gateAllowed: gate.allowed, gateDisposition: gate.disposition },
    recoverable: false,
  };
  return {
    ...input,
    status: 'BLOCKED',
    blockedReasons: [...input.blockedReasons, ...gate.reasons, integrityReason],
    summary: `BLOCKED：${integrityReason.message}`,
  };
}

function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function evidenceForCriterion(scenario: Scenario, evidence: readonly EvidenceEnvelope[], criterionId: string): EvidenceEnvelope[] {
  const assertionIds = new Set(scenario.assertions.filter((assertion) => assertion.acceptanceCriteriaIds.includes(criterionId)).map((assertion) => assertion.id));
  const requirementIds = new Set(scenario.evidenceRequirements.filter((requirement) => requirement.assertionIds.some((id) => assertionIds.has(id))).map((requirement) => requirement.id));
  return evidence.filter((item) => item.verified === true && (item.acceptanceCriteriaIds.includes(criterionId)
    || Boolean(item.assertionId && assertionIds.has(item.assertionId))
    || requirementIds.has(item.id)));
}

function assertionResultEvidence(
  scenario: Scenario,
  assertionId: string,
  evidence: readonly EvidenceEnvelope[],
): EvidenceEnvelope | undefined {
  const assertion = scenario.assertions.find((item) => item.id === assertionId);
  if (!assertion) return undefined;
  return evidence.find((item) => item.scenarioId === scenario.id
    && item.assertionId === assertion.id
    && item.verified === true
    && (!assertion.operationId || item.operationId === assertion.operationId)
    && assertion.acceptanceCriteriaIds.every((id) => item.acceptanceCriteriaIds.includes(id))
    && Boolean(item.data && typeof item.data === 'object'
      && typeof (item.data as Record<string, unknown>).pass === 'boolean'));
}

export function buildScenarioExecutionReport(input: {
  scenario: Scenario;
  result: ScenarioResult;
  gate: ScenarioExecutabilityGateResult;
  quality: ScenarioQualityResult;
}): ScenarioExecutionReport {
  const result = enforceScenarioReportIntegrity(input.scenario, input.result, input.gate);
  const acceptanceCriteria = input.scenario.acceptanceCriteriaIds.map((id): ScenarioAcceptanceCriterionReport => {
    const operations = input.scenario.operations.filter((operation) => operation.acceptanceCriteriaIds.includes(id));
    const assertions = input.scenario.assertions.filter((assertion) => assertion.acceptanceCriteriaIds.includes(id));
    const evidence = evidenceForCriterion(input.scenario, result.evidence, id);
    const assertionEvidence = assertions.flatMap((assertion) => {
      const item = assertionResultEvidence(input.scenario, assertion.id, evidence);
      return item ? [item] : [];
    });
    const status: ScenarioResultStatus = result.status === 'PASS' && operations.length && assertions.length
      && assertionEvidence.length === assertions.length
      && assertionEvidence.every((item) => (item.data as Record<string, unknown>).pass === true)
      ? 'PASS' : result.status;
    return { id, operationIds: operations.map((item) => item.id), assertionIds: assertions.map((item) => item.id), evidenceIds: evidence.map((item) => item.id), status };
  });
  const executableOperations = result.operationResults.filter((item) => item.executed && item.processorInvoked).length;
  const evidencedAssertions = input.scenario.assertions.filter((assertion) => (
    assertionResultEvidence(input.scenario, assertion.id, result.evidence)
  )).length;
  const requiredEvidence = input.scenario.evidenceRequirements.filter((item) => item.requiredForPass);
  const presentRequiredEvidence = requiredEvidence.filter((requirement) => (
    findEvidenceForRequirement(input.scenario, requirement, result.evidence)
  )).length;
  const coverage: ScenarioCoverageReport = {
    requirementCoverage: percent(acceptanceCriteria.filter((item) => item.operationIds.length && item.assertionIds.length).length, acceptanceCriteria.length),
    scenarioCoverage: input.scenario.id && input.scenario.operations.length ? 100 : 0,
    executableCoverage: percent(executableOperations, input.scenario.operations.length),
    assertionCoverage: percent(evidencedAssertions, input.scenario.assertions.length),
    evidenceCoverage: percent(presentRequiredEvidence, requiredEvidence.length),
  };
  const trace = acceptanceCriteria.map((item) => ({
    acceptanceCriterionId: item.id,
    scenarioId: input.scenario.id,
    operationIds: item.operationIds,
    processorNames: [...new Set(result.operationResults.filter((operation) => item.operationIds.includes(operation.operationId))
      .flatMap((operation) => operation.processor ? [operation.processor] : []))],
    assertionIds: item.assertionIds,
    evidenceIds: item.evidenceIds,
    status: item.status,
  }));
  return {
    scenario: {
      id: input.scenario.id,
      title: input.scenario.title,
      domain: input.scenario.domain,
      priority: input.scenario.priority,
      executionMode: input.scenario.executionMode,
      patternIds: input.scenario.patternIds,
    },
    result,
    gate: input.gate,
    quality: input.quality,
    acceptanceCriteria,
    coverage,
    trace,
    blockedReasons: [...input.gate.reasons, ...result.blockedReasons],
    generatedAt: new Date().toISOString(),
  };
}
