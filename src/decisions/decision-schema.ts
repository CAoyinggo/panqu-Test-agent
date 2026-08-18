// Agent Decision Trace Schema：自治决策轨迹数据模型（Phase 22 通用）
// 在 Tool Trace / LLM Trace / Execution Trace 之外增加 Decision Trace，
// 记录每个自治决策的 decision / score / evidence / reason / confidence / timestamp / inputs。

/** 决策类型（任务书二十二 / Phase 23.1 扩展 replanning） */
export type DecisionKind = 'requirement' | 'risk' | 'selection' | 'priority' | 'stopping' | 'replanning' | 'release';

export const DECISION_KINDS: readonly DecisionKind[] = [
  'requirement', 'risk', 'selection', 'priority', 'stopping', 'replanning', 'release',
];

/** 单条决策记录 */
export interface DecisionRecord {
  /** 决策 id（taskId + 序号） */
  id: string;
  /** 决策类型 */
  kind: DecisionKind;
  /** 决策结果（如 PASS / BLOCK / REVIEW / P0 / 停止 / 继续） */
  decision: string;
  /** 决策得分（如 testValue / riskScore / confidence 等） */
  score?: number;
  /** 决策依据（证据，禁止无依据决策） */
  evidence: string[];
  /** 决策理由（自然语言解释） */
  reason: string;
  /** 决策置信度 0~1 */
  confidence?: number;
  /** 决策时间（ISO） */
  timestamp: string;
  /** 决策输入（可复现） */
  inputs: Record<string, unknown>;
  /** 关联用例（可空，用于 Trace 关联） */
  caseId?: string;
  /** 决策输出（可复现） */
  outputs?: Record<string, unknown>;
}

/** Decision Trace（整轮自治任务的决策汇总） */
export interface DecisionTrace {
  taskId: string;
  createdAt: string;
  records: DecisionRecord[];
  /** 各类型决策数量统计 */
  summary: string;
  byKind: Record<DecisionKind, number>;
}
