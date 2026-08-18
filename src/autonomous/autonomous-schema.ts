// Autonomous Regression Schema：自治回归数据模型（Phase 22.6）
// 自治模式：manual / assisted / autonomous。--autonomous 默认 false。
// 自治预算：maxReplans / maxAutonomousCases / maxAutonomousCost / maxAutonomousDuration / maxLLMCalls。
// 控制器闭环：Select → Prioritize → Execute → Observe → Re-Plan → Stop。
// production 危险动作始终需 Permission / Approval（allowProductionDangerous 默认 false）。

import type { FailurePrediction } from '../failure-prediction/index.js';
import type { StoppingDecision } from '../stopping/index.js';

/** 自治模式 */
export type AutonomousMode = 'manual' | 'assisted' | 'autonomous';

/** 自治预算上限（任务书二十五 + Phase 23.4 扩展） */
export interface AutonomousBudget {
  /** 最大重新规划次数 */
  maxReplans: number;
  /** 最大自治执行用例数 */
  maxAutonomousCases: number;
  /** 最大自治成本（用例预估成本之和） */
  maxAutonomousCost: number;
  /** 最大自治时长 ms（用例预估时长之和） */
  maxAutonomousDuration: number;
  /** 最大 LLM 调用次数 */
  maxLLMCalls: number;
  /** 最大决策深度（决策链层数，超过 → AUTONOMOUS STOP，默认 20） */
  maxDecisionDepth: number;
  /** 最大连续重新规划次数（超过 → AUTONOMOUS STOP，默认 2） */
  maxConsecutiveReplans: number;
}

export const DEFAULT_AUTONOMOUS_BUDGET: AutonomousBudget = {
  maxReplans: 5,
  maxAutonomousCases: 100,
  maxAutonomousCost: 10,
  maxAutonomousDuration: 600000,
  maxLLMCalls: 20,
  maxDecisionDepth: 20,
  maxConsecutiveReplans: 2,
};

/** 自治用例（含预测输入与相关性标签） */
export interface AutonomousCase {
  caseId: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  /** 相关性标签：同标签失败 → 集群提升优先级 */
  changeTags?: string[];
  /** 预估执行成本（预算 maxAutonomousCost 用） */
  estimatedCost?: number;
  /** 预估执行时长 ms（预算 maxAutonomousDuration 用） */
  estimatedDurationMs?: number;
  /** 失败预测输入 */
  changeImpact?: number;
  modelRisk?: number;
  environmentRisk?: number;
  riskScore?: number;
  flakyRate?: number;
  defectDensity?: number;
  historicalSamples?: Array<{ passed: boolean; at: string }>;
  executedOnCurrentVersion?: boolean;
  /** 历史已知问题（复现时不重复创建缺陷） */
  knownIssue?: boolean;
}

/** 自治运行结果决策 */
export type AutonomousDecision =
  | 'COMPLETED' // 全部完成（或停止条件自然触发）
  | 'STOPPED' // 自适应停止（任务书 Scenario 3）
  | 'BLOCKED' // P0 失败 → 暂停低优先级 → Release BLOCK（Scenario 4）
  | 'BUDGET_EXHAUSTED' // 自治预算上限 → AUTONOMOUS STOP
  | 'PLANNED'; // manual 模式：仅分析规划，不执行

/** 重新规划事件 */
export interface ReplanEvent {
  at: string;
  failedCase: string;
  cause: string;
  boostedCases: string[];
  action: string;
}

/** 自治运行选项 */
export interface AutonomousRunOptions {
  cases: AutonomousCase[];
  /** 自治预算（缺省用默认值） */
  budget?: Partial<AutonomousBudget>;
  /** 自治模式（默认 autonomous） */
  mode?: AutonomousMode;
  /** 离线模拟执行结果：caseId → passed（真实运行由执行器提供） */
  outcomes?: Record<string, boolean>;
  /** 同标签集群失败触发阈值（默认 2） */
  clusterFailureTrigger?: number;
  /** 每次执行消耗的 LLM 调用数（预算 maxLLMCalls 用） */
  llmCallsPerStep?: number;
  /** 当前时间（确定性测试用） */
  now?: string | number;
  /** 允许生产危险动作（Release BLOCK → 部署等）。默认 false：始终需审批 */
  allowProductionDangerous?: boolean;
  /** assisted 模式的逐用例审批回调（返回 false 跳过该用例） */
  approve?: (caseId: string) => boolean;
}

/** 自治运行结果 */
export interface AutonomousRunResult {
  runId: string;
  mode: AutonomousMode;
  decision: AutonomousDecision;
  reason: string;
  /** 全部用例失败预测（执行顺序依据） */
  predictions: FailurePrediction[];
  /** 初始执行计划（Trace Initial Plan 用，执行前顺序） */
  initialOrder: string[];
  /** 已执行用例 */
  executed: Array<{ caseId: string; passed: boolean }>;
  /** 未执行用例 */
  remaining: string[];
  /** 重新规划事件 */
  replans: ReplanEvent[];
  /** 停止判定（如触发） */
  stopping: StoppingDecision | null;
  /** 复现的已知问题（不重复创建缺陷） */
  knownIssueReappeared: string[];
  /** 预算使用 */
  budgetUsed: { cases: number; cost: number; replans: number; durationMs: number; llmCalls: number };
  /** 超限预算项 */
  exceededLimit?: string;
  /** Release 是否被 BLOCK */
  releaseBlocked: boolean;
  /** 需要人工审批的动作（production 危险动作） */
  requiresApproval: string[];
  /** 决策轨迹（可解释） */
  evidence: string[];
}
