import { describe, expect, it } from 'vitest';
import {
  aggregateCapacitySamples,
  aggregateDailyCostCapacity,
  forecastCapacities,
  forecastCapacity,
  type CapacitySample,
  type CostAttribution,
} from '../../src/cost/governance.js';

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

  it('多 horizon 仅遍历一次历史样本，并复用同一聚合结果', () => {
    const samples: CapacitySample[] = [
      { timestamp: '2026-08-20T00:00:00Z', runs: 4, cost: 8, queuePeak: 30, workersPeak: 2 },
      { timestamp: '2026-08-19T00:00:00Z', runs: 2, cost: 4, queuePeak: 10, workersPeak: 1 },
    ];
    let iterations = 0;
    const singleUseIterable: Iterable<CapacitySample> = {
      *[Symbol.iterator]() {
        iterations += 1;
        yield* samples;
      },
    };

    const forecasts = forecastCapacities(singleUseIterable);

    expect(iterations).toBe(1);
    expect(forecasts).toHaveLength(5);
    for (const forecast of forecasts) {
      expect(forecast).toEqual(forecastCapacity(samples, forecast.horizon));
    }
    expect(aggregateCapacitySamples(samples)).toMatchObject({
      sampleCount: 2,
      totalRuns: 6,
      totalCost: 12,
      peakQueue: 30,
      first: { timestamp: '2026-08-19T00:00:00Z' },
      last: { timestamp: '2026-08-20T00:00:00Z' },
    });
  });

  it('成本记录一次按天聚合，并按唯一 runId 计数', () => {
    const record = (id: string, runId: string | undefined, timestamp: string, totalCost: number): CostAttribution => ({
      id,
      projectId: 'wan3',
      runId,
      category: 'LLM',
      quantity: totalCost,
      unitCost: 1,
      totalCost,
      currency: 'USD',
      timestamp,
    });
    const samples = aggregateDailyCostCapacity([
      record('a', 'run-1', '2026-08-20T01:00:00Z', 1),
      record('b', 'run-1', '2026-08-20T02:00:00Z', 2),
      record('c', 'run-2', '2026-08-20T03:00:00Z', 3),
      record('d', undefined, '2026-08-21T01:00:00Z', 4),
    ]);

    expect(samples).toEqual([
      { timestamp: '2026-08-20T00:00:00.000Z', runs: 2, cost: 6, queuePeak: 0, workersPeak: 1 },
      { timestamp: '2026-08-21T00:00:00.000Z', runs: 0, cost: 4, queuePeak: 0, workersPeak: 1 },
    ]);
  });
});
