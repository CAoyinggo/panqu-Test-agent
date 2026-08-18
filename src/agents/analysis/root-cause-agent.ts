// Root Cause Agent：RCA 深度根因分析（Phase 13）
// 铁律：禁止「断言失败 → LLM 猜原因」。RCA 必须先收集证据链（Evidence Collector），
// 再让 LLM 基于证据链推断根因。确定事实来自证据链；LLM 输出一律标注为「AI 推断」。
// 策略：证据链（确定性）→ LLM 推断（失败则回退确定性分类器 + 证据事实）。
import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import { parseLLMJson } from '../../llm/index.js';
import type { CaseExecutionResult, ExecutionOutcome } from '../execution/execution-schema.js';
import {
  RootCauseAnalysis,
  ROOT_CAUSE_JSON_SCHEMA,
  isRootCauseLike,
  validateRootCause,
  normalizeRootCause,
  buildRootCause,
  FAILURE_CATEGORIES,
} from './root-cause-schema.js';
import { collectFullEvidence, EvidenceCollection, HistoricalSimilarFailure } from './evidence-collector.js';
import { classifyFailure } from './failure-classifier.js';

/** 系统提示词：要求 LLM 严格基于证据链推断，禁止猜测 */
const SYSTEM_PROMPT = `你是资深测试根因分析专家。你只能基于给定的「证据链」推断失败根因，
禁止编造证据中不存在的服务、日志或数据。必须区分「AI 推断」与「低置信度猜测」。
输出严格符合如下 JSON Schema（只输出 JSON，不要 Markdown 围栏）：
${JSON.stringify(ROOT_CAUSE_JSON_SCHEMA, null, 2)}

规则：
- rootCause：一句话根因，必须能在证据链中找到支撑
- category：从证据与证据链推断最可能的失败分类
- evidence：保留证据链中的关键事实（确定事实）
- inferences：你的推断（AI 推断）
- guesses：低置信度猜测（必须标注「猜测」）
- excludedCauses：明确排除的原因（如与证据矛盾）
- recommendedAction：可执行的下一步动作
- confidence：0~1，依据证据充分度`;

/** RCA 输入 */
export interface RcaAgentInput {
  /** 目标失败用例（必选） */
  executionResult: CaseExecutionResult;
  /** 整轮执行结果（可选） */
  outcome?: ExecutionOutcome;
  /** 环境标识 */
  environment?: string;
  /** 最近变更说明（可选） */
  recentChanges?: string[];
  /** 运行时指标（可选） */
  metrics?: Record<string, unknown>;
  /** 历史相似失败（可选） */
  history?: HistoricalSimilarFailure[];
}

/** RCA Agent */
export class RootCauseAgent extends BaseAgent<RcaAgentInput, RootCauseAnalysis> {
  name = 'root-cause';
  version = '0.1.0';
  description = '基于证据链定位失败根因（Evidence First：确定性证据 + LLM 推断 + 确定性回退）';

  async execute(input: RcaAgentInput, context: AgentContext): Promise<RootCauseAnalysis> {
    if (!input?.executionResult) {
      throw new Error('RCA 输入为空：缺少 executionResult');
    }

    // 1. 证据链收集（确定性事实，永远先于 LLM）
    const evidence = await collectFullEvidence({
      executionResult: input.executionResult,
      outcome: input.outcome,
      environment: input.environment,
      feature: input.executionResult.feature,
      recentChanges: input.recentChanges,
      metrics: input.metrics,
      history: input.history,
      memory: context.memory,
    });

    // 2. LLM 基于证据链推断（失败 / 非法 / 校验不通过 → 确定性回退）
    try {
      const rca = await this.inferWithLLM(input, evidence, context);
      context.logger.info(`RCA 完成（LLM）：${rca.category} / ${rca.rootCause}`);
      return rca;
    } catch (e) {
      context.logger.warn(`LLM RCA 失败，回退确定性分类器：${(e as Error).message}`);
    }

    // 3. 确定性回退：证据事实 + 规则分类（无 AI 推断）
    const rca = buildRootCause({
      caseId: evidence.caseId,
      name: evidence.name,
      category: evidence.classification.category,
      confidence: evidence.classification.confidence,
      rootCause: evidence.classification.reasons[0] ?? evidence.facts[0] ?? '失败原因未知',
      evidenceItems: evidence.items,
      evidence: evidence.facts,
      facts: evidence.facts,
      inferences: [],
      guesses: [],
      excludedCauses: [],
      recommendedAction: `基于证据与分类（${evidence.classification.category}）检查对应环节`,
      source: 'rules',
    });
    context.logger.info(`RCA 完成（规则）：${rca.category}`);
    return rca;
  }

  /** LLM 基于证据链推断：只传证据链与确定性分类，不传原始数据 */
  private async inferWithLLM(
    input: RcaAgentInput,
    evidence: EvidenceCollection,
    context: AgentContext,
  ): Promise<RootCauseAnalysis> {
    const userContent = `用例：${evidence.caseId} ${evidence.name ?? ''}
证据链（确定事实）：
${evidence.facts.join('\n') || '（无）'}
确定性分类：${evidence.classification.category}（置信度 ${evidence.classification.confidence}）
分类依据：${evidence.classification.reasons.join('；') || '（无）'}
历史相似失败：${evidence.historical.length > 0 ? evidence.historical.slice(0, 3).map((h) => `#${h.caseId ?? h.id} ${h.message ?? ''}`).join('；') : '（无）'}
${evidence.hasHistoricalSimilar ? '提示：存在历史同类问题，请结合历史结论推断。' : ''}`;

    const resp = await context.llm.generate({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      jsonMode: true,
    });

    const parsed = parseLLMJson(resp);
    if (!isRootCauseLike(parsed)) {
      throw new Error('LLM 输出缺少 caseId / rootCause 字段');
    }
    const validated = await validateRootCause(parsed);
    // 归一化 + 强制证据链事实合并（确定事实必须来自证据链）
    return mergeEvidence(normalizeRootCause(validated), evidence);
  }
}

/** 合并：确定事实恒来自证据链；LLM 输出归入 AI 推断；分类与证据链不冲突时保留 LLM 分类 */
function mergeEvidence(rca: RootCauseAnalysis, evidence: EvidenceCollection): RootCauseAnalysis {
  const llmInferences = [
    ...(rca.inferences.length ? rca.inferences : rca.evidence.length ? rca.evidence : []),
  ];
  if (rca.rootCause && rca.rootCause.length > 0) {
    llmInferences.unshift(`LLM 根因推断：${rca.rootCause}`);
  }
  return buildRootCause({
    caseId: rca.caseId || evidence.caseId,
    name: rca.name ?? evidence.name,
    // 分类合法性：LLM 分类非法时回落确定性分类
    category: FAILURE_CATEGORIES.includes(rca.category) ? rca.category : evidence.classification.category,
    confidence: rca.confidence,
    rootCause: rca.rootCause,
    evidenceItems: evidence.items,
    evidence: evidence.facts,
    facts: evidence.facts,
    inferences: llmInferences,
    guesses: rca.guesses,
    excludedCauses: rca.excludedCauses,
    recommendedAction: rca.recommendedAction,
    source: 'llm',
  });
}

/** 便捷工厂 */
export function createRootCauseAgent(): RootCauseAgent {
  return new RootCauseAgent();
}

// 重导出便于外部消费
export { RootCauseAnalysis, FailureCategory, buildRootCause } from './root-cause-schema.js';
export { ROOT_CAUSE_JSON_SCHEMA, normalizeRootCause } from './root-cause-schema.js';
export { classifyFailure } from './failure-classifier.js';
export { collectFullEvidence, collectEvidence, EvidenceCollection } from './evidence-collector.js';
