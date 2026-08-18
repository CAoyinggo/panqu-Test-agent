// Platform Gate（Phase 24.5）：组合「RBAC → 环境策略 → Approval → Execute」完整链路
// - execute：评估访问；需审批时自动向 Approval Center 发起审批，等待审批通过后才能执行
// - approve / reject：审批人必须拥有对应动作的审批权限（HEALING_APPROVE / RELEASE_APPROVE）
// - 核心约束：ADMIN 不能绕过生产安全（环境策略 deny 无条件拒绝）

import type { ApprovalCenter } from '../approval-center/approval-center.js';
import type { ApprovalRequest } from '../approval-center/approval-schema.js';
import type { Environment } from '../projects/project-schema.js';
import { evaluateAccessChain, type AccessDecision, type AccessRequest } from './access-chain.js';
import { approvalPermissionFor, hasPermission, type Role } from './rbac.js';

/** 访问请求（带环境对象，供审批落库） */
export interface GateRequest extends AccessRequest {
  environment: Pick<Environment, 'id' | 'type' | 'safetyPolicy'>;
}

/** 门禁结果 */
export type GateOutcome =
  | { verdict: 'ALLOWED'; decision: AccessDecision }
  | { verdict: 'APPROVAL_REQUIRED'; decision: AccessDecision; approval: ApprovalRequest }
  | { verdict: 'DENIED'; decision: AccessDecision };

export class PlatformGate {
  constructor(private readonly approvals: ApprovalCenter) {}

  /**
   * 执行访问链路：
   * - RBAC / 环境策略拒绝 → DENIED
   * - 环境策略允许 → ALLOWED
   * - 环境策略要求审批 → 创建审批请求并返回 APPROVAL_REQUIRED
   *   调用方在审批通过后才能真正执行（Execute 阶段）。
   */
  async execute(req: GateRequest): Promise<GateOutcome> {
    const decision = evaluateAccessChain(req);
    if (decision.verdict === 'APPROVAL_REQUIRED') {
      const { approval } = await this.approvals.request({
        runId: req.runId ?? 'n/a',
        action: `${req.action}-${req.environment.type}`,
        riskLevel: req.action,
        environment: req.environment.id,
        requester: req.actor,
        reason: req.reason ?? decision.reason,
        evidence: req.evidence ?? [],
        idempotencyKey: req.runId ? `gate:${req.runId}:${req.action}:${req.environment.id}` : undefined,
      });
      return { verdict: 'APPROVAL_REQUIRED', decision, approval };
    }
    return { verdict: decision.verdict as 'ALLOWED' | 'DENIED', decision };
  }

  /** 审批通过：审批人必须具备该动作的审批权限 */
  async approve(approvalId: string, decidedBy: string, role: Role): Promise<ApprovalRequest> {
    const approval = await this.approvals.get(approvalId);
    if (!approval) throw new Error(`审批不存在：${approvalId}`);
    const perm = approvalPermissionFor(approval.action);
    if (!hasPermission(role, perm)) {
      throw new Error(`角色 ${role} 无权审批 ${approval.action}（需 ${perm}）`);
    }
    return this.approvals.approve(approvalId, decidedBy);
  }

  /** 驳回 */
  async reject(approvalId: string, decidedBy: string, role: Role): Promise<ApprovalRequest> {
    const approval = await this.approvals.get(approvalId);
    if (!approval) throw new Error(`审批不存在：${approvalId}`);
    const perm = approvalPermissionFor(approval.action);
    if (!hasPermission(role, perm)) {
      throw new Error(`角色 ${role} 无权审批 ${approval.action}（需 ${perm}）`);
    }
    return this.approvals.reject(approvalId, decidedBy);
  }
}
