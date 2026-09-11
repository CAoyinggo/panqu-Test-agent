import { describe, expect, it } from 'vitest';
import { BillingOracle } from '../../../src/devtest/billing-oracle.js';

describe('BillingOracle - 独立计费预估与流水级对账器', () => {
  describe('刊例价独立计算', () => {
    it('Wan 3.0 (ID 84) 计费标准：480P=7/s, 720P=14/s, 1080P=27/s', () => {
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 84, duration: 4, resolution: '480p' })).toBe(28);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 84, duration: 4, resolution: '720p' })).toBe(56);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 84, duration: 4, resolution: '1080p' })).toBe(108);
    });

    it('Wan 3.0 Prime (ID 88) 计费标准：480P=11/s, 720P=22/s, 1080P=44/s', () => {
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 88, duration: 4, resolution: '480p' })).toBe(44);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 88, duration: 4, resolution: '720p' })).toBe(88);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 88, duration: 4, resolution: '1080p' })).toBe(176);
    });

    it('Seedance 2.0 (ID 15) 计费标准：480P=15/s, 720P=30/s', () => {
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 15, duration: 4, resolution: '480p' })).toBe(60);
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 15, duration: 4, resolution: '720p' })).toBe(120);
    });

    it('图片模型标准刊例价为 5 积分/张', () => {
      expect(BillingOracle.calculateExpectedPoints({ mediaType: 'image', modelId: 12 })).toBe(5);
    });
  });

  describe('流水对账与异常审计', () => {
    const taskId = 8888;
    const expectedPoints = 28;

    it('成功任务预扣与结算完全匹配时对账 PASS', () => {
      const report = BillingOracle.reconcileTaskLedger({
        taskId,
        expectedPoints,
        terminalStatus: 'SUCCESS',
        scoreLogs: [
          { task_id: taskId, type: 2, score: -28, memo: '预扣' },
        ],
        balanceBefore: 1000,
        balanceAfter: 972,
      });

      expect(report.passed).toBe(true);
      expect(report.status).toBe('PASS');
      expect(report.netDeductedPoints).toBe(28);
      expect(report.underCharged).toBe(false);
      expect(report.overCharged).toBe(false);
      expect(report.duplicateCharged).toBe(false);
      expect(report.balanceAuxiliary?.balanceDelta).toBe(28);
    });

    it('检测到重复预扣费时触发 DUPLICATE_CHARGED 并判 FAIL', () => {
      const report = BillingOracle.reconcileTaskLedger({
        taskId,
        expectedPoints,
        terminalStatus: 'SUCCESS',
        scoreLogs: [
          { id: 1, task_id: taskId, type: 2, score: -28 },
          { id: 2, task_id: taskId, type: 2, score: -28 }, // 重复预扣
        ],
      });

      expect(report.passed).toBe(false);
      expect(report.status).toBe('FAIL');
      expect(report.duplicateCharged).toBe(true);
      expect(report.reasons.some((r) => r.includes('重复预扣费'))).toBe(true);
    });

    it('检测到超额多扣费时触发 OVER_CHARGED 并判 FAIL', () => {
      const report = BillingOracle.reconcileTaskLedger({
        taskId,
        expectedPoints: 28,
        terminalStatus: 'SUCCESS',
        scoreLogs: [
          { task_id: taskId, type: 2, score: -44 }, // 应扣 28 却扣了 44
        ],
      });

      expect(report.passed).toBe(false);
      expect(report.status).toBe('FAIL');
      expect(report.overCharged).toBe(true);
      expect(report.reasons.some((r) => r.includes('多扣费'))).toBe(true);
    });

    it('检测到少扣费时触发 UNDER_CHARGED 并判 FAIL', () => {
      const report = BillingOracle.reconcileTaskLedger({
        taskId,
        expectedPoints: 28,
        terminalStatus: 'SUCCESS',
        scoreLogs: [
          { task_id: taskId, type: 2, score: -14 }, // 应扣 28 却只扣了 14
        ],
      });

      expect(report.passed).toBe(false);
      expect(report.status).toBe('FAIL');
      expect(report.underCharged).toBe(true);
      expect(report.reasons.some((r) => r.includes('少扣费'))).toBe(true);
    });

    it('任务失败但未退还预扣积分时触发 MISSING_REFUND 并判 FAIL', () => {
      const report = BillingOracle.reconcileTaskLedger({
        taskId,
        expectedPoints: 28,
        terminalStatus: 'FAILED',
        scoreLogs: [
          { task_id: taskId, type: 2, score: -28 }, // 扣除未退
        ],
      });

      expect(report.passed).toBe(false);
      expect(report.status).toBe('FAIL');
      expect(report.missingRefund).toBe(true);
      expect(report.reasons.some((r) => r.includes('任务失败漏退款'))).toBe(true);
    });

    it('任务失败且积分全额退还时对账 PASS (净扣除=0)', () => {
      const report = BillingOracle.reconcileTaskLedger({
        taskId,
        expectedPoints: 28,
        terminalStatus: 'FAILED',
        scoreLogs: [
          { task_id: taskId, type: 2, score: -28 }, // 预扣
          { task_id: taskId, type: 1, score: 28 },  // 退款
        ],
      });

      expect(report.passed).toBe(true);
      expect(report.status).toBe('PASS');
      expect(report.netDeductedPoints).toBe(0);
      expect(report.missingRefund).toBe(false);
    });

    it('检测到重复退款时触发 DUPLICATE_REFUNDED 并判 FAIL', () => {
      const report = BillingOracle.reconcileTaskLedger({
        taskId,
        expectedPoints: 28,
        terminalStatus: 'FAILED',
        scoreLogs: [
          { task_id: taskId, type: 2, score: -28 },
          { task_id: taskId, type: 1, score: 28 },
          { task_id: taskId, type: 1, score: 28 }, // 重复退款
        ],
      });

      expect(report.passed).toBe(false);
      expect(report.status).toBe('FAIL');
      expect(report.duplicateRefunded).toBe(true);
      expect(report.reasons.some((r) => r.includes('重复退款'))).toBe(true);
    });
  });
});
