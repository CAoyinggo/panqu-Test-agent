import { describe, expect, it } from 'vitest';
import {
  DriftDetector,
  LegacyMigrationIndex,
  createPhase1ContractRegistry,
  createPhase1ContractResolver,
  registerKnowledgeFact,
} from '../../../src/contracts/index.js';
import { generateTestCasesWithBusiness, toTaskDef } from '../../../src/agents/index.js';
import { contractDependency } from '../../../src/contracts/dependency-index.js';

const NOW = '2026-08-24T00:00:00.000Z';

describe('Phase 1 Wan3 contract sample', () => {
  it('keeps historical and current versions separate and resolves current facts', () => {
    const registry = createPhase1ContractRegistry();
    const resolution = createPhase1ContractResolver().resolve<Record<string, unknown>>({ id: 'model.wan3' });
    expect(resolution.status).toBe('RESOLVED');
    expect(resolution.contract?.version).toBe('v2');
    expect(resolution.contract?.value).toMatchObject({ type: 10, task_type: 'qnck_to_video', workflow_type: 'qnck' });
    expect(registry.list({ id: 'model.wan3' })).toHaveLength(2);
  });

  it('detects all three required historical drifts without special-case detector logic', () => {
    const registry = createPhase1ContractRegistry();
    const [oldContract, currentContract] = registry.list({ id: 'model.wan3' });
    const result = new DriftDetector().compare(oldContract, currentContract);
    expect(result.status).toBe('DRIFT');
    expect(result.changedFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$.type', before: 6, after: 10 }),
      expect.objectContaining({ path: '$.task_type', before: 105, after: 'qnck_to_video' }),
      expect.objectContaining({ path: '$.workflow_type', before: 'qntk', after: 'qnck' }),
    ]));
  });

  it('does not invent unknown Kling/H3/API facts', () => {
    const resolver = createPhase1ContractResolver();
    expect(resolver.resolve({ id: 'model.kling' }).status).toBe('UNKNOWN');
    expect(resolver.resolve({ id: 'model.h3' }).status).toBe('UNKNOWN');
    expect(resolver.resolve({ id: 'api.videohub.submit' }).status).toBe('UNKNOWN');
    expect(resolver.resolve({ id: 'api.videohub.getRecentTasks' }).status).toBe('UNKNOWN');
  });

  it('injects resolved model values into Agent TaskDef instead of using the legacy type=6 default', async () => {
    const resolver = createPhase1ContractResolver();
    const model = resolver.resolve({ id: 'model.wan3' }).contract!;
    const cases = generateTestCasesWithBusiness({
        feature: 'wan3', capabilities: ['text-to-video'], inputs: ['prompt'], requirements: [],
        businessRules: ['任务提交成功'], dependencies: ['模型服务'], version: 'v1',
    }).cases;
    cases.forEach((testCase) => {
      testCase.contractDependencies = [contractDependency(model)];
      testCase.metadata = { ...(testCase.metadata ?? {}), resolvedContractValue: model.value };
    });
    const task = toTaskDef(cases[0]);
    expect(task).toMatchObject({ type: 10, model_id: 84, task_type: 'qnck_to_video' });
    expect(task.extra?.workflow_type).toBe('qnck');
    expect(task.contractDependencies?.[0]).toMatchObject({ contractId: 'model.wan3', version: 'v2' });
  });
});

describe('KnowledgeStore compatibility boundary', () => {
  it('only promotes environment-fact knowledge and preserves lifecycle status', () => {
    const registry = createPhase1ContractRegistry();
    const base = {
      feature: 'demo', title: 'Current environment flag', content: 'enabled=true', confidence: 0.8,
      usageCount: 1, source: 'manual', tags: [], createdAt: NOW, updatedAt: NOW,
    };
    expect(registerKnowledgeFact({ ...base, id: 'kb-risk', type: 'risk-insight', status: 'ACTIVE' }, registry)).toBeUndefined();
    const contract = registerKnowledgeFact({ ...base, id: 'kb-env', type: 'environment-fact', status: 'STALE' }, registry);
    expect(contract).toMatchObject({ id: 'resource.knowledge.kb-env', status: 'STALE' });
  });
});

describe('Legacy migration index', () => {
  it('classifies every indexed asset and exposes Wan3 dependencies', () => {
    const index = LegacyMigrationIndex.load();
    expect(index.data.assets).toHaveLength(18);
    expect(index.data.assets.every((asset) => ['ACTIVE', 'LEGACY', 'STALE', 'CONFLICT', 'UNKNOWN'].includes(asset.status))).toBe(true);
    expect(index.get('tasks/wan3-wensheng.json')).toMatchObject({ status: 'STALE', type: 'TaskDef' });
    expect(index.get('src/platform/test-assets/wan3-catalog.ts')?.contracts.map((item) => item.contractId))
      .toContain('model.wan3');
    expect(index.byContract('model.wan3')).toHaveLength(17);
  });

  it('reports per asset type/status statistics', () => {
    const stats = LegacyMigrationIndex.load().statistics();
    expect(stats.TaskDef.STALE).toBe(4);
    expect(stats['TypeScript Case'].STALE).toBe(9);
    expect(stats.Catalog.STALE).toBe(1);
    expect(stats.Template.LEGACY).toBe(1);
    expect(stats['Hardcoded Generator'].STALE).toBe(2);
    expect(stats['Hardcoded Generator'].LEGACY).toBe(1);
  });
});
