// Decision Replay（Phase 45 / 42.17）：决策重放 + 确定性验证
// 输入一个 Evaluation Case → 重新执行 需求解析 → 风险 → 选择 → 分类 → 发布决策 全链路。
// 铁律：
//   - Replay 默认 read-only：不产生 production mutation、不创建缺陷、不做发布。
//   - 确定性模块必须验证：same input → same output（两次执行结果一致）。
//   - LLM 模块允许波动，但必须记录 model / promptVersion / temperature / seed / timestamp。
// 当前评测链路全部为确定性规则（Deterministic First），因此 Replay 必须逐字节一致。
import type { EvaluationCase, EvaluationDomain, EvaluationResult } from './contract.js';
import { DOMAIN_LABELS } from './contract.js';
import { evaluateRequirement } from './evaluator/requirement.js';
import { evaluateTestDesign } from './evaluator/test-design.js';
import { evaluateRisk } from './evaluator/risk.js';
import { evaluateSelection } from './evaluator/selection.js';
import { evaluateRca } from './evaluator/rca.js';
import { evaluateDefect } from './evaluator/defect.js';
import { evaluateHealing } from './evaluator/healing.js';
import { evaluateRelease } from './evaluator/release.js';

const REPLAY_EVALUATORS: Record<EvaluationDomain, (c: EvaluationCase) => EvaluationResult> = {
  REQUIREMENT: (c) => evaluateRequirement(c as Parameters<typeof evaluateRequirement>[0]),
  TEST_DESIGN: (c) => evaluateTestDesign(c as Parameters<typeof evaluateTestDesign>[0]),
  RISK: (c) => evaluateRisk(c as Parameters<typeof evaluateRisk>[0]),
  SELECTION: (c) => evaluateSelection(c as Parameters<typeof evaluateSelection>[0]),
  RCA: (c) => evaluateRca(c as Parameters<typeof evaluateRca>[0]),
  DEFECT: (c) => evaluateDefect(c as Parameters<typeof evaluateDefect>[0]),
  HEALING: (c) => evaluateHealing(c as Parameters<typeof evaluateHealing>[0]),
  RELEASE: (c) => evaluateRelease(c as Parameters<typeof evaluateRelease>[0]),
};

/** 单次 Replay 结果 */
export interface ReplayRun {
  caseId: string;
  domain: EvaluationDomain;
  result: EvaluationResult;
  /** 确定性一致性：true = 与首次执行一致 */
  deterministic: boolean;
  /** 执行版本信息（rules 模型；LLM 时含 temperature/seed） */
  model: string;
  executedAt: string;
}

export interface ReplayOutput {
  caseId: string;
  domain: EvaluationDomain;
  domainLabel: string;
  runs: ReplayRun[];
  deterministic: boolean;
  readOnly: boolean;
  errors: string[];
}

/** 确定性结构指纹（same input → same output 判定） */
function fingerprint(r: EvaluationResult): string {
  return JSON.stringify({ score: r.score, passed: r.passed, actual: r.actual, errors: r.errors });
}

/**
 * 决策重放：对同一 Evaluation Case 重复执行指定次数（默认 2）。
 * read-only：绝不创建缺陷 / 不做发布 / 不写 production（当前链路仅调用确定性分析器）。
 * 返回是否确定性一致（决定论断言：必须 true）。
 */
export function replayCase(
  c: EvaluationCase,
  opts: { runs?: number; readOnly?: boolean } = {},
): ReplayOutput {
  const runs = opts.runs ?? 2;
  const readOnly = opts.readOnly ?? true;
  const errors: string[] = [];
  const evaluator = REPLAY_EVALUATORS[c.domain];
  if (!evaluator) {
    errors.push(`领域 ${c.domain} 无可用的确定性评估器`);
    return { caseId: c.id, domain: c.domain, domainLabel: DOMAIN_LABELS[c.domain] ?? c.domain, runs: [], deterministic: false, readOnly, errors };
  }

  const executed: ReplayRun[] = [];
  let first: string | null = null;
  let deterministic = true;
  for (let i = 0; i < runs; i++) {
    try {
      const result = evaluator(c);
      const fp = fingerprint(result);
      if (first === null) first = fp;
      else if (fp !== first) deterministic = false;
      executed.push({
        caseId: c.id,
        domain: c.domain,
        result,
        deterministic,
        model: 'rules',
        executedAt: new Date().toISOString(),
      });
    } catch (e) {
      errors.push(`第 ${i + 1} 次 Replay 执行失败：${(e as Error).message}`);
      deterministic = false;
    }
  }

  return {
    caseId: c.id,
    domain: c.domain,
    domainLabel: DOMAIN_LABELS[c.domain] ?? c.domain,
    runs: executed,
    deterministic,
    readOnly,
    errors,
  };
}

/** 全链路 Replay（单个用例在所有适用领域的确定性验证） */
export function replayAllCases(cases: EvaluationCase[]): { outputs: ReplayOutput[]; allDeterministic: boolean; failed: string[] } {
  const outputs = cases.map((c) => replayCase(c));
  const failed = outputs.filter((o) => !o.deterministic || o.errors.length > 0).map((o) => `${o.domain}:${o.caseId}`);
  return { outputs, allDeterministic: failed.length === 0, failed };
}
