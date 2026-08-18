// Flaky Lifecycle：Flaky 用例生命周期管理（Phase 21.7）
// 状态机：STABLE → SUSPECTED → FLAKY → QUARANTINED → FIXED → STABLE。
// 复用既有 flaky-analyzer 的 classifyStatus 作为分类信号；
// QUARANTINED 用例连续 N 次通过自动进入 FIXED，再稳定一次恢复 STABLE。

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/fs-utils.js';
import { classifyStatus } from '../agents/flaky/flaky-analyzer.js';

/** Flaky 生命周期状态 */
export type FlakyLifecycleStatus = 'STABLE' | 'SUSPECTED' | 'FLAKY' | 'QUARANTINED' | 'FIXED';

export const FLAKY_LIFECYCLE_STATUSES: readonly FlakyLifecycleStatus[] = [
  'STABLE', 'SUSPECTED', 'FLAKY', 'QUARANTINED', 'FIXED',
];

/** 生命周期流转事件 */
export interface FlakyLifecycleEvent {
  caseId: string;
  from: FlakyLifecycleStatus;
  to: FlakyLifecycleStatus;
  reason: string;
  at: string;
}

/** 单用例生命周期状态 */
export interface FlakyCaseState {
  caseId: string;
  status: FlakyLifecycleStatus;
  /** QUARANTINED 期间连续通过次数 */
  consecutivePasses: number;
  /** 连续失败次数 */
  consecutiveFailures: number;
  updatedAt: string;
}

/** 生命周期配置 */
export interface FlakyLifecycleConfig {
  /** QUARANTINED → FIXED 所需连续通过次数（默认 3） */
  recoveryThreshold: number;
}

export const DEFAULT_FLAKY_LIFECYCLE_CONFIG: FlakyLifecycleConfig = { recoveryThreshold: 3 };

export class FlakyLifecycle {
  private readonly cases = new Map<string, FlakyCaseState>();
  private readonly events: FlakyLifecycleEvent[] = [];

  constructor(private readonly config: FlakyLifecycleConfig = DEFAULT_FLAKY_LIFECYCLE_CONFIG) {}

  /** 记录一次执行结果，驱动状态机，返回本轮发生的流转事件 */
  recordRun(caseId: string, pass: boolean): FlakyLifecycleEvent[] {
    const state = this.stateOf(caseId);
    const before = state.status;
    const round: FlakyLifecycleEvent[] = [];
    const now = new Date().toISOString();

    if (pass) {
      state.consecutiveFailures = 0;
      switch (state.status) {
        case 'SUSPECTED':
          this.move(state, 'STABLE', '疑似后恢复通过，解除怀疑', round, now);
          break;
        case 'QUARANTINED':
          state.consecutivePasses += 1;
          if (state.consecutivePasses >= this.config.recoveryThreshold) {
            this.move(state, 'FIXED', `隔离期连续 ${state.consecutivePasses} 次通过，视为已修复`, round, now);
          }
          break;
        case 'FIXED':
          this.move(state, 'STABLE', '修复后持续稳定，恢复正常', round, now);
          break;
        default:
          break; // STABLE / FLAKY 通过不改变状态
      }
    } else {
      state.consecutivePasses = 0;
      state.consecutiveFailures += 1;
      switch (state.status) {
        case 'STABLE':
          this.move(state, 'SUSPECTED', '稳定用例出现失败，疑似 Flaky', round, now);
          break;
        case 'SUSPECTED':
          this.move(state, 'FLAKY', '疑似后再次失败，确认 Flaky', round, now);
          break;
        case 'FLAKY':
          this.move(state, 'QUARANTINED', 'Flaky 持续失败，自动隔离', round, now);
          break;
        case 'FIXED':
          this.move(state, 'FLAKY', '修复后复发，重新判定 Flaky', round, now);
          break;
        default:
          break; // QUARANTINED 失败只重置连续通过计数
      }
    }

    state.updatedAt = now;
    this.events.push(...round);
    return round;
  }

  /** 手动隔离 */
  quarantine(caseId: string, reason = '人工隔离'): FlakyLifecycleEvent | null {
    const state = this.stateOf(caseId);
    if (state.status === 'QUARANTINED') return null;
    const round: FlakyLifecycleEvent[] = [];
    this.move(state, 'QUARANTINED', reason, round, new Date().toISOString());
    this.events.push(...round);
    return round[0] ?? null;
  }

  /** 手动标记修复（进入 FIXED 观察期） */
  markFixed(caseId: string, reason = '人工标记修复'): FlakyLifecycleEvent | null {
    const state = this.stateOf(caseId);
    if (state.status !== 'QUARANTINED' && state.status !== 'FLAKY') return null;
    const round: FlakyLifecycleEvent[] = [];
    state.consecutivePasses = 0;
    this.move(state, 'FIXED', reason, round, new Date().toISOString());
    this.events.push(...round);
    return round[0] ?? null;
  }

  /**
   * 从既有 Flaky 分类信号同步（复用 classifyStatus）：
   * FLAKY/UNSTABLE → 进入 FLAKY 状态；STABLE 分类且处于 SUSPECTED → 恢复 STABLE；
   * BROKEN 不属于 Flaky（产品/用例缺陷），不改变生命周期状态。
   */
  syncFromPassRate(caseId: string, passRate: number, runs: number): FlakyLifecycleEvent[] {
    const classified = classifyStatus(passRate, runs);
    const state = this.stateOf(caseId);
    const round: FlakyLifecycleEvent[] = [];
    const now = new Date().toISOString();
    if ((classified === 'FLAKY' || classified === 'UNSTABLE') && state.status !== 'FLAKY' && state.status !== 'QUARANTINED') {
      this.move(state, 'FLAKY', `classifyStatus 判定 ${classified}（通过率 ${(passRate * 100).toFixed(0)}%）`, round, now);
    } else if (classified === 'STABLE' && state.status === 'SUSPECTED') {
      this.move(state, 'STABLE', `classifyStatus 判定 STABLE（通过率 ${(passRate * 100).toFixed(0)}%）`, round, now);
    }
    this.events.push(...round);
    return round;
  }

  status(caseId: string): FlakyLifecycleStatus {
    return this.cases.get(caseId)?.status ?? 'STABLE';
  }

  state(caseId: string): FlakyCaseState | null {
    return this.cases.get(caseId) ?? null;
  }

  /** 全部流转事件（时间序） */
  history(caseId?: string): FlakyLifecycleEvent[] {
    return caseId ? this.events.filter((e) => e.caseId === caseId) : [...this.events];
  }

  /** 汇总：各状态计数 + 隔离名单 */
  summary(): { byStatus: Record<string, number>; quarantineIds: string[]; tracked: number } {
    const byStatus: Record<string, number> = {};
    const quarantineIds: string[] = [];
    for (const s of this.cases.values()) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      if (s.status === 'QUARANTINED') quarantineIds.push(s.caseId);
    }
    return { byStatus, quarantineIds: quarantineIds.sort(), tracked: this.cases.size };
  }

  private stateOf(caseId: string): FlakyCaseState {
    let state = this.cases.get(caseId);
    if (!state) {
      state = { caseId, status: 'STABLE', consecutivePasses: 0, consecutiveFailures: 0, updatedAt: new Date().toISOString() };
      this.cases.set(caseId, state);
    }
    return state;
  }

  private move(state: FlakyCaseState, to: FlakyLifecycleStatus, reason: string, round: FlakyLifecycleEvent[], at: string): void {
    const from = state.status;
    state.status = to;
    if (to === 'QUARANTINED') state.consecutivePasses = 0;
    round.push({ caseId: state.caseId, from, to, reason, at });
  }

  save(file: string): void {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ cases: [...this.cases.values()] }, null, 2), 'utf-8');
  }

  static load(file: string, config?: FlakyLifecycleConfig): FlakyLifecycle {
    const lifecycle = new FlakyLifecycle(config);
    try {
      if (!fs.existsSync(file)) return lifecycle;
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases?: FlakyCaseState[] };
      for (const c of snapshot.cases ?? []) lifecycle.cases.set(c.caseId, c);
    } catch {
      // 文件损坏：返回空状态
    }
    return lifecycle;
  }
}

export function createFlakyLifecycle(config?: FlakyLifecycleConfig): FlakyLifecycle {
  return new FlakyLifecycle(config);
}
