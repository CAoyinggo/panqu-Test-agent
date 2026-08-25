// Coverage Agent：测试覆盖分析（LLM 优先，确定性回退）
// 目标：Phase 12 —— 回答「还有什么没测」。基于结构化 Case / Requirement 计算覆盖，AI 判断缺口。
// 确定性分析器优先负责计算（任务书第 21 节），LLM 负责补充缺口判断与解释。
import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import { parseLLMJson } from '../../llm/index.js';
import { Requirement } from '../requirement/requirement-schema.js';
import { TestCase } from '../test-design/testcase-schema.js';
import {
  CoverageAnalysis,
  COVERAGE_JSON_SCHEMA,
  isCoverageLike,
  validateCoverage,
  buildCoverage,
  CoverageRecommendation,
} from './coverage-schema.js';
import { computeCoverageAnalysis, CoverageInput } from './coverage-analyzer.js';

/** 系统提示词（默认内置，可被 Prompt Registry 覆盖） */
export const COVERAGE_SYSTEM_PROMPT = `你是测试覆盖分析专家。根据需求与测试用例，分析各维度覆盖率并指出覆盖缺口。
输出必须严格符合如下 JSON Schema（只输出 JSON）：
${JSON.stringify(COVERAGE_JSON_SCHEMA, null, 2)}

覆盖维度：requirement（业务规则）/ parameter（参数取值）/ boundary（边界）/ exception（异常）
/ assertion（断言）/ risk（风险）/ history（历史缺陷）。
- coverage 为 维度名 → 覆盖率（0~100 数字）
- gaps 为覆盖缺口描述（如 1080P + 10秒组合场景缺失）
- recommendedCases 为补测建议（description + priority + dimension）
基于给定数据计算，不要编造用例中不存在的覆盖事实。`;

/** 覆盖分析输入（Agent 层） */
export type CoverageAgentInput = CoverageInput;

/** Coverage Agent */
export class CoverageAgent extends BaseAgent<CoverageAgentInput, CoverageAnalysis> {
  name = 'coverage';
  version = '0.1.0';
  description = '基于需求与用例计算测试覆盖并识别缺口（LLM 优先，规则兜底）';

  async execute(input: CoverageAgentInput, context: AgentContext): Promise<CoverageAnalysis> {
    if (!input?.requirement) {
      throw new Error('覆盖分析输入为空：缺少 requirement');
    }

    // 1. LLM 优先（失败/非法/校验不通过 → 回退确定性）
    try {
      const analysis = await this.parseWithLLM(input, context);
      context.logger.info('覆盖分析完成（LLM）');
      return analysis;
    } catch (e) {
      context.logger.warn(`LLM 覆盖分析失败，回退规则分析：${(e as Error).message}`);
    }

    // 2. 确定性分析兜底
    const analysis = computeCoverageAnalysis(input);
    context.logger.info(
      `覆盖分析完成（规则）：${analysis.dimensions.map((d) => `${d.name}=${d.rate}%`).join('，')}`,
    );
    return analysis;
  }

  /** LLM 覆盖分析：构造提示 → 解析 JSON → ajv 校验 → 归一化 */
  private async parseWithLLM(input: CoverageAgentInput, context: AgentContext): Promise<CoverageAnalysis> {
    const userContent = JSON.stringify(
      {
        requirement: input.requirement,
        testCases: input.testCases.map((c) => ({
          id: c.id, name: c.name, priority: c.priority, tags: c.tags,
          assertions: c.assertions,
        })),
        historicalDefects: input.historicalDefects ?? [],
      },
      null,
      2,
    );
    const resp = await context.runtime.generate({
        task: 'coverage',
        agent: this.name,
        system: COVERAGE_SYSTEM_PROMPT,
        user: userContent,
        temperature: 0,
        jsonMode: true,
      });

    const parsed = parseLLMJson(resp);
    if (!isCoverageLike(parsed)) {
      throw new Error('LLM 输出缺少 coverage 结构');
    }
    const validated = await validateCoverage(parsed);
    return normalizeLlmCoverage(validated, input);
  }
}

/** 归一化 LLM 覆盖分析：coverage 数值化 + dimensions 派生 + recommendedCases 规整 */
function normalizeLlmCoverage(raw: Record<string, unknown>, input: CoverageAgentInput): CoverageAnalysis {
  const coverage: Record<string, number> = {};
  for (const [k, v] of Object.entries((raw.coverage as Record<string, unknown>) ?? {})) {
    coverage[k] = typeof v === 'number' ? Math.max(0, Math.min(100, v)) : 0;
  }
  const gaps = Array.isArray(raw.gaps) ? raw.gaps.map(String) : [];
  const recs: CoverageRecommendation[] = Array.isArray(raw.recommendedCases)
    ? raw.recommendedCases
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => ({
          description: String(r.description ?? ''),
          priority: (['P1', 'P2', 'P3'] as const).includes(String(r.priority) as 'P1') ? String(r.priority) as 'P1' | 'P2' | 'P3' : 'P2',
          dimension: String(r.dimension ?? 'unknown'),
        }))
        .filter((r) => r.description)
    : [];

  // 用确定性分析补齐 dimensions（保证结构完整）
  const base = computeCoverageAnalysis(input);
  return buildCoverage({
    feature: input.requirement.feature,
    dimensions: base.dimensions.map((d) => ({ ...d, rate: coverage[d.name] ?? d.rate })),
    coverage,
    gaps,
    recommendedCases: recs,
    source: 'llm',
    confidence: 0.9,
  });
}

/** 便捷工厂 */
export function createCoverageAgent(): CoverageAgent {
  return new CoverageAgent();
}

// 重导出便于外部消费
export { CoverageAnalysis, buildCoverage } from './coverage-schema.js';
export { COVERAGE_JSON_SCHEMA } from './coverage-schema.js';
export { computeCoverageAnalysis, CoverageInput } from './coverage-analyzer.js';
