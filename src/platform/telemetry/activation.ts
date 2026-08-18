// Metric Activation Tracker（Phase 25.5）：tracked=false 指标按真实遥测自动激活
// 任一真实样本写入对应遥测通道（LLM 成本 / RCA 验证 / Flaky 运行 / Healing 决策 / 执行）
// 时，自动标记该指标为 activated=true，记录首次激活时间 / 最近样本时间 / 累计采样数。
// 未激活指标保持 activated=false（绝不虚构）。

import type { Repository } from '../storage/index.js';

/** 平台可激活的遥测驱动指标 */
export type TrackedMetric = 'cost' | 'rcaAccuracy' | 'flakyRate' | 'healingRate' | 'execution';

/** 激活状态记录（id = metric 名） */
export interface MetricActivationRecord {
  id: string;
  metric: TrackedMetric;
  activated: boolean;
  firstActivatedAt: string | null;
  lastSampleAt: string | null;
  sampleCount: number;
}

export const ALL_TRACKED_METRICS: readonly TrackedMetric[] = ['cost', 'rcaAccuracy', 'flakyRate', 'healingRate', 'execution'];

/** 激活跟踪器：基于 Repository<T> 持久化（同平台存储后端） */
export class MetricActivationTracker {
  constructor(
    private readonly repo: Repository<MetricActivationRecord>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** 记录一个真实样本并自动激活对应指标（幂等） */
  async mark(metric: TrackedMetric): Promise<MetricActivationRecord> {
    const ts = this.now();
    const existing = await this.repo.get(metric);
    if (!existing) {
      const rec: MetricActivationRecord = {
        id: metric, metric, activated: true, firstActivatedAt: ts, lastSampleAt: ts, sampleCount: 1,
      };
      await this.repo.create(rec);
      return rec;
    }
    await this.repo.update(metric, { activated: true, lastSampleAt: ts, sampleCount: existing.sampleCount + 1 });
    return (await this.repo.get(metric)) as MetricActivationRecord;
  }

  /** 查询单个指标激活状态（未记录 = 未激活） */
  async status(metric: TrackedMetric): Promise<MetricActivationRecord | undefined> {
    return (await this.repo.get(metric)) ?? undefined;
  }

  /** 列出全部平台指标的激活状态（未激活指标也返回 activated=false） */
  async list(): Promise<MetricActivationRecord[]> {
    const all = await this.repo.query({});
    const byId = new Map(all.map((r) => [r.id, r]));
    return ALL_TRACKED_METRICS.map((m) => byId.get(m) ?? {
      id: m, metric: m, activated: false, firstActivatedAt: null, lastSampleAt: null, sampleCount: 0,
    });
  }

  /** 已激活指标数（可用于报表/健康检查） */
  async activeCount(): Promise<number> {
    const all = await this.list();
    return all.filter((r) => r.activated).length;
  }
}
