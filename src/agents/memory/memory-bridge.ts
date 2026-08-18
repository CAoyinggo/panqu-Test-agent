// Memory Bridge：AI 流程与记忆层的双向桥接
// 方向一：执行完成后将失败/结果写入记忆（持久化，供后续检索）。
// 方向二：执行前从记忆检索历史相似失败，转化为风险项（flaky/已知问题），辅助风险与执行决策。
// 遵循「Memory 可替换（JSON/SQLite/向量）」：只依赖 TestMemory 接口。

import type { TestMemory } from './memory-store.js';
import { generateMemoryId } from './memory-store.js';
import type { ExecutionOutcome } from '../execution/execution-schema.js';
import type { AnalysisReport, MemoryWorthyFailure } from '../analysis/analysis-schema.js';
import type { RiskItem } from '../risk/risk-schema.js';

/** 写入记忆返回统计 */
export interface MemoryWriteStats {
  saved: number;
  types: string[];
}

/** 保存分析报告中的失败记录与执行摘要到记忆 */
export async function storeAnalysisToMemory(
  memory: TestMemory,
  report: AnalysisReport,
  outcome: ExecutionOutcome,
): Promise<MemoryWriteStats> {
  const stats: MemoryWriteStats = { saved: 0, types: [] };

  // 执行摘要
  await memory.save({
    id: generateMemoryId('exec'),
    type: 'execution',
    createdAt: new Date().toISOString(),
    data: {
      feature: outcome.feature,
      total: outcome.total,
      passed: outcome.passed,
      failed: outcome.failed,
      timedOut: outcome.timedOut,
      passRate: outcome.passRate,
      summary: outcome.summary,
    },
    tags: [outcome.feature, 'execution'],
  });
  stats.saved++;
  stats.types.push('execution');

  // 失败记录（逐条）
  for (const f of report.memoryWorthy) {
    await saveFailure(memory, f);
    stats.saved++;
    stats.types.push('failure');
  }

  return stats;
}

/** 保存单条失败记录 */
export async function saveFailure(memory: TestMemory, f: MemoryWorthyFailure): Promise<void> {
  await memory.save({
    id: generateMemoryId('fail'),
    type: 'failure',
    createdAt: new Date().toISOString(),
    data: {
      caseId: f.caseId,
      category: f.category,
      message: f.message,
      evidence: f.evidence,
    },
    tags: [...f.tags, 'failure'],
  });
}

/** 保存单条历史失败（供外部直接调用） */
export async function storeFailure(
  memory: TestMemory,
  failure: { caseId: string; category?: string; message?: string; evidence?: string[]; tags?: string[] },
): Promise<void> {
  await saveFailure(memory, {
    caseId: failure.caseId,
    category: failure.category ?? 'error',
    message: failure.message ?? '',
    evidence: failure.evidence ?? [],
    tags: failure.tags ?? [],
  });
}

/** 从记忆检索历史相似失败，转化为风险项（供 Risk/Execution 阶段补充） */
export async function buildHistoricalRiskItems(memory: TestMemory, feature: string): Promise<RiskItem[]> {
  const records = await memory.query({ type: 'failure', tags: [feature], limit: 20 });
  if (!records.length) return [];

  const items: RiskItem[] = [];
  const byCase = new Map<string, number>();
  for (const r of records) {
    const caseId = String(r.data?.caseId ?? '');
    if (caseId) byCase.set(caseId, (byCase.get(caseId) ?? 0) + 1);
  }

  // 同一用例历史失败 ≥2 次 → flaky / 已知问题风险
  let idx = 0;
  for (const [caseId, count] of byCase) {
    if (count < 2) continue;
    items.push({
      id: `risk-hist-${String(++idx).padStart(2, '0')}`,
      category: 'compatibility',
      level: count >= 3 ? 'high' : 'medium',
      title: `历史不稳定用例：${caseId}（失败 ${count} 次）`,
      desc: `记忆层显示用例 ${caseId} 历史多次失败，可能为 flaky 或已知缺陷`,
      affectedCases: [caseId],
      mitigation: '执行时优先关注该用例，结合历史失败证据判断是 flaky 还是缺陷',
      confidence: Math.min(0.9, 0.5 + count * 0.1),
    });
  }
  return items;
}

/** 检索某用例的历史失败证据（供 Execution/Risk 决策） */
export async function getHistoricalEvidence(memory: TestMemory, caseId: string): Promise<string[]> {
  const records = await memory.query({ type: 'failure', limit: 10 });
  return records
    .filter((r) => String(r.data?.caseId ?? '') === caseId)
    .map((r) => String(r.data?.message ?? ''));
}
