import { describe, expect, it } from 'vitest';
import { ChaosSimulator } from '../../../src/devtest/chaos-simulator.js';

describe('ChaosSimulator - NewAPI 网关多渠道故障与降级容灾演练器', () => {
  it('注入主力渠道 429 限流：网关自动无感故障转移至备用渠道，严格保证单次扣费 (防双扣)', async () => {
    const result = await ChaosSimulator.simulate({
      chaosType: 'UPSTREAM_429_RATE_LIMIT',
      modelId: 84,
      mediaType: 'video',
      mock: true,
    });

    expect(result.ok).toBe(true);
    expect(result.resiliencePassed).toBe(true);
    expect(result.initialChannel.status).toBe('FAILED');
    expect(result.initialChannel.error).toContain('429');
    expect(result.failoverChannel).toBeDefined();
    expect(result.failoverChannel?.status).toBe('SUCCESS');
    expect(result.invariantsChecked.antiDoubleBilling).toBe(true);
  });

  it('注入全渠道瘫痪 (ALL_CHANNELS_DOWN)：系统优雅降级回退直连保护，触发退款净扣归零', async () => {
    const result = await ChaosSimulator.simulate({
      chaosType: 'ALL_CHANNELS_DOWN',
      modelId: 84,
      mediaType: 'video',
      mock: true,
    });

    expect(result.ok).toBe(true);
    expect(result.resiliencePassed).toBe(true);
    expect(result.initialChannel.status).toBe('DOWN');
    expect(result.fallbackToDirect).toBe(true);
    expect(result.invariantsChecked.netChargeZeroOnFailure).toBe(true);
    expect(result.billingReconciled).toBe(true);
  });
});
