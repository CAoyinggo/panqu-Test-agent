// Self-Healing Agent：自愈建议（Phase 15）
// 铁律：LLM 一律不得自动修改核心代码。检测 → 生成 Patch/Diff → 风险评估 →
// 人工确认（Approval，Phase 16）→ 才允许修改。
// Deterministic First：路径失效检测与最近路径搜索由 analyzeHealing 完成；
// LLM 仅补充修复理由，失败回退确定性理由。所有建议状态恒为 SUGGESTED。
import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import { parseLLMJson } from '../../llm/index.js';
import type { CaseExecutionResult } from '../execution/execution-schema.js';
import { HealingAnalysis, buildHealingSuggestion } from './healing-schema.js';
import { analyzeHealing } from './healing-analyzer.js';

/** 系统提示词：只补充理由，禁止声称已修改代码 */
export const HEALING_SYSTEM_PROMPT = `你是测试自愈专家。基于给定的 JSON Path 失效检测结果，为每条建议补充修复理由。
重要约束：你只生成修复建议（SUGGESTED），绝不声称已修改代码或已应用补丁。
只输出 JSON：
{"reason":"修复理由（结合响应结构变化说明为何该新路径更可能）"}`;

/** 自愈输入 */
export interface SelfHealingAgentInput {
  feature: string;
  failedCases: CaseExecutionResult[];
  /** 实际响应 Schema（可选） */
  actualSchema?: Record<string, unknown>;
}

/** Self-Healing Agent */
export class SelfHealingAgent extends BaseAgent<SelfHealingAgentInput, HealingAnalysis> {
  name = 'self-healing';
  version = '0.1.0';
  description = '检测测试失效并生成修复建议（仅 SUGGESTED，需人工审批，绝不自动改码）';

  async execute(input: SelfHealingAgentInput, context: AgentContext): Promise<HealingAnalysis> {
    if (!input?.failedCases || input.failedCases.length === 0) {
      throw new Error('自愈输入为空：缺少 failedCases');
    }

    // 1. 确定性检测（路径失效 + 最近路径搜索）
    const analysis = analyzeHealing({ feature: input.feature, failedCases: input.failedCases, actualSchema: input.actualSchema });

    // 2. 无可修复项直接返回（无 LLM 调用）
    if (analysis.suggestions.length === 0) {
      return analysis;
    }

    // 3. LLM 补充理由（失败则保留确定性理由）
    try {
      const enriched = await this.enrichWithLLM(input, analysis, context);
      context.logger.info(`自愈建议生成完成（LLM 补充理由）：${enriched.suggestions.length} 条待审批`);
      return enriched;
    } catch (e) {
      context.logger.warn(`LLM 自愈理由补充失败，保留规则理由：${(e as Error).message}`);
    }
    return analysis;
  }

  /** LLM 补充修复理由：只传确定性检测结果，禁止改动路径/补丁 */
  private async enrichWithLLM(
    input: SelfHealingAgentInput,
    analysis: HealingAnalysis,
    context: AgentContext,
  ): Promise<HealingAnalysis> {
    const payload = analysis.suggestions.map((s) => ({
      caseId: s.caseId,
      oldPath: s.oldPath,
      newPath: s.newPath,
      confidence: s.confidence,
      patch: s.patch,
    }));
    const resp = await context.runtime.generate({
        task: 'healing',
        agent: this.name,
        system: HEALING_SYSTEM_PROMPT,
        user: JSON.stringify(payload, null, 2),
        temperature: 0,
        jsonMode: true,
      });
    const parsed = parseLLMJson<Record<string, unknown>>(resp);
    const reason = typeof parsed?.reason === 'string' && parsed.reason.length > 0 ? parsed.reason : undefined;

    const suggestions = analysis.suggestions.map((s) =>
      buildHealingSuggestion({
        ...s,
        reason: reason ? `${s.reason}；${reason}` : s.reason,
      }),
    );
    return { ...analysis, suggestions, source: 'rules+llm' };
  }
}

/** 便捷工厂 */
export function createSelfHealingAgent(): SelfHealingAgent {
  return new SelfHealingAgent();
}

// 重导出便于外部消费
export { HealingAnalysis, HealingSuggestion, HealingType, HealingStatus, buildHealingSuggestion } from './healing-schema.js';
export { analyzeHealing, findClosestPath, pathSimilarity, extractPaths, isPathFailure, extractErrorCodeMismatch, classifyPathChange } from './healing-analyzer.js';
