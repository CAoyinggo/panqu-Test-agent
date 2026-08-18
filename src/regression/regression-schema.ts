// Regression Schema：持续回归数据模型（Phase 21.3 Continuous Regression）
// 统一 Test Run ID：runId 贯穿 Case / Execution / RCA / Defect / Knowledge，
// 任何一个失败都可以通过 runId 找到完整链路。

/** 变更类型 */
export type ChangeType =
  | 'code'            // 代码变化
  | 'model'           // 模型发布 / 切换
  | 'api'             // 接口变化
  | 'config'          // 配置变化
  | 'pricing'         // 价格变化
  | 'environment'     // 环境变化
  | 'requirement';    // 需求变化

export const CHANGE_TYPES: readonly ChangeType[] = [
  'code', 'model', 'api', 'config', 'pricing', 'environment', 'requirement',
];

/** 变更事件（影响分析输入） */
export interface ChangeEvent {
  type: ChangeType;
  /** 变更目标（如 wan3/text-to-video、Model A、submit_url） */
  target: string;
  /** 变更前（如 v1） */
  from?: string;
  /** 变更后（如 v2） */
  to?: string;
  /** 归属业务（缺省由影响分析推断） */
  businessId?: string;
  description?: string;
  /** 变更时间（ISO，缺省当前） */
  at?: string;
}

/** 回归触发方式 */
export type RegressionTriggerType =
  | 'pr'                  // PR 提交
  | 'release'             // 代码发布
  | 'model-release'       // 模型发布
  | 'config-change'       // 配置变化
  | 'pricing-change'      // 价格变化
  | 'environment-change'  // 环境变化
  | 'manual'              // 人工触发
  | 'schedule';           // 定时任务

export const REGRESSION_TRIGGER_TYPES: readonly RegressionTriggerType[] = [
  'pr', 'release', 'model-release', 'config-change', 'pricing-change',
  'environment-change', 'manual', 'schedule',
];

/** 影响分析结果 */
export interface ImpactAnalysis {
  change: ChangeEvent;
  /** 受影响业务 id */
  affectedBusinesses: string[];
  /** 受影响能力标签 */
  affectedCapabilities: string[];
  /** 受影响测试资产 id（test-case） */
  affectedCases: string[];
  /** 受影响风险描述 */
  affectedRisks: string[];
  /** 分析说明（每条命中原因） */
  reasons: string[];
}

/** 回归计划（测试选择结果：不执行全量 Case） */
export interface RegressionPlan {
  runId: string;
  trigger: RegressionTriggerType;
  change: ChangeEvent;
  impact: ImpactAnalysis;
  /** 按优先级分层的选中用例（资产 id） */
  selected: { p0: string[]; p1: string[]; p2: string[] };
  /** 跳过的用例（资产 id + 原因） */
  skipped: Array<{ id: string; reason: string }>;
  /** 每条选中的理由 */
  reasons: Record<string, string>;
  /** 计划生成时间 */
  createdAt: string;
}

/** 回归运行结果状态 */
export type RegressionRunStatus = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED';

/** 回归运行记录（runId 贯穿） */
export interface RegressionRun {
  runId: string;
  taskId?: string;
  feature: string;
  trigger: RegressionTriggerType;
  change?: ChangeEvent;
  /** 执行的用例资产 id */
  caseIds: string[];
  status: RegressionRunStatus;
  /** 通过率 0~1 */
  passRate: number;
  /** 失败用例 → RCA / Defect 资产 id（runId 追踪链） */
  failures: Array<{ caseId: string; rcaId?: string; defectId?: string }>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

let runSeq = 0;

/** 生成统一 Test Run ID：run-<日期>-<时间戳36>-<序号> */
export function generateRunId(): string {
  runSeq += 1;
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `run-${date}-${Date.now().toString(36)}-${String(runSeq).padStart(3, '0')}`;
}

/** 校验变更事件：非法抛错 */
export function normalizeChangeEvent(input: unknown): ChangeEvent {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('ChangeEvent 校验失败：必须为对象');
  }
  const raw = input as Record<string, unknown>;
  if (!raw.type || !CHANGE_TYPES.includes(raw.type as ChangeType)) {
    throw new Error(`ChangeEvent 校验失败：type 无效（需为 ${CHANGE_TYPES.join(' / ')}）`);
  }
  if (!raw.target || typeof raw.target !== 'string') {
    throw new Error('ChangeEvent 校验失败：缺少 target');
  }
  const event: ChangeEvent = {
    type: raw.type as ChangeType,
    target: String(raw.target).trim(),
    at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
  };
  if (typeof raw.from === 'string') event.from = raw.from;
  if (typeof raw.to === 'string') event.to = raw.to;
  if (typeof raw.businessId === 'string') event.businessId = raw.businessId;
  if (typeof raw.description === 'string') event.description = raw.description;
  return event;
}
