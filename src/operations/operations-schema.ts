// Operations Schema：统一 AI Test Operations 运维视图模型（Phase 21.8）
// 聚合：健康 / 执行任务 / 失败 / Flaky / RCA / Defect / Healing / 成本 /
//       Coverage / Knowledge / Agent Quality，输出统一运维快照。

/** 健康检查结果 */
export interface OperationsHealth {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/** 单次执行任务摘要 */
export interface OperationsRun {
  runId: string;
  feature: string;
  total: number;
  passed: number;
  failed: number;
  at?: string;
}

/** 自治运行摘要（Autonomous Run Summary，Phase 23.6 Dashboard 升级） */
export interface OperationsAutonomousRun {
  runId: string;
  feature: string;
  at?: string;
  total: number;
  executed: number;
  skipped: number;
  passed: number;
  failed: number;
  replans: number;
  rcaCount: number;
  coverage: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  stopReason: string | null;
  portfolioRate: number;
  explorationGenerated: number;
  explorationScreened: number;
  explorationRejected: number;
  decision: string;
  releaseDecision: 'PASS' | 'REVIEW' | 'BLOCK';
}

/** 自治运行状态（由最近一次 Release 决策推导） */
export type AutonomousRunStatus = 'AUTONOMOUS_PASS' | 'AUTONOMOUS_REVIEW' | 'AUTONOMOUS_BLOCK' | 'AUTONOMOUS_NONE';

/** 运维视图输入（各子系统已有产物的结构化摘要） */
export interface OperationsInput {
  health?: OperationsHealth;
  runs?: OperationsRun[];
  flaky?: { byStatus: Record<string, number>; quarantineIds: string[] };
  rca?: { total: number; byCategory?: Record<string, number> };
  defects?: { total: number; open: number; critical?: number; bySeverity?: Record<string, number> };
  healing?: { suggestions: number; applied: number; recovered: number };
  cost?: { total: number; byCategory?: Record<string, number>; costPerFeature?: Record<string, number> };
  coverage?: Record<string, number>;
  knowledge?: Record<string, number>;
  quality?: Array<{ feature: string; score: number; grade: string }>;
  /** 自治运行摘要（Phase 23.6） */
  autonomous?: { runs?: OperationsAutonomousRun[] };
}

/** 运维总体状态 */
export type OperationsStatus = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';

/** 运维快照 */
export interface OperationsView {
  generatedAt: string;
  status: OperationsStatus;
  health: OperationsHealth;
  runs: {
    count: number;
    totalCases: number;
    totalPassed: number;
    totalFailed: number;
    passRate: number;
    items: OperationsRun[];
  };
  flaky: { byStatus: Record<string, number>; quarantined: number; quarantineIds: string[] };
  rca: { total: number; byCategory: Record<string, number> };
  defects: { total: number; open: number; critical: number; bySeverity: Record<string, number> };
  healing: { suggestions: number; applied: number; recovered: number; recoveryRate: number };
  cost: { total: number; byCategory: Record<string, number>; costPerFeature: Record<string, number> };
  coverage: Record<string, number>;
  knowledge: Record<string, number>;
  quality: Array<{ feature: string; score: number; grade: string }>;
  /** 自治运行摘要（Phase 23.6 Dashboard 升级） */
  autonomous: {
    runs: OperationsAutonomousRun[];
    runCount: number;
    /** 自治运行状态（最近一次 Release 决策） */
    status: AutonomousRunStatus;
    latestReleaseDecision: 'PASS' | 'REVIEW' | 'BLOCK' | 'NONE';
    totalPlanned: number;
    totalExecuted: number;
    totalSkipped: number;
    totalReplans: number;
    totalRca: number;
  };
  /** 需要关注的问题（按严重度排序） */
  highlights: string[];
  summary: string;
}
