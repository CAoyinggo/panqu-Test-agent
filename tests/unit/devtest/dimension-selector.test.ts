import { describe, expect, it } from 'vitest';
import type { TestCase, TestType } from '../../../src/agents/test-design/testcase-schema.js';
import { coreKindOf, deduplicateDevTestCases, devTestDimensionOf, scoreDevTestCase, selectDevTestCases } from '../../../src/devtest/dimension-selector.js';

function testCase(id: string, testType: TestType, priority: TestCase['priority'] = 'P1'): TestCase {
  return {
    id, feature: 'demo', name: id, priority, testType,
    executionMode: testType === 'UI' ? 'DESIGNED_ONLY' : 'EXECUTABLE',
    protocol: 'HTTP', tags: [], steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/api/demo' }],
    assertions: [{ type: 'STATUS_CODE', expected: 200 }],
    contractDependencies: [{ contractId: 'api.demo', version: 'v1', fingerprint: 'fp' }],
  };
}

describe('DevTest five-dimension selection', () => {
  it('将 Acceptance 类型确定性映射到五维', () => {
    expect(devTestDimensionOf('AUTH')).toBe('API');
    expect(devTestDimensionOf('BUSINESS_RULE')).toBe('FUNCTIONAL');
    expect(devTestDimensionOf('UI')).toBe('UI');
    expect(devTestDimensionOf('PERMISSION')).toBe('DATA_ISOLATION');
    expect(devTestDimensionOf('BOUNDARY')).toBe('PARAMETER_VALIDATION');
  });

  it('先覆盖适用五维，再按 P0→P1→P2 裁剪到 maxCases', () => {
    const candidates = [
      testCase('API-P2', 'API', 'P2'), testCase('API-P0', 'AUTH', 'P0'),
      testCase('FUNC', 'FUNCTIONAL', 'P0'), testCase('UI', 'UI', 'P1'),
      testCase('DATA', 'DATA_ISOLATION', 'P0'), testCase('PARAM', 'BOUNDARY', 'P0'),
      ...Array.from({ length: 30 }, (_, index) => testCase(`EXTRA-${index}`, 'PARAMETER', 'P2')),
    ];
    const selection = selectDevTestCases(candidates, { maxCases: 8 });
    expect(selection.selected.length).toBeLessThanOrEqual(8);
    expect(selection.deduplication.removed).toBeGreaterThan(0);
    expect(new Set(selection.selected.map((item) => item.id)).size).toBe(selection.selected.length);
    expect(new Set(selection.selected.map((item) => devTestDimensionOf(item.testType))).size).toBe(5);
    expect(selection.selected.some((item) => item.id === 'API-P0')).toBe(true);
    expect(selection.decisions.find((item) => item.dimension === 'UI')?.applicability).toBe('OPTIONAL');
  });

  it('显式关闭维度并解释跳过原因', () => {
    const selection = selectDevTestCases([testCase('UI', 'UI')], {
      maxCases: 20, enabledDimensions: { UI: false },
    });
    expect(selection.selected).toHaveLength(0);
    expect(selection.decisions.find((item) => item.dimension === 'UI')).toMatchObject({
      applicability: 'NOT_APPLICABLE', enabled: false, selectedCases: 0,
    });
  });

  it('拒绝无界或非法 maxCases', () => {
    expect(() => selectDevTestCases([], { maxCases: 0 })).toThrow('DEVTEST_MAX_CASES_INVALID');
    expect(() => selectDevTestCases([], { maxCases: 101 })).toThrow('DEVTEST_MAX_CASES_INVALID');
  });

  it('Test Value Score 优先高风险、可执行、低成本 Case', () => {
    const read = testCase('READ', 'AUTH', 'P0');
    const ui = testCase('UI', 'UI', 'P0');
    expect(scoreDevTestCase(read).total).toBeGreaterThan(scoreDevTestCase(ui).total);
    expect(scoreDevTestCase(read)).toEqual(expect.objectContaining({
      risk: 5, detectability: 5, executionCost: 1,
    }));
  });

  it('不得将 assertions 不同的 Case 按模糊相似度去重', () => {
    const low = testCase('LOW', 'API', 'P2');
    const high = { ...testCase('HIGH', 'API', 'P0'), assertions: [
      { type: 'STATUS_CODE' as const, expected: 200 },
      { type: 'JSON_PATH' as const, path: '$.id', expected: 'demo' },
    ] };
    const result = deduplicateDevTestCases([low, high]);
    expect(result.retained.map((item) => item.id)).toEqual(['LOW', 'HIGH']);
    expect(result.groups).toEqual([]);
  });

  it('自动识别 Happy Path、核心校验、授权和数据隔离', () => {
    expect(coreKindOf(testCase('HAPPY', 'API', 'P0'))).toBe('HAPPY_PATH');
    expect(coreKindOf(testCase('VALIDATION', 'BOUNDARY', 'P0'))).toBe('CORE_VALIDATION');
    expect(coreKindOf(testCase('AUTH', 'PERMISSION', 'P0'))).toBe('AUTHORIZATION');
    expect(coreKindOf(testCase('PERSIST', 'STATE', 'P0'))).toBe('PERSISTENCE');
    expect(coreKindOf(testCase('ISOLATION', 'DATA_ISOLATION', 'P0'))).toBe('DATA_ISOLATION');
  });
});
