import { describe, expect, it, vi } from 'vitest';
import { ContractRegistry } from '../../../src/contracts/registry.js';
import { ContractResolver } from '../../../src/contracts/resolver.js';
import { resolveDiscoveredOperations } from '../../../src/discovery/api/api-discovery.js';
import { discoverOpenApi } from '../../../src/discovery/api/source-scanners.js';
import { classifyFeatureRisk } from '../../../src/self-test/risk-classifier.js';
import { generateMinimalSelfTestPack } from '../../../src/self-test/pack-generator.js';
import { evaluateSelfTestSafety } from '../../../src/self-test/execution-safety.js';
import { deriveFeatureResult, terminalScenarioResult } from '../../../src/self-test/report.js';
import { parseSelfTestCliArgs } from '../../../src/self-test/self-test-cli.js';
import { runDeveloperSelfTest } from '../../../src/self-test/self-test-runner.js';

function packFor(method: 'get' | 'post') {
  const resolver = new ContractResolver(new ContractRegistry());
  const operations = discoverOpenApi({ paths: { '/resource': { [method]: { security: [], responses: { [method === 'get' ? 200 : 201]: {} } } } } }, 'openapi.json');
  const resolved = resolveDiscoveredOperations(operations, resolver, 'test');
  const risk = classifyFeatureRisk(operations);
  return { pack: generateMinimalSelfTestPack('feature', resolved, risk), risk };
}

describe('Developer Self-Test Pack and safety', () => {
  it('generates a bounded P0 pack with Contract Dependencies and deterministic evidence', () => {
    const { pack } = packFor('get');
    expect(pack.scenarios.length).toBeGreaterThanOrEqual(2);
    expect(pack.scenarios.length).toBeLessThanOrEqual(8);
    expect(pack.scenarios[0].contractDependencies?.length).toBe(1);
    expect(pack.scenarios[0].evidenceRequirements[0]).toMatchObject({ kind: 'RESPONSE', requiredForPass: true });
  });

  it('SAFE blocks a mutation before Processor execution', () => {
    const { pack, risk } = packFor('post');
    const scenario = pack.scenarios.find((item) => item.tags?.includes('happy'))!;
    expect(evaluateSelfTestSafety(scenario, { environment: 'test', changedFiles: ['x.ts'] }, 'SAFE', risk))
      .toMatchObject({ allowed: false, disposition: 'BLOCKED', reasons: [expect.stringContaining('SAFE_MODE_SIDE_EFFECT_BLOCKED')] });
  });

  it('LIVE requires approval, budget and rollback for side effects', () => {
    const { pack, risk } = packFor('post');
    const scenario = pack.scenarios.find((item) => item.tags?.includes('happy'))!;
    expect(evaluateSelfTestSafety(scenario, { environment: 'test', changedFiles: ['x.ts'] }, 'LIVE', risk).reasons[0]).toContain('LIVE_APPROVAL_REQUIRED');
    expect(evaluateSelfTestSafety(scenario, { environment: 'test', changedFiles: ['x.ts'], budget: { maxCost: 1 } }, 'LIVE', risk, {
      approval: { id: 'approval-1', status: 'APPROVED', approvedBy: 'reviewer' },
    }).reasons[0]).toContain('LIVE_ROLLBACK_REQUIRED');
  });

  it('does not convert PASS majority plus BLOCKED into READY', () => {
    const { pack, risk } = packFor('get');
    const [first, second] = pack.scenarios;
    const pass = terminalScenarioResult(first, 'BLOCKED', [], 'run');
    pass.status = 'PASS'; pass.executed = true; pass.processorInvoked = true;
    pass.passedAssertions = first.assertions.length;
    pass.evidence = first.evidenceRequirements.map((item) => ({
      id: item.id, scenarioId: first.id, operationId: item.operationId, acceptanceCriteriaIds: first.acceptanceCriteriaIds,
      kind: item.kind, channel: item.channel, source: 'test', observedAt: new Date().toISOString(), data: {}, verified: true,
    }));
    const blocked = terminalScenarioResult(second, 'BLOCKED', ['missing'], 'run');
    expect(deriveFeatureResult([
      { scenario: first, result: pass, safety: evaluateSelfTestSafety(first, { environment: 'test', changedFiles: ['x'] }, 'SAFE', risk) },
      { scenario: second, result: blocked, safety: evaluateSelfTestSafety(second, { environment: 'test', changedFiles: ['x'] }, 'SAFE', risk) },
    ])).toBe('PARTIAL');
  });

  it('parses standard CLI arguments and rejects unsafe LIVE defaults', () => {
    expect(parseSelfTestCliArgs(['--changed', 'HEAD~1..HEAD', '--env', 'test']).mode).toBe('SAFE');
    expect(() => parseSelfTestCliArgs(['--changed=HEAD~1..HEAD', '--env=test', '--mode=live'])).toThrow('LIVE 必须同时提供');
    expect(() => parseSelfTestCliArgs(['--changed=x', '--env=test', '--wat'])).toThrow('参数解析失败');
  });

  it('DRY_RUN produces a pack but invokes no Processor', async () => {
    const execute = vi.fn(async () => ({ status: 'PASS' as const, executed: true, evidence: [] }));
    const report = await runDeveloperSelfTest({ environment: 'test', entrypoints: ['http://example.test/health'] }, {
      mode: 'DRY_RUN',
      openApiDocuments: [{ document: { paths: { '/health': { get: { security: [], responses: { 200: {} } } } } }, ref: 'openapi.json' }],
      processors: [{ name: 'api', supportsAbort: true, supportedEvidenceKinds: ['RESPONSE'], supports: () => true, execute }],
    });
    expect(report.pack.generated).toBeGreaterThan(0);
    expect(report.scenarios.every((item) => item.result.status === 'NOT_EXECUTED')).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('binds Wan3 model/workflow from the Phase 1 Resolver without engine hardcoding', async () => {
    const report = await runDeveloperSelfTest({ environment: 'test', module: 'wan3', changedFiles: ['videohub-routes.ts'] }, {
      mode: 'DRY_RUN',
      changedContents: new Map([['videohub-routes.ts', "router.post('/videohub/submit', submit); router.get('/videohub/recent-tasks', recent);"]]),
      openApiDocuments: [{
        document: { paths: {
          '/videohub/submit': { post: { security: [], responses: { 201: {} } } },
          '/videohub/recent-tasks': { get: { security: [], responses: { 200: {} } } },
        } }, ref: 'videohub-openapi.json',
      }],
    });
    expect(report.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'RESOLVED', contract: expect.objectContaining({ id: 'model.wan3', version: 'v2' }) }),
      expect.objectContaining({ status: 'RESOLVED', contract: expect.objectContaining({ id: 'enum.wan3.workflow', version: 'v2' }) }),
    ]));
    expect(report.scenarios[0].scenario.contractDependencies?.map((item) => item.contractId))
      .toEqual(expect.arrayContaining(['model.wan3', 'enum.wan3.workflow']));
  });
});
