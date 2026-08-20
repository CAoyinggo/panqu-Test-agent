// Risk Evaluator（Phase 45 / 42.5）：风险评估评估
// 调用确定性风险分析（parseRequirement + analyzeRisks）得到风险类别集合，
// 与独立人工核验的 expectedCategories / criticalCategories 比对。
// 指标：Precision / Recall / F1 / 混淆矩阵 / Critical Miss Rate（P0 漏判率）。
import { parseRequirement } from '../../agents/requirement/requirement-parser.js';
import { analyzeRisks } from '../../agents/risk/risk-analyzer.js';
import type { RiskGroundTruth } from '../benchmark/data/risk.js';
import { isPassed, roundScore } from '../score.js';
import { setScore } from '../metrics.js';
import type { EvaluationCase, EvaluationResult } from '../contract.js';

/** 风险类别全集（风险分析器可产出的类别） */
export const RISK_EVAL_CATEGORIES = [
  'dependency', 'data', 'boundary', 'concurrency', 'billing',
  'security', 'environment', 'compatibility', 'timeout', 'retry',
] as const;

export function evaluateRisk(c: EvaluationCase<{ text: string; testCases: Parameters<typeof analyzeRisks>[0]['testCases']; environment?: string }, RiskGroundTruth>): EvaluationResult {
  const errors: string[] = [];
  let actualCategories: string[] = [];
  let highCategories: string[] = [];
  let feature = '';
  try {
    const requirement = parseRequirement(c.input.text);
    feature = requirement.feature;
    const assessment = analyzeRisks({
      requirement,
      testCases: c.input.testCases ?? [],
      environment: c.input.environment,
    });
    actualCategories = Array.from(new Set(assessment.risks.map((r) => r.category)));
    highCategories = Array.from(new Set(assessment.risks.filter((r) => r.level === 'high').map((r) => r.category)));
  } catch (e) {
    errors.push(`风险评估失败：${(e as Error).message}`);
  }

  const gt = c.groundTruth;
  const s = setScore(actualCategories, gt.expectedCategories);
  // Critical Miss：关键（P0 等价）类别必须被识别为高风险级别；未识别或仅低级别 → 漏判
  const criticalMiss = gt.criticalCategories.filter((cat) => !highCategories.includes(cat));
  const criticalMissRate = gt.criticalCategories.length === 0 ? 0 : criticalMiss.length / gt.criticalCategories.length;
  const score = roundScore(0.6 * s.f1 + 0.4 * (1 - criticalMissRate));

  if (criticalMiss.length > 0) errors.push(`Critical Miss：高风险类别漏判 ${criticalMiss.join(', ')}（P0 Miss ≠ 0 → WARN）`);
  const falsePositives = actualCategories.filter((cat) => !gt.expectedCategories.includes(cat));
  if (falsePositives.length > 0) errors.push(`误报类别：${falsePositives.join(', ')}`);

  return {
    caseId: c.id,
    domain: 'RISK',
    score,
    passed: isPassed(score),
    tracked: true,
    expected: { ...gt, feature },
    actual: { categories: actualCategories, highCategories, feature },
    errors,
    evidence: [
      `识别类别：${actualCategories.join(',') || '无'}`,
      `高优类别：${highCategories.join(',') || '无'}`,
      `期望类别 Recall=${s.recall.toFixed(2)} / Precision=${s.precision.toFixed(2)} / F1=${s.f1.toFixed(2)}`,
      `Critical Miss Rate=${criticalMissRate.toFixed(2)}${criticalMiss.length ? `（漏判 ${criticalMiss.join(',')}）` : '（=0）'}`,
    ],
  };
}
