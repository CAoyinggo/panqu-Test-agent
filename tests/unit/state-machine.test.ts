// 单元测试：Agent State Machine（Phase 16/17 状态机 + 失败恢复）
// 覆盖：主路径转移 / 非法转移拒绝 / checkpoint / pause / cancel / resume / retry / 序列化恢复
import { describe, it, expect } from 'vitest';
import {
  AgentStateMachine,
  isMachineState,
  MAIN_STATES,
} from '../../src/agents/index.js';

describe('state-machine - 主路径转移', () => {
  it('按顺序前进合法', () => {
    const m = new AgentStateMachine('t1');
    expect(m.current()).toBe('INIT');
    expect(m.transition('REQUIREMENT_PARSED')).toBe(true);
    expect(m.transition('TEST_DESIGNED')).toBe(true);
    expect(m.transition('RISK_ASSESSED')).toBe(true);
    expect(m.transition('TEST_SELECTED')).toBe(true);
    expect(m.transition('DATA_READY')).toBe(true);
    expect(m.transition('EXECUTING')).toBe(true);
    expect(m.transition('ANALYZING')).toBe(true);
    expect(m.transition('RCA')).toBe(true);
    expect(m.transition('DEFECT')).toBe(true);
    expect(m.transition('HEALING')).toBe(true);
    expect(m.transition('MEMORY_UPDATED')).toBe(true);
    expect(m.transition('COMPLETED')).toBe(true);
    expect(m.isTerminal()).toBe(true);
  });

  it('非法转移（跳步/回退）被拒绝', () => {
    const m = new AgentStateMachine('t1');
    expect(m.transition('EXECUTING')).toBe(false); // 跳步
    m.transition('REQUIREMENT_PARSED');
    expect(m.transition('INIT')).toBe(false); // 回退
  });

  it('终态后不可再转移', () => {
    const m = new AgentStateMachine('t1');
    for (const s of MAIN_STATES.slice(1)) {
      m.transition(s);
    }
    expect(m.current()).toBe('COMPLETED');
    expect(m.transition('RCA')).toBe(false);
    expect(m.cancel()).toBe(false);
  });
});

describe('state-machine - 异常态与恢复', () => {
  it('pause → 恢复执行', () => {
    const m = new AgentStateMachine('t1');
    m.transition('REQUIREMENT_PARSED');
    m.transition('TEST_DESIGNED');
    expect(m.pause()).toBe(true);
    expect(m.current()).toBe('PAUSED');
    expect(m.isRecoverable()).toBe(true);
    expect(m.resume()).toBe(true);
    expect(m.current()).toBe('TEST_DESIGNED');
  });

  it('fail → retry 恢复到最后活动状态', () => {
    const m = new AgentStateMachine('t1');
    m.transition('REQUIREMENT_PARSED');
    m.transition('TEST_DESIGNED');
    m.transition('RISK_ASSESSED');
    m.fail();
    expect(m.current()).toBe('FAILED');
    expect(m.retry()).toBe(true);
    expect(m.current()).toBe('RISK_ASSESSED');
  });

  it('waitForApproval → resume 指定阶段', () => {
    const m = new AgentStateMachine('t1');
    m.transition('REQUIREMENT_PARSED');
    m.transition('TEST_DESIGNED');
    m.waitForApproval();
    expect(m.current()).toBe('WAITING_APPROVAL');
    expect(m.resume('TEST_SELECTED')).toBe(true);
    expect(m.current()).toBe('TEST_SELECTED');
  });

  it('cancel 终止', () => {
    const m = new AgentStateMachine('t1');
    m.transition('REQUIREMENT_PARSED');
    expect(m.cancel()).toBe(true);
    expect(m.current()).toBe('CANCELLED');
    expect(m.isTerminal()).toBe(true);
  });
});

describe('state-machine - checkpoint 与序列化', () => {
  it('checkpoint 保存阶段产物，resume 后读取', () => {
    const m = new AgentStateMachine('t1');
    m.setCheckpoint('EXECUTING', { results: ['r1'] });
    expect(m.getCheckpoint('EXECUTING')).toEqual({ results: ['r1'] });
    expect(m.checkpointStages()).toContain('EXECUTING');
  });

  it('toJSON / fromJSON 支持持久化续跑', () => {
    const m = new AgentStateMachine('t1');
    m.transition('REQUIREMENT_PARSED');
    m.transition('TEST_DESIGNED');
    m.setCheckpoint('REQUIREMENT_PARSED', { feature: 'wan3' });
    const json = m.toJSON();
    const restored = AgentStateMachine.fromJSON(json);
    expect(restored.current()).toBe('TEST_DESIGNED');
    expect(restored.getCheckpoint('REQUIREMENT_PARSED')).toEqual({ feature: 'wan3' });
    expect(restored.transition('RISK_ASSESSED')).toBe(true);
  });

  it('isMachineState 校验', () => {
    expect(isMachineState('EXECUTING')).toBe(true);
    expect(isMachineState('WAITING_APPROVAL')).toBe(true);
    expect(isMachineState('NOPE')).toBe(false);
  });

  it('MAIN_STATES 顺序符合任务书', () => {
    expect(MAIN_STATES).toEqual([
      'INIT', 'REQUIREMENT_PARSED', 'TEST_DESIGNED', 'RISK_ASSESSED', 'TEST_SELECTED',
      'DATA_READY', 'EXECUTING', 'ANALYZING', 'RCA', 'DEFECT', 'HEALING',
      'MEMORY_UPDATED', 'COMPLETED',
    ]);
  });
});
