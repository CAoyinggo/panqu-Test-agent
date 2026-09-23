/**
 * Panqu AI DevTest - 探索调度策略器 (Exploration Policy)
 *
 * 核心调度哲学：
 * 1. Unknown > Known（未知优先铁律：严禁已知高频路径压制未知高危跃迁）；
 * 2. 多维综合评分：
 *    ExplorationScore = Risk + Novelty + Uncertainty + HistoricalFailure + ConstraintBoundary + BusinessImpact - AlreadyCovered
 * 3. 具备完全可解释的决策依据生成。
 */

import { type LearningExperience } from './contracts.js';
import { type UnverifiedFrontier } from './state-graph.js';
import { PanquConstraintEvaluator } from './constraint.js';

export interface ScoreBreakdown {
  risk: number;
  novelty: number;
  uncertainty: number;
  historicalFailure: number;
  constraintBoundary: number;
  businessImpact: number;
  alreadyCoveredPenalty: number;
}

export interface ScoredFrontier {
  frontier: UnverifiedFrontier;
  totalScore: number;
  breakdown: ScoreBreakdown;
  rationale: string;
}

export class PanquExplorationPolicy {
  private constraintEvaluator: PanquConstraintEvaluator;

  constructor(constraintEvaluator = new PanquConstraintEvaluator()) {
    this.constraintEvaluator = constraintEvaluator;
  }

  /**
   * 针对候选 Frontier 列表进行约束过滤、多维评分与排序
   *
   * @param frontiers 候选探索前沿列表
   * @param historyCounts 历史执行频次映射 (key: transitionId 或 `${fromKey}->${actionType}`)
   * @param experiences 沉淀的因果经验列表
   */
  public evaluateAndRank(
    frontiers: UnverifiedFrontier[],
    historyCounts: Map<string, number> = new Map(),
    experiences: LearningExperience[] = [],
  ): ScoredFrontier[] {
    const scoredList: ScoredFrontier[] = [];

    for (const frontier of frontiers) {
      // 1. 约束求解器前置硬过滤：不满足业务约束的候选直接剔除
      const samplePayload = frontier.candidateAction.payloadGenerator
        ? frontier.candidateAction.payloadGenerator(frontier.fromState)
        : {};

      const constraintResult = this.constraintEvaluator.evaluate(
        frontier.candidateAction,
        frontier.fromState,
        samplePayload,
      );

      if (!constraintResult.satisfied) {
        continue; // 不满足业务硬性约束，直接舍弃
      }

      // 2. 提取历史频次
      const transitionSignature = `${frontier.fromKey}->${frontier.candidateAction.type}`;
      const runs = historyCounts.get(transitionSignature) ?? 0;

      // 3. 计算七维指标
      const breakdown = this.computeBreakdown(frontier, runs, experiences);

      // 综合评分公式 (强制 Unknown > Known)
      const totalScore = Number(
        (
          breakdown.risk +
          breakdown.novelty +
          breakdown.uncertainty +
          breakdown.historicalFailure +
          breakdown.constraintBoundary +
          breakdown.businessImpact -
          breakdown.alreadyCoveredPenalty
        ).toFixed(3),
      );

      // 4. 生成高度可解释的选择依据
      const rationale = this.generateExplanation(frontier, runs, breakdown, totalScore);

      scoredList.push({
        frontier,
        totalScore,
        breakdown,
        rationale,
      });
    }

    // 按总效用分降序排序
    return scoredList.sort((a, b) => b.totalScore - a.totalScore);
  }

  /**
   * 计算七维细分指标
   */
  private computeBreakdown(
    frontier: UnverifiedFrontier,
    historyRuns: number,
    experiences: LearningExperience[],
  ): ScoreBreakdown {
    // A. 基础风险 (Risk: 0.0 ~ 1.0)
    const risk = frontier.candidateAction.baseRisk;

    // B. 新颖度 (Novelty: 0.0 ~ 1.0)
    // 0 次运行即为 1.0；随着历史运行次数增加迅速衰减
    const novelty = historyRuns === 0 ? 1.0 : Number((1.0 / (1.0 + Math.log2(1 + historyRuns))).toFixed(3));

    // 提取匹配的因果经验 (供历史缺陷与不确定性推导复用)
    const matchingExperiences = experiences.filter((exp) => {
      return (
        exp.discoveredAnomaly.includes(frontier.candidateAction.type) ||
        exp.policyDirectives.priorityStatesToExplore.some((s) => frontier.fromKey.includes(s))
      );
    });

    // C. 不确定性与状态熵 (Uncertainty: 0.0 ~ 1.0)
    // 目标状态含潜在 Defect 或存在多个推导分支时，不确定性极高
    let uncertainty = 0.2;
    if (frontier.inferredTargetStates.some((s) => s.includes('Defect') || s.includes('Orphan'))) {
      uncertainty = 0.95;
    } else if (['DISPATCHED', 'GENERATING'].includes(frontier.fromState.task.status)) {
      uncertainty = 0.65;
    }
    // 历史经验若表明存在凭证缺口或未证实风险 (Evidence Gap)，显著提高不确定性探索权重
    if (
      matchingExperiences.some(
        (e) =>
          e.confidence < 0.9 || e.discoveredAnomaly.includes('UNPROVEN') || e.discoveredAnomaly.includes('UNVERIFIED'),
      )
    ) {
      uncertainty = Math.max(uncertainty, 0.85);
    }

    // D. 历史缺陷关联度 (HistoricalFailure: 0.0 ~ 1.5)
    // 如果相关状态在历史经验中记录过 Bug，享受显著权重加成
    let historicalFailure = 0.0;
    if (matchingExperiences.length > 0) {
      const maxBoost = Math.max(...matchingExperiences.map((e) => e.policyDirectives.boostMultiplier || 1.0));
      historicalFailure = Math.min(1.5, Number(((maxBoost - 1.0) * 0.5 + 0.3).toFixed(3)));
    }

    // E. 约束边界效应 (ConstraintBoundary: 0.0 ~ 0.8)
    // 在异步时序正处于进行时发起中断/取消，处于极端业务边界
    let constraintBoundary = 0.1;
    if (
      ['GENERATING', 'DISPATCHED'].includes(frontier.fromState.task.status) &&
      ['CANCEL_TASK', 'INJECT_TIMEOUT'].includes(frontier.candidateAction.type)
    ) {
      constraintBoundary = 0.75;
    }

    // F. 核心业务影响 (BusinessImpact: 0.0 ~ 1.2)
    // 涉及资金扣费与退款不变量的动作具有顶级业务影响
    let businessImpact = 0.3;
    if (frontier.candidateAction.riskCategory === 'CRITICAL_FINANCIAL') {
      businessImpact = 1.2; // 直接关乎 antiDoubleBilling / netChargeZero / refundIdempotency
    } else if (frontier.candidateAction.riskCategory === 'ASYNC_CONSISTENCY') {
      businessImpact = 0.85;
    } else if (frontier.candidateAction.riskCategory === 'MEDIA_INTEGRITY') {
      businessImpact = 0.7;
    }

    // G. 既有覆盖惩罚 (AlreadyCoveredPenalty: 0.0 ~ 5.0+)
    // 【核心机制：Unknown > Known】
    // 已经验证过 100 次的正常路径扣除重度覆盖惩罚，严禁持续重复测试
    const alreadyCoveredPenalty = historyRuns === 0 ? 0.0 : Number((0.55 * Math.log2(1 + historyRuns)).toFixed(3));

    return {
      risk,
      novelty,
      uncertainty,
      historicalFailure,
      constraintBoundary,
      businessImpact,
      alreadyCoveredPenalty,
    };
  }

  /**
   * 生成自然语言可解释依据
   */
  private generateExplanation(
    frontier: UnverifiedFrontier,
    historyRuns: number,
    b: ScoreBreakdown,
    total: number,
  ): string {
    const reasons: string[] = [];

    if (historyRuns === 0) {
      reasons.push(`[未知优先] 历史上该状态跃迁执行 0 次 (Novelty=1.0)，属于全新测试空白区`);
    } else {
      reasons.push(`[已覆盖惩罚] 历史已执行 ${historyRuns} 次，扣除覆盖惩罚 -${b.alreadyCoveredPenalty}`);
    }

    if (b.businessImpact >= 1.0) {
      reasons.push(`[资金不变量] 动作属于 ${frontier.candidateAction.riskCategory}，直接牵涉净扣零与退款幂等真值`);
    }

    if (b.uncertainty >= 0.8) {
      reasons.push(`[高不确定性] 目标状态具有高风险潜在分支 (${frontier.inferredTargetStates.join(' | ')})`);
    }

    if (b.historicalFailure > 0) {
      reasons.push(`[历史经验强化] 关联合适的已知缺陷模式，获得历史经验权重 +${b.historicalFailure}`);
    }

    if (b.constraintBoundary >= 0.7) {
      reasons.push(`[业务边界动作] 在任务异步处于 ${frontier.fromState.task.status} 关键时序节点执行切断动作`);
    }

    return `总分 ${total} 分。决策依据：${reasons.join('；')}。`;
  }
}
