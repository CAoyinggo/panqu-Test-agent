// TelemetryService（Phase 25.4）：统一遥测服务
// 记录真实 LLM / 执行 / RCA / Flaky / Healing / Release / Cost 事件到持久化存储，
// 并从真实数据计算：Cost 汇总、RCA Accuracy（Ground Truth）、Flaky Rate、Healing Rate。
// 无数据时一律 tracked=false（禁止虚构 / 禁止用 0 表示无数据）。

import {
  CostLedger,
  FlakyRecordStore,
  HealingRecordStore,
  ReleaseRecordStore,
  RcaVerificationStore,
  TelemetryEventStore,
} from './telemetry-store.js';
import { InMemoryRepository } from '../storage/index.js';
import type {
  CostBreakdown,
  CostLedgerEntry,
  FlakyRecord,
  HealingRecord,
  MetricSample,
  ReleaseRecord,
  RcaVerification,
  TelemetryEvent,
  TelemetryEventType,
  TelemetryPeriod,
} from './telemetry-types.js';
import { periodStartMs } from './telemetry-types.js';
import { MetricActivationTracker, type MetricActivationRecord, type TrackedMetric } from './activation.js';
import type { FailureCategory } from '../../agents/analysis/root-cause-schema.js';

/** 模型单价（元 / 百万 token；可覆盖） */
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
}

export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'deepseek-chat': { inputPerM: 1.0, outputPerM: 2.0 },
  'deepseek-reasoner': { inputPerM: 4.0, outputPerM: 16.0 },
  'gpt-4o-mini': { inputPerM: 1.5, outputPerM: 6.0 },
  'gpt-4o': { inputPerM: 17.5, outputPerM: 70.0 },
  'qwen-plus': { inputPerM: 0.8, outputPerM: 2.0 },
};

export interface TelemetryServiceOptions {
  pricing?: Record<string, ModelPricing>;
  now?: () => string;
  /** 指标激活跟踪器（25.5）：缺省内存态；生产由工厂注入同后端持久化实例 */
  activation?: MetricActivationTracker;
}

export interface LlmUsageInput {
  runId: string;
  projectId?: string;
  feature?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  requestCount?: number;
  retryCount?: number;
}

export interface HealingMetrics {
  successRate: MetricSample;   // recovered / applied
  falseHealingRate: MetricSample; // rolledBack / applied
  recoveryRate: MetricSample;  // recovered / suggested
}

export class TelemetryService {
  readonly events: TelemetryEventStore;
  readonly costs: CostLedger;
  readonly rca: RcaVerificationStore;
  readonly flaky: FlakyRecordStore;
  readonly healing: HealingRecordStore;
  readonly releases: ReleaseRecordStore;
  /** 指标激活跟踪器（25.5） */
  readonly activation: MetricActivationTracker;

  private readonly pricing: Record<string, ModelPricing>;
  private readonly now: () => string;

  constructor(
    opts: TelemetryServiceOptions & {
      events?: TelemetryEventStore;
      costs?: CostLedger;
      rca?: RcaVerificationStore;
      flaky?: FlakyRecordStore;
      healing?: HealingRecordStore;
      releases?: ReleaseRecordStore;
    } = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.events = opts.events ?? new TelemetryEventStore(new InMemoryRepository('telemetry-event'));
    this.costs = opts.costs ?? new CostLedger(new InMemoryRepository('cost-ledger'));
    this.rca = opts.rca ?? new RcaVerificationStore(new InMemoryRepository('rca-verification'));
    this.flaky = opts.flaky ?? new FlakyRecordStore(new InMemoryRepository('flaky-record'));
    this.healing = opts.healing ?? new HealingRecordStore(new InMemoryRepository('healing-record'));
    this.releases = opts.releases ?? new ReleaseRecordStore(new InMemoryRepository('release-record'));
    this.activation = opts.activation ?? new MetricActivationTracker(new InMemoryRepository<MetricActivationRecord>('metric-activation'), this.now);
    this.pricing = { ...DEFAULT_PRICING, ...(opts.pricing ?? {}) };
  }

  /** 记录一个真实样本并自动激活对应指标（25.5） */
  private async markActivated(metric: TrackedMetric): Promise<void> {
    try {
      await this.activation.mark(metric);
    } catch (err) {
      // 激活跟踪失败不阻塞遥测主流程（仅告警）
      console.warn(`[telemetry] 指标激活标记失败 ${metric}：${(err as Error).message}`);
    }
  }

  private emit(event: Omit<TelemetryEvent, 'id' | 'eventId' | 'timestamp'>): Promise<TelemetryEvent> {
    return this.events.record({ ...event, timestamp: this.now() });
  }

  /** 模型单价（缺省走默认表） */
  priceFor(model: string): ModelPricing {
    return this.pricing[model] ?? this.pricing.default ?? { inputPerM: 1.0, outputPerM: 2.0 };
  }

  // ── LLM / Cost ──
  async recordLLM(usage: LlmUsageInput): Promise<CostLedgerEntry> {
    const p = this.priceFor(usage.model);
    const cost = Number(((usage.inputTokens / 1_000_000) * p.inputPerM + (usage.outputTokens / 1_000_000) * p.outputPerM).toFixed(6));
    const entry = await this.costs.record({
      runId: usage.runId,
      projectId: usage.projectId,
      feature: usage.feature,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs: usage.latencyMs,
      requestCount: usage.requestCount ?? 1,
      retryCount: usage.retryCount ?? 0,
      cost,
      timestamp: this.now(),
    });
    await this.emit({
      runId: usage.runId, projectId: usage.projectId, feature: usage.feature,
      type: 'cost', value: cost,
      metadata: { model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: usage.latencyMs },
    });
    await this.emit({
      runId: usage.runId, projectId: usage.projectId, feature: usage.feature,
      type: 'llm', value: usage.latencyMs,
      metadata: { model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    });
    await this.markActivated('cost');
    return entry;
  }

  // ── Execution ──
  async recordExecution(input: { runId: string; projectId?: string; feature?: string; phase: string; result: 'success' | 'failed' | 'skipped' | 'canceled'; durationMs?: number }): Promise<TelemetryEvent> {
    const event = await this.emit({
      runId: input.runId, projectId: input.projectId, feature: input.feature,
      type: 'execution', value: input.durationMs,
      metadata: { phase: input.phase, result: input.result },
    });
    await this.markActivated('execution');
    return event;
  }

  // ── RCA（预测 + Ground Truth 验证） ──
  async recordRca(input: { runId: string; projectId?: string; feature?: string; rcaId: string; caseId: string; predictedCategory: FailureCategory; confidence?: number }): Promise<TelemetryEvent> {
    return this.emit({
      runId: input.runId, projectId: input.projectId, feature: input.feature,
      type: 'rca', value: input.confidence,
      metadata: { rcaId: input.rcaId, caseId: input.caseId, predictedCategory: input.predictedCategory },
    });
  }

  async verifyRca(input: { runId: string; rcaId: string; predictedCategory: FailureCategory; actualCategory: FailureCategory; verifiedBy?: string; verifiedAt?: string }): Promise<RcaVerification> {
    const correct = input.predictedCategory === input.actualCategory;
    const v = await this.rca.record({
      rcaId: input.rcaId,
      runId: input.runId,
      predictedCategory: input.predictedCategory,
      actualCategory: input.actualCategory,
      correct,
      verifiedBy: input.verifiedBy ?? 'human',
      verifiedAt: input.verifiedAt ?? this.now(),
    });
    await this.emit({
      runId: input.runId, type: 'rca.verify',
      value: correct ? 1 : 0,
      metadata: { rcaId: input.rcaId, predictedCategory: input.predictedCategory, actualCategory: input.actualCategory },
    });
    await this.markActivated('rcaAccuracy');
    return v;
  }

  // ── Flaky ──
  async recordFlaky(r: Omit<FlakyRecord, 'id' | 'timestamp'> & { timestamp?: string }): Promise<FlakyRecord> {
    const record = await this.flaky.record({ ...r, timestamp: r.timestamp ?? this.now() });
    await this.emit({
      runId: r.runId, type: 'flaky', value: r.pass ? 1 : 0,
      metadata: { caseId: r.caseId, retry: r.retry, environment: r.environment, durationMs: r.durationMs },
    });
    await this.markActivated('flakyRate');
    return record;
  }

  // ── Healing ──
  async recordHealing(h: Omit<HealingRecord, 'id' | 'timestamp'> & { timestamp?: string }): Promise<HealingRecord> {
    const record = await this.healing.record({ ...h, timestamp: h.timestamp ?? this.now() });
    await this.emit({
      runId: h.runId, type: 'healing', value: h.recovered ? 1 : 0,
      metadata: { healingId: h.healingId, caseId: h.caseId, approved: h.approved, applied: h.applied, rolledBack: h.rolledBack },
    });
    await this.markActivated('healingRate');
    return record;
  }

  // ── Release ──
  async recordRelease(r: Omit<ReleaseRecord, 'id' | 'timestamp'> & { timestamp?: string }): Promise<ReleaseRecord> {
    const record = await this.releases.record({ ...r, timestamp: r.timestamp ?? this.now() });
    await this.emit({
      runId: r.runId, type: 'release', value: r.result === 'success' ? 1 : 0,
      metadata: { decision: r.decision, result: r.result, reason: r.reason },
    });
    return record;
  }

  // ── 查询：时间窗口过滤 ──
  private inPeriod<T extends { timestamp: string }>(records: T[], period: TelemetryPeriod, nowMs: number): T[] {
    if (period === 'release' || period === 'version') return records;
    const start = periodStartMs(period, nowMs);
    return records.filter((r) => Date.parse(r.timestamp) >= start);
  }

  async eventsByRun(runId: string): Promise<TelemetryEvent[]> {
    return this.events.byRun(runId);
  }

  // ── Cost 汇总：Cost / Run / Feature / Model / Project ──
  async costMetrics(period: TelemetryPeriod = '7d'): Promise<CostBreakdown> {
    const nowMs = Date.parse(this.now());
    const entries = this.inPeriod(await this.costs.list({}), period, nowMs);
    const total = entries.reduce((s, e) => s + e.cost, 0);
    const totalTokens = entries.reduce((s, e) => s + e.totalTokens, 0);
    const requests = entries.reduce((s, e) => s + e.requestCount, 0);
    const runIds = new Set(entries.map((e) => e.runId));
    const featureIds = new Set(entries.map((e) => e.feature).filter(Boolean));
    const projectIds = new Set(entries.map((e) => e.projectId).filter(Boolean));
    const perModel = new Map<string, { cost: number; tokens: number; requests: number }>();
    for (const e of entries) {
      const m = perModel.get(e.model) ?? { cost: 0, tokens: 0, requests: 0 };
      m.cost += e.cost;
      m.tokens += e.totalTokens;
      m.requests += e.requestCount;
      perModel.set(e.model, m);
    }
    const tracked = entries.length > 0;
    const totalSample: MetricSample = { value: tracked ? Number(total.toFixed(4)) : null, tracked, sampleCount: entries.length, unit: 'CNY' };
    const perRun: MetricSample = {
      value: tracked && runIds.size > 0 ? Number((total / runIds.size).toFixed(4)) : null,
      tracked, sampleCount: runIds.size, unit: 'CNY',
    };
    const perFeature: MetricSample = {
      value: tracked && featureIds.size > 0 ? Number((total / featureIds.size).toFixed(4)) : null,
      tracked, sampleCount: featureIds.size, unit: 'CNY',
    };
    const perProject: MetricSample = {
      value: tracked && projectIds.size > 0 ? Number((total / projectIds.size).toFixed(4)) : null,
      tracked, sampleCount: projectIds.size, unit: 'CNY',
    };
    return {
      total: totalSample,
      perRun,
      perFeature,
      perModel: [...perModel.entries()].map(([model, v]) => ({ model, cost: Number(v.cost.toFixed(4)), tokens: v.tokens, requests: v.requests })).sort((a, b) => b.cost - a.cost),
      perProject,
    };
  }

  /** 回归成本：针对指定 feature（回归验证）的成本 */
  async costForFeature(feature: string, period: TelemetryPeriod = '7d'): Promise<MetricSample> {
    const nowMs = Date.parse(this.now());
    const entries = this.inPeriod(await this.costs.list({ feature }), period, nowMs);
    const total = entries.reduce((s, e) => s + e.cost, 0);
    const tracked = entries.length > 0;
    return { value: tracked ? Number(total.toFixed(4)) : null, tracked, sampleCount: entries.length, unit: 'CNY' };
  }

  // ── RCA Accuracy：仅在有真实验证数据时 tracked=true ──
  async rcaAccuracy(period: TelemetryPeriod = '7d'): Promise<MetricSample> {
    const nowMs = Date.parse(this.now());
    // RcaVerification 用 verifiedAt 作为时间戳（字段名为 verifiedAt 而非 timestamp）
    const allVerified = (await this.rca.list({})).filter((v) => v.correct !== undefined);
    const verified = (period === 'release' || period === 'version')
      ? allVerified
      : allVerified.filter((v) => Date.parse(v.verifiedAt) >= periodStartMs(period, nowMs));
    if (verified.length === 0) return { value: null, tracked: false, sampleCount: 0, unit: '%' };
    const correct = verified.filter((v) => v.correct === true).length;
    return { value: Number(((correct / verified.length) * 100).toFixed(1)), tracked: true, sampleCount: verified.length, unit: '%' };
  }

  // ── Flaky Rate：真实运行记录 → 用例级通过/失败波动 ──
  async flakyRate(period: TelemetryPeriod = '7d'): Promise<MetricSample> {
    const nowMs = Date.parse(this.now());
    const records = this.inPeriod(await this.flaky.list({}), period, nowMs);
    if (records.length === 0) return { value: null, tracked: false, sampleCount: 0, unit: '%' };
    const byCase = new Map<string, { pass: number; fail: number }>();
    for (const r of records) {
      const c = byCase.get(r.caseId) ?? { pass: 0, fail: 0 };
      if (r.pass) c.pass += 1;
      else c.fail += 1;
      byCase.set(r.caseId, c);
    }
    // flaky = 同一 case 既有通过又有失败（波动）
    let flaky = 0;
    for (const c of byCase.values()) {
      if (c.pass > 0 && c.fail > 0) flaky += 1;
    }
    const total = byCase.size;
    return { value: Number(((flaky / total) * 100).toFixed(1)), tracked: true, sampleCount: total, unit: '%' };
  }

  // ── Healing：仅在 approved+applied 后统计真实成功率 ──
  async healingMetrics(period: TelemetryPeriod = '7d'): Promise<HealingMetrics> {
    const nowMs = Date.parse(this.now());
    const records = this.inPeriod(await this.healing.list({}), period, nowMs);
    const applied = records.filter((r) => r.applied);
    const recovered = applied.filter((r) => r.recovered).length;
    const rolledBack = applied.filter((r) => r.rolledBack).length;
    const suggested = records.filter((r) => r.suggested).length;
    const unit = '%';
    return {
      successRate: applied.length > 0
        ? { value: Number(((recovered / applied.length) * 100).toFixed(1)), tracked: true, sampleCount: applied.length, unit }
        : { value: null, tracked: false, sampleCount: 0, unit },
      falseHealingRate: applied.length > 0
        ? { value: Number(((rolledBack / applied.length) * 100).toFixed(1)), tracked: true, sampleCount: applied.length, unit }
        : { value: null, tracked: false, sampleCount: 0, unit },
      recoveryRate: suggested > 0
        ? { value: Number(((recovered / suggested) * 100).toFixed(1)), tracked: true, sampleCount: suggested, unit }
        : { value: null, tracked: false, sampleCount: 0, unit },
    };
  }

  /** 指标汇总（Dashboard 使用）：成本 / RCA / Flaky / Healing */
  async metricsSnapshot(period: TelemetryPeriod = '7d'): Promise<{
    cost: CostBreakdown;
    rcaAccuracy: MetricSample;
    flakyRate: MetricSample;
    healing: HealingMetrics;
  }> {
    const [cost, rcaAccuracy, flakyRate, healing] = await Promise.all([
      this.costMetrics(period),
      this.rcaAccuracy(period),
      this.flakyRate(period),
      this.healingMetrics(period),
    ]);
    return { cost, rcaAccuracy, flakyRate, healing };
  }

  /** 指标激活状态（25.5）：全部平台指标的激活情况 + 已激活计数 */
  async activationStatus(): Promise<{
    records: MetricActivationRecord[];
    activeCount: number;
  }> {
    const records = await this.activation.list();
    return { records, activeCount: records.filter((r) => r.activated).length };
  }
}
