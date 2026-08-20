// RCA Evaluator（Phase 45 / 42.7）：根因分析评估
// 调用确定性失败分类器（classifyFailure）得到 Predicted Category，
// 与 groundTruth 的 Actual Category 比对。
// 指标：RCA Accuracy（Top-1）/ Unknown Rate / False Root Cause Rate；
// Top-3 用于 LLM 排名输出，规则分类器为 Top-1 确定性输出。
import { classifyFailure, type ClassifierInput } from '../../agents/analysis/failure-classifier.js';
import type { RcaGroundTruth } from '../benchmark/data/rca.js';
import { isPassed, roundScore } from '../score.js';
import { exactMatch } from '../metrics.js';
import type { EvaluationCase, EvaluationResult } from '../contract.js';

export function evaluateRca(c: EvaluationCase<ClassifierInput, RcaGroundTruth>): EvaluationResult {
  const errors: string[] = [];
  let category = 'UNKNOWN';
  let confidence = 0;
  let reasons: string[] = [];
  try {
    const result = classifyFailure(c.input);
    category = result.category;
    confidence = result.confidence;
    reasons = result.reasons;
  } catch (e) {
    errors.push(`RCA 分类失败：${(e as Error).message}`);
  }

  const expected = c.groundTruth.category;
  const score = roundScore(exactMatch(category, expected));
  const isUnknown = category === 'UNKNOWN';

  if (!isPassed(score)) {
    errors.push(`根因分类错误：期望 ${expected}，实际 ${category}`);
  }
  if (isUnknown) errors.push('Unknown：无法归类（低置信兜底）');

  return {
    caseId: c.id,
    domain: 'RCA',
    score,
    passed: isPassed(score),
    tracked: true,
    expected: c.groundTruth,
    actual: { category, confidence, reasons },
    errors,
    evidence: [
      `Predicted=${category} / Actual=${expected}`,
      `置信度=${confidence.toFixed(2)}`,
      ...reasons.slice(0, 3).map((r) => `依据：${r}`),
    ],
  };
}
