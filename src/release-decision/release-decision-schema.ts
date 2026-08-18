// Autonomous Release Decision Schema：AI 发布决策数据模型（Phase 22.8）
// 把 Release Gate 从二元（PASS/BLOCK）升级为三态（PASS/BLOCK/REVIEW）。
// 全部由确定性信号推导，禁止 LLM“我认为可以发布”。

/** 优先级执行统计（复用 Release Gate 形态） */
export interface PriorityRunStats {
  total: number;
  passed: number;
}

/** 发布决策输入 */
export interface ReleaseDecisionInput {
  /** P0 执行统计（失败 → 权威 BLOCK） */
  p0: PriorityRunStats;
  /** P1 执行统计 */
  p1: PriorityRunStats;
  /** 覆盖率 0~1 */
  coverage: number;
  /** 未关闭的严重缺陷数（>0 → 权威 BLOCK） */
  criticalDefects: number;
  /** 整体风险级别（HIGH → REVIEW） */
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  /** 平均失败预测概率 0~1 */
  failurePrediction?: number;
  /** 历史失败率 0~1 */
  historicalFailureRate?: number;
  /** 模型是否发生变更 */
  modelChange?: boolean;
  /** 测试环境异常（→ 权威 BLOCK） */
  environmentAbnormal?: boolean;
  /** 不稳定用例数（> 容忍值 → REVIEW） */
  flakyCount?: number;
  /** 已知问题数（>0 → REVIEW） */
  knownIssues?: number;
  /** 阈值覆盖 */
  thresholds?: Partial<ReleaseDecisionThresholds>;
}

/** 发布决策阈值 */
export interface ReleaseDecisionThresholds {
  /** P1 最低通过率（默认 0.98） */
  p1PassRate: number;
  /** 最低覆盖率（默认 0.9） */
  minCoverage: number;
  /** 不稳定用例容忍值（默认 1，>1 触发 REVIEW） */
  flakyTolerance: number;
  /** 历史失败率阈值（默认 0.3） */
  historyThreshold: number;
  /** 失败预测阈值（默认 0.5） */
  predictionThreshold: number;
}

export const DEFAULT_RELEASE_DECISION_THRESHOLDS: ReleaseDecisionThresholds = {
  p1PassRate: 0.98,
  minCoverage: 0.9,
  flakyTolerance: 1,
  historyThreshold: 0.3,
  predictionThreshold: 0.5,
};

/** 发布决策（三态） */
export type ReleaseDecision = 'PASS' | 'BLOCK' | 'REVIEW';

/** 结构化证据（禁止无证据决策） */
export interface ReleaseEvidence {
  type: string;
  value: string;
}

/** 发布决策结果 */
export interface AutonomousReleaseDecision {
  decision: ReleaseDecision;
  /** 决策置信度 0~1（确定性公式） */
  confidence: number;
  /** 决策理由（未满足的信号说明） */
  reasons: string[];
  /** 阻断因素（仅 BLOCK 时非空） */
  blockingFactors: string[];
  /** 建议动作 */
  recommendedActions: string[];
  /** 全部信号证据（type/value，含通过项） */
  evidence: ReleaseEvidence[];
}
