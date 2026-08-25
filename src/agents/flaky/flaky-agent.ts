// Flaky Agent：Flaky Test 管理（Phase 13）
// Deterministic First：统计与分类由规则引擎完成（analyzeFlakiness），
// LLM 仅负责解释 flaky 原因（失败可回退规则汇总）。
// 策略：识别 → 隔离 → 降低可信度（quarantine）。
import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import { parseLLMJson } from '../../llm/index.js';
import { RunRecord, FlakyAnalysis, isFlakyLike, normalizeFlakyAnalysis, buildFlakyAnalysis } from './flaky-schema.js';
import { analyzeFlakiness } from './flaky-analyzer.js';

/** 系统提示词：只做解释，不改统计 */
export const FLAKY_SYSTEM_PROMPT = `你是 Flaky Test 分析专家。基于给定的 Flaky 统计结果（规则已计算），
解释为何这些用例不稳定，并给出处理建议。只输出 JSON：
{"summary":"一句话汇总（说明 flaky/unstable 用例数与主要模式）","notes":[{"caseId":"tc-01","note":"该用例不稳定原因分析"}]}`;

/** Flaky 输入 */
export interface FlakyAgentInput {
  feature?: string;
  /** 历史运行记录（多次运行） */
  runs: RunRecord[];
}

/** Flaky Agent */
export class FlakyAgent extends BaseAgent<FlakyAgentInput, FlakyAnalysis> {
  name = 'flaky';
  version = '0.1.0';
  description = 'Flaky Test 统计分类与隔离建议（确定性统计优先，LLM 解释兜底）';

  async execute(input: FlakyAgentInput, context: AgentContext): Promise<FlakyAnalysis> {
    if (!input?.runs || input.runs.length === 0) {
      throw new Error('Flaky 输入为空：缺少 runs');
    }

    // 1. 确定性统计（永远生效，AI 不参与计算）
    const analysis = analyzeFlakiness({ feature: input.feature, runs: input.runs });

    // 2. LLM 补充解释（失败则保留规则汇总）
    try {
      const explained = await this.explainWithLLM(input, analysis, context);
      context.logger.info(`Flaky 分析完成（LLM 解释）：${analysis.quarantineIds.length} 个需隔离`);
      return explained;
    } catch (e) {
      context.logger.warn(`LLM Flaky 解释失败，保留规则汇总：${(e as Error).message}`);
    }
    return analysis;
  }

  /** LLM 解释：只传规则统计结果，禁止改动分类 */
  private async explainWithLLM(input: FlakyAgentInput, analysis: FlakyAnalysis, context: AgentContext): Promise<FlakyAnalysis> {
    const unstable = analysis.records.filter((r) => r.status === 'FLAKY' || r.status === 'UNSTABLE');
    const userContent = JSON.stringify(
      {
        feature: input.feature,
        unstable: unstable.slice(0, 20).map((r) => ({
          caseId: r.caseId, status: r.status, runs: r.runs, passRate: r.passRate,
          flakinessIndex: r.flakinessIndex, environmentCorrelation: r.environmentCorrelation,
          retryCorrelation: r.retryCorrelation, failedRuns: r.failedRuns.slice(0, 5),
        })),
      },
      null,
      2,
    );
    const resp = await context.runtime.generate({
        task: 'flaky',
        agent: this.name,
        system: FLAKY_SYSTEM_PROMPT,
        user: userContent,
        temperature: 0,
        jsonMode: true,
      });
    const parsed = parseLLMJson<Record<string, unknown>>(resp);
    if (typeof parsed?.summary !== 'string') {
      throw new Error('LLM Flaky 解释缺少 summary');
    }
    return buildFlakyAnalysis({
      feature: analysis.feature,
      records: analysis.records,
      summary: parsed.summary,
      source: 'rules+llm',
    });
  }
}

/** 便捷工厂 */
export function createFlakyAgent(): FlakyAgent {
  return new FlakyAgent();
}

// 重导出便于外部消费
export { FlakyAnalysis, FlakyStatus, RunRecord, buildFlakyAnalysis } from './flaky-schema.js';
export { analyzeFlakiness, computeFlakinessIndex, classifyStatus } from './flaky-analyzer.js';
