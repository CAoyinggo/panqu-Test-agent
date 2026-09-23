import { describe, expect, it } from 'vitest';
import { BillingOracle, type ScoreLogEntry } from '../../../src/devtest/billing.js';

describe('Billing - 计费预估、流水对账与供应商成本核算', () => {
  describe('1. 刊例扣费基准计算 (calculateExpectedPoints)', () => {
    it('Wan 3.0 (84): 480p=7/s, 720p=14/s, 1080p=27/s', () => {
      expect(
        BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 84, duration: 4, resolution: '480p' }),
      ).toBe(28);
      expect(
        BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 84, duration: 5, resolution: '720p' }),
      ).toBe(70);
      expect(
        BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 84, duration: 4, resolution: '1080p' }),
      ).toBe(108);
    });

    it('Wan 3.0 Prime (88): 480p=11/s, 720p=22/s, 1080p=44/s', () => {
      expect(
        BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 88, duration: 4, resolution: '480p' }),
      ).toBe(44);
      expect(
        BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 88, duration: 4, resolution: '720p' }),
      ).toBe(88);
      expect(
        BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 88, duration: 4, resolution: '1080p' }),
      ).toBe(176);
    });

    it('Seedance 2.0 (15): 480p=15/s, 720p=30/s', () => {
      expect(
        BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 15, duration: 4, resolution: '480p' }),
      ).toBe(60);
      expect(
        BillingOracle.calculateExpectedPoints({ mediaType: 'video', modelId: 15, duration: 4, resolution: '720p' }),
      ).toBe(120);
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

  describe('3. 钱包前后余额 (balanceBefore / balanceAfter) 与账单净扣一致性契约', () => {
    it('余额差额与流水净扣一致时：balanceAuxiliary 忠实记录差额且数值严格对齐 netDeductedPoints', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 2001, type: 2, score: -56 }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 2001,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
        balanceBefore: 1000,
        balanceAfter: 944,
      });
      expect(res.passed).toBe(true);
      expect(res.status).toBe('PASS');
      expect(res.netDeductedPoints).toBe(56);
      expect(res.balanceAuxiliary?.balanceBefore).toBe(1000);
      expect(res.balanceAuxiliary?.balanceAfter).toBe(944);
      expect(res.balanceAuxiliary?.balanceDelta).toBe(56);
      expect(res.balanceAuxiliary?.balanceDelta).toBe(res.netDeductedPoints);
      expect(res.balanceAuxiliary?.note).toBe('钱包余额变化: 1000 -> 944 (差额 56 pts)');
    });

    it('失败任务退款后净扣归零：钱包差额为 0 且与流水净扣 0 严格一致', () => {
      const logs: ScoreLogEntry[] = [
        { task_id: 2002, type: 2, score: -56 },
        { task_id: 2002, type: 1, score: 56 },
      ];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 2002,
        expectedPoints: 56,
        terminalStatus: 'FAILED',
        scoreLogs: logs,
        balanceBefore: 1000,
        balanceAfter: 1000,
      });
      expect(res.passed).toBe(true);
      expect(res.status).toBe('PASS');
      expect(res.netDeductedPoints).toBe(0);
      expect(res.netChargeZero).toBe(true);
      expect(res.balanceAuxiliary?.balanceDelta).toBe(0);
      expect(res.balanceAuxiliary?.balanceDelta).toBe(res.netDeductedPoints);
      expect(res.balanceAuxiliary?.note).toBe('钱包余额变化: 1000 -> 1000 (差额 0 pts)');
    });

    it('余额差额与账单净扣不一致：代码当前行为将差额作为辅助元数据导出，两者产生显式偏离', () => {
      // 场景：钱包多扣 100 点，但流水仅记录扣除 56 点
      const logs: ScoreLogEntry[] = [{ task_id: 2003, type: 2, score: -56 }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 2003,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
        balanceBefore: 1000,
        balanceAfter: 900, // 差额 100 pts
      });
      // 当前代码契约：三大不变量基于流水判定为 PASS，balanceAuxiliary 透传差额供调用方或下游断言核验
      expect(res.status).toBe('PASS');
      expect(res.netDeductedPoints).toBe(56);
      expect(res.balanceAuxiliary?.balanceDelta).toBe(100);
      expect(res.balanceAuxiliary?.balanceDelta).not.toBe(res.netDeductedPoints);
      expect(res.balanceAuxiliary?.note).toBe('钱包余额变化: 1000 -> 900 (差额 100 pts)');
    });

    it('失败任务流水账面归零但钱包未退款：捕捉流水净扣与钱包差额矛盾', () => {
      // 场景：流水显示全退款净扣 0，但用户钱包实际未退款（仍少了 56 点）
      const logs: ScoreLogEntry[] = [
        { task_id: 2004, type: 2, score: -56 },
        { task_id: 2004, type: 1, score: 56 },
      ];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 2004,
        expectedPoints: 56,
        terminalStatus: 'FAILED',
        scoreLogs: logs,
        balanceBefore: 1000,
        balanceAfter: 944, // 差额 56 pts
      });
      expect(res.netChargeZero).toBe(true); // 流水层面核销净扣为 0
      expect(res.netDeductedPoints).toBe(0);
      expect(res.balanceAuxiliary?.balanceDelta).toBe(56); // 钱包实际存在 56 点差额
      expect(res.balanceAuxiliary?.balanceDelta).not.toBe(res.netDeductedPoints);
    });

    it('字段缺失边界：仅提供 balanceBefore 时，balanceDelta 为 undefined', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 2005, type: 2, score: -56 }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 2005,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
        balanceBefore: 1000,
        balanceAfter: undefined,
      });
      expect(res.balanceAuxiliary?.balanceBefore).toBe(1000);
      expect(res.balanceAuxiliary?.balanceAfter).toBeUndefined();
      expect(res.balanceAuxiliary?.balanceDelta).toBeUndefined();
      expect(res.balanceAuxiliary?.note).toBe('未提供钱包前后余额');
    });

    it('字段缺失边界：仅提供 balanceAfter 时，balanceDelta 为 undefined', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 2006, type: 2, score: -56 }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 2006,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
        balanceBefore: undefined,
        balanceAfter: 944,
      });
      expect(res.balanceAuxiliary?.balanceBefore).toBeUndefined();
      expect(res.balanceAuxiliary?.balanceAfter).toBe(944);
      expect(res.balanceAuxiliary?.balanceDelta).toBeUndefined();
      expect(res.balanceAuxiliary?.note).toBe('未提供钱包前后余额');
    });

    it('零余额边界：balanceBefore 与 balanceAfter 均为 0 时合法计算差额为 0', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 2007, type: 2, score: 0, memo: '免扣任务' }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 2007,
        expectedPoints: 0,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
        balanceBefore: 0,
        balanceAfter: 0,
        expectedChargeSource: 'REAL_BILLING_FACT',
      });
      expect(res.balanceAuxiliary?.balanceBefore).toBe(0);
      expect(res.balanceAuxiliary?.balanceAfter).toBe(0);
      expect(res.balanceAuxiliary?.balanceDelta).toBe(0);
      expect(res.balanceAuxiliary?.note).toBe('钱包余额变化: 0 -> 0 (差额 0 pts)');
    });

    it('非法值边界：传入 NaN 或异常逆向变化时忠实计算并导出', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 2008, type: 2, score: -56 }];
      // 场景 1: NaN
      const resNaN = BillingOracle.reconcileTaskLedger({
        taskId: 2008,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
        balanceBefore: NaN,
        balanceAfter: 944,
      });
      expect(Number.isNaN(resNaN.balanceAuxiliary?.balanceDelta)).toBe(true);

      // 场景 2: 逆向增长（扣费任务余额反而增加）
      const resNegative = BillingOracle.reconcileTaskLedger({
        taskId: 2008,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
        balanceBefore: 500,
        balanceAfter: 600, // 差额 -100 pts
      });
      expect(resNegative.balanceAuxiliary?.balanceDelta).toBe(-100);
      expect(resNegative.balanceAuxiliary?.note).toBe('钱包余额变化: 500 -> 600 (差额 -100 pts)');
    });
  });

  describe('4. 高风险边界与异常流水对账 (重复去重、少扣多扣、免扣与异步结算)', () => {
    it('失败任务 0 预扣且有确凿事实证明无需扣费 (REAL_BILLING_FACT + 0 pt)：判定 PASS', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 3001, type: 2, score: 0, memo: '免扣任务' }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 3001,
        expectedPoints: 0,
        terminalStatus: 'FAILED',
        scoreLogs: logs,
        expectedChargeSource: 'REAL_BILLING_FACT',
      });
      expect(res.passed).toBe(true);
      expect(res.status).toBe('PASS');
      expect(res.antiDoubleBilling).toBe(true);
      expect(res.netChargeZero).toBe(true);
      expect(res.refundIdempotency).toBe(true);
    });

    it('成功任务预扣未落盘但声明 allowAsyncPending：标记异步入账处理中并判定 UNVERIFIED', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 3002, type: 3, score: 0, memo: '任务进行中尚未结算' }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 3002,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
        allowAsyncPending: true,
      });
      expect(res.passed).toBe(false);
      expect(res.status).toBe('UNVERIFIED');
      expect(res.asyncSettlementPending).toBe(true);
      expect(res.netChargeZero).toBeUndefined();
      expect(res.reasons.some((r) => r.includes('成功任务预扣流水尚未落盘，标记异步入账处理中'))).toBe(true);
    });

    it('失败任务退款未落盘但声明 allowAsyncPending：标记异步处理中并判定 UNVERIFIED', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 3003, type: 3, score: 0, memo: '挂起中' }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 3003,
        expectedPoints: 56,
        terminalStatus: 'FAILED',
        scoreLogs: logs,
        allowAsyncPending: true,
      });
      expect(res.passed).toBe(false);
      expect(res.status).toBe('UNVERIFIED');
      expect(res.asyncSettlementPending).toBe(true);
      expect(res.netChargeZero).toBeUndefined();
      expect(res.reasons.some((r) => r.includes('失败任务预扣与退款流水尚未落盘，标记异步处理中'))).toBe(true);
    });

    it('成功任务少扣费：应扣 56 实际扣 28，触发 underCharged 且判定 FAIL', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 3004, type: 2, score: -28 }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 3004,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.status).toBe('FAIL');
      expect(res.underCharged).toBe(true);
      expect(res.netChargeZero).toBe(false);
      expect(res.reasons.some((r) => r.includes('少扣费: 应扣 56 积分，实际净扣 28 积分'))).toBe(true);
    });

    it('成功任务多扣费：应扣 28 实际扣 56，触发 overCharged 且判定 FAIL', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 3005, type: 2, score: -56 }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 3005,
        expectedPoints: 28,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.status).toBe('FAIL');
      expect(res.overCharged).toBe(true);
      expect(res.netChargeZero).toBe(false);
      expect(res.reasons.some((r) => r.includes('多扣费: 应扣 28 积分，实际净扣 56 积分 (超扣 28)'))).toBe(true);
    });

    it('并发/重试未去重：同一 clientToken / idempotency_key 触发多次扣费判定 FAIL', () => {
      const logs: ScoreLogEntry[] = [
        { task_id: 3006, type: 2, score: -56, client_token: 'req-token-xyz-123' },
        { task_id: 3006, type: 2, score: -56, idempotency_key: 'req-token-xyz-123' },
      ];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 3006,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.status).toBe('FAIL');
      expect(res.antiDoubleBilling).toBe(false);
      expect(res.duplicateCharged).toBe(true);
      expect(
        res.reasons.some((r) =>
          r.includes('检测到并发/重试未去重: 同一 clientToken (req-token-xyz-123) 触发了多次扣费'),
        ),
      ).toBe(true);
    });

    it('失败任务无预扣却存在退款流水：违背退款幂等不变量，判定 FAIL', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 3007, type: 1, score: 56 }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 3007,
        expectedPoints: 56,
        terminalStatus: 'FAILED',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.status).toBe('FAIL');
      expect(res.refundIdempotency).toBe(false);
      expect(
        res.reasons.some((r) =>
          r.includes('[INVARIANT_VIOLATED: REFUND_IDEMPOTENCY] 失败任务缺失有效预扣却存在退款记录'),
        ),
      ).toBe(true);
    });

    it('失败任务多次预扣：退款幂等与净扣归零双重违背判定 FAIL', () => {
      const logs: ScoreLogEntry[] = [
        { task_id: 3008, type: 2, score: -56 },
        { task_id: 3008, type: 2, score: -56 },
        { task_id: 3008, type: 1, score: 56 },
      ];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 3008,
        expectedPoints: 56,
        terminalStatus: 'FAILED',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.status).toBe('FAIL');
      expect(res.antiDoubleBilling).toBe(false);
      expect(res.refundIdempotency).toBe(false);
      expect(res.netChargeZero).toBe(false);
      expect(res.reasons.some((r) => r.includes('存在多次预扣，退款幂等核销失效'))).toBe(true);
      expect(res.reasons.some((r) => r.includes('存在重复预扣费，失败净扣无法正常归零'))).toBe(true);
    });

    it('流水全部不匹配目标任务 ID：记录未匹配原因并保持 UNVERIFIED', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 99999, type: 2, score: -56 }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 3009,
        expectedPoints: 56,
        terminalStatus: 'SUCCESS',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.status).toBe('UNVERIFIED');
      expect(res.reasons.some((r) => r.includes('提供了 1 条积分流水，但没有任何记录匹配任务 ID 3009'))).toBe(true);
      expect(res.reasons.some((r) => r.includes('未找到匹配任务 ID 3009 的有效流水记录 [UNVERIFIED]'))).toBe(true);
    });

    it('任务终态为 UNKNOWN 等非终结态：不变量标记为 undefined 且判定 UNVERIFIED', () => {
      const logs: ScoreLogEntry[] = [{ task_id: 3010, type: 2, score: -56 }];
      const res = BillingOracle.reconcileTaskLedger({
        taskId: 3010,
        expectedPoints: 56,
        terminalStatus: 'UNKNOWN',
        scoreLogs: logs,
      });
      expect(res.passed).toBe(false);
      expect(res.status).toBe('UNVERIFIED');
      expect(res.netChargeZero).toBeUndefined();
      expect(res.refundIdempotency).toBeUndefined();
      expect(res.reasons.some((r) => r.includes('任务终态为 UNKNOWN，无法核验账务不变量 [UNVERIFIED]'))).toBe(true);
    });
  });
});
