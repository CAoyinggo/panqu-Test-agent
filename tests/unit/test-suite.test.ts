// 单元测试：Test Suite（Phase 39.1）
// 覆盖：创建 / 修改 / 复制 / 归档 / 恢复 / 添加移除 Case / 按 Tag 过滤 / 跨项目隔离。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

describe('Test Suite：CRUD', () => {
  it('创建 Suite（维护 caseIds 引用，不复制数据）', async () => {
    const b = makeBundle();
    const s = await b.service.createSuite({ projectId: 'wan3', name: 'WAN3 回归', caseIds: ['wan3-1080p-10s', 'wan3-4k-30s'], tags: ['regression', 'p0'], createdBy: 'qa' }, 'QA');
    expect(s.id).toMatch(/^suite-/);
    expect(s.status).toBe('ACTIVE');
    expect(s.caseIds).toHaveLength(2);
    expect(await b.service.getSuite(s.id)).toMatchObject({ name: 'WAN3 回归' });
  });

  it('修改名称 / 描述 / Tags', async () => {
    const b = makeBundle();
    const s = await b.service.createSuite({ projectId: 'wan3', name: 'A', createdBy: 'qa' }, 'QA');
    const updated = await b.service.updateSuite(s.id, { name: 'B', description: 'desc', tags: ['t1'] }, 'qa', 'QA');
    expect(updated.name).toBe('B');
    expect(updated.description).toBe('desc');
    expect(updated.tags).toEqual(['t1']);
  });

  it('添加 / 移除 Case（去重）', async () => {
    const b = makeBundle();
    const s = await b.service.createSuite({ projectId: 'wan3', name: 'A', caseIds: ['c1'], createdBy: 'qa' }, 'QA');
    const added = await b.service.addSuiteCases(s.id, ['c2', 'c1'], 'qa', 'QA');
    expect(added.caseIds).toEqual(['c1', 'c2']);
    const removed = await b.service.removeSuiteCases(s.id, ['c1'], 'qa', 'QA');
    expect(removed.caseIds).toEqual(['c2']);
  });

  it('归档 / 恢复', async () => {
    const b = makeBundle();
    const s = await b.service.createSuite({ projectId: 'wan3', name: 'A', createdBy: 'qa' }, 'QA');
    expect((await b.service.archiveSuite(s.id, 'qa', 'QA')).status).toBe('ARCHIVED');
    expect((await b.service.getSuite(s.id))!.status).toBe('ARCHIVED');
    expect((await b.service.restoreSuite(s.id, 'qa', 'QA')).status).toBe('ACTIVE');
  });

  it('复制：新 Suite 共享引用（不复制 TestCase 数据）', async () => {
    const b = makeBundle();
    const s = await b.service.createSuite({ projectId: 'wan3', name: '原', caseIds: ['c1', 'c2'], createdBy: 'qa' }, 'QA');
    const copy = await b.service.copySuite(s.id, 'qa', 'QA');
    expect(copy.id).not.toBe(s.id);
    expect(copy.caseIds).toEqual(['c1', 'c2']);
    expect(copy.name).toContain('副本');
  });

  it('按 Tag 过滤', async () => {
    const b = makeBundle();
    await b.service.createSuite({ projectId: 'wan3', name: 'A', tags: ['regression'], createdBy: 'qa' }, 'QA');
    await b.service.createSuite({ projectId: 'wan3', name: 'B', tags: ['smoke'], createdBy: 'qa' }, 'QA');
    const matched = await b.service.listSuitesByTag(['regression']);
    expect(matched.map((s) => s.name)).toEqual(['A']);
  });

  it('跨项目隔离：JWT scopes 只看到授权项目', async () => {
    const b = makeBundle();
    const s = await b.service.createSuite({ projectId: 'wan3', name: 'A', createdBy: 'qa' }, 'QA');
    await b.service.createSuite({ projectId: 'other', name: 'B', createdBy: 'qa' }, 'QA');
    const visible = await b.service.listSuites(undefined, { projects: ['wan3'], environments: [], businesses: [] });
    expect(visible.map((x) => x.id)).toEqual([s.id]);
  });

  it('VIEWER 无权创建 Suite', async () => {
    const b = makeBundle();
    await expect(b.service.createSuite({ projectId: 'wan3', name: 'A', createdBy: 'viewer' }, 'VIEWER')).rejects.toThrow(/权限/);
  });
});
