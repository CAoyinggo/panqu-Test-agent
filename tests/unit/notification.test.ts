// 单元测试：Event Bus + Notification（Phase 24.6）
// 覆盖：订阅 / 退订 / 全局订阅 / 发布顺序 / 事件完整性 / 通道实现（Feishu/DingTalk/Email/Webhook）/
//       重要事件映射（Release BLOCK / P0 / Worker Down / Production Deny 等）/ 多通道分发容错。

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/platform/events/index.js';
import { PLATFORM_EVENT_TYPES } from '../../src/platform/events/index.js';
import type { PlatformEvent, PlatformEventType } from '../../src/platform/events/index.js';
import {
  NotificationDispatcher,
  buildNotificationMessage,
  consoleChannel,
  webhookChannel,
  feishuChannel,
  dingTalkChannel,
  emailChannel,
} from '../../src/platform/notifications/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

describe('EventBus（In-Process）', () => {
  it('订阅指定事件并收到发布的事件', async () => {
    const bus = new EventBus({ now: () => FIXED_ISO });
    const got: PlatformEvent[] = [];
    bus.subscribe('RunCreated', (e) => {
      got.push(e);
    });
    const ev = await bus.publish({ type: 'RunCreated', runId: 'run-1', data: { environment: 'test' } });
    expect(got).toHaveLength(1);
    expect(got[0].runId).toBe('run-1');
    expect(got[0].timestamp).toBe(FIXED_ISO);
    expect(ev.timestamp).toBe(FIXED_ISO);
  });

  it('只收到订阅类型的事件；退订后不再收到', async () => {
    const bus = new EventBus();
    const got: PlatformEventType[] = [];
    const off = bus.subscribe('RunFailed', (e) => {
      got.push(e.type);
    });
    await bus.publish({ type: 'RunCompleted', data: {} });
    expect(got).toHaveLength(0);
    await bus.publish({ type: 'RunFailed', data: {} });
    expect(got).toEqual(['RunFailed']);
    off();
    await bus.publish({ type: 'RunFailed', data: {} });
    expect(got).toHaveLength(1);
  });

  it('全局订阅收到全部事件', async () => {
    const bus = new EventBus();
    const got: PlatformEventType[] = [];
    bus.subscribeAll((e) => {
      got.push(e.type);
    });
    await bus.publish({ type: 'RunStarted', data: {} });
    await bus.publish({ type: 'WorkerOnline', data: {} });
    expect(got).toEqual(['RunStarted', 'WorkerOnline']);
  });

  it('事件类型清单完整覆盖任务书事件', () => {
    const required = [
      'RunCreated', 'RunStarted', 'RunPaused', 'RunResumed', 'RunCompleted', 'RunFailed',
      'CaseFailed', 'RcaCompleted', 'DefectCreated',
      'ReleasePass', 'ReleaseReview', 'ReleaseBlock',
      'WorkerOnline', 'WorkerOffline',
      'ApprovalRequested', 'ApprovalCompleted',
      'KnowledgeUpdated',
    ];
    for (const t of required) expect(PLATFORM_EVENT_TYPES).toContain(t);
  });

  it('监听器异常不阻断总线与其他监听器', async () => {
    const bus = new EventBus();
    const got: string[] = [];
    bus.subscribe('RunCreated', async () => {
      throw new Error('boom');
    });
    bus.subscribe('RunCreated', (e) => {
      got.push(e.runId ?? '');
    });
    await bus.publish({ type: 'RunCreated', runId: 'r', data: {} });
    expect(got).toEqual(['r']);
    expect(bus.totalPublished()).toBe(1);
  });
});

describe('Notification Channel 实现', () => {
  it('webhookChannel：POST JSON 到 url（可注入 sender）', async () => {
    const sender = vi.fn(async () => ({ ok: true }));
    const ch = webhookChannel({ name: 'wh', url: 'https://example.com/hook', sender });
    await ch.send({ title: 'T', body: 'B', severity: 'error', eventType: 'RunFailed' });
    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'T', text: 'B', msgType: 'error' }),
      'https://example.com/hook',
    );
  });

  it('webhookChannel 缺少 url → 抛错', async () => {
    const ch = webhookChannel({ name: 'wh' });
    await expect(ch.send({ title: 'T', body: 'B', severity: 'info', eventType: 'X' })).rejects.toThrow(/缺少 url/);
  });

  it('feishuChannel：text 风格 payload', async () => {
    const sender = vi.fn(async () => ({}));
    const ch = feishuChannel({ name: 'feishu', url: 'https://open.feishu.cn/hook', sender });
    await ch.send({ title: '发布阻塞', body: 'run-1 BLOCK', severity: 'critical', eventType: 'ReleaseBlock' });
    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({ msg_type: 'text', content: { text: expect.stringContaining('发布阻塞') } }),
      'https://open.feishu.cn/hook',
    );
  });

  it('dingTalkChannel：markdown 风格 payload', async () => {
    const sender = vi.fn(async () => ({}));
    const ch = dingTalkChannel({ name: 'ding', url: 'https://oapi.dingtalk.com/robot/send', sender });
    await ch.send({ title: 'Worker 下线', body: 'w1 down', severity: 'error', eventType: 'WorkerOffline' });
    expect(sender).toHaveBeenCalledWith(
      expect.objectContaining({ msgtype: 'markdown', markdown: { title: 'Worker 下线', text: expect.stringContaining('w1 down') } }),
      'https://oapi.dingtalk.com/robot/send',
    );
  });

  it('emailChannel：注入 send 接收消息与收件人', async () => {
    const send = vi.fn(async () => ({}));
    const ch = emailChannel({ name: 'email', to: ['a@x.com'], send });
    await ch.send({ title: 'T', body: 'B', severity: 'warning', eventType: 'ApprovalRequested' });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { to: ['a@x.com'] } }),
    );
  });
});

describe('Notification Dispatcher：事件映射与分发', () => {
  it('Release BLOCK → critical 严重度，正文含 runId 与原因', () => {
    const msg = buildNotificationMessage({
      type: 'ReleaseBlock',
      runId: 'run-9',
      data: { reason: 'P0 缺陷 2 个' },
      timestamp: FIXED_ISO,
    });
    expect(msg.severity).toBe('critical');
    expect(msg.title).toContain('发布阻塞');
    expect(msg.body).toContain('run-9');
    expect(msg.body).toContain('P0 缺陷');
  });

  it('P0Failure / ProductionDeny / WorkerOffline / BudgetExhausted 均映射为告警', () => {
    expect(buildNotificationMessage({ type: 'P0Failure', data: {} } as PlatformEvent).severity).toBe('critical');
    expect(buildNotificationMessage({ type: 'ProductionDeny', data: {} } as PlatformEvent).severity).toBe('critical');
    expect(buildNotificationMessage({ type: 'WorkerOffline', data: {} } as PlatformEvent).severity).toBe('error');
    expect(buildNotificationMessage({ type: 'BudgetExhausted', data: {} } as PlatformEvent).severity).toBe('error');
    expect(buildNotificationMessage({ type: 'ReleaseReview', data: {} } as PlatformEvent).severity).toBe('warning');
  });

  it('多通道分发：全部成功 → sent=通道数', async () => {
    const d = new NotificationDispatcher();
    d.register(consoleChannel('console'));
    d.register(emailChannel({ name: 'email' }));
    const sum = await d.notifyEvent({ type: 'ReleasePass', runId: 'r', data: { confidence: 0.9 }, timestamp: FIXED_ISO });
    expect(sum.total).toBe(2);
    expect(sum.sent).toBe(2);
    expect(sum.failed).toBe(0);
  });

  it('某一通道失败不阻断其他通道（failed 计数正确）', async () => {
    const d = new NotificationDispatcher();
    d.register(webhookChannel({ name: 'bad', url: 'https://x.invalid/hook' }));
    d.register(emailChannel({ name: 'ok' }));
    const sum = await d.notifyEvent({ type: 'RunCompleted', runId: 'r', data: {}, timestamp: FIXED_ISO });
    expect(sum.total).toBe(2);
    expect(sum.sent).toBe(1);
    expect(sum.failed).toBe(1);
  });

  it('unregister / channelCount', () => {
    const d = new NotificationDispatcher();
    d.register(consoleChannel('a'));
    d.register(consoleChannel('b'));
    expect(d.channelCount()).toBe(2);
    d.unregister('a');
    expect(d.channelNames()).toEqual(['b']);
  });
});
