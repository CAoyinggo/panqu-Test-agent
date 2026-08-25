import { describe, expect, it, vi } from 'vitest';
import {
  computeOutcome,
  normalizeCaseExecutionResult,
} from '../../src/agents/execution/execution-schema.js';
import type { ApiSpec } from '../../src/acceptance/requirement-ir.js';
import type {
  BlockedReason,
  EvidenceEnvelope,
  EvidenceRequirement,
  Scenario,
  ScenarioAssertion,
  ScenarioOperation,
  ScenarioResult,
} from '../../src/acceptance/scenario-contract.js';
import {
  evaluateScenarioExecutability,
  type ScenarioExecutionCapabilities,
} from '../../src/acceptance/scenario-executability-gate.js';
import { scoreScenarioQuality } from '../../src/acceptance/scenario-quality.js';
import { buildScenarioExecutionReport } from '../../src/acceptance/scenario-report.js';
import {
  createAcceptanceHttpScenarioProcessor,
  runScenario,
  type ScenarioProcessor,
} from '../../src/acceptance/scenario-runner.js';

function baseScenario(): Scenario {
  return {
    schemaVersion: '1.0',
    id: 'SCN-ADVERSARIAL',
    title: 'adversarial integrity contract',
    domain: 'integrity',
    requirement: '只有真实执行、有效断言和可验证证据完整时才允许 PASS。',
    sources: [{ documentId: 'scenario-adversarial-integrity.test.ts', requirementId: 'REQ-INTEGRITY' }],
    acceptanceCriteriaIds: ['AC-001'],
    patternIds: ['FUNCTIONAL', 'API_CONTRACT'],
    scope: {},
    preconditions: [],
    testData: [],
    operations: [{
      id: 'STEP-001',
      channel: 'API',
      description: 'read controlled resource',
      processor: 'memory-api',
      method: 'GET',
      path: '/resources/r-1',
      acceptanceCriteriaIds: ['AC-001'],
    }],
    assertions: [{
      id: 'AS-001',
      channel: 'RESPONSE',
      target: 'status',
      operator: 'EQUALS',
      expected: 200,
      acceptanceCriteriaIds: ['AC-001'],
      operationId: 'STEP-001',
      evidenceRequirementIds: ['EV-001'],
    }],
    evidenceRequirements: [{
      id: 'EV-001',
      kind: 'RESPONSE',
      channel: 'RESPONSE',
      description: 'verified response',
      requiredForPass: true,
      operationId: 'STEP-001',
      sourceRef: 'STEP-001',
      assertionIds: ['AS-001'],
    }],
    prepare: [],
    cleanup: [],
    executionMode: 'EXECUTABLE',
    blockedReasons: [],
    risks: [],
    priority: 'P0',
    dependencies: [],
  };
}

function evidence(
  scenario: Scenario,
  operation: ScenarioOperation,
  options: {
    id?: string;
    kind?: EvidenceEnvelope['kind'];
    channel?: EvidenceEnvelope['channel'];
    data?: unknown;
    verified?: boolean;
    assertionId?: string;
  } = {},
): EvidenceEnvelope {
  return {
    id: options.id ?? 'EV-001',
    scenarioId: scenario.id,
    operationId: operation.id,
    assertionId: options.assertionId,
    acceptanceCriteriaIds: operation.acceptanceCriteriaIds,
    kind: options.kind ?? 'RESPONSE',
    channel: options.channel ?? 'RESPONSE',
    source: 'adversarial-controlled-processor',
    observedAt: new Date().toISOString(),
    data: options.data ?? { status: 200 },
    verified: options.verified ?? true,
  };
}

function processor(
  execute: ScenarioProcessor['execute'],
  supportedEvidenceKinds: ScenarioProcessor['supportedEvidenceKinds'] = ['RESPONSE'],
  name = 'memory-api',
): ScenarioProcessor {
  return {
    name,
    supportsAbort: true,
    supportedEvidenceKinds,
    supports: () => true,
    execute,
  };
}

function runnerOptions(processors: readonly ScenarioProcessor[]) {
  return {
    processors,
    environmentAvailable: true,
    policyAllowed: true,
  };
}

function capabilities(
  scenario: Scenario,
  options: Partial<ScenarioExecutionCapabilities> = {},
): ScenarioExecutionCapabilities {
  return {
    processors: new Set(scenario.operations.flatMap((operation) => operation.processor ? [operation.processor] : [])),
    evidenceKinds: new Set(scenario.evidenceRequirements.map((requirement) => requirement.kind)),
    prepareHooks: new Set(scenario.prepare.map((hook) => hook.handler)),
    cleanupHooks: new Set(scenario.cleanup.map((hook) => hook.handler)),
    availableDependencies: new Set(scenario.dependencies),
    executorAvailable: true,
    environmentAvailable: true,
    policyAllowed: true,
    supportsOperation: () => true,
    ...options,
  };
}

function twoOperationScenario(): Scenario {
  const scenario = baseScenario();
  scenario.operations = [
    { ...scenario.operations[0], id: 'STEP-A' },
    { ...scenario.operations[0], id: 'STEP-B' },
  ];
  scenario.assertions = scenario.operations.map((operation, index): ScenarioAssertion => ({
    id: `AS-${operation.id}`,
    channel: 'RESPONSE',
    target: 'status',
    operator: 'EQUALS',
    expected: 200,
    acceptanceCriteriaIds: ['AC-001'],
    operationId: operation.id,
    evidenceRequirementIds: [`EV-${operation.id}`],
    severity: index === 0 ? 'P0' : 'P1',
  }));
  scenario.evidenceRequirements = scenario.operations.map((operation): EvidenceRequirement => ({
    id: `EV-${operation.id}`,
    kind: 'RESPONSE',
    channel: 'RESPONSE',
    description: `${operation.id} verified response`,
    requiredForPass: true,
    operationId: operation.id,
    sourceRef: operation.id,
    assertionIds: [`AS-${operation.id}`],
  }));
  return scenario;
}

describe('Scenario adversarial integrity regressions', () => {
  it('[P0] HTTP adapter binds the exact ApiSpec and reaches a real fetch implementation', async () => {
    const scenario = baseScenario();
    scenario.operations[0] = {
      ...scenario.operations[0],
      processor: 'api',
      // Canonical binding must remain explicit instead of being guessed from prose.
      apiSpecId: 'API-RESOURCE-READ',
    } as ScenarioOperation & { apiSpecId: string };

    const apiSpec: ApiSpec = {
      id: 'API-RESOURCE-READ',
      operationKey: 'GET /resources/r-1',
      authPolicy: 'AUTH_UNKNOWN',
      method: 'GET',
      path: '/resources/r-1',
      pathParams: [],
      query: [],
      headers: [],
      body: [],
      responses: [{ status: 200 }],
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { id: 'r-1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const httpProcessor = createAcceptanceHttpScenarioProcessor({
      baseUrl: 'http://fixture.invalid',
      apiSpecs: [apiSpec],
      fetchImpl,
    });

    const outcome = await runScenario(scenario, runnerOptions([httpProcessor]));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome.result).toMatchObject({
      status: 'PASS',
      executed: true,
      processorInvoked: true,
      passedAssertions: 1,
      failedAssertions: 0,
    });
  });

  it('[P0] blocks the whole Scenario before an unasserted write Operation can run', async () => {
    const scenario = baseScenario();
    scenario.operations = [
      {
        id: 'STEP-WRITE', channel: 'API', description: 'unasserted write', processor: 'memory-api',
        method: 'POST', path: '/resources', acceptanceCriteriaIds: ['AC-001'],
      },
      { ...scenario.operations[0], id: 'STEP-READ', dependsOn: ['STEP-WRITE'] },
    ];
    scenario.assertions = [{ ...scenario.assertions[0], operationId: 'STEP-READ' }];
    scenario.evidenceRequirements = [{ ...scenario.evidenceRequirements[0], operationId: 'STEP-READ', sourceRef: 'STEP-READ' }];
    scenario.cleanup = [{ id: 'CLEANUP-001', phase: 'CLEANUP', handler: 'cleanup-resource', required: true }];

    let writes = 0;
    const execute = vi.fn<ScenarioProcessor['execute']>(async (operation, context) => {
      if (operation.id === 'STEP-WRITE') writes++;
      const output = { status: 200 };
      return {
        status: 'PASS',
        executed: true,
        output,
        evidence: operation.id === 'STEP-READ'
          ? [evidence(context.scenario, operation, { data: output })]
          : [],
      };
    });
    const outcome = await runScenario(scenario, {
      ...runnerOptions([processor(execute)]),
      cleanupHooks: new Map([['cleanup-resource', async () => undefined]]),
    });

    expect(outcome.gate.allowed).toBe(false);
    expect(outcome.result.status).toBe('BLOCKED');
    expect(execute).not.toHaveBeenCalled();
    expect(writes).toBe(0);
  });

  it('[P0] rejects unverified Evidence with the wrong Evidence Requirement ID', async () => {
    const scenario = baseScenario();
    const execute: ScenarioProcessor['execute'] = async (operation, context) => ({
      status: 'PASS',
      executed: true,
      output: { status: 200 },
      evidence: [evidence(context.scenario, operation, {
        id: 'EV-WRONG',
        data: { status: 999 },
        verified: false,
      })],
    });

    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));

    expect(outcome.result.status).toBe('BLOCKED');
    expect(outcome.result.passedAssertions).toBe(0);
    expect(outcome.result.blockedReasons.some((reason) => reason.code === 'MISSING_EVIDENCE')).toBe(true);
  });

  it('[P0] rejects Evidence that a Processor labels with another Scenario identity', async () => {
    const scenario = baseScenario();
    const execute: ScenarioProcessor['execute'] = async (operation, context) => ({
      status: 'PASS',
      executed: true,
      output: { status: 200 },
      evidence: [{
        ...evidence(context.scenario, operation, { data: { status: 200 } }),
        scenarioId: 'SCN-ANOTHER-RUN',
      }],
    });

    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));

    expect(outcome.result.status).toBe('BLOCKED');
    expect(outcome.result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ scenarioId: scenario.id, verified: false }),
    ]));
  });

  it('[P0] blocks an unresolved expectedFrom before NOT_EQUALS can turn undefined into a passing oracle', async () => {
    const scenario = baseScenario();
    scenario.assertions[0] = {
      ...scenario.assertions[0],
      operator: 'NOT_EQUALS',
      expected: undefined,
      expectedFrom: 'missing.oracle',
    };
    const execute = vi.fn<ScenarioProcessor['execute']>(async (operation, context) => {
      const output = { status: 200 };
      return {
        status: 'PASS', executed: true, output,
        evidence: [evidence(context.scenario, operation, { data: output })],
      };
    });

    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));

    expect(outcome.result.status).toBe('BLOCKED');
    expect(outcome.result.passedAssertions).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('[P0] aborts a timeout-aware Processor before its delayed side effect', async () => {
    const scenario = baseScenario();
    scenario.operations[0] = { ...scenario.operations[0], method: 'POST', timeoutMs: 5 };
    scenario.cleanup = [{ id: 'CLEANUP-001', phase: 'CLEANUP', handler: 'cleanup-resource', required: true }];
    let delayedSideEffects = 0;
    const execute: ScenarioProcessor['execute'] = async (operation, context) => await new Promise((resolve) => {
      const timer = setTimeout(() => {
        delayedSideEffects++;
        const output = { status: 200 };
        resolve({
          status: 'PASS', executed: true, output,
          evidence: [evidence(context.scenario, operation, { data: output })],
        });
      }, 30);
      context.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve({ status: 'TIMEOUT', executed: false, evidence: [] });
      }, { once: true });
    });

    const outcome = await runScenario(scenario, {
      ...runnerOptions([processor(execute)]),
      cleanupHooks: new Map([['cleanup-resource', async () => undefined]]),
    });
    await new Promise((resolve) => setTimeout(resolve, 45));

    expect(outcome.result.status).toBe('TIMEOUT');
    expect(delayedSideEffects).toBe(0);
  });

  it('[P0] Report downgrades a structurally complete forged PASS when the Gate blocked execution', () => {
    const scenario = baseScenario();
    const responseEvidence = evidence(scenario, scenario.operations[0], {
      id: 'EV-001',
      assertionId: 'AS-001',
      data: { status: 200 },
    });
    const forged: ScenarioResult = {
      scenarioId: scenario.id,
      status: 'PASS',
      executionMode: 'EXECUTABLE',
      executed: true,
      processorInvoked: true,
      processors: ['memory-api'],
      assertions: 1,
      passedAssertions: 1,
      failedAssertions: 0,
      evidence: [responseEvidence],
      blockedReasons: [],
      operationResults: [{
        operationId: 'STEP-001',
        status: 'PASS',
        executed: true,
        processor: 'memory-api',
        processorInvoked: true,
        evidence: [responseEvidence],
        blockedReasons: [],
      }],
    };
    const policyReason: BlockedReason = {
      code: 'POLICY_BLOCKED',
      stage: 'POLICY',
      message: 'Policy denied real execution',
      details: {},
      recoverable: false,
    };
    const gate = {
      allowed: false,
      disposition: 'BLOCKED' as const,
      declaredMode: scenario.executionMode,
      reasons: [policyReason],
      checkedAt: new Date().toISOString(),
      obligations: [],
    };

    const report = buildScenarioExecutionReport({
      scenario,
      result: forged,
      gate,
      quality: scoreScenarioQuality(scenario, gate),
    });

    expect(report.result.status).toBe('BLOCKED');
    expect(report.acceptanceCriteria[0].status).toBe('BLOCKED');
  });

  it('[P0] generic Execution schema rejects PASS without Processor and effective Assertions', () => {
    const normalized = normalizeCaseExecutionResult({
      id: 'CASE-FORGED',
      name: 'forged pass',
      executed: true,
      status: 'PASS',
      pass: true,
      passRate: 100,
      assertions: 0,
      passedAssertions: 0,
      failedAssertions: 0,
    });
    const outcome = computeOutcome('integrity', [normalized]);

    expect(normalized.status).not.toBe('PASS');
    expect(normalized.pass).toBe(false);
    expect(outcome.passed).toBe(0);
    expect(outcome.passRate).toBe(0);
  });

  it('[P0] generic Execution schema does not count status=FAIL/pass=true as passed', () => {
    const normalized = normalizeCaseExecutionResult({
      id: 'CASE-CONTRADICTORY',
      name: 'contradictory result',
      executed: true,
      processor: 'api',
      processorInvoked: true,
      status: 'FAIL',
      pass: true,
      passRate: 100,
      assertions: 1,
      passedAssertions: 0,
      failedAssertions: 1,
      checks: [{ name: 'business', pass: false, detail: 'failed', kind: 'BUSINESS' }],
    });
    const outcome = computeOutcome('integrity', [normalized]);

    expect(normalized.status).toBe('FAIL');
    expect(normalized.pass).toBe(false);
    expect(outcome).toMatchObject({ passed: 0, failed: 1, passRate: 0 });
  });

  it('[P0] generic Execution schema rejects FAIL without a failed business assertion', () => {
    const normalized = normalizeCaseExecutionResult({
      id: 'CASE-FORGED-FAIL',
      name: 'forged failure',
      executed: true,
      processor: 'api',
      processorInvoked: true,
      status: 'FAIL',
      pass: false,
      checks: [{ name: 'business', pass: true, detail: 'actually passed', kind: 'BUSINESS' }],
    });

    expect(normalized).toMatchObject({ status: 'BLOCKED', pass: false, passRate: 0 });
    expect(normalized.blockedReason).toEqual(expect.objectContaining({ code: 'RESULT_INTEGRITY_VIOLATION' }));
  });

  it('[P0] PERSISTENCE requires independent after-state proof, not only STATE_BEFORE', () => {
    const scenario = baseScenario();
    scenario.patternIds = ['FUNCTIONAL', 'PERSISTENCE'];
    scenario.operations[0] = { ...scenario.operations[0], method: 'POST' };
    scenario.assertions.push({
      id: 'AS-STATE',
      channel: 'STATE',
      target: 'version',
      operator: 'EQUALS',
      expected: 1,
      acceptanceCriteriaIds: ['AC-001'],
      operationId: 'STEP-001',
      evidenceRequirementIds: ['EV-BEFORE'],
    });
    scenario.evidenceRequirements.push({
      id: 'EV-BEFORE',
      kind: 'STATE_BEFORE',
      channel: 'STATE',
      description: 'before only',
      requiredForPass: true,
      operationId: 'STEP-001',
      sourceRef: 'STEP-001',
      assertionIds: ['AS-STATE'],
    });
    scenario.cleanup = [{ id: 'CLEANUP-001', phase: 'CLEANUP', handler: 'cleanup-resource', required: true }];

    const gate = evaluateScenarioExecutability(scenario, capabilities(scenario));

    expect(gate.allowed).toBe(false);
    expect(gate.disposition).toBe('BLOCKED');
    expect(gate.reasons.some((reason) => reason.code === 'MISSING_STATE_OBSERVER')).toBe(true);
  });

  it('[P0] compares sensitive observations before redaction but never exposes their raw values', async () => {
    const scenario = baseScenario();
    scenario.operations = [
      { ...scenario.operations[0], id: 'STEP-BEFORE', capture: { originalEmail: 'body.email' } },
      { ...scenario.operations[0], id: 'STEP-AFTER', dependsOn: ['STEP-BEFORE'] },
    ];
    scenario.assertions = [
      {
        ...scenario.assertions[0], id: 'AS-BEFORE', operationId: 'STEP-BEFORE',
        evidenceRequirementIds: ['EV-BEFORE'],
      },
      {
        id: 'AS-EMAIL-UNCHANGED', channel: 'STATE', target: 'body.email', operator: 'UNCHANGED',
        expectedFrom: 'STEP-BEFORE.originalEmail', acceptanceCriteriaIds: ['AC-001'],
        operationId: 'STEP-AFTER', evidenceRequirementIds: ['EV-AFTER'],
      },
    ];
    scenario.evidenceRequirements = [
      {
        id: 'EV-BEFORE', kind: 'RESPONSE', channel: 'RESPONSE', description: 'before response',
        requiredForPass: true, operationId: 'STEP-BEFORE', sourceRef: 'STEP-BEFORE', assertionIds: ['AS-BEFORE'],
      },
      {
        id: 'EV-AFTER', kind: 'STATE_AFTER', channel: 'STATE', description: 'after state',
        requiredForPass: true, operationId: 'STEP-AFTER', sourceRef: 'STEP-AFTER', assertionIds: ['AS-EMAIL-UNCHANGED'],
      },
    ];

    const run = async (afterEmail: string) => runScenario(scenario, runnerOptions([processor(async (operation, context) => {
      const email = operation.id === 'STEP-BEFORE' ? 'owner-before@example.test' : afterEmail;
      const output = { status: 200, body: { email } };
      return {
        status: 'PASS', executed: true, output,
        evidence: [evidence(context.scenario, operation, {
          id: operation.id === 'STEP-BEFORE' ? 'EV-BEFORE' : 'EV-AFTER',
          kind: operation.id === 'STEP-BEFORE' ? 'RESPONSE' : 'STATE_AFTER',
          channel: operation.id === 'STEP-BEFORE' ? 'RESPONSE' : 'STATE',
          data: output,
        })],
      };
    }, ['RESPONSE', 'STATE_AFTER'])]));

    const unchanged = await run('owner-before@example.test');
    const mutated = await run('attacker-after@example.test');

    expect(unchanged.result.status).toBe('PASS');
    expect(mutated.result).toMatchObject({ status: 'FAIL', failedAssertions: 1 });
    const serialized = JSON.stringify({ unchanged, mutated });
    expect(serialized).not.toContain('owner-before@example.test');
    expect(serialized).not.toContain('attacker-after@example.test');
    expect(unchanged.result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'EV-BEFORE', redacted: true, data: expect.objectContaining({ body: { email: '***' } }) }),
    ]));
  });

  it('[P0] keeps a later independent observer after newly-ready dependency-chain Operations', async () => {
    const scenario = twoOperationScenario();
    scenario.operations[1].dependsOn = ['STEP-A'];
    scenario.operations.push({ ...scenario.operations[0], id: 'STEP-C', description: 'observe completed flow' });
    scenario.assertions.push({
      ...scenario.assertions[0], id: 'AS-STEP-C', operationId: 'STEP-C', evidenceRequirementIds: ['EV-STEP-C'],
    });
    scenario.evidenceRequirements.push({
      id: 'EV-STEP-C', kind: 'RESPONSE', channel: 'RESPONSE', description: 'completed flow observation',
      requiredForPass: true, operationId: 'STEP-C', sourceRef: 'STEP-C', assertionIds: ['AS-STEP-C'],
    });
    const executionOrder: string[] = [];
    const outcome = await runScenario(scenario, runnerOptions([processor(async (operation, context) => {
      executionOrder.push(operation.id);
      const output = { status: 200 };
      return {
        status: 'PASS', executed: true, output,
        evidence: [evidence(context.scenario, operation, { id: `EV-${operation.id}`, data: output })],
      };
    })]));

    expect(outcome.result.status).toBe('PASS');
    expect(executionOrder).toEqual(['STEP-A', 'STEP-B', 'STEP-C']);
  });

  it('[P1] cleans resources created by successful Prepare hooks when a later Prepare hook fails', async () => {
    const scenario = baseScenario();
    scenario.prepare = [
      { id: 'PREPARE-001', phase: 'PREPARE', handler: 'create-resource', required: true },
      { id: 'PREPARE-002', phase: 'PREPARE', handler: 'fail-after-create', required: true },
    ];
    scenario.cleanup = [{ id: 'CLEANUP-001', phase: 'CLEANUP', handler: 'cleanup-resource', required: true }];
    let created = 0;
    let cleaned = 0;
    const execute = vi.fn<ScenarioProcessor['execute']>();

    const outcome = await runScenario(scenario, {
      ...runnerOptions([processor(execute)]),
      prepareHooks: new Map([
        ['create-resource', async () => { created++; }],
        ['fail-after-create', async () => { throw new Error('controlled prepare failure'); }],
      ]),
      cleanupHooks: new Map([['cleanup-resource', async () => { cleaned++; }]]),
    });

    expect(outcome.result.status).toBe('BLOCKED');
    expect(created).toBe(1);
    expect(cleaned).toBe(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('[P1] injects canonical Scenario Test Data into Operation interpolation', async () => {
    const scenario = baseScenario();
    scenario.testData = [{ id: 'payload', source: 'EXPLICIT', value: { name: 'canonical' } }];
    scenario.operations[0] = {
      ...scenario.operations[0],
      method: 'POST',
      input: '${testData.payload}',
    };
    scenario.cleanup = [{ id: 'CLEANUP-001', phase: 'CLEANUP', handler: 'cleanup-resource', required: true }];
    let observedInput: unknown;
    const execute: ScenarioProcessor['execute'] = async (operation, context) => {
      observedInput = operation.input;
      const output = { status: 200 };
      return {
        status: 'PASS', executed: true, output,
        evidence: [evidence(context.scenario, operation, { data: output })],
      };
    };

    const outcome = await runScenario(scenario, {
      ...runnerOptions([processor(execute)]),
      cleanupHooks: new Map([['cleanup-resource', async () => undefined]]),
    });

    expect(observedInput).toEqual({ name: 'canonical' });
    expect(outcome.result.status).toBe('PASS');
  });

  it('[P1] executes reverse-listed Operations in dependency order', async () => {
    const scenario = twoOperationScenario();
    scenario.operations[0].dependsOn = ['STEP-B'];
    const executionOrder: string[] = [];
    const execute: ScenarioProcessor['execute'] = async (operation, context) => {
      executionOrder.push(operation.id);
      const output = { status: 200 };
      return {
        status: 'PASS', executed: true, output,
        evidence: [evidence(context.scenario, operation, {
          id: `EV-${operation.id}`,
          data: output,
        })],
      };
    };

    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));

    expect(outcome.result.status).toBe('PASS');
    expect(executionOrder).toEqual(['STEP-B', 'STEP-A']);
  });

  it('[P1] blocks cyclic Operation dependencies before invoking a Processor', async () => {
    const scenario = twoOperationScenario();
    scenario.operations[0].dependsOn = ['STEP-B'];
    scenario.operations[1].dependsOn = ['STEP-A'];
    const execute = vi.fn<ScenarioProcessor['execute']>();

    const outcome = await runScenario(scenario, runnerOptions([processor(execute)]));

    expect(outcome.gate.allowed).toBe(false);
    expect(outcome.result.status).toBe('BLOCKED');
    expect(execute).not.toHaveBeenCalled();
  });
});
