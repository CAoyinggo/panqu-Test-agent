import { describe, expect, it, vi } from 'vitest';
import type {
  EvidenceEnvelope,
  EvidenceRequirement,
  Scenario,
  ScenarioAssertion,
  ScenarioOperation,
  ScenarioResult,
} from '../../src/acceptance/scenario-contract.js';
import { enforceScenarioResultIntegrity } from '../../src/acceptance/scenario-report.js';
import { runScenario, type ScenarioProcessor } from '../../src/acceptance/scenario-runner.js';

function evidence(
  scenario: Scenario,
  operation: ScenarioOperation,
  kind: EvidenceEnvelope['kind'],
  channel: EvidenceEnvelope['channel'],
  data: unknown,
): EvidenceEnvelope {
  const requirement = scenario.evidenceRequirements.find((item) => (
    item.operationId === operation.id && item.kind === kind
  ));
  return {
    id: requirement?.id ?? `${operation.id}:${kind}`,
    requirementId: requirement?.id,
    scenarioId: scenario.id,
    operationId: operation.id,
    acceptanceCriteriaIds: operation.acceptanceCriteriaIds,
    kind,
    channel,
    source: 'controlled-test-processor',
    observedAt: new Date().toISOString(),
    data,
    verified: true,
  };
}

function baseScenario(): Scenario {
  return {
    schemaVersion: '1.0',
    id: 'SCN-RUNNER-BASIC',
    title: 'read resource',
    domain: 'generic',
    requirement: '读取存在的资源时返回资源状态。',
    sources: [{ documentId: 'scenario-runner.test.ts', requirementId: 'REQ-1' }],
    acceptanceCriteriaIds: ['AC-001'],
    patternIds: ['FUNCTIONAL', 'API_CONTRACT'],
    scope: {},
    preconditions: [{ id: 'PRE-001', kind: 'DATA', description: '资源存在', required: true }],
    testData: [{ id: 'DATA-001', source: 'EXPLICIT', value: { id: 'resource-1' }, resourceOwnerId: 'actor-1' }],
    operations: [{
      id: 'STEP-001', channel: 'API', description: 'read resource', processor: 'memory-api',
      method: 'GET', path: '/resources/resource-1', acceptanceCriteriaIds: ['AC-001'],
    }],
    assertions: [{
      id: 'AS-001', channel: 'RESPONSE', target: 'status', operator: 'EQUALS', expected: 200,
      acceptanceCriteriaIds: ['AC-001'], operationId: 'STEP-001', evidenceRequirementIds: ['EV-001'],
    }],
    evidenceRequirements: [{
      id: 'EV-001', kind: 'RESPONSE', channel: 'RESPONSE', description: '真实响应', requiredForPass: true,
      operationId: 'STEP-001', sourceRef: 'STEP-001', assertionIds: ['AS-001'],
    }],
    prepare: [], cleanup: [], executionMode: 'EXECUTABLE', blockedReasons: [], risks: [], priority: 'P0', dependencies: [],
  };
}

function processor(
  handler: ScenarioProcessor['execute'],
  supportedEvidenceKinds: ScenarioProcessor['supportedEvidenceKinds'] = ['RESPONSE'],
): ScenarioProcessor {
  return { name: 'memory-api', supportsAbort: true, supportedEvidenceKinds, supports: () => true, execute: handler };
}

const runnerOptions = (processors: ScenarioProcessor[]) => ({
  processors,
  environmentAvailable: true,
  policyAllowed: true,
});

describe('Scenario Runner fail-closed contract', () => {
  it('returns PASS only after a Processor executed, an assertion passed and required Evidence exists', async () => {
    const scenario = baseScenario();
    const execute = vi.fn<ScenarioProcessor['execute']>(async (operation, context) => {
      const response = { status: 200, body: { id: 'resource-1' } };
      return { status: 'PASS', executed: true, output: response, evidence: [evidence(context.scenario, operation, 'RESPONSE', 'RESPONSE', response)] };
    });
    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));

    expect(outcome.result).toMatchObject({
      status: 'PASS', executed: true, processorInvoked: true, processors: ['memory-api'],
      assertions: 1, passedAssertions: 1, failedAssertions: 0,
    });
    expect(outcome.result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'RESPONSE', verified: true }),
      expect.objectContaining({ assertionId: 'AS-001', verified: true }),
    ]));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns FAIL when an observed business assertion fails', async () => {
    const scenario = baseScenario();
    const execute: ScenarioProcessor['execute'] = async (operation, context) => {
      const response = { status: 500, body: {} };
      return { status: 'PASS', executed: true, output: response, evidence: [evidence(context.scenario, operation, 'RESPONSE', 'RESPONSE', response)] };
    };
    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));
    expect(outcome.result).toMatchObject({ status: 'FAIL', executed: true, assertions: 1, passedAssertions: 0, failedAssertions: 1 });
  });

  it('requires a Processor-declared FAIL to be backed by a failed Scenario assertion', async () => {
    const scenario = baseScenario();
    const execute: ScenarioProcessor['execute'] = async (operation, context) => {
      const response = { status: 500, body: {} };
      return {
        status: 'FAIL', executed: true, output: response,
        evidence: [evidence(context.scenario, operation, 'RESPONSE', 'RESPONSE', response)],
      };
    };
    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));
    expect(outcome.result).toMatchObject({ status: 'FAIL', executed: true, failedAssertions: 1 });
    expect(outcome.result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ assertionId: 'AS-001', verified: true, data: expect.objectContaining({ pass: false }) }),
    ]));
  });

  it('blocks a Processor-declared FAIL when no failed business assertion can be proven', async () => {
    const scenario = baseScenario();
    const execute: ScenarioProcessor['execute'] = async () => ({
      status: 'FAIL', executed: true, output: { status: 500 }, evidence: [],
    });
    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));
    expect(outcome.result).toMatchObject({ status: 'BLOCKED', failedAssertions: 0 });
    expect(outcome.result.blockedReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'ASSERTION' }),
    ]));
  });

  it('blocks before Prepare and execution when the Processor is absent', async () => {
    const scenario = baseScenario();
    const prepare = vi.fn(async () => undefined);
    scenario.prepare = [{ id: 'PREPARE-001', phase: 'PREPARE', handler: 'prepare-data', required: true }];
    const outcome = await runScenario(scenario, {
      ...runnerOptions([]), prepareHooks: new Map([['prepare-data', prepare]]),
    });
    expect(outcome.result).toMatchObject({ status: 'BLOCKED', executed: false, processorInvoked: false });
    expect(outcome.result.blockedReasons.some((item) => item.code === 'MISSING_PROCESSOR')).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('blocks without invoking a Processor when no assertion exists', async () => {
    const scenario = baseScenario();
    scenario.assertions = [];
    scenario.evidenceRequirements = [];
    const execute = vi.fn<ScenarioProcessor['execute']>();
    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));
    expect(outcome.result).toMatchObject({ status: 'BLOCKED', executed: false, assertions: 0 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps DESIGNED_ONLY as NOT_EXECUTED and never invokes a Processor', async () => {
    const scenario = baseScenario();
    scenario.executionMode = 'DESIGNED_ONLY';
    const execute = vi.fn<ScenarioProcessor['execute']>();
    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));
    expect(outcome.result).toMatchObject({ status: 'NOT_EXECUTED', executed: false, processorInvoked: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('aborts an in-flight Processor and returns TIMEOUT', async () => {
    const scenario = baseScenario();
    scenario.operations[0].timeoutMs = 5;
    let abortObserved = false;
    const execute: ScenarioProcessor['execute'] = async (_operation, context) => await new Promise((resolve) => {
      context.signal.addEventListener('abort', () => {
        abortObserved = true;
        resolve({ status: 'TIMEOUT', executed: false, evidence: [] });
      }, { once: true });
    });
    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));
    expect(outcome.result).toMatchObject({ status: 'TIMEOUT', executed: false, processorInvoked: true });
    expect(abortObserved).toBe(true);
  });

  it('blocks an otherwise successful operation when required Evidence was not captured', async () => {
    const scenario = baseScenario();
    const execute: ScenarioProcessor['execute'] = async () => ({ status: 'PASS', executed: true, output: { status: 200 }, evidence: [] });
    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));
    expect(outcome.result.status).toBe('BLOCKED');
    expect(outcome.result.blockedReasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'MISSING_EVIDENCE' })]));
  });

  it('proves a rejected write did not mutate state using independent Before/After evidence', async () => {
    const scenario = baseScenario();
    scenario.id = 'SCN-NON-MUTATION';
    scenario.patternIds = ['FUNCTIONAL', 'API_CONTRACT', 'NON_MUTATION'];
    scenario.operations = [
      { ...scenario.operations[0], id: 'STEP-001', description: 'state before' },
      { ...scenario.operations[0], id: 'STEP-002', description: 'denied write', method: 'PATCH' },
      { ...scenario.operations[0], id: 'STEP-003', description: 'state after' },
    ];
    scenario.assertions = [
      { ...scenario.assertions[0], id: 'AS-BEFORE', operationId: 'STEP-001', expected: 200, evidenceRequirementIds: ['EV-BEFORE'] },
      { ...scenario.assertions[0], id: 'AS-001', operationId: 'STEP-002', expected: 403, evidenceRequirementIds: ['EV-REJECT'] },
      { id: 'AS-002', channel: 'STATE', target: 'body.name', operator: 'UNCHANGED', expectedFrom: 'STEP-001.output.body.name', operationId: 'STEP-003', acceptanceCriteriaIds: ['AC-001'], evidenceRequirementIds: ['EV-AFTER'] },
    ];
    scenario.evidenceRequirements = [
      { id: 'EV-BEFORE', kind: 'STATE_BEFORE', channel: 'STATE', description: 'before', requiredForPass: true, operationId: 'STEP-001', sourceRef: 'STEP-001', assertionIds: ['AS-BEFORE'] },
      { id: 'EV-REJECT', kind: 'RESPONSE', channel: 'RESPONSE', description: 'rejection', requiredForPass: true, operationId: 'STEP-002', sourceRef: 'STEP-002', assertionIds: ['AS-001'] },
      { id: 'EV-AFTER', kind: 'STATE_AFTER', channel: 'STATE', description: 'after', requiredForPass: true, operationId: 'STEP-003', sourceRef: 'STEP-003', assertionIds: ['AS-002'] },
    ];
    scenario.cleanup = [{ id: 'CLEANUP-001', phase: 'CLEANUP', handler: 'cleanup-resource', required: true }];
    let state = { name: 'before' };
    const execute: ScenarioProcessor['execute'] = async (operation, context) => {
      const output = operation.id === 'STEP-002' ? { status: 403, body: { code: 'FORBIDDEN' } } : { status: 200, body: { ...state } };
      const kind = operation.id === 'STEP-001' ? 'STATE_BEFORE' : operation.id === 'STEP-003' ? 'STATE_AFTER' : 'RESPONSE';
      const channel = kind === 'RESPONSE' ? 'RESPONSE' : 'STATE';
      return { status: 'PASS', executed: true, output, evidence: [evidence(context.scenario, operation, kind, channel, output)] };
    };
    const outcome = await runScenario(scenario, {
      ...runnerOptions([processor(execute, ['RESPONSE', 'STATE_BEFORE', 'STATE_AFTER'])]),
      cleanupHooks: new Map([['cleanup-resource', async () => { state = { name: 'cleaned' }; }]]),
    });
    expect(outcome.result).toMatchObject({ status: 'PASS', assertions: 3, passedAssertions: 3 });
  });

  it('detects duplicate business side effects in an idempotency scenario', async () => {
    const scenario = baseScenario();
    scenario.id = 'SCN-IDEMPOTENCY';
    scenario.patternIds = ['FUNCTIONAL', 'API_CONTRACT', 'IDEMPOTENCY'];
    scenario.operations = [
      { ...scenario.operations[0], id: 'STEP-001', method: 'POST' },
      { ...scenario.operations[0], id: 'STEP-002', method: 'POST', dependsOn: ['STEP-001'] },
    ];
    scenario.assertions = [
      { ...scenario.assertions[0], id: 'AS-FIRST', operationId: 'STEP-001', evidenceRequirementIds: ['EV-FIRST'] },
      { ...scenario.assertions[0], operationId: 'STEP-002', evidenceRequirementIds: ['EV-RESPONSE'] },
      { id: 'AS-ENTITY-COUNT', channel: 'STATE', target: 'entityCount', operator: 'COUNT_EQUALS', expected: 1, operationId: 'STEP-002', acceptanceCriteriaIds: ['AC-001'], evidenceRequirementIds: ['EV-STATE'] },
      { id: 'AS-SIDE-EFFECT-COUNT', channel: 'SIDE_EFFECT', target: 'entityCount', operator: 'COUNT_EQUALS', expected: 1, operationId: 'STEP-002', acceptanceCriteriaIds: ['AC-001'], evidenceRequirementIds: ['EV-EVENT'] },
    ];
    scenario.evidenceRequirements = [
      { id: 'EV-FIRST', kind: 'RESPONSE', channel: 'RESPONSE', description: 'first response', requiredForPass: true, operationId: 'STEP-001', sourceRef: 'STEP-001', assertionIds: ['AS-FIRST'] },
      { id: 'EV-RESPONSE', kind: 'RESPONSE', channel: 'RESPONSE', description: 'response', requiredForPass: true, operationId: 'STEP-002', sourceRef: 'STEP-002', assertionIds: ['AS-001'] },
      { id: 'EV-STATE', kind: 'STATE_AFTER', channel: 'STATE', description: 'entity count', requiredForPass: true, operationId: 'STEP-002', sourceRef: 'STEP-002', assertionIds: ['AS-ENTITY-COUNT'] },
      { id: 'EV-EVENT', kind: 'EVENT', channel: 'SIDE_EFFECT', description: 'side effect count', requiredForPass: true, operationId: 'STEP-002', sourceRef: 'STEP-002', assertionIds: ['AS-SIDE-EFFECT-COUNT'] },
    ];
    scenario.cleanup = [{ id: 'CLEANUP-001', phase: 'CLEANUP', handler: 'cleanup', required: true }];
    let entities = 0;
    const execute: ScenarioProcessor['execute'] = async (operation, context) => {
      entities++;
      const output = { status: 200, entityCount: entities };
      return { status: 'PASS', executed: true, output, evidence: [
        evidence(context.scenario, operation, 'RESPONSE', 'RESPONSE', output),
        ...(operation.id === 'STEP-002' ? [evidence(context.scenario, operation, 'STATE_AFTER', 'STATE', { entityCount: entities })] : []),
        evidence(context.scenario, operation, 'EVENT', 'SIDE_EFFECT', { entityCount: entities }),
      ] };
    };
    const outcome = await runScenario(scenario, {
      ...runnerOptions([processor(execute, ['RESPONSE', 'STATE_AFTER', 'EVENT'])]),
      cleanupHooks: new Map([['cleanup', async () => undefined]]),
    });
    expect(outcome.result).toMatchObject({ status: 'FAIL', failedAssertions: 2 });
  });

  it('proves a billing operation created exactly one ledger entry', async () => {
    const scenario = baseScenario();
    scenario.id = 'SCN-BILLING-ONCE';
    scenario.patternIds = ['FUNCTIONAL', 'API_CONTRACT', 'BILLING'];
    scenario.operations[0] = { ...scenario.operations[0], method: 'POST', description: 'charge once' };
    scenario.assertions = [
      { ...scenario.assertions[0], evidenceRequirementIds: ['EV-RESPONSE'] },
      { id: 'AS-BEFORE', channel: 'STATE', target: 'beforeBalance', operator: 'EQUALS', expected: 100, operationId: 'STEP-001', acceptanceCriteriaIds: ['AC-001'], evidenceRequirementIds: ['EV-BEFORE'] },
      { id: 'AS-AFTER', channel: 'STATE', target: 'afterBalance', operator: 'EQUALS', expected: 90, operationId: 'STEP-001', acceptanceCriteriaIds: ['AC-001'], evidenceRequirementIds: ['EV-AFTER'] },
      { id: 'AS-BILLING', channel: 'SIDE_EFFECT', target: 'ledgerEntries', operator: 'COUNT_EQUALS', expected: 1, operationId: 'STEP-001', acceptanceCriteriaIds: ['AC-001'], evidenceRequirementIds: ['EV-BILLING'] },
    ];
    scenario.evidenceRequirements = [
      { id: 'EV-RESPONSE', kind: 'RESPONSE', channel: 'RESPONSE', description: 'charge response', requiredForPass: true, operationId: 'STEP-001', sourceRef: 'STEP-001', assertionIds: ['AS-001'] },
      { id: 'EV-BEFORE', kind: 'STATE_BEFORE', channel: 'STATE', description: 'balance before', requiredForPass: true, operationId: 'STEP-001', sourceRef: 'STEP-001', assertionIds: ['AS-BEFORE'] },
      { id: 'EV-AFTER', kind: 'STATE_AFTER', channel: 'STATE', description: 'balance after', requiredForPass: true, operationId: 'STEP-001', sourceRef: 'STEP-001', assertionIds: ['AS-AFTER'] },
      { id: 'EV-BILLING', kind: 'BILLING_RECORD', channel: 'SIDE_EFFECT', description: 'ledger', requiredForPass: true, operationId: 'STEP-001', sourceRef: 'STEP-001', assertionIds: ['AS-BILLING'] },
    ];
    scenario.cleanup = [{ id: 'CLEANUP-001', phase: 'CLEANUP', handler: 'cleanup-ledger', required: true }];
    const execute: ScenarioProcessor['execute'] = async (operation, context) => {
      const output = { status: 200, beforeBalance: 100, afterBalance: 90, ledgerEntries: [{ id: 'ledger-1', delta: -10 }] };
      return { status: 'PASS', executed: true, output, evidence: [
        evidence(context.scenario, operation, 'RESPONSE', 'RESPONSE', output),
        evidence(context.scenario, operation, 'STATE_BEFORE', 'STATE', output),
        evidence(context.scenario, operation, 'STATE_AFTER', 'STATE', output),
        evidence(context.scenario, operation, 'BILLING_RECORD', 'SIDE_EFFECT', output),
      ] };
    };
    const outcome = await runScenario(scenario, {
      ...runnerOptions([processor(execute, ['RESPONSE', 'STATE_BEFORE', 'STATE_AFTER', 'BILLING_RECORD'])]),
      cleanupHooks: new Map([['cleanup-ledger', async () => undefined]]),
    });
    expect(outcome.result).toMatchObject({ status: 'PASS', assertions: 4, passedAssertions: 4 });
  });

  it('does not pass an illegal state transition that mutated the resource', async () => {
    const scenario = baseScenario();
    scenario.id = 'SCN-STATE-MACHINE';
    scenario.patternIds = ['FUNCTIONAL', 'API_CONTRACT', 'STATE_MACHINE'];
    scenario.operations = [
      { ...scenario.operations[0], id: 'STEP-001', description: 'state before' },
      { ...scenario.operations[0], id: 'STEP-002', method: 'POST', description: 'illegal transition' },
    ];
    scenario.assertions = [
      { id: 'AS-BEFORE', channel: 'STATE', target: 'body.state', operator: 'EQUALS', expected: 'DONE', operationId: 'STEP-001', acceptanceCriteriaIds: ['AC-001'], evidenceRequirementIds: ['EV-BEFORE'] },
      { ...scenario.assertions[0], id: 'AS-REJECT', operationId: 'STEP-002', expected: 409, evidenceRequirementIds: ['EV-RESPONSE'] },
      { id: 'AS-STATE', channel: 'STATE', target: 'body.state', operator: 'UNCHANGED', expectedFrom: 'STEP-001.output.body.state', operationId: 'STEP-002', acceptanceCriteriaIds: ['AC-001'], evidenceRequirementIds: ['EV-AFTER'] },
    ];
    scenario.evidenceRequirements = [
      { id: 'EV-BEFORE', kind: 'STATE_BEFORE', channel: 'STATE', description: 'before', requiredForPass: true, operationId: 'STEP-001', sourceRef: 'STEP-001', assertionIds: ['AS-BEFORE'] },
      { id: 'EV-RESPONSE', kind: 'RESPONSE', channel: 'RESPONSE', description: 'rejected transition', requiredForPass: true, operationId: 'STEP-002', sourceRef: 'STEP-002', assertionIds: ['AS-REJECT'] },
      { id: 'EV-AFTER', kind: 'STATE_AFTER', channel: 'STATE', description: 'after', requiredForPass: true, operationId: 'STEP-002', sourceRef: 'STEP-002', assertionIds: ['AS-STATE'] },
    ];
    scenario.cleanup = [{ id: 'CLEANUP-001', phase: 'CLEANUP', handler: 'cleanup-state', required: true }];
    const execute: ScenarioProcessor['execute'] = async (operation, context) => {
      const output = operation.id === 'STEP-001' ? { status: 200, body: { state: 'DONE' } } : { status: 409, body: { state: 'RUNNING' } };
      const kinds: EvidenceEnvelope[] = operation.id === 'STEP-001'
        ? [evidence(context.scenario, operation, 'STATE_BEFORE', 'STATE', output)]
        : [evidence(context.scenario, operation, 'RESPONSE', 'RESPONSE', output), evidence(context.scenario, operation, 'STATE_AFTER', 'STATE', output)];
      return { status: 'PASS', executed: true, output, evidence: kinds };
    };
    const outcome = await runScenario(scenario, {
      ...runnerOptions([processor(execute, ['RESPONSE', 'STATE_BEFORE', 'STATE_AFTER'])]),
      cleanupHooks: new Map([['cleanup-state', async () => undefined]]),
    });
    expect(outcome.result).toMatchObject({ status: 'FAIL', failedAssertions: 1 });
  });

  it('executes a multi-API flow in order and binds captured output into the next request', async () => {
    const scenario = baseScenario();
    scenario.id = 'SCN-MULTI-API';
    scenario.operations = [
      { ...scenario.operations[0], id: 'STEP-001', method: 'POST', path: '/uploads', capture: { uploadId: 'body.id' } },
      { ...scenario.operations[0], id: 'STEP-002', method: 'POST', path: '/tasks', input: { uploadId: '${STEP-001.uploadId}' }, dependsOn: ['STEP-001'] },
    ];
    scenario.assertions = [
      { ...scenario.assertions[0], id: 'AS-UPLOAD', operationId: 'STEP-001', expected: 201, evidenceRequirementIds: ['EV-UPLOAD'] },
      { ...scenario.assertions[0], id: 'AS-TASK', operationId: 'STEP-002', expected: 201, evidenceRequirementIds: ['EV-TASK'] },
    ];
    scenario.evidenceRequirements = [
      { id: 'EV-UPLOAD', kind: 'RESPONSE', channel: 'RESPONSE', description: 'upload', requiredForPass: true, operationId: 'STEP-001', sourceRef: 'STEP-001', assertionIds: ['AS-UPLOAD'] },
      { id: 'EV-TASK', kind: 'RESPONSE', channel: 'RESPONSE', description: 'task', requiredForPass: true, operationId: 'STEP-002', sourceRef: 'STEP-002', assertionIds: ['AS-TASK'] },
    ];
    scenario.cleanup = [{ id: 'CLEANUP-001', phase: 'CLEANUP', handler: 'cleanup-flow', required: true }];
    const seen: string[] = [];
    const execute: ScenarioProcessor['execute'] = async (operation, context) => {
      seen.push(operation.id);
      if (operation.id === 'STEP-002') expect(operation.input).toEqual({ uploadId: 'upload-1' });
      const output = operation.id === 'STEP-001' ? { status: 201, body: { id: 'upload-1' } } : { status: 201, body: { id: 'task-1' } };
      return { status: 'PASS', executed: true, output, evidence: [evidence(context.scenario, operation, 'RESPONSE', 'RESPONSE', output)] };
    };
    const outcome = await runScenario(scenario, {
      ...runnerOptions([processor(execute)]), cleanupHooks: new Map([['cleanup-flow', async () => undefined]]),
    });
    expect(seen).toEqual(['STEP-001', 'STEP-002']);
    expect(outcome.result).toMatchObject({ status: 'PASS', assertions: 2, passedAssertions: 2 });
  });

  it('blocks forged PASS at the report integrity boundary', () => {
    const scenario = baseScenario();
    const forged: ScenarioResult = {
      scenarioId: scenario.id, status: 'PASS', executionMode: 'EXECUTABLE', executed: false,
      processorInvoked: false, processors: [], assertions: 0, passedAssertions: 0, failedAssertions: 0,
      evidence: [], blockedReasons: [], operationResults: [],
    };
    expect(enforceScenarioResultIntegrity(scenario, forged)).toMatchObject({
      status: 'BLOCKED', blockedReasons: [expect.objectContaining({ stage: 'REPORT' })],
    });
  });

  it('blocks a forged PASS whose counters claim success but no per-assertion result evidence exists', () => {
    const scenario = baseScenario();
    const observed = evidence(scenario, scenario.operations[0], 'RESPONSE', 'RESPONSE', { status: 200 });
    const forged: ScenarioResult = {
      scenarioId: scenario.id, status: 'PASS', executionMode: 'EXECUTABLE', executed: true,
      processorInvoked: true, processors: ['memory-api'], assertions: 1, passedAssertions: 1,
      failedAssertions: 0, evidence: [observed], blockedReasons: [],
      operationResults: [{
        operationId: 'STEP-001', status: 'PASS', executed: true, processor: 'memory-api',
        processorInvoked: true, evidence: [observed], blockedReasons: [],
      }],
    };
    const result = enforceScenarioResultIntegrity(scenario, forged);
    expect(result.status).toBe('BLOCKED');
    expect(result.blockedReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'REPORT', message: expect.stringContaining('逐断言') }),
    ]));
  });
});
