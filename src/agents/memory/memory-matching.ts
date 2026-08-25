// 记忆检索共享逻辑：JSON / SQLite 实现复用的纯函数（单一实现，防两套语义漂移）。
import type { MemoryRecord, MemoryQuery, FailureRecord } from './memory-store.js';

/** 通用查询：type / tags / 时间窗过滤 + 时间倒序 + limit */
export function matchQuery(records: MemoryRecord[], query: MemoryQuery = {}): MemoryRecord[] {
  let out = records;
  if (query.type) out = out.filter((r) => r.type === query.type);
  if (query.tags && query.tags.length) {
    out = out.filter((r) => query.tags!.every((t) => r.tags?.includes(t)));
  }
  if (query.from) out = out.filter((r) => r.createdAt >= query.from!);
  if (query.to) out = out.filter((r) => r.createdAt <= query.to!);
  out = sortByTime(out);
  if (query.limit) out = out.slice(0, query.limit);
  return out;
}

/** 相似失败检索：类型 + 标签 + 关键词 + 同 caseId 加权，按相似度降序（前 10） */
export function matchSimilarFailures(records: MemoryRecord[], failure: FailureRecord): MemoryRecord[] {
  const keywords = [failure.category, failure.caseId, failure.message]
    .filter(Boolean)
    .map((s) => (s as string).toLowerCase());
  const failureTags = failure.tags ?? [];

  const scored = records
    .filter((r) => r.type === 'failure' || r.type === 'root-cause' || r.type === 'flaky')
    .map((r) => {
      let score = 0;
      for (const t of failureTags) {
        if (r.tags?.includes(t)) score += 3;
      }
      const blob = JSON.stringify(r.data).toLowerCase();
      for (const kw of keywords) {
        if (kw && blob.includes(kw)) score += 2;
      }
      if (r.data.caseId && failure.caseId && String(r.data.caseId) === String(failure.caseId)) score += 5;
      return { record: r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((x) => x.record).slice(0, 10);
}

/** 某用例历史：caseId 精确匹配（含 caseIds 数组）或标签命中 */
export function matchSimilarCase(records: MemoryRecord[], caseId: string, limit = 20): MemoryRecord[] {
  const id = String(caseId).toLowerCase();
  const matches = records.filter((r) => {
    if (String(r.data.caseId ?? '').toLowerCase() === id) return true;
    if (Array.isArray(r.data.caseIds) && r.data.caseIds.some((c) => String(c).toLowerCase() === id)) return true;
    return r.tags?.some((t) => t.toLowerCase() === id) ?? false;
  });
  return sortByTime(matches).slice(0, limit);
}

/** 某功能历史风险：failure / root-cause / flaky 记录 */
export function matchHistoricalRisk(records: MemoryRecord[], feature: string, limit = 20): MemoryRecord[] {
  const f = feature.toLowerCase();
  const matches = records.filter((r) => {
    if (r.type !== 'failure' && r.type !== 'root-cause' && r.type !== 'flaky') return false;
    return String(r.data.feature ?? r.data.module ?? '').toLowerCase() === f || r.tags?.includes(f);
  });
  return sortByTime(matches).slice(0, limit);
}

/** 已知问题：defect / root-cause 记录（可按功能过滤） */
export function matchKnownIssue(records: MemoryRecord[], feature?: string, limit = 20): MemoryRecord[] {
  const matches = records.filter((r) => {
    if (r.type !== 'defect' && r.type !== 'root-cause') return false;
    if (feature) {
      const f = feature.toLowerCase();
      return String(r.data.feature ?? '').toLowerCase() === f || r.tags?.includes(f);
    }
    return true;
  });
  return sortByTime(matches).slice(0, limit);
}

/** 覆盖缺口：coverage-gap 记录（可按功能过滤） */
export function matchCoverageGap(records: MemoryRecord[], feature?: string, limit = 50): MemoryRecord[] {
  const matches = records.filter((r) => {
    if (r.type !== 'coverage-gap') return false;
    if (feature) {
      const f = feature.toLowerCase();
      return String(r.data.feature ?? '').toLowerCase() === f || r.tags?.includes(f);
    }
    return true;
  });
  return sortByTime(matches).slice(0, limit);
}

/** 按 createdAt 倒序（无时间戳的记录排末尾） */
export function sortByTime(records: MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
}
