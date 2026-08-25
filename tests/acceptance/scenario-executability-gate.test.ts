import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Scenario } from '../../src/acceptance/scenario-contract.js';
import {
  evaluateScenarioExecutability,
  type ScenarioExecutionCapabilities,
} from '../../src/acceptance/scenario-executability-gate.js';
import { parseScenarioMarkdown } from '../../src/acceptance/scenario-markdown-parser.js';
import { runScenario, type ScenarioProcessor } from '../../src/acceptance/scenario-runner.js';

const template = readFileSync(fileURLToPath(new URL('./templates/scenario.md', import.meta.url)), 'utf8');

function executableScenario(): Scenario {
  const markdown = template
    .replace('SCN-<domain>-<intent>', 'SCN-generic-persistence')
    .replace('- <按风险选择 PERSISTENCE / NON_MUTATION / IDEMPOTENCY / AUTHORIZATION / ...>', '- PERSISTENCE')
    .replace('- <环境、服务、Processor、Evidence Provider；无则写 NONE>', '- NONE');
  const parsed = parseScenarioMarkdown(markdown);
  if (!parsed.valid) throw new Error(`Invalid Scenario fixture: ${JSON.stringify(parsed.issues)}`);
  return parsed.scenario;
}

function capabilities(overrides: Partial<ScenarioExecutionCapabilities> = {}): ScenarioExecutionCapabilities {
  return {
    processors: new Set(['api']),
    evidenceKinds: new Set(['RESPONSE', 'STATE_AFTER']),
    prepareHooks: new Set(['prepare-resource']),
    cleanupHooks: new Set(['cleanup-resource']),
    availableDependencies: new Set(),
    executorAvailable: true,
    environmentAvailable: true,
    policyAllowed: true,
    supportsOperation: () => true,
    ...overrides,
  };
}

function controlledProcessor(execute: ScenarioProcessor['execute']): ScenarioProcessor {
  return {
    name: 'api',
    supportsAbort: true,
    supportedEvidenceKinds: ['RESPONSE', 'STATE_AFTER'],
    supports: () => true,
    execute,
  };
}

describe('Scenario Executability Gate contract', () => {
  it.each([
    {
      name: 'Processor 未声明',
      expectedCode: 'MISSING_PROCESSOR',
      mutate: (scenario: Scenario) => scenario.operations.forEach((operation) => { operation.processor = undefined; }),
      policyAllowed: true,
    },
    {
      name: 'Assertion 为空',
      expectedCode: 'MISSING_ASSERTION',
      mutate: (scenario: Scenario) => { scenario.assertions = []; },
      policyAllowed: true,
    },
    {
      name: 'Policy 拒绝',
      expectedCode: 'POLICY_BLOCKED',
      mutate: (_scenario: Scenario) => undefined,
      policyAllowed: false,
    },
    {
      name: 'State Evidence 缺失',
      expectedCode: 'MISSING_STATE_OBSERVER',
      mutate: (scenario: Scenario) => {
        scenario.evidenceRequirements = scenario.evidenceRequirements.filter((evidence) => evidence.kind !== 'STATE_AFTER');
      },
      policyAllowed: true,
    },
  ] as const)('$name 时在任何 Hook/Processor 前 BLOCKED', async ({ mutate, expectedCode, policyAllowed }) => {
    const scenario = executableScenario();
    mutate(scenario);
    const execute = vi.fn<ScenarioProcessor['execute']>(async () => ({
      status: 'PASS', executed: true, evidence: [],
    }));
    const prepare = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);

    const outcome = await runScenario(scenario, {
      processors: [controlledProcessor(execute)],
      prepareHooks: new Map([['prepare-resource', prepare]]),
      cleanupHooks: new Map([['cleanup-resource', cleanup]]),
      environmentAvailable: true,
      policyAllowed,
      availableDependencies: new Set(),
    });

    expect(outcome.gate).toMatchObject({ allowed: false, disposition: 'BLOCKED' });
    expect(outcome.gate.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expectedCode }),
    ]));
    expect(outcome.result).toMatchObject({
      status: 'BLOCKED', executed: false, processorInvoked: false,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('allows a complete Scenario without invoking an execution Processor', () => {
    const scenario = executableScenario();
    const execute = vi.fn<ScenarioProcessor['execute']>();

    const gate = evaluateScenarioExecutability(scenario, capabilities());

    expect(gate).toMatchObject({
      allowed: true,
      disposition: 'EXECUTABLE',
      declaredMode: 'EXECUTABLE',
      reasons: [],
    });
    expect(gate.obligations.length).toBeGreaterThan(0);
    expect(gate.obligations.every((obligation) => obligation.satisfied)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['Acceptance Criterion', (scenario: Scenario) => scenario.acceptanceCriteriaIds.push(scenario.acceptanceCriteriaIds[0])],
    ['Assertion', (scenario: Scenario) => scenario.assertions.push({ ...scenario.assertions[0] })],
    ['Evidence Requirement', (scenario: Scenario) => scenario.evidenceRequirements.push({ ...scenario.evidenceRequirements[0] })],
  ])('blocks duplicate %s identities before execution', (_name, mutate) => {
    const scenario = executableScenario();
    mutate(scenario);
    const gate = evaluateScenarioExecutability(scenario, capabilities());
    expect(gate.allowed).toBe(false);
    expect(gate.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_SCENARIO' }),
    ]));
  });

  it('turns a throwing Processor supports probe into an unsupported-operation block', async () => {
    const scenario = executableScenario();
    const execute = vi.fn<ScenarioProcessor['execute']>();
    const throwingProcessor: ScenarioProcessor = {
      ...controlledProcessor(execute),
      supports: () => { throw new Error('probe failed'); },
    };
    const outcome = await runScenario(scenario, {
      processors: [throwingProcessor],
      prepareHooks: new Map([['prepare-resource', async () => undefined]]),
      cleanupHooks: new Map([['cleanup-resource', async () => undefined]]),
      environmentAvailable: true,
      policyAllowed: true,
    });
    expect(outcome.result.status).toBe('BLOCKED');
    expect(outcome.result.blockedReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
    ]));
    expect(execute).not.toHaveBeenCalled();
  });
});
