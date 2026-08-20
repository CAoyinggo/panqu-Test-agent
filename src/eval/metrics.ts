// Evaluation Metrics（Phase 45 / 42.3-42.12 公共度量）
// 集合度量（precision/recall/F1）、混淆矩阵、Top-K 命中、检出率等，
// 供各领域评估器复用，保证统计口径一致（禁止各模块自造公式）。

/** 二分类混淆 */
export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export function emptyConfusion(): Confusion {
  return { tp: 0, fp: 0, fn: 0, tn: 0 };
}

/** 由逐条预测（actual 是否命中 expected）累计混淆 */
export function accumulateConfusion(c: Confusion, hit: boolean, predicted: boolean): Confusion {
  if (predicted && hit) return { ...c, tp: c.tp + 1 };
  if (predicted && !hit) return { ...c, fp: c.fp + 1 };
  if (!predicted && hit) return { ...c, fn: c.fn + 1 };
  return { ...c, tn: c.tn + 1 };
}

/** precision / recall / f1（0~1；分母为 0 时记 0） */
export function prf(tp: number, fp: number, fn: number): { precision: number; recall: number; f1: number } {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/** 集合 F1：actual 覆盖 expected 的程度（大小写不敏感） */
export function setScore(actual: string[], expected: string[]): { precision: number; recall: number; f1: number } {
  const a = new Set(actual.map((x) => String(x).toLowerCase()));
  const e = new Set(expected.map((x) => String(x).toLowerCase()));
  if (e.size === 0) return a.size === 0 ? { precision: 1, recall: 1, f1: 1 } : { precision: 0, recall: 0, f1: 0 };
  let inter = 0;
  for (const x of a) if (e.has(x)) inter++;
  const precision = a.size === 0 ? 0 : inter / a.size;
  const recall = inter / e.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/** 精确匹配（0/1） */
export function exactMatch(actual: unknown, expected: unknown): number {
  return String(actual).toLowerCase() === String(expected).toLowerCase() ? 1 : 0;
}

/** 均值（空列表返回 0） */
export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, x) => s + x, 0) / values.length;
}

/** 转百分比（0~100，保留 1 位小数） */
export function pct(v: number): number {
  return Math.round(v * 1000) / 10;
}

/** 截断到 4 位小数 */
export function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Top-K 命中判定：actual 排序列表前 K 项是否包含 target */
export function hitAtK(actualRanked: string[], target: string, k: number): boolean {
  return actualRanked.slice(0, k).includes(target);
}

/**
 * Recall@TopK：目标集中有多少在 actual 前 K 中被命中（k <= 0 时视为全量命中评估）。
 * 返回 { hit, total, recall }
 */
export function recallAtTopK(actualRanked: string[], targets: string[], k: number): { hit: number; total: number; recall: number } {
  const total = targets.length;
  if (total === 0) return { hit: 0, total: 0, recall: 0 };
  const pool = k > 0 ? new Set(actualRanked.slice(0, k)) : new Set(actualRanked);
  const hit = targets.filter((t) => pool.has(t)).length;
  return { hit, total, recall: hit / total };
}

/** 混淆矩阵（category 多分类）：返回矩阵与逐类 prf */
export function categoryConfusion(
  actuals: string[],
  expecteds: string[],
  categories: readonly string[],
): { matrix: Record<string, Record<string, number>>; perCategory: Record<string, { precision: number; recall: number; f1: number }> } {
  const matrix: Record<string, Record<string, number>> = {};
  for (const cat of categories) matrix[cat] = Object.fromEntries(categories.map((c) => [c, 0]));
  for (let i = 0; i < expecteds.length; i++) {
    const exp = expecteds[i];
    const act = actuals[i] ?? 'UNKNOWN';
    matrix[exp] = matrix[exp] ?? {};
    matrix[exp][act] = (matrix[exp][act] ?? 0) + 1;
  }
  const perCategory: Record<string, { precision: number; recall: number; f1: number }> = {};
  for (const cat of categories) {
    const tp = matrix[cat]?.[cat] ?? 0;
    const col = Object.values(matrix).reduce((s, row) => s + (row[cat] ?? 0), 0);
    const row = Object.values(matrix[cat] ?? {}).reduce((s, v) => s + v, 0);
    perCategory[cat] = prf(tp, col - tp, row - tp);
  }
  return { matrix, perCategory };
}
