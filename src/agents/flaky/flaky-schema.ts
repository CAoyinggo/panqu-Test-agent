// Flaky Schema：Flaky Test 数据模型 + 归一化（Phase 13 分析侧）
// 定位：通过率 / 失败时间分布 / 环境相关性 / 并发相关性 / 重试相关性 / 历史执行结果
// 计算 flakiness_index，分类 STABLE / FLAKY / UNSTABLE / BROKEN。
// Flaky Case 不能简单计入产品失败：识别 → 隔离 → 降低可信度。

/** Flaky 分类 */
export type FlakyStatus = 'STABLE' | 'FLAKY' | 'UNSTABLE' | 'BROKEN';

/** 单次运行记录 */
export interface RunRecord {
  /** 用例 ID */
  caseId: string;
  name?: string;
  pass: boolean;
  timedOut?: boolean;
  error?: string;
  /** 运行时间点（ISO 字符串或任意可排序字符串） */
  at?: string;
  /** 运行环境（可选，用于环境相关性） */
  environment?: string;
  /** 是否重试运行（可选，用于重试相关性） */
  isRetry?: boolean;
  /** 运行批次（可选，用于并发相关性：同一批次 = 并发运行） */
  batch?: string;
}

/** 单用例 Flaky 分析 */
export interface FlakyCaseRecord {
  caseId: string;
  name?: string;
  /** 运行次数 */
  runs: number;
  /** 通过次数 */
  passes: number;
  /** 失败次数 */
  failures: number;
  /** 通过率 0~100 */
  passRate: number;
  /** 波动指数 0~1：越高越不稳定（0=全过或全挂，1=五五开） */
  flakinessIndex: number;
  /** 分类 */
  status: FlakyStatus;
  /** 失败运行明细 */
  failedRuns: Array<{ at?: string; error?: string; environment?: string; isRetry?: boolean }>;
  /** 环境相关性（仅提供环境信息时计算）：失败是否集中于特定环境 */
  environmentCorrelation?: boolean;
  /** 重试相关性：失败是否多发生于重试前 */
  retryCorrelation?: boolean;
  tags?: string[];
  /** 是否建议隔离（FLAKY/UNSTABLE 为 true） */
  quarantine: boolean;
}

/** Flaky 汇总 */
export interface FlakyAnalysis {
  feature: string;
  /** 参与统计的用例数 */
  total: number;
  records: FlakyCaseRecord[];
  /** FLAKY 用例 ID 集合 */
  flakyCaseIds: string[];
  /** UNSTABLE 用例 ID 集合 */
  unstableCaseIds: string[];
  /** BROKEN 用例 ID 集合 */
  brokenCaseIds: string[];
  /** 需要隔离的用例 ID（flaky + unstable） */
  quarantineIds: string[];
  /** 一句话汇总 */
  summary: string;
  source?: string;
}

/** 判断数据是否「像 FlakyAnalysis」 */
export function isFlakyLike(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === 'object' && data !== null
    && typeof (data as Record<string, unknown>).feature === 'string'
    && Array.isArray((data as Record<string, unknown>).records)
  );
}

/** 同步形态构建 */
export function buildFlakyAnalysis(partial: Partial<FlakyAnalysis> & { feature: string; records: FlakyCaseRecord[] }): FlakyAnalysis {
  const records = partial.records;
  const flaky = records.filter((r) => r.status === 'FLAKY').map((r) => r.caseId);
  const unstable = records.filter((r) => r.status === 'UNSTABLE').map((r) => r.caseId);
  const broken = records.filter((r) => r.status === 'BROKEN').map((r) => r.caseId);
  return {
    feature: partial.feature,
    total: records.length,
    records,
    flakyCaseIds: flaky,
    unstableCaseIds: unstable,
    brokenCaseIds: broken,
    quarantineIds: [...flaky, ...unstable],
    summary: partial.summary ?? `共 ${records.length} 个用例：稳定 ${records.filter((r) => r.status === 'STABLE').length}，flaky ${flaky.length}，不稳定 ${unstable.length}，broken ${broken.length}`,
    source: partial.source,
  };
}

/** 归一化外部产出的 FlakyAnalysis（过滤非法记录） */
export function normalizeFlakyAnalysis(data: Record<string, unknown>): FlakyAnalysis {
  const records = (Array.isArray(data.records) ? data.records : [])
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({
      caseId: String(r.caseId ?? ''),
      name: r.name !== undefined ? String(r.name) : undefined,
      runs: typeof r.runs === 'number' ? r.runs : 0,
      passes: typeof r.passes === 'number' ? r.passes : 0,
      failures: typeof r.failures === 'number' ? r.failures : 0,
      passRate: typeof r.passRate === 'number' ? r.passRate : 0,
      flakinessIndex: typeof r.flakinessIndex === 'number' ? r.flakinessIndex : 0,
      status: ['STABLE', 'FLAKY', 'UNSTABLE', 'BROKEN'].includes(String(r.status)) ? String(r.status) as FlakyStatus : 'STABLE',
      failedRuns: Array.isArray(r.failedRuns) ? r.failedRuns as FlakyCaseRecord['failedRuns'] : [],
      environmentCorrelation: r.environmentCorrelation === true,
      retryCorrelation: r.retryCorrelation === true,
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      quarantine: r.quarantine === true,
    }))
    .filter((r) => r.caseId.length > 0);
  return buildFlakyAnalysis({ feature: String(data.feature ?? ''), records, source: data.source !== undefined ? String(data.source) : undefined });
}
