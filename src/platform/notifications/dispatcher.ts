// Notification Dispatcher（Phase 24.6）：事件 → 通知消息 → 多通道分发
// 内置事件 → 标题 / 严重度 / 正文 映射（覆盖任务书 10 重要事件）。
// 多通道并行发送，任一通道失败不阻断其他通道。

import type { PlatformEvent, PlatformEventType } from '../events/events.js';
import type { NotificationChannel, NotificationMessage } from './channel.js';

/** 事件 → 通知模板 */
interface EventTemplate {
  title: string;
  severity: NotificationMessage['severity'];
  /** 从事件数据中提取正文关键信息 */
  body: (e: PlatformEvent) => string;
}

/** 重要事件映射（任务书 10） */
export const EVENT_NOTIFICATION_TEMPLATES: Record<PlatformEventType, EventTemplate> = {
  RunCreated: { title: 'Run 已创建', severity: 'info', body: (e) => `${e.runId} 已入队（${String(e.data.environment ?? '')}）` },
  RunStarted: { title: 'Run 已开始', severity: 'info', body: (e) => `${e.runId} 开始执行` },
  RunPaused: { title: 'Run 已暂停', severity: 'warning', body: (e) => `${e.runId} 已暂停，checkpoint 已保存` },
  RunResumed: { title: 'Run 已恢复', severity: 'info', body: (e) => `${e.runId} 从 checkpoint 恢复` },
  RunCompleted: { title: 'Run 完成', severity: 'info', body: (e) => `${e.runId} 执行完成` },
  RunFailed: { title: 'Run 失败', severity: 'error', body: (e) => `${e.runId} 执行失败：${String(e.data.reason ?? '')}` },
  CaseFailed: { title: '用例失败', severity: 'error', body: (e) => `用例 ${String(e.data.caseId ?? '')} 失败：${String(e.data.reason ?? '')}` },
  P0Failure: { title: 'P0 失败', severity: 'critical', body: (e) => `P0 用例 ${String(e.data.caseId ?? '')} 失败，需立即关注` },
  RcaCompleted: { title: 'RCA 完成', severity: 'info', body: (e) => `用例 ${String(e.data.caseId ?? '')} 根因：${String(e.data.category ?? '')}` },
  DefectCreated: { title: '缺陷已创建', severity: 'warning', body: (e) => `缺陷 ${String(e.data.defectId ?? '')}（${String(e.data.severity ?? '')}）：${String(e.data.reason ?? '')}` },
  ReleasePass: { title: '发布通过', severity: 'info', body: (e) => `${e.runId} 发布门禁 PASS（confidence ${String(e.data.confidence ?? '')}）` },
  ReleaseReview: { title: '发布需人工评审', severity: 'warning', body: (e) => `${e.runId} 发布门禁 REVIEW，需人工确认（${String(e.data.reason ?? '')}）` },
  ReleaseBlock: { title: '发布阻塞', severity: 'critical', body: (e) => `${e.runId} 发布门禁 BLOCK：${String(e.data.reason ?? '')}` },
  WorkerOnline: { title: 'Worker 上线', severity: 'info', body: (e) => `Worker ${String(e.data.workerId ?? '')} 已注册` },
  WorkerOffline: { title: 'Worker 下线', severity: 'error', body: (e) => `Worker ${String(e.data.workerId ?? '')} 心跳超时/下线，Job 已回收` },
  ApprovalRequested: { title: '审批请求', severity: 'warning', body: (e) => `${e.runId} ${String(e.data.action ?? '')}@${String(e.data.environment ?? '')} 需审批（approval: ${e.approvalId ?? ''}）` },
  HealingApproval: { title: '自愈需审批', severity: 'warning', body: (e) => `自愈动作需审批：${String(e.data.reason ?? '')}` },
  ApprovalCompleted: { title: '审批完成', severity: 'info', body: (e) => `审批 ${e.approvalId ?? ''} 结果：${String(e.data.status ?? '')}（by ${String(e.data.decidedBy ?? '')}）` },
  KnowledgeUpdated: { title: '知识更新', severity: 'info', body: (e) => `知识库更新 ${String(e.data.count ?? 0)} 条` },
  RepeatedFailure: { title: '重复失败', severity: 'error', body: (e) => `用例 ${String(e.data.caseId ?? '')} 多次失败（${String(e.data.count ?? '')} 次）` },
  FlakyQuarantine: { title: 'Flaky 隔离', severity: 'warning', body: (e) => `用例 ${String(e.data.caseId ?? '')} 判定为 Flaky，已隔离` },
  ProductionDeny: { title: '生产访问被拒', severity: 'critical', body: (e) => `${String(e.data.actor ?? '')} 尝试 ${String(e.data.action ?? '')}@production 被拒绝（生产安全）` },
  SchedulerFailure: { title: '调度器异常', severity: 'critical', body: (e) => `调度器异常：${String(e.data.reason ?? '')}` },
  BudgetExhausted: { title: '预算耗尽', severity: 'error', body: (e) => `${e.runId} 预算耗尽：${String(e.data.reason ?? '')}` },
};

/** 事件 → 通知消息 */
export function buildNotificationMessage(event: PlatformEvent): NotificationMessage {
  const t = EVENT_NOTIFICATION_TEMPLATES[event.type];
  return {
    title: t.title,
    body: t.body(event),
    severity: t.severity,
    eventType: event.type,
    runId: event.runId,
    metadata: event.data,
  };
}

/** 通知结果摘要 */
export interface NotificationSummary {
  total: number;
  sent: number;
  failed: number;
}

/** 通知分发器：注册多通道，事件 → 消息 → 并行分发 */
export class NotificationDispatcher {
  private channels: NotificationChannel[] = [];

  register(channel: NotificationChannel): void {
    this.channels.push(channel);
  }

  unregister(name: string): void {
    this.channels = this.channels.filter((c) => c.name !== name);
  }

  channelNames(): string[] {
    return this.channels.map((c) => c.name);
  }

  channelCount(): number {
    return this.channels.length;
  }

  /** 发送一条消息到全部通道（任一失败不阻断） */
  async notify(message: NotificationMessage): Promise<NotificationSummary> {
    const results = await Promise.allSettled(this.channels.map((c) => c.send(message)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    return { total: this.channels.length, sent: this.channels.length - failed, failed };
  }

  /** 事件 → 通知消息 → 分发 */
  async notifyEvent(event: PlatformEvent): Promise<NotificationSummary> {
    return this.notify(buildNotificationMessage(event));
  }
}
