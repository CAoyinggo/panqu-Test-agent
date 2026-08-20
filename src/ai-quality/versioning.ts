// Prompt / Model Versioning + A/B Evaluation + Multi-objective Score（Phase 46 / 43.7-43.10）
// PromptVersion / ModelVersion 各自版本化；同一个 Benchmark 可对多个 Prompt / Model 公平比较。
// A/B Evaluation（43.9）：至少比较 Accuracy / Latency / Cost / Failure Rate / Safety，不要只看 Accuracy。
// Multi-objective Score（43.10）：Quality / Safety / Latency / Cost 加权 → QualityScore，
// 但必须保留原始指标（不能只输出一个黑盒分数）。
import { randomBytes } from 'node:crypto';
import type { AbComparison, AbMetric, ModelVersion, ObjectiveWeights, PromptVersion } from './contract.js';
import { DEFAULT_OBJECTIVE_WEIGHTS } from './contract.js';

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

// ── Prompt Versioning（43.7）──
export class PromptStore {
  private readonly items = new Map<string, PromptVersion>();
  private readonly byKey = new Map<string, PromptVersion[]>(); // promptKey → 按版本升序

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  /** 新增 Prompt 版本：同名 key 自动递增版本号（v1 → v2 → v3） */
  add(input: { promptKey: string; content: string; model?: string; createdBy: string }): PromptVersion {
    const key = input.promptKey;
    const existing = this.byKey.get(key) ?? [];
    const version = `v${existing.length + 1}`;
    const p: PromptVersion = {
      id: newId('prompt'),
      promptKey: key,
      version,
      content: input.content,
      model: input.model,
      createdBy: input.createdBy,
      createdAt: this.now(),
      status: existing.length === 0 ? 'ACTIVE' : 'DRAFT',
      parentVersion: existing.length > 0 ? existing[existing.length - 1].version : undefined,
    };
    this.items.set(p.id, p);
    const arr = this.byKey.get(key) ?? [];
    arr.push(p);
    this.byKey.set(key, arr);
    return p;
  }

  list(promptKey?: string): PromptVersion[] {
    const all = [...this.items.values()];
    return promptKey
      ? (this.byKey.get(promptKey) ?? []).sort((a, b) => a.version.localeCompare(b.version))
      : all.sort((a, b) => a.promptKey.localeCompare(b.promptKey) || a.version.localeCompare(b.version));
  }

  get(id: string): PromptVersion | null {
    return this.items.get(id) ?? null;
  }

  /** 记录该版本的 Benchmark 得分 */
  recordScore(id: string, score: number): PromptVersion {
    const p = this.items.get(id);
    if (!p) throw new Error(`Prompt 版本不存在：${id}`);
    p.benchmarkScore = score;
    return p;
  }

  /** 切换为 ACTIVE（生产生效，需经审批链调用；此处仅做状态变更，审批由上层控制） */
  setActive(id: string): PromptVersion {
    const p = this.items.get(id);
    if (!p) throw new Error(`Prompt 版本不存在：${id}`);
    for (const other of this.byKey.get(p.promptKey) ?? []) {
      if (other.id !== id && other.status === 'ACTIVE') other.status = 'DISABLED';
    }
    p.status = 'ACTIVE';
    return p;
  }

  size(): number {
    return this.items.size;
  }

  /** 从快照恢复（CLI/API 持久化用） */
  static import(items: PromptVersion[]): PromptStore {
    const s = new PromptStore();
    for (const p of items) {
      s.items.set(p.id, p);
      const arr = s.byKey.get(p.promptKey) ?? [];
      arr.push(p);
      s.byKey.set(p.promptKey, arr);
    }
    return s;
  }
}
export class ModelStore {
  private readonly items = new Map<string, ModelVersion>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  add(input: { provider: string; model: string; modelVersion: string; configuration?: Record<string, unknown>; createdBy: string }): ModelVersion {
    const id = `${input.provider}:${input.model}@${input.modelVersion}`;
    const existing = this.items.get(id);
    if (existing) return existing; // 幂等
    const m: ModelVersion = {
      id,
      provider: input.provider,
      model: input.model,
      modelVersion: input.modelVersion,
      configuration: input.configuration ?? {},
      status: 'DRAFT',
      createdBy: input.createdBy,
      createdAt: this.now(),
    };
    this.items.set(id, m);
    return m;
  }

  list(): ModelVersion[] {
    return [...this.items.values()].sort((a, b) => `${a.provider}:${a.model}`.localeCompare(`${b.provider}:${b.model}`) || a.modelVersion.localeCompare(b.modelVersion));
  }

  get(id: string): ModelVersion | null {
    return this.items.get(id) ?? null;
  }

  setActive(id: string): ModelVersion {
    const m = this.items.get(id);
    if (!m) throw new Error(`Model 版本不存在：${id}`);
    for (const other of this.items.values()) {
      if (other.id !== id && other.model === m.model && other.status === 'ACTIVE') other.status = 'DISABLED';
    }
    m.status = 'ACTIVE';
    return m;
  }

  size(): number {
    return this.items.size;
  }

  /** 从快照恢复（CLI/API 持久化用） */
  static import(items: ModelVersion[]): ModelStore {
    const s = new ModelStore();
    for (const m of items) s.items.set(m.id, m);
    return s;
  }
}

// ── A/B Evaluation（43.9）──
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** 计算多目标综合分（43.10）：QualityScore = Σ weights × 归一化分；保留原始指标 */
export function multiObjectiveScore(
  m: AbMetric,
  weights: ObjectiveWeights = DEFAULT_OBJECTIVE_WEIGHTS,
): { qualityScore: number; components: Record<string, number> } {
  const latencyScore = clamp01(1 - m.latencyMs / 2000); // 2000ms 为满分基线，超过为 0
  const costScore = clamp01(1 - m.cost / 0.01); // 0.01$ 为满分基线
  const safetyScore = clamp01(1 - m.safety); // safety 为 0~1 风险率（如 unsafe 比例），越低越好
  const qualityScore = clamp01(
    weights.quality * m.accuracy +
    weights.safety * safetyScore +
    weights.latency * latencyScore +
    weights.cost * costScore,
  );
  return {
    qualityScore: Math.round(qualityScore * 10000) / 10000,
    components: {
      accuracy: Math.round(m.accuracy * 10000) / 10000,
      safetyScore: Math.round(safetyScore * 10000) / 10000,
      latencyScore: Math.round(latencyScore * 10000) / 10000,
      costScore: Math.round(costScore * 10000) / 10000,
    },
  };
}

/**
 * A/B 对比：baseline vs candidate，逐维度胜者 + 多目标综合分。
 * 用于 Prompt / Model 版本公平比较（43.9）。
 */
export function compareAb(baseline: AbMetric, candidate: AbMetric, weights?: ObjectiveWeights): AbComparison {
  const winners = {
    accuracy: baseline.accuracy > candidate.accuracy ? 'baseline' as const : candidate.accuracy > baseline.accuracy ? 'candidate' as const : 'tie' as const,
    latencyMs: baseline.latencyMs < candidate.latencyMs ? 'baseline' as const : candidate.latencyMs < baseline.latencyMs ? 'candidate' as const : 'tie' as const,
    cost: baseline.cost < candidate.cost ? 'baseline' as const : candidate.cost < baseline.cost ? 'candidate' as const : 'tie' as const,
    failureRate: baseline.failureRate < candidate.failureRate ? 'baseline' as const : candidate.failureRate < baseline.failureRate ? 'candidate' as const : 'tie' as const,
    safety: baseline.safety < candidate.safety ? 'baseline' as const : candidate.safety < baseline.safety ? 'candidate' as const : 'tie' as const,
  };
  const b = multiObjectiveScore(baseline, weights);
  const c = multiObjectiveScore(candidate, weights);
  return {
    baseline,
    candidate,
    deltas: {
      accuracy: Math.round((candidate.accuracy - baseline.accuracy) * 10000) / 10000,
      latencyMs: candidate.latencyMs - baseline.latencyMs,
      cost: Math.round((candidate.cost - baseline.cost) * 10000) / 10000,
      failureRate: Math.round((candidate.failureRate - baseline.failureRate) * 10000) / 10000,
      safety: Math.round((candidate.safety - baseline.safety) * 10000) / 10000,
    },
    winners,
    baselineQuality: b.qualityScore,
    candidateQuality: c.qualityScore,
  };
}

export function formatAbComparison(cmp: AbComparison): string {
  const lines: string[] = ['A/B Comparison（Accuracy / Latency / Cost / Failure / Safety / Quality）'];
  lines.push(`  Baseline : acc=${fmt(cmp.baseline.accuracy)} latency=${cmp.baseline.latencyMs}ms cost=$${cmp.baseline.cost} fail=${fmt(cmp.baseline.failureRate)} safety=${fmt(cmp.baseline.safety)} quality=${fmt(cmp.baselineQuality)}`);
  lines.push(`  Candidate: acc=${fmt(cmp.candidate.accuracy)} latency=${cmp.candidate.latencyMs}ms cost=$${cmp.candidate.cost} fail=${fmt(cmp.candidate.failureRate)} safety=${fmt(cmp.candidate.safety)} quality=${fmt(cmp.candidateQuality)}`);
  lines.push(`  Winners  : accuracy=${cmp.winners.accuracy} latency=${cmp.winners.latencyMs} cost=${cmp.winners.cost} failure=${cmp.winners.failureRate} safety=${cmp.winners.safety}`);
  return lines.join('\n');
}

function fmt(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
