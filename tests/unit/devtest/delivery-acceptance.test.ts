import { describe, expect, it } from 'vitest';

import type { TestCase, TestEvidenceChannel } from '../../../src/agents/test-design/testcase-schema.js';
import type { AcceptanceCaseExecutionResult } from '../../../src/acceptance/api-processor.js';
import { parseAcceptanceRequirement } from '../../../src/acceptance/requirement-parser.js';
import {
  buildDevTestAcceptanceTraces,
  buildDevTestDeliveryCoverage,
  buildDevTestRequirementModel,
} from '../../../src/devtest/delivery-acceptance.js';
import type {
  DevTestAcceptanceResult,
  DevTestAcceptanceTrace,
  DevTestIssueClassification,
  DevTestOracleResult,
  DevTestProblem,
  DevTestRequirementModel,
} from '../../../src/devtest/types.js';

const BASE_REQUIREMENT = `# 查询资源

## API

GET /api/resources/{id}

无需认证。

## 响应

| 状态码 | 描述 |
| --- | --- |
| 200 | 查询成功 |

## Acceptance Criteria

- AC-1 GET /api/resources/{id} 返回 200。
`;

function requirementModel(factIds: readonly string[]): DevTestRequirementModel {
  const requirement = parseAcceptanceRequirement(BASE_REQUIREMENT, { documentId: 'delivery.md' });
  const seed = requirement.factLedger.find((fact) => fact.normativity === 'NORMATIVE');
  if (!seed) throw new Error('test fixture did not create a normative Requirement Fact');
  requirement.factLedger = factIds.map((id, index) => ({
    ...seed,
    id,
    statement: `Requirement ${index + 1}`,
    provenance: 'EXPLICIT' as const,
    epistemicType: 'FACT' as const,
    status: 'UNVERIFIED' as const,
    source: { ...seed.source, text: `Requirement ${index + 1}` },
    canonical: { ...seed.canonical, normalizationStatus: 'COMPLETE' as const, unresolved: [] },
  }));
  return buildDevTestRequirementModel(requirement);
}

function apiCase(
  caseId: string,
  factId: string,
  options: {
    assertions?: TestCase['assertions'];
    evidenceChannels?: readonly TestEvidenceChannel[];
    executionMode?: TestCase['executionMode'];
  } = {},
): TestCase {
  const assertions = options.assertions ?? [{
    type: 'STATUS_CODE' as const,
    expected: 200,
    factIds: [factId],
    objectiveIds: [`OBJ-${factId}`],
    sourceType: 'REQUIREMENT' as const,
    provenance: 'EXPLICIT' as const,
  }];
  const evidenceChannels = options.evidenceChannels ?? ['API_REQUEST', 'API_RESPONSE'];
  return {
    id: caseId,
    feature: '查询资源',
    name: `GET resource ${caseId}`,
    priority: 'P0',
    testType: 'API',
    executionMode: options.executionMode ?? 'EXECUTABLE',
    protocol: 'HTTP',
    tags: [],
    preconditions: ['资源 resource-1 已存在'],
    data: { resourceId: 'resource-1' },
    source: {
      requirementId: 'REQ-DELIVERY',
      testPointId: `TP-${caseId}`,
      acceptanceCriteriaIds: ['AC-1'],
      factIds: [factId],
      objectiveIds: [`OBJ-${factId}`],
      scenarioId: `SCENARIO-${caseId}`,
      sourceType: 'REQUIREMENT',
      provenance: 'EXPLICIT',
      apiOperationKey: 'GET /api/resources/{id}',
    },
    steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/api/resources/{id}', pathParams: { id: 'resource-1' } }],
    assertions,
    expected: { status: '200' },
    evidenceRequirements: evidenceChannels.map((channel) => ({
      channel,
      phase: channel === 'API_REQUEST' ? 'DURING' : 'AFTER',
      required: true,
      description: `${channel} is required for delivery acceptance`,
      factIds: [factId],
    })),
    design: {
      objectiveIds: [`OBJ-${factId}`],
      factIds: [factId],
      scenarioId: `SCENARIO-${caseId}`,
      sourceType: 'REQUIREMENT',
      expectedOutcome: 'GET /api/resources/{id} 返回 200',
      actions: ['GET /api/resources/resource-1'],
      executability: options.executionMode === 'DESIGNED_ONLY' ? 'DESIGNED_ONLY' : 'EXECUTABLE',
    },
    contractDependencies: [{ contractId: 'api.resources.get', version: 'v1', fingerprint: 'contract-fp' }],
  };
}

function apiResult(
  caseId: string,
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED' | 'CANCELLED',
  options: { error?: string; includeRequest?: boolean; includeResponse?: boolean; executed?: boolean } = {},
): AcceptanceCaseExecutionResult {
  const executed = options.executed ?? (status === 'PASS' || status === 'FAIL');
  const assertionPass = status === 'PASS';
  const includeRequest = options.includeRequest ?? executed;
  const includeResponse = options.includeResponse ?? executed;
  return {
    caseId,
    name: caseId,
    feature: '查询资源',
    priority: 'P0',
    tags: [],
    scene: 'api',
    timestamp: '2026-08-26T00:00:00.000Z',
    status,
    executed,
    processorInvoked: executed,
    processor: executed ? 'ApiProcessor' : undefined,
    pass: status === 'PASS',
    passRate: status === 'PASS' ? 1 : 0,
    assertions: executed ? 1 : 0,
    passedAssertions: assertionPass ? 1 : 0,
    failedAssertions: status === 'FAIL' ? 1 : 0,
    classification: status === 'PASS' ? 'SUCCESS' : status === 'FAIL' ? 'PRODUCT_FAILURE' : 'NOT_EXECUTED',
    error: options.error,
    attribution: {
      classification: status === 'PASS' ? 'SUCCESS' : status === 'FAIL' ? 'PRODUCT_FAILURE' : 'NOT_EXECUTED',
      confidence: 'HIGH',
      reason: options.error ?? status,
      evidenceSources: executed ? ['HTTP_REQUEST', 'HTTP_RESPONSE'] : ['CASE_EXECUTION_MODE'],
    },
    evidence: {
      acceptanceCriteriaIds: ['AC-1'],
      factIds: ['FACT-1'],
      objectiveIds: ['OBJ-FACT-1'],
      request: includeRequest ? {
        method: 'GET', url: 'http://127.0.0.1/api/resources/resource-1', headers: {}, pathParams: { id: 'resource-1' }, query: {},
      } : undefined,
      response: includeResponse ? {
        status: assertionPass ? 200 : 409, headers: {}, body: assertionPass ? { id: 'resource-1' } : { error: 'conflict' },
      } : undefined,
      assertions: executed ? [{
        type: 'STATUS_CODE', expected: 200, actual: assertionPass ? 200 : 409, pass: assertionPass,
        detail: `expected=200 actual=${assertionPass ? 200 : 409}`,
      }] : [],
      evidenceItems: [],
    },
  } as AcceptanceCaseExecutionResult;
}

function oracle(
  caseId: string,
  verdict: DevTestOracleResult['verdict'],
  complete: boolean,
  transientSignal?: DevTestOracleResult['transientSignal'],
): DevTestOracleResult {
  return {
    caseId,
    verdict,
    expected: {
      requirement: ['GET /api/resources/{id} 返回 200'],
      contract: ['api.resources.get@v1:contract-fp'],
      invariants: [],
    },
    actual: verdict === 'FAIL' ? { status: 409 } : { status: 200 },
    evidence: {
      execution: complete,
      assertion: complete,
      response: complete,
      observedState: complete,
      complete,
    },
    transientSignal,
    reason: complete ? `deterministic ${verdict}` : `${verdict} because evidence is incomplete`,
  };
}

function problem(
  caseId: string,
  failureClass: NonNullable<DevTestProblem['failureClass']>,
  reasonCode: string,
): DevTestProblem {
  return {
    id: `P-${caseId}`,
    type: failureClass === 'PRODUCT_BUG' ? 'TEST_FAILED'
      : failureClass === 'REQUIREMENT_ISSUE' ? 'REQUIREMENT_QUALITY'
        : failureClass === 'ENVIRONMENT_ISSUE' ? 'ENVIRONMENT_MISSING'
          : failureClass === 'TEST_ISSUE' ? 'ASSERTION_MISSING' : 'PROCESSOR_MISSING',
    severity: 'HIGH',
    dimension: 'EXECUTION',
    message: reasonCode,
    affectedCases: [caseId],
    reasonCode,
    failureClass,
  };
}

function traces(input: {
  testCase: TestCase;
  result?: AcceptanceCaseExecutionResult;
  oracle?: DevTestOracleResult;
  problems?: DevTestProblem[];
}): DevTestAcceptanceTrace[] {
  return buildDevTestAcceptanceTraces({
    requirementModel: requirementModel(input.testCase.source?.factIds ?? []),
    testCases: [input.testCase],
    results: input.result ? [input.result] : [],
    uiResults: [],
    oracleResults: input.oracle ? [input.oracle] : [],
    observations: [],
    snapshots: [],
    problems: input.problems ?? [],
  });
}

function coverageTrace(input: {
  caseId: string;
  factId: string;
  result: DevTestAcceptanceResult;
  execution: DevTestAcceptanceTrace['execution']['status'];
}): DevTestAcceptanceTrace {
  const verified = input.result === 'PASS' || input.result === 'FAIL';
  return {
    caseId: input.caseId,
    requirement: {
      acceptanceCriteriaIds: ['AC-1'], factIds: [input.factId], explicitFactIds: [input.factId], derivedFactIds: [], unknownFactIds: [],
      assertedFactIds: [input.factId], verifiedFactIds: verified ? [input.factId] : [],
    },
    testModel: { objectiveIds: [`OBJ-${input.factId}`], dimension: 'API', provenance: 'EXPLICIT' },
    executableTest: {
      status: 'READY', preconditions: [], steps: [], assertions: [], evidencePlan: [], missing: [],
    },
    execution: {
      status: input.execution,
      rawStatus: input.result === 'NOT_TESTED' ? 'NOT_EXECUTED' : input.result,
      executed: input.execution === 'EXECUTED',
      processorInvoked: input.execution === 'EXECUTED',
      processor: input.execution === 'EXECUTED' ? 'ApiProcessor' : undefined,
    },
    evidence: {
      required: ['API_REQUEST', 'API_RESPONSE'],
      collected: verified ? ['API_REQUEST', 'API_RESPONSE'] : [],
      missing: verified ? [] : ['API_REQUEST', 'API_RESPONSE'],
      complete: verified,
    },
    oracle: {
      verdict: input.result === 'PASS' ? 'PASS' : input.result === 'FAIL' ? 'FAIL' : 'BLOCKED',
      reason: input.result,
      expected: { requirement: [], contract: [], invariants: [] },
      actual: undefined,
    },
    result: input.result,
    classification: input.result === 'PASS' ? 'NONE' : input.result === 'FAIL' ? 'PRODUCT_BUG'
      : input.result === 'NOT_TESTED' ? 'NOT_TESTED' : 'EXECUTION_ERROR',
    problemIds: [],
    explanation: [],
  };
}

describe('DevTest delivery acceptance', () => {
  it('projects Requirement Facts into explicit, derived and unknown knowledge without collapsing epistemic boundaries', () => {
    const requirement = parseAcceptanceRequirement(BASE_REQUIREMENT, { documentId: 'knowledge.md' });
    const seed = requirement.factLedger.find((fact) => fact.normativity === 'NORMATIVE');
    if (!seed) throw new Error('test fixture did not create a normative Requirement Fact');
    requirement.factLedger = [
      {
        ...seed, id: 'FACT-EXPLICIT', statement: '资源查询必须返回 200', provenance: 'EXPLICIT', epistemicType: 'FACT',
        canonical: { ...seed.canonical, normalizationStatus: 'COMPLETE', unresolved: [] },
      },
      {
        ...seed, id: 'FACT-DERIVED', statement: '由路径模板推导 id 为路径参数', provenance: 'INFERRED', epistemicType: 'INFERENCE',
        canonical: { ...seed.canonical, normalizationStatus: 'COMPLETE', unresolved: [] },
      },
      {
        ...seed, id: 'FACT-UNKNOWN', statement: '成功后的最终业务状态未知', provenance: 'UNKNOWN', epistemicType: 'FACT',
        canonical: { ...seed.canonical, normalizationStatus: 'UNRESOLVED', unresolved: ['EXPECTED_STATE_UNKNOWN'] },
      },
    ];

    const model = buildDevTestRequirementModel(requirement);

    expect(model.explicitFactIds).toEqual(['FACT-EXPLICIT']);
    expect(model.derivedFactIds).toEqual(['FACT-DERIVED']);
    expect(model.unknownFactIds).toEqual(['FACT-UNKNOWN']);
    expect(model.facts.map((fact) => [fact.id, fact.knowledge])).toEqual([
      ['FACT-EXPLICIT', 'EXPLICIT'],
      ['FACT-DERIVED', 'DERIVED'],
      ['FACT-UNKNOWN', 'UNKNOWN'],
    ]);
  });

  it('marks a complete API execution as PASS/NONE and preserves the complete delivery trace', () => {
    const testCase = apiCase('CASE-PASS', 'FACT-1');
    const [trace] = traces({ testCase, result: apiResult(testCase.id, 'PASS'), oracle: oracle(testCase.id, 'PASS', true) });

    expect(trace).toMatchObject({
      caseId: 'CASE-PASS',
      requirement: { acceptanceCriteriaIds: ['AC-1'], factIds: ['FACT-1'], explicitFactIds: ['FACT-1'] },
      testModel: { objectiveIds: ['OBJ-FACT-1'], scenarioId: 'SCENARIO-CASE-PASS', dimension: 'API' },
      executableTest: { status: 'READY', missing: [] },
      execution: { status: 'EXECUTED', rawStatus: 'PASS', executed: true, processorInvoked: true },
      evidence: {
        required: ['API_REQUEST', 'API_RESPONSE'],
        collected: ['API_REQUEST', 'API_RESPONSE'],
        missing: [],
        complete: true,
      },
      oracle: { verdict: 'PASS' },
      result: 'PASS',
      classification: 'NONE',
      problemIds: [],
    });
  });

  it('does not mark an API Case VERIFIED when any required Evidence channel is missing', () => {
    const testCase = apiCase('CASE-MISSING-EVIDENCE', 'FACT-1', {
      evidenceChannels: ['API_REQUEST', 'API_RESPONSE', 'DATABASE_STATE'],
    });
    const [trace] = traces({
      testCase,
      result: apiResult(testCase.id, 'PASS'),
      oracle: oracle(testCase.id, 'PASS', true),
    });

    expect(trace.evidence).toMatchObject({ complete: false, missing: ['DATABASE_STATE'] });
    expect(trace.result).toBe('BLOCKED');
    expect(trace.classification).toBe('EXECUTION_ERROR');
    const coverage = buildDevTestDeliveryCoverage({ requirementModel: requirementModel(['FACT-1']), traces: [trace] });
    expect(coverage.cases.verified).toBe(0);
    expect(coverage.requirements.verified).toBe(0);
  });

  it('does not verify an unasserted Fact when one Case links multiple Requirement Facts', () => {
    const testCase = apiCase('CASE-MULTI-FACT', 'FACT-1');
    testCase.source!.factIds = ['FACT-1', 'FACT-2'];
    testCase.design!.factIds = ['FACT-1', 'FACT-2'];
    const execution = apiResult(testCase.id, 'PASS');
    execution.evidence.factIds = ['FACT-1', 'FACT-2'];
    execution.evidence.assertions[0].factIds = ['FACT-1'];

    const [trace] = buildDevTestAcceptanceTraces({
      requirementModel: requirementModel(['FACT-1', 'FACT-2']),
      testCases: [testCase],
      results: [execution],
      uiResults: [],
      oracleResults: [oracle(testCase.id, 'PASS', true)],
      observations: [],
      snapshots: [],
      problems: [],
    });
    const coverage = buildDevTestDeliveryCoverage({
      requirementModel: requirementModel(['FACT-1', 'FACT-2']),
      traces: [trace],
    });

    expect(trace.executableTest.missing).toContain('FACT_ASSERTION_MISSING:FACT-2');
    expect(trace.requirement.assertedFactIds).toEqual(['FACT-1']);
    expect(trace.requirement.verifiedFactIds).not.toContain('FACT-2');
    expect(coverage.requirements).toEqual(expect.objectContaining({ total: 2, generated: 2, executed: 2, verified: 0 }));
    expect(coverage.requirements.blockedFactIds).toContain('FACT-2');
  });

  it('maps a Case that never entered the Runner to NOT_TESTED instead of PASS or VERIFIED', () => {
    const testCase = apiCase('CASE-NOT-EXECUTED', 'FACT-1');
    const [trace] = traces({
      testCase,
      result: apiResult(testCase.id, 'NOT_EXECUTED'),
      oracle: oracle(testCase.id, 'BLOCKED', false),
    });

    expect(trace).toMatchObject({
      execution: { status: 'NOT_EXECUTED', rawStatus: 'NOT_EXECUTED', executed: false },
      result: 'NOT_TESTED',
      classification: 'NOT_TESTED',
    });
    const coverage = buildDevTestDeliveryCoverage({ requirementModel: requirementModel(['FACT-1']), traces: [trace] });
    expect(coverage.cases).toMatchObject({ generated: 1, executed: 0, verified: 0, notTested: 1 });
    expect(coverage.requirements).toMatchObject({ total: 1, generated: 1, executed: 0, verified: 0, untested: 1 });
  });

  it('Oracle/Evidence 即使被误标完整，没有 Processor 真实执行也不得产生 PASS', () => {
    const testCase = apiCase('CASE-FALSE-PASS-GUARD', 'FACT-1');
    const falseOracle = oracle(testCase.id, 'PASS', true);
    falseOracle.evidence.collected = ['API_REQUEST@DURING:PRESENT', 'API_RESPONSE@AFTER:PRESENT'];
    falseOracle.evidence.missing = [];
    const [trace] = traces({ testCase, oracle: falseOracle });
    expect(trace.execution).toMatchObject({ status: 'NOT_EXECUTED', executed: false, processorInvoked: false });
    expect(trace.result).toBe('NOT_TESTED');
    expect(trace.classification).toBe('NOT_TESTED');
    expect(trace.requirement.verifiedFactIds).toEqual([]);
  });

  it('请求已经发出后取消时保持 BLOCKED，不能伪装成 NOT_TESTED', () => {
    const testCase = apiCase('CASE-CANCELLED-AFTER-SEND', 'FACT-1');
    const cancelled = apiResult(testCase.id, 'CANCELLED', {
      executed: true, includeRequest: true, includeResponse: false, error: 'CANCELLED after request dispatch',
    });
    const [trace] = traces({ testCase, result: cancelled, oracle: oracle(testCase.id, 'BLOCKED', false) });
    expect(trace).toMatchObject({
      execution: { status: 'EXECUTED', rawStatus: 'CANCELLED', executed: true },
      result: 'BLOCKED',
    });
    expect(trace.classification).not.toBe('NOT_TESTED');
  });

  it('取消后即使残留完整 PASS Oracle 也必须 BLOCKED', () => {
    const testCase = apiCase('CASE-CANCELLED-STALE-ORACLE', 'FACT-1');
    const cancelled = apiResult(testCase.id, 'CANCELLED', {
      executed: true, includeRequest: true, includeResponse: true, error: 'CANCELLED after response',
    });
    const staleOracle = oracle(testCase.id, 'PASS', true);
    staleOracle.evidence.collected = ['API_REQUEST@DURING:PRESENT', 'API_RESPONSE@AFTER:PRESENT'];
    staleOracle.evidence.missing = [];
    const [trace] = traces({ testCase, result: cancelled, oracle: staleOracle });
    expect(trace.result).toBe('BLOCKED');
  });

  it('Runner FAIL 与残留 PASS Oracle 冲突时保持 BLOCKED', () => {
    const testCase = apiCase('CASE-FAIL-STALE-PASS', 'FACT-1');
    const staleOracle = oracle(testCase.id, 'PASS', true);
    staleOracle.evidence.collected = ['API_REQUEST@DURING:PRESENT', 'API_RESPONSE@AFTER:PRESENT'];
    staleOracle.evidence.missing = [];
    const [trace] = traces({ testCase, result: apiResult(testCase.id, 'FAIL'), oracle: staleOracle });
    expect(trace.result).toBe('BLOCKED');
  });

  it('keeps GENERATED, EXECUTED, VERIFIED and UNTESTED delivery coverage arithmetically consistent', () => {
    const model = requirementModel(['FACT-PASS', 'FACT-FAIL', 'FACT-BLOCKED', 'FACT-UNTESTED']);
    const deliveryTraces = [
      coverageTrace({ caseId: 'CASE-PASS', factId: 'FACT-PASS', result: 'PASS', execution: 'EXECUTED' }),
      coverageTrace({ caseId: 'CASE-FAIL', factId: 'FACT-FAIL', result: 'FAIL', execution: 'EXECUTED' }),
      coverageTrace({ caseId: 'CASE-BLOCKED', factId: 'FACT-BLOCKED', result: 'BLOCKED', execution: 'EXECUTED' }),
      coverageTrace({ caseId: 'CASE-UNTESTED', factId: 'FACT-UNTESTED', result: 'NOT_TESTED', execution: 'NOT_EXECUTED' }),
    ];

    const coverage = buildDevTestDeliveryCoverage({ requirementModel: model, traces: deliveryTraces });

    expect(coverage.cases).toEqual(expect.objectContaining({
      generated: 4, executable: 4, executed: 3, verified: 2,
      passed: 1, failed: 1, blocked: 1, notTested: 1,
    }));
    expect(coverage.cases.verified).toBeLessThanOrEqual(coverage.cases.executed);
    expect(coverage.cases.executed).toBeLessThanOrEqual(coverage.cases.generated);
    expect(coverage.cases.verified + coverage.cases.blocked + coverage.cases.notTested).toBe(coverage.cases.generated);
    expect(coverage.requirements).toEqual(expect.objectContaining({
      total: 4, generated: 4, executed: 3, verified: 2, blocked: 1, untested: 1,
      generatedCoverage: 100, executedCoverage: 75, verifiedCoverage: 50,
      untestedFactIds: ['FACT-UNTESTED'], blockedFactIds: ['FACT-BLOCKED'],
    }));
    expect(coverage.requirements.verified + coverage.requirements.blocked + coverage.requirements.untested)
      .toBe(coverage.requirements.total);
  });

  it('Evidence Coverage 按 required item 计数，同一 Channel 的 before/after 缺一项不能到 100%', () => {
    const trace = coverageTrace({ caseId: 'CASE-DIFF', factId: 'FACT-1', result: 'BLOCKED', execution: 'EXECUTED' });
    trace.evidence = {
      required: ['DATA_DIFF'], collected: ['DATA_DIFF'], missing: [], complete: false,
      requiredItems: ['EV-BEFORE', 'EV-AFTER'], collectedItems: ['EV-BEFORE'], missingItems: ['EV-AFTER'],
    };
    const coverage = buildDevTestDeliveryCoverage({ requirementModel: requirementModel(['FACT-1']), traces: [trace] });
    expect(coverage.evidence).toEqual(expect.objectContaining({ required: 2, collected: 1, coverage: 50 }));
  });

  it.each<{
    name: string;
    classification: DevTestIssueClassification;
    testCase: TestCase;
    result?: AcceptanceCaseExecutionResult;
    oracle?: DevTestOracleResult;
    problems?: DevTestProblem[];
  }>([
    {
      name: 'deterministic mismatch',
      classification: 'PRODUCT_BUG',
      testCase: apiCase('CASE-PRODUCT', 'FACT-1'),
      result: apiResult('CASE-PRODUCT', 'FAIL'),
      oracle: oracle('CASE-PRODUCT', 'FAIL', true),
      problems: [problem('CASE-PRODUCT', 'PRODUCT_BUG', 'TEST_FAILED')],
    },
    {
      name: 'unknown requirement expectation',
      classification: 'REQUIREMENT_GAP',
      testCase: apiCase('CASE-REQUIREMENT', 'FACT-1'),
      result: apiResult('CASE-REQUIREMENT', 'BLOCKED', { error: 'EXPECTED_OUTCOME_UNKNOWN' }),
      oracle: oracle('CASE-REQUIREMENT', 'BLOCKED', false),
      problems: [problem('CASE-REQUIREMENT', 'REQUIREMENT_ISSUE', 'EXPECTED_OUTCOME_UNKNOWN')],
    },
    {
      name: 'missing deterministic assertion',
      classification: 'TEST_DESIGN_ERROR',
      testCase: apiCase('CASE-DESIGN', 'FACT-1', { assertions: [] }),
      result: apiResult('CASE-DESIGN', 'BLOCKED', { error: 'ASSERTION_MISSING' }),
      oracle: oracle('CASE-DESIGN', 'BLOCKED', false),
      problems: [problem('CASE-DESIGN', 'TEST_ISSUE', 'ASSERTION_MISSING')],
    },
    {
      name: 'network failure',
      classification: 'ENVIRONMENT_ERROR',
      testCase: apiCase('CASE-ENVIRONMENT', 'FACT-1'),
      result: apiResult('CASE-ENVIRONMENT', 'BLOCKED', { error: 'NETWORK_UNREACHABLE ECONNREFUSED' }),
      oracle: oracle('CASE-ENVIRONMENT', 'BLOCKED', false, 'ENVIRONMENT'),
      problems: [problem('CASE-ENVIRONMENT', 'ENVIRONMENT_ISSUE', 'NETWORK_UNREACHABLE')],
    },
    {
      name: 'processor unavailable',
      classification: 'EXECUTION_ERROR',
      testCase: apiCase('CASE-EXECUTION', 'FACT-1'),
      result: apiResult('CASE-EXECUTION', 'BLOCKED', { error: 'PROCESSOR_MISSING' }),
      oracle: oracle('CASE-EXECUTION', 'BLOCKED', false, 'PROCESSOR'),
      problems: [problem('CASE-EXECUTION', 'UNSUPPORTED', 'PROCESSOR_MISSING')],
    },
    {
      name: 'case not selected for this run',
      classification: 'NOT_TESTED',
      testCase: apiCase('CASE-NOT-TESTED', 'FACT-1'),
      result: apiResult('CASE-NOT-TESTED', 'NOT_EXECUTED'),
      oracle: oracle('CASE-NOT-TESTED', 'BLOCKED', false),
      problems: [],
    },
  ])('classifies $name as $classification', ({ testCase, result, oracle: oracleResult, problems, classification }) => {
    const [trace] = traces({ testCase, result, oracle: oracleResult, problems });
    expect(trace.classification).toBe(classification);
    expect(trace.result === 'PASS' && classification !== 'NONE').toBe(false);
  });
});
