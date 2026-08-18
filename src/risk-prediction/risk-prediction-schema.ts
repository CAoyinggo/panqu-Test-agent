// Risk Prediction Schema：风险预测引擎数据模型（Phase 22.3）
// 基于历史频率 + 时间衰减 + 趋势 + 变更信号 + 失败聚集的确定性统计预测。

/** 单次执行样本 */
export interface ExecutionSample {
  caseId: string;
  passed: boolean;
  /** ISO 时间戳（时间衰减用） */
  at: string;
}

/** 变更信号 */
export interface ChangeSignal {
  type: string;
  /** 关联目标（如 model 名 / 环境名 / 业务名） */
  target?: string;
  /** 全局型（code/config/environment/model 变更影响全部） */
  global?: boolean;
  at?: string;
}

/** 预测风险等级 */
export type PredictedRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** 用例失败概率预测 */
export interface PredictedCaseRisk {
  caseId: string;
  failureProbability: number;
  riskLevel: PredictedRiskLevel;
  confidence: number;
  evidence: string[];
  /** 各因子分解（可解释） */
  factors: {
    historical: number;
    recencyWeighted: number;
    trend: number;
    change: number;
    clustering: number;
  };
}

/** 维度风险（Feature / Model / Environment） */
export interface PredictedDimensionRisk {
  key: string;
  riskScore: number;
  riskLevel: PredictedRiskLevel;
  confidence: number;
  caseCount: number;
  evidence: string[];
}

/** 预测配置 */
export interface PredictionConfig {
  /** 最近窗口大小（默认 5） */
  recentWindow?: number;
  /** 时间衰减系数/天（默认 0.95，30 天 ≈ 0.9） */
  decayPerDay?: number;
  /** 最大特征样本参考量（默认 30） */
  referenceSamples?: number;
}
