/**
 * Panqu AI DevTest - 探索自进化经验闭环 (Learning & Experience Feedback)
 *
 * 核心设计原则：
 * 1. 经验 100% 提取自物理执行与验证证据 (executeResult, verifyResult, rejectionEvidence, StateGraph transition)；
 * 2. 严禁使用 expectedObservation 或 expectedRisk 作为经验输入；
 * 3. 严格 REAL 与 MOCK 隔离：MOCK 模式产出的经验默认绝不写入生产真实历史；
 * 4. 正常 PASS 用例不生成缺陷经验，仅通过 StateGraph 累加 historyCount 激活 AlreadyCoveredPenalty；
 * 5. 重点捕获“已确诊缺陷”与“高价值负向探测/凭证缺口 (Evidence Gap)”。
 */

import { type LearningExperience } from './contracts.js';
import { type PanquStateGraph } from './state-graph.js';
import { type MutationRunResult } from './runner.js';

export interface ExtractLearningOptions {
  mode?: 'real' | 'mock';
  allowMockLearning?: boolean; // 受控单元测试中是否允许将 MOCK 结果提取并学习
}

/**
 * 从单次变异执行结果中提取标准 LearningExperience
 */
export function extractLearningExperiences(
  runResult: MutationRunResult,
  options: ExtractLearningOptions = {},
): LearningExperience[] {
  // 1. 阻断未执行或未证实的动作 (绝对禁止从未执行的候选中凭空捏造经验)
  if (
    runResult.executionReadiness === 'BLOCKED_BY_UNSUPPORTED_ACTION' ||
    runResult.executionReadiness === 'STRUCTURAL_ONLY'
  ) {
    return [];
  }

  // 2. REAL / MOCK 隔离：MOCK 执行若未显式授权允许学习，绝对禁止生成经验
  if (runResult.mode === 'mock' && !options.allowMockLearning) {
    return [];
  }

  const experiences: LearningExperience[] = [];
  const actionType = runResult.observedTransition?.actionType || 'SUBMIT_TASK';
  const fromKey = runResult.observedTransition?.fromKey || 'task:UNSUBMITTED';
  const toKey = runResult.observedTransition?.toKey || 'task:FAILED';
  const transitionId = runResult.observedTransition?.id || `trans_${Date.now()}`;

  // 3. 场景 A: 真实已确诊缺陷 (Confirmed Defect / Anomaly)
  const isFailedVerification =
    runResult.verifyResult && (!runResult.verifyResult.passed || runResult.verifyResult.verdict === 'FAIL');
  const hasStateGraphAnomalies =
    runResult.observedTransition && runResult.observedTransition.anomaliesDetected.length > 0;
  const matchedPatterns =
    runResult.verifyResult?.businessValidation?.matchedFailurePatterns ||
    (runResult.verifyResult?.memoryCandidate?.patternId ? [runResult.verifyResult.memoryCandidate.patternId] : []);
  const hasFailurePatterns = matchedPatterns.length > 0;

  if (isFailedVerification || hasStateGraphAnomalies || hasFailurePatterns) {
    const rawAnomaly = runResult.observedTransition?.anomaliesDetected[0] || matchedPatterns[0] || 'INVARIANT_FAILED';

    const reasons = runResult.verifyResult?.reasons || [];
    const invariantsList: string[] = [];

    // 从 observedTransition.invariantsChecked 提取
    if (runResult.observedTransition?.invariantsChecked) {
      invariantsList.push(...runResult.observedTransition.invariantsChecked);
    }
    // 从 businessValidation.failedInvariants 提取
    const bvFailedInvariants = (runResult.verifyResult?.businessValidation as any)?.failedInvariants;
    if (Array.isArray(bvFailedInvariants)) {
      invariantsList.push(...bvFailedInvariants);
    }
    // 从 verifyResult.invariants 提取
    if (runResult.verifyResult?.invariants) {
      const inv = runResult.verifyResult.invariants;
      if (inv.antiDoubleBilling === false) invariantsList.push('antiDoubleBilling');
      if (inv.netChargeZero === false) invariantsList.push('netChargeZero');
      if (inv.refundIdempotency === false) invariantsList.push('refundIdempotency');
    }
    // 语义推导：防重扣 -> antiDoubleBilling, 媒体损坏 -> mediaFormatValid
    if (reasons.some((r) => r.includes('防重扣') || r.includes('FP-004') || r.includes('antiDoubleBilling'))) {
      invariantsList.push('antiDoubleBilling');
    }
    if (reasons.some((r) => r.includes('媒体') || r.includes('FP-002') || r.includes('media'))) {
      invariantsList.push('mediaFormatValid');
    }

    const failedInvariants = Array.from(new Set([...invariantsList, ...reasons, rawAnomaly])).filter(Boolean);

    // 确保 discoveredAnomaly 包含 actionType 以便 Policy 直接检索
    const discoveredAnomaly = `${actionType}_${rawAnomaly}`;

    experiences.push({
      experienceId: `exp_defect_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      discoveredTransitionId: transitionId,
      discoveredAnomaly,
      causalChain: [fromKey, actionType, toKey, ...(reasons.length > 0 ? reasons : [rawAnomaly])],
      policyDirectives: {
        boostMultiplier: 3.0, // 确诊缺陷赋予强加成
        mandatoryInvariants: failedInvariants.length > 0 ? failedInvariants : ['netChargeZero'],
        priorityStatesToExplore: [fromKey],
      },
      confidence: 0.98,
      createdAt: Date.now(),
    });

    return experiences;
  }

  // 4. 场景 B: 验证存在凭证缺口 (Evidence Gap / UNVERIFIED)
  if (runResult.verifyResult?.verdict === 'UNVERIFIED') {
    const reasons = runResult.verifyResult.reasons || [];
    experiences.push({
      experienceId: `exp_unverified_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      discoveredTransitionId: transitionId,
      discoveredAnomaly: `${actionType}_EVIDENCE_INSUFFICIENT_UNVERIFIED`,
      causalChain: [fromKey, actionType, toKey, 'PHYSICAL_EVIDENCE_INCOMPLETE', ...reasons],
      policyDirectives: {
        boostMultiplier: 2.0,
        mandatoryInvariants: ['physicalEvidenceCompleteness'],
        priorityStatesToExplore: [fromKey],
      },
      confidence: 0.8, // 凭证不足，信心值 < 0.9
      createdAt: Date.now(),
    });

    return experiences;
  }

  // 5. 场景 C: 负向非法探测中零扣费未被流水证实 (Negative Probe Evidence Gap)
  if (
    runResult.status === 'NEGATIVE_PROBE_REJECTION_VERIFIED' &&
    runResult.rejectionEvidence &&
    !runResult.rejectionEvidence.zeroChargeProven
  ) {
    experiences.push({
      experienceId: `exp_negprobe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      discoveredTransitionId: transitionId,
      discoveredAnomaly: `${actionType}_NEGATIVE_PROBE_ZERO_CHARGE_UNPROVEN_BY_LEDGER`,
      causalChain: [
        'PARAMETER_OUT_OF_BOUNDS',
        'GATEWAY_REJECTED_TASK_ID_ZERO',
        'BILLING_ZERO_CHARGE_UNPROVEN_BY_LEDGER',
      ],
      policyDirectives: {
        boostMultiplier: 2.2,
        mandatoryInvariants: ['ledgerZeroChargeProof'],
        priorityStatesToExplore: [fromKey],
      },
      confidence: 0.85, // 具有探索价值的边界不确定性
      createdAt: Date.now(),
    });

    return experiences;
  }

  // 6. 场景 D: 正常无异常 PASS
  // 按照规范：不要把所有 PASS 都学习成经验。正常通过仅留在 StateGraph 作为基础跃迁，不生成缺陷干扰。
  return [];
}

/**
 * 从真实 StateGraph 跃迁记录中聚合出每个动作的已执行频次映射表
 * 用于给 ExplorationPolicy 真实计算 AlreadyCoveredPenalty
 */
export function buildActionHistoryCounts(stateGraph: PanquStateGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const trans of stateGraph.getAllTransitions()) {
    const signature = `${trans.fromKey}->${trans.actionType}`;
    const current = counts.get(signature) ?? 0;
    counts.set(signature, current + trans.historyCount);
  }
  return counts;
}

/**
 * 极简进程内因果经验仓库 (PanquLearningStore)
 * 严格保持 REAL 与 MOCK 隔离
 */
export class PanquLearningStore {
  private realExperiences: LearningExperience[] = [];
  private mockExperiences: LearningExperience[] = [];

  /**
   * 记录单条经验（内置去重与强化合并，避免相同物理失败重复记录导致经验库无意义膨胀）
   */
  public record(experience: LearningExperience, mode: 'real' | 'mock' = 'real'): void {
    const list = mode === 'real' ? this.realExperiences : this.mockExperiences;
    const existingIndex = list.findIndex(
      (e) =>
        e.discoveredAnomaly === experience.discoveredAnomaly &&
        (e.discoveredTransitionId === experience.discoveredTransitionId ||
          e.policyDirectives.priorityStatesToExplore[0] === experience.policyDirectives.priorityStatesToExplore[0]),
    );
    if (existingIndex >= 0) {
      const existing = list[existingIndex];
      existing.createdAt = experience.createdAt;
      existing.confidence = Math.max(existing.confidence, experience.confidence);
      existing.policyDirectives.boostMultiplier = Math.max(
        existing.policyDirectives.boostMultiplier,
        experience.policyDirectives.boostMultiplier,
      );
      return;
    }
    list.push(experience);
  }

  /**
   * 批量记录经验
   */
  public recordMany(experiences: LearningExperience[], mode: 'real' | 'mock' = 'real'): void {
    for (const exp of experiences) {
      this.record(exp, mode);
    }
  }

  /**
   * 获取沉淀的经验列表
   */
  public getExperiences(mode: 'real' | 'mock' = 'real'): LearningExperience[] {
    return mode === 'real' ? [...this.realExperiences] : [...this.mockExperiences];
  }

  /**
   * 清空经验（仅用于受控重置）
   */
  public clear(mode?: 'real' | 'mock'): void {
    if (!mode || mode === 'real') this.realExperiences = [];
    if (!mode || mode === 'mock') this.mockExperiences = [];
  }
}

/**
 * 辅助函数：将执行结果直接送入学习提取并存入仓库
 */
export function feedResultIntoLearning(
  runResult: MutationRunResult,
  store: PanquLearningStore,
  options: ExtractLearningOptions = {},
): LearningExperience[] {
  const experiences = extractLearningExperiences(runResult, options);
  if (experiences.length > 0) {
    const targetMode = options.allowMockLearning && runResult.mode === 'mock' ? 'mock' : runResult.mode;
    store.recordMany(experiences, targetMode);
  }
  return experiences;
}
