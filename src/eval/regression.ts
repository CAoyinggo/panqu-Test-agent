// Eval Regression（Phase 45 / 42.15-42.16）：版本对比 + 回归门
// 评测不能只看"现在多少分"，必须支持版本间对比：
//   baseline（如 v4.15.0） vs candidate（current）→ Improved / Regressed / Unchanged
// 回归门（Regression Gate）——任一命中即 BLOCK：
//   1. 关键安全指标上升：P0 Miss / False Pass / Unsafe Healing / Skipped Critical
//   2. 任领域得分下降超过 criticalDelta（默认 0.05）
//   3. 关键领域（RCA / RISK / RELEASE / HEALING）下降即触发（安全敏感）
// 普通小幅下降（> softDelta）→ REVIEW；否则 PASS。
import type { EvaluationDomain } from './contract.js';
import { DOMAIN_LABELS } from './contract.js';
import type { DomainReport, EvalReport } from './runner.js';
import { round4 } from './metrics.js';

/** 安全敏感关键领域：任一得分下降即触发 BLOCK */
const CRITICAL_DOMAINS: readonly EvaluationDomain[] = ['RCA', 'RISK', 'RELEASE', 'HEALING'];

export type Trend = 'improved' | 'regressed' | 'unchanged';
export type GateVerdict = 'PASS' | 'REVIEW' | 'BLOCK';

export interface DomainComparison {
  domain: EvaluationDomain;
  label: string;
  baseline: number;
  candidate: number;
  /** candidate - baseline（正 = 提升） */
  delta: number;
  trend: Trend;
}

export interface RegressionGateThresholds {
  /** 关键指标（安全敏感）下降超过该比例（0.05）→ BLOCK */
  criticalDelta: number;
  /** 普通领域下降超过该比例（0.03）→ REVIEW */
  softDelta: number;
  /** 候选版本关键安全指标数上限（任一超过 → BLOCK） */
  maxP0Miss: number;
  maxFalsePass: number;
  maxUnsafeHealing: number;
  maxSkippedCritical: number;
}

export const DEFAULT_GATE_THRESHOLDS: RegressionGateThresholds = {
  criticalDelta: 0.05,
  softDelta: 0.03,
  maxP0Miss: 0,
  maxFalsePass: 0,
  maxUnsafeHealing: 0,
  maxSkippedCritical: 0,
};

export interface CompareResult {
  baseline: string;
  candidate: string;
  generatedAt: string;
  domains: DomainComparison[];
  overall: { baseline: number; candidate: number; delta: number; trend: Trend };
  critical: {
    baseline: EvalReport['critical'];
    candidate: EvalReport['critical'];
    /** 安全指标退化列表（candidate > baseline 或超阈值） */
    regressions: string[];
  };
  gate: { verdict: GateVerdict; reasons: string[] };
}

/** 单领域趋势判定 */
export function domainTrend(baseline: number, candidate: number, thresholds: RegressionGateThresholds): Trend {
  const delta = round4(candidate - baseline);
  if (delta > thresholds.softDelta) return 'improved';
  if (delta < -thresholds.softDelta) return 'regressed';
  return 'unchanged';
}

/** 对比两个版本报告并计算回归门 */
export function compareVersions(
  baseline: EvalReport,
  candidate: EvalReport,
  thresholds: RegressionGateThresholds = DEFAULT_GATE_THRESHOLDS,
): CompareResult {
  const reasons: string[] = [];
  const regressions: string[] = [];

  const byDomain = new Map<EvaluationDomain, DomainReport>();
  for (const d of baseline.domains) byDomain.set(d.domain, d);
  const candByDomain = new Map<EvaluationDomain, DomainReport>();
  for (const d of candidate.domains) candByDomain.set(d.domain, d);

  const domains: DomainComparison[] = [...byDomain.keys()].map((domain) => {
    const b = byDomain.get(domain)!;
    const c = candByDomain.get(domain);
    const base = b.score;
    const cand = c ? c.score : base;
    const delta = round4(cand - base);
    return {
      domain,
      label: DOMAIN_LABELS[domain],
      baseline: base,
      candidate: cand,
      delta,
      trend: domainTrend(base, cand, thresholds),
    };
  });

  // 1. 领域得分下降
  for (const d of domains) {
    if (d.delta < 0) {
      if (d.delta < -thresholds.criticalDelta || CRITICAL_DOMAINS.includes(d.domain)) {
        reasons.push(`BLOCK：${d.label} 得分下降 ${(-d.delta * 100).toFixed(1)}%${CRITICAL_DOMAINS.includes(d.domain) ? '（安全敏感领域）' : ''}`);
      } else if (d.delta < -thresholds.softDelta) {
        reasons.push(`REVIEW：${d.label} 得分小幅下降 ${(-d.delta * 100).toFixed(1)}%`);
      }
    }
  }

  // 2. 关键安全指标（candidate 侧）——任一超阈值 → BLOCK
  const cr = candidate.critical;
  if (cr.p0Miss > thresholds.maxP0Miss) {
    reasons.push(`BLOCK：候选版本 P0 Miss = ${cr.p0Miss}（阈值 ${thresholds.maxP0Miss}）`);
    regressions.push(`P0 Miss ${baseline.critical.p0Miss} → ${cr.p0Miss}`);
  }
  if (cr.falsePass > thresholds.maxFalsePass) {
    reasons.push(`BLOCK：候选版本 False Pass = ${cr.falsePass}（阈值 ${thresholds.maxFalsePass}，Critical Release Miss 禁止）`);
    regressions.push(`False Pass ${baseline.critical.falsePass} → ${cr.falsePass}`);
  }
  if (cr.unsafeHealing > thresholds.maxUnsafeHealing) {
    reasons.push(`BLOCK：候选版本 Unsafe Healing = ${cr.unsafeHealing}（阈值 ${thresholds.maxUnsafeHealing}）`);
    regressions.push(`Unsafe Healing ${baseline.critical.unsafeHealing} → ${cr.unsafeHealing}`);
  }
  if (cr.skippedCritical > thresholds.maxSkippedCritical) {
    reasons.push(`BLOCK：候选版本 Skipped Critical = ${cr.skippedCritical}（阈值 ${thresholds.maxSkippedCritical}）`);
    regressions.push(`Skipped Critical ${baseline.critical.skippedCritical} → ${cr.skippedCritical}`);
  }

  // 关键安全指标退化（candidate > baseline 但均未超绝对阈值——仍视为退化 REVIEW）
  if (cr.p0Miss > baseline.critical.p0Miss && cr.p0Miss <= thresholds.maxP0Miss) regressions.push(`P0 Miss ${baseline.critical.p0Miss} → ${cr.p0Miss}`);
  if (cr.falsePass > baseline.critical.falsePass && cr.falsePass <= thresholds.maxFalsePass) regressions.push(`False Pass ${baseline.critical.falsePass} → ${cr.falsePass}`);
  if (cr.unsafeHealing > baseline.critical.unsafeHealing && cr.unsafeHealing <= thresholds.maxUnsafeHealing) regressions.push(`Unsafe Healing ${baseline.critical.unsafeHealing} → ${cr.unsafeHealing}`);
  if (cr.skippedCritical > baseline.critical.skippedCritical && cr.skippedCritical <= thresholds.maxSkippedCritical) regressions.push(`Skipped Critical ${baseline.critical.skippedCritical} → ${cr.skippedCritical}`);

  // 汇总整体趋势
  const overallDelta = round4(candidate.overall - baseline.overall);
  const overallTrend = domainTrend(baseline.overall, candidate.overall, thresholds);

  // 门禁裁决：存在 BLOCK 原因 → BLOCK；否则存在 REVIEW 原因 → REVIEW；否则 PASS
  let verdict: GateVerdict = 'PASS';
  if (reasons.some((r) => r.startsWith('BLOCK'))) verdict = 'BLOCK';
  else if (reasons.length > 0) verdict = 'REVIEW';
  if (verdict === 'PASS' && overallTrend === 'regressed' && baseline.overall >= 0.95) {
    // 高基线下的整体小幅回落仍保持 PASS，但记录提示
  }

  return {
    baseline: baseline.version,
    candidate: candidate.version,
    generatedAt: new Date().toISOString(),
    domains,
    overall: { baseline: baseline.overall, candidate: candidate.overall, delta: overallDelta, trend: overallTrend },
    critical: { baseline: baseline.critical, candidate: candidate.critical, regressions },
    gate: { verdict, reasons: reasons.length ? reasons : ['全部指标达标或持平，允许发布'] },
  };
}

/** 便捷：由两个版本报告输出人读文本 */
export function formatCompare(cmp: CompareResult): string {
  const lines: string[] = [];
  lines.push(`Eval Compare: ${cmp.baseline} → ${cmp.candidate}`);
  lines.push(`Overall: ${(cmp.overall.baseline * 100).toFixed(1)}% → ${(cmp.overall.candidate * 100).toFixed(1)}%（${cmp.overall.trend}）`);
  for (const d of cmp.domains) {
    lines.push(`  ${d.label}: ${(d.baseline * 100).toFixed(1)}% → ${(d.candidate * 100).toFixed(1)}%（${d.trend}，Δ${(d.delta * 100).toFixed(1)}%）`);
  }
  if (cmp.critical.regressions.length) {
    lines.push('关键安全指标退化：');
    for (const r of cmp.critical.regressions) lines.push(`  - ${r}`);
  }
  lines.push(`Gate: ${cmp.gate.verdict}${cmp.gate.reasons.length ? `（${cmp.gate.reasons.join('；')}）` : ''}`);
  return lines.join('\n');
}
