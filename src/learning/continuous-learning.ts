// Continuous Learning Engine：持续学习引擎（Phase 22.7）
// 1) applyEvidence：新执行结果 → failureRate / recentRate / confidence / riskWeight / priority 重算。
//    confidence = 0.3 + recentRate × 0.7（最近失败越多 → 风险置信度越高；连续 PASS → 下降）。
//    riskWeight = failureRate × confidence（新证据验证后 decay 重置为 1）。
// 2) decayAll：无新证据时按 time decay 降低权重（30 天 0.9 / 60 天 0.7 / 90 天 0.4）。
// 3) applyToCases：Selection Update（闭环最后一环）。
// 全部确定性、可复现，无 LLM。

import type {
  ExecutionEvidence,
  LearningAppliedCase,
  LearningConfig,
  LearningState,
  LearningUpdate,
} from './learning-schema.js';
import { DEFAULT_LEARNING_CONFIG } from './learning-schema.js';

const DAY_MS = 86400000;

/** Knowledge Weight Decay：时间衰减因子（确定性阶梯 + 90 天后继续衰减） */
export function weightDecay(ageDays: number, config: LearningConfig = DEFAULT_LEARNING_CONFIG): number {
  if (ageDays < 30) return 1;
  if (ageDays < 60) return config.decay30; // 30 天：0.9
  if (ageDays < 90) return config.decay60; // 60 天：0.7
  // 90 天后：0.4 继续衰减，但保留最小权重，除非新证据重新验证
  return Math.max(config.minDecay, config.decay90 * Math.pow(0.9, (ageDays - 90) / 30));
}

/** 由 riskWeight 推导建议优先级（确定性阈值） */
export function suggestedPriority(riskWeight: number, config: LearningConfig = DEFAULT_LEARNING_CONFIG): LearningState['priority'] {
  const { p0, p1, p2 } = config.priorityThresholds;
  if (riskWeight >= p0) return 'P0';
  if (riskWeight >= p1) return 'P1';
  if (riskWeight >= p2) return 'P2';
  return 'P3';
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** 创建初始学习状态 */
export function createLearningState(key: string): LearningState {
  const now = new Date().toISOString();
  return {
    key,
    runs: 0,
    failures: 0,
    failureRate: 0,
    recentRate: 0,
    confidence: 0,
    riskWeight: 0,
    decay: 1,
    priority: 'P3',
    consecutivePasses: 0,
    consecutiveFailures: 0,
    lastResult: undefined,
    lastEvidenceAt: now,
    lastUpdatedAt: now,
    evidence: [],
    recent: [],
  };
}

/** 应用单次执行证据（新证据验证知识 → 权重按最新行为重算） */
export function applyEvidence(
  prev: LearningState,
  passed: boolean,
  config: LearningConfig = DEFAULT_LEARNING_CONFIG,
  nowMs: number = Date.now(),
): LearningState {
  const runs = prev.runs + 1;
  const failures = prev.failures + (passed ? 0 : 1);
  const failureRate = failures / runs;
  const recent = [...prev.recent, passed].slice(-config.recentWindow);
  const recentFailures = recent.filter((r) => !r).length;
  const recentRate = recentFailures / recent.length;
  // 风险置信度：最近失败越多越高；连续 PASS 冲刷 → 下降
  const confidence = Math.round(clamp01(0.3 + recentRate * 0.7) * 1000) / 1000;
  // 新证据验证：decay 重置为 1，风险权重 = 失败率 × 置信度
  const riskWeight = Math.round(clamp01(failureRate * confidence) * 1000) / 1000;
  const priority = suggestedPriority(riskWeight, config);
  const nowIso = new Date(nowMs).toISOString();
  const evidence = [
    ...prev.evidence.slice(-19),
    passed
      ? `第 ${runs} 次执行 PASS（连续通过 ${passed ? prev.consecutivePasses + 1 : 0} 次）`
      : `第 ${runs} 次执行 FAIL（连续失败 ${prev.consecutiveFailures + 1} 次）`,
  ];
  return {
    key: prev.key,
    runs,
    failures,
    failureRate: Math.round(failureRate * 1000) / 1000,
    recentRate: Math.round(recentRate * 1000) / 1000,
    confidence,
    riskWeight,
    decay: 1,
    priority,
    consecutivePasses: passed ? prev.consecutivePasses + 1 : 0,
    consecutiveFailures: passed ? 0 : prev.consecutiveFailures + 1,
    lastResult: passed ? 'PASS' : 'FAIL',
    lastEvidenceAt: nowIso,
    lastUpdatedAt: nowIso,
    evidence,
    recent,
  };
}

/** Knowledge Weight Decay：无新证据时按时间降低权重 */
export function decayLearningState(
  state: LearningState,
  nowMs: number,
  config: LearningConfig = DEFAULT_LEARNING_CONFIG,
): LearningState {
  const ageMs = nowMs - new Date(state.lastEvidenceAt).getTime();
  const ageDays = Math.max(0, ageMs / DAY_MS);
  const decay = weightDecay(ageDays, config);
  const confidence = Math.round(clamp01(state.confidence * decay) * 1000) / 1000;
  const riskWeight = Math.round(clamp01(state.riskWeight * decay) * 1000) / 1000;
  return {
    ...state,
    confidence,
    riskWeight,
    decay: Math.round(decay * 1000) / 1000,
    priority: suggestedPriority(riskWeight, config),
    lastUpdatedAt: new Date(nowMs).toISOString(),
  };
}

/** 连续学习器：按 key 维护学习状态，提供证据学习、衰减、Selection 闭环 */
export class ContinuousLearner {
  private readonly states = new Map<string, LearningState>();

  constructor(private readonly config: LearningConfig = DEFAULT_LEARNING_CONFIG) {}

  /** 学习一批执行证据 */
  learn(evidence: ExecutionEvidence[], nowMs: number = Date.now()): LearningUpdate[] {
    const updates: LearningUpdate[] = [];
    for (const e of evidence) {
      const key = e.key;
      const before = this.states.get(key) ?? createLearningState(key);
      const evidenceAt = e.at ? new Date(e.at).getTime() : nowMs;
      const after = applyEvidence(before, e.passed, this.config, evidenceAt);
      this.states.set(key, after);
      updates.push({
        key,
        kind: 'evidence',
        before,
        after,
        deltas: [
          `failureRate ${(before.failureRate * 100).toFixed(1)}% → ${(after.failureRate * 100).toFixed(1)}%`,
          `riskWeight ${before.riskWeight.toFixed(3)} → ${after.riskWeight.toFixed(3)}`,
          `priority ${before.priority} → ${after.priority}`,
        ],
      });
    }
    return updates;
  }

  /** 对所有状态应用 Knowledge Weight Decay */
  decayAll(nowMs: number = Date.now()): LearningUpdate[] {
    const updates: LearningUpdate[] = [];
    for (const [key, state] of this.states) {
      const after = decayLearningState(state, nowMs, this.config);
      if (after.riskWeight !== state.riskWeight || after.confidence !== state.confidence) {
        updates.push({
          key,
          kind: 'decay',
          before: state,
          after,
          deltas: [
            `decay ${state.decay.toFixed(3)} → ${after.decay.toFixed(3)}`,
            `riskWeight ${state.riskWeight.toFixed(3)} → ${after.riskWeight.toFixed(3)}`,
            `priority ${state.priority} → ${after.priority}`,
          ],
        });
      }
      this.states.set(key, after);
    }
    return updates;
  }

  state(key: string): LearningState | undefined {
    return this.states.get(key);
  }

  entries(): LearningState[] {
    return [...this.states.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  size(): number {
    return this.states.size;
  }

  /** Selection Update：把学习结果应用到用例（风险分/动态优先级） */
  applyToCases(
    cases: Array<{ caseId: string; priority: 'P0' | 'P1' | 'P2' | 'P3'; riskScore?: number }>,
  ): LearningAppliedCase[] {
    const out: LearningAppliedCase[] = [];
    for (const c of cases) {
      const state = this.states.get(c.caseId);
      if (!state || state.runs === 0) continue;
      // 学习优先级为建议值；P0 用例不降级（保底），非 P0 可升降
      const priority = c.priority === 'P0' ? 'P0' : state.priority;
      const riskScore = Math.round(Math.max(c.riskScore ?? 0, state.riskWeight) * 1000) / 1000;
      out.push({ caseId: c.caseId, priority, riskScore });
    }
    return out;
  }

  /** 导出为知识条目输入（risk-insight，供 KnowledgeStore 沉淀） */
  toKnowledgeInputs(feature: string): Array<{ type: 'risk-insight'; feature: string; title: string; content: string; confidence: number; stats: { runs: number; failures: number }; tags: string[] }> {
    return this.entries()
      .filter((s) => s.runs > 0)
      .map((s) => ({
        type: 'risk-insight' as const,
        feature,
        title: `${s.key} 失败率学习`,
        content: `持续学习：${s.runs} 次执行，失败 ${s.failures} 次，失败率 ${(s.failureRate * 100).toFixed(1)}%，风险权重 ${s.riskWeight.toFixed(3)}`,
        confidence: s.confidence,
        stats: { runs: s.runs, failures: s.failures },
        tags: [s.key],
      }));
  }
}
