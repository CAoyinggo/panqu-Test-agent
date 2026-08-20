// AI Quality Optimization Contract（Phase 46 / 43.x）：AI 质量优化、反馈学习与持续改进闭环
// 统一数据契约：Feedback / Error Taxonomy / Error Cluster / Improvement Proposal /
// Prompt Version / Model Version / Experiment(Shadow/Canary) / Rollback / Audit。
// 铁律：
//   - 禁止不同模块各自维护完全不同的 Feedback 结构。
//   - 禁止 AI 自己修改生产 Prompt / Model / Knowledge（必须经 Human Approval）。
//   - 禁止未经 Benchmark 直接上线；禁止把 Mock 当真实结果。
// 复用 Phase 45 的 EvaluationDomain，保证与评测框架同源。
import type { EvaluationDomain } from '../eval/contract.js';

/** 评测领域（与 Phase 45 eval 同源，禁止重复定义） */
export type AiDomain = EvaluationDomain;

/** 反馈类型 */
export type FeedbackType =
  | 'CORRECT'
  | 'INCORRECT'
  | 'PARTIAL'
  | 'UNSAFE'
  | 'MISSING'
  | 'DUPLICATE';

export const FEEDBACK_TYPES: readonly FeedbackType[] = [
  'CORRECT', 'INCORRECT', 'PARTIAL', 'UNSAFE', 'MISSING', 'DUPLICATE',
];

/** 反馈来源 */
export type FeedbackSource =
  | 'HUMAN'
  | 'PRODUCTION'
  | 'EVALUATION'
  | 'SYSTEM';

export const FEEDBACK_SOURCES: readonly FeedbackSource[] = [
  'HUMAN', 'PRODUCTION', 'EVALUATION', 'SYSTEM',
];

/** 反馈接入渠道（43.2） */
export type FeedbackChannel =
  | 'HUMAN_CORRECTION'
  | 'RCA_VERIFICATION'
  | 'DEFECT_REVIEW'
  | 'RELEASE_REVIEW'
  | 'HEALING_REVIEW'
  | 'BENCHMARK_FAILURE'
  | 'PRODUCTION_INCIDENT'
  | 'FLAKY_CONFIRMATION';

export const FEEDBACK_CHANNELS: readonly FeedbackChannel[] = [
  'HUMAN_CORRECTION', 'RCA_VERIFICATION', 'DEFECT_REVIEW', 'RELEASE_REVIEW',
  'HEALING_REVIEW', 'BENCHMARK_FAILURE', 'PRODUCTION_INCIDENT', 'FLAKY_CONFIRMATION',
];

/** 统一 AI 反馈（43.1） */
export interface AIFeedback {
  id: string;
  runId?: string;
  caseId?: string;
  domain: AiDomain;
  prediction: unknown;
  actual: unknown;
  feedbackType: FeedbackType;
  source: FeedbackSource;
  /** 反馈渠道（来源细化） */
  channel?: FeedbackChannel;
  /** 人工置信度（可选） */
  confidence?: number;
  /** 是否已由人工核验 */
  verified: boolean;
  verifiedBy?: string;
  verifiedAt?: string;
  note?: string;
  createdAt: string;
}

/** 创建反馈输入 */
export interface CreateFeedbackInput {
  runId?: string;
  caseId?: string;
  domain: AiDomain;
  prediction: unknown;
  actual: unknown;
  feedbackType: FeedbackType;
  source: FeedbackSource;
  channel?: FeedbackChannel;
  confidence?: number;
  note?: string;
}

/** 错误类型分类（43.3） */
export type ErrorTaxonomy =
  | 'WRONG'           // 输出与真值不符（预测类别/字段错误）
  | 'MISSING'         // 应当输出但缺失
  | 'OVER_PREDICTION' // 过度预测（如风险虚高 / 过度 BLOCK）
  | 'UNDER_PREDICTION'// 低估（如 P2 实际 P0 / 漏判）
  | 'DUPLICATE'       // 重复产出（如重复创建缺陷）
  | 'UNSAFE'          // 不安全（如掩盖真实 Bug 的自愈）
  | 'INCONSISTENT'    // 自相矛盾 / 前后不一致
  | 'LOW_VALUE';      // 低价值输出

export const ERROR_TAXONOMY: readonly ErrorTaxonomy[] = [
  'WRONG', 'MISSING', 'OVER_PREDICTION', 'UNDER_PREDICTION',
  'DUPLICATE', 'UNSAFE', 'INCONSISTENT', 'LOW_VALUE',
];

export const ERROR_TAXONOMY_LABELS: Record<ErrorTaxonomy, string> = {
  WRONG: '错误输出',
  MISSING: '缺失输出',
  OVER_PREDICTION: '过度预测',
  UNDER_PREDICTION: '低估漏判',
  DUPLICATE: '重复产出',
  UNSAFE: '不安全行为',
  INCONSISTENT: '自相矛盾',
  LOW_VALUE: '低价值输出',
};

/** 错误聚类（43.4） */
export interface ErrorCluster {
  id: string;
  domain: AiDomain;
  category: ErrorTaxonomy;
  count: number;
  cases: string[];
  /** 疑似根因（规则启发，非虚构） */
  suspectedCause?: string;
  /** 证据（关联反馈/评测结果快照） */
  evidence: unknown[];
  createdAt: string;
  lastSeenAt: string;
}

/** 改进目标 */
export type ImprovementTarget =
  | 'PROMPT'
  | 'RULE'
  | 'MODEL'
  | 'TOOL'
  | 'KNOWLEDGE'
  | 'DATA';

export const IMPROVEMENT_TARGETS: readonly ImprovementTarget[] = [
  'PROMPT', 'RULE', 'MODEL', 'TOOL', 'KNOWLEDGE', 'DATA',
];

/** 提案状态机 */
export type ProposalStatus =
  | 'PROPOSED'
  | 'EVALUATING'
  | 'APPROVED'
  | 'REJECTED'
  | 'ACTIVATED'
  | 'ROLLED_BACK';

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'PROPOSED', 'EVALUATING', 'APPROVED', 'REJECTED', 'ACTIVATED', 'ROLLED_BACK',
];

export type ProposalRisk = 'LOW' | 'MEDIUM' | 'HIGH';

/** AI 改进提案（43.5） */
export interface ImprovementProposal {
  id: string;
  /** 来源错误聚类 */
  clusterId?: string;
  target: ImprovementTarget;
  problem: string;
  hypothesis: string;
  expectedImprovement: string;
  risk: ProposalRisk;
  evidence: unknown[];
  status: ProposalStatus;
  /** 离线评测（43.6）：baseline vs candidate */
  baselineScore?: number;
  candidateScore?: number;
  benchmark?: string;
  benchmarkVersion?: string;
  /** 多目标评分（43.10） */
  qualityScore?: number;
  gateVerdict?: 'PASS' | 'REVIEW' | 'BLOCK';
  /** 审批（Human Approval） */
  approvalId?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedReason?: string;
  /** 激活后实验记录（shadow / canary） */
  experimentId?: string;
  rollbackId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Prompt 版本（43.7） */
export interface PromptVersion {
  id: string;
  /** 逻辑名（如 risk） */
  promptKey: string;
  /** 版本号（v1/v2/...） */
  version: string;
  /** Prompt 内容 */
  content: string;
  /** 关联模型 */
  model?: string;
  /** 创建人（禁止 AI 自批） */
  createdBy: string;
  createdAt: string;
  /** 该版本在基准上的得分（评测后填写） */
  benchmarkScore?: number;
  status: 'DRAFT' | 'ACTIVE' | 'DISABLED' | 'ROLLED_BACK';
  parentVersion?: string;
}

/** Model 版本（43.8） */
export interface ModelVersion {
  id: string;
  provider: string;
  model: string;
  modelVersion: string;
  /** 配置（temperature / maxTokens 等） */
  configuration: Record<string, unknown>;
  status: 'DRAFT' | 'ACTIVE' | 'DISABLED' | 'ROLLED_BACK';
  createdBy: string;
  createdAt: string;
}

/** A/B 评测维度（43.9） */
export interface AbMetric {
  accuracy: number;
  latencyMs: number;
  cost: number;
  failureRate: number;
  safety: number;
}

/** A/B 对比结果 */
export interface AbComparison {
  baseline: AbMetric;
  candidate: AbMetric;
  deltas: {
    accuracy: number;
    latencyMs: number;
    cost: number;
    failureRate: number;
    safety: number;
  };
  /** 逐维度胜者（baseline / candidate / tie） */
  winners: Record<'accuracy' | 'latencyMs' | 'cost' | 'failureRate' | 'safety', 'baseline' | 'candidate' | 'tie'>;
  /** 多目标综合分（43.10） */
  baselineQuality: number;
  candidateQuality: number;
}

/** 多目标加权配置（43.10） */
export interface ObjectiveWeights {
  quality: number;
  safety: number;
  latency: number;
  cost: number;
}

export const DEFAULT_OBJECTIVE_WEIGHTS: ObjectiveWeights = {
  quality: 0.5,
  safety: 0.3,
  latency: 0.1,
  cost: 0.1,
};

/** 实验类型（43.13/43.14） */
export type ExperimentType = 'SHADOW' | 'CANARY';

/** 实验阶段（Canary 分级） */
export type CanaryStage = '5%' | '20%' | '50%' | '100%';

export const CANARY_STAGES: readonly CanaryStage[] = ['5%', '20%', '50%', '100%'];

export type ExperimentStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'PAUSED'
  | 'PROMOTED'
  | 'ROLLED_BACK'
  | 'COMPLETED';

/** 实验记录（Shadow / Canary） */
export interface ExperimentRecord {
  id: string;
  type: ExperimentType;
  /** 关联提案 */
  proposalId: string;
  /** 候选版本（prompt 或 model） */
  candidateRef: string;
  /** Canary 当前阶段 */
  canaryStage?: CanaryStage;
  status: ExperimentStatus;
  /** 每个阶段观测指标快照 */
  stages: Array<{
    stage?: CanaryStage;
    label: string;
    startedAt: string;
    metrics: Partial<AbMetric>;
    passed: boolean;
    reason?: string;
  }>;
  /** 是否进入生产（仅 Shadow/CANARY 100% 且达标后） */
  activatedAt?: string;
  rolledBackAt?: string;
  rollbackReason?: string;
  createdAt: string;
}

/** 回滚记录（43.12） */
export interface RollbackRecord {
  id: string;
  proposalId?: string;
  kind: 'PROMPT' | 'MODEL' | 'RULE' | 'KNOWLEDGE';
  fromRef: string;
  toRef: string;
  reason: string;
  evidence: unknown[];
  metrics: Record<string, number>;
  actor: string;
  createdAt: string;
}

/** 审计记录（43.19） */
export interface ImprovementAuditRecord {
  id: string;
  proposalId: string;
  actor: string;
  action:
    | 'CREATED'
    | 'EVALUATED'
    | 'APPROVED'
    | 'REJECTED'
    | 'ACTIVATED'
    | 'ROLLED_BACK'
    | 'CANARY_PROMOTED'
    | 'CANARY_PAUSED';
  baseline?: string;
  candidate?: string;
  benchmark?: string;
  approvalId?: string;
  metrics?: Record<string, number>;
  decision: string;
  timestamp: string;
}

/** 变更影响（43.23） */
export interface ChangeImpact {
  changeRef: string;
  changeType: 'PROMPT' | 'MODEL' | 'TOOL' | 'KNOWLEDGE';
  affectedBenchmarks: string[];
  affectedDomains: AiDomain[];
  affectedProjects: string[];
  affectedRuns: string[];
  targetedEvaluationSuggested: boolean;
  generatedAt: string;
}

/** 常量：无需参数即可复用的辅助函数 */
export function isProposalApprovable(p: ImprovementProposal): boolean {
  return p.status === 'EVALUATING' && p.gateVerdict === 'PASS' && p.candidateScore != null && p.baselineScore != null;
}

export function isProposalActivable(p: ImprovementProposal): boolean {
  return p.status === 'APPROVED' && !!p.approvalId && !!p.approvedBy;
}
