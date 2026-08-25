import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ContractRegistry,
  ContractResolver,
  acceptanceApiContractId,
  contractDependency,
  contractSource,
  createContract,
  createPhase1ContractRegistry,
} from '../../src/contracts/index.js';
import { runAgentPipeline, createAgentContext, NoopMemory, ToolRegistry } from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import { runAcceptancePipeline } from '../../src/acceptance/acceptance-pipeline.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { loadCases } from '../../src/cases/loader.js';
import { Engine } from '../../src/core/engine.js';
import { runScenario } from '../../src/acceptance/scenario-runner.js';
import type { Scenario } from '../../src/acceptance/scenario-contract.js';

const NOW = '2026-08-24T00:00:00.000Z';
const acceptanceFixture = fs.readFileSync(fileURLToPath(new URL('../acceptance/fixtures/user-profile.md', import.meta.url)), 'utf8');

class TrackingResolver extends ContractResolver {
  calls: string[] = [];
  override resolve<T = unknown>(query: Parameters<ContractResolver['resolve']>[0]) {
    this.calls.push(query.id ?? `${query.kind}:${query.subject}`);
    return super.resolve<T>(query);
  }
}

function agentContext() {
  return createAgentContext({
    taskId: 'contract-gate-test', feature: 'user', environment: 'test',
    tools: new ToolRegistry(), memory: new NoopMemory(), llm: new MockLLMProvider(),
    metadata: {},
  });
}

function minimalScenario(dependencies: Scenario['contractDependencies']): Scenario {
  return {
    schemaVersion: '1.0.0', id: 'SCN-contract-gate', title: 'Contract gate', domain: 'generic',
    requirement: 'must be contract bound', sources: [], acceptanceCriteriaIds: ['AC-1'], patternIds: [],
    scope: {}, preconditions: [], testData: [], operations: [], assertions: [], evidenceRequirements: [],
    prepare: [], cleanup: [], executionMode: 'EXECUTABLE', blockedReasons: [], risks: [], priority: 'P0',
    dependencies: [], contractDependencies: dependencies,
  };
}

describe('Agent / Acceptance / Legacy use the shared ContractResolver boundary', () => {
  it('routes all three entries through the same injected resolver instance', async () => {
    const resolver = new TrackingResolver(createPhase1ContractRegistry());
    const agent = await runAgentPipeline({
      requirementText: '测试 user 用户资料更新，验证 userId 必填',
      environment: 'test', contractResolver: resolver,
      options: {
        dryRun: true, skipExecution: true, runSelection: false, runCoverage: false,
        runRca: false, runDefect: false, runHealing: false, runApproval: false,
      },
    }, agentContext());
    expect(agent.contracts?.validation.status).toBe('VALID');

    const acceptance = await runAcceptancePipeline({
      markdown: acceptanceFixture, project: 'phase1', documentId: 'user-profile.md',
      baseUrl: 'http://127.0.0.1:1', mode: 'dry-run', contractResolver: resolver,
    });
    expect(acceptance.contracts.validation.status).toBe('VALID');
    expect(acceptance.testCases.filter((testCase) => testCase.source?.apiSpecId)
      .every((testCase) => testCase.source?.contractRef && testCase.source.contractVersion && testCase.source.contractFingerprint)).toBe(true);

    const [loaded] = await loadCases('tasks/wan3-wensheng.json');
    const legacy = await new Engine({ contractResolver: resolver }).runTask({
      default_env: 'test', session_cookies_path: '/not-used', status_text: {}, environments: {},
    }, loaded.def, 'test');
    expect(legacy).toMatchObject({ status: 'BLOCKED', executed: false, passRate: 0, processorInvoked: false });
    expect(legacy.checks[0].detail).toContain('LEGACY_ASSET_STALE');

    expect(resolver.calls).toEqual(expect.arrayContaining([
      'resource.requirement.user',
      expect.stringMatching(/^api\.api-/),
    ]));
    expect(resolver.calls.length).toBeGreaterThan(3);
  });
});

describe('Contract fail-closed integration', () => {
  it('blocks Agent before TestDesign when a required implementation Contract is UNKNOWN', async () => {
    const registry = new ContractRegistry([{
      id: 'model.user', kind: 'model', subject: 'user', version: 'v1', status: 'UNKNOWN', value: {},
      sources: [], createdAt: NOW,
    }]);
    await expect(runAgentPipeline({
      requirementText: '测试 user 用户资料更新，验证 userId 必填',
      contractResolver: new ContractResolver(registry),
      options: { dryRun: true, skipExecution: true },
    }, agentContext())).rejects.toThrow(/CONTRACT_GATE_BLOCKED/);
  });

  it('blocks Acceptance when Backend and Requirement API facts conflict', async () => {
    const parsed = parseAcceptanceRequirement(acceptanceFixture, { documentId: 'user-profile.md' });
    const api = parsed.apis[0];
    const registry = new ContractRegistry([{
      id: acceptanceApiContractId(api), kind: 'api', subject: api.operationKey, version: 'v1', status: 'ACTIVE',
      value: { method: 'DELETE', path: '/different-runtime-operation' },
      sources: [contractSource('backend', 'backend:routes.ts')], createdAt: NOW,
    }]);
    const execution = await runAcceptancePipeline({
      markdown: acceptanceFixture, project: 'phase1', documentId: 'user-profile.md',
      baseUrl: 'http://127.0.0.1:1', mode: 'dry-run', contractResolver: new ContractResolver(registry),
    });
    expect(execution.contracts.validation.status).toBe('BLOCKED');
    expect(execution.results.some((result) => result.status === 'PASS')).toBe(false);
    expect(execution.results.filter((result) => result.evidence.binding || result.evidence.request)).toHaveLength(0);
  });

  it('blocks an unindexed Legacy asset before loading session or network state', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-legacy-'));
    const file = path.join(directory, 'unindexed.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'unindexed', scene: 'video' }));
    try {
      const [loaded] = await loadCases(file);
      const result = await new Engine().runTask({
        default_env: 'test', session_cookies_path: '/definitely/missing', status_text: {}, environments: {},
      }, loaded.def, 'test');
      expect(result).toMatchObject({ status: 'BLOCKED', executed: false, passRate: 0 });
      expect(result.checks[0].detail).toContain('LEGACY_ASSET_UNKNOWN');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('blocks a raw TaskDef that bypasses Loader and declares no Contract dependency', async () => {
    const result = await new Engine().runTask({
      default_env: 'test', session_cookies_path: '/definitely/missing', status_text: {}, environments: {},
    }, { name: 'raw-bypass', scene: 'video' }, 'test');
    expect(result).toMatchObject({ status: 'BLOCKED', executed: false, passRate: 0 });
    expect(result.checks[0].detail).toContain('MISSING_CONTRACT_DEPENDENCY');
  });

  it.each([
    ['STALE', 'STALE'],
    ['CONTRACT_DRIFT', 'CONTRACT_DRIFT'],
    ['BLOCKED', 'BLOCKED'],
  ] as const)('maps dependency validation %s to Scenario result %s before Processor', async (kind, expected) => {
    const current = createContract({
      id: 'resource.demo', kind: 'resource', subject: 'demo', version: 'v2', status: kind === 'STALE' ? 'STALE' : 'ACTIVE',
      value: { active: true }, sources: [contractSource('backend', 'backend:demo')], createdAt: NOW,
    });
    const resolver = new ContractResolver(new ContractRegistry([current]));
    const dependency = kind === 'BLOCKED'
      ? { contractId: 'missing', version: 'v1' }
      : kind === 'CONTRACT_DRIFT'
        ? { ...contractDependency(current), version: 'v1' }
        : contractDependency(current);
    const outcome = await runScenario(minimalScenario([dependency]), {
      processors: [], environmentAvailable: true, policyAllowed: true,
      contractResolver: resolver, requireContractDependencies: true,
    });
    expect(outcome.result).toMatchObject({ status: expected, executed: false, processorInvoked: false });
  });
});
