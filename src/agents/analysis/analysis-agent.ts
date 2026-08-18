// Analysis Agent：综合需求 / 用例 / 执行结果 / 风险评估，产出结构化分析报告
// 策略：LLM 分析（System Prompt 内嵌 AnalysisReport 结构，产出 findings/recommendations/aiSummary）
//      → 归一化 → 失败回退到确定性分析器。
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
  toMemoryWorthy,
} from './analysis-schema.js';
import { analyzeExecution, AnalysisAnalyzerInput } from './analysis-analyzer.js';

/** 系统提示词：要求 LLM 严格按结构输出分析结论 */
const SYSTEM_PROMPT = `你是资深测试分析师。根据测试需求、用例、执行结果与风险评估，输出结构化分析报告。
只输出 JSON，不要任何解释或 Markdown 围栏。输出结构如下：
{"feature":"功能名","aiSummary":"一句话总结","findings":[{"type":"fail|flaky|blocked|pass|info","caseId":"tc-01","title":"标题","detail":"细节","severity":"high|medium|low","suggestion":"建议"}],"recommendations":["建议1","建议2"]}

规则：
- 优先根因定位：失败（断言/错误）、超时、阻塞（高风险+失败）、不稳定（历史 flaky）
- recommendations 给出可执行改进建议，不要泛泛而谈
- aiSummary 一句话概括整体结论与关键风险
- 不要编造执行结果中不存在的失败`;

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
    const userContent = `功能模块：${requirement.feature}
执行结果：共 ${outcome.total} 条，通过 ${outcome.passed}，失败 ${outcome.failed}，超时 ${outcome.timedOut}，通过率 ${outcome.passRate}%
失败用例：
${outcome.results
    .filter((r) => !r.pass)
    .slice(0, 20)
    .map((r) => `- ${r.caseId} ${r.name}（${r.timedOut ? '超时' : r.error ?? '断言失败'}）`)
    .join('\n') || '（无失败）'}
高风险项：
${(risk?.risks ?? []).filter((r) => r.level === 'high').map((r) => `- ${r.title}：${r.mitigation}`).join('\n') || '（无）'}
用例（${testCases.length} 条）：${testCases.slice(0, 10).map((c) => c.id).join(', ')}`;

    const resp = await context.llm.generate({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      jsonMode: true,
    });

    const parsed = parseLLMJson(resp); // 非法 JSON 抛错 → 回退
    if (!isAnalysisLike(parsed)) {
      throw new Error('LLM 输出缺少 feature 字段');
    }
    const report = normalizeAnalysis({ ...parsed, ...llmOverrides(input) });
    report.source = requirement.source;
    return report;
  }
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
export { analyzeExecution, AnalysisAnalyzerInput } from './analysis-analyzer.js';
