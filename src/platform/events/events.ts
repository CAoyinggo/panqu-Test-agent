// Platform Event 类型（Phase 24.6）：统一事件定义
// 任务书 17（Event Bus）事件清单 + 任务书 10（Notification）重要事件清单。

/** 平台事件类型 */
export type PlatformEventType =
  | 'RunCreated'
  | 'RunStarted'
  | 'RunPaused'
  | 'RunResumed'
  | 'RunCompleted'
  | 'RunFailed'
  | 'CaseFailed'
  | 'RcaCompleted'
  | 'DefectCreated'
  | 'ReleasePass'
  | 'ReleaseReview'
  | 'ReleaseBlock'
  | 'WorkerOnline'
  | 'WorkerOffline'
  | 'ApprovalRequested'
  | 'ApprovalCompleted'
  | 'KnowledgeUpdated'
  | 'P0Failure'
  | 'RepeatedFailure'
  | 'FlakyQuarantine'
  | 'HealingApproval'
  | 'ProductionDeny'
  | 'SchedulerFailure'
  | 'BudgetExhausted'
  // Phase 39.5：协作（Comment / Mention）
  | 'CollaborationComment'
  | 'CollaborationMention';

/** 平台事件 */
export interface PlatformEvent {
  type: PlatformEventType;
  runId?: string;
  taskId?: string;
  traceId?: string;
  approvalId?: string;
  /** 事件附加数据（caseId / projectId / environment / reason 等） */
  data: Record<string, unknown>;
  timestamp: string;
}

/** 全部事件类型（校验 / 文档用） */
export const PLATFORM_EVENT_TYPES: readonly PlatformEventType[] = [
  'RunCreated', 'RunStarted', 'RunPaused', 'RunResumed', 'RunCompleted', 'RunFailed',
  'CaseFailed', 'RcaCompleted', 'DefectCreated',
  'ReleasePass', 'ReleaseReview', 'ReleaseBlock',
  'WorkerOnline', 'WorkerOffline',
  'ApprovalRequested', 'ApprovalCompleted',
  'KnowledgeUpdated',
  'P0Failure', 'RepeatedFailure', 'FlakyQuarantine', 'HealingApproval',
  'ProductionDeny', 'SchedulerFailure', 'BudgetExhausted',
  'CollaborationComment', 'CollaborationMention',
];
