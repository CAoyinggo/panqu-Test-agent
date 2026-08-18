// Autonomous Budget：自治预算控制（Phase 22.6）
// 上限：maxReplans / maxAutonomousCases / maxAutonomousCost / maxAutonomousDuration / maxLLMCalls。
// 达到上限 → AUTONOMOUS STOP，并输出原因。

import type { AutonomousBudget } from './autonomous-schema.js';

/** 预算使用（Phase 23.4 新增 consecutiveReplans / decisionDepth） */
export interface AutonomousBudgetUsage {
  cases: number;
  cost: number;
  replans: number;
  durationMs: number;
  llmCalls: number;
  /** 连续重新规划次数（PASS 时重置） */
  consecutiveReplans?: number;
  /** 决策深度（决策链层数） */
  decisionDepth?: number;
}

/** 预算检查结果 */
export interface AutonomousBudgetCheck {
  ok: boolean;
  exceeded?: keyof AutonomousBudget;
}

/** 检查自治预算：任一达到上限 → 停止 */
export function checkAutonomousBudget(used: AutonomousBudgetUsage, limits: AutonomousBudget): AutonomousBudgetCheck {
  if (used.cases >= limits.maxAutonomousCases) return { ok: false, exceeded: 'maxAutonomousCases' };
  if (used.cost >= limits.maxAutonomousCost) return { ok: false, exceeded: 'maxAutonomousCost' };
  if (used.durationMs >= limits.maxAutonomousDuration) return { ok: false, exceeded: 'maxAutonomousDuration' };
  if (used.replans >= limits.maxReplans) return { ok: false, exceeded: 'maxReplans' };
  if (used.llmCalls >= limits.maxLLMCalls) return { ok: false, exceeded: 'maxLLMCalls' };
  // 超过（>）才触发：允许等于阈值的连续次数/深度
  if ((used.decisionDepth ?? 0) > limits.maxDecisionDepth) return { ok: false, exceeded: 'maxDecisionDepth' };
  if ((used.consecutiveReplans ?? 0) > limits.maxConsecutiveReplans) return { ok: false, exceeded: 'maxConsecutiveReplans' };
  return { ok: true };
}

/** 中文预算项名（输出可解释） */
export const BUDGET_LIMIT_NAMES: Record<keyof AutonomousBudget, string> = {
  maxReplans: '最大重新规划次数',
  maxAutonomousCases: '最大自治执行用例数',
  maxAutonomousCost: '最大自治成本',
  maxAutonomousDuration: '最大自治时长',
  maxLLMCalls: '最大 LLM 调用次数',
  maxDecisionDepth: '最大决策深度',
  maxConsecutiveReplans: '最大连续重新规划次数',
};
