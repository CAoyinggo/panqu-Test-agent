// Continuous Learning Schema：持续学习数据模型（Phase 22.7）
// 执行结果自动改变知识权重：failureRate ↑/↓、confidence ↑/↓、riskWeight ↑/↓、priority ↑/↓。
// Knowledge Weight Decay：time decay（30 天 0.9 / 60 天 0.7 / 90 天 0.4）。
// 闭环：Execution → Knowledge Update → Risk Update → Selection Update → Next Execution。

/** 学习配置 */
export interface LearningConfig {
  /** 最近失败率窗口（默认 20） */
  recentWindow: number;
  /** 置信度参考样本量（默认 30） */
  referenceRuns: number;
  /** riskWeight 优先级阈值 */
  priorityThresholds: { p0: number; p1: number; p2: number };
  /** 30 天权重（0.9） */
  decay30: number;
  /** 60 天权重（0.7） */
  decay60: number;
  /** 90 天权重（0.4） */
  decay90: number;
  /** 最小权重（防衰减为 0） */
  minDecay: number;
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  recentWindow: 20,
  referenceRuns: 30,
  priorityThresholds: { p0: 0.6, p1: 0.35, p2: 0.15 },
  decay30: 0.9,
  decay60: 0.7,
  decay90: 0.4,
  minDecay: 0.05,
};

/** 学习状态（单个 key：caseId 或 feature:tag） */
export interface LearningState {
  key: string;
  /** 历史运行次数 */
  runs: number;
  /** 历史失败次数 */
  failures: number;
  /** 总体失败率 = failures / runs */
  failureRate: number;
  /** 最近窗口失败率 */
  recentRate: number;
  /** 风险置信度 0~1（最近行为驱动：连续失败 → ↑，连续 PASS → ↓） */
  confidence: number;
  /** 风险权重 = failureRate × confidence × decay（0~1） */
  riskWeight: number;
  /** 当前衰减因子（新证据验证后重置为 1） */
  decay: number;
  /** 建议动态优先级 */
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  /** 连续通过次数 */
  consecutivePasses: number;
  /** 连续失败次数 */
  consecutiveFailures: number;
  lastResult: 'PASS' | 'FAIL' | undefined;
  /** 最近证据时间 */
  lastEvidenceAt: string;
  lastUpdatedAt: string;
  /** 可解释证据 */
  evidence: string[];
  /** 最近窗口结果（true=通过） */
  recent: boolean[];
}

/** 单次执行证据 */
export interface ExecutionEvidence {
  key: string;
  passed: boolean;
  at?: string;
}

/** 学习更新（before → after） */
export interface LearningUpdate {
  key: string;
  kind: 'evidence' | 'decay';
  before: LearningState;
  after: LearningState;
  /** 变化方向（可解释） */
  deltas: string[];
}

/** Selection Update：把学习结果应用到用例 */
export interface LearningAppliedCase {
  caseId: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  riskScore: number;
}
