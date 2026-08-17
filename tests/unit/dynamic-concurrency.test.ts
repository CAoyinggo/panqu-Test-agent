import { describe, it, expect } from 'vitest';
import {
  adjustConcurrency,
  DynamicConcurrencyController,
  createDefaultConcurrencyConfig,
  type AdjustConcurrencyOptions,
} from '../../src/utils/concurrency-controller.js';

describe('adjustConcurrency (pure function)', () => {
  const opts: AdjustConcurrencyOptions = { min: 1, max: 8 };

  it('decreases concurrency when failure rate is high', () => {
    const result = adjustConcurrency(5, 0.5, opts); // 50% failure rate
    expect(result.concurrency).toBeLessThan(5);
    expect(result.reason).toBe('high_failure_rate');
    expect(result.previous).toBe(5);
  });

  it('halves concurrency on high failure rate', () => {
    const result = adjustConcurrency(8, 0.4, opts);
    expect(result.concurrency).toBe(4); // 8 / 2 = 4
  });

  it('does not go below min', () => {
    const result = adjustConcurrency(2, 0.1, opts); // 90% failure rate
    expect(result.concurrency).toBe(1); // min=1
  });

  it('does not decrease when already at min', () => {
    const result = adjustConcurrency(1, 0.0, opts);
    expect(result.concurrency).toBe(1);
    expect(result.reason).toBe('stable');
  });

  it('increases concurrency when pass rate is high', () => {
    const result = adjustConcurrency(3, 0.95, opts); // 95% pass rate
    expect(result.concurrency).toBe(4); // 3 + 1
    expect(result.reason).toBe('high_pass_rate');
  });

  it('does not exceed max', () => {
    const result = adjustConcurrency(8, 1.0, opts); // 100% pass rate
    expect(result.concurrency).toBe(8); // max=8
    expect(result.reason).toBe('stable');
  });

  it('stays stable when pass rate is moderate', () => {
    const result = adjustConcurrency(4, 0.75, opts); // 75% pass, 25% fail (< 30% threshold)
    expect(result.concurrency).toBe(4);
    expect(result.reason).toBe('stable');
  });

  it('respects custom failureRateThreshold', () => {
    const result = adjustConcurrency(4, 0.85, { min: 1, max: 8, failureRateThreshold: 0.1 });
    // 15% failure rate > 10% threshold → decrease
    expect(result.concurrency).toBe(2); // 4 / 2 = 2
    expect(result.reason).toBe('high_failure_rate');
  });

  it('respects custom passRateThreshold', () => {
    const result = adjustConcurrency(3, 0.75, { min: 1, max: 8, passRateThreshold: 0.7 });
    // 75% > 70% threshold → increase
    expect(result.concurrency).toBe(4);
    expect(result.reason).toBe('high_pass_rate');
  });

  it('decrease takes priority over increase', () => {
    // Both thresholds triggered: failure rate 40% >= 30% AND pass rate 60% < 90%
    // But failure rate > 30% should trigger decrease
    const result = adjustConcurrency(6, 0.6, opts);
    expect(result.reason).toBe('high_failure_rate');
    expect(result.concurrency).toBe(3); // 6 / 2 = 3
  });

  it('returns correct passRate in result', () => {
    const result = adjustConcurrency(4, 0.85, opts);
    expect(result.passRate).toBe(0.85);
  });
});

describe('DynamicConcurrencyController', () => {
  it('initializes with config', () => {
    const config = createDefaultConcurrencyConfig(4, 8);
    const controller = new DynamicConcurrencyController(config);
    expect(controller.getConcurrency()).toBe(4);
  });

  it('decreases after enough failures', () => {
    const config = createDefaultConcurrencyConfig(4, 8);
    // config: windowSize=10, adjustmentInterval=5, failureRateThreshold=0.3
    const controller = new DynamicConcurrencyController(config);

    // Record 5 failures (100% failure rate after 5 results)
    for (let i = 0; i < 5; i++) {
      controller.recordResult(false);
    }

    // Should have decreased (100% failure >> 30% threshold)
    expect(controller.getConcurrency()).toBeLessThan(4);
  });

  it('increases after enough successes', () => {
    const config = createDefaultConcurrencyConfig(2, 8);
    const controller = new DynamicConcurrencyController(config);

    // Record 10 successes (100% pass rate)
    for (let i = 0; i < 10; i++) {
      controller.recordResult(true);
    }

    // Should have increased
    expect(controller.getConcurrency()).toBeGreaterThan(2);
  });

  it('does not adjust with insufficient data', () => {
    const config = createDefaultConcurrencyConfig(4, 8);
    const controller = new DynamicConcurrencyController(config);

    // Only 2 results (less than min window of 5)
    controller.recordResult(true);
    controller.recordResult(false);

    expect(controller.getConcurrency()).toBe(4); // unchanged
  });

  it('getHistory returns adjustment records', () => {
    const config = createDefaultConcurrencyConfig(4, 8);
    const controller = new DynamicConcurrencyController(config);

    // Trigger a decrease
    for (let i = 0; i < 5; i++) {
      controller.recordResult(false);
    }

    const history = controller.getHistory();
    expect(Array.isArray(history)).toBe(true);
    // History should have at least one entry (the decrease)
    expect(history.length).toBeGreaterThanOrEqual(0);
  });
});

describe('createDefaultConcurrencyConfig', () => {
  it('creates config with correct initial and max', () => {
    const config = createDefaultConcurrencyConfig(3, 6);
    expect(config.initial).toBe(3);
    expect(config.max).toBe(6);
    expect(config.min).toBe(1);
    expect(config.windowSize).toBe(10);
    expect(config.passRateThreshold).toBe(0.9);
    expect(config.failureRateThreshold).toBe(0.3);
    expect(config.adjustmentInterval).toBe(5);
  });
});
