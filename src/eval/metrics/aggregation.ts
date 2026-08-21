// Phase 51.6：Evaluation Telemetry 增量聚合。
export interface EvaluationTelemetryRecord {
  id: string;
  timestamp: string;
  projectId: string;
  model: string;
  benchmark: string;
  score: number;
  latencyMs: number;
  cost: number;
  success: boolean;
}

export type AggregationDimension = 'hourly' | 'daily' | 'project' | 'model' | 'benchmark';

interface MutableAggregate {
  count: number;
  scoreSum: number;
  costSum: number;
  failures: number;
  latencyHistogram: Map<number, number>;
}

export interface AggregatedMetric {
  dimension: AggregationDimension;
  key: string;
  count: number;
  averageScore: number;
  p95LatencyMs: number;
  cost: number;
  failures: number;
  failureRate: number;
}

export class EvaluationMetricsAggregator {
  private readonly buckets = new Map<AggregationDimension, Map<string, MutableAggregate>>();
  private readonly ingestedIds = new Set<string>();

  constructor() {
    for (const dimension of ['hourly', 'daily', 'project', 'model', 'benchmark'] as const) this.buckets.set(dimension, new Map());
  }

  /** 幂等增量写入；Dashboard query 不需要读取 raw telemetry。 */
  ingest(record: EvaluationTelemetryRecord): boolean {
    if (this.ingestedIds.has(record.id)) return false;
    validate(record);
    this.ingestedIds.add(record.id);
    const date = new Date(record.timestamp);
    const keys: Record<AggregationDimension, string> = {
      hourly: `${date.toISOString().slice(0, 13)}:00:00.000Z`,
      daily: date.toISOString().slice(0, 10),
      project: record.projectId,
      model: record.model,
      benchmark: record.benchmark,
    };
    for (const [dimension, key] of Object.entries(keys) as Array<[AggregationDimension, string]>) {
      const map = this.buckets.get(dimension)!;
      const bucket = map.get(key) ?? { count: 0, scoreSum: 0, costSum: 0, failures: 0, latencyHistogram: new Map() };
      bucket.count += 1;
      bucket.scoreSum += record.score;
      bucket.costSum += record.cost;
      if (!record.success) bucket.failures += 1;
      bucket.latencyHistogram.set(record.latencyMs, (bucket.latencyHistogram.get(record.latencyMs) ?? 0) + 1);
      map.set(key, bucket);
    }
    return true;
  }

  ingestMany(records: EvaluationTelemetryRecord[]): number {
    return records.reduce((count, record) => count + Number(this.ingest(record)), 0);
  }

  query(dimension: AggregationDimension, key?: string): AggregatedMetric[] {
    const entries = [...this.buckets.get(dimension)!.entries()]
      .filter(([bucketKey]) => !key || bucketKey === key)
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([bucketKey, bucket]) => ({
      dimension,
      key: bucketKey,
      count: bucket.count,
      averageScore: round6(bucket.scoreSum / bucket.count),
      p95LatencyMs: percentileHistogram(bucket.latencyHistogram, bucket.count, 0.95),
      cost: round6(bucket.costSum),
      failures: bucket.failures,
      failureRate: round6(bucket.failures / bucket.count),
    }));
  }

  get recordCount(): number {
    return this.ingestedIds.size;
  }
}

export function aggregateRaw(records: EvaluationTelemetryRecord[]): EvaluationMetricsAggregator {
  const aggregator = new EvaluationMetricsAggregator();
  aggregator.ingestMany(records);
  return aggregator;
}

function percentileHistogram(histogram: Map<number, number>, total: number, quantile: number): number {
  const target = Math.max(1, Math.ceil(total * quantile));
  let seen = 0;
  for (const [latency, count] of [...histogram].sort(([a], [b]) => a - b)) {
    seen += count;
    if (seen >= target) return latency;
  }
  return 0;
}

function validate(record: EvaluationTelemetryRecord): void {
  if (!record.id || !record.projectId || !record.model || !record.benchmark) throw new Error('Telemetry aggregation key 缺失');
  if (Number.isNaN(Date.parse(record.timestamp))) throw new Error(`Telemetry timestamp 非法：${record.timestamp}`);
  for (const [key, value] of Object.entries({ score: record.score, latencyMs: record.latencyMs, cost: record.cost })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Telemetry ${key} 非法`);
  }
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
