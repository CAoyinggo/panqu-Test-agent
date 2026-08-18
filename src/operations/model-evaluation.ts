// Model Evaluation：模型横向对比（Phase 21.8）
// 同一测试套件在 Model A/B/C 上执行，对比 Quality / Latency / Cost / Failure，
// 确定性归一化 + 等权综合评分，输出排名与推荐模型。

/** 单模型套件执行结果 */
export interface ModelRunResult {
  model: string;
  /** 测试质量分（0~100，越高越好） */
  qualityScore: number;
  /** 平均延迟 ms（越低越好） */
  latencyMs: number;
  /** 总成本（越低越好） */
  cost: number;
  /** 用例总数 */
  total: number;
  /** 通过数 */
  passed: number;
  /** 失败数 */
  failed: number;
}

/** 单模型对比行 */
export interface ModelComparisonRow {
  model: string;
  qualityScore: number;
  latencyMs: number;
  cost: number;
  failureRate: number;
  /** 各维度归一化得分 0~1（越高越好） */
  normalized: { quality: number; latency: number; cost: number; failure: number };
  /** 综合得分 0~100 */
  composite: number;
  rank: number;
}

/** 对比结论 */
export interface ModelComparison {
  rows: ModelComparisonRow[];
  /** 综合得分最高者（并列按模型名字典序） */
  winner: string | null;
  /** 各维度最优模型 */
  bestPerDimension: { quality: string | null; latency: string | null; cost: string | null; failure: string | null };
  summary: string;
}

/**
 * 横向对比：Quality/Latency/Cost/Failure 四维归一化（最优=1），等权综合。
 * 归一化：quality 除以最大值；latency/cost/failureRate 用「最小值 / 当前值」（越小越好）。
 * 全部同值时归一为 1（并列最优）。
 */
export function compareModels(results: ModelRunResult[]): ModelComparison {
  if (results.length === 0) {
    return { rows: [], winner: null, bestPerDimension: { quality: null, latency: null, cost: null, failure: null }, summary: '无对比数据' };
  }

  const failureRates = results.map((r) => (r.total > 0 ? r.failed / r.total : 0));
  const maxQuality = Math.max(...results.map((r) => r.qualityScore), 0);
  const minLatency = Math.min(...results.map((r) => r.latencyMs));
  const minCost = Math.min(...results.map((r) => r.cost));
  const minFailure = Math.min(...failureRates);

  const rows: ModelComparisonRow[] = results.map((r, i) => {
    const failureRate = failureRates[i];
    const normalized = {
      quality: maxQuality > 0 ? r.qualityScore / maxQuality : 1,
      latency: r.latencyMs > 0 ? minLatency / r.latencyMs : 1,
      cost: r.cost > 0 ? minCost / r.cost : 1,
      failure: failureRate > 0 ? minFailure / failureRate : 1,
    };
    const composite = Math.round(((normalized.quality + normalized.latency + normalized.cost + normalized.failure) / 4) * 1000) / 10;
    return {
      model: r.model,
      qualityScore: r.qualityScore,
      latencyMs: r.latencyMs,
      cost: r.cost,
      failureRate: Math.round(failureRate * 10000) / 10000,
      normalized: {
        quality: round4(normalized.quality),
        latency: round4(normalized.latency),
        cost: round4(normalized.cost),
        failure: round4(normalized.failure),
      },
      composite,
      rank: 0,
    };
  });

  // 排名：综合得分降序，同分按模型名字典序
  rows.sort((a, b) => b.composite - a.composite || a.model.localeCompare(b.model));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  const bestOf = (better: (a: ModelRunResult, b: ModelRunResult) => boolean): string | null => {
    if (results.length === 0) return null;
    let best = results[0];
    for (const r of results.slice(1)) if (better(r, best)) best = r;
    return best.model;
  };

  const bestPerDimension = {
    quality: bestOf((a, b) => a.qualityScore > b.qualityScore || (a.qualityScore === b.qualityScore && a.model < b.model)),
    latency: bestOf((a, b) => a.latencyMs < b.latencyMs || (a.latencyMs === b.latencyMs && a.model < b.model)),
    cost: bestOf((a, b) => a.cost < b.cost || (a.cost === b.cost && a.model < b.model)),
    failure: bestOf((a, b) => {
      const fa = a.total > 0 ? a.failed / a.total : 0;
      const fb = b.total > 0 ? b.failed / b.total : 0;
      return fa < fb || (fa === fb && a.model < b.model);
    }),
  };

  const winner = rows[0]?.model ?? null;
  const summary = winner
    ? `推荐模型 ${winner}（综合 ${rows[0].composite} 分）；` +
      `质量最优 ${bestPerDimension.quality}，延迟最优 ${bestPerDimension.latency}，` +
      `成本最优 ${bestPerDimension.cost}，失败率最优 ${bestPerDimension.failure}`
    : '无对比数据';

  return { rows, winner, bestPerDimension, summary };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
