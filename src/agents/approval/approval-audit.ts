// Approval Audit：审批审计日志（Phase 16）
// 记录每一次审批请求与结论（决策 / 结论 / 操作者 / 时间），支持持久化回调。
// 审计日志是「审批后不可抵赖」的基础，不能被 Agent 修改。
import { ApprovalDecision, ApprovalVerdict, ApprovalRequest } from './approval-schema.js';

/** 审计条目 */
export interface AuditEntry {
  id: string;
  requestId: string;
  at: string;
  /** 策略判定等级 */
  decision: ApprovalDecision;
  /** 最终结论 */
  verdict: ApprovalVerdict;
  /** 操作者（system 表示自动，user 表示人工） */
  actor: string;
  /** 风险操作 */
  operation: string;
  /** 环境 */
  environment: string;
  /** 严重程度 */
  severity: string;
  message?: string;
}

/** 审计持久化回调 */
export type AuditStore = (entry: AuditEntry) => Promise<void> | void;

/** 审批审计日志（内存 + 可选持久化） */
export class ApprovalAuditLog {
  private entries: AuditEntry[] = [];

  constructor(private store?: AuditStore) {}

  /** 记录一条审计（AUTO 决策 actor=system，REVIEW/MANUAL actor=user） */
  record(req: ApprovalRequest, verdict: ApprovalVerdict, actor: string, message?: string): AuditEntry {
    const entry: AuditEntry = {
      id: `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      requestId: req.id,
      at: new Date().toISOString(),
      decision: req.decision,
      verdict,
      actor,
      operation: req.operation,
      environment: req.environment,
      severity: req.severity,
      message,
    };
    this.entries.push(entry);
    if (this.store) {
      try {
        this.store(entry);
      } catch {
        // 持久化失败不阻断审批（审计尽力而为，内存仍保留）
      }
    }
    return entry;
  }

  /** 全部审计条目（按时间正序） */
  list(): AuditEntry[] {
    return [...this.entries];
  }

  /** 按请求查询 */
  byRequest(requestId: string): AuditEntry[] {
    return this.entries.filter((e) => e.requestId === requestId);
  }

  /** 条目数 */
  count(): number {
    return this.entries.length;
  }

  /** 清空（测试用） */
  clear(): void {
    this.entries = [];
  }
}
