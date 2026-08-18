// Flaky Analyzer：确定性 Flaky 统计分析（Phase 13）
// Deterministic First：flakiness_index 与分类由规则引擎计算（任务书第 21 节），AI 只做解释。
import { RunRecord, FlakyAnalysis, FlakyCaseRecord, FlakyStatus, buildFlakyAnalysis } from './flaky-schema.js';

/** 分析输入 */
export interface FlakyAnalyzerInput {
  feature?: string;
  /** 历史运行记录（多次运行，按 caseId 聚合） */
  runs: RunRecord[];
}

/**
 * 计算单用例 flakiness_index（0~1）：
 * 二进制通过/失败结果中，通过率越接近 50% 波动越大。
 * index = 1 - |passRate - 0.5| * 2（0=全过或全挂，1=五五开）。
 */
export function computeFlakinessIndex(passRate: number): number {
  const r = Math.max(0, Math.min(1, passRate));
  return Math.round((1 - Math.abs(r - 0.5) * 2) * 100) / 100;
}

/** 按通过率分类（优先 STABLE/BROKEN，其次 FLAKY/UNSTABLE） */
export function classifyStatus(passRate: number, runs: number): FlakyStatus {
  if (runs <= 0) return 'STABLE';
  if (passRate >= 0.95) return 'STABLE';
  if (passRate <= 0.05) return 'BROKEN';
  // 明显混合区间 → FLAKY；边缘波动（偶尔翻转）→ UNSTABLE
  if (passRate >= 0.25 && passRate <= 0.75) return 'FLAKY';
  return 'UNSTABLE';
}

/** 环境相关性：失败是否集中于特定环境 */
function detectEnvironmentCorrelation(failedRuns: RunRecord[]): boolean {
  const byEnv = new Map<string, number>();
  let total = 0;
  for (const r of failedRuns) {
    if (!r.environment) continue;
    total++;
    byEnv.set(r.environment, (byEnv.get(r.environment) ?? 0) + 1);
  }
  if (total < 2) return false;
  return Math.max(...byEnv.values()) === total; // 所有失败集中于同一环境
}

/** 重试相关性：失败多发生于非重试运行（重试前失败，重试后通过） */
function detectRetryCorrelation(failedRuns: RunRecord[]): boolean {
  const nonRetry = failedRuns.filter((r) => r.isRetry !== true).length;
  return failedRuns.length > 1 && nonRetry === failedRuns.length;
}

/** 确定性 Flaky 分析：按 caseId 聚合多次运行并分类 */
export function analyzeFlakiness(input: FlakyAnalyzerInput): FlakyAnalysis {
  const runs = input.runs ?? [];
  const byCase = new Map<string, RunRecord[]>();
  for (const r of runs) {
    if (!r.caseId) continue;
    const list = byCase.get(r.caseId) ?? [];
    list.push(r);
    byCase.set(r.caseId, list);
  }

  const records: FlakyCaseRecord[] = [];
  for (const [caseId, list] of byCase) {
    const name = list.find((r) => r.name)?.name;
    const passes = list.filter((r) => r.pass).length;
    const failures = list.length - passes;
    const passRate = passes / list.length;
    const flakinessIndex = computeFlakinessIndex(passRate);
    const status = classifyStatus(passRate, list.length);
    const failedRuns = list.filter((r) => !r.pass).map((r) => ({
      at: r.at,
      error: r.error,
      environment: r.environment,
      isRetry: r.isRetry,
    }));
    records.push({
      caseId,
      name,
      runs: list.length,
      passes,
      failures,
      passRate: Math.round(passRate * 1000) / 10,
      flakinessIndex,
      status,
      failedRuns,
      environmentCorrelation: detectEnvironmentCorrelation(list.filter((r) => !r.pass)),
      retryCorrelation: detectRetryCorrelation(list.filter((r) => !r.pass)),
      quarantine: status === 'FLAKY' || status === 'UNSTABLE',
    });
  }

  // 稳定排序：flaky 优先展示
  records.sort((a, b) => b.flakinessIndex - a.flakinessIndex);

  return buildFlakyAnalysis({
    feature: input.feature ?? 'default',
    records,
    source: 'rules',
  });
}
