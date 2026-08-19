// 单元测试：Approval Center（Phase 24.5）
// 覆盖：请求创建 / 幂等 / 审批通过 / 驳回 / 已决幂等 / 列表 / pendingCount。

import { describe, it, expect } from 'vitest';
import { ApprovalCenter } from '../../src/platform/approval-center/index.js';
import type { ApprovalRequest } from '../../src/platform/approval-center/index.js';
import { InMemoryRepository } from '../../src/platform/storage/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeCenter(now: () => string = () => FIXED_ISO) {
  const repo = new InMemoryRepository<ApprovalRequest>('approval');
  return new ApprovalCenter(repo, { now });
}

describe('Approval Center', () => {
  it('request 创建 PENDING 审批', async () => {
    const c = makeCenter();
    const { approval, created } = await c.request({
      runId: 'run-1',
      action: 'risky-production',
      riskLevel: 'risky',
      environment: 'production',
      requester: 'alice',
      reason: '生产冒烟',
      evidence: [{ type: 'tool', detail: 'billing-check' }],
    });
    expect(created).toBe(true);
    expect(approval.status).toBe('PENDING');
    expect(approval.requester).toBe('alice');
    expect(approval.evidence).toHaveLength(1);
    expect(approval.createdAt).toBe(FIXED_ISO);
  });

  it('幂等：同一 idempotencyKey 重复请求只创建一份', async () => {
    const c = makeCenter();
    const a1 = await c.request({
      runId: 'run-2',
      action: 'release',
      riskLevel: 'risky',
      environment: 'production',
      requester: 'alice',
      reason: 'x',
      idempotencyKey: 'k1',
    });
    const a2 = await c.request({
      runId: 'run-2',
      action: 'release',
      riskLevel: 'risky',
      environment: 'production',
      requester: 'alice',
      reason: 'x',
      idempotencyKey: 'k1',
    });
    expect(a1.created).toBe(true);
    expect(a2.created).toBe(false);
    expect(a1.approval.approvalId).toBe(a2.approval.approvalId);
    expect(await c.pendingCount()).toBe(1);
  });

  it('approve：PENDING → APPROVED，记录审批人与时间', async () => {
    const c = makeCenter();
    const { approval } = await c.request({
      runId: 'run-3',
      action: 'release',
      riskLevel: 'risky',
      environment: 'production',
      requester: 'alice',
      reason: '发布审批',
    });
    const approved = await c.approve(approval.approvalId, 'bob');
    expect(approved.status).toBe('APPROVED');
    expect(approved.decidedBy).toBe('bob');
    expect(approved.decidedAt).toBe(FIXED_ISO);
  });

  it('reject：PENDING → REJECTED', async () => {
    const c = makeCenter();
    const { approval } = await c.request({
      runId: 'run-4',
      action: 'healing',
      riskLevel: 'risky',
      environment: 'staging',
      requester: 'alice',
      reason: '自愈审批',
    });
    const rejected = await c.reject(approval.approvalId, 'bob');
    expect(rejected.status).toBe('REJECTED');
  });

  it('已决审批不可二次变更（幂等返回既有结果）', async () => {
    const c = makeCenter();
    const { approval } = await c.request({
      runId: 'run-5',
      action: 'release',
      riskLevel: 'risky',
      environment: 'production',
      requester: 'alice',
      reason: 'x',
    });
    await c.approve(approval.approvalId, 'bob');
    // 再次 approve / reject 均返回既有 APPROVED，不覆盖
    const again = await c.approve(approval.approvalId, 'evil');
    expect(again.status).toBe('APPROVED');
    expect(again.decidedBy).toBe('bob');
    const rej = await c.reject(approval.approvalId, 'evil');
    expect(rej.status).toBe('APPROVED');
    expect(rej.decidedBy).toBe('bob');
  });

  it('list 按状态过滤 / pendingCount', async () => {
    const c = makeCenter();
    await c.request({ runId: 'r1', action: 'release', riskLevel: 'risky', environment: 'production', requester: 'a', reason: 'x' });
    await c.request({ runId: 'r2', action: 'healing', riskLevel: 'risky', environment: 'staging', requester: 'a', reason: 'x' });
    const all = await c.list();
    expect(all).toHaveLength(2);
    expect(await c.pendingCount()).toBe(2);
    await c.approve(all[0].approvalId, 'bob');
    expect(await c.pendingCount()).toBe(1);
    const pending = await c.list({ status: 'PENDING' });
    expect(pending).toHaveLength(1);
    expect(pending[0].runId).toBe('r2');
  });

  it('审批不存在 → 抛错', async () => {
    const c = makeCenter();
    await expect(c.approve('nope', 'bob')).rejects.toThrow(/审批不存在/);
  });

  it('27.3 审批职责分离：审批人不能审批自己发起的申请（approve/reject 均拦截）', async () => {
    const c = makeCenter();
    const { approval } = await c.request({
      runId: 'run-6',
      action: 'release',
      riskLevel: 'risky',
      environment: 'production',
      requester: 'alice',
      reason: '自提自批演练',
    });
    await expect(c.approve(approval.approvalId, 'alice')).rejects.toThrow(/职责分离/);
    await expect(c.reject(approval.approvalId, 'alice')).rejects.toThrow(/职责分离/);
    // 未被篡改：仍为 PENDING，可交由他人审批
    expect((await c.get(approval.approvalId))?.status).toBe('PENDING');
    const approved = await c.approve(approval.approvalId, 'bob');
    expect(approved.status).toBe('APPROVED');
  });

  it('27.3 审批 ID 使用安全随机值：同一时间多次创建不重复', async () => {
    const c = makeCenter();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { approval } = await c.request({
        runId: `run-${i}`,
        action: 'release',
        riskLevel: 'risky',
        environment: 'production',
        requester: 'alice',
        reason: 'x',
      });
      ids.add(approval.approvalId);
    }
    expect(ids.size).toBe(50);
  });
});
