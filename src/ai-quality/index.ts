// AI Quality Optimization Facade（Phase 46 / 43.x）统一出口
// 组合：FeedbackRegistry + ErrorAnalysis + ProposalStore + PromptStore + ModelStore +
// ExperimentStore(Shadow/Canary) + KnowledgeLearning + ImprovementAudit + AI Release Gate。
// 提供：
//   - 从 Benchmark 失败结果自动生成 Feedback（BENCHMARK_FAILURE 渠道，已验证）
//   - 从 Feedback 自动聚类错误 → 自动生成 Proposal
//   - AI Quality 聚合视图（AIQualityReport）
//   - Change Impact → Targeted Evaluation 建议
export { createFeedbackRegistry } from './feedback.js';
export { FeedbackRegistry } from './feedback.js';
export { normalizeCreateFeedbackInput, deriveErrorTaxonomy } from './feedback.js';
export { analyzeErrors, classifyFeedback, classifyEvalResult, formatErrorCluster } from './error-analysis.js';
export { ProposalStore, createProposalStore, proposalFromCluster, runImprovementGate, targetForCluster, riskForCluster } from './improvement.js';
export { PromptStore, ModelStore, compareAb, multiObjectiveScore, formatAbComparison } from './versioning.js';
export { ExperimentStore, createExperimentStore } from './experiment.js';
export { KnowledgeLearning, createKnowledgeLearning } from './knowledge-learning.js';
export { detectRegression, aiReleaseGate, computeChangeImpact, benchmarkCandidateFromFeedback, CONTINUOUS_EVAL_SCHEDULES } from './ops.js';
export { ImprovementAudit, createImprovementAudit } from './ops.js';
export { BenchmarkCandidateStore, createBenchmarkCandidateStore, bridgeEvalReport, extractEvalFailures, type BenchmarkCandidate, type BenchmarkCandidateStatus, type EvalBridgeResult, type EvalBridgeDeps } from './eval-bridge.js';
export { mergeApprovedCandidates, candidateMatchesSource, type BenchmarkMergeResult, type BenchmarkMergeDeps, type BenchmarkMergeOptions } from './benchmark-merge.js';
export type { ErrorAnalysisSource, ErrorAnalysisOptions } from './error-analysis.js';
export type { CreateProposalInput, ImprovementGateInput, ImprovementGateResult, ProposalStoreOptions } from './improvement.js';
export type { ExperimentOptions, ShadowObservation } from './experiment.js';
export type { KnowledgeUsageEvent, KnowledgeCandidate, KnowledgeItem } from './knowledge-learning.js';
export type { AbMetric, AbComparison, AIFeedback, ErrorCluster, ErrorTaxonomy, ImprovementProposal, PromptVersion, ModelVersion, ExperimentRecord, RollbackRecord, ChangeImpact, ImprovementAuditRecord, ObjectiveWeights, FeedbackType, FeedbackSource, FeedbackChannel, CanaryStage } from './contract.js';
export { ERROR_TAXONOMY, ERROR_TAXONOMY_LABELS, FEEDBACK_TYPES, FEEDBACK_SOURCES, FEEDBACK_CHANNELS, IMPROVEMENT_TARGETS, PROPOSAL_STATUSES, CANARY_STAGES, DEFAULT_OBJECTIVE_WEIGHTS } from './contract.js';

export type { AIFeedback as AiFeedback, AiDomain } from './contract.js';
export { ERROR_TAXONOMY as ERROR_TAXONOMY_ALIAS } from './contract.js';
