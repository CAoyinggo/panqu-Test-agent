// 单元测试：Run 状态机（Phase 32 变异测试防护）
// 覆盖：统一 Completion 状态机、canTransition 正反例、非法跃迁与终态判定。

import { describe, it, expect } from 'vitest';
import {
  RUN_TRANSITIONS,
  canTransition,
  transitionRun,
  isTerminal,
  type RunStatus,
} from '../../src/platform/runs/run-schema.js';

describe('Run 状态机（Run 状态转移表）', () => {
  it('完整状态转移表', () => {
    expect(RUN_TRANSITIONS).toEqual({
      QUEUED: ['PLANNING', 'BLOCKED', 'CANCELLED'],
      PLANNING: ['GATED', 'BLOCKED', 'FAILED', 'TIMEOUT', 'CANCELLED'],
      GATED: ['RUNNING', 'BLOCKED', 'FAILED', 'TIMEOUT', 'CANCELLED'],
      RUNNING: ['PAUSED', 'EVIDENCE_READY', 'BLOCKED', 'FAILED', 'TIMEOUT', 'CANCELLED'],
      PAUSED: ['PLANNING', 'CANCELLED'],
      EVIDENCE_READY: ['COMPLETED', 'FAILED', 'CANCELLED'],
      COMPLETED: [],
      FAILED: [],
      BLOCKED: [],
      TIMEOUT: [],
      CANCELLED: [],
    });
  });

  it('终态无合法迁移：COMPLETED / FAILED / CANCELLED 转移表为空（变异防护）', () => {
    expect(RUN_TRANSITIONS.COMPLETED).toEqual([]);
    expect(RUN_TRANSITIONS.FAILED).toEqual([]);
    expect(RUN_TRANSITIONS.BLOCKED).toEqual([]);
    expect(RUN_TRANSITIONS.TIMEOUT).toEqual([]);
    expect(RUN_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('canTransition：合法迁移允许，非法迁移拒绝', () => {
    // QUEUED
    expect(canTransition('QUEUED', 'PLANNING')).toBe(true);
    expect(canTransition('QUEUED', 'CANCELLED')).toBe(true);
    expect(canTransition('QUEUED', 'COMPLETED')).toBe(false);
    expect(canTransition('QUEUED', 'PAUSED')).toBe(false);
    // RUNNING
    expect(canTransition('RUNNING', 'PAUSED')).toBe(true);
    expect(canTransition('RUNNING', 'EVIDENCE_READY')).toBe(true);
    expect(canTransition('RUNNING', 'COMPLETED')).toBe(false);
    expect(canTransition('RUNNING', 'FAILED')).toBe(true);
    expect(canTransition('RUNNING', 'CANCELLED')).toBe(true);
    expect(canTransition('RUNNING', 'QUEUED')).toBe(false);
    // PAUSED
    expect(canTransition('PAUSED', 'PLANNING')).toBe(true);
    expect(canTransition('PAUSED', 'CANCELLED')).toBe(true);
    expect(canTransition('PAUSED', 'COMPLETED')).toBe(false);
    // 终态不允许任何迁移
    expect(canTransition('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransition('FAILED', 'RETRY' as RunStatus)).toBe(false);
    expect(canTransition('CANCELLED', 'QUEUED')).toBe(false);
  });

  it('transitionRun：合法迁移返回目标状态；非法迁移抛错', () => {
    expect(transitionRun('QUEUED', 'PLANNING')).toBe('PLANNING');
    expect(transitionRun('EVIDENCE_READY', 'COMPLETED')).toBe('COMPLETED');
    expect(() => transitionRun('COMPLETED', 'RUNNING')).toThrow(/非法 Run 状态迁移/);
    expect(() => transitionRun('QUEUED', 'FAILED')).toThrow(/非法 Run 状态迁移/);
  });

  it('isTerminal：完成与异常终态不可再迁移', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('BLOCKED')).toBe(true);
    expect(isTerminal('TIMEOUT')).toBe(true);
    expect(isTerminal('QUEUED')).toBe(false);
    expect(isTerminal('RUNNING')).toBe(false);
    expect(isTerminal('PAUSED')).toBe(false);
    expect(isTerminal('EVIDENCE_READY')).toBe(false);
  });
});
