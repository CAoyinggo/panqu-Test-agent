// Cost Ledger：成本台账（Phase 21.6）
// 记录六类成本（LLM/环境/API/GPU/积分/时间），聚合出
// Cost/Case、Cost/Feature、Cost/Regression、Cost/Defect。
// recordLLM 将 token 用量折算为 LLM 成本入账，补齐 tracer 的成本数据通路。

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/fs-utils.js';
import {
  generateCostId,
  normalizeCreateCostInput,
  estimateLLMCost,
  DEFAULT_LLM_COST,
  type CostCategory,
  type CostRecord,
  type LLMCostConfig,
} from './cost-schema.js';

/** 成本汇总 */
export interface CostSummary {
  total: number;
  recordCount: number;
  byCategory: Record<string, number>;
  costPerCase: Record<string, number>;
  costPerFeature: Record<string, number>;
  costPerRegression: Record<string, number>;
  costPerDefect: Record<string, number>;
}

export class CostLedger {
  private readonly records = new Map<string, CostRecord>();

  /** 记录一条成本 */
  record(input: unknown): CostRecord {
    const norm = normalizeCreateCostInput(input);
    const record: CostRecord = {
      id: norm.id ?? generateCostId(),
      category: norm.category,
      amount: norm.amount,
      unit: norm.unit ?? 'credit',
      timestamp: norm.timestamp ?? new Date().toISOString(),
    };
    if (norm.businessId) record.businessId = norm.businessId;
    if (norm.feature) record.feature = norm.feature;
    if (norm.caseId) record.caseId = norm.caseId;
    if (norm.regressionRunId) record.regressionRunId = norm.regressionRunId;
    if (norm.defectId) record.defectId = norm.defectId;
    if (norm.quantity !== undefined) record.quantity = norm.quantity;
    if (norm.description) record.description = norm.description;
    this.records.set(record.id, record);
    return record;
  }

  /**
   * 记录一次 LLM 调用成本（token → 成本折算）。
   * 与 AgentTracer.recordLLM 配套：tracer 记录 token/延迟，ledger 记录折算成本。
   */
  recordLLM(
    attribution: { businessId?: string; feature?: string; caseId?: string; regressionRunId?: string },
    inputTokens: number,
    outputTokens: number,
    config: LLMCostConfig = DEFAULT_LLM_COST,
  ): CostRecord {
    return this.record({
      ...attribution,
      category: 'llm',
      amount: estimateLLMCost(inputTokens, outputTokens, config),
      unit: 'credit',
      quantity: inputTokens + outputTokens,
      description: `LLM tokens in=${inputTokens} out=${outputTokens}`,
    });
  }

  get(id: string): CostRecord | null {
    return this.records.get(id) ?? null;
  }

  /** 过滤记录 */
  list(filter: Partial<{ category: CostCategory; businessId: string; feature: string; caseId: string; regressionRunId: string; defectId: string }> = {}): CostRecord[] {
    return [...this.records.values()].filter((r) => {
      if (filter.category && r.category !== filter.category) return false;
      if (filter.businessId && r.businessId !== filter.businessId) return false;
      if (filter.feature && r.feature !== filter.feature) return false;
      if (filter.caseId && r.caseId !== filter.caseId) return false;
      if (filter.regressionRunId && r.regressionRunId !== filter.regressionRunId) return false;
      if (filter.defectId && r.defectId !== filter.defectId) return false;
      return true;
    });
  }

  /** 总成本（可按过滤条件） */
  total(filter?: Parameters<CostLedger['list']>[0]): number {
    return round6(this.list(filter ?? {}).reduce((s, r) => s + r.amount, 0));
  }

  /** Cost/Case */
  costPerCase(): Record<string, number> {
    return this.groupSum((r) => r.caseId);
  }

  /** Cost/Feature */
  costPerFeature(): Record<string, number> {
    return this.groupSum((r) => r.feature);
  }

  /** Cost/Regression（按回归运行 runId） */
  costPerRegression(): Record<string, number> {
    return this.groupSum((r) => r.regressionRunId);
  }

  /** Cost/Defect（定位/修复/回归验证缺陷所花成本） */
  costPerDefect(): Record<string, number> {
    return this.groupSum((r) => r.defectId);
  }

  /** 按类别汇总 */
  byCategory(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.records.values()) out[r.category] = round6((out[r.category] ?? 0) + r.amount);
    return out;
  }

  /** 完整汇总 */
  summarize(): CostSummary {
    return {
      total: this.total(),
      recordCount: this.records.size,
      byCategory: this.byCategory(),
      costPerCase: this.costPerCase(),
      costPerFeature: this.costPerFeature(),
      costPerRegression: this.costPerRegression(),
      costPerDefect: this.costPerDefect(),
    };
  }

  private groupSum(keyOf: (r: CostRecord) => string | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.records.values()) {
      const key = keyOf(r);
      if (!key) continue;
      out[key] = round6((out[key] ?? 0) + r.amount);
    }
    return out;
  }

  save(file: string): void {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ records: [...this.records.values()] }, null, 2), 'utf-8');
  }

  static load(file: string): CostLedger {
    const ledger = new CostLedger();
    try {
      if (!fs.existsSync(file)) return ledger;
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf-8')) as { records?: CostRecord[] };
      for (const r of snapshot.records ?? []) ledger.records.set(r.id, r);
    } catch {
      // 文件损坏：返回空台账
    }
    return ledger;
  }
}

export function createCostLedger(): CostLedger {
  return new CostLedger();
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
