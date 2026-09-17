/**
 * Panqu AI DevTest - 自进化测试内核核心数据契约
 * 
 * 严格基于运行时事实与业务不变量定义，禁止虚构与硬编码假象。
 */

/**
 * 复合业务实体状态（运行时事实）
 */
export interface EntityCompositeState {
  session: {
    status: 'ANONYMOUS' | 'AUTHENTICATED' | 'EXPIRED';
    userId?: string | number;
    cookiePresent?: boolean;
  };
  task: {
    status: 'UNSUBMITTED' | 'SUBMITTED' | 'DISPATCHED' | 'GENERATING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    taskId?: string | number;
    durationSeconds?: number;
    modelId?: number;
    promptText?: string;
  };
  billing: {
    status: 'UNBILLED' | 'RESERVED' | 'CHARGED' | 'REFUNDED' | 'INCONSISTENT';
    netPointsDeducted: number;
    recordCount: number;
    lastLogType?: number;
  };
  artifacts: {
    status: 'NONE' | 'MISSING' | 'INVALID' | 'PARTIAL' | 'VERIFIED';
    atomsFound: string[];
    ownershipVerified: boolean;
    mediaUrl?: string;
  };
  observedAt: number;
  rawAttributes?: Record<string, any>;
}

/**
 * 提取复合状态的标准化唯一指纹 Key
 */
export function getCompositeStateKey(state: EntityCompositeState): string {
  return [
    `session:${state.session.status}`,
    `task:${state.task.status}`,
    `billing:${state.billing.status}`,
    `artifacts:${state.artifacts.status}`,
  ].join('|');
}

/**
 * 动作类型定义
 */
export type PanquActionType =
  | 'AUTHENTICATE'
  | 'SUBMIT_TASK'
  | 'POLL_STATUS'
  | 'INJECT_TIMEOUT'
  | 'CANCEL_TASK'
  | 'RETRY_TASK'
  | 'AUDIT_BILLING'
  | 'INSPECT_MEDIA';

/**
 * 动作执行能力状态标定
 */
export type ActionExecutionSupport =
  | 'REAL_EXECUTABLE'
  | 'REAL_SETUP'
  | 'CODEBASE_UNSUPPORTED'
  | 'UNVERIFIED_UNSUPPORTED';

/**
 * 变异候选执行就绪度
 */
export type MutationExecutionReadiness =
  | 'EXECUTABLE'
  | 'NEGATIVE_PROBE'
  | 'STRUCTURAL_ONLY'
  | 'BLOCKED_BY_UNSUPPORTED_ACTION';

/**
 * 动作空间规范
 */
export interface PanquActionDefinition {
  type: PanquActionType;
  name: string;
  description: string;
  riskCategory: 'CRITICAL_FINANCIAL' | 'MEDIA_INTEGRITY' | 'ASYNC_CONSISTENCY' | 'READ_ONLY';
  baseRisk: number; // 0.0 ~ 1.0
  preconditions: Array<(state: EntityCompositeState) => boolean>;
  payloadGenerator?: (state: EntityCompositeState) => Record<string, any>;
  executionSupport?: ActionExecutionSupport;
}

/**
 * 状态跃迁事实记录
 */
export interface StateTransitionRecord {
  id: string;
  fromKey: string;
  fromState: EntityCompositeState;
  actionType: PanquActionType;
  actionPayload: Record<string, any>;
  toKey: string;
  toState: EntityCompositeState;
  historyCount: number;
  lastObserved: number;
  invariantsChecked: string[];
  anomaliesDetected: string[];
}

/**
 * 客观执行证据（独立于测试框架，以真实业务事实为凭证）
 */
export interface ExecutionEvidence {
  evidenceId: string;
  timestamp: number;
  httpStatus?: number;
  apiResponse?: any;
  taskSnapshot?: {
    taskId: string | number;
    status: string;
    progress?: number;
    rawPayload?: any;
  };
  billingEvidence?: {
    recordCount: number;
    netPoints: number;
    doubleBillingDetected: boolean;
    refundIdempotencyPassed: boolean;
    records: Array<{ task_id?: number; score: number; type: number }>;
  };
  mediaEvidence?: {
    checked: boolean;
    format: 'mp4' | 'png' | 'other';
    atomsFound: string[];
    ihdrValid?: boolean;
    ownershipVerified: boolean;
  };
  exitCode: number;
  errorTrace?: string;
  coverageDelta?: {
    uncoveredLines: number[];
    branchesHit: string[];
  };
}

/**
 * 最终裁决与故障诊断
 */
export interface VerificationVerdict {
  verdict: 'PASS' | 'FAIL' | 'UNVERIFIED';
  diagnosis?: 'TEST_DEFECT' | 'PRODUCT_BUG' | 'ENVIRONMENT_FAILURE' | 'INTENT_CONFLICT';
  failedInvariants: string[];
  evidenceSummary: string[];
  candidateScenarioId?: string;
}

/**
 * 因果经验（用于自进化策略调整，严禁篡改 Oracle 真值）
 */
export interface LearningExperience {
  experienceId: string;
  discoveredTransitionId: string;
  discoveredAnomaly: string;
  causalChain: string[];
  policyDirectives: {
    boostMultiplier: number;
    mandatoryInvariants: string[];
    priorityStatesToExplore: string[];
  };
  confidence: number;
  createdAt: number;
}
