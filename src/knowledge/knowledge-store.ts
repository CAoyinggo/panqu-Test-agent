// Knowledge Store：知识库（Phase 21.5）
// 能力：Knowledge Ranking（置信度 × 时效 × 使用频率）、Deduplication（同题合并）、
// Expiration（ACTIVE → STALE → EXPIRED）、Confidence（引用时微调）。
// 与 Memory 分工：Memory 存原始执行记录，KnowledgeStore 存提炼后的可决策知识。

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/fs-utils.js';
import {
  generateKnowledgeId,
  normalizeCreateKnowledgeInput,
  type CreateKnowledgeInput,
  type KnowledgeEntry,
  type KnowledgeStatus,
} from './knowledge-schema.js';

/** 生命周期配置 */
export interface KnowledgeLifecycleConfig {
  /** ACTIVE → STALE：超过 N 天未被引用（默认 30） */
  staleDays: number;
  /** STALE → EXPIRED：超过 N 天未被引用（默认 90） */
  expireDays: number;
}

export const DEFAULT_LIFECYCLE_CONFIG: KnowledgeLifecycleConfig = { staleDays: 30, expireDays: 90 };

const DAY_MS = 24 * 60 * 60 * 1000;

/** 生命周期流转记录 */
export interface LifecycleTransition {
  id: string;
  from: KnowledgeStatus;
  to: KnowledgeStatus;
  reason: string;
}

export class KnowledgeStore {
  private readonly entries = new Map<string, KnowledgeEntry>();

  constructor(private readonly lifecycle: KnowledgeLifecycleConfig = DEFAULT_LIFECYCLE_CONFIG) {}

  /**
   * 添加知识：同 feature + type + title 视为重复 → 合并
   * （usageCount 累加、confidence 取大、lastUsedAt 取新、stats 浅合并），
   * 避免知识越积越重复。
   */
  add(input: unknown): { entry: KnowledgeEntry; merged: boolean } {
    const norm = normalizeCreateKnowledgeInput(input);
    const existing = this.findDuplicate(norm);
    const now = new Date().toISOString();
    if (existing) {
      existing.usageCount += 1;
      existing.confidence = Math.max(existing.confidence, norm.confidence ?? 0);
      existing.lastUsedAt = now;
      existing.updatedAt = now;
      if (norm.content) existing.content = norm.content;
      if (norm.validUntil) existing.validUntil = norm.validUntil;
      if (norm.stats) existing.stats = { ...(existing.stats ?? {}), ...norm.stats };
      for (const tag of norm.tags ?? []) if (!existing.tags.includes(tag)) existing.tags.push(tag);
      if (existing.status === 'EXPIRED') existing.status = 'ACTIVE'; // 再次沉淀的知识复活
      return { entry: existing, merged: true };
    }
    const entry: KnowledgeEntry = {
      id: norm.id ?? generateKnowledgeId(norm.feature),
      type: norm.type,
      feature: norm.feature,
      title: norm.title,
      content: norm.content ?? '',
      confidence: norm.confidence ?? 0.5,
      usageCount: 0,
      source: norm.source ?? 'manual',
      status: 'ACTIVE',
      tags: norm.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    if (norm.validUntil) entry.validUntil = norm.validUntil;
    if (norm.stats) entry.stats = norm.stats;
    this.entries.set(entry.id, entry);
    return { entry, merged: false };
  }

  private findDuplicate(norm: CreateKnowledgeInput): KnowledgeEntry | null {
    for (const e of this.entries.values()) {
      if (e.feature === norm.feature && e.type === norm.type && e.title === norm.title) return e;
    }
    return null;
  }

  get(id: string): KnowledgeEntry | null {
    return this.entries.get(id) ?? null;
  }

  /** 查询（默认仅 ACTIVE；stale 含 STALE；all 全部） */
  query(filter: { feature?: string; type?: string; tags?: string[]; text?: string; scope?: 'active' | 'stale' | 'all' } = {}): KnowledgeEntry[] {
    const text = (filter.text ?? '').toLowerCase();
    return [...this.entries.values()]
      .filter((e) => {
        if (filter.scope === 'active' || !filter.scope) {
          if (e.status !== 'ACTIVE') return false;
        } else if (filter.scope === 'stale') {
          if (e.status === 'EXPIRED') return false;
        }
        if (filter.feature && e.feature !== filter.feature) return false;
        if (filter.type && e.type !== filter.type) return false;
        if (filter.tags?.length && !filter.tags.some((t) => e.tags.includes(t))) return false;
        if (text && !`${e.title} ${e.content} ${e.tags.join(' ')}`.toLowerCase().includes(text)) return false;
        return true;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Knowledge Ranking：综合得分 = confidence × 0.5 + 时效 × 0.3 + 使用频率 × 0.2。
   * 时效：最近 30 天内被引用为满分，线性衰减；使用频率：log(usageCount+1) 归一。
   */
  rank(entries: KnowledgeEntry[], now: number = Date.now()): KnowledgeEntry[] {
    const maxUsage = Math.max(...entries.map((e) => Math.log(e.usageCount + 1)), 1);
    const scored = entries.map((e) => {
      const refAt = e.lastUsedAt ?? e.createdAt;
      const ageDays = Math.max(0, (now - new Date(refAt).getTime()) / DAY_MS);
      const recency = Math.max(0, 1 - ageDays / 30);
      const usage = Math.log(e.usageCount + 1) / maxUsage;
      return { entry: e, score: e.confidence * 0.5 + recency * 0.3 + usage * 0.2 };
    });
    scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    return scored.map((s) => s.entry);
  }

  /** 引用知识：usageCount +1、lastUsedAt 刷新、confidence 微调（上限 0.99） */
  touch(id: string): KnowledgeEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Knowledge 引用失败：${id} 不存在`);
    entry.usageCount += 1;
    entry.lastUsedAt = new Date().toISOString();
    entry.confidence = Math.min(0.99, Math.round((entry.confidence + 0.01) * 100) / 100);
    entry.updatedAt = entry.lastUsedAt;
    return entry;
  }

  /**
   * 生命周期刷新：
   *   - ACTIVE → STALE：超过 staleDays 未被引用
   *   - STALE → EXPIRED：超过 expireDays 未被引用 或 已过 validUntil
   *   - ACTIVE 且已过 validUntil → EXPIRED
   * EXPIRED 不自动复活（需再次 add 同题知识或 revive）。
   */
  refreshLifecycle(now: number = Date.now()): LifecycleTransition[] {
    const transitions: LifecycleTransition[] = [];
    for (const e of this.entries.values()) {
      const refAt = new Date(e.lastUsedAt ?? e.createdAt).getTime();
      const idleDays = (now - refAt) / DAY_MS;
      const expiredByValidity = e.validUntil !== undefined && now > new Date(e.validUntil).getTime();
      let next: KnowledgeStatus | null = null;
      let reason = '';
      if (e.status === 'ACTIVE' && (expiredByValidity || idleDays > this.lifecycle.staleDays)) {
        next = expiredByValidity && idleDays <= this.lifecycle.staleDays ? 'EXPIRED' : 'STALE';
        if (expiredByValidity) {
          next = 'EXPIRED';
          reason = '已过 validUntil';
        } else {
          reason = `${Math.floor(idleDays)} 天未被引用`;
        }
      } else if (e.status === 'STALE' && (expiredByValidity || idleDays > this.lifecycle.expireDays)) {
        next = 'EXPIRED';
        reason = expiredByValidity ? '已过 validUntil' : `STALE 超过 ${Math.floor(idleDays)} 天`;
      }
      if (next && next !== e.status) {
        transitions.push({ id: e.id, from: e.status, to: next, reason });
        e.status = next;
        e.updatedAt = new Date(now).toISOString();
      }
    }
    return transitions;
  }

  /** 手动复活（EXPIRED/STALE → ACTIVE） */
  revive(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.status === 'ACTIVE') return false;
    entry.status = 'ACTIVE';
    entry.updatedAt = new Date().toISOString();
    return true;
  }

  size(): number {
    return this.entries.size;
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries.values()) out[e.status] = (out[e.status] ?? 0) + 1;
    return out;
  }

  save(file: string): void {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ entries: [...this.entries.values()] }, null, 2), 'utf-8');
  }

  static load(file: string, lifecycle?: KnowledgeLifecycleConfig): KnowledgeStore {
    const store = new KnowledgeStore(lifecycle);
    try {
      if (!fs.existsSync(file)) return store;
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf-8')) as { entries?: KnowledgeEntry[] };
      for (const e of snapshot.entries ?? []) store.entries.set(e.id, e);
    } catch {
      // 文件损坏：返回空知识库
    }
    return store;
  }
}

export function createKnowledgeStore(lifecycle?: KnowledgeLifecycleConfig): KnowledgeStore {
  return new KnowledgeStore(lifecycle);
}
