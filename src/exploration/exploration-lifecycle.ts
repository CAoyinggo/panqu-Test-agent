// Exploration Lifecycle Controller：探索接入 Regression 的控制层（Phase 23.3）
// 生命周期：GENERATED → SCREENED → APPROVED → EXECUTED → VALIDATED / REJECTED。
// 三进门禁：Risk（P0 危险输入拒绝） / Budget（maxExplorationCases/Cost/Duration） / Permission（read/safe/risky/dangerous）。
// 安全策略：production → dangerous = DENY、risky = Approval；自治模式不能改变安全策略。
// 接入：Regression → Coverage Gap → Exploration → 门禁 → 通过候选加入 Regression Plan。

import {
  guardProductionAction,
  isProductionTier,
  PRODUCTION_FORBIDDEN_ACTIONS,
} from '../config/environment-policy.js';
import { generateExplorations } from './exploration-engine.js';
import {
  DEFAULT_EXPLORATION_CONFIG,
  type ExplorationCandidate,
  type ExplorationConfig,
  type ExplorationLifecycleStatus,
  type ExplorationSource,
} from './exploration-schema.js';

/** 权限等级（与 ToolPermission 语义一致：read / safe / risky / dangerous） */
export type PermissionLevel = 'read' | 'safe' | 'risky' | 'dangerous';

/** 三进门禁结果 */
export interface ExplorationGateResult {
  riskGate: 'pass' | 'block';
  budgetGate: 'pass' | 'block';
  permissionGate: 'pass' | 'block';
  /** 是否可执行（三进门禁全部通过） */
  canExecute: boolean;
  /** 未通过原因 */
  reasons: string[];
}

/** 探索生命周期状态（单个候选） */
export interface ExplorationLifecycleState {
  candidateId: string;
  status: ExplorationLifecycleStatus;
  gates: ExplorationGateResult;
  permission: PermissionLevel;
  /** 状态更新时间 */
  timestamp: string;
  /** 被拒原因（REJECTED 时） */
  blockedReason?: string;
}

/** 探索计划输入（接入 Regression） */
export interface ExplorationPlanInput {
  /** 覆盖缺口（Regression Coverage Gap 触发探索） */
  coverageGaps?: string[];
  /** 历史失败区域 */
  historicalFailures?: string[];
  /** 参数空间 */
  parameterSpace?: Record<string, string[]>;
  /** 已存在用例 id（避免重复） */
  existingCaseIds: string[];
  /** 环境（production → dangerous=DENY、risky=Approval） */
  environment?: string;
  /** 高风险探索授权（Approval 回调，risky 类） */
  approveHighRisk?: boolean;
  /** 生产危险动作授权（dangerous 类，默认 false = DENY） */
  approveProduction?: boolean;
  /** 配置覆盖 */
  config?: Partial<ExplorationConfig>;
}

/** 探索计划输出（可加入 Regression Plan 的候选） */
export interface ExplorationPlan {
  /** 全部生成候选（GENERATED） */
  generated: ExplorationCandidate[];
  /** 通过三进门禁、可加入 Regression Plan 的候选（SCREENED/APPROVED） */
  screened: ExplorationCandidate[];
  /** 被拒绝候选（REJECTED，含门禁原因） */
  rejected: ExplorationCandidate[];
  /** 生命周期状态 */
  lifecycle: ExplorationLifecycleState[];
  /** 预算使用 */
  budget: {
    usedCount: number;
    usedCost: number;
    usedDuration: number;
    maxCount: number;
    maxCost: number;
    maxDuration: number;
  };
  /** 是否可以把探索候选加入 Regression Plan */
  canAddToRegression: boolean;
  /** 决策证据（为什么生成 / 为什么拒绝） */
  evidence: string[];
}

/** 危险动作关键词（tag 命中任一 → dangerous） */
const DANGEROUS_KEYWORDS = [
  ...PRODUCTION_FORBIDDEN_ACTIONS,
  'billing',
  'payment',
  'pay',
  'delete',
  'db-write',
  'db-modify',
  'production',
  'run-production',
  'stress',
];

/**
 * 权限分类（确定性）：
 * - 命中危险动作关键词 → dangerous（生产 DENY / 非生产需审批）
 * - 历史失败探索或 riskScore ≥ 0.5 → risky（需 Approval）
 * - 其余 → safe（覆盖缺口 / 参数组合）
 */
export function classifyPermission(candidate: ExplorationCandidate): PermissionLevel {
  const tags = candidate.tags.map((t) => t.toLowerCase());
  if (tags.some((t) => DANGEROUS_KEYWORDS.some((k) => t.includes(k)))) return 'dangerous';
  if (candidate.source === 'history' || candidate.riskScore >= 0.5) return 'risky';
  return 'safe';
}

/**
 * 三进门禁（确定性）：
 * Risk Gate：高风险探索未授权 → block（P0 dangerous input 禁止生成）
 * Budget Gate：count / cost / duration 任一超限 → block
 * Permission Gate：production → dangerous=DENY、risky=Approval；非生产 → dangerous 也需 approveProduction
 */
export function screenCandidate(
  candidate: ExplorationCandidate,
  context: {
    environment?: string;
    approveHighRisk?: boolean;
    approveProduction?: boolean;
    usedCount: number;
    usedCost: number;
    usedDuration: number;
    config: ExplorationConfig;
  },
): ExplorationGateResult {
  const config = context.config;
  const permission = classifyPermission(candidate);
  const reasons: string[] = [];
  let riskGate: ExplorationGateResult['riskGate'] = 'pass';
  let budgetGate: ExplorationGateResult['budgetGate'] = 'pass';
  let permissionGate: ExplorationGateResult['permissionGate'] = 'pass';

  // Risk Gate
  if (config.requirePermissionForHighRisk && candidate.riskScore >= config.riskGateThreshold && !context.approveHighRisk) {
    riskGate = 'block';
    reasons.push(`Risk 门禁：高风险探索（risk=${candidate.riskScore.toFixed(2)}）需人工授权`);
  }

  // Budget Gate（count / cost / duration）
  const nextCount = context.usedCount + 1;
  const nextCost = context.usedCost + candidate.estimatedCost;
  const nextDuration = context.usedDuration + (candidate.estimatedDurationMs ?? 0);
  if (nextCount > config.maxExplorationCases) {
    budgetGate = 'block';
    reasons.push(`Budget 门禁：maxExplorationCases=${config.maxExplorationCases} 达到上限`);
  }
  if (nextCost > config.maxExplorationCost) {
    budgetGate = 'block';
    reasons.push(`Budget 门禁：maxExplorationCost=${config.maxExplorationCost} 达到上限`);
  }
  if (nextDuration > config.maxExplorationDuration) {
    budgetGate = 'block';
    reasons.push(`Budget 门禁：maxExplorationDuration=${config.maxExplorationDuration}ms 达到上限`);
  }

  // Permission Gate
  const production = isProductionTier(context.environment);
  if (permission === 'dangerous') {
    // 危险动作：production 无条件 DENY；非生产需 approveProduction
    const guard = guardProductionAction(context.environment, candidate.tags[0] ?? 'exploration-action');
    if (production) {
      permissionGate = 'block';
      reasons.push(`Permission 门禁：production 环境危险动作 DENY（${guard.reason}）`);
    } else if (!context.approveProduction) {
      permissionGate = 'block';
      reasons.push('Permission 门禁：危险动作需人工审批（approveProduction）');
    }
  } else if (permission === 'risky' && !context.approveHighRisk) {
    permissionGate = 'block';
    reasons.push('Permission 门禁：risky 动作需人工审批（Approval）');
  }

  return {
    riskGate,
    budgetGate,
    permissionGate,
    canExecute: riskGate === 'pass' && budgetGate === 'pass' && permissionGate === 'pass',
    reasons,
  };
}

/** 状态转移校验（确定性）：非法转移抛错 */
export function advanceExploration(
  state: ExplorationLifecycleState,
  to: Exclude<ExplorationLifecycleStatus, 'GENERATED'>,
): ExplorationLifecycleState {
  const valid: Record<string, string[]> = {
    GENERATED: ['SCREENED', 'REJECTED'],
    SCREENED: ['APPROVED', 'EXECUTED', 'REJECTED'],
    APPROVED: ['EXECUTED', 'REJECTED'],
    EXECUTED: ['VALIDATED', 'REJECTED'],
    VALIDATED: [],
    REJECTED: [],
  };
  if (!valid[state.status].includes(to)) {
    throw new Error(`非法探索生命周期转移：${state.status} → ${to}`);
  }
  return { ...state, status: to, timestamp: new Date().toISOString() };
}

/**
 * 运行探索计划（接入 Regression）：
 * Regression Coverage Gap → generateExplorations → 三进门禁 → 通过候选加入 Regression Plan。
 */
export function runExplorationPlan(input: ExplorationPlanInput): ExplorationPlan {
  const config: ExplorationConfig = { ...DEFAULT_EXPLORATION_CONFIG, ...(input.config ?? {}) };
  const approveHighRisk = input.approveHighRisk ?? false;
  const approveProduction = input.approveProduction ?? false;
  const evidence: string[] = [];

  // 1) 生成（Budget/Risk/Permission 基础门禁已在 generateExplorations 内执行）
  const generated = generateExplorations({
    existingCaseIds: input.existingCaseIds,
    coverageGaps: input.coverageGaps,
    historicalFailures: input.historicalFailures,
    parameterSpace: input.parameterSpace,
    approveHighRisk,
    config,
  });

  // 2) 基础门禁拒绝的候选（generateExplorations 内 Budget/Risk/Permission）先并入生命周期
  const lifecycle: ExplorationLifecycleState[] = [];
  const rejected: ExplorationCandidate[] = [];
  for (const r of generated.rejected) {
    lifecycle.push({
      candidateId: r.id,
      status: 'REJECTED',
      gates: {
        riskGate: 'block',
        budgetGate: 'block',
        permissionGate: 'block',
        canExecute: false,
        reasons: [r.blockedReason ?? '基础门禁拒绝'],
      },
      permission: classifyPermission(r),
      timestamp: new Date().toISOString(),
      blockedReason: r.blockedReason,
    });
    rejected.push(r);
  }

  // 3) 逐个 screen（完整三进门禁 + 生命周期）
  const screened: ExplorationCandidate[] = [];
  let usedCount = 0;
  let usedCost = 0;
  let usedDuration = 0;

  for (const cand of generated.selected) {
    const gates = screenCandidate(cand, {
      environment: input.environment,
      approveHighRisk,
      approveProduction,
      usedCount,
      usedCost,
      usedDuration,
      config,
    });
    const permission = classifyPermission(cand);
    const state: ExplorationLifecycleState = {
      candidateId: cand.id,
      status: gates.canExecute ? 'SCREENED' : 'REJECTED',
      gates,
      permission,
      timestamp: new Date().toISOString(),
      blockedReason: gates.canExecute ? undefined : gates.reasons.join('；'),
    };
    lifecycle.push(state);
    if (gates.canExecute) {
      screened.push({ ...cand, status: 'SCREENED', approved: true });
      usedCount += 1;
      usedCost += cand.estimatedCost;
      usedDuration += cand.estimatedDurationMs ?? 0;
    } else {
      rejected.push({ ...cand, approved: false, status: 'REJECTED', blockedReason: state.blockedReason });
    }
  }

  // 3) 证据
  if (input.coverageGaps?.length) evidence.push(`覆盖缺口 ${input.coverageGaps.length} 个触发探索`);
  if (screened.length) evidence.push(`通过三进门禁 ${screened.length} 个探索候选，可加入 Regression Plan（${screened.map((c) => c.id).join('、')}）`);
  if (rejected.length) {
    const reasons = [...new Set(rejected.map((r) => r.blockedReason ?? '被拒绝'))];
    evidence.push(`拒绝 ${rejected.length} 个探索候选：${reasons.join('；')}`);
  }
  if (input.environment && isProductionTier(input.environment)) {
    evidence.push('生产环境：dangerous=DENY、risky=Approval，自治模式未改变安全策略');
  }

  return {
    generated: generated.selected,
    screened,
    rejected,
    lifecycle,
    budget: {
      usedCount,
      usedCost,
      usedDuration,
      maxCount: config.maxExplorationCases,
      maxCost: config.maxExplorationCost,
      maxDuration: config.maxExplorationDuration,
    },
    canAddToRegression: screened.length > 0,
    evidence,
  };
}

/** 来源统计（供 Report / Dashboard） */
export function explorationSourceStats(candidates: ExplorationCandidate[]): Record<ExplorationSource, number> {
  const out = Object.fromEntries(
    (['coverage-gap', 'history', 'parameter', 'requirement'] as ExplorationSource[]).map((s) => [s, 0]),
  ) as Record<ExplorationSource, number>;
  for (const c of candidates) out[c.source] += 1;
  return out;
}
