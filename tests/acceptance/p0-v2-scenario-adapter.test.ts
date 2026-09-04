import { describe, expect, it, vi } from 'vitest';
import type { TestCase, TestEvidenceChannel } from '../../src/agents/test-design/testcase-schema.js';
import type { EvidenceEnvelope, ScenarioOperation } from '../../src/acceptance/scenario-contract.js';
import {
  adaptTestCaseV2ToScenario,
  createConcurrentScenarioProcessor,
  runTestCaseV2WithScenarioRunner,
} from '../../src/acceptance/test-case-scenario-adapter.js';
import type { ScenarioProcessor } from '../../src/acceptance/scenario-runner.js';

function businessScenario(): NonNullable<TestCase['businessScenario']> {
  return {
    title: 'resource flow', goal: 'actor executes declared resource flow', actor: 'USER', action: 'READ', resource: 'RESOURCE',
    kind: 'CORE_FLOW', actors: [], resources: [{ id: 'RES-1', type: 'RESOURCE', identifiers: {}, provenance: 'EXPLICIT', factIds: ['FACT-1'] }],
    resourceContext: { type: 'RESOURCE', idRef: 'resource-1', provenance: 'EXPLICIT' },
    ownership: { relation: 'NOT_APPLICABLE', provenance: 'EXPLICIT' }, ownerships: [], scopes: [],
    state: { status: 'NOT_APPLICABLE', provenance: 'EXPLICIT' },
    permission: { decision: 'NOT_APPLICABLE', provenance: 'EXPLICIT' },
    flow: { id: 'FLOW-1', name: 'resource flow', mode: 'SINGLE_OPERATION', steps: [{ id: 'STEP-001', action: 'READ', dependsOn: [] }] },
    dependencies: [], risks: [], expectedBusinessOutcome: 'HTTP 200', provenance: 'EXPLICIT', factIds: ['FACT-1'], acceptanceCriteriaIds: ['AC-1'],
  };
}

function v2Case(overrides: Partial<TestCase> = {}): TestCase {
  const testCase: TestCase = {
    schemaVersion: 'TEST_CASE_V2', id: 'CASE-1', feature: 'reference', name: 'read resource', priority: 'P0',
    testType: 'API', testAspects: ['API_CONTRACT'], executionMode: 'DESIGNED_ONLY', requirementStatus: 'CONFIRMED',
    businessScenario: businessScenario(),
    source: { requirementId: 'REQ-1', testPointId: 'TP-1', scenarioId: 'FLOW-1', acceptanceCriteriaIds: ['AC-1'], factIds: ['FACT-1'], objectiveIds: ['OBJ-1'], sourceType: 'REQUIREMENT', provenance: 'EXPLICIT', apiSpecId: 'API-1' },
    tags: ['p0'], preconditions: [], preconditionPlan: [], data: {}, testData: [],
    steps: [{ id: 'STEP-001', channel: 'API', type: 'HTTP_REQUEST', method: 'GET', url: '/resources/resource-1', description: 'read', execution: 'PLANNED', dependsOn: [], acceptanceCriteriaIds: ['AC-1'], factIds: ['FACT-1'] }],
    assertions: [{ id: 'AS-001', channel: 'RESPONSE', type: 'STATUS_CODE', expected: 200, acceptanceCriteriaIds: ['AC-1'], evidenceRequirementIds: ['EV-001'], factIds: ['FACT-1'], objectiveIds: ['OBJ-1'], sourceType: 'REQUIREMENT', provenance: 'EXPLICIT' }],
    expected: { response: { status: 200 }, description: 'HTTP 200' },
    evidenceRequirements: [{ id: 'EV-001', channel: 'API_RESPONSE', phase: 'DURING', required: true, description: 'response', factIds: ['FACT-1'], sourceStepId: 'STEP-001', assertionIds: ['AS-001'] }],
    oracle: { mode: 'ALL', deterministic: true, status: 'BLOCKED', assertionIds: ['AS-001'], evidenceRequirementIds: ['EV-001'], reason: 'runtime required' },
    prepare: [], cleanup: [],
    dependencies: [{ id: 'DEP-ENV', kind: 'ENVIRONMENT', ref: 'runtime.baseUrl', description: 'env', required: true, resolution: 'RUNTIME_REQUIRED' }],
    readiness: { status: 'BLOCKED', reasons: ['COMPOSITE_EXECUTION_REQUIRED'], missingCapabilities: ['acceptance.scenarioRunner'] },
    executionContract: { executor: { kind: 'COMPOSITE', ref: 'acceptance.scenarioRunner', status: 'UNAVAILABLE', supports: [] }, observers: [{ channel: 'API_RESPONSE', ref: 'runtime.observer.API_RESPONSE', phase: 'DURING', required: true, status: 'RUNTIME_REQUIRED' }], preflight: [{ kind: 'ENVIRONMENT', ref: 'runtime.baseUrl', required: true }], lifecycleHooks: [] },
  };
  return { ...testCase, ...overrides };
}

function dataFor(kind: EvidenceEnvelope['kind'], operation: ScenarioOperation, store?: Set<string>): unknown {
  if (kind === 'REQUEST') return { method: operation.method, path: operation.path };
  if (kind === 'STATE_BEFORE' || kind === 'STATE_AFTER' || kind === 'RESOURCE' || kind === 'DATABASE') return { value: 'stable', count: store?.size ?? 1 };
  if (kind === 'EVENT' || kind === 'QUEUE_MESSAGE' || kind === 'BILLING_RECORD' || kind === 'AUDIT_RECORD') return { count: 0 };
  return { status: operation.path === '/denied' ? 403 : operation.path === '/count' ? 200 : operation.method === 'POST' ? 201 : 200, body: { count: store?.size ?? 0 } };
}

function memoryProcessor(store?: Set<string>): ScenarioProcessor {
  return {
    name: 'memory', supportsAbort: true,
    supportedEvidenceKinds: ['REQUEST', 'RESPONSE', 'STATE_BEFORE', 'STATE_AFTER', 'RESOURCE', 'DATABASE', 'EVENT', 'QUEUE_MESSAGE', 'BILLING_RECORD', 'AUDIT_RECORD'],
    supports: () => true,
    execute: async (operation, context) => {
      if (store && operation.method === 'POST' && operation.path !== '/denied') store.add(String((operation.input as { id?: string } | undefined)?.id ?? 'created'));
      const requirements = context.scenario.evidenceRequirements.filter((item) => item.operationId === operation.id
        || item.sourceRef === operation.id);
      const evidence = requirements.map((requirement): EvidenceEnvelope => ({
        id: requirement.id, requirementId: requirement.id, scenarioId: context.scenario.id, operationId: operation.id,
        acceptanceCriteriaIds: context.scenario.acceptanceCriteriaIds, kind: requirement.kind, channel: requirement.channel,
        source: 'memory', observedAt: new Date().toISOString(), data: dataFor(requirement.kind, operation, store), verified: true,
      }));
      const response = dataFor('RESPONSE', operation, store);
      return { status: 'PASS', executed: true, output: operation.channel === 'API' ? response : evidence[0]?.data ?? response, evidence };
    },
  };
}

const options = (processors: ScenarioProcessor[], extra: Record<string, unknown> = {}) => ({
  processors, environmentAvailable: true, policyAllowed: true, ...extra,
});

describe('P0 TEST_CASE_V2 → Scenario Runner Adapter', () => {
  it('执行前动态回写 Generated/Runtime/Effective Readiness，并把 Composite 自动升级为 EXECUTABLE', async () => {
    const testCase = v2Case();
    const execution = await runTestCaseV2WithScenarioRunner(testCase, options([memoryProcessor()]));

    expect(execution.adapted.generatedReadiness).toMatchObject({ status: 'BLOCKED' });
    expect(execution.adapted.runtimeReadiness.status).toBe('EXECUTABLE');
    expect(execution.adapted.effectiveReadiness.status).toBe('EXECUTABLE');
    expect(testCase.executionContract?.executor.status).toBe('AVAILABLE');
    expect(execution.outcome.result).toMatchObject({ status: 'PASS', executed: true, processorInvoked: true });
    expect(execution.oracleVerdict).toBe('PASS');
  });

  it('缺少 Processor/Observer 时明确 BLOCKED 且不伪造 PASS', async () => {
    const testCase = v2Case();
    const execution = await runTestCaseV2WithScenarioRunner(testCase, options([]));

    expect(execution.adapted.effectiveReadiness.status).toBe('BLOCKED');
    expect(execution.outcome.result).toMatchObject({ status: 'BLOCKED', executed: false, processorInvoked: false });
    expect(execution.oracleVerdict).toBe('NOT_VERIFIED');
  });

  it('Case Prepare 失败阻止执行；Cleanup 在成功后执行并产生 Lifecycle Evidence', async () => {
    const execute = vi.fn(memoryProcessor().execute);
    const processor = { ...memoryProcessor(), execute };
    const prepare = vi.fn(async () => ({ variables: { prepared: true } }));
    const cleanup = vi.fn(async () => undefined);
    const testCase = v2Case({
      id: 'CASE-HOOK',
      prepare: [{ id: 'PREP-1', phase: 'PREPARE', handler: 'prepare-case', required: true }],
      cleanup: [{ id: 'CLEAN-1', phase: 'CLEANUP', handler: 'cleanup-case', required: true }],
      executionContract: {
        ...v2Case().executionContract!,
        lifecycleHooks: [
          { phase: 'PREPARE', hookId: 'PREP-1', required: true, evidenceRequired: true },
          { phase: 'CLEANUP', hookId: 'CLEAN-1', required: true, evidenceRequired: true },
        ],
      },
    });
    const run = await runTestCaseV2WithScenarioRunner(testCase, options([processor], {
      prepareHooks: new Map([['prepare-case', prepare]]), cleanupHooks: new Map([['cleanup-case', cleanup]]),
    }));
    expect(run.outcome.result.status).toBe('PASS');
    expect(prepare).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(run.outcome.result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'test-case-adapter/prepare', verified: true }),
      expect.objectContaining({ source: 'test-case-adapter/cleanup', verified: true }),
    ]));

    const failedPrepare = vi.fn(async () => { throw new Error('fixture unavailable'); });
    const blocked = await runTestCaseV2WithScenarioRunner(v2Case({ id: 'CASE-PREP-FAIL', prepare: testCase.prepare }), options([processor], {
      prepareHooks: new Map([['prepare-case', failedPrepare]]),
    }));
    expect(blocked.outcome.result.status).toBe('BLOCKED');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('Cleanup 隔离 Case 数据，防止 Cross-Case Pollution', async () => {
    const store = new Set<string>();
    const cleanup = vi.fn(async () => { store.clear(); });
    const create = v2Case({
      id: 'CASE-CREATE', name: 'create',
      steps: [{ ...v2Case().steps[0], method: 'POST', url: '/resources', body: { id: 'case-owned' } }],
      assertions: [{ ...v2Case().assertions[0], expected: 201 }],
      expected: { response: { status: 201 } },
      cleanup: [{ id: 'CLEAN-1', phase: 'CLEANUP', handler: 'cleanup-store', required: true }],
    });
    const first = await runTestCaseV2WithScenarioRunner(create, options([memoryProcessor(store)], {
      cleanupHooks: new Map([['cleanup-store', cleanup]]),
    }));
    expect(first.outcome.result.status).toBe('PASS');
    expect(store.size).toBe(0);

    const read = v2Case({ id: 'CASE-READ-NEXT', steps: [{ ...v2Case().steps[0], url: '/count' }],
      assertions: [{ ...v2Case().assertions[0], type: 'JSON_VALUE', path: 'count', expected: 0 }], expected: { response: { status: 200, fields: { count: 0 } } } });
    const second = await runTestCaseV2WithScenarioRunner(read, options([memoryProcessor(store)]));
    expect(second.outcome.result.status).toBe('PASS');
  });

  it('负向写操作缺少 Non-Mutation/Side Effect Evidence 时为 NOT_VERIFIED，不能 PASS', async () => {
    const negative = v2Case({
      id: 'CASE-NEGATIVE-INCOMPLETE', testAspects: ['API_CONTRACT', 'NEGATIVE_PATH'],
      steps: [{ ...v2Case().steps[0], method: 'POST', url: '/denied' }],
      assertions: [{ ...v2Case().assertions[0], expected: 403 }], expected: { response: { status: 403 } },
      cleanup: [{ id: 'CLEAN-1', phase: 'CLEANUP', handler: 'cleanup', required: true }],
    });
    const execution = await runTestCaseV2WithScenarioRunner(negative, options([memoryProcessor()], {
      cleanupHooks: new Map([['cleanup', async () => undefined]]),
    }));
    expect(execution.adapted.effectiveReadiness.status).toBe('DESIGNED_ONLY');
    expect(execution.outcome.result.status).toBe('NOT_EXECUTED');
    expect(execution.oracleVerdict).toBe('NOT_VERIFIED');
  });

  it('多步骤变量捕获、Case Dependency、Negative Non-Mutation 与 Side Effect 形成确定性 Oracle', async () => {
    const channels: Array<{ id: string; channel: TestEvidenceChannel; phase: 'BEFORE' | 'DURING' | 'AFTER'; step: string; assertion: string }> = [
      { id: 'EV-BEFORE', channel: 'STATE_CHANGE', phase: 'BEFORE', step: 'STEP-001', assertion: 'AS-BEFORE' },
      { id: 'EV-RESPONSE', channel: 'API_RESPONSE', phase: 'DURING', step: 'STEP-002', assertion: 'AS-RESPONSE' },
      { id: 'EV-AFTER', channel: 'STATE_CHANGE', phase: 'AFTER', step: 'STEP-003', assertion: 'AS-AFTER' },
      { id: 'EV-EFFECT', channel: 'EVENT', phase: 'AFTER', step: 'STEP-004', assertion: 'AS-EFFECT' },
    ];
    const negative = v2Case({
      id: 'CASE-NEGATIVE-COMPLETE', testAspects: ['API_CONTRACT', 'NEGATIVE_PATH', 'SIDE_EFFECT', 'PRE_POST_CONDITION'],
      steps: [
        { id: 'STEP-001', channel: 'DATA', description: 'before', action: 'OBSERVE', execution: 'PLANNED', dependsOn: [], capture: { before: 'value' }, acceptanceCriteriaIds: ['AC-1'], factIds: ['FACT-1'] },
        { id: 'STEP-002', channel: 'API', type: 'HTTP_REQUEST', method: 'POST', url: '/denied', description: 'deny', execution: 'PLANNED', dependsOn: ['STEP-001'], acceptanceCriteriaIds: ['AC-1'], factIds: ['FACT-1'] },
        { id: 'STEP-003', channel: 'DATA', description: 'after', action: 'OBSERVE', execution: 'PLANNED', dependsOn: ['STEP-002'], acceptanceCriteriaIds: ['AC-1'], factIds: ['FACT-1'] },
        { id: 'STEP-004', channel: 'QUEUE', description: 'effects', action: 'OBSERVE', execution: 'PLANNED', dependsOn: ['STEP-003'], acceptanceCriteriaIds: ['AC-1'], factIds: ['FACT-1'] },
      ],
      assertions: [
        { id: 'AS-BEFORE', channel: 'STATE', target: 'state', path: 'value', operator: 'equals', expected: 'stable', acceptanceCriteriaIds: ['AC-1'], evidenceRequirementIds: ['EV-BEFORE'], factIds: ['FACT-1'] },
        { id: 'AS-RESPONSE', channel: 'RESPONSE', type: 'STATUS_CODE', expected: 403, acceptanceCriteriaIds: ['AC-1'], evidenceRequirementIds: ['EV-RESPONSE'], factIds: ['FACT-1'] },
        { id: 'AS-AFTER', channel: 'STATE', target: 'state', path: 'value', operator: 'equals', expectedFrom: '${STEP-001.before}', description: 'resource unchanged', acceptanceCriteriaIds: ['AC-1'], evidenceRequirementIds: ['EV-AFTER'], factIds: ['FACT-1'] },
        { id: 'AS-EFFECT', channel: 'SIDE_EFFECT', target: 'event', path: 'count', operator: 'equals', expected: 0, acceptanceCriteriaIds: ['AC-1'], evidenceRequirementIds: ['EV-EFFECT'], factIds: ['FACT-1'] },
      ],
      expected: { response: { status: 403 }, state: { expectation: 'UNCHANGED', description: 'resource unchanged' }, sideEffects: [{ kind: 'MESSAGE', action: 'CREATE', description: 'no message', expectation: 'FORBIDDEN' }] },
      evidenceRequirements: channels.map((item) => ({ id: item.id, channel: item.channel, phase: item.phase, required: true, description: item.id, factIds: ['FACT-1'], sourceStepId: item.step, assertionIds: [item.assertion] })),
      oracle: { mode: 'ALL', deterministic: true, status: 'BLOCKED', assertionIds: ['AS-BEFORE', 'AS-RESPONSE', 'AS-AFTER', 'AS-EFFECT'], evidenceRequirementIds: channels.map((item) => item.id) },
      cleanup: [{ id: 'CLEAN-1', phase: 'CLEANUP', handler: 'cleanup', required: true }],
      dependencies: [{ id: 'DEP-CASE', kind: 'CASE', ref: 'CASE-PREPARED', description: 'prepared fixture', required: true, resolution: 'RUNTIME_REQUIRED' }],
      executionContract: { ...v2Case().executionContract!, executor: { kind: 'COMPOSITE', ref: 'acceptance.scenarioRunner', status: 'RUNTIME_REQUIRED', supports: [] }, observers: channels.map((item) => ({ channel: item.channel, ref: `observer.${item.channel}`, phase: item.phase, required: true, status: 'RUNTIME_REQUIRED' as const })) },
    });
    const execution = await runTestCaseV2WithScenarioRunner(negative, options([memoryProcessor()], {
      cleanupHooks: new Map([['cleanup', async () => undefined]]), availableDependencies: new Set(['CASE-PREPARED']),
    }));
    expect(execution.adapted.effectiveReadiness.status).toBe('EXECUTABLE');
    expect(execution.outcome.result).toMatchObject({ status: 'PASS', executed: true, assertions: 4, passedAssertions: 4 });
    expect(execution.oracleVerdict).toBe('PASS');
  });

  it('Concurrency Group 通过轻量并发 Processor 真正并发执行，不修改 Runner 协议', async () => {
    let active = 0;
    let maxActive = 0;
    const delegate = memoryProcessor();
    delegate.execute = async (operation, context) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      const result = await memoryProcessor().execute(operation, context);
      active--;
      return result;
    };
    const concurrent = createConcurrentScenarioProcessor([delegate]);
    const testCase = v2Case({
      id: 'CASE-CONCURRENT',
      steps: [
        { ...v2Case().steps[0], id: 'STEP-001', method: 'POST', url: '/pay', concurrencyGroup: 'pay' },
        { ...v2Case().steps[0], id: 'STEP-002', method: 'POST', url: '/pay', concurrencyGroup: 'pay' },
      ],
      assertions: [
        { ...v2Case().assertions[0], id: 'AS-001', expected: 201, evidenceRequirementIds: ['EV-001'] },
        { ...v2Case().assertions[0], id: 'AS-002', expected: 201, evidenceRequirementIds: ['EV-002'] },
      ],
      evidenceRequirements: [
        { ...v2Case().evidenceRequirements![0], id: 'EV-001', sourceStepId: 'STEP-001', assertionIds: ['AS-001'] },
        { ...v2Case().evidenceRequirements![0], id: 'EV-002', sourceStepId: 'STEP-002', assertionIds: ['AS-002'] },
      ],
      oracle: { mode: 'ALL', deterministic: true, status: 'BLOCKED', assertionIds: ['AS-001', 'AS-002'], evidenceRequirementIds: ['EV-001', 'EV-002'] },
      expected: { response: { status: 201 } },
      cleanup: [{ id: 'CLEAN-1', phase: 'CLEANUP', handler: 'cleanup', required: true }],
    });
    const execution = await runTestCaseV2WithScenarioRunner(testCase, options([concurrent, delegate], {
      cleanupHooks: new Map([['cleanup', async () => undefined]]),
    }));
    expect(execution.outcome.result.status).toBe('PASS');
    expect(maxActive).toBe(2);
    expect(execution.adapted.scenario.operations).toHaveLength(1);
  });

  it('Adapter 预览不会把缺失运行时能力误标 READY', () => {
    const adapted = adaptTestCaseV2ToScenario(v2Case(), options([]));
    expect(adapted.runtimeReadiness.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PROCESSOR', available: false }),
      expect.objectContaining({ kind: 'OBSERVER', available: false }),
    ]));
    expect(adapted.scenario.executionMode).toBe('BLOCKED');
  });
});
