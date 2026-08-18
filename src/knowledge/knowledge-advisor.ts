// Knowledge Advisor：知识参与决策（Phase 21.5）
// 目标：历史知识不只是显示在报告里，而是真正参与下一次测试决策：
//   Requirement → Knowledge Retrieval → Risk（提高风险权重）→ Test Selection（提高执行优先级）。
// 示例：Memory 发现「过去 30 次 1080P + 10s 失败率 37%」→ 该类 Case 自动提高风险权重与执行优先级。

import type { KnowledgeEntry } from './knowledge-schema.js';

/** 知识统计中的失败率数据形态 */
export interface FailureStats {
  /** 历史运行次数 */
  runs: number;
  /** 失败次数 */
  failures: number;
}

/** 知识决策建议 */
export interface KnowledgeAdvice {
  knowledgeId: string;
  title: string;
  /** 命中的上下文标签 */
  matchedTags: string[];
  /** 历史失败率（0~1，无统计数据时为 0） */
  failureRate: number;
  /** 风险权重 = 失败率 × 置信度（0~1） */
  riskWeight: number;
  /** 是否建议提升执行优先级（失败率 ≥ 阈值） */
  priorityBoost: boolean;
  reason: string;
}

/** 决策上下文：当前需求/回归关注的 feature 与标签（参数取值、能力等） */
export interface AdviceContext {
  feature: string;
  tags: string[];
}

/** 优先级提升的失败率阈值（默认 20%） */
export const PRIORITY_BOOST_THRESHOLD = 0.2;

/** 从知识 stats 提取失败率 */
export function failureRateOf(entry: KnowledgeEntry): number {
  const stats = entry.stats as Partial<FailureStats> | undefined;
  if (!stats || typeof stats.runs !== 'number' || stats.runs <= 0) return 0;
  const failures = typeof stats.failures === 'number' ? stats.failures : 0;
  return Math.min(1, Math.max(0, failures / stats.runs));
}

/**
 * 主动知识检索 + 决策建议：
 * 1. 检索：同 feature 且 ACTIVE 的知识，tags 与上下文有交集（或知识无 tags 时按 feature 命中）
 * 2. 建议：失败率 × 置信度 → 风险权重；失败率 ≥ 20% → 建议提升执行优先级
 * 按风险权重降序返回。
 */
export function adviseFromKnowledge(entries: KnowledgeEntry[], context: AdviceContext): KnowledgeAdvice[] {
  const ctxTags = new Set(context.tags.map((t) => t.toLowerCase()));
  const advice: KnowledgeAdvice[] = [];

  for (const entry of entries) {
    if (entry.status !== 'ACTIVE') continue;
    if (entry.feature !== context.feature) continue;
    const matchedTags = entry.tags.filter((t) => ctxTags.has(t.toLowerCase()));
    // 知识无 tags 视为 feature 级通用知识；有 tags 则必须命中上下文
    if (entry.tags.length > 0 && matchedTags.length === 0) continue;

    const failureRate = failureRateOf(entry);
    const riskWeight = Math.round(failureRate * entry.confidence * 1000) / 1000;
    advice.push({
      knowledgeId: entry.id,
      title: entry.title,
      matchedTags,
      failureRate: Math.round(failureRate * 1000) / 1000,
      riskWeight,
      priorityBoost: failureRate >= PRIORITY_BOOST_THRESHOLD,
      reason: failureRate > 0
        ? `历史失败率 ${(failureRate * 100).toFixed(1)}%（置信度 ${entry.confidence}），建议提高风险权重${failureRate >= PRIORITY_BOOST_THRESHOLD ? '与执行优先级' : ''}`
        : `历史知识命中（${entry.type}），作为风险参考`,
    });
  }
  return advice.sort((a, b) => b.riskWeight - a.riskWeight || a.knowledgeId.localeCompare(b.knowledgeId));
}

/**
 * 将知识建议应用到用例优先级：返回需要提权的用例标签集合。
 * 规则：priorityBoost 建议的 matchedTags 对应的用例应提升优先级（如 P2 → P1）。
 */
export function boostedTagsFromAdvice(advice: KnowledgeAdvice[]): string[] {
  const tags = new Set<string>();
  for (const a of advice) {
    if (a.priorityBoost) for (const t of a.matchedTags) tags.add(t);
  }
  return [...tags].sort();
}
