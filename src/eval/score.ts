// Score 工具（Phase 45）：统一得分规约
// - score 为 0~1；roundScore 统一截断到 4 位小数，避免浮点噪声。
// - isPassed 由 contract 统一导出（默认阈值 0.9）。
import { isPassed, DEFAULT_PASS_THRESHOLD } from './contract.js';

export { isPassed, DEFAULT_PASS_THRESHOLD };

/** 截断到 4 位小数（统一得分精度） */
export function roundScore(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** 分数差（用于版本对比 / 回归门），避免浮点误差 */
export function scoreDelta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return roundScore(a - b);
}
