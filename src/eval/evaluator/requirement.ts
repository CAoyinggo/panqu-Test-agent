// Requirement Evaluator（Phase 45 / 42.3）：需求理解评估
// 调用确定性需求解析器（parseRequirement）得到 feature / capabilities / inputs /
// businessRules / risks，与独立人工核验的 groundTruth 比对。
// 指标：Completeness（各字段 F1）/ Precision / Recall / F1。
import { parseRequirement } from '../../agents/requirement/requirement-parser.js';
import type { RequirementGroundTruth } from '../benchmark/data/requirement.js';
import { isPassed, roundScore } from '../score.js';
import { setScore, exactMatch } from '../metrics.js';
import type { EvaluationCase, EvaluationResult } from '../contract.js';

/** 逐字段 F1 汇总（需求理解完整度） */
export interface RequirementBreakdown {
  feature: number;
  capabilities: { precision: number; recall: number; f1: number };
  inputs: { precision: number; recall: number; f1: number };
  businessRules: { precision: number; recall: number; f1: number };
  risks: { precision: number; recall: number; f1: number };
  overall: number;
}

export function evaluateRequirement(c: EvaluationCase<{ text: string }, RequirementGroundTruth>): EvaluationResult {
  const errors: string[] = [];
  let actual: Record<string, unknown>;
  try {
    const req = parseRequirement(c.input.text);
    actual = {
      feature: req.feature,
      capabilities: req.capabilities,
      inputs: req.inputs,
      businessRules: req.businessRules,
      risks: req.risks ?? [],
    };
  } catch (e) {
    errors.push(`需求解析失败：${(e as Error).message}`);
    actual = { feature: '', capabilities: [], inputs: [], businessRules: [], risks: [] };
  }

  const gt = c.groundTruth;
  const feature = exactMatch(actual.feature, gt.feature);
  const capabilities = setScore(asStringArray(actual.capabilities), gt.capabilities);
  const inputs = setScore(asStringArray(actual.inputs), gt.inputs);
  const businessRules = setScore(asStringArray(actual.businessRules), gt.businessRules);
  const risks = setScore(asStringArray(actual.risks), gt.risks);

  // 权重：feature 0.15 / capabilities 0.3 / inputs 0.2 / businessRules 0.2 / risks 0.15
  const score = roundScore(
    0.15 * feature
    + 0.3 * capabilities.f1
    + 0.2 * inputs.f1
    + 0.2 * businessRules.f1
    + 0.15 * risks.f1,
  );

  const breakdown: RequirementBreakdown = {
    feature,
    capabilities,
    inputs,
    businessRules,
    risks,
    overall: score,
  };

  return {
    caseId: c.id,
    domain: 'REQUIREMENT',
    score,
    passed: isPassed(score),
    tracked: true,
    expected: gt,
    actual,
    errors,
    evidence: [
      `feature: ${actual.feature}（期望 ${gt.feature}）`,
      `capabilities F1=${capabilities.f1.toFixed(2)}：${asStringArray(actual.capabilities).join(',') || '无'}`,
      `inputs F1=${inputs.f1.toFixed(2)}：${asStringArray(actual.inputs).join(',') || '无'}`,
      `businessRules F1=${businessRules.f1.toFixed(2)}：${asStringArray(actual.businessRules).join(';') || '无'}`,
      `risks F1=${risks.f1.toFixed(2)}：${asStringArray(actual.risks).join(',') || '无'}`,
      ...(score < 1 ? ['存在字段未完全命中，详见 Expected/Actual 对比'] : []),
    ],
  };
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}
