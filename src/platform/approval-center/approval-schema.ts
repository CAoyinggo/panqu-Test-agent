// Approval Schema（Phase 24.5）：审批请求实体
// Approval Center 持久化审批工作流；approve / reject 只允许对 PENDING 状态操作。

import type { Entity } from '../storage/repository.js';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** 审批请求（任务书 24.5 Approval Center） */
export interface ApprovalRequest extends Entity {
  approvalId: string;
  runId: string;
  /** 动作描述：如 risky-tool / dangerous-tool / release / healing / production-access */
  action: string;
  /** 风险等级：risky | dangerous */
  riskLevel: string;
  environment: string;
  /** 申请人 */
  requester: string;
  reason: string;
  evidence: unknown[];
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** 幂等键：同一键重复请求只创建一份 */
  idempotencyKey?: string;
}

/** 审批请求输入 */
export interface ApprovalRequestInput {
  approvalId?: string;
  runId: string;
  action: string;
  riskLevel: string;
  environment: string;
  requester: string;
  reason: string;
  evidence?: unknown[];
  idempotencyKey?: string;
}
