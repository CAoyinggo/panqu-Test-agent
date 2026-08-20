// Evaluation Cost Tracking（Phase 45 / 42.19）
// 每次 AI 评测记录 inputTokens / outputTokens / latencyMs / cost（美元）。
// 确定性（规则）评测不消耗 token，cost=0；LLM 评测按 token 计价估算。
// 报告同时给出 Score + Cost，支撑后续 Quality/Cost 优化。

export interface EvaluationCost {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  /** 估算成本（美元） */
  cost: number;
}

export const EMPTY_COST: EvaluationCost = { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0, cost: 0 };

/** 每 1K token 计价（美元），可按模型覆盖 */
export interface TokenPricing {
  inputPer1K: number;
  outputPer1K: number;
}

export const DEFAULT_PRICING: TokenPricing = { inputPer1K: 0.0015, outputPer1K: 0.002 };

/** 由 token 用量与计价估算成本 */
export function estimateCost(tokens: { inputTokens: number; outputTokens: number }, pricing: TokenPricing = DEFAULT_PRICING): number {
  return (tokens.inputTokens / 1000) * pricing.inputPer1K + (tokens.outputTokens / 1000) * pricing.outputPer1K;
}

export function buildCost(parts: Array<Partial<EvaluationCost>>, pricing: TokenPricing = DEFAULT_PRICING): EvaluationCost {
  const inputTokens = parts.reduce((s, p) => s + (p.inputTokens ?? 0), 0);
  const outputTokens = parts.reduce((s, p) => s + (p.outputTokens ?? 0), 0);
  const latencyMs = parts.reduce((s, p) => s + (p.latencyMs ?? 0), 0);
  const explicit = parts.reduce((s, p) => s + (p.cost ?? 0), 0);
  const cost = explicit > 0 ? explicit : estimateCost({ inputTokens, outputTokens }, pricing);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, latencyMs, cost: round6(cost) };
}

function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}
