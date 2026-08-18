// Defect Lifecycle Tracker：缺陷生命周期跟踪器（Phase 21.4）
// 能力：摄入 Draft / 状态迁移（合法性校验 + 历史日志）/ 处置（Known Issue / Duplicate /
// Won't Fix / Fixed）/ 回归验证（通过 → VERIFIED，失败 → 重开）/ processFailure 端到端
// （失败 → 搜索历史 → 重复判定 → 关联已有 Bug 或创建新 DRAFT）/ JSON 持久化。

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/fs-utils.js';
import {
  canTransition,
  normalizeIngestInput,
  type DefectRecord,
  type DefectResolution,
  type DefectStatus,
  type IngestDefectInput,
} from './lifecycle-schema.js';
import { buildFailureSignature, detectDuplicate, type DuplicateVerdict, type FailureReport } from './duplicate-detector.js';

/** processFailure 结果 */
export interface ProcessFailureResult {
  /** 是否为重复问题 */
  duplicate: boolean;
  /** 关联到的已有 Bug id（重复时）或新建 Bug id */
  defectId: string;
  /** 重复判定详情 */
  verdict: DuplicateVerdict;
}

export class DefectLifecycleTracker {
  private readonly records = new Map<string, DefectRecord>();
  private seq = 0;

  /** 摄入 Draft → DRAFT 记录（id 重复抛错） */
  ingest(input: unknown): DefectRecord {
    const norm = normalizeIngestInput(input);
    const id = norm.id ?? this.nextId(norm.feature);
    if (this.records.has(id)) throw new Error(`Defect 摄入失败：${id} 已存在`);
    const now = new Date().toISOString();
    const record: DefectRecord = {
      id,
      feature: norm.feature,
      title: norm.title,
      severity: norm.severity ?? 'P2',
      status: 'DRAFT',
      relatedCases: norm.relatedCases ?? [],
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    if (norm.failureSignature) record.failureSignature = norm.failureSignature;
    if (norm.category) record.category = norm.category;
    this.records.set(id, record);
    return record;
  }

  private nextId(feature: string): string {
    this.seq += 1;
    return `def-${feature.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 16)}-${String(this.seq).padStart(4, '0')}`;
  }

  get(id: string): DefectRecord | null {
    return this.records.get(id) ?? null;
  }

  /** 状态迁移：非法迁移抛错，历史日志记录 */
  transition(id: string, to: DefectStatus, note?: string): DefectRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Defect 迁移失败：${id} 不存在`);
    if (!canTransition(record.status, to)) {
      throw new Error(`Defect 迁移失败：${record.status} → ${to} 不合法`);
    }
    record.history.push({ from: record.status, to, at: new Date().toISOString(), note });
    record.status = to;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  /**
   * 处置结论：
   *   - KNOWN_ISSUE / DUPLICATE / WONT_FIX → CLOSED（duplicateOf 记录关联 Bug）
   *   - FIXED → FIXED 状态（等待回归验证）
   */
  resolve(id: string, resolution: DefectResolution, opts: { note?: string; duplicateOf?: string } = {}): DefectRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Defect 处置失败：${id} 不存在`);
    if (resolution === 'FIXED') {
      if (record.status !== 'FIXING') {
        throw new Error(`Defect 处置失败：FIXED 仅允许从 FIXING 迁移（当前 ${record.status}）`);
      }
      record.resolution = 'FIXED';
      return this.transition(id, 'FIXED', opts.note ?? '标记修复');
    }
    if (resolution === 'REGRESSION_FAILED') {
      throw new Error('Defect 处置失败：REGRESSION_FAILED 请使用 regressionResult()');
    }
    record.resolution = resolution;
    if (resolution === 'DUPLICATE' && opts.duplicateOf) record.duplicateOf = opts.duplicateOf;
    return this.transition(id, 'CLOSED', opts.note ?? `处置：${resolution}`);
  }

  /** 修复后回归验证：通过 → VERIFIED；失败 → REGRESSION_FAILED 重开回 FIXING */
  regressionResult(id: string, pass: boolean, note?: string): DefectRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Defect 回归验证失败：${id} 不存在`);
    if (record.status !== 'REGRESSION') {
      throw new Error(`Defect 回归验证失败：仅 REGRESSION 状态可验证（当前 ${record.status}）`);
    }
    if (pass) {
      return this.transition(id, 'VERIFIED', note ?? '回归验证通过');
    }
    record.resolution = 'REGRESSION_FAILED';
    return this.transition(id, 'FIXING', note ?? '回归失败，重开');
  }

  /** 查询（状态 / 处置 / feature 过滤） */
  query(filter: { status?: DefectStatus; resolution?: DefectResolution; feature?: string } = {}): DefectRecord[] {
    return [...this.records.values()]
      .filter((r) => {
        if (filter.status && r.status !== filter.status) return false;
        if (filter.resolution && r.resolution !== filter.resolution) return false;
        if (filter.feature && r.feature !== filter.feature) return false;
        return true;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 已知问题清单（KNOWN_ISSUE 处置的缺陷） */
  knownIssues(): DefectRecord[] {
    return this.query({ resolution: 'KNOWN_ISSUE' });
  }

  size(): number {
    return this.records.size;
  }

  /**
   * 端到端：失败 → 搜索历史 Issue → 重复判定 → 关联已有 Bug 或创建新 DRAFT。
   * 重复时不创建新 Bug：把失败用例并入已有 Bug 的 relatedCases。
   */
  processFailure(failure: FailureReport): ProcessFailureResult {
    const history = [...this.records.values()];
    const verdict = detectDuplicate(failure, history);
    if (verdict.isDuplicate && verdict.match) {
      const existing = verdict.match;
      if (!existing.relatedCases.includes(failure.caseId)) {
        existing.relatedCases.push(failure.caseId);
        existing.updatedAt = new Date().toISOString();
      }
      return { duplicate: true, defectId: existing.id, verdict };
    }
    const input: IngestDefectInput = {
      feature: failure.feature,
      title: `[${failure.category ?? 'UNKNOWN'}] ${failure.caseId} 执行失败`,
      relatedCases: [failure.caseId],
      category: failure.category,
      failureSignature: buildFailureSignature(failure.error),
    };
    const record = this.ingest(input);
    return { duplicate: false, defectId: record.id, verdict };
  }

  save(file: string): void {
    ensureDir(path.dirname(file));
    const snapshot = { records: [...this.records.values()], seq: this.seq };
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  static load(file: string): DefectLifecycleTracker {
    const tracker = new DefectLifecycleTracker();
    try {
      if (!fs.existsSync(file)) return tracker;
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf-8')) as { records?: DefectRecord[]; seq?: number };
      for (const r of snapshot.records ?? []) tracker.records.set(r.id, r);
      tracker.seq = snapshot.seq ?? tracker.records.size;
    } catch {
      // 文件损坏：返回空跟踪器
    }
    return tracker;
  }
}

export function createDefectLifecycleTracker(): DefectLifecycleTracker {
  return new DefectLifecycleTracker();
}
