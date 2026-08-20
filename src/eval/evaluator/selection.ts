// Selection Evaluator（Phase 45 / 42.6）：用例选择评估
// 调用确定性选择器（parseRequirement + selectTestCases）得到选中用例集，
// 与 groundTruth 的 mustRun / shouldSkip / criticalCaseIds 比对。
// 指标：Must-Run Recall / Critical Selection Recall / Precision@TopK /
// Skipped Critical Case Rate（跳过关键用例率）。
import { parseRequirement } from '../../agents/requirement/requirement-parser.js';
import { selectTestCases } from '../../agents/test-selection/selection-analyzer.js';
import type { SelectionInput, SelectionGroundTruth } from '../benchmark/data/selection.js';
import { isPassed, roundScore } from '../score.js';
import type { EvaluationCase, EvaluationResult } from '../contract.js';

export function evaluateSelection(
  c: EvaluationCase<SelectionInput, SelectionGroundTruth>,
): EvaluationResult {
  const errors: string[] = [];
  let selected: string[] = [];
  let skipped: string[] = [];
  try {
    const requirement = parseRequirement(c.input.text);
    const selection = selectTestCases({
      requirement,
      testCases: c.input.testCases,
      riskAssessment: c.input.riskAssessment,
      history: c.input.history,
      options: c.input.options,
    });
    selected = selection.selectedCases;
    skipped = selection.skippedCases ?? [];
  } catch (e) {
    errors.push(`用例选择失败：${(e as Error).message}`);
  }

  const gt = c.groundTruth;
  const sel = new Set(selected);
  const skp = new Set(skipped);

  // Must-Run Recall：必须执行的用例是否全部被选中
  const mustRunMissing = gt.mustRun.filter((id) => !sel.has(id));
  const mustRunRecall = gt.mustRun.length === 0 ? 1 : (gt.mustRun.length - mustRunMissing.length) / gt.mustRun.length;
  // Critical Selection Recall：关键用例是否全部选中
  const criticalMissing = gt.criticalCaseIds.filter((id) => !sel.has(id));
  const criticalRecall = gt.criticalCaseIds.length === 0 ? 1 : (gt.criticalCaseIds.length - criticalMissing.length) / gt.criticalCaseIds.length;
  // Skipped Critical Case Rate：关键用例被跳过（未选中）的比例
  const skippedCriticalRate = gt.criticalCaseIds.length === 0 ? 0 : criticalMissing.length / gt.criticalCaseIds.length;
  // Should-Skip 正确性：应跳过的用例是否全部未被选中
  const wronglySelected = gt.shouldSkip.filter((id) => sel.has(id));
  const skipRate = gt.shouldSkip.length === 0 ? 1 : (gt.shouldSkip.length - wronglySelected.length) / gt.shouldSkip.length;
  // Precision@TopK（k=mustRun 数量）：前 k 命中 mustRun 的比例
  const k = gt.mustRun.length;
  const topK = selected.slice(0, k);
  const precisionAtTopK = k === 0 ? 1 : topK.filter((id) => gt.mustRun.includes(id)).length / k;

  const score = roundScore(0.4 * mustRunRecall + 0.3 * criticalRecall + 0.2 * skipRate + 0.1 * precisionAtTopK);

  if (criticalMissing.length > 0) errors.push(`跳过关键用例：${criticalMissing.join(', ')}（Skipped Critical Case Rate=${skippedCriticalRate.toFixed(2)}）`);
  if (mustRunMissing.length > 0) errors.push(`漏选 Must-Run：${mustRunMissing.join(', ')}`);
  if (wronglySelected.length > 0) errors.push(`错误选中应跳过用例：${wronglySelected.join(', ')}`);

  return {
    caseId: c.id,
    domain: 'SELECTION',
    score,
    passed: isPassed(score),
    tracked: true,
    expected: gt,
    actual: { selected, skipped },
    errors,
    evidence: [
      `Must-Run Recall=${mustRunRecall.toFixed(2)}${mustRunMissing.length ? `（缺 ${mustRunMissing.join(',')}）` : ''}`,
      `Critical Selection Recall=${criticalRecall.toFixed(2)}`,
      `Skipped Critical Case Rate=${skippedCriticalRate.toFixed(2)}`,
      `Precision@TopK=${precisionAtTopK.toFixed(2)}`,
      `选中 ${selected.length} / 跳过 ${skipped.length}`,
    ],
  };
}
