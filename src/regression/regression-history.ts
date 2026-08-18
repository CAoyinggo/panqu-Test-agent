// Regression History：回归历史（Phase 21.3）
// 职责：以 runId 为主键记录每次回归运行，支持查询与趋势统计，JSON 持久化。

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/fs-utils.js';
import type { RegressionRun } from './regression-schema.js';

export class RegressionHistory {
  private readonly runs: RegressionRun[] = [];

  /** 记录一次回归运行（runId 重复则覆盖，保证幂等） */
  record(run: RegressionRun): RegressionRun {
    const idx = this.runs.findIndex((r) => r.runId === run.runId);
    if (idx >= 0) this.runs[idx] = run;
    else this.runs.push(run);
    return run;
  }

  get(runId: string): RegressionRun | null {
    return this.runs.find((r) => r.runId === runId) ?? null;
  }

  /** 查询运行记录（feature / trigger / 状态过滤，时间倒序） */
  query(filter: { feature?: string; trigger?: string; status?: string; limit?: number } = {}): RegressionRun[] {
    let result = this.runs.filter((r) => {
      if (filter.feature && r.feature !== filter.feature) return false;
      if (filter.trigger && r.trigger !== filter.trigger) return false;
      if (filter.status && r.status !== filter.status) return false;
      return true;
    });
    result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (filter.limit && filter.limit > 0) result = result.slice(0, filter.limit);
    return result;
  }

  /** runId 追踪链：一次运行的失败 → RCA / Defect 映射 */
  failureChain(runId: string): Array<{ caseId: string; rcaId?: string; defectId?: string }> {
    return this.get(runId)?.failures ?? [];
  }

  /** 趋势统计：最近 limit 次运行的通过率与状态分布 */
  trend(feature?: string, limit = 10): { runs: number; passRate: number; statusCounts: Record<string, number> } {
    const recent = this.query({ feature, limit });
    const statusCounts: Record<string, number> = {};
    for (const r of recent) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    const passRate = recent.length
      ? Math.round((recent.reduce((sum, r) => sum + r.passRate, 0) / recent.length) * 1000) / 1000
      : 0;
    return { runs: recent.length, passRate, statusCounts };
  }

  size(): number {
    return this.runs.length;
  }

  save(file: string): void {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ runs: this.runs }, null, 2), 'utf-8');
  }

  static load(file: string): RegressionHistory {
    const history = new RegressionHistory();
    try {
      if (!fs.existsSync(file)) return history;
      const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { runs?: RegressionRun[] };
      for (const run of data.runs ?? []) history.runs.push(run);
    } catch {
      // 文件损坏：返回空历史
    }
    return history;
  }
}

export function createRegressionHistory(): RegressionHistory {
  return new RegressionHistory();
}
