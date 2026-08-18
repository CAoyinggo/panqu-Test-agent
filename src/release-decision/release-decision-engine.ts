// Autonomous Release Decision Engine：AI 发布决策引擎（Phase 22.8）
// 三态决策：BLOCK（权威阻断信号）> REVIEW（软性风险信号）> PASS（全部达标）。
// 全部确定性信号推导 + 结构化证据，LLM 仅用于自然语言解释（本模块不调用 LLM）。

import {
  DEFAULT_RELEASE_DECISION_THRESHOLDS,
  type AutonomousReleaseDecision,
  type ReleaseDecisionInput,
  type ReleaseEvidence,
  type ReleaseDecisionThresholds,
} from './release-decision-schema.js';

/** 权威阻断信号类型（命中任一 → BLOCK） */
const HARD_SIGNAL_TYPES = new Set(['p0', 'critical-defect', 'environment']);

/** 信号内部形态 */
interface Signal {
  type: string;
  value: string;
  pass: boolean;
  label: string;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** 由输入信号推导发布决策（确定性、可复现、可解释） */
export function decideRelease(input: ReleaseDecisionInput): AutonomousReleaseDecision {
  const t: ReleaseDecisionThresholds = { ...DEFAULT_RELEASE_DECISION_THRESHOLDS, ...(input.thresholds ?? {}) };

  const p0Pass = input.p0.total > 0 ? input.p0.passed === input.p0.total : true;
  const p1Rate = input.p1.total > 0 ? input.p1.passed / input.p1.total : 1;
  const p1Pass = p1Rate >= t.p1PassRate;
  const coveragePass = input.coverage >= t.minCoverage;
  const criticalPass = input.criticalDefects <= 0;
  const envOk = !input.environmentAbnormal;
  const flakyPass = (input.flakyCount ?? 0) <= t.flakyTolerance;
  const knownPass = (input.knownIssues ?? 0) <= 0;
  const riskOk = (input.riskLevel ?? 'LOW') !== 'HIGH';
  const modelOk = !input.modelChange;
  const historyOk = (input.historicalFailureRate ?? 0) < t.historyThreshold;
  const predictionOk = (input.failurePrediction ?? 0) < t.predictionThreshold;

  const signals: Signal[] = [
    { type: 'p0', value: `${input.p0.passed}/${input.p0.total} passed`, pass: p0Pass, label: 'P0 全部通过' },
    { type: 'p1-passrate', value: `${(p1Rate * 100).toFixed(1)}%`, pass: p1Pass, label: `P1 通过率 ≥ ${(t.p1PassRate * 100).toFixed(0)}%` },
    { type: 'coverage', value: `${(input.coverage * 100).toFixed(1)}%`, pass: coveragePass, label: `Coverage ≥ ${(t.minCoverage * 100).toFixed(0)}%` },
    { type: 'critical-defect', value: `${input.criticalDefects} open`, pass: criticalPass, label: 'Critical Defect = 0' },
    { type: 'risk', value: input.riskLevel ?? 'LOW', pass: riskOk, label: '整体风险非 HIGH' },
    { type: 'failure-prediction', value: `${((input.failurePrediction ?? 0) * 100).toFixed(0)}%`, pass: predictionOk, label: `失败预测 < ${(t.predictionThreshold * 100).toFixed(0)}%` },
    { type: 'historical-failure', value: `${((input.historicalFailureRate ?? 0) * 100).toFixed(1)}%`, pass: historyOk, label: `历史失败率 < ${(t.historyThreshold * 100).toFixed(0)}%` },
    { type: 'model-change', value: input.modelChange ? 'detected' : 'none', pass: modelOk, label: '无模型变更' },
    { type: 'environment', value: input.environmentAbnormal ? 'abnormal' : 'normal', pass: envOk, label: '环境正常' },
    { type: 'flaky', value: `${input.flakyCount ?? 0} cases`, pass: flakyPass, label: `不稳定用例 ≤ ${t.flakyTolerance}` },
    { type: 'known-issue', value: `${input.knownIssues ?? 0} open`, pass: knownPass, label: '无已知问题' },
  ];

  const hardFailures = signals.filter((s) => !s.pass && HARD_SIGNAL_TYPES.has(s.type));
  const softFailures = signals.filter((s) => !s.pass && !HARD_SIGNAL_TYPES.has(s.type));

  let decision: AutonomousReleaseDecision['decision'];
  if (hardFailures.length > 0) decision = 'BLOCK';
  else if (softFailures.length > 0) decision = 'REVIEW';
  else decision = 'PASS';

  // 确定性置信度：
  //   BLOCK  0.5 + 0.12 × (阻断 + 软信号失败数)，上限 0.98
  //   REVIEW 0.5 + 0.08 × 软信号失败数，上限 0.9
  //   PASS   0.85（全部门禁与风险信号达标）
  let confidence: number;
  if (decision === 'BLOCK') {
    confidence = Math.min(0.98, Math.round(clamp01(0.5 + 0.12 * (hardFailures.length + softFailures.length)) * 100) / 100);
  } else if (decision === 'REVIEW') {
    confidence = Math.min(0.9, Math.round(clamp01(0.5 + 0.08 * softFailures.length) * 100) / 100);
  } else {
    confidence = 0.85;
  }

  const blockingFactors = hardFailures.map((s) => `${s.label}：实际 ${s.value}`);
  const reasons = signals.filter((s) => !s.pass).map((s) => `${s.label} 未满足：实际 ${s.value}`);

  return {
    decision,
    confidence,
    reasons: reasons.length > 0 ? reasons : ['所有发布门禁与风险信号均达标'],
    blockingFactors,
    recommendedActions: buildRecommendedActions(decision, hardFailures, softFailures),
    evidence: signals.map((s): ReleaseEvidence => ({ type: s.type, value: s.value })),
  };
}

/** 建议动作（按命中信号推导，确定性） */
function buildRecommendedActions(
  decision: AutonomousReleaseDecision['decision'],
  hard: Signal[],
  soft: Signal[],
): string[] {
  if (decision === 'PASS') return ['允许发布'];
  const hardTypes = new Set(hard.map((s) => s.type));
  const softTypes = new Set(soft.map((s) => s.type));
  const actions: string[] = [];
  if (hardTypes.has('p0')) actions.push('修复 P0 失败用例并重新回归');
  if (hardTypes.has('critical-defect')) actions.push('关闭 Critical 缺陷后再发布');
  if (hardTypes.has('environment')) actions.push('修复测试环境后重新验证');
  if (softTypes.has('p1-passrate')) actions.push('补充 P1 回归，提升通过率');
  if (softTypes.has('coverage')) actions.push('补充测试覆盖，提升覆盖率');
  if (softTypes.has('risk') || softTypes.has('failure-prediction') || softTypes.has('historical-failure')) {
    actions.push('评估高风险区域并追加针对性测试');
  }
  if (softTypes.has('model-change')) actions.push('对模型变更范围补充回归验证');
  if (softTypes.has('flaky')) actions.push('隔离不稳定用例并复核');
  if (softTypes.has('known-issue')) actions.push('评估已知问题影响面并确认豁免');
  if (actions.length === 0) actions.push('人工评审确认风险后可发布');
  return actions;
}
