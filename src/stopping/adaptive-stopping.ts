// Adaptive Stopping：实时停止判定（Phase 22.4）
// 多条件 OR 判定 + 防过早停止保护（最少已执行数）。全部确定性，可解释。

import { clamp01 } from '../intelligence/index.js';
import {
  DEFAULT_STOPPING_RULES,
  type StoppingCondition,
  type StoppingDecision,
  type StoppingInput,
  type StoppingRules,
} from './stopping-schema.js';

/** 评估停止判定 */
export function evaluateStopping(input: StoppingInput): StoppingDecision {
  const rules: StoppingRules = { ...DEFAULT_STOPPING_RULES, ...(input.rules ?? {}) };
  const coverage = clamp01(input.coverage);
  const riskCoverage = clamp01(input.riskCoverage);
  const p0Coverage = clamp01(input.p0Coverage);
  const remaining = input.remainingCases ?? [];
  const executed = input.executedCases ?? 0;
  const budgetUsed = clamp01(input.budgetUsedRatio);
  const infoGain = input.infoGain === undefined ? null : clamp01(input.infoGain);

  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

  // 逐条件评估
  const conditions: StoppingCondition[] = [
    {
      name: 'p0-covered',
      satisfied: p0Coverage >= rules.minP0Coverage,
      detail: `P0 覆盖 ${pct(p0Coverage)} ≥ ${pct(rules.minP0Coverage)}`,
    },
    {
      name: 'risk-covered',
      satisfied: riskCoverage >= rules.minRiskCoverage,
      detail: `风险覆盖 ${pct(riskCoverage)} ≥ ${pct(rules.minRiskCoverage)}`,
    },
    {
      name: 'coverage-met',
      satisfied: coverage >= rules.minCoverage,
      detail: `覆盖 ${pct(coverage)} ≥ ${pct(rules.minCoverage)}`,
    },
    {
      name: 'low-info-gain',
      satisfied: infoGain !== null && infoGain < rules.lowInfoGainThreshold,
      detail:
        infoGain === null
          ? '剩余用例无信息增益评估'
          : `剩余用例信息增益 ${(infoGain * 100).toFixed(0)}% < ${(rules.lowInfoGainThreshold * 100).toFixed(0)}%`,
    },
    {
      name: 'release-block',
      satisfied: Boolean(input.p0Failed || input.criticalDefect),
      detail: input.p0Failed ? 'P0 用例失败，Release 判定 BLOCK' : input.criticalDefect ? '存在 Critical 缺陷' : '无阻断性失败',
    },
    {
      name: 'budget-limit',
      satisfied: budgetUsed >= rules.budgetWarningRatio,
      detail: `预算已用 ${pct(budgetUsed)} ≥ ${pct(rules.budgetWarningRatio)}`,
    },
    {
      name: 'environment-abnormal',
      satisfied: Boolean(input.environmentAbnormal),
      detail: input.environmentAbnormal ? '测试环境异常' : '环境正常',
    },
  ];

  const satisfied = conditions.filter((c) => c.satisfied);
  const blocks: string[] = [];
  if (executed < rules.minExecutedCases) {
    blocks.push(`已执行 ${executed} 个用例 < 最少 ${rules.minExecutedCases} 个（防过早停止）`);
  }

  // 强制停止条件：环境异常 / Release BLOCK / 预算上限（无条件触发）
  const hardStop =
    Boolean(input.environmentAbnormal) ||
    Boolean(input.p0Failed || input.criticalDefect) ||
    budgetUsed >= rules.budgetWarningRatio;

  // 安全停止条件：Coverage / Risk / 低信息增益（P0 全覆盖仅作门禁，不单独触发）
  const safeStopNames = new Set<StoppingCondition['name']>(['coverage-met', 'risk-covered', 'low-info-gain']);
  const safeStopHit = satisfied.some((c) => safeStopNames.has(c.name));
  // P0 门禁：安全停止必须保证 P0 已全覆盖（除非已是 BLOCK 场景）
  const releaseBlockHit = Boolean(input.p0Failed || input.criticalDefect);
  const p0Gate = p0Coverage >= rules.minP0Coverage || releaseBlockHit;

  const stop = (hardStop || (safeStopHit && p0Gate)) && blocks.length === 0;

  // 置信度：命中条件越多越确信；被阻断则低；上限 0.98
  const confidence = Math.round(Math.min(0.98, clamp01(0.6 + satisfied.length * 0.08 - (blocks.length > 0 ? 0.4 : 0))) * 100) / 100;

  const reason = stop
    ? `自动停止：${satisfied.map((c) => c.detail).join('；')}`
    : blocks.length > 0
      ? `继续执行：${blocks.join('；')}`
      : p0Gate === false
        ? `继续执行：P0 未全覆盖（${pct(p0Coverage)} < ${pct(rules.minP0Coverage)}），不能过早停止`
        : `继续执行：所有停止条件均未满足（当前覆盖 ${pct(coverage)}，风险覆盖 ${pct(riskCoverage)}）`;

  return {
    stop,
    reason,
    confidence,
    remainingCases: remaining,
    riskCoverage,
    coverage,
    p0Coverage,
    conditions,
    blocks,
  };
}
