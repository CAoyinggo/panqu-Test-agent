// 单元测试：Test Plan（Phase 39.2）
// 覆盖：创建 / 修改 / Plan → Suite → TestCase 解析 / 按 Plan 直接运行 / 跨项目隔离。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

describe('Test Plan：CRUD', () => {
  it('创建 Plan（聚合多个 Suite）', async () => {
    const b = makeBundle();
    const s1 = await b.service.createSuite({ projectId: 'wan3', name: '回归', caseIds: ['c1', 'c2'], createdBy: 'qa' }, 'QA');
    const s2 = await b.service.createSuite({ projectId: 'wan3', name: '冒烟', caseIds: ['c3'], createdBy: 'qa' }, 'QA');
    const plan = await b.service.createPlan({ projectId: 'wan3', name: 'WAN3 发版计划', suiteIds: [s1.id, s2.id], environment: 'staging', mode: 'AUTONOMOUS', budget: 10, releaseGate: true, createdBy: 'qa' }, 'QA');
    expect(plan.id).toMatch(/^plan-/);
    expect(plan.mode).toBe('AUTONOMOUS');
    expect(plan.suiteIds).toEqual([s1.id, s2.id]);
  });

  it('修改 Plan（suiteIds / 环境 / 模式 / 预算 / 门禁）', async () => {
    const b = makeBundle();
    const plan = await b.service.createPlan({ projectId: 'wan3', name: 'P', environment: 'test', mode: 'MANUAL', createdBy: 'qa' }, 'QA');
    const updated = await b.service.updatePlan(plan.id, { environment: 'staging', mode: 'REGRESSION', budget: 5, releaseGate: true }, 'qa', 'QA');
    expect(updated.environment).toBe('staging');
    expect(updated.mode).toBe('REGRESSION');
    expect(updated.budget).toBe(5);
    expect(updated.releaseGate).toBe(true);
  });

  it('planCases：Plan → Suite → 去重 Case 列表', async () => {
    const b = makeBundle();
    const s1 = await b.service.createSuite({ projectId: 'wan3', name: 'A', caseIds: ['c1', 'c2'], createdBy: 'qa' }, 'QA');
    const s2 = await b.service.createSuite({ projectId: 'wan3', name: 'B', caseIds: ['c2', 'c3'], createdBy: 'qa' }, 'QA');
    const plan = await b.service.createPlan({ projectId: 'wan3', name: 'P', suiteIds: [s1.id, s2.id], environment: 'test', mode: 'MANUAL', createdBy: 'qa' }, 'QA');
    const { caseIds } = await b.service.planCases(plan.id);
    expect(caseIds).toEqual(['c1', 'c2', 'c3']);
  });

  it('按 Plan 直接运行 → 生成新 Run（固定 planId / assetVersion）', async () => {
    const b = makeBundle();
    const s = await b.service.createSuite({ projectId: 'wan3', name: '回归', caseIds: ['wan3-1080p-10s'], createdBy: 'qa' }, 'QA');
    await b.service.recordAssetVersion({ assetType: 'test-case', assetId: 'wan3-1080p-10s', snapshot: { title: 'v1' }, createdBy: 'qa' }, 'QA');
    const plan = await b.service.createPlan({ projectId: 'wan3', name: 'P', suiteIds: [s.id], environment: 'staging', mode: 'AUTONOMOUS', createdBy: 'qa' }, 'QA');
    const { runId } = await b.service.runPlan(plan.id, 'qa', 'QA');
    const run = await b.service.getRun(runId);
    expect(run?.planId).toBe(plan.id);
    expect(run?.suiteIds).toEqual([s.id]);
    expect(run?.mode).toBe('AUTONOMOUS');
    expect(run?.assetVersion?.['wan3-1080p-10s']).toBe(1);
  });

  it('不存在的 Plan → 抛错', async () => {
    const b = makeBundle();
    await expect(b.service.runPlan('plan-nope', 'qa', 'QA')).rejects.toThrow(/Test Plan 不存在/);
  });

  it('跨项目隔离：JWT scopes 只看到授权项目 Plan', async () => {
    const b = makeBundle();
    await b.service.createPlan({ projectId: 'wan3', name: 'A', environment: 'test', mode: 'MANUAL', createdBy: 'qa' }, 'QA');
    await b.service.createPlan({ projectId: 'other', name: 'B', environment: 'test', mode: 'MANUAL', createdBy: 'qa' }, 'QA');
    const visible = await b.service.listPlans(undefined, { projects: ['wan3'], environments: [], businesses: [] });
    expect(visible.map((p) => p.name)).toEqual(['A']);
  });
});
