// Test Design Evaluator（Phase 45 / 42.4）：测试设计评估
// 评估 AI 生成的 TestCase：功能/边界/异常覆盖、关键用例存在性、重复率、可执行性。
// 产出 Coverage Score / Redundancy Score / Executability Score，
// 并识别 Duplicate Test / Low-value Test / Missing Critical Test。
import type { TestCase } from '../../agents/test-design/testcase-schema.js';
import type { TestDesignGroundTruth } from '../benchmark/data/test-design.js';
import { isPassed, roundScore } from '../score.js';
import type { EvaluationCase, EvaluationResult } from '../contract.js';

/** 重复检测：同名用例两两配对（Deterministic First） */
export function countDuplicatePairs(cases: TestCase[]): number {
  const byName = new Map<string, number>();
  for (const c of cases) {
    const key = `${c.name}::${c.priority}::${c.tags.slice().sort().join(',')}`;
    byName.set(key, (byName.get(key) ?? 0) + 1);
  }
  let pairs = 0;
  for (const n of byName.values()) {
    if (n >= 2) pairs += (n * (n - 1)) / 2;
  }
  return pairs;
}

/** 可执行性：至少 1 步 + 至少 1 条断言 */
export function isExecutable(c: TestCase): boolean {
  return (c.steps?.length ?? 0) >= 1 && (c.assertions?.length ?? 0) >= 1;
}

/** 覆盖得分：requiredCoverageTags 在用例标签并集中的命中率 */
function coverageScore(cases: TestCase[], required: string[]): { score: number; missing: string[] } {
  if (required.length === 0) return { score: 1, missing: [] };
  const tags = new Set(cases.flatMap((c) => c.tags ?? []).map((t) => t.toLowerCase()));
  const missing = required.filter((r) => !tags.has(r.toLowerCase()));
  return { score: (required.length - missing.length) / required.length, missing };
}

export function evaluateTestDesign(c: EvaluationCase<{ testCases: TestCase[] }, TestDesignGroundTruth>): EvaluationResult {
  const errors: string[] = [];
  const cases = c.input.testCases ?? [];
  const gt = c.groundTruth;

  // 1. Coverage Score
  const cov = coverageScore(cases, gt.requiredCoverageTags);
  // 2. Critical 存在性
  const ids = new Set(cases.map((tc) => tc.id));
  const missingCritical = gt.criticalCaseIds.filter((id) => !ids.has(id));
  const criticalScore = gt.criticalCaseIds.length === 0 ? 1 : (gt.criticalCaseIds.length - missingCritical.length) / gt.criticalCaseIds.length;
  // 3. Redundancy Score（与实际重复对数的接近度）
  const duplicates = countDuplicatePairs(cases);
  const redundancyScore = gt.expectedDuplicateCount === duplicates
    ? 1
    : Math.max(0, 1 - Math.abs(gt.expectedDuplicateCount - duplicates) / Math.max(1, gt.expectedDuplicateCount));
  // 4. Executability Score
  const allExecutable = cases.length > 0 ? cases.every(isExecutable) : true;
  const executabilityScore = allExecutable === gt.expectedExecutable ? 1 : 0;

  const score = roundScore(
    0.35 * cov.score
    + 0.3 * criticalScore
    + 0.2 * redundancyScore
    + 0.15 * executabilityScore,
  );

  // 错误分析：识别 Duplicate / Low-value / Missing Critical
  if (duplicates > 0) errors.push(`检测到 ${duplicates} 对重复用例（同名/同标签/同优先级）`);
  if (missingCritical.length > 0) errors.push(`关键用例缺失：${missingCritical.join(', ')}`);
  if (cases.filter((tc) => tc.priority === 'P3').length === cases.length && cases.length > 0) errors.push('全部为低价值 P3 用例（缺少 P0/P1 核心用例）');
  if (!allExecutable) errors.push('存在不可执行用例（无断言或无常量步骤）');
  if (cov.missing.length > 0) errors.push(`覆盖缺失：${cov.missing.join(', ')}`);

  return {
    caseId: c.id,
    domain: 'TEST_DESIGN',
    score,
    passed: isPassed(score),
    tracked: true,
    expected: gt,
    actual: {
      caseCount: cases.length,
      coverageTags: Array.from(new Set(cases.flatMap((tc) => tc.tags ?? []))),
      duplicatePairs: duplicates,
      allExecutable,
      criticalPresent: gt.criticalCaseIds.filter((id) => ids.has(id)),
      criticalMissing: missingCritical,
    },
    errors,
    evidence: [
      `Coverage Score=${cov.score.toFixed(2)}${cov.missing.length ? `（缺 ${cov.missing.join(',')}）` : ''}`,
      `Redundancy Score=${redundancyScore.toFixed(2)}（实际重复 ${duplicates} 对，期望 ${gt.expectedDuplicateCount}）`,
      `Executability Score=${executabilityScore.toFixed(2)}（全部可执行=${allExecutable}，期望=${gt.expectedExecutable}）`,
      `Critical 存在=${criticalScore.toFixed(2)}${missingCritical.length ? `（缺 ${missingCritical.join(',')}）` : ''}`,
    ],
  };
}
