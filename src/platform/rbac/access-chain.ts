// Access Chain（Phase 24.5）：User → RBAC → Tool Permission → Environment Policy → Approval → Execute
// 核心安全约束：任何角色（含 ADMIN）都不能绕过 RBAC 或环境安全策略。
// - 环境策略 deny → 无条件拒绝（即使 ADMIN + PRODUCTION_ACCESS）
// - 环境策略 approval → 必须走 Approval Center，审批通过后才能执行

import { hasPermission, type Permission, type Role } from './rbac.js';
import {
  resolveEnvironmentDecision,
  type PolicyDecision,
  type ToolActionLevel,
} from '../projects/environment-policy.js';
import type { Environment } from '../projects/project-schema.js';

/** 访问判定结果 */
export type AccessVerdict = 'ALLOWED' | 'APPROVAL_REQUIRED' | 'DENIED';

/** 访问请求（一次受控执行） */
export interface AccessRequest {
  /** 操作者 */
  actor: string;
  /** 操作者角色（RBAC 第一道闸） */
  role: Role;
  /** 该动作需要的基础权限（RBAC 第二道闸） */
  permission: Permission;
  /** 工具动作分级（对应 Tool Permission） */
  action: ToolActionLevel;
  /** 目标环境（环境策略第三道闸，ADMIN 不可绕过） */
  environment: Pick<Environment, 'id' | 'type' | 'safetyPolicy'>;
  runId?: string;
  reason?: string;
  evidence?: unknown[];
}

/** 访问决策 */
export interface AccessDecision {
  verdict: AccessVerdict;
  reason: string;
  /** 是否要求审批 */
  requiresApproval: boolean;
  /** 环境策略原始决策 */
  policy: PolicyDecision;
  /** RBAC 权限是否通过 */
  rbacPassed: boolean;
}

/**
 * 评估访问链路：RBAC → 环境策略。
 * 返回 APPROVAL_REQUIRED 时，调用方必须向 Approval Center 发起审批，
 * 审批通过后才允许真正执行（PlatformGate 负责组合）。
 */
export function evaluateAccessChain(req: AccessRequest): AccessDecision {
  // 1) RBAC：角色必须具备该权限（ADMIN 有全部权限，但仅此一道还不够）
  if (!hasPermission(req.role, req.permission)) {
    return {
      verdict: 'DENIED',
      reason: `角色 ${req.role} 缺少权限 ${req.permission}`,
      requiresApproval: false,
      policy: 'deny',
      rbacPassed: false,
    };
  }
  // 2) 环境安全策略（不能被 ADMIN 绕过）
  const policy = resolveEnvironmentDecision(req.environment, req.action);
  switch (policy) {
    case 'allow':
      return {
        verdict: 'ALLOWED',
        reason: `${req.action}@${req.environment.type} 允许（RBAC 通过 + 环境策略允许）`,
        requiresApproval: false,
        policy,
        rbacPassed: true,
      };
    case 'approval':
      return {
        verdict: 'APPROVAL_REQUIRED',
        reason: `${req.action}@${req.environment.type} 需审批（RBAC 通过 + 环境策略要求审批）`,
        requiresApproval: true,
        policy,
        rbacPassed: true,
      };
    case 'deny':
      return {
        verdict: 'DENIED',
        reason: `${req.action}@${req.environment.type} 拒绝（生产安全：ADMIN 亦不可绕过）`,
        requiresApproval: false,
        policy,
        rbacPassed: true,
      };
  }
}
