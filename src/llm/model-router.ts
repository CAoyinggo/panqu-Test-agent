// Model Router：模型路由（Phase 17 横切 / 任务书第二十节）
// 不同任务不一定使用同一个模型。按任务类型分配 model / fallbackModel /
// timeout / temperature / maxTokens。支持模型档位（high/medium/small）映射具体模型。
// 建议：Requirement/Analysis/RCA → 高能力；Test Design → 中高；Risk/简单分类 → 小模型。

/** 任务类型（Agent 种类） */
export type TaskKind =
  | 'requirement'
  | 'test-design'
  | 'data'
  | 'test-selection'
  | 'coverage'
  | 'risk'
  | 'analysis'
  | 'rca'
  | 'defect'
  | 'healing'
  | 'flaky'
  | 'classification';

/** 模型档位 */
export type ModelTier = 'high' | 'medium' | 'small';

/** 单任务路由配置 */
export interface RouteConfig {
  /** 主模型（可为档位名或具体模型名） */
  model: string;
  /** 回退模型 */
  fallbackModel?: string;
  /** 超时（ms） */
  timeoutMs?: number;
  /** 采样温度 */
  temperature?: number;
  /** 最大输出 token */
  maxTokens?: number;
  /** 最大输入 token；Runtime 在调用 Provider 前 fail-fast，避免上下文溢出与无效计费。 */
  maxInputTokens?: number;
}

/**
 * 成本/质量策略层输出给 ModelRouter 的最小契约。
 * 保持结构化接口，避免 Router 反向依赖 cost governance 模块。
 */
export interface ModelPolicyDecisionLike {
  selectedModel: string;
  fallbackModel?: string;
}

/** 档位 → 具体模型映射 */
export interface ModelTierMap {
  high: string;
  medium: string;
  small: string;
}

const DEFAULT_TIERS: ModelTierMap = { high: 'gpt-4o', medium: 'gpt-4o-mini', small: 'gpt-4o-mini' };

/** 默认路由：任务书第二十节建议 */
const DEFAULT_ROUTES: Record<TaskKind, RouteConfig> = {
  requirement: { model: 'high', fallbackModel: 'medium', timeoutMs: 30000, temperature: 0, maxTokens: 2000, maxInputTokens: 100_000 },
  'test-design': { model: 'medium', fallbackModel: 'small', timeoutMs: 30000, temperature: 0.3, maxTokens: 3000, maxInputTokens: 100_000 },
  data: { model: 'medium', fallbackModel: 'small', timeoutMs: 30000, temperature: 0, maxTokens: 3000, maxInputTokens: 100_000 },
  'test-selection': { model: 'small', timeoutMs: 15000, temperature: 0 },
  coverage: { model: 'small', timeoutMs: 15000, temperature: 0 },
  risk: { model: 'small', fallbackModel: 'small', timeoutMs: 10000, temperature: 0 },
  analysis: { model: 'high', fallbackModel: 'medium', timeoutMs: 30000, temperature: 0, maxTokens: 2000 },
  rca: { model: 'high', fallbackModel: 'medium', timeoutMs: 30000, temperature: 0, maxTokens: 2000 },
  defect: { model: 'high', fallbackModel: 'medium', timeoutMs: 30000, temperature: 0, maxTokens: 2000 },
  healing: { model: 'medium', fallbackModel: 'small', timeoutMs: 20000, temperature: 0 },
  flaky: { model: 'small', timeoutMs: 10000, temperature: 0 },
  classification: { model: 'small', timeoutMs: 8000, temperature: 0 },
};

/**
 * 从环境变量加载档位映射（Phase 20.1：LLM_HIGH_MODEL / LLM_MEDIUM_MODEL / LLM_SMALL_MODEL）。
 * 未设置任何档位时返回 undefined（保持默认）。
 */
export function loadTiersFromEnv(
  env: Record<string, string | undefined> = process.env,
): ModelTierMap | undefined {
  const high = env.LLM_HIGH_MODEL;
  const medium = env.LLM_MEDIUM_MODEL;
  const small = env.LLM_SMALL_MODEL;
  if (!high && !medium && !small) return undefined;
  return {
    high: high ?? DEFAULT_TIERS.high,
    medium: medium ?? DEFAULT_TIERS.medium,
    small: small ?? DEFAULT_TIERS.small,
  };
}

/** 应用环境变量档位到指定 Router（默认单例），返回是否已应用 */
export function applyTiersFromEnv(
  router: ModelRouter = modelRouter,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const tiers = loadTiersFromEnv(env);
  if (!tiers) return false;
  router.setTiers(tiers);
  return true;
}

/** 模型路由 */
export class ModelRouter {
  private readonly routes: Record<TaskKind, RouteConfig>;
  private readonly tiers: ModelTierMap;
  private readonly defaultConfig: RouteConfig;

  constructor(options: {
    tiers?: ModelTierMap;
    defaultConfig?: RouteConfig;
    routes?: Partial<Record<TaskKind, RouteConfig>>;
  } = {}) {
    this.tiers = { ...DEFAULT_TIERS, ...(options.tiers ?? {}) };
    this.routes = { ...DEFAULT_ROUTES, ...(options.routes ?? {}) };
    this.defaultConfig = options.defaultConfig ?? { model: this.tiers.medium, timeoutMs: 30000, temperature: 0 };
  }

  /** 解析档位为具体模型名（非档位则原样返回） */
  resolveModel(model: string): string {
    return this.tiers[model as ModelTier] ?? model;
  }

  /** 按任务类型获取路由配置（未配置回退默认） */
  route(kind: TaskKind): RouteConfig {
    const cfg = this.routes[kind] ?? this.defaultConfig;
    return {
      ...cfg,
      model: this.resolveModel(cfg.model),
      fallbackModel: cfg.fallbackModel ? this.resolveModel(cfg.fallbackModel) : undefined,
    };
  }

  /** 覆盖某任务的路由配置 */
  configure(kind: TaskKind, config: Partial<RouteConfig>): void {
    this.routes[kind] = { ...this.routes[kind], ...config };
  }

  /**
   * 将 Model Policy 的选择结果应用到真实 LLM 路由。
   * timeout / temperature / maxTokens 等任务参数继续沿用现有路由配置。
   */
  applyPolicyDecision(kind: TaskKind, decision: ModelPolicyDecisionLike): RouteConfig {
    const selectedModel = decision.selectedModel.trim();
    if (!selectedModel) throw new Error('模型策略未返回 selectedModel');
    this.configure(kind, {
      model: selectedModel,
      fallbackModel: decision.fallbackModel?.trim() || undefined,
    });
    return this.route(kind);
  }

  /** 覆盖档位映射 */
  setTiers(tiers: ModelTierMap): void {
    Object.assign(this.tiers, tiers);
  }

  /** 全部路由（已解析为具体模型） */
  list(): Record<TaskKind, RouteConfig> {
    const out = {} as Record<TaskKind, RouteConfig>;
    for (const k of Object.keys(this.routes) as TaskKind[]) {
      out[k] = this.route(k);
    }
    return out;
  }
}

/** 单例（供 Pipeline / CLI 复用） */
export const modelRouter = new ModelRouter();
