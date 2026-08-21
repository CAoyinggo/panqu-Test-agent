import { describe, expect, it } from 'vitest';
import { ModelPolicyRegistry } from '../../src/cost/governance.js';

describe('Phase 52 Model Cost / Quality Router', () => {
  it('简单任务选择低成本模型，关键 RCA 按策略选择强模型并解释原因', () => {
    const registry = new ModelPolicyRegistry();
    registry.set({ domain: 'RCA', primaryModel: 'strong', fallbackModel: 'cheap', maxCost: 5, maxLatencyMs: 1000, environment: 'PRODUCTION', status: 'ACTIVE' });
    const candidates = [{ model: 'cheap', quality: 90, cost: 1, latencyMs: 400 }, { model: 'strong', quality: 94, cost: 5, latencyMs: 800 }];
    expect(registry.route({ domain: 'Requirement', complexity: 'SIMPLE', candidates }).selectedModel).toBe('cheap');
    const rca = registry.route({ domain: 'RCA', complexity: 'CRITICAL', candidates });
    expect(rca.selectedModel).toBe('strong');
    expect(rca.trace.join(' ')).toContain('quality=94');
  });
});
