// Risk Agent：根据 Requirement + TestCase 列表评估测试风险，产出结构化 RiskAssessment
// 策略：LLM 评估（System Prompt 内嵌 Risk JSON Schema，输出 RiskItem 数组）
//      → 校验 → 失败回退到确定性风险分析器。
// 输出直接映射现有 IssueItem（阻塞/数据异常/待接入/待人工），供报告复用。

import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import { parseLLMJson } from '../../llm/index.js';
import type { Requirement } from '../requirement/requirement-schema.js';
import type { TestCase } from '../test-design/testcase-schema.js';
import {
  RiskAssessment,
  RISK_JSON_SCHEMA,
  isRiskAssessmentLike,
  validateRiskAssessment,
  toIssueItem,
} from './risk-schema.js';
import { analyzeRisks } from './risk-analyzer.js';

/** 系统提示词：要求 LLM 严格按 Schema 输出风险列表 */
const SYSTEM_PROMPT = `你是资深测试风险分析师。根据测试需求与用例评估执行风险。
输出必须严格符合如下 JSON Schema（risks 为数组，只输出 JSON，不要任何解释或 Markdown 围栏）：
{"type":"object","required":["feature","risks"],"properties":{"feature":{"type":"string"},"risks":{"type":"array","items":${JSON.stringify(RISK_JSON_SCHEMA.properties.risks, null, 2)}}}}

规则：
- 每个风险必须有 category（dependency/data/boundary/concurrency/billing/security/environment/compatibility/timeout/retry）
  、level（high/medium/low）、title、desc、mitigation
- 优先识别阻塞性风险：计费、安全、并发、生产环境
- 其次数据性风险：边界值、异常输入、依赖可用性
- 高风险达到 2 条或存在计费/安全/并发高风险时 overall=high 且 recommendedSkip=true
- 生成 3~10 条风险，不要编造需求中不存在的风险`;

/** Risk Agent 输入 */
export interface RiskAgentInput {
  requirement: Requirement;
  testCases?: TestCase[];
  environment?: string;
}

/** Risk Agent */
export class RiskAgent extends BaseAgent<RiskAgentInput, RiskAssessment> {
  name = 'risk';
  version = '0.2.0';
  description = '评估测试执行风险，产出结构化风险评估（LLM 优先，确定性分析器兜底）';

  async execute(input: RiskAgentInput, context: AgentContext): Promise<RiskAssessment> {
    if (!input || !input.requirement) {
      throw new Error('风险评估输入为空：请提供 Requirement');
    }

    // 1. 尝试 LLM 评估（含 Mock，失败则回退）
    try {
      const result = await this.assessWithLLM(input, context);
      context.logger.info(
        `风险评估完成（LLM，${result.risks.length} 项，overall=${result.summary.overall}，recommendedSkip=${result.summary.recommendedSkip}）`,
      );
      return result;
    } catch (e) {
      context.logger.warn(`LLM 评估风险失败，回退确定性分析器：${(e as Error).message}`);
    }

    // 2. 确定性分析器兜底（永远可用，不依赖 LLM）
    const result = analyzeRisks(input);
    context.logger.info(
      `风险评估完成（确定性分析器，${result.risks.length} 项，overall=${result.summary.overall}）`,
    );
    return result;
  }

  /** LLM 评估：构造提示 → 解析 JSON → 校验 → 归一化 + IssueItem 映射 */
  private async assessWithLLM(input: RiskAgentInput, context: AgentContext): Promise<RiskAssessment> {
    const { requirement, testCases = [], environment } = input;
    const userContent = `功能模块：${requirement.feature}
执行环境：${environment ?? 'test'}
依赖服务：[${requirement.dependencies.join(', ')}]
业务规则：[${requirement.businessRules.join(', ')}]
测试用例（${testCases.length} 条）：
${testCases
    .slice(0, 30)
    .map((c) => `- ${c.id} [${c.priority}] ${c.name}（tags: ${c.tags.join(',')}，断言: ${c.assertions.map((a) => a.target ?? 'submit').join(',')}）`)
    .join('\n')}`;

    const resp = await context.llm.generate({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      jsonMode: true,
    });

    const parsed = parseLLMJson(resp); // 非法 JSON 抛错 → 回退
    if (!isRiskAssessmentLike(parsed)) {
      throw new Error('LLM 输出缺少 feature 字段');
    }
    const validated = await validateRiskAssessment(parsed);
    validated.source = requirement.source;
    validated.confidence = Math.max(validated.confidence ?? 0, 0.85);
    return validated;
  }
}

/** 便捷工厂：创建 Risk Agent 实例 */
export function createRiskAgent(): RiskAgent {
  return new RiskAgent();
}

// 重导出 schema / analyzer 便于外部消费
export { RiskAssessment, RiskItem, RiskLevel, RiskCategory, RiskSummary } from './risk-schema.js';
export { RISK_JSON_SCHEMA, normalizeRiskAssessment, validateRiskAssessment, computeRiskSummary, toIssueItem } from './risk-schema.js';
export { analyzeRisks, RiskAnalyzerInput } from './risk-analyzer.js';
