// 核心类型定义：贯穿引擎/用例/断言/报告各层

/** Debug 级别（--debug-level 参数） */
export type DebugLevel = 'basic' | 'verbose' | 'full';

/** HTTP 请求/响应记录（--debug verbose/full 模式下保存） */
export interface HttpRecord {
  step: string;
  timestamp: string;
  name: string;
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseStatus: number;
  responseBody?: unknown;
  durationMs: number;
  error?: string;
}

/** 环境配置 */
export interface EnvironmentConfig {
  base_url: string;
  submit_url?: string;
  status_url?: string;
  detail_url?: string;
  billing_url?: string;
  csrf_page?: string;
  project_id: number;
  account?: string;
  nickname?: string;
}

/** 全局配置（environments 多环境 + 通用项） */
export interface AppConfig {
  default_env: string;
  session_cookies_path: string;
  poll_interval_ms?: number;
  status_text: Record<number | string, string>;
  environments: Record<string, EnvironmentConfig>;
}

/** 登录会话 */
export interface Session {
  env: string;
  account?: string;
  nickname?: string;
  project_id?: number;
  cookie_string: string;
  token_exp: number;
  [key: string]: unknown;
}

/** 任务/用例定义（数据输入层，源自 tasks/*.json 或 TS 用例脚本） */
export interface TaskDef {
  name: string;
  scene: string;
  scene_detail?: string;
  type?: number;
  model_id?: number | string;
  model_name?: string;
  task_type?: number | string;
  task_id?: number | null;
  selmodelsId?: number | string;
  extra?: Record<string, unknown>;
  expected_points?: number;
  uploads?: Array<{ field: string; path: string }>;
  manual_cases?: Array<{ id: string; steps: string }>;
  /** 用例标签（用于 --grep 筛选，如 ['regression', 'P0']） */
  tags?: string[];
  /** 数据工厂名称（--auto-setup 模式下按名称查找注册的 DataFactory） */
  dataFactory?: string;
  /** 数据集预留（数据工厂接口，暂未实现） */
  dataset?: Record<string, unknown>;
  /** setup 预留（前置数据准备，暂未实现） */
  setup?: string;
  /** teardown 预留（后置数据清理，暂未实现） */
  teardown?: string;
  /** 外部数据文件路径（dry-run 模式校验文件是否存在） */
  dataFile?: string;
  /** 声明式断言 DSL（通用断言引擎解析） */
  assert?: AssertionConfig;
  /** 业务适配器选择（如 'wan3'，不设则仅运行通用断言） */
  adapter?: 'wan3' | 'default';
  /** Phase 1：本次执行参数所依赖的 canonical Contract。 */
  contractDependencies?: import('../contracts/types.js').ContractDependency[];
  /** Loader 从 Legacy Migration Index 注入；Agent 生成的 TaskDef 不使用此字段。 */
  legacyContract?: {
    asset: string;
    status: import('../contracts/types.js').LegacyAssetStatus;
    reasons: string[];
  };
  /** 断言失败后的行为：stop=中断（默认），continue=继续执行后续断言 */
  onFail?: 'stop' | 'continue';
  [key: string]: unknown;
}

/** 提交结果（由场景处理器产出，供断言/报告） */
export interface SubmitResult {
  taskId?: number | null;
  status?: string;
  err?: string;
  progress?: number | string;
  videoUrl?: string;
  detail?: Record<string, any>;
  /** 状态流转序列（status-flow-check 断言使用） */
  statusHistory?: string[];
  [key: string]: unknown;
}

/** 计费核验数据 */
export interface BillingData {
  summary?: Record<string, any>;
  trend?: { labels?: string[]; series?: Array<{ name?: string; values?: number[] }> };
  top?: { total?: number; items?: any[] };
  records?: any[];
  modelTrend?: { found: boolean; lastValue?: number | null; modelName?: string };
  net?: number;
  /** 提交前积分快照（available_points / consumed_7d） */
  beforeBalance?: { available_points: number; consumed_7d: number };
  /** 提交后积分快照 */
  afterBalance?: { available_points: number; consumed_7d: number };
  /** 快照差值计算的本次实际净消耗 = before - after */
  actualConsumed?: number;
  /** 安全探针结果（跨账号只读越权检测） */
  securityProbe?: {
    attempted: boolean;
    rejected: boolean;
    detail: string;
  };
  [key: string]: unknown;
}

/** 影响清单条目（数据隔离分析） */
export interface ImpactItem {
  type: '表' | '模块';
  name: string;
  action: string;
  desc: string;
}

/** 核验结论（断言结果） */
export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
  /** 只有 BUSINESS 断言能够参与 PASS；其余类型仅用于诊断、清理或展示。 */
  kind?: import('./execution-evidence.js').AssertionKind;
  level?: 'P0' | 'P1' | 'P2';
  // 扩展字段（通用断言引擎使用，向后兼容）
  assertionType?: 'response' | 'submit' | 'billing' | 'headers' | 'env' | 'metrics' | 'custom';
  path?: string;
  operator?: string;
  expected?: unknown;
  actual?: unknown;
  durationMs?: number;
}

/** 声明式断言配置（与 assertion-engine.ts 的 AssertionConfig 结构兼容） */
export interface AssertionConfig {
  mode?: 'all' | 'any' | 'soft';
  /** 组合器（与 mode 等价，支持 "and"/"or" 别名，用于嵌套组） */
  combinator?: 'and' | 'or';
  rules: unknown[];
  message?: string;
}

/** 接口响应摘要 */
export interface ResponseSummary {
  name: string;
  method: string;
  status: number;
  code: number;
  summary: string;
}

/** 问题卡点 */
export interface IssueItem {
  level: '阻塞' | '数据异常' | '待接入' | '待人工';
  title: string;
  desc: string;
}

/** 素材库扫描结果 */
export interface AssetScan {
  exists: boolean;
  byType: { image: any[]; audio: any[]; video: any[]; text: any[] };
  bySubdir: Record<string, any[]>;
}

/** 素材解析条目 */
export interface ResolvedAsset {
  field: string;
  path: string;
  full: string;
}

/** 素材使用信息（供报告） */
export interface AssetInfo {
  exists: boolean;
  counts?: { image: number; audio: number; video: number; text: number } | null;
  resolved: ResolvedAsset[];
}

/** 执行上下文（传给场景处理器方法与钩子） */
export interface RunContext {
  env: string;
  session: Session;
  taskDef: TaskDef;
  http: any;
  assets: any;
  CFG: AppConfig;
  responses: ResponseSummary[];
  submit: SubmitResult;
  taskId: number | null;
  /** 数据工厂产出的上下文（--auto-setup 模式） */
  data?: DataContext;
  [key: string]: unknown;
}

/** 报告数据（报告器统一入参） */
export interface ReportData {
  title: string;
  env: string;
  taskDef: TaskDef & { project_id?: number; account?: string };
  submit: SubmitResult;
  billingData: BillingData;
  impact: ImpactItem[];
  checks: CheckResult[];
  responses: ResponseSummary[];
  manual: Array<{ id: string; steps: string }>;
  issues: IssueItem[];
  passRate: number;
  /** 是否完成真实 Processor 执行。 */
  executed?: boolean;
  /** PASS / FAIL / BLOCKED / NOT_EXECUTED。 */
  executionStatus?: import('./execution-status.js').CoreExecutionStatus;
  assetInfo: AssetInfo;
  /** 执行追踪 ID（Phase 3） */
  traceId?: string;
  /** 执行度量数据（Phase 3） */
  metrics?: Record<string, unknown>;
  /** 环境一致性检测结果 */
  envDiff?: EnvDiff;
  /** 数据上下文快照（--auto-setup 模式） */
  dataContext?: DataContext;
  /** debug 产物目录路径（供报告器生成链接） */
  debugProducts?: string;
}

/**
 * 数据上下文：DataFactory.setup() 产出的测试数据快照
 * 在 pipeline 执行期间通过 RunContext.data 传递，teardown 时用于清理
 */
export interface DataContext {
  /** 账号信息 */
  account?: { id: string; nickname: string; project_id: number };
  /** 积分快照 */
  balance?: { initial: number; consumed: number; remaining: number };
  /** 素材列表 */
  assets?: Array<{ id: string; type: string; url: string }>;
  /** 创建的任务 ID 列表（teardown 时清理用） */
  taskIds?: string[];
  /** 扩展数据 */
  extra?: Record<string, unknown>;
}

/**
 * 数据工厂接口：自动构造测试数据、清理残留数据、批量生成参数化用例。
 * - setup()：在用例执行前准备数据（如充值、上传素材、创建辅助任务）
 * - teardown()：在用例执行后清理数据（如删除任务、回退积分）
 * - generate()：批量生成参数化用例（预留，暂未集成到 loader）
 */
export interface DataFactory {
  /** 准备测试数据：创建账号、充值、上传素材等 */
  setup(ctx: RunContext): Promise<DataContext>;
  /** 清理测试数据：删除任务、回退积分、删除素材等 */
  teardown(ctx: RunContext, data: DataContext): Promise<void>;
  /** 生成测试数据集（用于参数化） */
  generate(params: Record<string, unknown>): Promise<DataContext>;
}

/** 环境快照（用于一致性检测） */
export interface EnvSnapshot {
  /** 快照时间戳 */
  timestamp: string;
  /** 环境名称 */
  env: string;
  /** 积分余额 */
  availablePoints: number;
  /** 近 7 天消耗 */
  consumed7d: number;
  /** 模型列表与单价 */
  models: Array<{ id: string | number; name: string; price?: number }>;
  /** 环境配置摘要（base_url / project_id / account） */
  config: { base_url: string; project_id: number; account: string };
}

/** 环境差异检测结果 */
export interface EnvDiff {
  /** 是否有差异 */
  changed: boolean;
  /** 差异详情 */
  changes: Array<{
    field: string;
    before: string;
    after: string;
    severity: 'info' | 'warning' | 'error';
  }>;
}
