import { describe, expect, it } from 'vitest';
import { selectByValueCost } from '../../src/cost/governance.js';

describe('Phase 52 Cost-aware Selection', () => {
  it('在 maxCost 内按风险、变化、覆盖和性价比选择 A+B', () => {
    const result = selectByValueCost([
      { id: 'A', risk: 0.9, change: 1, coverage: 1, criticality: 1, cost: 5 },
      { id: 'B', risk: 0.8, change: 1, coverage: 0.9, criticality: 0.8, cost: 4 },
      { id: 'C', risk: 0.2, change: 0.1, coverage: 0.2, criticality: 0.1, cost: 4 },
    ], 10);
    expect(result.selected.map((v) => v.id).sort()).toEqual(['A', 'B']);
    expect(result.totalCost).toBe(9);
    expect(result.trace.find((v) => v.id === 'C')?.selected).toBe(false);
  });
});
