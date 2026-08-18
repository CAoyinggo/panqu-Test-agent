// Exploration Testing Engine：探索性测试引擎（Phase 22 通用）
// 确定性生成新测试输入：参数空间组合 / 覆盖缺口 / 历史失败。
// 门禁：Budget（maxExplorationCases / maxExplorationCost）、Risk（高风险需授权）、
// Permission（生产危险动作需授权）。不得无限生成。

import {
  DEFAULT_EXPLORATION_CONFIG,
  type ExplorationCandidate,
  type ExplorationConfig,
  type ExplorationInput,
  type ExplorationResult,
  type ExplorationSource,
} from './exploration-schema.js';

/** 组合参数空间：笛卡尔积，限定最大生成数，避免组合爆炸 */
export function buildParameterCandidates(
  parameterSpace: Record<string, string[]>,
  existingCaseIds: Set<string>,
  max: number,
): ExplorationCandidate[] {
  const keys = Object.keys(parameterSpace).sort();
  if (keys.length === 0) return [];
  const combos: string[][] = [[]];
  for (const key of keys) {
    const values = [...parameterSpace[key]].sort();
    if (combos.length * values.length > 1000) break; // 防组合爆炸
    const next: string[][] = [];
    for (const base of combos) for (const v of values) next.push([...base, `${key}=${v}`]);
    combos.length = 0;
    combos.push(...next);
  }
  const out: ExplorationCandidate[] = [];
  let seq = 0;
  for (const combo of combos) {
    if (out.length >= max) break;
    const id = `explore-param-${String(seq + 1).padStart(3, '0')}`;
    if (existingCaseIds.has(id)) continue;
    seq += 1;
    out.push({
      id,
      tags: combo,
      estimatedCost: 0.4,
      reason: `参数空间组合探索（${combo.join(' + ') || '无参数'}）`,
      source: 'parameter',
      riskScore: 0.3,
      approved: true,
    });
  }
  return out;
}

/** 生成探索候选（确定性） */
export function generateExplorations(input: ExplorationInput): ExplorationResult {
  const config: ExplorationConfig = { ...DEFAULT_EXPLORATION_CONFIG, ...(input.config ?? {}) };
  const existing = new Set(input.existingCaseIds);
  const approveHighRisk = input.approveHighRisk ?? false;
  const candidates: ExplorationCandidate[] = [];
  const rejected: ExplorationCandidate[] = [];

  const pushCandidate = (c: ExplorationCandidate): boolean => {
    const cand: ExplorationCandidate = {
      ...c,
      estimatedDurationMs: c.estimatedDurationMs ?? (c.source === 'history' ? 40000 : 20000),
      status: 'GENERATED',
    };
    // 总尝试上限（max×2），防止 rejected 无限增长
    if (candidates.length + rejected.length >= config.maxExplorationCases * 2) return false;
    if (candidates.length >= config.maxExplorationCases) {
      rejected.push({ ...cand, approved: false, status: 'REJECTED', blockedReason: '预算不足（maxExplorationCases 达到上限）' });
      return false;
    }
    if (candidates.reduce((s, x) => s + x.estimatedCost, 0) + cand.estimatedCost > config.maxExplorationCost) {
      rejected.push({ ...cand, approved: false, status: 'REJECTED', blockedReason: '预算不足（maxExplorationCost 达到上限）' });
      return false;
    }
    if (candidates.reduce((s, x) => s + (x.estimatedDurationMs ?? 0), 0) + (cand.estimatedDurationMs ?? 0) > config.maxExplorationDuration) {
      rejected.push({ ...cand, approved: false, status: 'REJECTED', blockedReason: '预算不足（maxExplorationDuration 达到上限）' });
      return false;
    }
    // Risk 门禁：高风险探索需授权
    if (config.requirePermissionForHighRisk && cand.riskScore >= config.riskGateThreshold && !approveHighRisk) {
      rejected.push({ ...cand, approved: false, status: 'REJECTED', blockedReason: '高风险探索需人工授权（permission required）' });
      return false;
    }
    // Permission 门禁：生产危险动作需授权
    if (cand.tags.some((t) => t.toLowerCase().includes('production')) && !approveHighRisk) {
      rejected.push({ ...cand, approved: false, status: 'REJECTED', blockedReason: '生产环境危险动作需人工授权' });
      return false;
    }
    candidates.push(cand);
    return true;
  };

  // 1) 参数空间组合
  const paramSpace = { ...DEFAULT_EXPLORATION_CONFIG.parameterSpace, ...(input.parameterSpace ?? {}), ...(config.parameterSpace ?? {}) };
  for (const c of buildParameterCandidates(paramSpace, existing, config.maxExplorationCases)) pushCandidate(c);

  // 2) 覆盖缺口（预算门禁在 pushCandidate 内显式拒绝）
  for (const gap of input.coverageGaps ?? []) {
    pushCandidate({
      id: `explore-gap-${gap.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 12)}`,
      tags: [gap],
      estimatedCost: 0.3,
      reason: `覆盖缺口探索（${gap}）`,
      source: 'coverage-gap',
      riskScore: 0.4,
      approved: true,
    });
  }

  // 3) 历史失败（高风险探索）
  for (const h of input.historicalFailures ?? []) {
    pushCandidate({
      id: `explore-hist-${h.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 12)}`,
      tags: [h],
      estimatedCost: 0.6,
      reason: `历史失败区域探索（${h}）`,
      source: 'history',
      riskScore: 0.7,
      approved: false,
    });
  }

  const usedCount = candidates.length;
  const usedCost = candidates.reduce((s, c) => s + c.estimatedCost, 0);
  const usedDuration = candidates.reduce((s, c) => s + (c.estimatedDurationMs ?? 0), 0);
  const reason = buildReason(candidates, rejected, config);
  return { candidates: [...candidates, ...rejected], selected: candidates, rejected, usedCount, usedCost, usedDuration, reason };
}

/** 汇总原因（可解释） */
function buildReason(candidates: ExplorationCandidate[], rejected: ExplorationCandidate[], config: ExplorationConfig): string {
  const parts: string[] = [];
  if (candidates.length > 0) {
    parts.push(`生成 ${candidates.length} 个探索用例（预算内，成本 ${candidates.reduce((s, c) => s + c.estimatedCost, 0).toFixed(1)}）`);
  } else {
    parts.push('未生成探索用例');
  }
  if (rejected.length > 0) {
    const reasons = [...new Set(rejected.map((r) => r.blockedReason ?? '被拒绝'))];
    parts.push(`拒绝 ${rejected.length} 个：${reasons.join('；')}`);
  }
  parts.push(`上限：maxExplorationCases=${config.maxExplorationCases}，maxExplorationCost=${config.maxExplorationCost}，maxExplorationDuration=${config.maxExplorationDuration}ms`);
  return parts.join('。');
}

/** 来源统计 */
export function explorationBySource(candidates: ExplorationCandidate[]): Record<ExplorationSource, number> {
  const out = Object.fromEntries(
    (['coverage-gap', 'history', 'parameter', 'requirement'] as ExplorationSource[]).map((s) => [s, 0]),
  ) as Record<ExplorationSource, number>;
  for (const c of candidates) out[c.source] += 1;
  return out;
}
