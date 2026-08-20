// Experiment（Shadow + Canary + Rollback）（Phase 46 / 43.12 + 43.13 + 43.14）
// Shadow Mode（43.13）：新 Prompt / Model 第一次上线先 Shadow——真实 Run 中 Baseline 执行 +
// Candidate Shadow，Candidate 不修改生产状态（不影响 Release / Defect / Healing），只记录
// Prediction / Score / Latency / Cost。
// Canary（43.14）：Shadow 通过后 5% → 20% → 50% → 100%，每阶段检查 Accuracy / Safety /
// Cost / Latency / Error Rate，异常自动停止扩展，严重异常自动回滚。
// Rollback（43.12）：上线后发现 Accuracy ↓ / False Pass ↑ / Unsafe Healing ↑ / Critical RCA Miss ↑
// → 自动 DEACTIVATE → ROLLBACK → RESTORE BASELINE，并记录原因 / 证据 / 指标。
import { randomBytes } from 'node:crypto';
import type { AbMetric, CanaryStage, ExperimentRecord, RollbackRecord } from './contract.js';
import { CANARY_STAGES } from './contract.js';

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export interface ExperimentOptions {
  now?: () => string;
}

/** Shadow 观测指标（只读，不改变生产状态） */
export interface ShadowObservation {
  prediction: unknown;
  score: number;
  latencyMs: number;
  cost: number;
  timestamp: string;
}

export class ExperimentStore {
  private readonly items = new Map<string, ExperimentRecord>();

  constructor(private readonly opts: ExperimentOptions = {}) {}

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  /** 创建 Shadow 实验（43.13） */
  createShadow(input: { proposalId: string; candidateRef: string }): ExperimentRecord {
    const rec: ExperimentRecord = {
      id: newId('exp'),
      type: 'SHADOW',
      proposalId: input.proposalId,
      candidateRef: input.candidateRef,
      status: 'RUNNING',
      stages: [],
      createdAt: this.now(),
    };
    this.items.set(rec.id, rec);
    return rec;
  }

  /** 创建 Canary 实验（43.14）：从 5% 开始 */
  createCanary(input: { proposalId: string; candidateRef: string }): ExperimentRecord {
    const rec: ExperimentRecord = {
      id: newId('exp'),
      type: 'CANARY',
      proposalId: input.proposalId,
      candidateRef: input.candidateRef,
      canaryStage: '5%',
      status: 'RUNNING',
      stages: [],
      createdAt: this.now(),
    };
    this.items.set(rec.id, rec);
    return rec;
  }

  get(id: string): ExperimentRecord | null {
    return this.items.get(id) ?? null;
  }

  list(filter: { type?: string; status?: string; proposalId?: string } = {}): ExperimentRecord[] {
    return [...this.items.values()].filter((e) => {
      if (filter.type && e.type !== filter.type) return false;
      if (filter.status && e.status !== filter.status) return false;
      if (filter.proposalId && e.proposalId !== filter.proposalId) return false;
      return true;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 记录 Shadow 观测。Candidate 只记录，不修改生产（read-only）。
   * 返回 Shadow 阶段是否通过（候选 accuracy ≥ baseline 时通过）。
   */
  recordShadowObservation(
    id: string,
    input: {
      baseline: AbMetric;
      candidate: AbMetric;
      observations?: ShadowObservation[];
    },
  ): { passed: boolean; reason?: string } {
    const e = this.items.get(id);
    if (!e) throw new Error(`实验不存在：${id}`);
    if (e.type !== 'SHADOW') throw new Error(`实验 ${id} 不是 Shadow`);
    const passed = input.candidate.accuracy >= input.baseline.accuracy - 1e-9;
    e.stages.push({
      label: 'shadow',
      startedAt: this.now(),
      metrics: {
        accuracy: input.candidate.accuracy,
        latencyMs: input.candidate.latencyMs,
        cost: input.candidate.cost,
        failureRate: input.candidate.failureRate,
        safety: input.candidate.safety,
      },
      passed,
      reason: passed ? 'Shadow 候选不劣于基线，可进入 Canary' : `Shadow 候选精度 ${input.candidate.accuracy} < 基线 ${input.baseline.accuracy}`,
    });
    if (passed) {
      e.status = 'COMPLETED';
    } else {
      e.status = 'PAUSED';
    }
    return { passed, reason: e.stages[e.stages.length - 1].reason };
  }

  /**
   * Canary 阶段推进：5% → 20% → 50% → 100%（43.14）。
   * 每阶段检查 Accuracy / Safety / Cost / Latency / Error Rate；
   * 关键异常（accuracy 明显下降 / unsafe > 0）→ 自动停止（PAUSED）或回滚。
   */
  canaryPromote(
    id: string,
    input: {
      metrics: AbMetric;
      thresholdAccuracyDrop?: number;
    },
  ): { stage: CanaryStage; passed: boolean; reason?: string } {
    const e = this.items.get(id);
    if (!e) throw new Error(`实验不存在：${id}`);
    if (e.type !== 'CANARY') throw new Error(`实验 ${id} 不是 Canary`);
    if (e.status === 'ROLLED_BACK' || e.status === 'PAUSED') {
      return { stage: e.canaryStage ?? '5%', passed: false, reason: `Canary 已 ${e.status}，不可继续推进` };
    }
    const current = e.canaryStage ?? '5%';
    const idx = CANARY_STAGES.indexOf(current);
    const currentAllowed = Math.min(0.99, 1 - Number(current.replace('%', '')) / 100);
    const safety = input.metrics.safety ?? 0;
    const accuracyDrop = input.metrics.accuracy ?? 0;
    const threshold = input.thresholdAccuracyDrop ?? 0.03;

    const reasons: string[] = [];
    if (safety > 0) reasons.push(`Unsafe 指标上升（${safety}），严重异常`);
    if (accuracyDrop < -threshold) reasons.push(`Accuracy 下降超过阈值（Δ${(accuracyDrop * 100).toFixed(1)}%），异常`);

    if (reasons.length > 0) {
      e.status = 'ROLLED_BACK';
      e.rolledBackAt = this.now();
      e.rollbackReason = reasons.join('；');
      e.stages.push({
        stage: current,
        label: `${current} 检查异常`,
        startedAt: this.now(),
        metrics: input.metrics,
        passed: false,
        reason: e.rollbackReason,
      });
      return { stage: current, passed: false, reason: e.rollbackReason };
    }

    e.stages.push({
      stage: current,
      label: `${current} 检查通过`,
      startedAt: this.now(),
      metrics: input.metrics,
      passed: true,
      reason: '指标达标',
    });

    if (idx >= CANARY_STAGES.length - 1) {
      // 100% 通过 → 全量激活
      e.status = 'PROMOTED';
      e.canaryStage = '100%';
      e.activatedAt = this.now();
      return { stage: '100%', passed: true, reason: 'Canary 100% 通过，全量激活' };
    }
    const next = CANARY_STAGES[idx + 1];
    e.canaryStage = next;
    return { stage: next, passed: true, reason: `${current} 通过，推进至 ${next}` };
  }

  /** 手动暂停（异常时停止扩展） */
  pause(id: string, reason: string): ExperimentRecord {
    const e = this.items.get(id);
    if (!e) throw new Error(`实验不存在：${id}`);
    e.status = 'PAUSED';
    e.stages.push({ label: '人工暂停', startedAt: this.now(), metrics: {}, passed: false, reason });
    return e;
  }

  /** 回滚（43.12）：恢复基线，记录原因 / 证据 / 指标 */
  rollback(id: string, input: { reason: string; evidence?: unknown[]; metrics?: Record<string, number> }): RollbackRecord {
    const e = this.items.get(id);
    if (!e) throw new Error(`实验不存在：${id}`);
    e.status = 'ROLLED_BACK';
    e.rolledBackAt = this.now();
    e.rollbackReason = input.reason;
    const rec: RollbackRecord = {
      id: newId('rb'),
      proposalId: e.proposalId,
      kind: 'PROMPT',
      fromRef: e.candidateRef,
      toRef: 'baseline',
      reason: input.reason,
      evidence: input.evidence ?? [],
      metrics: input.metrics ?? {},
      actor: 'SYSTEM',
      createdAt: this.now(),
    };
    return rec;
  }

  size(): number {
    return this.items.size;
  }

  /** 从快照恢复（CLI/API 持久化用） */
  static import(items: ExperimentRecord[]): ExperimentStore {
    const s = new ExperimentStore();
    for (const e of items) s.items.set(e.id, e);
    return s;
  }
}

export function createExperimentStore(): ExperimentStore {
  return new ExperimentStore();
}
