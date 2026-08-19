// 统一 Run Entity（Phase 24.3）：Scheduler / Worker / Dashboard / Audit 共用

import { randomUUID } from 'node:crypto';

/** 触发来源 */
export type RunTrigger =
  | 'manual'
  | 'schedule'
  | 'pr'
  | 'release'
  | 'model-change'
  | 'config-change'
  | 'autonomous';

/** 运行状态（过程态，区别于 RegressionRunStatus 结果态） */
export type RunStatus = 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** 统一 Run Entity（任务书 24.3） */
export interface TestRun {
  runId: string;
  projectId: string;
  businessId?: string;
  feature?: string;
  environment: string;
  trigger: RunTrigger;
  status: RunStatus;
  progress: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** 创建 Run 输入 */
export interface CreateRunInput {
  runId?: string;
  projectId: string;
  businessId?: string;
  feature?: string;
  environment: string;
  trigger: RunTrigger;
}

/** Run 状态机：合法迁移表 */
export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/** 是否允许状态迁移 */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/** 迁移并校验；非法迁移抛错 */
export function transitionRun(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransition(from, to)) {
    throw new Error(`非法 Run 状态迁移：${from} → ${to}`);
  }
  return to;
}

/** 终态 */
export function isTerminal(status: RunStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

/** 生成 runId（统一口径，供 Scheduler / RunService 使用） */
export function generatePlatformRunId(prefix = 'run'): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 29.3：随机尾改 crypto.randomUUID（原 4 位 base36 在高并发 create 下会碰撞）
  return `${prefix}-${ts}-${randomUUID().replace(/-/g, '')}`;
}
