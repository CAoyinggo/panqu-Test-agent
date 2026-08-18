// Regression Planner：回归计划器（Phase 21.3）
// 职责：变更 → 影响分析 → 测试选择 → P0/P1 回归计划。不要每次都执行全部 Case。
// 选择策略与 TestSelectionAgent 对齐：P0/P1 全量、P2/P3 影响命中直选、预算超限反向裁剪。

import type { TestAsset } from '../test-assets/asset-schema.js';
import { generateRunId, type ImpactAnalysis, type RegressionPlan, type RegressionTriggerType } from './regression-schema.js';

/** 回归计划选项 */
export interface RegressionPlanOptions {
  /** 预算：最大用例数（超出从 P2 开始裁剪） */
  maxCases?: number;
  /** 是否包含 P3 用例（默认 false：回归聚焦 P0/P1/P2） */
  includeP3?: boolean;
}

/** 从资产提取优先级（content.priority > tags 中的 P0~P3 > 默认 P2） */
export function assetPriority(asset: TestAsset): 'P0' | 'P1' | 'P2' | 'P3' {
  const content = asset.content as { priority?: unknown } | undefined;
  const fromContent = typeof content?.priority === 'string' ? content.priority.toUpperCase() : '';
  if (/^P[0-3]$/.test(fromContent)) return fromContent as 'P0';
  const fromTag = asset.tags.find((t) => /^P[0-3]$/i.test(t));
  if (fromTag) return fromTag.toUpperCase() as 'P0';
  return 'P2';
}

/**
 * 生成回归计划：仅选择受影响用例，按优先级分层，预算超限从 P2 裁剪。
 * @param impact 影响分析结果
 * @param candidates 全部候选用例资产（通常为资产库中该 feature 的 test-case）
 */
export function planRegression(
  impact: ImpactAnalysis,
  candidates: TestAsset[],
  trigger: RegressionTriggerType,
  options: RegressionPlanOptions = {},
): RegressionPlan {
  const affected = new Set(impact.affectedCases);
  const reasons: Record<string, string> = {};
  const buckets: Record<'P0' | 'P1' | 'P2' | 'P3', string[]> = { P0: [], P1: [], P2: [], P3: [] };
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const asset of candidates) {
    if (!affected.has(asset.id)) {
      skipped.push({ id: asset.id, reason: '未受本次变更影响' });
      continue;
    }
    const priority = assetPriority(asset);
    if (priority === 'P3' && !options.includeP3) {
      skipped.push({ id: asset.id, reason: 'P3 用例不进入回归（includeP3=false）' });
      continue;
    }
    buckets[priority].push(asset.id);
    reasons[asset.id] = `受影响用例（${priority}）：变更「${impact.change.target}」`;
  }
  for (const key of Object.keys(buckets) as Array<keyof typeof buckets>) buckets[key].sort();

  // 预算裁剪：从 P2 开始（保 P0/P1）
  let selectedCount = buckets.P0.length + buckets.P1.length + buckets.P2.length + buckets.P3.length;
  if (options.maxCases && selectedCount > options.maxCases) {
    const overflow = selectedCount - options.maxCases;
    const trimmed = buckets.P2.splice(buckets.P2.length - Math.min(overflow, buckets.P2.length));
    for (const id of trimmed) {
      skipped.push({ id, reason: '预算裁剪（P2 超出 maxCases）' });
      delete reasons[id];
    }
    selectedCount -= trimmed.length;
    if (selectedCount > options.maxCases) {
      const rest = buckets.P3.splice(0, selectedCount - options.maxCases);
      for (const id of rest) {
        skipped.push({ id, reason: '预算裁剪（P3 超出 maxCases）' });
        delete reasons[id];
      }
    }
  }

  return {
    runId: generateRunId(),
    trigger,
    change: impact.change,
    impact,
    selected: { p0: buckets.P0, p1: buckets.P1, p2: [...buckets.P2, ...buckets.P3].sort() },
    skipped,
    reasons,
    createdAt: new Date().toISOString(),
  };
}

/** 计划摘要：各优先级数量与跳过数 */
export function summarizePlan(plan: RegressionPlan): { p0: number; p1: number; p2: number; skipped: number; total: number } {
  return {
    p0: plan.selected.p0.length,
    p1: plan.selected.p1.length,
    p2: plan.selected.p2.length,
    skipped: plan.skipped.length,
    total: plan.selected.p0.length + plan.selected.p1.length + plan.selected.p2.length,
  };
}
