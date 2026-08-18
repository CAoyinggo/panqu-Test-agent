// Quality Tracker：质量记录与多维趋势（Phase 21.7）
// Test Quality Score → Feature Quality Score；
// 趋势维度：日 / 周 / 版本 / Feature / Model / Environment。

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/fs-utils.js';
import {
  computeTestQualityScore,
  gradeOf,
  generateQualityId,
  normalizeCreateQualityInput,
  type QualityRecord,
} from './quality-schema.js';

/** 趋势点 */
export interface TrendPoint {
  key: string;
  count: number;
  avgScore: number;
}

/** 趋势维度 */
export type TrendDimension = 'day' | 'week' | 'version' | 'feature' | 'model' | 'environment';

export class QualityTracker {
  private readonly records = new Map<string, QualityRecord>();

  /** 记录一轮质量评估（自动计算得分与等级） */
  record(input: unknown): QualityRecord {
    const norm = normalizeCreateQualityInput(input);
    const { score, dimensions } = computeTestQualityScore(norm.metrics);
    const record: QualityRecord = {
      id: norm.id ?? generateQualityId(),
      scope: norm.scope ?? 'test',
      feature: norm.feature,
      score,
      grade: gradeOf(score),
      dimensions,
      metrics: norm.metrics,
      timestamp: norm.timestamp ?? new Date().toISOString(),
    };
    if (norm.version) record.version = norm.version;
    if (norm.model) record.model = norm.model;
    if (norm.environment) record.environment = norm.environment;
    this.records.set(record.id, record);
    return record;
  }

  get(id: string): QualityRecord | null {
    return this.records.get(id) ?? null;
  }

  /** 过滤记录 */
  list(filter: Partial<{ feature: string; scope: 'test' | 'feature'; version: string; model: string; environment: string }> = {}): QualityRecord[] {
    return [...this.records.values()]
      .filter((r) => {
        if (filter.feature && r.feature !== filter.feature) return false;
        if (filter.scope && r.scope !== filter.scope) return false;
        if (filter.version && r.version !== filter.version) return false;
        if (filter.model && r.model !== filter.model) return false;
        if (filter.environment && r.environment !== filter.environment) return false;
        return true;
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /** Feature Quality Score：该 feature 最新一条记录的得分 */
  featureScore(feature: string): QualityRecord | null {
    const list = this.list({ feature });
    return list.length > 0 ? list[list.length - 1] : null;
  }

  /**
   * 多维趋势：按 day / week / version / feature / model / environment 分组，
   * 返回每组的记录数与平均分（按 key 升序）。
   */
  trend(by: TrendDimension, filter: Partial<{ feature: string; model: string; environment: string }> = {}): TrendPoint[] {
    const groups = new Map<string, number[]>();
    for (const r of this.list(filter)) {
      const key = this.trendKey(r, by);
      if (!key) continue;
      const list = groups.get(key) ?? [];
      list.push(r.score);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([key, scores]) => ({
        key,
        count: scores.length,
        avgScore: Math.round((scores.reduce((s, x) => s + x, 0) / scores.length) * 10) / 10,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  private trendKey(r: QualityRecord, by: TrendDimension): string | null {
    switch (by) {
      case 'day':
        return r.timestamp.slice(0, 10);
      case 'week':
        return isoWeekOf(r.timestamp);
      case 'version':
        return r.version ?? null;
      case 'feature':
        return r.feature;
      case 'model':
        return r.model ?? null;
      case 'environment':
        return r.environment ?? null;
    }
  }

  save(file: string): void {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ records: [...this.records.values()] }, null, 2), 'utf-8');
  }

  static load(file: string): QualityTracker {
    const tracker = new QualityTracker();
    try {
      if (!fs.existsSync(file)) return tracker;
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf-8')) as { records?: QualityRecord[] };
      for (const r of snapshot.records ?? []) tracker.records.set(r.id, r);
    } catch {
      // 文件损坏：返回空记录
    }
    return tracker;
  }
}

export function createQualityTracker(): QualityTracker {
  return new QualityTracker();
}

/** ISO 周：YYYY-Wnn */
function isoWeekOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
