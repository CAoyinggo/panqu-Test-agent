// Phase 52：成本治理、资源优化与容量自适应。
// 所有计算保持确定性；生产策略变更必须先经人工审批。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDir } from '../utils/fs-utils.js';
import { checkAutonomousBudget, type AutonomousBudgetUsage } from '../autonomous/autonomous-budget.js';
import { DEFAULT_AUTONOMOUS_BUDGET, type AutonomousBudget } from '../autonomous/autonomous-schema.js';

export type AttributionCategory = 'LLM' | 'COMPUTE' | 'STORAGE' | 'NETWORK' | 'WORKER' | 'OTHER';
export type CostWindow = 'today' | '7d' | '30d' | 'release' | 'version';
export const ATTRIBUTION_CATEGORIES: readonly AttributionCategory[] = ['LLM', 'COMPUTE', 'STORAGE', 'NETWORK', 'WORKER', 'OTHER'];

export interface CostAttribution {
  id: string;
  projectId: string;
  runId?: string;
  evaluationId?: string;
  benchmarkId?: string;
  releaseId?: string;
  version?: string;
  category: AttributionCategory;
  provider?: string;
  model?: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  currency: string;
  timestamp: string;
}

export interface CostAttributionInput extends Omit<CostAttribution, 'id' | 'totalCost' | 'timestamp'> {
  id?: string;
  totalCost?: number;
  timestamp?: string;
}

export interface CostFilter {
  projectId?: string;
  runId?: string;
  evaluationId?: string;
  benchmarkId?: string;
  model?: string;
  provider?: string;
  releaseId?: string;
  version?: string;
  window?: CostWindow;
  now?: string;
}

export interface CostSummary {
  totalCost: number;
  currency: string;
  recordCount: number;
  byProject: Record<string, number>;
  byRun: Record<string, number>;
  byEvaluation: Record<string, number>;
  byBenchmark: Record<string, number>;
  byModel: Record<string, number>;
  byProvider: Record<string, number>;
  byCategory: Record<string, number>;
  costPerRun: number | null;
  costPerEvaluation: number | null;
  costPerBenchmark: number | null;
  costPerProject: number | null;
}

export class CostAttributionLedger {
  private readonly records = new Map<string, CostAttribution>();
  private baseCurrency?: string;

  record(input: CostAttributionInput): CostAttribution {
    if (!input.projectId?.trim()) throw new Error('projectId 不能为空');
    if (!ATTRIBUTION_CATEGORIES.includes(input.category)) throw new Error(`Cost category 无效：${String(input.category)}`);
    if (!input.currency?.trim()) throw new Error('currency 不能为空');
    if (input.timestamp && Number.isNaN(Date.parse(input.timestamp))) throw new Error('timestamp 必须是合法 ISO 时间');
    for (const [key, value] of Object.entries({ quantity: input.quantity, unitCost: input.unitCost })) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${key} 必须是非负有限数字`);
    }
    const calculated = round6(input.quantity * input.unitCost);
    const totalCost = input.totalCost === undefined ? calculated : round6(input.totalCost);
    if (!Number.isFinite(totalCost) || totalCost < 0) throw new Error('totalCost 必须是非负有限数字');
    if (Math.abs(totalCost - calculated) > 0.000001) throw new Error('totalCost 必须等于 quantity × unitCost');
    const record: CostAttribution = {
      ...input,
      id: input.id ?? `attr-${randomUUID()}`,
      projectId: input.projectId.trim(),
      totalCost,
      currency: input.currency || 'CNY',
      timestamp: input.timestamp ?? new Date().toISOString(),
    };
    if (this.baseCurrency && this.baseCurrency !== record.currency) throw new Error(`Cost ledger 币种不一致：${record.currency} != ${this.baseCurrency}；需先在采集层换算`);
    const existing = this.records.get(record.id);
    if (existing) {
      if (existing.projectId !== record.projectId || existing.totalCost !== record.totalCost) throw new Error(`Cost attribution id 冲突：${record.id}`);
      return clone(existing);
    }
    this.records.set(record.id, record);
    this.baseCurrency ??= record.currency;
    return clone(record);
  }

  list(filter: CostFilter = {}): CostAttribution[] {
    const start = windowStart(filter.window, filter.now);
    return [...this.records.values()].filter((r) => {
      if (start !== null && Date.parse(r.timestamp) < start) return false;
      for (const key of ['projectId', 'runId', 'evaluationId', 'benchmarkId', 'model', 'provider', 'releaseId', 'version'] as const) {
        if (filter[key] && r[key] !== filter[key]) return false;
      }
      return true;
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)).map(clone);
  }

  summarize(filter: CostFilter = {}): CostSummary {
    const records = this.list(filter);
    const grouped = (key: keyof CostAttribution): Record<string, number> => groupCost(records, key);
    const byProject = grouped('projectId');
    const byRun = grouped('runId');
    const byEvaluation = grouped('evaluationId');
    const byBenchmark = grouped('benchmarkId');
    const totalCost = round6(records.reduce((sum, r) => sum + r.totalCost, 0));
    return {
      totalCost,
      currency: records[0]?.currency ?? this.baseCurrency ?? 'CNY',
      recordCount: records.length,
      byProject,
      byRun,
      byEvaluation,
      byBenchmark,
      byModel: grouped('model'),
      byProvider: grouped('provider'),
      byCategory: grouped('category'),
      costPerRun: average(totalCost, Object.keys(byRun).length),
      costPerEvaluation: average(totalCost, Object.keys(byEvaluation).length),
      costPerBenchmark: average(totalCost, Object.keys(byBenchmark).length),
      costPerProject: average(totalCost, Object.keys(byProject).length),
    };
  }

  trend(filter: CostFilter = {}, grain: 'daily' | 'weekly' | 'monthly' = 'daily'): Array<{ period: string; cost: number }> {
    const grouped = new Map<string, number>();
    for (const record of this.list(filter)) {
      const date = new Date(record.timestamp);
      let period = record.timestamp.slice(0, 10);
      if (grain === 'monthly') period = record.timestamp.slice(0, 7);
      if (grain === 'weekly') {
        const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7)));
        period = monday.toISOString().slice(0, 10);
      }
      grouped.set(period, round6((grouped.get(period) ?? 0) + record.totalCost));
    }
    return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([period, cost]) => ({ period, cost }));
  }

  snapshot(): CostAttribution[] { return this.list(); }
  static restore(records: CostAttribution[]): CostAttributionLedger {
    const ledger = new CostAttributionLedger();
    for (const record of records) { ledger.records.set(record.id, clone(record)); ledger.baseCurrency ??= record.currency; }
    return ledger;
  }
}

export type BudgetStatus = 'NORMAL' | 'WARNING' | 'EXCEEDED';
export interface CostBudget {
  id: string;
  projectId?: string;
  daily?: number;
  weekly?: number;
  monthly?: number;
  perRun?: number;
  perEvaluation?: number;
  perRelease?: number;
  warningThreshold?: number;
  createdAt: string;
  updatedAt: string;
}
export type CostBudgetInput = Omit<CostBudget, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
export interface BudgetEvaluation {
  budgetId: string;
  status: BudgetStatus;
  limitType: keyof Pick<CostBudget, 'daily' | 'weekly' | 'monthly' | 'perRun' | 'perEvaluation' | 'perRelease'>;
  budget: number;
  used: number;
  remaining: number;
  ratio: number;
}
export interface BudgetGuardResult {
  allowed: boolean;
  decision: 'CONTINUE' | 'AUTONOMOUS_STOP';
  reason: string;
  budget: number;
  used: number;
  remaining: number;
  trace: string[];
  autonomousExceeded?: keyof AutonomousBudget;
}

export class CostBudgetRegistry {
  private readonly budgets = new Map<string, CostBudget>();
  list(projectId?: string): CostBudget[] { return [...this.budgets.values()].filter((b) => !projectId || b.projectId === projectId).map(clone); }
  get(id: string): CostBudget | undefined { const value = this.budgets.get(id); return value ? clone(value) : undefined; }
  set(input: CostBudgetInput, now = new Date().toISOString()): CostBudget {
    validateBudget(input);
    const id = input.id ?? `budget-${randomUUID()}`;
    const previous = this.budgets.get(id);
    const value: CostBudget = { ...previous, ...input, id, warningThreshold: input.warningThreshold ?? previous?.warningThreshold ?? 0.9, createdAt: previous?.createdAt ?? now, updatedAt: now };
    this.budgets.set(id, value);
    return clone(value);
  }
  patch(id: string, patch: Partial<CostBudgetInput>, now = new Date().toISOString()): CostBudget {
    const previous = this.budgets.get(id);
    if (!previous) throw new Error(`预算不存在：${id}`);
    return this.set({ ...previous, ...patch, id }, now);
  }
  evaluate(id: string, ledger: CostAttributionLedger, context: { now?: string; runId?: string; evaluationId?: string; releaseId?: string } = {}): BudgetEvaluation[] {
    const budget = this.budgets.get(id);
    if (!budget) throw new Error(`预算不存在：${id}`);
    const evaluations: BudgetEvaluation[] = [];
    const add = (limitType: BudgetEvaluation['limitType'], used: number): void => {
      const limit = budget[limitType];
      if (limit === undefined) return;
      const ratio = limit === 0 ? (used > 0 ? Infinity : 0) : used / limit;
      evaluations.push({ budgetId: id, status: ratio >= 1 ? 'EXCEEDED' : ratio >= (budget.warningThreshold ?? 0.9) ? 'WARNING' : 'NORMAL', limitType, budget: limit, used: round6(used), remaining: round6(Math.max(0, limit - used)), ratio: round6(ratio) });
    };
    const base = { projectId: budget.projectId, now: context.now };
    add('daily', ledger.summarize({ ...base, window: 'today' }).totalCost);
    add('weekly', ledger.summarize({ ...base, window: '7d' }).totalCost);
    add('monthly', ledger.summarize({ ...base, window: '30d' }).totalCost);
    if (context.runId) add('perRun', ledger.summarize({ ...base, runId: context.runId }).totalCost);
    if (context.evaluationId) add('perEvaluation', ledger.summarize({ ...base, evaluationId: context.evaluationId }).totalCost);
    if (context.releaseId) add('perRelease', ledger.summarize({ ...base, releaseId: context.releaseId }).totalCost);
    return evaluations;
  }
  snapshot(): CostBudget[] { return this.list(); }
  static restore(values: CostBudget[]): CostBudgetRegistry { const registry = new CostBudgetRegistry(); for (const value of values) registry.budgets.set(value.id, clone(value)); return registry; }
}

export function guardBudget(input: { evaluation: BudgetEvaluation; projectedCost?: number; autonomousUsage?: AutonomousBudgetUsage; autonomousLimits?: Partial<AutonomousBudget> }): BudgetGuardResult {
  const projected = round6(input.evaluation.used + (input.projectedCost ?? 0));
  const remaining = round6(Math.max(0, input.evaluation.budget - projected));
  const trace = [`budget=${input.evaluation.budget}`, `used=${input.evaluation.used}`, `projected=${input.projectedCost ?? 0}`, `remaining=${remaining}`];
  let autonomousExceeded: keyof AutonomousBudget | undefined;
  if (input.autonomousUsage) {
    const autonomous = checkAutonomousBudget(input.autonomousUsage, { ...DEFAULT_AUTONOMOUS_BUDGET, ...(input.autonomousLimits ?? {}) });
    autonomousExceeded = autonomous.exceeded;
    trace.push(`autonomous=${autonomous.ok ? 'NORMAL' : autonomous.exceeded}`);
  }
  const exceeded = projected >= input.evaluation.budget || !!autonomousExceeded;
  return {
    allowed: !exceeded,
    decision: exceeded ? 'AUTONOMOUS_STOP' : 'CONTINUE',
    reason: autonomousExceeded ? `自治预算超限：${autonomousExceeded}` : exceeded ? `${input.evaluation.limitType} 成本预算已耗尽` : '预算充足',
    budget: input.evaluation.budget,
    used: projected,
    remaining,
    trace,
    ...(autonomousExceeded ? { autonomousExceeded } : {}),
  };
}

export interface CostSelectionCandidate {
  id: string;
  risk: number;
  change?: number;
  history?: number;
  coverage?: number;
  criticality?: number;
  cost: number;
  flaky?: number;
  latencyMs?: number;
}
export interface CostSelectionResult { selected: CostSelectionCandidate[]; totalCost: number; trace: Array<{ id: string; expectedValue: number; score: number; selected: boolean; reason: string }>; }

export function selectByValueCost(candidates: CostSelectionCandidate[], maxCost: number): CostSelectionResult {
  if (!Number.isFinite(maxCost) || maxCost < 0) throw new Error('maxCost 必须为非负有限数字');
  const scored = candidates.map((candidate) => {
    const expectedValue = round6(candidate.risk * 0.3 + (candidate.change ?? 0) * 0.15 + (candidate.history ?? 0) * 0.1 + (candidate.coverage ?? 0) * 0.2 + (candidate.criticality ?? 0) * 0.2 - (candidate.flaky ?? 0) * 0.05);
    const latencyPenalty = 1 + Math.max(0, candidate.latencyMs ?? 0) / 100_000;
    return { candidate, expectedValue, score: round6(expectedValue / Math.max(candidate.cost, 0.000001) / latencyPenalty) };
  }).sort((a, b) => b.score - a.score || b.expectedValue - a.expectedValue || a.candidate.id.localeCompare(b.candidate.id));
  const selected: CostSelectionCandidate[] = [];
  let totalCost = 0;
  const trace = scored.map(({ candidate, expectedValue, score }) => {
    const fits = round6(totalCost + candidate.cost) <= maxCost;
    if (fits) { selected.push(candidate); totalCost = round6(totalCost + candidate.cost); }
    return { id: candidate.id, expectedValue, score, selected: fits, reason: fits ? `value/cost=${score}` : `maxCost=${maxCost} 剩余不足` };
  });
  return { selected, totalCost, trace };
}

function validateBudget(input: CostBudgetInput | Partial<CostBudgetInput>): void {
  for (const key of ['daily', 'weekly', 'monthly', 'perRun', 'perEvaluation', 'perRelease'] as const) {
    const value = input[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`${key} 必须为非负有限数字`);
  }
  if (input.warningThreshold !== undefined && (input.warningThreshold <= 0 || input.warningThreshold >= 1)) throw new Error('warningThreshold 必须在 0 和 1 之间');
}

function groupCost(records: CostAttribution[], key: keyof CostAttribution): Record<string, number> {
  const result: Record<string, number> = {};
  for (const record of records) {
    const value = record[key];
    if (typeof value !== 'string' || !value) continue;
    result[value] = round6((result[value] ?? 0) + record.totalCost);
  }
  return result;
}

function windowStart(window: CostWindow | undefined, nowString: string | undefined): number | null {
  if (!window || window === 'release' || window === 'version') return null;
  const now = nowString ? Date.parse(nowString) : Date.now();
  if (window === 'today') { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  return now - (window === '7d' ? 7 : 30) * 86_400_000;
}
function average(total: number, count: number): number | null { return count ? round6(total / count) : null; }
function round6(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
function clone<T>(value: T): T { return structuredClone(value); }

export interface CostGovernanceSnapshot {
  version: 1;
  attributions: CostAttribution[];
  budgets: CostBudget[];
  policies: ModelPolicy[];
  optimizations: OptimizationRecommendation[];
  audits: CostAuditEvent[];
  scaling: ScalingState;
  anomalies?: CostAnomaly[];
}

export interface CostAuditEvent { id: string; projectId?: string; actor: string; action: string; target: string; trace: string[]; timestamp: string; }

export type ModelComplexity = 'SIMPLE' | 'STANDARD' | 'COMPLEX' | 'CRITICAL';
export interface ModelPolicy { id: string; projectId?: string; domain: string; primaryModel: string; fallbackModel?: string; maxCost?: number; maxLatencyMs?: number; environment: 'SHADOW' | 'PRODUCTION'; status: 'DRAFT' | 'ACTIVE' | 'ROLLED_BACK'; updatedAt: string; }
export interface ModelCandidate { model: string; quality: number; cost: number; latencyMs: number; failureRate?: number; }
export interface ModelRoutingDecision { policyId?: string; selectedModel: string; fallbackModel?: string; complexity: ModelComplexity; score: number; trace: string[]; }

export class ModelPolicyRegistry {
  private readonly policies = new Map<string, ModelPolicy>();
  list(projectId?: string): ModelPolicy[] { return [...this.policies.values()].filter((p) => !projectId || p.projectId === projectId).map(clone); }
  get(id: string): ModelPolicy | undefined { const value = this.policies.get(id); return value ? clone(value) : undefined; }
  set(input: Omit<ModelPolicy, 'id' | 'updatedAt'> & { id?: string }, now = new Date().toISOString()): ModelPolicy {
    if (!input.domain || !input.primaryModel) throw new Error('domain 和 primaryModel 不能为空');
    const id = input.id ?? `policy-${randomUUID()}`;
    const value: ModelPolicy = { ...input, id, updatedAt: now };
    this.policies.set(id, value);
    return clone(value);
  }
  patch(id: string, patch: Partial<Omit<ModelPolicy, 'id'>>, now = new Date().toISOString()): ModelPolicy {
    const previous = this.policies.get(id); if (!previous) throw new Error(`模型策略不存在：${id}`);
    return this.set({ ...previous, ...patch, id }, now);
  }
  route(input: { domain: string; complexity: ModelComplexity; candidates: ModelCandidate[]; projectId?: string }): ModelRoutingDecision {
    const policy = [...this.policies.values()].find((p) => p.status === 'ACTIVE' && p.domain === input.domain && (!p.projectId || p.projectId === input.projectId));
    const eligible = input.candidates.filter((c) => (policy?.maxCost === undefined || c.cost <= policy.maxCost) && (policy?.maxLatencyMs === undefined || c.latencyMs <= policy.maxLatencyMs));
    if (!eligible.length && policy) return { policyId: policy.id, selectedModel: policy.fallbackModel ?? policy.primaryModel, fallbackModel: policy.fallbackModel, complexity: input.complexity, score: 0, trace: ['没有候选满足上限', `fallback=${policy.fallbackModel ?? policy.primaryModel}`] };
    const qualityWeight = input.complexity === 'SIMPLE' ? 0.35 : input.complexity === 'STANDARD' ? 0.5 : input.complexity === 'COMPLEX' ? 0.7 : 0.8;
    const scored = eligible.map((c) => ({ candidate: c, score: round6(c.quality * qualityWeight - c.cost * (1 - qualityWeight) * 10 - (c.latencyMs / 1000) * 0.05 - (c.failureRate ?? 0) * 20) })).sort((a, b) => b.score - a.score || a.candidate.model.localeCompare(b.candidate.model));
    const preferred = scored.find((v) => v.candidate.model === policy?.primaryModel);
    const chosen = preferred && (input.complexity === 'CRITICAL' || preferred.score >= (scored[0]?.score ?? 0) * 0.95) ? preferred : scored[0];
    if (!chosen) throw new Error('没有可用模型候选');
    return { policyId: policy?.id, selectedModel: chosen.candidate.model, fallbackModel: policy?.fallbackModel, complexity: input.complexity, score: chosen.score, trace: [`complexity=${input.complexity}`, `qualityWeight=${qualityWeight}`, `quality=${chosen.candidate.quality}`, `cost=${chosen.candidate.cost}`, `latencyMs=${chosen.candidate.latencyMs}`, `score=${chosen.score}`] };
  }
  snapshot(): ModelPolicy[] { return this.list(); }
  static restore(values: ModelPolicy[]): ModelPolicyRegistry { const registry = new ModelPolicyRegistry(); for (const value of values) registry.policies.set(value.id, clone(value)); return registry; }
}

export interface WorkerCapacity { maxConcurrentJobs: number; cpuLimit?: number; memoryLimitMb?: number; }
export interface WorkerResource { id: string; capacity: WorkerCapacity; cpuUsed: number; memoryUsedMb: number; activeJobs: number; }
export interface ScalingInput { queueLength: number; oldestQueueAgeMs: number; utilization: number; priority: number; estimatedCost: number; currentWorkers: number; now?: number; }
export interface ScalingPolicy { minWorkers: number; maxWorkers: number; jobsPerWorker: number; scaleUpQueueAgeMs: number; cooldownMs: number; maxEstimatedCost?: number; }
export interface ScalingDecision { action: 'UP' | 'DOWN' | 'HOLD'; desiredWorkers: number; currentWorkers: number; reason: string; trace: string[]; }
export interface ScalingState { currentWorkers: number; lastScaledAt?: number; events: Array<ScalingDecision & { at: string; actor: string }>; }

export function canAssignWorker(worker: WorkerResource): boolean {
  return worker.activeJobs < worker.capacity.maxConcurrentJobs && worker.cpuUsed <= (worker.capacity.cpuLimit ?? 100) && worker.memoryUsedMb <= (worker.capacity.memoryLimitMb ?? Infinity);
}
export function adaptiveScale(input: ScalingInput, policy: ScalingPolicy, lastScaledAt?: number): ScalingDecision {
  const now = input.now ?? Date.now();
  const base = Math.ceil(input.queueLength / Math.max(1, policy.jobsPerWorker));
  const ageBoost = input.oldestQueueAgeMs >= policy.scaleUpQueueAgeMs ? 1 : 0;
  const priorityBoost = input.priority >= 0.8 ? 1 : 0;
  const utilizationBoost = input.utilization >= 0.85 && input.queueLength > 0 ? 1 : 0;
  const costLimited = policy.maxEstimatedCost !== undefined && input.estimatedCost > policy.maxEstimatedCost;
  let desired = costLimited ? input.currentWorkers : Math.min(policy.maxWorkers, Math.max(policy.minWorkers, base + ageBoost + priorityBoost + utilizationBoost));
  if (input.queueLength === 0) desired = policy.minWorkers;
  const cooling = lastScaledAt !== undefined && now - lastScaledAt < policy.cooldownMs;
  if (cooling && desired !== input.currentWorkers) desired = input.currentWorkers;
  const action = desired > input.currentWorkers ? 'UP' : desired < input.currentWorkers ? 'DOWN' : 'HOLD';
  const reason = costLimited ? '预计成本超过伸缩上限' : cooling ? 'cooldown 防抖中' : input.queueLength === 0 ? '队列为空，缩容至安全下限' : `${input.queueLength} 个排队任务需要 ${desired} 个 worker`;
  return { action, desiredWorkers: desired, currentWorkers: input.currentWorkers, reason, trace: [`queueLength=${input.queueLength}`, `queueAgeMs=${input.oldestQueueAgeMs}`, `utilization=${input.utilization}`, `priority=${input.priority}`, `estimatedCost=${input.estimatedCost}`, `min=${policy.minWorkers}`, `max=${policy.maxWorkers}`, `cooldown=${cooling}`] };
}

export type ForecastHorizon = '1h' | '6h' | '24h' | '7d' | '30d';
export interface CapacitySample { timestamp: string; runs: number; cost: number; queuePeak: number; workersPeak: number; }
export interface CapacityForecast { horizon: ForecastHorizon; expectedRuns: number; expectedCost: number; expectedQueue: number; expectedWorkerCount: number; method: 'HISTORICAL_AVERAGE_TREND_PEAK'; trace: string[]; }
export function forecastCapacity(samples: CapacitySample[], horizon: ForecastHorizon, jobsPerWorker = 20): CapacityForecast {
  if (!samples.length) return { horizon, expectedRuns: 0, expectedCost: 0, expectedQueue: 0, expectedWorkerCount: 1, method: 'HISTORICAL_AVERAGE_TREND_PEAK', trace: ['无历史样本，使用安全下限'] };
  const hours = { '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 }[horizon];
  const ordered = [...samples].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const averageRuns = ordered.reduce((s, v) => s + v.runs, 0) / ordered.length;
  const averageCost = ordered.reduce((s, v) => s + v.cost, 0) / ordered.length;
  const trendRuns = ordered.length > 1 ? (ordered.at(-1)!.runs - ordered[0].runs) / (ordered.length - 1) : 0;
  const trendCost = ordered.length > 1 ? (ordered.at(-1)!.cost - ordered[0].cost) / (ordered.length - 1) : 0;
  const expectedRuns = round6(Math.max(0, (averageRuns + trendRuns * Math.min(hours, 24) / 2) * hours));
  const expectedCost = round6(Math.max(0, (averageCost + trendCost * Math.min(hours, 24) / 2) * hours));
  const expectedQueue = Math.max(Math.max(...ordered.map((v) => v.queuePeak)), Math.ceil(expectedRuns / Math.max(1, hours)));
  return { horizon, expectedRuns, expectedCost, expectedQueue, expectedWorkerCount: Math.max(1, Math.ceil(expectedQueue / Math.max(1, jobsPerWorker))), method: 'HISTORICAL_AVERAGE_TREND_PEAK', trace: [`averageRuns=${round6(averageRuns)}`, `trendRuns=${round6(trendRuns)}`, `peakQueue=${Math.max(...ordered.map((v) => v.queuePeak))}`] };
}

export interface CostAnomaly { id: string; projectId?: string; type: 'COST_ANOMALY'; current: number; baseline: number; ratio: number; severity: 'WARNING' | 'CRITICAL'; message: string; channels: ['DASHBOARD', 'AUDIT', 'FEISHU']; timestamp: string; }
export function detectCostAnomaly(values: number[], current: number, projectId?: string, now = new Date().toISOString(), warningRatio = 2, criticalRatio = 4): CostAnomaly | null {
  if (!values.length) return null;
  const baseline = round6(values.reduce((s, v) => s + v, 0) / values.length);
  const ratio = baseline === 0 ? (current > 0 ? Infinity : 1) : round6(current / baseline);
  if (ratio < warningRatio) return null;
  return { id: `anomaly-${randomUUID()}`, projectId, type: 'COST_ANOMALY', current, baseline, ratio, severity: ratio >= criticalRatio ? 'CRITICAL' : 'WARNING', message: `当前成本 ${current} 是历史平均 ${baseline} 的 ${ratio} 倍`, channels: ['DASHBOARD', 'AUDIT', 'FEISHU'], timestamp: now };
}

export interface CostQualityPoint { id: string; quality: number; cost: number; latencyMs: number; tokenUsage?: number; }
export interface CostRegression { decision: 'PASS' | 'REVIEW' | 'BLOCK'; costChange: number; qualityChange: number; latencyChange: number; tokenChange: number | null; reasons: string[]; }
export function compareCostRegression(baseline: CostQualityPoint, current: CostQualityPoint): CostRegression {
  const change = (from: number, to: number): number => from === 0 ? (to === 0 ? 0 : Infinity) : round6((to - from) / from);
  const costChange = change(baseline.cost, current.cost), qualityChange = current.quality - baseline.quality, latencyChange = change(baseline.latencyMs, current.latencyMs);
  const tokenChange = baseline.tokenUsage === undefined || current.tokenUsage === undefined ? null : change(baseline.tokenUsage, current.tokenUsage);
  const severe = costChange >= 1 || latencyChange >= 1 || (current.quality < baseline.quality - 5);
  const review = costChange >= 0.5 && qualityChange <= 0;
  return { decision: severe ? 'BLOCK' : review ? 'REVIEW' : 'PASS', costChange, qualityChange: round6(qualityChange), latencyChange, tokenChange, reasons: severe ? ['成本、延迟或质量发生严重回归'] : review ? ['成本上升至少 50% 且质量无提升'] : ['成本/质量在接受范围'] };
}
export function paretoFrontier(points: CostQualityPoint[]): CostQualityPoint[] {
  return points.filter((point) => !points.some((other) => other.id !== point.id && other.cost <= point.cost && other.quality >= point.quality && (other.cost < point.cost || other.quality > point.quality))).sort((a, b) => a.cost - b.cost || b.quality - a.quality);
}
export function compareShadowRouting(baseline: CostQualityPoint, candidate: CostQualityPoint): { releaseImpact: false; costChange: number; qualityChange: number; latencyChange: number; decision: CostRegression['decision']; trace: string[] } {
  const regression = compareCostRegression(baseline, candidate);
  return { releaseImpact: false, costChange: regression.costChange, qualityChange: regression.qualityChange, latencyChange: regression.latencyChange, decision: regression.decision, trace: [`baseline=${baseline.id}`, `candidate=${candidate.id}`, ...regression.reasons] };
}

export type OptimizationStatus = 'RECOMMENDED' | 'APPROVED' | 'REJECTED' | 'ACTIVE' | 'STOPPED' | 'ROLLED_BACK';
export interface OptimizationRecommendation { id: string; projectId: string; type: 'MODEL_SWITCH' | 'BUDGET' | 'WORKER' | 'COST_POLICY'; title: string; current: string; proposed: string; expectedCostChange: number; expectedQualityChange: number; status: OptimizationStatus; approvedBy?: string; canaryPercent: 0 | 5 | 20 | 50 | 100; trace: string[]; createdAt: string; updatedAt: string; }

export class CostGovernanceService {
  ledger: CostAttributionLedger;
  budgets: CostBudgetRegistry;
  policies: ModelPolicyRegistry;
  private readonly recommendations = new Map<string, OptimizationRecommendation>();
  private readonly audits: CostAuditEvent[] = [];
  private scalingState: ScalingState = { currentWorkers: 1, events: [] };
  readonly anomalies: CostAnomaly[] = [];
  constructor(state?: Partial<CostGovernanceSnapshot>) {
    this.ledger = CostAttributionLedger.restore(state?.attributions ?? []);
    this.budgets = CostBudgetRegistry.restore(state?.budgets ?? []);
    this.policies = ModelPolicyRegistry.restore(state?.policies ?? []);
    for (const recommendation of state?.optimizations ?? []) this.recommendations.set(recommendation.id, clone(recommendation));
    this.audits.push(...(state?.audits ?? []).map(clone));
    this.scalingState = clone(state?.scaling ?? this.scalingState);
    this.anomalies.push(...(state?.anomalies ?? []).map(clone));
  }
  summary(filter: CostFilter = {}): CostSummary { return this.ledger.summarize(filter); }
  ingestTelemetry(entry: { id: string; projectId?: string; runId: string; model: string; totalTokens: number; cost: number; timestamp: string }): CostAttribution | undefined {
    if (!entry.projectId) return undefined; // 无法证明项目归属时宁可不计，也不跨项目猜测。
    const quantity = entry.totalTokens > 0 ? entry.totalTokens : 1;
    return this.ledger.record({ id: `telemetry:${entry.id}`, projectId: entry.projectId, runId: entry.runId, category: 'LLM', provider: 'telemetry', model: entry.model, quantity, unitCost: entry.cost / quantity, totalCost: entry.cost, currency: 'CNY', timestamp: entry.timestamp });
  }
  setBudget(input: CostBudgetInput, actor: string): CostBudget { const value = this.budgets.set(input); this.audit(actor, 'BUDGET_CHANGE', value.id, value.projectId, [`budget=${JSON.stringify(input)}`]); return value; }
  patchBudget(id: string, patch: Partial<CostBudgetInput>, actor: string): CostBudget { const value = this.budgets.patch(id, patch); this.audit(actor, 'BUDGET_CHANGE', id, value.projectId, [`patch=${JSON.stringify(patch)}`]); return value; }
  setPolicy(input: Omit<ModelPolicy, 'id' | 'updatedAt'> & { id?: string }, actor: string): ModelPolicy { const value = this.policies.set(input); this.audit(actor, 'MODEL_POLICY_CHANGE', value.id, value.projectId, [`model=${value.primaryModel}`, `environment=${value.environment}`]); return value; }
  patchPolicy(id: string, patch: Partial<Omit<ModelPolicy, 'id'>>, actor: string): ModelPolicy { const value = this.policies.patch(id, patch); this.audit(actor, 'MODEL_POLICY_CHANGE', id, value.projectId, [`patch=${JSON.stringify(patch)}`]); return value; }
  scale(input: ScalingInput, policy: ScalingPolicy, actor: string): ScalingDecision { const decision = adaptiveScale(input, policy, this.scalingState.lastScaledAt); if (decision.action !== 'HOLD') { this.scalingState.currentWorkers = decision.desiredWorkers; this.scalingState.lastScaledAt = input.now ?? Date.now(); } this.scalingState.events.push({ ...decision, at: new Date(input.now ?? Date.now()).toISOString(), actor }); this.audit(actor, 'WORKER_SCALE', 'workers', undefined, decision.trace); return decision; }
  scaling(): ScalingState { return clone(this.scalingState); }
  recommend(input: Omit<OptimizationRecommendation, 'id' | 'status' | 'canaryPercent' | 'createdAt' | 'updatedAt' | 'trace'> & { trace?: string[] }): OptimizationRecommendation { const now = new Date().toISOString(); const value: OptimizationRecommendation = { ...input, id: `opt-${randomUUID()}`, status: 'RECOMMENDED', canaryPercent: 0, trace: input.trace ?? [], createdAt: now, updatedAt: now }; this.recommendations.set(value.id, value); return clone(value); }
  listOptimizations(projectId?: string): OptimizationRecommendation[] { return [...this.recommendations.values()].filter((v) => !projectId || v.projectId === projectId).map(clone); }
  getOptimization(id: string): OptimizationRecommendation | undefined { const value = this.recommendations.get(id); return value ? clone(value) : undefined; }
  recommendModelOptimization(projectId: string, points: CostQualityPoint[], qualityTolerance = 1): OptimizationRecommendation | undefined {
    const expensive = [...points].sort((a, b) => b.cost - a.cost)[0];
    if (!expensive) return undefined;
    const replacement = points.filter((p) => p.id !== expensive.id && p.cost < expensive.cost && p.quality >= expensive.quality - qualityTolerance).sort((a, b) => a.cost - b.cost || b.quality - a.quality)[0];
    if (!replacement) return undefined;
    return this.recommend({ projectId, type: 'MODEL_SWITCH', title: `${expensive.id} → ${replacement.id}`, current: expensive.id, proposed: replacement.id, expectedCostChange: round6((replacement.cost - expensive.cost) / Math.max(expensive.cost, 0.000001)), expectedQualityChange: round6(replacement.quality - expensive.quality), trace: [`costShareCandidate=${expensive.cost}`, `qualityTolerance=${qualityTolerance}`] });
  }
  decideOptimization(id: string, decision: 'APPROVED' | 'REJECTED', actor: string): OptimizationRecommendation { const value = this.requireOptimization(id); if (value.status !== 'RECOMMENDED') throw new Error('仅建议状态可以审批'); value.status = decision; value.approvedBy = actor; value.updatedAt = new Date().toISOString(); value.trace.push(`${decision} by ${actor}`); this.audit(actor, `OPTIMIZATION_${decision}`, id, value.projectId, value.trace); return clone(value); }
  activateOptimization(id: string, actor: string): OptimizationRecommendation { const value = this.requireOptimization(id); if (value.status !== 'APPROVED') throw new Error('生产优化必须先获批准'); value.status = 'ACTIVE'; value.updatedAt = new Date().toISOString(); value.trace.push(`ACTIVE by ${actor}`); this.audit(actor, 'OPTIMIZATION_ACTIVATE', id, value.projectId, value.trace); return clone(value); }
  promoteCanary(id: string, actor: string): OptimizationRecommendation { const value = this.requireOptimization(id); if (!['APPROVED', 'ACTIVE'].includes(value.status)) throw new Error('灰度必须先获批准'); const steps = [0, 5, 20, 50, 100] as const; value.canaryPercent = steps[Math.min(steps.length - 1, steps.indexOf(value.canaryPercent) + 1)]; value.status = value.canaryPercent === 100 ? 'ACTIVE' : 'APPROVED'; value.updatedAt = new Date().toISOString(); value.trace.push(`canary=${value.canaryPercent}% by ${actor}`); this.audit(actor, 'CANARY_PROMOTE', id, value.projectId, value.trace); return clone(value); }
  observeCanary(id: string, metrics: { costChange: number; qualityChange: number; latencyChange: number; failureChange: number }, actor: string): OptimizationRecommendation { const value = this.requireOptimization(id); const severe = metrics.qualityChange <= -0.05 || metrics.failureChange >= 0.1 || metrics.costChange >= 1; const warning = metrics.costChange >= 0.5 || metrics.latencyChange >= 0.5; if (severe) { value.status = 'ROLLED_BACK'; value.canaryPercent = 0; } else if (warning) value.status = 'STOPPED'; value.updatedAt = new Date().toISOString(); value.trace.push(`${value.status}: ${JSON.stringify(metrics)}`); this.audit(actor, value.status === 'ROLLED_BACK' ? 'CANARY_ROLLBACK' : 'CANARY_OBSERVE', id, value.projectId, value.trace); return clone(value); }
  addAnomaly(anomaly: CostAnomaly): void { this.anomalies.push(clone(anomaly)); this.audit('system', 'COST_ANOMALY', anomaly.id, anomaly.projectId, [anomaly.message, ...anomaly.channels]); }
  listAudit(projectId?: string): CostAuditEvent[] { return this.audits.filter((a) => !projectId || a.projectId === projectId).map(clone); }
  snapshot(): CostGovernanceSnapshot { return { version: 1, attributions: this.ledger.snapshot(), budgets: this.budgets.snapshot(), policies: this.policies.snapshot(), optimizations: this.listOptimizations(), audits: this.listAudit(), scaling: this.scaling(), anomalies: this.anomalies.map(clone) }; }
  persistToFile(filePath: string): void { ensureDir(path.dirname(filePath)); const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(this.snapshot(), null, 2)); fs.renameSync(temp, filePath); }
  static loadFromFile(filePath: string): CostGovernanceService { return fs.existsSync(filePath) ? new CostGovernanceService(JSON.parse(fs.readFileSync(filePath, 'utf8')) as CostGovernanceSnapshot) : new CostGovernanceService(); }
  private requireOptimization(id: string): OptimizationRecommendation { const value = this.recommendations.get(id); if (!value) throw new Error(`优化建议不存在：${id}`); return value; }
  private audit(actor: string, action: string, target: string, projectId: string | undefined, trace: string[]): void { this.audits.push({ id: `cost-audit-${randomUUID()}`, actor, action, target, projectId, trace: [...trace], timestamp: new Date().toISOString() }); }
}
