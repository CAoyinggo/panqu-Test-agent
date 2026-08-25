// 单元测试：Run Template（Phase 39.3）
// 覆盖：Save as Template（只复制 Configuration）/ Run Template（生成新 Run）/ 复用计数 /
//       Run Again（不复制结果）/ Clone Configuration（允许改环境/预算/门禁）。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { completeVerifiedRun } from '../helpers/platform-run.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

/** 直接创建并返回一个可复用的 Run（终态 COMPLETED / FAILED） */
async function makeFinishedRun(b: PlatformBundle, status: 'COMPLETED' | 'FAILED' = 'COMPLETED'): Promise<string> {
  const suite = await b.service.createSuite({ projectId: 'wan3', name: '回归', caseIds: ['c1'], createdBy: 'qa' }, 'QA');
  const plan = await b.service.createPlan({ projectId: 'wan3', name: 'P', suiteIds: [suite.id], environment: 'staging', mode: 'AUTONOMOUS', budget: 10, releaseGate: true, createdBy: 'qa' }, 'QA');
  const { runId } = await b.service.runPlan(plan.id, 'qa', 'QA');
  if (status === 'COMPLETED') await completeVerifiedRun(b, runId);
  else await b.service.startRun(runId);
  if (status === 'FAILED') await b.service.failRun(runId, 'boom');
  return runId;
}

describe('Run Template：Save as Template', () => {
  it('从 Run 保存模板：只复制 Configuration，不复制结果', async () => {
    const b = makeBundle();
    const runId = await makeFinishedRun(b, 'FAILED');
    const t = await b.service.saveTemplateFromRun(runId, 'WAN3 回归模板', 'qa', 'QA');
    expect(t.name).toBe('WAN3 回归模板');
    expect(t.environment).toBe('staging');
    expect(t.mode).toBe('AUTONOMOUS');
    expect(t.budget).toBe(10);
    expect(t.releaseGate).toBe(true);
    // 模板对象不携带任何结果 / RCA / 门禁决策
    expect(Object.keys(t)).not.toContain('status');
    expect(Object.keys(t)).not.toContain('progress');
    expect(t.runCount).toBe(0);
  });

  it('Run Template → 生成新 Run（仅 Configuration；结果全新）', async () => {
    const b = makeBundle();
    const t = await b.service.createTemplate({ projectId: 'wan3', name: 'T', environment: 'staging', suiteIds: [], mode: 'AUTONOMOUS', budget: 7, releaseGate: true, createdBy: 'qa' }, 'QA');
    const { runId } = await b.service.runTemplate(t.id, 'qa', 'QA');
    const run = await b.service.getRun(runId);
    expect(run?.templateId).toBe(t.id);
    expect(run?.environment).toBe('staging');
    expect(run?.mode).toBe('AUTONOMOUS');
    expect(run?.budget).toBe(7);
    expect(run?.releaseGate).toBe(true);
    expect(run?.status).toBe('QUEUED'); // 全新 Run，不带旧结果
    expect((await b.service.getTemplate(t.id))!.runCount).toBe(1); // 复用计数 +1
  });

  it('Run Again：复制 project/env/suite/plan/mode/budget（不复制旧状态/结果）', async () => {
    const b = makeBundle();
    const runId = await makeFinishedRun(b, 'FAILED');
    const { runId: rerunId } = await b.service.rerunRun(runId, 'qa', 'QA');
    const old = await b.service.getRun(runId);
    const fresh = await b.service.getRun(rerunId);
    expect(fresh?.projectId).toBe(old?.projectId);
    expect(fresh?.environment).toBe(old?.environment);
    expect(fresh?.planId).toBe(old?.planId);
    expect(fresh?.suiteIds).toEqual(old?.suiteIds);
    expect(fresh?.mode).toBe(old?.mode);
    expect(fresh?.budget).toBe(old?.budget);
    expect(fresh?.status).toBe('QUEUED');
    expect(fresh?.runId).not.toBe(runId);
  });

  it('Clone Configuration：允许改 environment / budget / releaseGate', async () => {
    const b = makeBundle();
    const runId = await makeFinishedRun(b);
    const { runId: cloneId } = await b.service.cloneRun(runId, { environment: 'preprod', budget: 3, releaseGate: false }, 'qa', 'QA');
    const fresh = await b.service.getRun(cloneId);
    expect(fresh?.environment).toBe('preprod');
    expect(fresh?.budget).toBe(3);
    expect(fresh?.releaseGate).toBe(false);
    expect(fresh?.status).toBe('QUEUED');
  });

  it('跨项目隔离：runTemplate 需匹配 scopes', async () => {
    const b = makeBundle();
    const t = await b.service.createTemplate({ projectId: 'other', name: 'X', environment: 'test', suiteIds: [], mode: 'MANUAL', createdBy: 'qa' }, 'QA');
    await expect(b.service.runTemplate(t.id, 'qa', 'QA', { projects: ['wan3'], environments: [], businesses: [] })).rejects.toThrow(/无权访问/);
  });
});
