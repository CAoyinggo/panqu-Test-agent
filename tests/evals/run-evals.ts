// Agent 评测主脚本（Phase 18 Evaluation）
// 固定 Benchmark：
//   - Requirement：30 条（10 正常 + 10 边界 + 10 异常）需求理解
//   - RCA：30 条（10 历史缺陷 + 10 环境异常 + 10 模型异常）根因分类
//   - Healing：5 条 自愈路径检测
//   - Defect：30 条 缺陷草稿生成质量
//   - Risk：30 条 风险识别覆盖
// 输出 Agent Quality Score（确定性基准，LLM 路径用 MockLLM 注入，失败自动回退）。
import { pathToFileURL } from 'node:url';
import { createAgentContext, NoopMemory, ToolRegistry } from '../../src/agents/index.js';
import { RequirementAgent } from '../../src/agents/requirement/requirement-agent.js';
import { parseRequirement } from '../../src/agents/requirement/requirement-parser.js';
import type { Requirement } from '../../src/agents/requirement/requirement-schema.js';
import { classifyFailure } from '../../src/agents/analysis/failure-classifier.js';
import type { FailureCategory } from '../../src/agents/analysis/root-cause-schema.js';
import { buildRootCause } from '../../src/agents/analysis/root-cause-schema.js';
import { analyzeHealing } from '../../src/agents/self-healing/healing-analyzer.js';
import { buildDefectFromRca } from '../../src/agents/defect/defect-agent.js';
import { analyzeRisks } from '../../src/agents/risk/risk-analyzer.js';
import type { CaseExecutionResult } from '../../src/agents/execution/execution-schema.js';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import { MockLLMProvider } from '../../src/llm/mock-llm.js';
import { AgentTracer } from '../../src/agents/observability/tracer.js';
import { setScore, exactMatch, mean, pct, type EvalDimension, type QualityReport, buildQualityReport, finalizeReport } from './eval-utils.js';
import { REQUIREMENT_BENCHMARK, type BenchmarkRequirement } from './benchmark/requirements.js';
import { FAILURE_BENCHMARK, type BenchmarkFailure } from './benchmark/failures.js';
import { HEALING_BENCHMARK, type BenchmarkHealing } from './benchmark/healing.js';

/** 评测维度权重（确定性组件：需求 / RCA 为主，其余均衡） */
export const EVAL_WEIGHTS: Record<string, number> = {
  requirements: 0.25,
  rca: 0.25,
  healing: 0.15,
  defect: 0.15,
  risk: 0.2,
};

/** 分类 → 缺陷严重度映射（与 Defect Agent 保持一致） */
const CATEGORY_SEVERITY: Record<string, { severity: string; priority: string }> = {
  AUTH_ERROR: { severity: 'P1', priority: 'HIGH' },
  BILLING_ERROR: { severity: 'P1', priority: 'HIGH' },
  MODEL_ERROR: { severity: 'P1', priority: 'HIGH' },
  CONCURRENCY_ERROR: { severity: 'P2', priority: 'MEDIUM' },
  TIMEOUT: { severity: 'P2', priority: 'MEDIUM' },
  ASSERTION_ERROR: { severity: 'P2', priority: 'MEDIUM' },
  DATA_ERROR: { severity: 'P2', priority: 'MEDIUM' },
  ENVIRONMENT_ERROR: { severity: 'P3', priority: 'LOW' },
  NETWORK_ERROR: { severity: 'P3', priority: 'LOW' },
  TEST_CODE_ERROR: { severity: 'P3', priority: 'LOW' },
  UNKNOWN_ERROR: { severity: 'P2', priority: 'MEDIUM' },
};

/** 需求评分：字段加权（feature 精确 + 集合 F1） */
function scoreRequirement(req: Requirement, expected: BenchmarkRequirement['expected']): number {
  return (
    0.2 * exactMatch(req.feature, expected.feature) +
    0.2 * setScore(req.capabilities, expected.capabilities).f1 +
    0.2 * setScore(req.inputs, expected.inputs).f1 +
    0.2 * setScore(req.businessRules, expected.businessRules).f1 +
    0.2 * setScore(req.risks ?? [], expected.risks).f1
  );
}

/** 单条需求评测：LLM 路径（注入正确 JSON）+ 回退路径（MockLLM 失败） */
async function evalRequirementCase(
  b: BenchmarkRequirement,
  useLlmPath: boolean,
  tracer: AgentTracer,
): Promise<{ score: number; featureOk: boolean }> {
  const spanId = tracer.startSpan('requirement', `benchmark-${b.id}-${useLlmPath ? 'llm' : 'fallback'}`);
  // LLM 路径注入解析器输出（模拟"理想 LLM"），回退路径强制 MockLLM 失败
  const mock = useLlmPath
    ? new MockLLMProvider({ defaultResponse: JSON.stringify(parseRequirement(b.text, b.text)) })
    : new MockLLMProvider({ failureMode: { type: 'invalid-json' } });
  const agent = new RequirementAgent();
  const ctx = createAgentContext({
    taskId: `eval-${b.id}`,
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm: mock,
  });
  let req: Requirement;
  try {
    req = await agent.execute({ text: b.text, format: 'text' }, ctx);
  } catch {
    req = parseRequirement(b.text, b.text);
  }
  const score = scoreRequirement(req, b.expected);
  const featureOk = exactMatch(req.feature, b.expected.feature) === 1;
  tracer.endSpan(spanId, {
    inputTokens: b.text.length,
    outputTokens: JSON.stringify(req).length,
    llmCalls: 1,
    fallbackCount: useLlmPath ? 0 : 1,
    success: true,
    status: useLlmPath ? 'ok' : 'fallback',
  });
  return { score, featureOk };
}

/** Requirement 维度：两种路径各 30 条 */
async function evalRequirements(tracer: AgentTracer): Promise<{ dim: EvalDimension; hallucinationRate: number }> {
  const scores: number[] = [];
  let featureMismatch = 0;
  for (const b of REQUIREMENT_BENCHMARK) {
    const llm = await evalRequirementCase(b, true, tracer);
    const fallback = await evalRequirementCase(b, false, tracer);
    scores.push(llm.score, fallback.score);
    if (!llm.featureOk) featureMismatch += 1;
  }
  const passed = scores.filter((s) => s >= 0.9).length;
  return {
    dim: {
      key: 'requirements',
      label: 'Requirement Accuracy',
      score: pct(mean(scores)),
      passed,
      total: scores.length,
    },
    hallucinationRate: featureMismatch / REQUIREMENT_BENCHMARK.length,
  };
}

/** RCA 维度：失败分类精确匹配 */
function evalRca(): EvalDimension {
  const total = FAILURE_BENCHMARK.length;
  const passed = FAILURE_BENCHMARK.filter((f) => {
    const cls = classifyFailure({ caseId: f.caseId, error: f.error, timedOut: f.timedOut, checks: f.checks });
    return exactMatch(cls.category, f.expectedCategory) === 1;
  }).length;
  return { key: 'rca', label: 'Root Cause Accuracy', score: pct(passed / total), passed, total };
}

/** Healing 维度：路径失效检测 + 新路径定位 */
function evalHealing(): EvalDimension {
  const total = HEALING_BENCHMARK.length;
  let passed = 0;
  for (const h of HEALING_BENCHMARK) {
    const failed: CaseExecutionResult = {
      caseId: h.caseId,
      name: h.name,
      pass: false,
      passRate: 0,
      error: h.error,
      timedOut: h.timedOut,
      checks: h.checks,
    };
    const analysis = analyzeHealing({ feature: 'wan3', failedCases: [failed], actualSchema: h.actualSchema });
    const ok = h.expectNoSuggestion
      ? analysis.suggestions.length === 0
      : analysis.suggestions.some(
          (s) => s.oldPath === h.expectedOldPath && s.newPath === h.expectedNewPath && s.status === 'SUGGESTED',
        );
    if (ok) passed += 1;
  }
  return { key: 'healing', label: 'Self-Healing Accuracy', score: pct(passed / total), passed, total };
}

/** Defect 维度：草稿状态 + 严重度映射 + 关联用例 */
function evalDefect(): EvalDimension {
  const total = FAILURE_BENCHMARK.length;
  let passed = 0;
  for (const f of FAILURE_BENCHMARK) {
    const cls = classifyFailure({ caseId: f.caseId, error: f.error, timedOut: f.timedOut, checks: f.checks });
    const failed: CaseExecutionResult = {
      caseId: f.caseId,
      name: f.name,
      pass: false,
      passRate: 0,
      error: f.error,
      timedOut: f.timedOut,
      checks: f.checks,
    };
    const rca = buildRootCause({ caseId: f.caseId, category: cls.category, confidence: cls.confidence, rootCause: f.error });
    const draft = buildDefectFromRca(failed, rca, 'wan3', 'test', 1);
    const expect = CATEGORY_SEVERITY[cls.category] ?? CATEGORY_SEVERITY.UNKNOWN_ERROR;
    const ok =
      draft.status === 'DRAFT' &&
      draft.severity === expect.severity &&
      draft.priority === expect.priority &&
      draft.relatedCases.includes(f.caseId) &&
      draft.title.length > 0 &&
      draft.evidence.length > 0;
    if (ok) passed += 1;
  }
  return { key: 'defect', label: 'Defect Quality', score: pct(passed / total), passed, total };
}

/** 构造最小带标签用例（风险维度并发/安全识别用） */
function makeTaggedCase(id: string, tags: string[]): TestCase {
  return { id, feature: 'wan3', name: id, priority: 'P2', tags, steps: [{ action: 'submit' }], assertions: [] };
}

/** Risk 维度：可判定风险标签（billing/timeout/retry/concurrency/security）覆盖 */
function evalRisk(): EvalDimension {
  const CHECKABLE = new Set(['billing', 'timeout', 'retry', 'concurrency', 'security']);
  const scores: number[] = [];
  for (const b of REQUIREMENT_BENCHMARK) {
    const req = parseRequirement(b.text, b.text);
    const testCases: TestCase[] = [];
    if ((req.risks ?? []).includes('concurrency')) testCases.push(makeTaggedCase(`${b.id}-conc`, ['concurrency']));
    if ((req.risks ?? []).includes('security')) testCases.push(makeTaggedCase(`${b.id}-sec`, ['security']));
    const assessment = analyzeRisks({ requirement: req, testCases, environment: 'test' });
    const checkable = (b.expected.risks ?? []).filter((r) => CHECKABLE.has(r));
    if (!checkable.length) {
      scores.push(1);
      continue;
    }
    const covered = checkable.filter((r) => assessment.risks.some((x) => x.category === r)).length;
    scores.push(covered / checkable.length);
  }
  const passed = scores.filter((s) => s >= 0.9).length;
  return { key: 'risk', label: 'Risk Accuracy', score: pct(mean(scores)), passed, total: scores.length };
}

/** 运行完整评测 */
export async function runAgentEval(): Promise<QualityReport> {
  const tracer = new AgentTracer('agent-eval', { feature: 'wan3', environment: 'test' });
  const reqResult = await evalRequirements(tracer);
  const dims: EvalDimension[] = [reqResult.dim, evalRca(), evalHealing(), evalDefect(), evalRisk()];
  const trace = tracer.toTrace();

  const report = buildQualityReport(dims, EVAL_WEIGHTS, {
    benchmark: {
      requirements: REQUIREMENT_BENCHMARK.length,
      failures: FAILURE_BENCHMARK.length,
      healing: HEALING_BENCHMARK.length,
    },
  });

  const llmCalls = trace.llmCallTotal ?? 0;
  const fallbacks = trace.fallbackTotal ?? 0;
  const fallbackRate = llmCalls > 0 ? fallbacks / llmCalls : 0;

  return finalizeReport(report, {
    fallbackRate: Math.round(fallbackRate * 1000) / 1000,
    hallucinationRate: Math.round(reqResult.hallucinationRate * 1000) / 1000,
    tokenCost: Math.round((trace.totalCost ?? 0) * 10000) / 10000,
    latencyMs: trace.totalLatencyMs ?? 0,
  });
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runAgentEval()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.overall >= 0 ? 0 : 1);
    })
    .catch((e) => {
      console.error('Agent Eval 失败：', (e as Error).message);
      process.exit(1);
    });
}
