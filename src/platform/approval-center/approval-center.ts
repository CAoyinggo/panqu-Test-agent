// Approval Center（Phase 24.5）：审批工作流
// - request：创建审批（幂等：同一 idempotencyKey 只创建一份）
// - approve / reject：只允许对 PENDING 操作，已决的审批不可二次变更
// - 幂等：重复 approve / reject 返回既有结果，不重复执行

import type { Repository } from '../storage/repository.js';
import {
  type ApprovalRequest,
  type ApprovalRequestInput,
  type ApprovalStatus,
} from './approval-schema.js';

export interface ApprovalCenterOptions {
  now?: () => string;
}

export class ApprovalCenter {
  constructor(
    private readonly repo: Repository<ApprovalRequest>,
    private readonly opts: ApprovalCenterOptions = {},
  ) {}

  private nowIso(): string {
    return this.opts.now ? this.opts.now() : new Date().toISOString();
  }

  /** 创建审批请求（幂等） */
  async request(input: ApprovalRequestInput): Promise<{ approval: ApprovalRequest; created: boolean }> {
    if (input.idempotencyKey) {
      const existing = await this.repo.query({ idempotencyKey: input.idempotencyKey });
      if (existing.length > 0) return { approval: existing[0], created: false };
    }
    const approvalId = input.approvalId ?? `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const approval: ApprovalRequest = {
      id: approvalId,
      approvalId,
      runId: input.runId,
      action: input.action,
      riskLevel: input.riskLevel,
      environment: input.environment,
      requester: input.requester,
      reason: input.reason,
      evidence: input.evidence ?? [],
      status: 'PENDING',
      createdAt: this.nowIso(),
      idempotencyKey: input.idempotencyKey,
    };
    await this.repo.create(approval);
    return { approval, created: true };
  }

  async get(approvalId: string): Promise<ApprovalRequest | null> {
    return this.repo.get(approvalId);
  }

  async list(filter?: Partial<ApprovalRequest>): Promise<ApprovalRequest[]> {
    return this.repo.query(filter);
  }

  async pendingCount(): Promise<number> {
    const rows = await this.repo.query({ status: 'PENDING' });
    return rows.length;
  }

  /** 审批通过（幂等：已决返回既有结果） */
  async approve(approvalId: string, decidedBy: string): Promise<ApprovalRequest> {
    return this.decide(approvalId, 'APPROVED', decidedBy);
  }

  /** 驳回（幂等） */
  async reject(approvalId: string, decidedBy: string): Promise<ApprovalRequest> {
    return this.decide(approvalId, 'REJECTED', decidedBy);
  }

  private async decide(
    approvalId: string,
    status: Extract<ApprovalStatus, 'APPROVED' | 'REJECTED'>,
    decidedBy: string,
  ): Promise<ApprovalRequest> {
    const cur = await this.repo.get(approvalId);
    if (!cur) throw new Error(`审批不存在：${approvalId}`);
    // 幂等：已决审批返回既有结果，不重复执行
    if (cur.status !== 'PENDING') {
      return cur;
    }
    return this.repo.update(approvalId, {
      status,
      decidedBy,
      decidedAt: this.nowIso(),
    });
  }

  async clear(): Promise<void> {
    await this.repo.clear();
  }
}
