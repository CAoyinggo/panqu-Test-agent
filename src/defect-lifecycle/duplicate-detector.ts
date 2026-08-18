// Defect Duplicate Detector：缺陷重复判定（Phase 21.4）
// 目标：失败 → 搜索历史 Issue → 判断是否重复 → 关联已有 Bug，
// 避免同一个问题每次回归创建一个新 Bug。
// 确定性实现：失败签名规范化 + 关键词重叠评分，不引入向量数据库。

import type { DefectRecord } from './lifecycle-schema.js';

/** 失败报告（重复判定输入） */
export interface FailureReport {
  caseId: string;
  feature: string;
  /** 错误文本 */
  error?: string;
  /** RCA 根因类别 */
  category?: string;
}

/** 重复判定结果 */
export interface DuplicateVerdict {
  isDuplicate: boolean;
  /** 命中的已有 Bug（得分最高者） */
  match?: DefectRecord;
  score: number;
  reasons: string[];
}

/** 判定阈值：总分 ≥ 5 视为重复 */
export const DUPLICATE_THRESHOLD = 5;

/** 规范化失败签名：小写、去数字/时间戳/ID/路径，保留错误关键词 */
export function buildFailureSignature(error?: string): string {
  if (!error) return '';
  return error
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(\.\d+)?z?\b/g, ' ') // 时间戳
    .replace(/\b[0-9a-f]{8,}\b/g, ' ')                                       // 长 hex id
    .replace(/\b\d+\b/g, ' ')                                                // 数字
    .replace(/https?:\/\/\S+/g, ' ')                                         // URL
    .replace(/["'`]/g, ' ')
    .split(/[\s:：,，;；|/\\()\[\]{}]+/)
    .filter((w) => w.length >= 2)
    .sort()
    .join(' ');
}

/** 签名关键词集合 */
function signatureWords(signature: string): Set<string> {
  return new Set(signature.split(' ').filter(Boolean));
}

/** 两个签名的关键词重叠率（Jaccard） */
export function signatureOverlap(a: string, b: string): number {
  const wa = signatureWords(a);
  const wb = signatureWords(b);
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  return inter / Math.max(wa.size, wb.size);
}

/**
 * 重复判定评分（确定性）：
 *   - feature 一致 +2
 *   - RCA category 一致 +2
 *   - 失败签名重叠率 ×4（0~4）
 *   - 关联用例重叠 +2
 * 总分 ≥ DUPLICATE_THRESHOLD（5）判定为重复。
 */
export function scoreDuplicate(failure: FailureReport, candidate: DefectRecord): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  if (failure.feature === candidate.feature) {
    score += 2;
    reasons.push('feature 一致');
  }
  if (failure.category && candidate.category && failure.category === candidate.category) {
    score += 2;
    reasons.push(`根因类别一致：${failure.category}`);
  }
  const failSig = buildFailureSignature(failure.error);
  if (failSig && candidate.failureSignature) {
    const overlap = signatureOverlap(failSig, candidate.failureSignature);
    if (overlap > 0) {
      const gained = Math.round(overlap * 4 * 10) / 10;
      score += gained;
      reasons.push(`失败签名重叠 ${(overlap * 100).toFixed(0)}%`);
    }
  }
  if (candidate.relatedCases.includes(failure.caseId)) {
    score += 2;
    reasons.push(`关联用例重叠：${failure.caseId}`);
  }
  return { score, reasons };
}

/**
 * 在历史缺陷中查找重复：返回得分最高且 ≥ 阈值的候选。
 * 仅对未关闭或已知问题状态的缺陷做匹配（CLOSED 且非 KNOWN_ISSUE 的历史 Bug 不参与，
 * 因为已修复关闭的问题再次出现应视为回归而非重复）。
 */
export function detectDuplicate(failure: FailureReport, history: DefectRecord[]): DuplicateVerdict {
  let best: { record: DefectRecord; score: number; reasons: string[] } | null = null;
  for (const record of history) {
    const closedFixed = record.status === 'CLOSED' && record.resolution !== 'KNOWN_ISSUE';
    if (closedFixed) continue;
    const { score, reasons } = scoreDuplicate(failure, record);
    if (score >= DUPLICATE_THRESHOLD && (!best || score > best.score)) {
      best = { record, score, reasons };
    }
  }
  if (!best) return { isDuplicate: false, score: 0, reasons: [] };
  return { isDuplicate: true, match: best.record, score: best.score, reasons: best.reasons };
}
