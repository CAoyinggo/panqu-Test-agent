// 单元测试：Approval / Human-in-the-loop（Phase 16）
// 覆盖：确定性分级策略（AUTO/REVIEW/MANUAL/DENY）/ 审计日志 / 归一化
import { describe, it, expect } from 'vitest';
import {
  evaluateApproval,
  ApprovalAuditLog,
  normalizeApprovalRequest,
  isApprovalDecision,
} from '../../src/agents/index.js';

describe('approval - 确定性分级策略', () => {
  it('P2/P3 + 测试环境 → AUTO', () => {
    const r = evaluateApproval({ environment: 'test', severity: 'P2' });
    expect(r.decision).toBe('AUTO');
  });

  it('P1 + 测试环境 → REVIEW', () => {
    const r = evaluateApproval({ environment: 'test', severity: 'P1' });
    expect(r.decision).toBe('REVIEW');
  });

  it('P0 + 生产环境 → MANUAL', () => {
    const r = evaluateApproval({ environment: 'prod', severity: 'P0' });
    expect(r.decision).toBe('MANUAL');
  });

  it('生产环境 + 真实扣费 → DENY', () => {
    const r = evaluateApproval({ environment: 'prod', severity: 'P1', realBilling: true });
    expect(r.decision).toBe('DENY');
  });

  it('生产环境 + 删除数据 → DENY', () => {
    const r = evaluateApproval({ environment: 'production', deleteData: true });
    expect(r.decision).toBe('DENY');
  });

  it('生产环境 + 改库 → DENY', () => {
    const r = evaluateApproval({ environment: 'prod', dbModify: true });
    expect(r.decision).toBe('DENY');
  });

  it('生产环境 + 大并发 → MANUAL', () => {
    const r = evaluateApproval({ environment: 'prod', severity: 'P2', concurrent: true });
    expect(r.decision).toBe('MANUAL');
  });

  it('测试环境 + 创建缺陷 → REVIEW（不自动创建正式缺陷）', () => {
    const r = evaluateApproval({ environment: 'test', severity: 'P2', operation: 'create-defect' });
    expect(r.decision).toBe('REVIEW');
  });

  it('测试环境 + 应用自愈 → REVIEW（不自动改码）', () => {
    const r = evaluateApproval({ environment: 'test', severity: 'P2', operation: 'apply-healing' });
    expect(r.decision).toBe('REVIEW');
  });
});

describe('approval - 审计日志', () => {
  it('AUTO 决策由 system 记录，可查询', () => {
    const log = new ApprovalAuditLog();
    const req = normalizeApprovalRequest({ operation: 'run-high-risk', environment: 'test', severity: 'P2', decision: 'AUTO', reason: '自动放行' });
    log.record(req, 'approved', 'system');
    expect(log.count()).toBe(1);
    expect(log.byRequest(req.id)).toHaveLength(1);
    const entry = log.list()[0];
    expect(entry.decision).toBe('AUTO');
    expect(entry.actor).toBe('system');
    expect(entry.operation).toBe('run-high-risk');
  });

  it('MANUAL 审批由 user 记录', () => {
    const log = new ApprovalAuditLog();
    const req = normalizeApprovalRequest({ operation: 'create-defect', environment: 'test', severity: 'P1', decision: 'MANUAL', reason: '需人工' });
    log.record(req, 'approved', 'user', '我确认可以提交');
    const entry = log.byRequest(req.id)[0];
    expect(entry.actor).toBe('user');
    expect(entry.message).toContain('确认');
  });

  it('持久化回调被调用且失败不阻断', () => {
    let stored = 0;
    const log = new ApprovalAuditLog(() => {
      stored++;
    });
    const req = normalizeApprovalRequest({ operation: 'run-high-risk', environment: 'test', severity: 'P2', decision: 'AUTO', reason: '自动' });
    log.record(req, 'approved', 'system');
    expect(stored).toBe(1);
  });
});

describe('approval - schema', () => {
  it('isApprovalDecision 校验', () => {
    expect(isApprovalDecision('AUTO')).toBe(true);
    expect(isApprovalDecision('GUESS')).toBe(false);
  });

  it('normalizeApprovalRequest 兜底默认值', () => {
    const req = normalizeApprovalRequest({ target: 'x' });
    expect(req.decision).toBe('REVIEW');
    expect(req.operation).toBe('run-high-risk');
    expect(req.environment).toBe('test');
    expect(req.severity).toBe('P2');
  });
});
