// Analysis Agent：综合需求 / 用例 / 执行结果 / 风险评估，产出结构化分析报告
// 策略：LLM 仅解释逐 Case finding → 证据门收敛 → 确定性分析器生成最终摘要/建议；
//      LLM 失败时完全回退到确定性分析器。
// 报告包含 memoryWorthy 失败记录，供 Memory 层持久化（Phase 8）。

import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import { parseLLMJson } from '../../llm/index.js';
import type { Requirement } from '../requirement/requirement-schema.js';
import type { TestCase } from '../test-design/testcase-schema.js';
import type { RiskAssessment } from '../risk/risk-schema.js';
import type { ExecutionOutcome } from '../execution/execution-schema.js';
import {
  AnalysisReport,
  isAnalysisLike,
  normalizeAnalysis,
  summaryFromOutcome,
  toMemoryWorthy,
} from './analysis-schema.js';
import { analyzeExecution, AnalysisAnalyzerInput, classifyExecutionResult } from './analysis-analyzer.js';
import { promptRegistry } from '../prompts/registry.js';
import { redactSensitive } from '../../core/redact.js';

/** 历史 Prompt，保留用于既有运行回放。 */
export const ANALYSIS_SYSTEM_PROMPT_V1 = `你是资深测试分析师。根据测试需求、用例、执行结果与风险评估，输出结构化分析报告。
只输出 JSON，不要任何解释或 Markdown 围栏。输出结构如下：
{"feature":"功能名","aiSummary":"一句话总结","findings":[{"type":"fail|flaky|blocked|pass|info","caseId":"tc-01","title":"标题","detail":"细节","severity":"high|medium|low","suggestion":"建议"}],"recommendations":["建议1","建议2"]}

规则：
- 优先根因定位：失败（断言/错误）、超时、阻塞（高风险+失败）、不稳定（历史 flaky）
- recommendations 给出可执行改进建议，不要泛泛而谈
- aiSummary 一句话概括整体结论与关键风险
- 不要编造执行结果中不存在的失败
- 禁止输出统计字段（total/passed/failed/timedOut/passRate/durationMs）——
  结果统计由平台根据真实执行结果计算，模型输出一律忽略`;

/** Evidence-first 分析 Prompt v2；模型只解释，最终状态和分类由确定性代码收敛。 */
export const ANALYSIS_SYSTEM_PROMPT = `你是开发验收结果解释器。根据 Requirement、TestCase、真实 Execution、Deterministic Assertion 和 Evidence 解释结果并提出下一步。
只输出 JSON，不要解释或 Markdown 围栏。结构如下：
{"feature":"功能名","aiSummary":"一句话解释","findings":[{"type":"fail|flaky|blocked|pass|info","caseId":"tc-01","title":"标题","detail":"Requirement→Case→Execution→Evidence→Result 的解释","severity":"high|medium|low","classification":"PRODUCT_BUG|REQUIREMENT_GAP|TEST_DESIGN_ERROR|ENVIRONMENT_ERROR|EXECUTION_ERROR|NOT_TESTED|NONE","evidence":["证据摘要"],"confidence":"CONFIRMED|LIKELY|UNKNOWN","suggestion":"可执行建议"}],"recommendations":["建议1"]}

铁律：
- LLM 不是 Oracle：不得修改或创造 PASS/FAIL/BLOCKED/NOT_EXECUTED，统计字段由真实 Runner 决定。
- 只有 executed=true、Processor 确实调用、明确 Expected、失败的确定性业务断言和有效 Evidence 同时存在，才能建议 PRODUCT_BUG/CONFIRMED。
- 500、Timeout、Empty Response、Slow Response、Browser Error 先检查 Environment、Contract、Auth、Test Data、Processor/Observer；不得直接归产品 Bug。
- 没执行、缺 Processor、缺断言、缺 Evidence、Oracle 不完整时使用 NOT_TESTED / TEST_DESIGN_ERROR / EXECUTION_ERROR，不得写成通过或产品缺陷。
- Requirement/Contract 含推导或歧义，且实测与推导不符时先使用 REQUIREMENT_GAP 并建议复核来源。
- findings 只能引用输入中存在的 caseId 和执行事实；evidence 只能摘录输入的断言/错误/证据摘要。
- recommendations/aiSummary 只是解释候选，最终报告会由确定性分析器重建，禁止写交付结论。
- 禁止输出 total/passed/failed/timedOut/passRate/durationMs/overall/exitCode。`;

function resolveSystemPrompt(): string {
  return promptRegistry.getVersion('analysis')?.system ?? ANALYSIS_SYSTEM_PROMPT;
}

/** Analysis Agent 输入 */
export interface AnalysisAgentInput {
  requirement: Requirement;
  testCases?: TestCase[];
  outcome: ExecutionOutcome;
  risk?: RiskAssessment;
  /** 历史 flaky 用例 ID（来自记忆层，可选） */
  flakyCaseIds?: string[];
}

/** Analysis Agent */
export class AnalysisAgent extends BaseAgent<AnalysisAgentInput, AnalysisReport> {
  name = 'analysis';
  version = '0.2.0';
  description = '综合分析测试结果，产出结构化分析报告（LLM 优先，确定性分析器兜底）';

  async execute(input: AnalysisAgentInput, context: AgentContext): Promise<AnalysisReport> {
    if (!input || !input.requirement || !input.outcome) {
      throw new Error('分析输入为空：请提供 Requirement 与执行结果');
    }

    // 1. 尝试 LLM 分析（含 Mock，失败则回退）
    try {
      const report = await this.analyzeWithLLM(input, context);
      context.logger.info(`分析完成（LLM，${report.findings.length} 项结论）`);
      return report;
    } catch (e) {
      context.logger.warn(`LLM 分析失败，回退确定性分析器：${(e as Error).message}`);
    }

    // 2. 确定性分析器兜底（永远可用，不依赖 LLM）
    const report = analyzeExecution(input as AnalysisAnalyzerInput);
    context.logger.info(`分析完成（确定性分析器，${report.findings.length} 项结论）`);
    return report;
  }

  /** LLM 分析：构造提示 → 解析 JSON → 归一化 + 补充确定性字段 */
  private async analyzeWithLLM(input: AnalysisAgentInput, context: AgentContext): Promise<AnalysisReport> {
    const { requirement, testCases = [], outcome, risk } = input;
    const caseById = new Map(testCases.map((testCase) => [testCase.id, testCase]));
    const userContent = `功能模块：${requirement.feature}
需求认知边界：${JSON.stringify(redactSensitive(requirement.understanding ?? { facts: [], ambiguities: [], unknowns: ['UNDERSTANDING_NOT_PROVIDED'] }))}
执行结果：共 ${outcome.total} 条，通过 ${outcome.passed}，失败 ${outcome.failed}，超时 ${outcome.timedOut}，通过率 ${outcome.passRate}%
逐 Case 执行事实：
${outcome.results
    .slice(0, 20)
    .map((r) => {
      const testCase = caseById.get(r.caseId);
      return `- ${r.caseId} ${r.name}: ${JSON.stringify(redactSensitive({
      status: r.status, executed: r.executed, processor: r.processor,
      processorInvoked: r.processorInvoked, error: r.error, timedOut: r.timedOut,
      checks: r.checks, evidencePresent: r.evidence !== undefined,
      evidenceShape: r.evidence && typeof r.evidence === 'object' ? Object.keys(r.evidence as object) : [],
      blockedReason: r.blockedReason,
      expected: testCase?.expected,
      assertions: testCase?.assertions.map((assertion) => ({
        id: assertion.id, type: assertion.type, operator: assertion.operator, expected: assertion.expected,
        factIds: assertion.factIds, evidenceRequirementIds: assertion.evidenceRequirementIds,
      })),
      contractDependencies: testCase?.contractDependencies,
    }))}`;
    })
    .join('\n') || '（无执行记录）'}
高风险项：
${(risk?.risks ?? []).filter((r) => r.level === 'high').map((r) => `- ${r.title}：${r.mitigation}`).join('\n') || '（无）'}
用例（${testCases.length} 条）：${testCases.slice(0, 10).map((c) => c.id).join(', ')}`;

    const resp = await context.runtime.generate({
        task: 'analysis',
        agent: this.name,
        system: resolveSystemPrompt(),
        user: userContent,
        temperature: 0,
        jsonMode: true,
      });

    const parsed = parseLLMJson(resp); // 非法 JSON 抛错 → 回退
    if (!isAnalysisLike(parsed)) {
      throw new Error('LLM 输出缺少 feature 字段');
    }
    // 统计字段（total/passed/failed/timedOut/duration/exitCode/overall）由真实执行结果
    // 确定性计算并逐字采用 —— LLM 输出的 summary（即使有）被整体丢弃，防结果污染。
    // LLM 只贡献逐 Case 的 detail / suggestion 候选；最终摘要、建议与分类由证据门重建。
    const report = normalizeAnalysis(
      { ...parsed, ...llmOverrides(input) },
      { trustedSummary: summaryFromOutcome(input.outcome) },
    );
    enforceEvidenceFirstFindings(report, input);
    report.source = requirement.source;
    return report;
  }
}

/**
 * LLM 可解释失败，但不能凭空新增 Case、把 PASS 说成 FAIL，或绕过证据门直接判产品缺陷。
 * 同时补回模型遗漏的真实失败，避免“模型没提”导致报告静默丢问题。
 */
function enforceEvidenceFirstFindings(report: AnalysisReport, input: AnalysisAgentInput): void {
  const resultByCase = new Map(input.outcome.results.map((result) => [result.caseId, result]));
  const deterministic = analyzeExecution(input as AnalysisAnalyzerInput);
  const deterministicByCase = new Map(deterministic.findings.filter((finding) => finding.caseId)
    .map((finding) => [finding.caseId!, finding]));
  const safeFindings: AnalysisReport['findings'] = [];
  for (const finding of report.findings) {
    if (!finding.caseId) continue;
    const result = resultByCase.get(finding.caseId);
    if (!result) continue;
    if ((finding.type === 'fail' || finding.type === 'flaky' || finding.type === 'blocked') && result.pass) continue;
    if (finding.type === 'pass' && !result.pass) continue;
    const deterministicFinding = deterministicByCase.get(finding.caseId);
    if (deterministicFinding) {
      safeFindings.push({
        ...deterministicFinding,
        detail: finding.detail?.trim() || deterministicFinding.detail,
        suggestion: finding.suggestion?.trim() || deterministicFinding.suggestion,
      });
    } else if (result.pass && finding.type === 'pass') {
      safeFindings.push({ ...finding, type: 'pass', classification: 'NONE', evidence: [], confidence: 'CONFIRMED' });
    }
  }
  report.findings = safeFindings;
  const represented = new Set(report.findings.map((finding) => finding.caseId).filter(Boolean));
  report.findings.push(...deterministic.findings.filter((finding) => !finding.caseId || !represented.has(finding.caseId)));
  // 汇总结论属于确定性 Oracle 的展示面，不能拼接模型可能与真实统计冲突的状态声明。
  // 模型对失败原因的解释仍保留在逐 Case finding.detail / suggestion 中。
  report.aiSummary = deterministic.aiSummary;
  report.recommendations = deterministic.recommendations;
}

/** LLM 分支补全确定性字段（failedCases/memoryWorthy/topFailures 始终来自真实执行结果） */
function llmOverrides(input: AnalysisAgentInput): Record<string, unknown> {
  const failed = input.outcome.results.filter((r) => !r.pass);
  return {
    feature: input.requirement.feature,
    failedCases: failed,
    topFailures: failed.slice(0, 10).map((c) => ({ caseId: c.caseId, name: c.name, error: c.error })),
    memoryWorthy: toMemoryWorthy(failed),
  };
}

/** 便捷工厂：创建 Analysis Agent 实例 */
export function createAnalysisAgent(): AnalysisAgent {
  return new AnalysisAgent();
}

// 重导出 schema / analyzer 便于外部消费
export { AnalysisReport, AnalysisFinding, AnalysisSummary, MemoryWorthyFailure, FindingType } from './analysis-schema.js';
export { normalizeAnalysis, computeAnalysisSummary, toMemoryWorthy } from './analysis-schema.js';
export { analyzeExecution, classifyExecutionResult, AnalysisAnalyzerInput } from './analysis-analyzer.js';
