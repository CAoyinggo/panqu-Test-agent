// Audit Log（Phase 24.8）：高风险操作审计
// 记录：actor / role / action / resource / environment / result / timestamp / approvalId / traceId。
// 敏感信息经 redactSensitive 脱敏后落库。

import type { Entity, Repository } from '../storage/repository.js';
import { redactSensitive } from '../../core/redact.js';

/** 审计动作（任务书 14 至少清单） */
export type AuditAction =
  | 'run.start'
  | 'run.cancel'
  | 'run.pause'
  | 'run.resume'
  | 'run.retry'
  | 'production.access'
  | 'dangerous.tool'
  | 'risky.tool'
  | 'approval'
  | 'release'
  | 'healing'
  | 'defect'
  | 'configuration'
  | 'run.create'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.refresh';

/** 审计记录 */
export interface AuditEntry extends Entity {
  entryId: string;
  timestamp: string;
  actor: string;
  role: string;
  action: AuditAction;
  resource: string;
  environment?: string;
  result: 'success' | 'denied' | 'error' | 'pending';
  approvalId?: string;
  traceId?: string;
  detail?: unknown;
}

export interface AuditLogOptions {
  now?: () => string;
}

/** 审计日志（追加写，支持按条件检索） */
export class AuditLog {
  constructor(
    private readonly repo: Repository<AuditEntry>,
    private readonly opts: AuditLogOptions = {},
  ) {}

  private nowIso(): string {
    return this.opts.now ? this.opts.now() : new Date().toISOString();
  }

  async record(input: Omit<AuditEntry, 'id' | 'entryId' | 'timestamp'>): Promise<AuditEntry> {
    const entryId = `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const entry: AuditEntry = {
      id: entryId,
      entryId,
      timestamp: this.nowIso(),
      actor: input.actor,
      role: input.role,
      action: input.action,
      resource: input.resource,
      environment: input.environment,
      result: input.result,
      approvalId: input.approvalId,
      traceId: input.traceId,
      detail: input.detail === undefined ? undefined : redactSensitive(input.detail),
    };
    await this.repo.create(entry);
    return entry;
  }

  async list(filter?: Partial<AuditEntry>): Promise<AuditEntry[]> {
    return this.repo.query(filter);
  }

  /** 按 runId / traceId / actor / approvalId 关联检索（Scenario 8 还原链路） */
  async search(opts: { actor?: string; runId?: string; traceId?: string; approvalId?: string }): Promise<AuditEntry[]> {
    let rows = await this.repo.query({});
    if (opts.actor) rows = rows.filter((r) => r.actor === opts.actor);
    if (opts.runId) rows = rows.filter((r) => r.resource === opts.runId || (r.detail as Record<string, unknown>)?.['runId'] === opts.runId);
    if (opts.traceId) rows = rows.filter((r) => r.traceId === opts.traceId);
    if (opts.approvalId) rows = rows.filter((r) => r.approvalId === opts.approvalId);
    return rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async count(): Promise<number> {
    return (await this.repo.query({})).length;
  }

  async clear(): Promise<void> {
    await this.repo.clear();
  }
}
