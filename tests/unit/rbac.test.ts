// 单元测试：RBAC + Access Chain + Platform Gate（Phase 24.5）
// 覆盖：角色权限矩阵 / 权限判定 / 审批权限映射 / 访问链路（RBAC → 环境策略 → Approval）/
//       Scenario 5（Production Dangerous DENY）/ Scenario 6（Risky + Approval）/ Admin 不可绕过生产安全。

import { describe, it, expect } from 'vitest';
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  approvalPermissionFor,
  evaluateAccessChain,
  listPermissions,
  PlatformGate,
} from '../../src/platform/rbac/index.js';
import { ApprovalCenter } from '../../src/platform/approval-center/index.js';
import { InMemoryRepository } from '../../src/platform/storage/index.js';
import type { ApprovalRequest } from '../../src/platform/approval-center/index.js';
import { standardEnvironments } from '../../src/platform/projects/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const ENVS = standardEnvironments();
const prod = ENVS.find((e) => e.type === 'production')!;
const test = ENVS.find((e) => e.type === 'test')!;

function makeApprovals() {
  const repo = new InMemoryRepository<ApprovalRequest>('approval');
  return new ApprovalCenter(repo, { now: () => FIXED_ISO });
}

/** 类型守卫：要求结果为 APPROVAL_REQUIRED，否则抛错（用于 Gate 审批流测试） */
function requireApproval(out: import('../../src/platform/rbac/index.js').GateOutcome) {
  if (out.verdict !== 'APPROVAL_REQUIRED') {
    throw new Error(`期望 APPROVAL_REQUIRED，实际 ${out.verdict}（${out.decision.reason}）`);
  }
  return { decision: out.decision, approval: out.approval };
}

describe('RBAC 角色 / 权限矩阵', () => {
  it('角色清单与权限覆盖至少清单', () => {
    const roles = Object.keys(ROLE_PERMISSIONS);
    expect(roles.sort()).toEqual(
      ['ADMIN', 'QA', 'DEVELOPER', 'RELEASE_MANAGER', 'VIEWER', 'SERVICE_ACCOUNT'].sort(),
    );
    // 权限至少清单全部在 ALL_PERMISSIONS 中
    for (const p of [
      'PROJECT_READ', 'PROJECT_WRITE', 'TEST_RUN', 'TEST_CANCEL', 'TEST_RETRY',
      'ASSET_READ', 'ASSET_WRITE', 'DEFECT_CREATE', 'HEALING_APPROVE',
      'RELEASE_APPROVE', 'PRODUCTION_ACCESS',
    ]) {
      expect(ALL_PERMISSIONS).toContain(p);
    }
  });

  it('ADMIN 持有全部权限；VIEWER 只有只读', () => {
    expect(ROLE_PERMISSIONS.ADMIN).toHaveLength(ALL_PERMISSIONS.length);
    expect(hasPermission('ADMIN', 'PRODUCTION_ACCESS')).toBe(true);
    expect(hasPermission('VIEWER', 'TEST_RUN')).toBe(false);
    expect(hasPermission('VIEWER', 'PROJECT_READ')).toBe(true);
  });

  it('QA 可跑测试但不能审批发布；RELEASE_MANAGER 可审批', () => {
    expect(hasPermission('QA', 'TEST_RUN')).toBe(true);
    expect(hasPermission('QA', 'RELEASE_APPROVE')).toBe(false);
    expect(hasPermission('RELEASE_MANAGER', 'RELEASE_APPROVE')).toBe(true);
    expect(hasPermission('RELEASE_MANAGER', 'HEALING_APPROVE')).toBe(true);
    expect(hasPermission('DEVELOPER', 'TEST_CANCEL')).toBe(false);
    expect(hasPermission('SERVICE_ACCOUNT', 'TEST_RUN')).toBe(true);
  });

  it('审批权限映射：healing → HEALING_APPROVE，其余 → RELEASE_APPROVE', () => {
    expect(approvalPermissionFor('healing')).toBe('HEALING_APPROVE');
    expect(approvalPermissionFor('release')).toBe('RELEASE_APPROVE');
    expect(approvalPermissionFor('risky-production')).toBe('RELEASE_APPROVE');
  });

  it('DEVELOPER / SERVICE_ACCOUNT 权限矩阵完整（变异防护，Phase 32）', () => {
    // DEVELOPER 正向：可读项目、跑测试、重试、读资产、创建缺陷
    for (const p of ['PROJECT_READ', 'TEST_RUN', 'TEST_RETRY', 'ASSET_READ', 'DEFECT_CREATE']) {
      expect(hasPermission('DEVELOPER', p as never)).toBe(true);
    }
    // DEVELOPER 负向：不可取消、不可写资产/项目、不可审批、不可生产访问、不可读运维
    for (const p of ['TEST_CANCEL', 'ASSET_WRITE', 'PROJECT_WRITE', 'RELEASE_APPROVE', 'PRODUCTION_ACCESS', 'OPS_READ']) {
      expect(hasPermission('DEVELOPER', p as never)).toBe(false);
    }
    // SERVICE_ACCOUNT 正向：可跑测试、读资产、创建缺陷、读运维
    for (const p of ['TEST_RUN', 'ASSET_READ', 'DEFECT_CREATE', 'OPS_READ']) {
      expect(hasPermission('SERVICE_ACCOUNT', p as never)).toBe(true);
    }
    // SERVICE_ACCOUNT 负向：不可读项目、不可重试/取消、不可写资产、不可审批
    for (const p of ['PROJECT_READ', 'TEST_RETRY', 'TEST_CANCEL', 'ASSET_WRITE', 'RELEASE_APPROVE', 'HEALING_APPROVE']) {
      expect(hasPermission('SERVICE_ACCOUNT', p as never)).toBe(false);
    }
  });

  it('listPermissions 返回角色权限清单（审计/调试用）', () => {
    expect(listPermissions('DEVELOPER')).toEqual(ROLE_PERMISSIONS.DEVELOPER);
    expect(listPermissions('SERVICE_ACCOUNT')).toEqual(ROLE_PERMISSIONS.SERVICE_ACCOUNT);
    expect(listPermissions('QA')).toContain('TEST_RUN');
    expect(listPermissions('QA')).not.toContain('RELEASE_APPROVE');
    expect(listPermissions('ADMIN')).toEqual(ALL_PERMISSIONS);
  });
});

describe('Access Chain：RBAC → Environment Policy', () => {
  it('QA + production + dangerous → RBAC 层拒绝（无 PRODUCTION_ACCESS，DENY）', () => {
    const d = evaluateAccessChain({
      actor: 'alice',
      role: 'QA',
      permission: 'PRODUCTION_ACCESS',
      action: 'dangerous',
      environment: prod,
    });
    expect(d.verdict).toBe('DENIED');
    expect(d.rbacPassed).toBe(false);
  });

  it('具备 PRODUCTION_ACCESS 的角色 + production + dangerous → 环境策略 DENY（Scenario 5：Production Dangerous）', () => {
    const d = evaluateAccessChain({
      actor: 'bob',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'dangerous',
      environment: prod,
    });
    expect(d.verdict).toBe('DENIED');
    expect(d.policy).toBe('deny');
    expect(d.reason).toContain('生产安全');
  });

  it('ADMIN + production + dangerous → DENY（Admin 不可绕过生产安全）', () => {
    const d = evaluateAccessChain({
      actor: 'root',
      role: 'ADMIN',
      permission: 'PRODUCTION_ACCESS',
      action: 'dangerous',
      environment: prod,
    });
    expect(d.verdict).toBe('DENIED');
    expect(d.reason).toContain('ADMIN 亦不可绕过');
  });

  it('production + risky → APPROVAL_REQUIRED（Scenario 6）', () => {
    const d = evaluateAccessChain({
      actor: 'bob',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      environment: prod,
    });
    expect(d.verdict).toBe('APPROVAL_REQUIRED');
    expect(d.requiresApproval).toBe(true);
  });

  it('test + dangerous → APPROVAL_REQUIRED（测试环境危险动作仍需审批）', () => {
    const d = evaluateAccessChain({
      actor: 'alice',
      role: 'QA',
      permission: 'TEST_RUN',
      action: 'dangerous',
      environment: test,
    });
    expect(d.verdict).toBe('APPROVAL_REQUIRED');
  });

  it('test + risky → ALLOWED；READ 动作全部 ALLOWED', () => {
    const d = evaluateAccessChain({
      actor: 'alice',
      role: 'QA',
      permission: 'TEST_RUN',
      action: 'risky',
      environment: test,
    });
    expect(d.verdict).toBe('ALLOWED');
    expect(evaluateAccessChain({
      actor: 'bob',
      role: 'VIEWER',
      permission: 'PROJECT_READ',
      action: 'read',
      environment: prod,
    }).verdict).toBe('ALLOWED');
  });

  it('RBAC 拒绝优先：无权限角色 → DENIED（不进入环境策略）', () => {
    const d = evaluateAccessChain({
      actor: 'bob',
      role: 'VIEWER',
      permission: 'TEST_RUN',
      action: 'risky',
      environment: test,
    });
    expect(d.verdict).toBe('DENIED');
    expect(d.rbacPassed).toBe(false);
  });
});

describe('Access Decision 完整形状（变异测试防护，Phase 32）', () => {
  // 四个分支逐一断言 {verdict, requiresApproval, rbacPassed, policy} 全字段，
  // 防止布尔字段被变异（如 requiresApproval 被翻转为 true）时测试仍通过。
  it('RBAC 拒绝分支：DENIED + requiresApproval=false + rbacPassed=false + policy=deny', () => {
    const d = evaluateAccessChain({
      actor: 'alice',
      role: 'QA',
      permission: 'PRODUCTION_ACCESS',
      action: 'dangerous',
      environment: prod,
    });
    expect(d.verdict).toBe('DENIED');
    expect(d.requiresApproval).toBe(false);
    expect(d.rbacPassed).toBe(false);
    expect(d.policy).toBe('deny');
    expect(d.reason).toContain('缺少权限');
  });

  it('环境允许分支：ALLOWED + requiresApproval=false + rbacPassed=true + policy=allow', () => {
    const d = evaluateAccessChain({
      actor: 'alice',
      role: 'QA',
      permission: 'TEST_RUN',
      action: 'risky',
      environment: test,
    });
    expect(d.verdict).toBe('ALLOWED');
    expect(d.requiresApproval).toBe(false);
    expect(d.rbacPassed).toBe(true);
    expect(d.policy).toBe('allow');
    expect(d.reason).toContain('允许');
  });

  it('需审批分支：APPROVAL_REQUIRED + requiresApproval=true + rbacPassed=true + policy=approval', () => {
    const d = evaluateAccessChain({
      actor: 'bob',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      environment: prod,
    });
    expect(d.verdict).toBe('APPROVAL_REQUIRED');
    expect(d.requiresApproval).toBe(true);
    expect(d.rbacPassed).toBe(true);
    expect(d.policy).toBe('approval');
    expect(d.reason).toContain('需审批');
  });

  it('环境拒绝分支：DENIED + requiresApproval=false + rbacPassed=true + policy=deny（RBAC 已通过）', () => {
    const d = evaluateAccessChain({
      actor: 'bob',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'dangerous',
      environment: prod,
    });
    expect(d.verdict).toBe('DENIED');
    expect(d.requiresApproval).toBe(false);
    expect(d.rbacPassed).toBe(true);
    expect(d.policy).toBe('deny');
    expect(d.reason).toContain('生产安全');
  });
});

describe('Platform Gate：完整链路 + 审批流（Scenario 6）', () => {
  it('production + risky → 自动发起审批 → 审批人通过后执行', async () => {
    const approvals = makeApprovals();
    const gate = new PlatformGate(approvals);
    const out = await gate.execute({
      actor: 'bob',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      environment: prod,
      runId: 'run-1',
      reason: '生产冒烟',
    });
    expect(out.verdict).toBe('APPROVAL_REQUIRED');
    const { approval } = requireApproval(out);
    expect(approval.status).toBe('PENDING');
    expect(approval.environment).toBe('production');
    expect(approval.requester).toBe('bob');
    // 审批人必须拥有审批权限
    const approved = await gate.approve(approval.approvalId, 'carol', 'RELEASE_MANAGER');
    expect(approved.status).toBe('APPROVED');
    expect(approved.decidedBy).toBe('carol');
  });

  it('审批驳回 → REJECTED，执行被拒绝', async () => {
    const approvals = makeApprovals();
    const gate = new PlatformGate(approvals);
    const out = await gate.execute({
      actor: 'bob',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      environment: prod,
      runId: 'run-2',
    });
    const { approval } = requireApproval(out);
    const rejected = await gate.reject(approval.approvalId, 'carol', 'RELEASE_MANAGER');
    expect(rejected.status).toBe('REJECTED');
  });

  it('QA 无审批权限 → 审批抛出异常', async () => {
    const approvals = makeApprovals();
    const gate = new PlatformGate(approvals);
    const out = await gate.execute({
      actor: 'bob',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      environment: prod,
      runId: 'run-3',
    });
    const { approval } = requireApproval(out);
    await expect(gate.approve(approval.approvalId, 'carol', 'QA')).rejects.toThrow(/无权审批/);
  });

  it('同一 Run 的审批请求幂等：重复 execute 只创建一份', async () => {
    const approvals = makeApprovals();
    const gate = new PlatformGate(approvals);
    const a1 = requireApproval(await gate.execute({
      actor: 'bob',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      environment: prod,
      runId: 'run-4',
    }));
    const a2 = requireApproval(await gate.execute({
      actor: 'bob',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      environment: prod,
      runId: 'run-4',
    }));
    expect(a1.approval.approvalId).toBe(a2.approval.approvalId);
    expect(await approvals.pendingCount()).toBe(1);
  });

  it('test + dangerous → APPROVAL_REQUIRED（测试环境危险动作也需审批）', async () => {
    const approvals = makeApprovals();
    const gate = new PlatformGate(approvals);
    const out = await gate.execute({
      actor: 'alice',
      role: 'QA',
      permission: 'TEST_RUN',
      action: 'dangerous',
      environment: test,
      runId: 'run-5',
    });
    expect(out.verdict).toBe('APPROVAL_REQUIRED');
  });

  it('approve 审批不存在 → 抛错（Phase 32）', async () => {
    const gate = new PlatformGate(makeApprovals());
    await expect(gate.approve('no-such-approval', 'carol', 'RELEASE_MANAGER')).rejects.toThrow(/审批不存在/);
  });

  it('reject 审批不存在 → 抛错（Phase 32）', async () => {
    const gate = new PlatformGate(makeApprovals());
    await expect(gate.reject('no-such-approval', 'carol', 'RELEASE_MANAGER')).rejects.toThrow(/审批不存在/);
  });

  it('reject 无审批权限 → 抛错（Phase 32）', async () => {
    const approvals = makeApprovals();
    const gate = new PlatformGate(approvals);
    const { approval } = requireApproval(await gate.execute({
      actor: 'bob',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      environment: prod,
      runId: 'run-rej',
    }));
    await expect(gate.reject(approval.approvalId, 'carol', 'QA')).rejects.toThrow(/无权审批/);
  });

  it('未传 reason / evidence → 审批回退 decision.reason / 空数组（Phase 32）', async () => {
    const approvals = makeApprovals();
    const gate = new PlatformGate(approvals);
    const { decision, approval } = requireApproval(await gate.execute({
      actor: 'bob',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      environment: prod,
      runId: 'run-fb',
    }));
    expect(approval.reason).toBe(decision.reason);
    expect(approval.evidence).toEqual([]);
  });
});
