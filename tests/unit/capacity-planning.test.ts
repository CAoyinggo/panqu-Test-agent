import { describe, expect, it } from 'vitest';
import { forecastCapacity } from '../../src/cost/governance.js';

describe('Phase 52 Capacity Planning', () => {
  it('用历史平均、趋势和峰值确定性预测五种周期', () => {
    const samples = [
      { timestamp: '2026-08-19T00:00:00Z', runs: 2, cost: 4, queuePeak: 10, workersPeak: 1 },
      { timestamp: '2026-08-20T00:00:00Z', runs: 4, cost: 8, queuePeak: 30, workersPeak: 2 },
    ];
    for (const horizon of ['1h', '6h', '24h', '7d', '30d'] as const) {
      const forecast = forecastCapacity(samples, horizon, 20);
      expect(forecast.expectedRuns).toBeGreaterThan(0);
      expect(forecast.expectedQueue).toBeGreaterThanOrEqual(30);
      expect(forecast.method).toBe('HISTORICAL_AVERAGE_TREND_PEAK');
    }
  });
});
