import { describe, expect, it } from 'vitest';
import {
  BillingOracle,
  type ScoreLogEntry,
} from '../../../src/devtest/billing.js';

describe('Billing - 计费预估、流水对账与供应商成本核算', () => {
  describe('1. 刊例扣费基准计算 (calculateExpectedPoints)', () => {
    it('Wan 3.0 (84): 480p=7/s, 720p=14/s, 1080p=27/s', () => {
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 84, duration: 4, resolution: '480p' })).toBe(28);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 84, duration: 5, resolution: '720p' })).toBe(70);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 84, duration: 4, resolution: '1080p' })).toBe(108);
    });

    it('Wan 3.0 Prime (88): 480p=11/s, 720p=22/s, 1080p=44/s', () => {
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 88, duration: 4, resolution: '480p' })).toBe(44);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 88, duration: 4, resolution: '720p' })).toBe(88);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 88, duration: 4, resolution: '1080p' })).toBe(176);
    });

    it('Seedance 2.0 (15): 480p=15/s, 720p=30/s', () => {
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 15, duration: 4, resolution: '480p' })).toBe(60);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 15, duration: 4, resolution: '720p' })).toBe(120);
    });

    it('图片模型: Model 201=5分, Model 205 (1k=10分, 2k=15分)', () => {
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'image', modelId: 201 })).toBe(5);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'image', modelId: 205, resolution: '1k' })).toBe(10);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'image', modelId: 205, resolution: '2k' })).toBe(15);
    });
  });

  describe('2. 专属任务流水对账与三大不变量 (reconcileTaskLedger)', () => {
    it('成功任务正常预扣：通过核销', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 1001, type: 2, score: -56 }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 1001,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(true);
      expect(res.netDeductedPoints).toBe(56);
      expect(res.antiDoubleBilling).toBe(true);
      expect(res.netChargeZero).toBe(true);
      expect(res.refundIdempotency).toBe(true);
    });

    it('失败任务全额退款：净扣为 0 判定通过 (netChargeZero)', () => {
      const logs: ScoreLogEntry[] = [
        { task_id: 1002, type: 2, score: -56 },
        { task_id: 1002, type: 1, score: 56 },
      ];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 1002,
        expectedPoints: 56,
        terminalStatus: 'FAILED',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(true);
      expect(res.netDeductedPoints).toBe(0);
      expect(res.netChargeZero).toBe(true);
    });

    it('防重复扣费不变量违背：多次预扣 (antiDoubleBilling=false)', () => {
      const logs: ScoreLogEntry[] = [
        { task_id: 1003, type: 2, score: -56 },
        { task_id: 1003, type: 2, score: -56 },
      ];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 1003,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.antiDoubleBilling).toBe(false);
      expect(res.duplicateCharged).toBe(true);
    });

    it('退款幂等不变量违背：多次退款 (refundIdempotency=false)', () => {
      const logs: ScoreLogEntry[] = [
        { task_id: 1004, type: 2, score: -56 },
        { task_id: 1004, type: 1, score: 56 },
        { task_id: 1004, type: 1, score: 56 },
      ];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 1004,
        expectedPoints: 56,
        terminalStatus: 'FAILED',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.refundIdempotency).toBe(false);
      expect(res.duplicateRefunded).toBe(true);
    });

    it('失败漏退款违背：netChargeZero=false', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 1005, type: 2, score: -56 }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 1005,
        expectedPoints: 56,
        terminalStatus: 'FAILED',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.netChargeZero).toBe(false);
      expect(res.missingRefund).toBe(true);
    });

    it('0 次预扣且期望扣费大于 0：不能仅凭 <=1 自动 PASS，判定 UNVERIFIED', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 1006, type: 3, score: 0, memo: '任务初始化未扣费' }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 1006,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
        expectedChargeSource: 'DEVTEST_EXPECTATION',
      });
      expect(res.passed).toBe(false);
      expect(res.antiDoubleBilling).toBeUndefined();
      expect(res.status).toBe('FAIL'); // 因 missing pre-deduct (underCharged) 导致 FAIL
    });

    it('0 次预扣且有确凿事实证明无需扣费 (REAL_BILLING_FACT + 0 pt)：判定 PASS', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 1007, type: 2, score: 0, memo: '免计费任务' }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 1007,
        expectedPoints: 0,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
        expectedChargeSource: 'REAL_BILLING_FACT',
      });
      expect(res.passed).toBe(true);
      expect(res.antiDoubleBilling).toBe(true);
      expect(res.netChargeZero).toBe(true);
      expect(res.refundIdempotency).toBe(true);
      expect(res.status).toBe('PASS');
    });

    it('失败任务无真实扣费记录：即便数学 sum=0 也绝不判定 PASS，而是 UNVERIFIED', () => {
      const logs: ScoreLogEntry[] = [];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 1008,
        expectedPoints: 56,
        terminalStatus: 'FAILED',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.netChargeZero).toBeUndefined();
      expect(res.antiDoubleBilling).toBeUndefined();
      expect(res.refundIdempotency).toBeUndefined();
      expect(res.status).toBe('UNVERIFIED');
    });

    it('失败任务超额退款 (netCharge < 0)：判定 FAIL', () => {
      const logs: ScoreLogEntry[] = [
        { task_id: 1009, type: 2, score: -28 },
        { task_id: 1009, type: 1, score: 56 },
      ];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 1009,
        expectedPoints: 28,
        terminalStatus: 'FAILED',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.netChargeZero).toBe(false);
      expect(res.status).toBe('FAIL');
    });

    it('成功任务异常触发退款：判定 FAIL', () => {
      const logs: ScoreLogEntry[] = [
        { task_id: 1010, type: 2, score: -28 },
        { task_id: 1010, type: 1, score: 28 },
      ];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 1010,
        expectedPoints: 28,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.refundIdempotency).toBe(false);
      expect(res.status).toBe('FAIL');
    });
  });
});
