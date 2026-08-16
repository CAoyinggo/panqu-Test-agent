// 核心类型定义：贯穿引擎/用例/断言/报告各层

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
  /** 数据集预留（数据工厂接口，暂未实现） */
  dataset?: Record<string, unknown>;
  /** setup 预留（前置数据准备，暂未实现） */
  setup?: string;
  /** teardown 预留（后置数据清理，暂未实现） */
  teardown?: string;
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
  level?: 'P0' | 'P1' | 'P2';
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
  assetInfo: AssetInfo;
  /** 执行追踪 ID（Phase 3） */
  traceId?: string;
  /** 执行度量数据（Phase 3） */
  metrics?: Record<string, unknown>;
}

/**
 * 数据工厂接口（预留，暂未实现）。
 * 未来用于：自动构造测试数据、清理残留数据、批量生成参数化用例。
 * 当前业务数据由登录态带入，无需自动构造。
 */
export interface DataFactory {
  /** 构造测试数据（预留） */
  setup?(ctx: RunContext): Promise<void>;
  /** 清理测试数据（预留） */
  teardown?(ctx: RunContext): Promise<void>;
  /** 批量生成参数化用例（预留） */
  generate?(): TaskDef[];
}
