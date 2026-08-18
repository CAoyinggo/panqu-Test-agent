// Approval Policy：确定性分级审批策略（Phase 16）
// Deterministic First：审批等级由规则引擎判定（环境 × 严重度 × 操作类型），
// 不支持任何 AI 猜测。规则示例：
//   P0 + Production → MANUAL
//   P1 + Test → REVIEW
//   P2/P3 + Test → AUTO
//   生产 + 真实扣费/删数据/改库 → DENY
import { ApprovalDecision, RiskOperation } from './approval-schema.js';

/** 风险上下文（用于分级判定） */
export interface RiskContext {
  environment: string;
  /** 严重程度 P0~P3 */
  severity?: string;
  /** 操作类型（可选，覆盖 operation 判定） */
  operation?: RiskOperation;
  /** 是否真实扣费/积分 */
  realBilling?: boolean;
  /** 是否真实支付 */
  payment?: boolean;
  /** 是否删除测试数据/生产数据 */
  deleteData?: boolean;
  /** 是否修改数据库 */
  dbModify?: boolean;
  /** 是否大并发 */
  concurrent?: boolean;
  /** 是否生产环境（显式覆盖 environment 判定） */
  production?: boolean;
}

/** 判定结果 */
export interface ApprovalEvaluation {
  decision: ApprovalDecision;
  reason: string;
}

function isProd(ctx: RiskContext): boolean {
  const env = (ctx.environment ?? '').toLowerCase();
  return ctx.production === true || env === 'prod' || env === 'production' || env === 'preonline';
}

/** 确定性分级：环境 × 严重度 × 操作类型 */
export function evaluateApproval(ctx: RiskContext): ApprovalEvaluation {
  const severity = (ctx.severity ?? 'P3').toUpperCase();

  // 生产环境禁止类操作 → DENY
  if (isProd(ctx)) {
    if (ctx.realBilling || ctx.payment) {
      return { decision: 'DENY', reason: '生产环境禁止真实扣费/真实支付' };
    }
    if (ctx.deleteData) {
      return { decision: 'DENY', reason: '生产环境禁止删除数据' };
    }
    if (ctx.dbModify) {
      return { decision: 'DENY', reason: '生产环境禁止直接修改数据库' };
    }
    if (ctx.operation === 'real-billing') {
      return { decision: 'DENY', reason: '真实扣费操作默认拒绝' };
    }
    if (severity === 'P0') {
      return { decision: 'MANUAL', reason: 'P0 + 生产环境 → 必须人工审批' };
    }
    if (ctx.concurrent) {
      return { decision: 'MANUAL', reason: '生产环境 + 大并发 → 必须人工审批' };
    }
    if (ctx.operation === 'run-production') {
      return { decision: 'MANUAL', reason: '生产环境执行 → 必须人工审批' };
    }
    return { decision: 'REVIEW', reason: '生产环境操作 → 需要人工复核' };
  }

  // 非生产环境（test / preonline 之外视为测试）
  if (severity === 'P0') {
    return { decision: 'REVIEW', reason: 'P0 + 测试环境 → 需要复核' };
  }
  if (severity === 'P1') {
    return { decision: 'REVIEW', reason: 'P1 + 测试环境 → 需要复核' };
  }
  // 创建正式缺陷 / 应用自愈修复属变更类操作，即使 P2/P3 也需要复核（不自动改码）
  if (ctx.operation === 'create-defect') {
    return { decision: 'REVIEW', reason: '创建正式缺陷 → 需人工确认' };
  }
  if (ctx.operation === 'apply-healing') {
    return { decision: 'REVIEW', reason: '应用自愈修复 → 需人工确认' };
  }
  if (ctx.deleteData || ctx.dbModify || ctx.realBilling) {
    return { decision: 'REVIEW', reason: '数据/计费类操作 → 需人工确认' };
  }
  if (ctx.concurrent) {
    return { decision: 'REVIEW', reason: '大并发执行 → 需人工复核' };
  }
  return { decision: 'AUTO', reason: 'P2/P3 + 测试环境 → 自动放行' };
}

/** 由审批请求构造风险上下文 */
export function riskContextFromRequest(
  environment: string,
  severity: string,
  operation?: RiskOperation,
  extra: Partial<RiskContext> = {},
): RiskContext {
  return { environment, severity, operation, ...extra };
}
