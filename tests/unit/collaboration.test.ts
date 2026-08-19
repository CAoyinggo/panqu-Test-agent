// 单元测试：Collaboration（Phase 39.5）
// 覆盖：Comment / Mention（@user → 通知事件）/ Assignment / Watcher / 跨项目隔离。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import type { PlatformEvent } from '../../src/platform/events/events.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

async function makeRun(b: PlatformBundle): Promise<string> {
  const { runId } = await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA' });
  return runId;
}

describe('Collaboration：Comment / Mention', () => {
  it('添加评论：正文 @user 被解析为 mentions，并触发 CollaborationMention 通知事件', async () => {
    const b = makeBundle();
    const runId = await makeRun(b);
    const mentions: PlatformEvent[] = [];
    const unsubscribe = b.bus.subscribe('CollaborationMention', (e) => { mentions.push(e); });
    const { comment, mentions: parsed } = await b.service.addRunComment(runId, 'RCA: MODEL_ERROR @zhangsan 请确认模型服务', 'qa', 'QA');
    expect(parsed).toEqual(['zhangsan']);
    expect(comment.body).toContain('@zhangsan');
    expect(comment.author).toBe('qa');
    // 评论已持久化
    const list = await b.service.listRunComments(runId, undefined);
    expect(list).toHaveLength(1);
    // @mention 触发通知事件（复用 EventBus + Notification Channel）
    expect(mentions.length).toBe(1);
    expect(mentions[0].data.mention).toBe('zhangsan');
    unsubscribe();
  });

  it('多条评论顺序保留', async () => {
    const b = makeBundle();
    const runId = await makeRun(b);
    await b.service.addRunComment(runId, '第一条', 'qa', 'QA');
    await b.service.addRunComment(runId, '第二条', 'dev', 'DEVELOPER');
    const list = await b.service.listRunComments(runId, undefined);
    expect(list.map((c) => c.body)).toEqual(['第一条', '第二条']);
  });

  it('Assignment：指派处理人', async () => {
    const b = makeBundle();
    const runId = await makeRun(b);
    const item = await b.service.assignRun(runId, ['zhangsan', 'lisi'], 'qa', 'QA');
    expect(item.assignees).toEqual(['zhangsan', 'lisi']);
  });

  it('Watcher：关注 / 取消关注', async () => {
    const b = makeBundle();
    const runId = await makeRun(b);
    const coll = b.workflow.collaboration;
    const watched = await coll.setWatcher({ resourceType: 'run', resourceId: runId, projectId: 'wan3', user: 'qa', watching: true });
    expect(watched.watchers).toContain('qa');
    const unwatched = await coll.setWatcher({ resourceType: 'run', resourceId: runId, projectId: 'wan3', user: 'qa', watching: false });
    expect(unwatched.watchers).not.toContain('qa');
  });

  it('跨项目隔离：scopes 不匹配的 Run 评论被拒绝', async () => {
    const b = makeBundle();
    b.service.createProject({ id: 'other', name: 'Other', businesses: [], environments: [{ id: 'test', name: 'test', type: 'test', enabled: true }], defaultEnvironment: 'test' } as never);
    const other = await b.service.createRun({ projectId: 'other', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA' });
    await expect(
      b.service.addRunComment(other.runId, 'hi', 'qa', 'QA', { projects: ['wan3'], environments: [], businesses: [] }),
    ).rejects.toThrow(/无权访问/);
  });

  it('不存在的 Run → 抛错', async () => {
    const b = makeBundle();
    await expect(b.service.addRunComment('run-nope', 'hi', 'qa', 'QA')).rejects.toThrow(/Run 不存在/);
  });
});
