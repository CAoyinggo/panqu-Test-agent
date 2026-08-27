import { describe, expect, it } from 'vitest';

import { formatReportDate, handoffProblemLevel } from '../../../src/devtest/artifacts.js';
import type { DevTestProblem } from '../../../src/devtest/types.js';

function problem(overrides: Partial<DevTestProblem>): DevTestProblem {
  return {
    id: 'P001',
    type: 'TEST_FAILED',
    severity: 'HIGH',
    dimension: 'FUNCTIONAL',
    message: '确定性断言失败',
    affectedCases: ['CASE-1'],
    failureClass: 'PRODUCT_BUG',
    issueClassification: 'PRODUCT_BUG',
    ...overrides,
  };
}

describe('DevTest developer handoff artifact', () => {
  it.each([
    ['越权/数据隔离产品问题是 P0', problem({ category: 'Permission Error', dimension: 'DATA_ISOLATION' }), {}, 'P0'],
    ['核心主流程产品问题是 P0', problem({}), { 'CASE-1': { core: true, coreKind: 'HAPPY_PATH' } }, 'P0'],
    ['持久化主流程产品问题是 P0', problem({}), { 'CASE-1': { core: true, coreKind: 'PERSISTENCE' } }, 'P0'],
    ['核心参数校验仍是 P2', problem({ category: 'Parameter Validation Error', dimension: 'PARAMETER_VALIDATION' }), { 'CASE-1': { core: true, coreKind: 'CORE_VALIDATION' } }, 'P2'],
    ['非核心业务结果错误是 P1', problem({}), {}, 'P1'],
    ['一般参数校验问题是 P2', problem({ category: 'Parameter Validation Error', dimension: 'PARAMETER_VALIDATION' }), {}, 'P2'],
    ['一般 UI 一致性问题是 P2', problem({ category: 'UI Behavior Error', dimension: 'UI' }), {}, 'P2'],
    ['低风险建议是 P3', problem({ failureClass: 'UNSUPPORTED', issueClassification: 'EXECUTION_ERROR', severity: 'LOW' }), {}, 'P3'],
  ] as const)('%s', (_name, input, caseProfiles, expected) => {
    expect(handoffProblemLevel(input, { caseProfiles: caseProfiles as never })).toBe(expected);
  });

  it('uses the report timezone instead of truncating the UTC date', () => {
    expect(formatReportDate('2026-08-26T16:30:00.000Z', 'Asia/Shanghai')).toBe('2026-08-27');
    expect(formatReportDate('2026-08-26T16:30:00.000Z', 'UTC')).toBe('2026-08-26');
  });
});
