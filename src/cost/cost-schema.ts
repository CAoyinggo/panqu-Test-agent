// Cost Schema：测试成本记录模型（Phase 21.6 Cost Optimization）
// 记录 LLM / 环境 / API / GPU / 积分 / 执行时间 六类成本，
// 支持 Cost/Case、Cost/Feature、Cost/Regression、Cost/Defect 聚合。

/** 成本类别 */
export type CostCategory = 'llm' | 'environment' | 'api' | 'gpu' | 'credit' | 'time';

export const COST_CATEGORIES: readonly CostCategory[] = [
  'llm', 'environment', 'api', 'gpu', 'credit', 'time',
];

/** 单条成本记录 */
export interface CostRecord {
  id: string;
  category: CostCategory;
  /** 成本金额（统一计量单位，默认 credit） */
  amount: number;
  /** 计量单位（credit / usd / ms / token 等，仅展示用途） */
  unit: string;
  /** 归属：业务 / 功能 / 用例 / 回归运行 / 缺陷（可多挂） */
  businessId?: string;
  feature?: string;
  caseId?: string;
  regressionRunId?: string;
  defectId?: string;
  /** 数量（如 token 数 / API 调用次数 / GPU 秒数） */
  quantity?: number;
  description?: string;
  timestamp: string;
}

/** 记录成本输入 */
export interface CreateCostInput {
  id?: string;
  category: CostCategory;
  amount: number;
  unit?: string;
  businessId?: string;
  feature?: string;
  caseId?: string;
  regressionRunId?: string;
  defectId?: string;
  quantity?: number;
  description?: string;
  timestamp?: string;
}

/** LLM 成本估算配置（与 AgentTracer.CostConfig 对齐） */
export interface LLMCostConfig {
  /** 每 1K input token 成本 */
  inputPer1k?: number;
  /** 每 1K output token 成本 */
  outputPer1k?: number;
}

/** 默认 LLM 成本（与 observability/tracer 的 DEFAULT_COST 一致） */
export const DEFAULT_LLM_COST: LLMCostConfig = { inputPer1k: 0.001, outputPer1k: 0.002 };

let costSeq = 0;

/** 生成成本记录 id */
export function generateCostId(): string {
  costSeq += 1;
  return `cost-${Date.now().toString(36)}-${String(costSeq).padStart(4, '0')}`;
}

/** 估算 LLM 调用成本 */
export function estimateLLMCost(inputTokens: number, outputTokens: number, config: LLMCostConfig = DEFAULT_LLM_COST): number {
  const cost = ((inputTokens / 1000) * (config.inputPer1k ?? 0)) + ((outputTokens / 1000) * (config.outputPer1k ?? 0));
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** 校验并归一化成本输入：非法抛错 */
export function normalizeCreateCostInput(input: unknown): CreateCostInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Cost 记录失败：输入必须为对象');
  }
  const raw = input as Record<string, unknown>;
  if (!raw.category || !COST_CATEGORIES.includes(raw.category as CostCategory)) {
    throw new Error(`Cost 记录失败：category 无效（需为 ${COST_CATEGORIES.join(' / ')}）`);
  }
  const amount = typeof raw.amount === 'number' ? raw.amount : NaN;
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Cost 记录失败：amount 需为 ≥0 的数字');
  const out: CreateCostInput = {
    category: raw.category as CostCategory,
    amount,
    unit: typeof raw.unit === 'string' ? raw.unit : 'credit',
  };
  if (typeof raw.id === 'string' && raw.id.trim()) out.id = raw.id.trim();
  for (const key of ['businessId', 'feature', 'caseId', 'regressionRunId', 'defectId', 'description', 'timestamp'] as const) {
    if (typeof raw[key] === 'string' && (raw[key] as string).trim()) out[key] = (raw[key] as string).trim();
  }
  if (typeof raw.quantity === 'number' && Number.isFinite(raw.quantity)) out.quantity = raw.quantity;
  return out;
}
