// Exploration Testing Schema：探索性测试数据模型（Phase 22 通用）
// 根据需求 / 已有 Case / 覆盖缺口 / 历史失败 / 参数空间自动生成新测试输入，
// 但必须先经过 Risk / Budget / Permission 检查，不得无限生成（maxExplorationCases / maxExplorationCost）。

/** 探索配置 */
export interface ExplorationConfig {
  /** 最大生成用例数（默认 5） */
  maxExplorationCases: number;
  /** 最大探索成本（默认 2） */
  maxExplorationCost: number;
  /** 最大探索时长 ms（默认 120000，Phase 23.3 预算门禁） */
  maxExplorationDuration: number;
  /** 高风险阈值（riskScore ≥ 该值需人工授权，默认 0.5） */
  riskGateThreshold: number;
  /** 高风险用例是否强制人工授权（默认 true） */
  requirePermissionForHighRisk: boolean;
  /** 参数空间（能力 → 可选取值），用于组合生成 */
  parameterSpace?: Record<string, string[]>;
}

export const DEFAULT_EXPLORATION_CONFIG: ExplorationConfig = {
  maxExplorationCases: 5,
  maxExplorationCost: 2,
  maxExplorationDuration: 120000,
  riskGateThreshold: 0.5,
  requirePermissionForHighRisk: true,
  parameterSpace: {},
};

/** 探索生命周期状态（Phase 23.3：GENERATED → SCREENED → APPROVED → EXECUTED → VALIDATED / REJECTED） */
export type ExplorationLifecycleStatus =
  | 'GENERATED' // 已生成候选
  | 'SCREENED' // 已通过三进门禁（Risk / Budget / Permission）
  | 'APPROVED' // 已获人工授权（risky / 生产危险动作）
  | 'EXECUTED' // 已执行
  | 'VALIDATED' // 已验证（发现缺陷 / 确认无缺陷）
  | 'REJECTED'; // 被拒绝（任一门禁未通过）

/** 候选来源 */
export type ExplorationSource = 'coverage-gap' | 'history' | 'parameter' | 'requirement';

/** 探索候选 */
export interface ExplorationCandidate {
  /** 候选 id（确定性生成） */
  id: string;
  /** 能力/参数标签 */
  tags: string[];
  /** 估算成本 */
  estimatedCost: number;
  /** 生成理由 */
  reason: string;
  /** 来源 */
  source: ExplorationSource;
  /** 风险分 0~1 */
  riskScore: number;
  /** 是否已通过授权检查 */
  approved: boolean;
  /** 未通过原因（approved=false 时） */
  blockedReason?: string;
  /** 预估执行时长 ms（Phase 23.3 duration 预算用） */
  estimatedDurationMs?: number;
  /** 生命周期状态（Phase 23.3，缺省 GENERATED） */
  status?: 'GENERATED' | 'SCREENED' | 'APPROVED' | 'EXECUTED' | 'VALIDATED' | 'REJECTED';
}

/** 探索输入 */
export interface ExplorationInput {
  /** 已存在的用例 id（避免重复生成） */
  existingCaseIds: string[];
  /** 覆盖缺口（feature 描述） */
  coverageGaps?: string[];
  /** 历史失败（case 标识，用于风险探索） */
  historicalFailures?: string[];
  /** 参数空间覆盖 */
  parameterSpace?: Record<string, string[]>;
  /** 是否授权高风险探索（生产危险动作需授权） */
  approveHighRisk?: boolean;
  /** 配置覆盖 */
  config?: Partial<ExplorationConfig>;
}

/** 探索结果 */
export interface ExplorationResult {
  /** 全部候选 */
  candidates: ExplorationCandidate[];
  /** 通过检查、可执行的候选 */
  selected: ExplorationCandidate[];
  /** 被拒绝的候选 */
  rejected: ExplorationCandidate[];
  /** 预算使用：已生成数 / 成本 / 时长 */
  usedCount: number;
  usedCost: number;
  /** 预估执行时长合计 ms（Phase 23.3） */
  usedDuration: number;
  /** 汇总说明（为什么生成这些 / 为什么拒绝那些） */
  reason: string;
}
