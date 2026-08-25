// 统一 Run Entity（Phase 24.3）：Scheduler / Worker / Dashboard / Audit 共用

import { randomUUID } from 'node:crypto';
import { CodedError, ErrorCode } from '../../core/errors.js';

/** 触发来源 */
export type RunTrigger =
  | 'manual'
  | 'schedule'
  | 'pr'
  | 'release'
  | 'model-change'
  | 'config-change'
  | 'autonomous';

/**
 * 运行状态（过程态，区别于测试结果态）。
 * COMPLETED 只表示完成契约已验证；测试断言失败由 executionRecord.outcome=FAILED 表达，
 * 平台/执行基础设施失败才使用 RunStatus=FAILED。
 */
export type RunStatus =
  | 'QUEUED'
  | 'PLANNING'
  | 'GATED'
  | 'RUNNING'
  | 'PAUSED'
  | 'EVIDENCE_READY'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'TIMEOUT'
  | 'CANCELLED';

export type RunExecutionMode = 'VERIFIED_AGENT' | 'NON_EXECUTING';
export type CompletionExecutionStatus =
  | 'PASSED'
  | 'FAILED'
  | 'NOT_EXECUTED'
  | 'BLOCKED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INCONCLUSIVE';

/** Platform 主链的可审计执行记录；未知业务结构原样保存，判定字段保持稳定。 */
export interface PlatformRunExecutionRecord {
  executionMode: 'VERIFIED_AGENT';
  requirementEvidence: {
    exists: boolean;
    requirementId?: string;
    value?: unknown;
  };
  policyGate: {
    status: 'ALLOW' | 'BLOCKED';
    value?: unknown;
  };
  execution: {
    executionId: string;
    started: boolean;
    finished: boolean;
    plan?: unknown;
  };
  evidence: Array<{
    evidenceId: string;
    runId: string;
    caseId: string;
    executed: boolean;
    processor?: string;
    processorInvoked: boolean;
    requestId?: string;
    executionStatus?: string;
    effectiveAssertions: number;
    assertionResults: Array<{ name: string; pass: boolean; kind?: string }>;
    timestamp: string;
  }>;
  outcome: {
    exists: boolean;
    outcomeId: string;
    executionStatus: CompletionExecutionStatus;
    executedCount: number;
    value?: unknown;
  };
  result: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED';
  recordedAt: string;
  /** 仅 RunService Completion Guard 成功后写 true，调用方不能预先声明。 */
  completionGuardPassed?: boolean;
}

/** 统一 Run Entity（任务书 24.3；Phase 39 扩展：固定计划/模板/资产版本以便复用与溯源） */
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
  /** Phase 39.2：来源 Test Plan（可选；Run Again / 溯源用） */
  planId?: string;
  /** Phase 39.2/39.1：来源 Suite 引用（可选） */
  suiteIds?: string[];
  /** Phase 39.3：来源 Run Template（可选；Run Template 复用计数用） */
  templateId?: string;
  /** Phase 39.3：运行模式（MANUAL / REGRESSION / AUTONOMOUS，可选） */
  mode?: string;
  /** Phase 39.3：预算（可选） */
  budget?: number;
  /** Phase 39.3：发布门禁开关（可选） */
  releaseGate?: boolean;
  /** Phase 39.4：固定资产版本（assetId → version；本次 Run 实际执行的版本） */
  assetVersion?: Record<string, number>;
  /** 所有执行型 Run 只有唯一模式；不存在兼容/测试旁路。 */
  executionMode: RunExecutionMode;
  /** Agent Pipeline 产出的唯一执行事实；没有它的 Run 不得进入 COMPLETED。 */
  executionRecord?: PlatformRunExecutionRecord;
}

/** 创建 Run 输入 */
export interface CreateRunInput {
  runId?: string;
  projectId: string;
  businessId?: string;
  feature?: string;
  environment: string;
  trigger: RunTrigger;
  planId?: string;
  suiteIds?: string[];
  templateId?: string;
  mode?: string;
  budget?: number;
  releaseGate?: boolean;
  assetVersion?: Record<string, number>;
  executionMode?: RunExecutionMode;
}

/** Run 状态机：合法迁移表 */
export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  QUEUED: ['PLANNING', 'BLOCKED', 'CANCELLED'],
  PLANNING: ['GATED', 'BLOCKED', 'FAILED', 'TIMEOUT', 'CANCELLED'],
  GATED: ['RUNNING', 'BLOCKED', 'FAILED', 'TIMEOUT', 'CANCELLED'],
  RUNNING: ['PAUSED', 'EVIDENCE_READY', 'BLOCKED', 'FAILED', 'TIMEOUT', 'CANCELLED'],
  PAUSED: ['PLANNING', 'CANCELLED'],
  EVIDENCE_READY: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  BLOCKED: [],
  TIMEOUT: [],
  CANCELLED: [],
};

/** 是否允许状态迁移 */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/** 迁移并校验；非法迁移抛错 */
export function transitionRun(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransition(from, to)) {
    throw new CodedError(ErrorCode.CONFLICT, `非法 Run 状态迁移：${from} → ${to}`);
  }
  return to;
}

/** 终态 */
export function isTerminal(status: RunStatus): boolean {
  return status === 'COMPLETED'
    || status === 'FAILED'
    || status === 'BLOCKED'
    || status === 'TIMEOUT'
    || status === 'CANCELLED';
}

/** 生成 runId（统一口径，供 Scheduler / RunService 使用） */
export function generatePlatformRunId(prefix = 'run'): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 29.3：随机尾改 crypto.randomUUID（原 4 位 base36 在高并发 create 下会碰撞）
  return `${prefix}-${ts}-${randomUUID().replace(/-/g, '')}`;
}
