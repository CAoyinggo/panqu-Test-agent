// Telemetry 类型（Phase 25.4）：统一遥测事件 + 成本账本 + RCA 真值 + Flaky / Healing 记录
// 原则：所有数值来自真实运行数据（LLM usage / 执行结果 / 人工验证 / 自愈决策），
//       无数据时 tracked=false（禁止用 0 表示“没有数据”）。

import type { FailureCategory } from '../../agents/analysis/root-cause-schema.js';

/** 遥测事件类型 */
export type TelemetryEventType =
  | 'llm'        // LLM 调用
  | 'execution'  // 执行（Run / Job）
  | 'rca'        // RCA 预测
  | 'rca.verify' // RCA 人工验证（Ground Truth）
  | 'flaky'      // Flaky 运行记录
  | 'healing'    // 自愈决策
  | 'release'    // 发布决策
  | 'cost';      // 成本记账

/** 统一遥测事件（任务书 25.4 接口） */
export interface TelemetryEvent {
  /** Repository Entity 约束（与 eventId 同值） */
  id: string;
  /** 任务书指定的事件 ID（= id） */
  eventId: string;
  runId: string;
  projectId?: string;
  feature?: string;
  type: TelemetryEventType;
  value?: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/** LLM 成本账本条目（真实 token 用量 × 模型单价） */
export interface CostLedgerEntry {
  id: string;
  runId: string;
  projectId?: string;
  feature?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  requestCount: number;
  retryCount: number;
  /** 计算成本（元） */
  cost: number;
  timestamp: string;
}

/** RCA 真值验证（Ground Truth） */
export interface RcaVerification {
  id: string;
  rcaId: string;
  runId: string;
  predictedCategory: FailureCategory;
  actualCategory?: FailureCategory;
  correct?: boolean;
  verifiedBy?: string;
  verifiedAt: string;
}

/** Flaky 运行记录（单次 case 执行） */
export interface FlakyRecord {
  id: string;
  caseId: string;
  runId: string;
  pass: boolean;
  retry: boolean;
  environment?: string;
  durationMs?: number;
  timestamp: string;
}

/** Healing 自愈决策记录 */
export interface HealingRecord {
  id: string;
  healingId: string;
  caseId: string;
  runId: string;
  suggested: boolean;
  approved: boolean;
  applied: boolean;
  recovered: boolean;
  rolledBack: boolean;
  timestamp: string;
}

/** 发布决策记录 */
export interface ReleaseRecord {
  id: string;
  runId: string;
  decision: 'PASS' | 'REVIEW' | 'BLOCK';
  result: 'success' | 'blocked' | 'review';
  reason?: string;
  timestamp: string;
}

/** 指标时间窗口（任务书 25.5） */
export type TelemetryPeriod = '1h' | '6h' | '24h' | '7d' | '30d' | 'release' | 'version';

/** 指标样本：真实值 + tracked 状态（禁止 0 代表无数据） */
export interface MetricSample {
  value: number | null;
  tracked: boolean;
  sampleCount: number;
  unit?: string;
}

/** 成本汇总（Cost / Run / Feature / Model / Project / Regression） */
export interface CostBreakdown {
  total: MetricSample;
  perRun: MetricSample;
  perFeature: MetricSample;
  perModel: Array<{ model: string; cost: number; tokens: number; requests: number }>;
  perProject: MetricSample;
}

/** 周期起点（毫秒）；release/version 返回 0（表示不过滤时间） */
export function periodStartMs(period: TelemetryPeriod, nowMs: number): number {
  if (period === 'release' || period === 'version') return 0;
  const map: Record<Exclude<TelemetryPeriod, 'release' | 'version'>, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  return nowMs - map[period];
}
