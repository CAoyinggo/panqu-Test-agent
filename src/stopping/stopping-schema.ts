// Adaptive Stopping Schema：自适应测试停止数据模型（Phase 22.4）
// 停止条件：P0 全覆盖 / Coverage≥90% / 信息增益低 / Release BLOCK / 预算上限 / 环境异常。
// 必须输出停止理由，不能静默停止。

/** 停止判定输入（当前实时状态） */
export interface StoppingInput {
  /** 当前覆盖率 0~1 */
  coverage: number;
  /** 当前风险覆盖率 0~1 */
  riskCoverage: number;
  /** 当前 P0 覆盖率 0~1 */
  p0Coverage: number;
  /** 剩余未执行用例 */
  remainingCases?: string[];
  /** 剩余用例平均信息增益 0~1（低=停止） */
  infoGain?: number;
  /** 是否已有 P0 失败（→ Release BLOCK 判定） */
  p0Failed?: boolean;
  /** 是否已有 Critical 缺陷（→ BLOCK） */
  criticalDefect?: boolean;
  /** 已执行用例数 */
  executedCases?: number;
  /** 预算使用比例 0~1 */
  budgetUsedRatio?: number;
  /** 测试环境异常 */
  environmentAbnormal?: boolean;
  /** 判定规则覆盖 */
  rules?: Partial<StoppingRules>;
}

/** 停止规则（默认值） */
export interface StoppingRules {
  /** 覆盖率达标线（0.9） */
  minCoverage: number;
  /** 风险覆盖率达标线（1.0） */
  minRiskCoverage: number;
  /** P0 覆盖率达标线（1.0） */
  minP0Coverage: number;
  /** 信息增益低于该值视为低价值（0.2） */
  lowInfoGainThreshold: number;
  /** 预算使用比例预警线（0.9） */
  budgetWarningRatio: number;
  /** 最少已执行用例数（防过早停止，默认 3） */
  minExecutedCases: number;
}

export const DEFAULT_STOPPING_RULES: StoppingRules = {
  minCoverage: 0.9,
  minRiskCoverage: 1,
  minP0Coverage: 1,
  lowInfoGainThreshold: 0.2,
  budgetWarningRatio: 0.9,
  minExecutedCases: 3,
};

/** 命中的停止条件 */
export interface StoppingCondition {
  name: 'p0-covered' | 'risk-covered' | 'coverage-met' | 'low-info-gain' | 'release-block' | 'budget-limit' | 'environment-abnormal';
  satisfied: boolean;
  detail: string;
}

/** 停止判定结果 */
export interface StoppingDecision {
  stop: boolean;
  reason: string;
  confidence: number;
  remainingCases: string[];
  riskCoverage: number;
  coverage: number;
  p0Coverage: number;
  /** 全部条件评估（含未命中，可解释） */
  conditions: StoppingCondition[];
  /** 阻止停止的因素 */
  blocks: string[];
}
