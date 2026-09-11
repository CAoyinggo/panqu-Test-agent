import { describe, expect, it } from 'vitest';
import {
  IdempotencyOracle,
  type SubmitAttemptRecord,
  type BillingEntryRecord,
  type TaskRecord,
  type AssetRecord,
  type CallbackEventRecord,
  type FinalStateRecord,
} from '../../../src/devtest/idempotency-oracle.js';

describe('IdempotencyOracle', () => {
  describe('SUBMISSION_UNKNOWN 安全恢复审计', () => {
    it('未知状态重试前先查询任务状态且确认任务存在，判定为 PASS', () => {
      const attempts: SubmitAttemptRecord[] = [
        { attempt: 1, error: 'TIMEOUT', clientToken: 'token_123' },
        { attempt: 2, taskId: 'task_888', responseStatus: 200 },
      ];

      const check = IdempotencyOracle.auditSubmissionUnknownRecovery({
        submitAttempts: attempts,
        existingTasksLookup: {
          invoked: true,
          foundTaskId: 'task_888',
        },
      });

      expect(check.verdict).toBe('PASS');
      expect(check.kind).toBe('SUBMISSION_UNKNOWN_RECOVERY');
      expect(check.evidence.complete).toBe(true);
    });

    it('未知状态未查询即盲目重试，判定为 FAIL', () => {
      const attempts: SubmitAttemptRecord[] = [
        { attempt: 1, error: 'TIMEOUT', clientToken: 'token_123' },
        { attempt: 2, taskId: 'task_888', responseStatus: 200 },
      ];

      const check = IdempotencyOracle.auditSubmissionUnknownRecovery({
        submitAttempts: attempts,
        // existingTasksLookup 未执行
      });

      expect(check.verdict).toBe('FAIL');
      expect(check.reason).toContain('SUBMISSION_UNKNOWN');
    });

    it('未发生未知状态时，单次正常提交判定为 PASS', () => {
      const attempts: SubmitAttemptRecord[] = [
        { attempt: 1, responseStatus: 200, taskId: 'task_1' },
      ];

      const check = IdempotencyOracle.auditSubmissionUnknownRecovery({
        submitAttempts: attempts,
      });

      expect(check.verdict).toBe('PASS');
      expect(check.reason).toContain('无需触发');
    });
  });

  describe('REQUEST_TIMEOUT_DEDUPLICATION 超时请求去重', () => {
    it('相同请求重试返回相同 taskId，判定为 PASS', () => {
      const attempts: SubmitAttemptRecord[] = [
        { attempt: 1, clientToken: 'cl-token-1', taskId: 'task_same' },
        { attempt: 2, clientToken: 'cl-token-1', taskId: 'task_same' },
      ];

      const check = IdempotencyOracle.auditRequestTimeoutDeduplication({
        clientToken: 'cl-token-1',
        submitAttempts: attempts,
      });

      expect(check.verdict).toBe('PASS');
      expect(check.evidence.complete).toBe(true);
    });

    it('相同 clientToken 重试生成了不同的 taskId，判定为 FAIL', () => {
      const attempts: SubmitAttemptRecord[] = [
        { attempt: 1, clientToken: 'cl-token-1', taskId: 'task_101' },
        { attempt: 2, clientToken: 'cl-token-1', taskId: 'task_102' },
      ];

      const check = IdempotencyOracle.auditRequestTimeoutDeduplication({
        clientToken: 'cl-token-1',
        submitAttempts: attempts,
      });

      expect(check.verdict).toBe('FAIL');
      expect(check.reason).toContain('REQUEST_TIMEOUT_DEDUPLICATION 失败');
    });
  });

  describe('ANTI_DOUBLE_BILLING 防二次扣费', () => {
    it('缺少账务流水记录时判定为 BLOCKED', () => {
      const check = IdempotencyOracle.auditAntiDoubleBilling({
        billingEntries: [],
      });
      expect(check.verdict).toBe('BLOCKED');
      expect(check.evidence.complete).toBe(false);
    });

    it('正常单次扣费或扣费后正负对账核销，判定为 PASS', () => {
      const entries: BillingEntryRecord[] = [
        { taskId: 'task_1', type: 'CHARGE', amount: 10 },
      ];

      const check1 = IdempotencyOracle.auditAntiDoubleBilling({
        billingEntries: entries,
      });
      expect(check1.verdict).toBe('PASS');

      const refundEntries: BillingEntryRecord[] = [
        { taskId: 'task_1', type: 'CHARGE', amount: 10 },
        { taskId: 'task_1', type: 'REFUND', amount: 10 },
      ];
      const check2 = IdempotencyOracle.auditAntiDoubleBilling({
        billingEntries: refundEntries,
      });
      expect(check2.verdict).toBe('PASS');
    });

    it('重复重放产生多次扣费且未核销退款，判定为 FAIL', () => {
      const duplicateCharges: BillingEntryRecord[] = [
        { taskId: 'task_1', type: 'CHARGE', amount: 10 },
        { taskId: 'task_1', type: 'CHARGE', amount: 10 },
      ];

      const check = IdempotencyOracle.auditAntiDoubleBilling({
        billingEntries: duplicateCharges,
      });

      expect(check.verdict).toBe('FAIL');
      expect(check.reason).toContain('ANTI_DOUBLE_BILLING');
    });
  });

  describe('ANTI_DUPLICATE_TASK 防重复任务/资产', () => {
    it('多次提交只保留 1 个生效运行中任务且无重复成品资产，判定 PASS', () => {
      const tasks: TaskRecord[] = [
        { taskId: 't1', status: 'RUNNING' },
      ];
      const assets: AssetRecord[] = [
        { assetId: 'a1', url: 'https://cdn.example.com/v1.mp4' },
      ];

      const check = IdempotencyOracle.auditAntiDuplicateTask({
        createdTasks: tasks,
        createdAssets: assets,
      });

      expect(check.verdict).toBe('PASS');
    });

    it('产生多个任务，判定为 FAIL', () => {
      const tasks: TaskRecord[] = [
        { taskId: 't1', status: 'RUNNING' },
        { taskId: 't2', status: 'RUNNING' },
      ];

      const check = IdempotencyOracle.auditAntiDuplicateTask({
        createdTasks: tasks,
      });

      expect(check.verdict).toBe('FAIL');
      expect(check.reason).toContain('ANTI_DUPLICATE_TASK');
    });

    it('生产出多份资产，判定为 FAIL', () => {
      const tasks: TaskRecord[] = [{ taskId: 't1', status: 'SUCCEEDED' }];
      const assets: AssetRecord[] = [
        { assetId: 'a1', url: 'https://cdn.example.com/same.mp4' },
        { assetId: 'a2', url: 'https://cdn.example.com/same.mp4' },
      ];

      const check = IdempotencyOracle.auditAntiDuplicateTask({
        createdTasks: tasks,
        createdAssets: assets,
      });

      expect(check.verdict).toBe('FAIL');
      expect(check.reason).toContain('ANTI_DUPLICATE_TASK');
    });
  });

  describe('CONCURRENT_SUBMIT_SAFETY 并发提交安全', () => {
    it('单次请求默认安全', () => {
      const check = IdempotencyOracle.auditConcurrentSubmitSafety({
        submitAttempts: [{ attempt: 1, taskId: 'task_1', responseStatus: 200 }],
      });

      expect(check.verdict).toBe('PASS');
    });

    it('并发提交时返回相同 taskId 或互斥拦截，判定为 PASS', () => {
      const check = IdempotencyOracle.auditConcurrentSubmitSafety({
        submitAttempts: [
          { attempt: 1, taskId: 'task_same', responseStatus: 200 },
          { attempt: 2, taskId: 'task_same', responseStatus: 200 },
        ],
      });

      expect(check.verdict).toBe('PASS');
    });

    it('并发提交全部穿透并创建了多个不同任务，判定为 FAIL', () => {
      const check = IdempotencyOracle.auditConcurrentSubmitSafety({
        submitAttempts: [
          { attempt: 1, taskId: 'task_1', responseStatus: 200 },
          { attempt: 2, taskId: 'task_2', responseStatus: 200 },
        ],
      });

      expect(check.verdict).toBe('FAIL');
      expect(check.reason).toContain('CONCURRENT_SUBMIT_SAFETY');
    });
  });

  describe('REPLAY_CALLBACK_SAFETY 重复回调幂等', () => {
    it('同一网关回调收到 3 次，只触发 1 次退款，判定为 PASS', () => {
      const events: CallbackEventRecord[] = [
        { callbackId: 'cb_1', taskId: 'task_fail', status: 'FAILED', refundTriggered: true, balanceChanged: 10 },
        { callbackId: 'cb_1', taskId: 'task_fail', status: 'FAILED', refundTriggered: false, balanceChanged: 0 },
        { callbackId: 'cb_1', taskId: 'task_fail', status: 'FAILED', refundTriggered: false, balanceChanged: 0 },
      ];

      const check = IdempotencyOracle.auditReplayCallbackSafety({
        callbacks: events,
      });

      expect(check.verdict).toBe('PASS');
    });

    it('重复回调导致多次退款，判定为 FAIL', () => {
      const events: CallbackEventRecord[] = [
        { callbackId: 'cb_1', taskId: 'task_fail', status: 'FAILED', refundTriggered: true, balanceChanged: 10 },
        { callbackId: 'cb_1', taskId: 'task_fail', status: 'FAILED', refundTriggered: true, balanceChanged: 10 },
      ];

      const check = IdempotencyOracle.auditReplayCallbackSafety({
        callbacks: events,
      });

      expect(check.verdict).toBe('FAIL');
      expect(check.reason).toContain('REPLAY_CALLBACK_SAFETY');
    });
  });

  describe('EVENTUAL_CONSISTENCY 最终一致性', () => {
    it('缺少最终状态快照时判定为 BLOCKED', () => {
      const check = IdempotencyOracle.auditEventualConsistency({});
      expect(check.verdict).toBe('BLOCKED');
    });

    it('最终状态与余额完全吻合，判定为 PASS', () => {
      const finalState: FinalStateRecord = {
        balance: 90,
        expectedBalance: 90,
        taskStatus: 'SUCCEEDED',
        expectedTaskStatus: 'SUCCEEDED',
      };

      const check = IdempotencyOracle.auditEventualConsistency({
        finalState,
      });

      expect(check.verdict).toBe('PASS');
    });

    it('最终余额或状态不一致，判定为 FAIL', () => {
      const finalState: FinalStateRecord = {
        balance: 80,
        expectedBalance: 90,
        taskStatus: 'FAILED',
        expectedTaskStatus: 'SUCCEEDED',
      };

      const check = IdempotencyOracle.auditEventualConsistency({
        finalState,
      });

      expect(check.verdict).toBe('FAIL');
      expect(check.reason).toContain('EVENTUAL_CONSISTENCY');
    });
  });

  describe('evaluate 批量评估', () => {
    it('输入多维记录时能够综合产出完整的 IdempotencyChecks 数组', () => {
      const checks = IdempotencyOracle.evaluate({
        billingEntries: [
          { taskId: 't1', type: 'CHARGE', amount: 10 },
        ],
        createdTasks: [
          { taskId: 't1', status: 'SUCCEEDED' },
        ],
        finalState: {
          balance: 90,
          expectedBalance: 90,
          taskStatus: 'SUCCEEDED',
          expectedTaskStatus: 'SUCCEEDED',
        },
      });

      expect(checks.length).toBe(7);
      expect(checks.some((c) => c.kind === 'ANTI_DOUBLE_BILLING' && c.verdict === 'PASS')).toBe(true);
      expect(checks.some((c) => c.kind === 'ANTI_DUPLICATE_TASK' && c.verdict === 'PASS')).toBe(true);
      expect(checks.some((c) => c.kind === 'EVENTUAL_CONSISTENCY' && c.verdict === 'PASS')).toBe(true);
    });
  });
});
