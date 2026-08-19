// Telemetry 存储（Phase 25.4）：基于 Repository<T> 的类型化存储
// 事件 / 成本账本 / RCA 真值 / Flaky / Healing / Release 全部落同一存储后端。

import type { Repository } from '../storage/repository.js';
import { generateId } from '../../core/id.js';
import type {
  CostLedgerEntry,
  FlakyRecord,
  HealingRecord,
  ReleaseRecord,
  RcaVerification,
  TelemetryEvent,
} from './telemetry-types.js';

export function newId(prefix: string): string {
  // 29.3：委托 core/id.ts（crypto.randomUUID，碰撞安全）
  return generateId(prefix);
}

/** 统一遥测事件存储 */
export class TelemetryEventStore {
  constructor(private readonly repo: Repository<TelemetryEvent>) {}

  async record(event: Omit<TelemetryEvent, 'id' | 'eventId' | 'timestamp'> & { id?: string; eventId?: string; timestamp?: string }): Promise<TelemetryEvent> {
    const id = event.id ?? newId('evt');
    const full: TelemetryEvent = {
      id,
      eventId: event.eventId ?? id,
      runId: event.runId,
      projectId: event.projectId,
      feature: event.feature,
      type: event.type,
      value: event.value,
      metadata: event.metadata,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    await this.repo.create(full);
    return full;
  }

  async byRun(runId: string): Promise<TelemetryEvent[]> {
    return this.repo.query({ runId });
  }

  async list(filter: Partial<TelemetryEvent> = {}): Promise<TelemetryEvent[]> {
    return this.repo.query(filter);
  }
}

/** LLM 成本账本 */
export class CostLedger {
  constructor(private readonly repo: Repository<CostLedgerEntry>) {}

  async record(entry: Omit<CostLedgerEntry, 'id' | 'totalTokens'> & { id?: string; totalTokens?: number }): Promise<CostLedgerEntry> {
    const full: CostLedgerEntry = {
      id: entry.id ?? newId('cost'),
      runId: entry.runId,
      projectId: entry.projectId,
      feature: entry.feature,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens ?? entry.inputTokens + entry.outputTokens,
      latencyMs: entry.latencyMs,
      requestCount: entry.requestCount,
      retryCount: entry.retryCount,
      cost: entry.cost,
      timestamp: entry.timestamp ?? new Date().toISOString(),
    };
    await this.repo.create(full);
    return full;
  }

  async list(filter: Partial<CostLedgerEntry> = {}): Promise<CostLedgerEntry[]> {
    return this.repo.query(filter);
  }
}

/** RCA 真值存储 */
export class RcaVerificationStore {
  constructor(private readonly repo: Repository<RcaVerification>) {}

  async record(v: Omit<RcaVerification, 'id'> & { id?: string }): Promise<RcaVerification> {
    const full: RcaVerification = { id: v.id ?? newId('rca-v'), ...v };
    await this.repo.create(full);
    return full;
  }

  async list(filter: Partial<RcaVerification> = {}): Promise<RcaVerification[]> {
    return this.repo.query(filter);
  }
}

/** Flaky 记录存储 */
export class FlakyRecordStore {
  constructor(private readonly repo: Repository<FlakyRecord>) {}

  async record(r: Omit<FlakyRecord, 'id'> & { id?: string }): Promise<FlakyRecord> {
    const full: FlakyRecord = { id: r.id ?? newId('flaky'), ...r };
    await this.repo.create(full);
    return full;
  }

  async list(filter: Partial<FlakyRecord> = {}): Promise<FlakyRecord[]> {
    return this.repo.query(filter);
  }
}

/** Healing 记录存储 */
export class HealingRecordStore {
  constructor(private readonly repo: Repository<HealingRecord>) {}

  async record(h: Omit<HealingRecord, 'id'> & { id?: string }): Promise<HealingRecord> {
    const full: HealingRecord = { id: h.id ?? newId('heal-t'), ...h };
    await this.repo.create(full);
    return full;
  }

  async list(filter: Partial<HealingRecord> = {}): Promise<HealingRecord[]> {
    return this.repo.query(filter);
  }
}

/** Release 决策存储 */
export class ReleaseRecordStore {
  constructor(private readonly repo: Repository<ReleaseRecord>) {}

  async record(r: Omit<ReleaseRecord, 'id'> & { id?: string }): Promise<ReleaseRecord> {
    const full: ReleaseRecord = { id: r.id ?? newId('rel'), ...r };
    await this.repo.create(full);
    return full;
  }

  async list(filter: Partial<ReleaseRecord> = {}): Promise<ReleaseRecord[]> {
    return this.repo.query(filter);
  }
}
