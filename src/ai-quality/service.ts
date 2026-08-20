// AI Quality Service（Phase 46 / 43.x 聚合服务）
// 组合各 Store 并提供高层操作：
//   - ingestFeedback：接入各渠道反馈（Human / RCA / Defect / Release / Healing / Benchmark /
//     Production / Flaky），统一写入 FeedbackRegistry
//   - runFullLoop：Feedback → ErrorCluster → Proposal（自动生成）
//   - aiQualityReport：聚合 AI Quality 视图（Accuracy / Regression / False Pass / P0 Miss /
//     RCA Accuracy / Selection Recall / Defect Quality / Healing Safety / Cost / Latency）
//   - Targeted Evaluation：Change Impact → 建议评测哪些领域
// 全部确定性、可复现；不消耗 token。
import fs from 'node:fs';
import path from 'node:path';
import type { AiDomain, AIFeedback, ErrorCluster, ImprovementProposal, ObjectiveWeights, FeedbackSource, FeedbackType, FeedbackChannel, PromptVersion, ModelVersion, ExperimentRecord, ImprovementAuditRecord } from './contract.js';
import { CANARY_STAGES } from './contract.js';
import { FeedbackRegistry } from './feedback.js';
import { analyzeErrors } from './error-analysis.js';
import { ProposalStore, proposalFromCluster } from './improvement.js';
import { PromptStore, ModelStore } from './versioning.js';
import { ExperimentStore } from './experiment.js';
import { KnowledgeLearning, type KnowledgeCandidate, type KnowledgeItem } from './knowledge-learning.js';
import { ContinuousEvalStore, runContinuousEvaluation, type ContinuousEvalRun, type ContinuousEvalScheduleName, type ContinuousEvalTrigger } from './continuous-eval.js';
import { ImprovementAudit } from './ops.js';
import type { EvalReport } from '../eval/runner.js';

export interface AIQualityServiceDeps {
  feedback?: FeedbackRegistry;
  proposals?: ProposalStore;
  prompts?: PromptStore;
  models?: ModelStore;
  experiments?: ExperimentStore;
  knowledge?: KnowledgeLearning;
  continuousEval?: ContinuousEvalStore;
  audit?: ImprovementAudit;
  now?: () => string;
}

export interface IngestFeedbackInput {
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
  verified?: boolean;
}

export class AIQualityService {
  readonly feedback: FeedbackRegistry;
  readonly proposals: ProposalStore;
  readonly prompts: PromptStore;
  readonly models: ModelStore;
  readonly experiments: ExperimentStore;
  readonly knowledge: KnowledgeLearning;
  readonly continuousEval: ContinuousEvalStore;
  readonly audit: ImprovementAudit;

  constructor(deps: AIQualityServiceDeps = {}) {
    this.feedback = deps.feedback ?? new FeedbackRegistry();
    this.proposals = deps.proposals ?? new ProposalStore();
    this.prompts = deps.prompts ?? new PromptStore();
    this.models = deps.models ?? new ModelStore();
    this.experiments = deps.experiments ?? new ExperimentStore();
    this.knowledge = deps.knowledge ?? new KnowledgeLearning();
    this.continuousEval = deps.continuousEval ?? new ContinuousEvalStore();
    this.audit = deps.audit ?? new ImprovementAudit();
  }

  /** 43.2：接入各渠道反馈（统一入口） */
  ingest(input: IngestFeedbackInput): AIFeedback {
    const fb = this.feedback.add(
      {
        runId: input.runId,
        caseId: input.caseId,
        domain: input.domain,
        prediction: input.prediction,
        actual: input.actual,
        feedbackType: input.feedbackType,
        source: input.source,
        channel: input.channel,
        confidence: input.confidence,
        note: input.note,
      },
      input.verified ?? false,
    );
    this.audit.record({
      proposalId: 'n/a',
      actor: input.source === 'HUMAN' ? 'HUMAN' : input.source,
      action: 'CREATED',
      decision: `反馈已登记 ${fb.id}（${fb.domain}/${fb.feedbackType}）`,
      metrics: { confidence: fb.confidence ?? 0 },
    });
    return fb;
  }

  /** 43.4：从反馈自动聚类错误 */
  errorClusters(): ErrorCluster[] {
    return analyzeErrors({ feedback: this.feedback.list() });
  }

  /** 43.5：从 ErrorCluster 自动生成 Proposal（每 cluster 至多一个未处理提案） */
  autoProposals(): ImprovementProposal[] {
    const created: ImprovementProposal[] = [];
    for (const cluster of this.errorClusters()) {
      const existing = this.proposals.list().filter((p) => p.clusterId === cluster.id && p.status !== 'REJECTED' && p.status !== 'ROLLED_BACK');
      if (existing.length > 0) continue;
      const p = this.proposals.create(proposalFromCluster(cluster));
      this.proposals.clusterDomain.set(cluster.id, cluster.domain);
      this.audit.record({
        proposalId: p.id,
        actor: 'SYSTEM',
        action: 'CREATED',
        decision: `由错误聚类 ${cluster.id} 自动生成提案`,
        metrics: { clusterCount: cluster.count },
      });
      created.push(p);
    }
    return created;
  }

  /** 43.22：AI Quality 聚合报告（从 EvalReport + 各 Store 汇总） */
  aiQualityReport(evalReport: EvalReport, weights?: ObjectiveWeights): Record<string, unknown> {
    const domains = Object.fromEntries(evalReport.domains.map((d) => [d.domain, d.score]));
    return {
      overall: evalReport.overall,
      accuracy: evalReport.overall,
      regression: {
        overall: evalReport.overall,
        generatedAt: evalReport.generatedAt,
      },
      falsePass: evalReport.critical.falsePass,
      p0Miss: evalReport.critical.p0Miss,
      rcaAccuracy: domains['RCA'] ?? 0,
      selectionRecall: domains['SELECTION'] ?? 0,
      defectQuality: domains['DEFECT'] ?? 0,
      healingSafety: domains['HEALING'] ?? 0,
      cost: evalReport.cost.cost,
      latency: evalReport.domains.reduce((s, d) => s + d.cost.latencyMs, 0),
      benchmark: {
        total: evalReport.domains.reduce((s, d) => s + d.total, 0),
        tracked: evalReport.domains.reduce((s, d) => s + d.tracked, 0),
      },
      feedback: {
        total: this.feedback.size(),
        verified: this.feedback.list({ verified: true }).length,
        errorClusters: this.errorClusters().length,
      },
      proposals: {
        total: this.proposals.size(),
        byStatus: this.proposals.list().reduce((acc: Record<string, number>, p) => {
          acc[p.status] = (acc[p.status] ?? 0) + 1;
          return acc;
        }, {}),
      },
      experiments: {
        total: this.experiments.size(),
        shadow: this.experiments.list({ type: 'SHADOW' }).length,
        canary: this.experiments.list({ type: 'CANARY' }).length,
      },
      knowledge: {
        candidates: this.knowledge.candidateSize(),
        active: this.knowledge.itemSize(),
        quality: this.knowledge.qualityMetrics(),
      },
      weights: weights ?? undefined,
    };
  }

  /** 43.23：Targeted Evaluation——根据变更影响返回应评测的领域 */
  targetedEvaluationDomains(changeType: 'PROMPT' | 'MODEL' | 'TOOL' | 'KNOWLEDGE', domains?: AiDomain[]): AiDomain[] {
    const all: AiDomain[] = ['REQUIREMENT', 'TEST_DESIGN', 'RISK', 'SELECTION', 'RCA', 'DEFECT', 'HEALING', 'RELEASE'];
    if (domains && domains.length > 0) return domains;
    // 无明确领域时按变更类型给出定向建议
    switch (changeType) {
      case 'PROMPT':
        return ['REQUIREMENT', 'RISK', 'RCA'];
      case 'MODEL':
        return ['REQUIREMENT', 'TEST_DESIGN', 'RISK', 'RCA', 'DEFECT', 'HEALING', 'RELEASE'];
      case 'TOOL':
        return ['TEST_DESIGN', 'SELECTION'];
      case 'KNOWLEDGE':
        return all;
      default:
        return all;
    }
  }

  /** 43.12：回滚（质量回归时自动回滚，恢复基线）——统一走此入口以完整记录审计链路 */
  rollbackExperiment(
    id: string,
    input: { reason: string; evidence?: unknown[]; metrics?: Record<string, number> },
  ): import('./contract.js').RollbackRecord {
    const rec = this.experiments.rollback(id, input);
    this.audit.record({
      proposalId: rec.proposalId ?? 'n/a',
      actor: 'SYSTEM',
      action: 'ROLLED_BACK',
      baseline: undefined,
      candidate: rec.fromRef,
      metrics: rec.metrics,
      decision: `${rec.reason}（${rec.kind} ${rec.fromRef} → ${rec.toRef}）`,
    });
    return rec;
  }

  /**
   * 48.x / 43.20：运行一次 Continuous Evaluation（真实 Benchmark → Compare → Detect Regression）。
   * 返回运行记录；Critical Regression（verdict BLOCK）→ alertSent=true + releaseBlocked=true，
   * 由调度方（CLI / API / 定时器）决定实际投递 Alert 与阻断发布。
   */
  runContinuousEval(input: {
    schedule: ContinuousEvalScheduleName;
    triggeredBy?: ContinuousEvalTrigger;
    domains?: import('../eval/contract.js').EvaluationDomain[];
    allowDrop?: number;
    createdBy?: string;
  }): ContinuousEvalRun {
    const run = runContinuousEvaluation(input, { store: this.continuousEval });
    this.audit.record({
      proposalId: 'n/a',
      actor: run.createdBy,
      action: 'CREATED',
      decision: `Continuous Evaluation ${run.schedule} 运行完成：Overall ${(run.current.overall * 100).toFixed(1)}% → verdict ${run.regression.verdict}（${run.regression.reasons.join('；')}）`,
      metrics: {
        overall: run.current.overall,
        p0Miss: run.current.critical.p0Miss,
        falsePass: run.current.critical.falsePass,
        unsafeHealing: run.current.critical.unsafeHealing,
      },
    });
    return run;
  }

  /** 完整状态快照（持续改进闭环持久化：CLI / API 重启后恢复） */
  snapshot(): AiQualitySnapshot {
    return {
      feedback: this.feedback.snapshot(),
      proposals: this.proposals.list(),
      clusterDomains: Object.fromEntries(this.proposals.clusterDomain),
      prompts: this.prompts.list(),
      models: this.models.list(),
      experiments: this.experiments.list(),
      knowledgeCandidates: this.knowledge.listCandidates(),
      knowledgeItems: this.knowledge.listItems(),
      continuousEval: this.continuousEval.snapshot(),
      audit: this.audit.list(),
    };
  }

  /** 从快照恢复 */
  static restore(snap: AiQualitySnapshot): AIQualityService {
    const svc = new AIQualityService({
      feedback: FeedbackRegistry.import(snap.feedback),
      proposals: ProposalStore.import(snap.proposals, snap.clusterDomains),
      prompts: PromptStore.import(snap.prompts),
      models: ModelStore.import(snap.models),
      experiments: ExperimentStore.import(snap.experiments),
      knowledge: KnowledgeLearning.import(snap.knowledgeCandidates, snap.knowledgeItems),
      continuousEval: ContinuousEvalStore.import(snap.continuousEval ?? []),
      audit: ImprovementAudit.import(snap.audit),
    });
    return svc;
  }

  /** 43.x：持久化到 JSON 文件（持续改进闭环跨重启保留：Feedback / Proposal / Version / Experiment / Knowledge / Audit） */
  persistToFile(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2), 'utf-8');
    fs.renameSync(tmp, filePath); // 原子替换，避免写一半损坏
  }

  /** 从 JSON 文件恢复（文件不存在时返回空服务） */
  static loadFromFile(filePath: string): AIQualityService {
    if (!fs.existsSync(filePath)) return new AIQualityService();
    try {
      const snap = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AiQualitySnapshot;
      return AIQualityService.restore(snap);
    } catch {
      return new AIQualityService(); // 损坏快照安全降级为空服务，不阻塞启动
    }
  }
}

/** AI Quality 状态快照（43.19 审计 + 全 Store 持久化） */
export interface AiQualitySnapshot {
  feedback: AIFeedback[];
  proposals: ImprovementProposal[];
  clusterDomains: Record<string, string>;
  prompts: PromptVersion[];
  models: ModelVersion[];
  experiments: ExperimentRecord[];
  knowledgeCandidates: KnowledgeCandidate[];
  knowledgeItems: KnowledgeItem[];
  /** Phase 48：Continuous Evaluation 历史 */
  continuousEval?: ContinuousEvalRun[];
  audit: ImprovementAuditRecord[];
}

export function createAIQualityService(deps: AIQualityServiceDeps = {}): AIQualityService {
  return new AIQualityService(deps);
}

export { CANARY_STAGES };
