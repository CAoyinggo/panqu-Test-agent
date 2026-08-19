// 单元测试：Test Asset Versioning（Phase 39.4）
// 覆盖：版本记录 v1/v2/v3、History、Compare（字段级差异）、Rollback（快照）、Run 固定版本。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

describe('Asset Versioning：版本记录 / History', () => {
  it('同资产版本递增 v1 → v2 → v3，记录 createdBy / changeReason / createdAt', async () => {
    const b = makeBundle();
    const v1 = await b.service.recordAssetVersion({ assetType: 'test-case', assetId: 'c1', snapshot: { title: 'A', steps: ['s1'] }, createdBy: 'qa', changeReason: '初始' }, 'QA');
    const v2 = await b.service.recordAssetVersion({ assetType: 'test-case', assetId: 'c1', snapshot: { title: 'B', steps: ['s1'] }, createdBy: 'qa', changeReason: '改标题' }, 'QA');
    const v3 = await b.service.recordAssetVersion({ assetType: 'test-case', assetId: 'c1', snapshot: { title: 'C', steps: ['s1', 's2'] }, createdBy: 'qa', changeReason: '加步骤' }, 'QA');
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(v3.createdBy).toBe('qa');
    expect(v3.changeReason).toBe('加步骤');
    expect(typeof v3.createdAt).toBe('string');
    expect(v3.createdAt.length).toBeGreaterThan(0);
    const history = await b.service.assetVersions('c1');
    expect(history.map((h) => h.version)).toEqual([1, 2, 3]);
  });

  it('Compare：字段级差异（changed / added / removed）', async () => {
    const b = makeBundle();
    await b.service.recordAssetVersion({ assetType: 'test-case', assetId: 'c1', snapshot: { title: 'A', steps: ['s1'], owner: 'x' }, createdBy: 'qa' }, 'QA');
    await b.service.recordAssetVersion({ assetType: 'test-case', assetId: 'c1', snapshot: { title: 'B', steps: ['s1'], tags: ['t'] }, createdBy: 'qa' }, 'QA');
    const diff = await b.service.assetCompare('c1', 1, 2);
    expect(diff.changed).toEqual(['title']);
    expect(diff.added).toEqual(['tags']);
    expect(diff.removed).toEqual(['owner']);
    const titleChange = diff.changes.find((c) => c.key === 'title');
    expect(titleChange?.from).toBe('A');
    expect(titleChange?.to).toBe('B');
  });

  it('Rollback：返回指定版本快照', async () => {
    const b = makeBundle();
    await b.service.recordAssetVersion({ assetType: 'suite', assetId: 's1', snapshot: { name: 'v1', caseIds: ['a'] }, createdBy: 'qa' }, 'QA');
    await b.service.recordAssetVersion({ assetType: 'suite', assetId: 's1', snapshot: { name: 'v2', caseIds: ['a', 'b'] }, createdBy: 'qa' }, 'QA');
    const snap = await b.service.assetRollbackSnapshot('s1', 1);
    expect(snap).toEqual({ name: 'v1', caseIds: ['a'] });
  });

  it('不存在的版本 → 抛错', async () => {
    const b = makeBundle();
    await b.service.recordAssetVersion({ assetType: 'test-case', assetId: 'c1', snapshot: { a: 1 }, createdBy: 'qa' }, 'QA');
    await expect(b.service.assetCompare('c1', 1, 9)).rejects.toThrow(/版本不存在/);
  });

  it('Run 固定 assetVersion：执行引用版本号', async () => {
    const b = makeBundle();
    await b.service.recordAssetVersion({ assetType: 'test-case', assetId: 'wan3-1080p-10s', snapshot: { title: 'v1' }, createdBy: 'qa', changeReason: 'v1' }, 'QA');
    await b.service.recordAssetVersion({ assetType: 'test-case', assetId: 'wan3-1080p-10s', snapshot: { title: 'v2' }, createdBy: 'qa', changeReason: 'v2' }, 'QA');
    const s = await b.service.createSuite({ projectId: 'wan3', name: 'S', caseIds: ['wan3-1080p-10s'], createdBy: 'qa' }, 'QA');
    const p = await b.service.createPlan({ projectId: 'wan3', name: 'P', suiteIds: [s.id], environment: 'test', mode: 'MANUAL', createdBy: 'qa' }, 'QA');
    const { runId } = await b.service.runPlan(p.id, 'qa', 'QA');
    const run = await b.service.getRun(runId);
    // 本次 Run 固定为最新 v2（可溯源）
    expect(run?.assetVersion?.['wan3-1080p-10s']).toBe(2);
  });
});
