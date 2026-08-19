// Defect 管理（Phase 40.2）：平台缺陷实体 + CRUD + 状态机
// 关联 Run / TestCase；事件（DefectCreated）与审计（audit 'defect'）由 PlatformService 负责。
// 持久化复用平台 Repository<T>（同存储后端，纳入备份/恢复/迁移/审计体系）。

import type { Entity, Repository } from '../storage/repository.js';
import { generateEntityId } from '../storage/repository.js';

/** 缺陷严重度 */
export type DefectSeverity = 'critical' | 'high' | 'medium' | 'low';

/** 缺陷状态 */
export type DefectStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | 'WONT_FIX';

export const DEFECT_SEVERITIES: readonly DefectSeverity[] = ['critical', 'high', 'medium', 'low'];
export const DEFECT_STATUSES: readonly DefectStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'WONT_FIX'];

export function isDefectSeverity(v: unknown): v is DefectSeverity {
  return typeof v === 'string' && (DEFECT_SEVERITIES as readonly string[]).includes(v);
}

export function isDefectStatus(v: unknown): v is DefectStatus {
  return typeof v === 'string' && (DEFECT_STATUSES as readonly string[]).includes(v);
}

/** 缺陷实体 */
export interface Defect extends Entity {
  id: string;
  /** 人类可读 ID（与 id 同值；Web / 事件 / 审计统一引用） */
  defectId: string;
  projectId: string;
  environment?: string;
  /** 关联 Run（触发缺陷的测试运行） */
  runId?: string;
  /** 关联 TestCase */
  caseId?: string;
  title: string;
  severity: DefectSeverity;
  status: DefectStatus;
  description?: string;
  evidence?: unknown[];
  assignee?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  /** 解决说明（RESOLVED / WONT_FIX / CLOSED） */
  resolution?: string;
}

/** 创建缺陷输入 */
export interface CreateDefectInput {
  projectId: string;
  title: string;
  severity?: DefectSeverity;
  environment?: string;
  runId?: string;
  caseId?: string;
  description?: string;
  evidence?: unknown[];
  createdBy: string;
  now?: () => string;
}

/** 状态机：允许的迁移（可再打开 / 可回退至 IN_PROGRESS 重新处理） */
const STATUS_TRANSITIONS: Record<DefectStatus, readonly DefectStatus[]> = {
  OPEN: ['IN_PROGRESS', 'RESOLVED', 'WONT_FIX', 'CLOSED'],
  IN_PROGRESS: ['RESOLVED', 'WONT_FIX', 'CLOSED', 'OPEN'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS', 'OPEN'],
  CLOSED: ['OPEN'],
  WONT_FIX: ['OPEN', 'CLOSED'],
};

export class DefectService {
  constructor(private readonly repo: Repository<Defect>) {}

  async create(input: CreateDefectInput): Promise<Defect> {
    const now = input.now ? input.now() : new Date().toISOString();
    const id = generateEntityId('defect');
    const defect: Defect = {
      id,
      defectId: id,
      projectId: input.projectId,
      environment: input.environment,
      runId: input.runId,
      caseId: input.caseId,
      title: input.title,
      severity: input.severity ?? 'medium',
      status: 'OPEN',
      description: input.description,
      evidence: input.evidence,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.create(defect);
    return defect;
  }

  async get(id: string): Promise<Defect | null> {
    return this.repo.get(id);
  }

  async list(filter?: Partial<Defect>): Promise<Defect[]> {
    return this.repo.query(filter ?? {});
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  /** 状态迁移（按状态机校验） */
  async updateStatus(id: string, status: DefectStatus, resolution?: string, now?: () => string): Promise<Defect> {
    const cur = await this.repo.get(id);
    if (!cur) throw new Error(`缺陷不存在：${id}`);
    const allowed = STATUS_TRANSITIONS[cur.status] ?? [];
    if (!allowed.includes(status)) {
      throw new Error(`缺陷状态非法迁移：${cur.status} → ${status}`);
    }
    const ts = now ? now() : new Date().toISOString();
    const closed = status === 'RESOLVED' || status === 'WONT_FIX' || status === 'CLOSED';
    const next: Defect = {
      ...cur,
      status,
      resolution: closed ? (resolution ?? cur.resolution) : undefined,
      resolvedAt: status === 'RESOLVED' || status === 'CLOSED' ? ts : undefined,
      updatedAt: ts,
    };
    await this.repo.update(id, next);
    return next;
  }

  /** 指派处理人 */
  async assign(id: string, assignee: string, now?: () => string): Promise<Defect> {
    const cur = await this.repo.get(id);
    if (!cur) throw new Error(`缺陷不存在：${id}`);
    const next: Defect = { ...cur, assignee, updatedAt: now ? now() : new Date().toISOString() };
    await this.repo.update(id, next);
    return next;
  }

  /** 更新基础信息（title / severity / description / environment） */
  async update(id: string, input: { title?: string; severity?: DefectSeverity; description?: string; environment?: string; caseId?: string }, now?: () => string): Promise<Defect> {
    const cur = await this.repo.get(id);
    if (!cur) throw new Error(`缺陷不存在：${id}`);
    const next: Defect = {
      ...cur,
      title: input.title ?? cur.title,
      severity: input.severity ?? cur.severity,
      description: input.description === undefined ? cur.description : input.description,
      environment: input.environment === undefined ? cur.environment : input.environment,
      caseId: input.caseId === undefined ? cur.caseId : input.caseId,
      updatedAt: now ? now() : new Date().toISOString(),
    };
    await this.repo.update(id, next);
    return next;
  }
}
