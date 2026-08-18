// Evidence Collector：RCA 证据链收集器（Phase 13）
// 禁止「断言失败 → LLM 猜原因」。本模块按证据链逐环收集确定事实：
//   Assertion → HTTP Response → Scene Result → Environment → Execution History
//   → Metrics → Recent Changes → Historical Similar Failures → RCA
// 证据链中的「确定事实」由本模块产出；AI 推断 / 猜测由 RCA Agent 附加。
import type { CaseExecutionResult, ExecutionOutcome } from '../execution/execution-schema.js';
import type { TestMemory } from '../memory/memory-store.js';
import {
  EvidenceItem,
  FailureCategory,
} from './root-cause-schema.js';
import { classifyFailure, ClassificationResult } from './failure-classifier.js';

/** 历史相似失败（来自记忆层） */
export interface HistoricalSimilarFailure {
  id: string;
  caseId?: string;
  category?: string;
  message?: string;
  createdAt?: string;
  tags?: string[];
}

/** 证据收集输入 */
export interface EvidenceCollectorInput {
  /** 目标用例（必选） */
  executionResult: CaseExecutionResult;
  /** 整轮执行结果（可选：场景/汇总上下文） */
  outcome?: ExecutionOutcome;
  /** 环境标识 */
  environment?: string;
  /** 功能模块 */
  feature?: string;
  /** 最近变更说明（可选） */
  recentChanges?: string[];
  /** 运行时指标（可选，如服务延迟/错误率） */
  metrics?: Record<string, unknown>;
  /** 历史失败（可选，可直接传入已检索结果） */
  history?: HistoricalSimilarFailure[];
  /** 记忆层（可选，用于查询历史相似失败） */
  memory?: TestMemory;
  /** 是否收集历史相似失败（默认 true） */
  withHistory?: boolean;
}

/** 证据收集结果 */
export interface EvidenceCollection {
  caseId: string;
  name?: string;
  /** 证据链（确定性证据，全部为 fact） */
  items: EvidenceItem[];
  /** 确定事实（证据链可读文本） */
  facts: string[];
  /** 确定性分类结果 */
  classification: ClassificationResult;
  /** 历史相似失败 */
  historical: HistoricalSimilarFailure[];
  /** 是否发现历史同类问题 */
  hasHistoricalSimilar: boolean;
}

/** 收集执行结果断言证据（Assertion） */
function collectAssertion(executionResult: CaseExecutionResult): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  if (executionResult.error) {
    items.push({ type: 'execution-result', detail: `错误信息：${executionResult.error.slice(0, 200)}`, certainty: 'fact', source: executionResult.caseId });
  }
  const failedChecks = (executionResult.checks ?? []).filter((c) => !c.pass);
  for (const c of failedChecks.slice(0, 10)) {
    items.push({ type: 'assertion', detail: `断言「${c.name}」失败：${c.detail.slice(0, 200)}`, certainty: 'fact', source: executionResult.caseId });
  }
  if (executionResult.timedOut) {
    items.push({ type: 'execution-result', detail: `执行超时（durationMs=${executionResult.durationMs ?? '?'}）`, certainty: 'fact', source: executionResult.caseId });
  }
  return items;
}

/** 收集 HTTP 响应证据（从错误消息中的状态码/响应片段） */
function collectHttpResponse(executionResult: CaseExecutionResult): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const err = executionResult.error ?? '';
  const statusMatch = err.match(/\b(\d{3})\b/);
  if (statusMatch) {
    items.push({ type: 'http-response', detail: `HTTP 状态码：${statusMatch[1]}`, certainty: 'fact', source: executionResult.caseId });
  }
  const body = err.match(/(?:response|body|返回|实际)[:：]\s*[^|]{0,160}/i);
  if (body) {
    items.push({ type: 'http-response', detail: `响应摘要：${body[0].slice(0, 160)}`, certainty: 'fact', source: executionResult.caseId });
  }
  return items;
}

/** 收集场景/执行上下文证据（Scene Result） */
function collectScene(executionResult: CaseExecutionResult, outcome?: ExecutionOutcome): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  if (executionResult.scene) {
    items.push({ type: 'scene-result', detail: `场景：${executionResult.scene}`, certainty: 'fact', source: executionResult.caseId });
  }
  if (outcome) {
    items.push({
      type: 'scene-result',
      detail: `整轮执行：共 ${outcome.total} 条，通过 ${outcome.passed}，失败 ${outcome.failed}，超时 ${outcome.timedOut}，通过率 ${outcome.passRate}%`,
      certainty: 'fact',
      source: 'execution-outcome',
    });
  }
  return items;
}

/** 收集环境证据（Environment） */
function collectEnvironment(environment?: string): EvidenceItem[] {
  if (!environment) return [];
  return [{ type: 'environment', detail: `执行环境：${environment}`, certainty: 'fact', source: 'context' }];
}

/** 收集指标证据（Metrics） */
function collectMetrics(metrics?: Record<string, unknown>): EvidenceItem[] {
  if (!metrics || Object.keys(metrics).length === 0) return [];
  const lines = Object.entries(metrics).slice(0, 8).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return [{ type: 'metrics', detail: `运行时指标：${lines.join('，')}`, certainty: 'fact', source: 'metrics' }];
}

/** 收集最近变更证据（Recent Changes） */
function collectRecentChanges(recentChanges?: string[]): EvidenceItem[] {
  if (!recentChanges || recentChanges.length === 0) return [];
  return [{ type: 'recent-changes', detail: `最近变更：${recentChanges.slice(0, 5).join('；')}`, certainty: 'fact', source: 'vcs' }];
}

/**
 * 收集证据链（确定性部分）。
 * 返回的证据 items 全部标记为 fact（确定事实）；AI 推断由 RCA Agent 附加。
 */
export function collectEvidence(input: EvidenceCollectorInput): EvidenceCollection {
  const { executionResult, outcome, environment, feature, recentChanges, metrics } = input;
  const items: EvidenceItem[] = [
    ...collectAssertion(executionResult),
    ...collectHttpResponse(executionResult),
    ...collectScene(executionResult, outcome),
    ...collectEnvironment(environment),
    ...collectMetrics(metrics),
    ...collectRecentChanges(recentChanges),
  ];
  if (feature) {
    items.unshift({ type: 'execution-history', detail: `功能模块：${feature}`, certainty: 'fact', source: 'context' });
  }

  const classification = classifyFailure(executionResult);
  return {
    caseId: executionResult.caseId,
    name: executionResult.name,
    items,
    facts: items.map((e) => `[${e.type}] ${e.detail}`),
    classification,
    historical: [],
    hasHistoricalSimilar: false,
  };
}

/** 从记忆层查询历史相似失败（Execution History → Historical Similar Failures） */
export async function collectHistoricalFailures(
  collection: EvidenceCollection,
  memory?: TestMemory,
  history?: HistoricalSimilarFailure[],
): Promise<EvidenceCollection> {
  let historical: HistoricalSimilarFailure[] = history ?? [];
  if (memory && historical.length === 0) {
    try {
      const records = await memory.getSimilarFailures({
        caseId: collection.caseId,
        category: collection.classification.category,
        message: collection.facts.join('\n'),
        tags: undefined,
      });
      historical = records.map((r) => ({
        id: r.id,
        caseId: typeof r.data.caseId === 'string' ? r.data.caseId : undefined,
        category: typeof r.data.category === 'string' ? r.data.category : r.type,
        message: typeof r.data.message === 'string' ? r.data.message : undefined,
        createdAt: r.createdAt,
        tags: r.tags,
      }));
    } catch {
      historical = [];
    }
  }

  if (historical.length > 0) {
    collection.items.push({
      type: 'historical-failure',
      detail: `历史相似失败 ${historical.length} 条：${historical.slice(0, 3).map((h) => `#${h.caseId ?? h.id}${h.message ? ` ${h.message.slice(0, 60)}` : ''}`).join('；')}`,
      certainty: 'fact',
      source: 'memory',
    });
    collection.facts = collection.items.map((e) => `[${e.type}] ${e.detail}`);
  }
  collection.historical = historical;
  collection.hasHistoricalSimilar = historical.length > 0;
  return collection;
}

/** 便捷组合：同步收集 + 异步历史（供 RCA Agent 使用） */
export async function collectFullEvidence(input: EvidenceCollectorInput): Promise<EvidenceCollection> {
  const base = collectEvidence(input);
  if (input.withHistory === false) return base;
  return collectHistoricalFailures(base, input.memory, input.history);
}
