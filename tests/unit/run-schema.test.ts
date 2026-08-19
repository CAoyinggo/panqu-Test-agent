// 单元测试：Run 状态机（Phase 32 变异测试防护）
// 覆盖：完整状态转移表（六状态）、canTransition 正反例、transitionRun 合法/非法迁移、
//       isTerminal 终态判定、终态无合法迁移（COMPLETED/FAILED/CANCELLED 转移表为空）。

import { describe, it, expect } from 'vitest';
import {
  RUN_TRANSITIONS,
  canTransition,
  transitionRun,
  isTerminal,
  type RunStatus,
} from '../../src/platform/runs/run-schema.js';

describe('Run 状态机（Run 状态转移表）', () => {
  it('完整状态转移表（六状态合法迁移）', () => {
    expect(RUN_TRANSITIONS).toEqual({
      QUEUED: ['RUNNING', 'CANCELLED'],
      RUNNING: ['PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
      PAUSED: ['RUNNING', 'CANCELLED'],
      COMPLETED: [],
      FAILED: [],
      CANCELLED: [],
    });
  });

  it('终态无合法迁移：COMPLETED / FAILED / CANCELLED 转移表为空（变异防护）', () => {
    expect(RUN_TRANSITIONS.COMPLETED).toEqual([]);
    expect(RUN_TRANSITIONS.FAILED).toEqual([]);
    expect(RUN_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('canTransition：合法迁移允许，非法迁移拒绝', () => {
    // QUEUED
    expect(canTransition('QUEUED', 'RUNNING')).toBe(true);
    expect(canTransition('QUEUED', 'CANCELLED')).toBe(true);
    expect(canTransition('QUEUED', 'COMPLETED')).toBe(false);
    expect(canTransition('QUEUED', 'PAUSED')).toBe(false);
    // RUNNING
    expect(canTransition('RUNNING', 'PAUSED')).toBe(true);
    expect(canTransition('RUNNING', 'COMPLETED')).toBe(true);
    expect(canTransition('RUNNING', 'FAILED')).toBe(true);
    expect(canTransition('RUNNING', 'CANCELLED')).toBe(true);
    expect(canTransition('RUNNING', 'QUEUED')).toBe(false);
    // PAUSED
    expect(canTransition('PAUSED', 'RUNNING')).toBe(true);
    expect(canTransition('PAUSED', 'CANCELLED')).toBe(true);
    expect(canTransition('PAUSED', 'COMPLETED')).toBe(false);
    // 终态不允许任何迁移
    expect(canTransition('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransition('FAILED', 'RETRY' as RunStatus)).toBe(false);
    expect(canTransition('CANCELLED', 'QUEUED')).toBe(false);
  });

  it('transitionRun：合法迁移返回目标状态；非法迁移抛错', () => {
    expect(transitionRun('QUEUED', 'RUNNING')).toBe('RUNNING');
    expect(transitionRun('RUNNING', 'COMPLETED')).toBe('COMPLETED');
    expect(() => transitionRun('COMPLETED', 'RUNNING')).toThrow(/非法 Run 状态迁移/);
    expect(() => transitionRun('QUEUED', 'FAILED')).toThrow(/非法 Run 状态迁移/);
  });

  it('isTerminal：仅 COMPLETED / FAILED / CANCELLED 为终态', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('QUEUED')).toBe(false);
    expect(isTerminal('RUNNING')).toBe(false);
    expect(isTerminal('PAUSED')).toBe(false);
  });
});
