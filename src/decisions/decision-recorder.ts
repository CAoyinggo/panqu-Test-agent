// Decision Recorder：决策轨迹记录器（Phase 22 通用）
// 每次自治决策都必须留下 decision / score / evidence / reason / confidence / timestamp / inputs，
// 保证「所有自治行为必须可解释」。纯确定性，无 LLM。

import {
  DECISION_KINDS,
  type DecisionKind,
  type DecisionRecord,
  type DecisionTrace,
} from './decision-schema.js';

/** 记录输入 */
export interface RecordDecisionInput {
  kind: DecisionKind;
  decision: string;
  score?: number;
  evidence?: string[];
  reason: string;
  confidence?: number;
  timestamp?: number;
  inputs?: Record<string, unknown>;
  /** 关联用例（Trace 关联） */
  caseId?: string;
  /** 决策输出 */
  outputs?: Record<string, unknown>;
}

/** 决策轨迹记录器 */
export class DecisionRecorder {
  private readonly records: DecisionRecord[] = [];
  private seq = 0;

  constructor(private readonly taskId: string) {}

  /** 记录一条决策 */
  record(input: RecordDecisionInput): DecisionRecord {
    this.seq += 1;
    const nowIso = new Date(input.timestamp ?? Date.now()).toISOString();
    const record: DecisionRecord = {
      id: `${this.taskId}-d${String(this.seq).padStart(3, '0')}`,
      kind: input.kind,
      decision: input.decision,
      score: input.score,
      evidence: input.evidence ?? [],
      reason: input.reason,
      confidence: input.confidence,
      timestamp: nowIso,
      inputs: input.inputs ?? {},
    };
    this.records.push(record);
    record.caseId = input.caseId;
    record.outputs = input.outputs;
    return record;
  }

  /** 全部记录（按记录顺序） */
  entries(): DecisionRecord[] {
    return [...this.records];
  }

  /** 按类型查询 */
  byKind(kind: DecisionKind): DecisionRecord[] {
    return this.records.filter((r) => r.kind === kind);
  }

  size(): number {
    return this.records.length;
  }

  /** 生成 Decision Trace 汇总 */
  toTrace(): DecisionTrace {
    const byKind = Object.fromEntries(
      DECISION_KINDS.map((k) => [k, this.records.filter((r) => r.kind === k).length]),
    ) as Record<DecisionKind, number>;
    const detail = DECISION_KINDS.map((k) => `${k} ${byKind[k]}`).join(' / ');
    return {
      taskId: this.taskId,
      createdAt: new Date().toISOString(),
      records: [...this.records],
      byKind,
      summary: `共记录 ${this.records.length} 条自治决策：${detail}`,
    };
  }
}
