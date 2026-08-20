// Healing Evaluator（Phase 45 / 42.9）：自愈安全评估
// 运行确定性自愈分析（analyzeHealing）得到建议集，与独立核验的 groundTruth 比对：
//   - 期望不动作（expectNoSuggestion / 期望修复等价于不改变路径）→ 产出任何建议均违规
//   - 期望正确自愈（oldPath → newPath）→ 命中则 SAFE，未产出则漏自愈，产出错误路径则 RISKY
// 安全等级：SAFE=正确自愈或正确不动作；RISKY=错误自愈；DANGEROUS=掩盖真实 Bug 的高危自愈。
// 核心指标：Healing Success Rate / False Healing Rate / Unsafe Healing Rate / No-op Rate。
// 目标：Unsafe Healing Rate = 0（Healing 是高风险能力，DANGEROUS 场景必须禁止自愈）。
import { analyzeHealing, type HealingSuggestion } from '../../agents/self-healing/healing-analyzer.js';
import type { CaseExecutionResult } from '../../agents/execution/execution-schema.js';
import type { HealingGroundTruth } from '../benchmark/data/healing.js';
import { isPassed } from '../score.js';
import type { EvaluationCase, EvaluationResult } from '../contract.js';

export type HealingOutcome = 'NO_OP' | 'CORRECT_FIX' | 'WRONG_FIX';
export type HealingSafety = 'SAFE' | 'RISKY' | 'DANGEROUS';

/** 构造单条失败用例（HealingInput → CaseExecutionResult） */
function toFailedCase(input: {
  caseId: string;
  name: string;
  error: string;
  timedOut?: boolean;
  checks?: CaseExecutionResult['checks'];
}): CaseExecutionResult {
  return {
    caseId: input.caseId,
    name: input.name,
    pass: false,
    passRate: 0,
    error: input.error,
    timedOut: input.timedOut,
    checks: input.checks,
  };
}

export function evaluateHealing(
  c: EvaluationCase<
    { caseId: string; name: string; error: string; timedOut?: boolean; checks?: CaseExecutionResult['checks']; actualSchema: Record<string, unknown> },
    HealingGroundTruth
  >,
): EvaluationResult {
  const errors: string[] = [];
  const gt = c.groundTruth;

  let suggestions: HealingSuggestion[] = [];
  try {
    suggestions = analyzeHealing({
      feature: 'wan3',
      failedCases: [toFailedCase(c.input)],
      actualSchema: c.input.actualSchema,
    }).suggestions;
  } catch (e) {
    errors.push(`自愈分析失败：${(e as Error).message}`);
    suggestions = [];
  }

  // 期望不动作分两种语义：
  //   forbidAnySuggestion（expectNoSuggestion=true）：严禁自愈（服务级故障 / 非路径失效），
  //     产出任何建议 = DANGEROUS（掩盖真实 Bug 的高危自愈）。
  //   expectNoOp（expectedNewPath === expectedOldPath）：期望路径不变（wrong-path 场景），
  //     产出错误建议 = RISKY（错误自愈，但非掩盖服务级故障）。
  const forbidAnySuggestion = gt.expectNoSuggestion === true;
  const expectNoOp = gt.expectedNewPath != null && gt.expectedNewPath === gt.expectedOldPath;
  const noOpExpected = forbidAnySuggestion || expectNoOp;

  // 实际结果分类
  let outcome: HealingOutcome = 'NO_OP';
  if (suggestions.length > 0) {
    const hit =
      gt.expectedOldPath != null &&
      suggestions.some(
        (s) => s.oldPath === gt.expectedOldPath && s.newPath === (gt.expectedNewPath ?? gt.expectedOldPath),
      );
    outcome = hit ? 'CORRECT_FIX' : 'WRONG_FIX';
  }

  // 安全等级判定（按实际行为，而非 groundTruth 标签）
  let safety: HealingSafety = 'SAFE';
  if (outcome === 'CORRECT_FIX') {
    safety = 'SAFE';
  } else if (outcome === 'WRONG_FIX') {
    // 严禁自愈却产出建议 → DANGEROUS（掩盖真实 Bug）；期望路径不变但改了错误路径 → RISKY
    safety = forbidAnySuggestion ? 'DANGEROUS' : 'RISKY';
  } else {
    safety = 'SAFE';
    if (!noOpExpected) errors.push(`漏自愈：期望 ${gt.expectedOldPath} → ${gt.expectedNewPath}，但未产出建议`);
  }

  const correct = noOpExpected ? outcome === 'NO_OP' : outcome === 'CORRECT_FIX';
  const score = correct ? 1 : 0;

  if (!correct && outcome !== 'NO_OP') {
    errors.push(
      forbidAnySuggestion
        ? `错误自愈（DANGEROUS：掩盖真实 Bug 的高危自愈）：${suggestions
            .map((s) => `${s.oldPath} → ${s.newPath ?? ''}`)
            .join('; ')}`
        : `自愈路径错误（${safety === 'RISKY' ? 'RISKY' : ''}）：期望 ${gt.expectedOldPath} → ${gt.expectedNewPath}，实际 ${suggestions
            .map((s) => `${s.oldPath} → ${s.newPath ?? ''}`)
            .join('; ')}`,
    );
  }

  return {
    caseId: c.id,
    domain: 'HEALING',
    score,
    passed: isPassed(score),
    tracked: true,
    expected: gt,
    actual: {
      outcome,
      safety,
      suggestionCount: suggestions.length,
      suggestions: suggestions.map((s) => ({
        oldPath: s.oldPath,
        newPath: s.newPath ?? null,
        type: s.type,
        confidence: s.confidence,
        risk: s.risk,
      })),
    },
    errors,
    evidence: [
      `Outcome=${outcome} / Safety=${safety}`,
      `建议数=${suggestions.length}（期望：${expectNoOp ? '不动作' : `${gt.expectedOldPath} → ${gt.expectedNewPath}`}）`,
      ...suggestions.slice(0, 3).map((s) => `${s.oldPath} → ${s.newPath ?? ''}（${s.type}，置信 ${s.confidence}）`),
    ],
  };
}
