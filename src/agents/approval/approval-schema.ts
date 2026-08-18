// Approval Schema：审批请求 / 结果数据模型（Phase 16 Human-in-the-loop）
// 风险操作：生产环境 / 真实扣费 / 真实积分 / 大并发 / 数据库修改 / 删除测试数据 /
// 测试代码自动修复 / 创建正式缺陷。支持 AUTO / REVIEW / MANUAL / DENY。
// 必须保留审批审计日志（ApprovalAuditLog）。

/** 审批决策等级 */
export type ApprovalDecision = 'AUTO' | 'REVIEW' | 'MANUAL' | 'DENY';

/** 审批结论 */
export type ApprovalVerdict = 'approved' | 'rejected' | 'pending';

/** 风险操作类型 */
export type RiskOperation =
  | 'create-defect'       // 创建正式缺陷
  | 'apply-healing'       // 应用自愈修复（测试代码）
  | 'run-high-risk'       // 高风险执行（大并发/生产）
  | 'real-billing'        // 真实扣费/积分
  | 'modify-db'           // 数据库修改
  | 'delete-data'         // 删除测试数据
  | 'run-production'      // 生产环境执行
  | 'send-notification';  // 对外通知（如飞书）

/** 审批请求 */
export interface ApprovalRequest {
  id: string;
  /** 风险操作类型 */
  operation: RiskOperation;
  /** 操作目标描述 */
  target: string;
  /** 环境 */
  environment: string;
  /** 严重程度 P0~P3 */
  severity: string;
  /** 策略判定结果 */
  decision: ApprovalDecision;
  /** 判定理由 */
  reason: string;
  /** 载荷（缺陷草稿 / 自愈建议 / 用例集等） */
  payload?: unknown;
  createdAt: string;
}

/** 审批结果 */
export interface ApprovalResult {
  requestId: string;
  verdict: ApprovalVerdict;
  decision: ApprovalDecision;
  message?: string;
  approver?: string;
  at: string;
}

/** 判断是否为合法决策等级 */
export function isApprovalDecision(v: unknown): v is ApprovalDecision {
  return v === 'AUTO' || v === 'REVIEW' || v === 'MANUAL' || v === 'DENY';
}

/** 判断是否为合法操作类型 */
export function isRiskOperation(v: unknown): v is RiskOperation {
  return [
    'create-defect', 'apply-healing', 'run-high-risk', 'real-billing',
    'modify-db', 'delete-data', 'run-production', 'send-notification',
  ].includes(String(v));
}

/** 归一化审批请求 */
export function normalizeApprovalRequest(data: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(data.id ?? `req-${Date.now().toString(36)}`),
    operation: isRiskOperation(data.operation) ? data.operation : 'run-high-risk',
    target: String(data.target ?? ''),
    environment: String(data.environment ?? 'test'),
    severity: String(data.severity ?? 'P2'),
    decision: isApprovalDecision(data.decision) ? data.decision : 'REVIEW',
    reason: String(data.reason ?? ''),
    payload: data.payload,
    createdAt: String(data.createdAt ?? new Date().toISOString()),
  };
}
