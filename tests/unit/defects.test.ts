// 单元测试：Defect 管理（Phase 40.2）
// 覆盖：创建 / 状态机 / 指派 / 列表过滤 / 跨项目隔离 / 权限 / DefectCreated 事件 / QA Home recentDefects 真实数据。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

describe('Defect：CRUD 与状态机', () => {
  it('创建缺陷：默认 severity=medium / status=OPEN，含 defectId', async () => {
    const b = makeBundle();
    const d = await b.service.createDefect({ projectId: 'wan3', title: '首页白屏', createdBy: 'qa' }, 'QA');
    expect(d.id).toMatch(/^defect-/);
    expect(d.defectId).toBe(d.id);
    expect(d.severity).toBe('medium');
    expect(d.status).toBe('OPEN');
    expect(d.title).toBe('首页白屏');
  });

  it('创建时指定 severity / 关联 Run 与 Case', async () => {
    const b = makeBundle();
    const d = await b.service.createDefect({ projectId: 'wan3', title: '崩溃', severity: 'critical', runId: 'run-1', caseId: 'case-1', environment: 'test', createdBy: 'qa' }, 'QA');
    expect(d.severity).toBe('critical');
    expect(d.runId).toBe('run-1');
    expect(d.caseId).toBe('case-1');
  });

  it('状态机：合法迁移通过，非法迁移拒绝', async () => {
    const b = makeBundle();
    const d = await b.service.createDefect({ projectId: 'wan3', title: 'A', createdBy: 'qa' }, 'QA');
    const inProg = await b.service.updateDefectStatus(d.id, 'IN_PROGRESS', undefined, 'qa', 'QA');
    expect(inProg.status).toBe('IN_PROGRESS');
    const resolved = await b.service.updateDefectStatus(d.id, 'RESOLVED', '已修复', 'qa', 'QA');
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolution).toBe('已修复');
    expect(typeof resolved.resolvedAt).toBe('string');
    await expect(b.service.updateDefectStatus(d.id, 'WONT_FIX', undefined, 'qa', 'QA')).rejects.toThrow(/非法迁移/);
  });

  it('指派处理人并更新基础信息', async () => {
    const b = makeBundle();
    const d = await b.service.createDefect({ projectId: 'wan3', title: 'A', createdBy: 'qa' }, 'QA');
    const assigned = await b.service.assignDefect(d.id, 'dev-1', 'qa', 'QA');
    expect(assigned.assignee).toBe('dev-1');
  });

  it('按项目 / 状态过滤', async () => {
    const b = makeBundle();
    await b.service.createDefect({ projectId: 'wan3', title: 'A', createdBy: 'qa' }, 'QA');
    await b.service.createDefect({ projectId: 'order', title: 'B', createdBy: 'qa' }, 'QA');
    const wan3 = await b.service.listDefects({ projectId: 'wan3' });
    expect(wan3.map((d) => d.title)).toEqual(['A']);
  });

  it('跨项目隔离：JWT scopes 只看到授权项目缺陷', async () => {
    const b = makeBundle();
    await b.service.createDefect({ projectId: 'wan3', title: 'A', createdBy: 'qa' }, 'QA');
    await b.service.createDefect({ projectId: 'order', title: 'B', createdBy: 'qa' }, 'QA');
    const visible = await b.service.listDefects(undefined, { projects: ['wan3'], environments: [], businesses: [] });
    expect(visible.map((d) => d.title)).toEqual(['A']);
    await expect(b.service.getDefect(visible[0].id, { projects: ['order'], environments: [], businesses: [] })).rejects.toThrow(/无权访问项目/);
  });

  it('VIEWER 无权创建缺陷（需 DEFECT_CREATE）', async () => {
    const b = makeBundle();
    await expect(b.service.createDefect({ projectId: 'wan3', title: 'A', createdBy: 'viewer' }, 'VIEWER')).rejects.toThrow(/权限/);
  });

  it('创建缺陷发布 DefectCreated 事件并写入 audit defect', async () => {
    const b = makeBundle();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    b.bus.subscribeAll((e) => {
      if (e.type === 'DefectCreated') events.push({ type: e.type, data: e.data });
    });
    const d = await b.service.createDefect({ projectId: 'wan3', title: '事件验证', severity: 'high', createdBy: 'qa' }, 'QA');
    expect(events).toHaveLength(1);
    expect(events[0].data.defectId).toBe(d.defectId);
    const audit = await b.audit.list({ action: 'defect' });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].resource).toContain(d.defectId);
  });
});

describe('QA Home：recentDefects 来自真实缺陷实体', () => {
  it('缺陷写入后 recentDefects 出现真实缺陷（字段对齐 defectId/title/severity/status）', async () => {
    const b = makeBundle();
    await b.service.createDefect({ projectId: 'wan3', title: '支付超时', severity: 'critical', createdBy: 'qa' }, 'QA');
    const home = await b.service.qaHome({ projects: ['wan3'], environments: [], businesses: [] });
    expect(home.recentDefects.length).toBe(1);
    const d = home.recentDefects[0];
    expect(d.defectId).toMatch(/^defect-/);
    expect(d.title).toBe('支付超时');
    expect(d.severity).toBe('critical');
    expect(d.status).toBe('OPEN');
  });

  it('recentDefects 按项目隔离：其他项目缺陷不可见', async () => {
    const b = makeBundle();
    await b.service.createDefect({ projectId: 'wan3', title: 'A', createdBy: 'qa' }, 'QA');
    await b.service.createDefect({ projectId: 'order', title: 'B', createdBy: 'qa' }, 'QA');
    const home = await b.service.qaHome({ projects: ['wan3'], environments: [], businesses: [] });
    expect(home.recentDefects.map((d) => d.title)).toEqual(['A']);
  });
});
