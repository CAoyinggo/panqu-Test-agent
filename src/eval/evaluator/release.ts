// Release Evaluator（Phase 45 / 42.10）：发布决策评估
// 运行确定性发布决策（decideRelease）得到三态决策，
// 与独立人工核验的 groundTruth（PASS / REVIEW / BLOCK）比对。
// 指标：Accuracy / False Pass Rate / False Block Rate / False Review Rate /
// Critical Release Miss（应 BLOCK 却 PASS——最严重，目标 = 0）。
import { decideRelease } from '../../release-decision/release-decision-engine.js';
import type { ReleaseDecisionInput } from '../../release-decision/release-decision-schema.js';
import type { ReleaseGroundTruth } from '../benchmark/data/release.js';
import { isPassed } from '../score.js';
import { exactMatch } from '../metrics.js';
import type { EvaluationCase, EvaluationResult } from '../contract.js';

export type ReleaseVerdict = 'PASS' | 'REVIEW' | 'BLOCK';

export interface ReleaseActual {
  decision: ReleaseVerdict;
  confidence: number;
  reasons: string[];
  blockingFactors: string[];
}

export function evaluateRelease(
  c: EvaluationCase<ReleaseDecisionInput, ReleaseGroundTruth>,
): EvaluationResult {
  const errors: string[] = [];
  let actual: ReleaseActual = { decision: 'PASS', confidence: 0, reasons: [], blockingFactors: [] };
  try {
    const d = decideRelease(c.input);
    actual = { decision: d.decision, confidence: d.confidence, reasons: d.reasons, blockingFactors: d.blockingFactors };
  } catch (e) {
    errors.push(`发布决策失败：${(e as Error).message}`);
  }

  const gt = c.groundTruth;
  const correct = actual.decision === gt.decision;
  const score = exactMatch(actual.decision, gt.decision);

  // 错误类型分类（相对 groundTruth）
  const isFalsePass = gt.decision === 'BLOCK' && actual.decision === 'PASS'; // Critical Release Miss
  const isFalseBlock = gt.decision === 'PASS' && actual.decision === 'BLOCK';
  const isFalseReview = !correct && !isFalsePass && !isFalseBlock;

  if (!correct) {
    if (isFalsePass) errors.push(`Critical Release Miss：应 BLOCK 却 PASS（最严重，禁止放行）`);
    else if (isFalseBlock) errors.push(`False Block：应 PASS 却 BLOCK（过度拦截）`);
    else errors.push(`False Review：期望 ${gt.decision}，实际 ${actual.decision}`);
  }

  return {
    caseId: c.id,
    domain: 'RELEASE',
    score,
    passed: isPassed(score),
    tracked: true,
    expected: gt,
    actual,
    errors,
    evidence: [
      `决策=${actual.decision}（期望 ${gt.decision}）`,
      `置信度=${actual.confidence.toFixed(2)}`,
      `False Pass=${isFalsePass ? 1 : 0} / False Block=${isFalseBlock ? 1 : 0}`,
      ...actual.reasons.slice(0, 3).map((r) => `依据：${r}`),
    ],
  };
}
