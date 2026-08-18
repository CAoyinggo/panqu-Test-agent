// TestJob（Phase 24.3）：调度队列单元
// 要求：同一 Run 不重复执行；同一 Job 不被多个 Worker 同时消费；支持 priority / retry / timeout / cancel / pause / resume。

import type { Entity } from '../storage/repository.js';

/** Job 状态 */
export type JobStatus = 'QUEUED' | 'RUNNING' | 'RETRY' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

/** 调度 Job（任务书 24.3） */
export interface TestJob extends Entity {
  jobId: string;
  runId: string;
  /** 优先级：数值越小越先执行 */
  priority: number;
  projectId: string;
  environment: string;
  payload: unknown;
  /** 约定：payload 内可携带 requiredCapability（如 'gpu' | 'api' | 'secure' | 'general'） */
  requiredCapability?: string;
  retryCount: number;
  maxRetries: number;
  status: JobStatus;
  /** 幂等键：同一键重复入队只保留一份 */
  idempotencyKey?: string;
  timeoutMs?: number;
  claimedBy?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** 入队输入 */
export interface EnqueueJobInput {
  jobId?: string;
  runId: string;
  priority?: number;
  projectId: string;
  environment: string;
  payload?: unknown;
  requiredCapability?: string;
  maxRetries?: number;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export function isJobTerminal(status: JobStatus): boolean {
  return status === 'SUCCESS' || status === 'FAILED' || status === 'CANCELLED';
}
