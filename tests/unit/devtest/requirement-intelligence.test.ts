import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';
import { parseAcceptanceRequirement } from '../../../src/acceptance/requirement-parser.js';
import { buildDevTestInvariants, buildRequirementCoverageMatrix, extendedDimensionsOf } from '../../../src/devtest/requirement-intelligence.js';

function caseFor(acId: string, assertions: TestCase['assertions']): TestCase {
  return {
    id: `CASE-${acId}`, feature: '权限更新', name: acId, priority: 'P0', testType: 'API', tags: [],
    executionMode: 'EXECUTABLE', protocol: 'HTTP',
    source: { requirementId: 'REQ-1', acceptanceCriteriaIds: [acId], testPointId: `TP-${acId}`, sourceType: 'REQUIREMENT' },
    steps: [{ type: 'HTTP_REQUEST', method: 'PATCH', url: '/api/resources/1' }], assertions,
  } as TestCase;
}

describe('DevTest requirement intelligence', () => {
  it('把每条 AC 映射为 Expected Behavior，并显式报告未覆盖 AC', () => {
    const requirement = parseAcceptanceRequirement(`# 权限更新\n\n## Acceptance Criteria\n\n- AC-1 管理员 PATCH /api/resources/1 返回 200。\n- AC-2 普通用户 PATCH /api/resources/1 返回 403。`);
    const testCase = caseFor('AC-1', [{ type: 'STATUS_CODE', expected: 200 }]);
    const matrix = buildRequirementCoverageMatrix({ requirement, testCases: [testCase], profiles: {
      [testCase.id]: { caseId: testCase.id, signature: 'one', informationScore: 1, core: true },
    } });
    expect(matrix.behaviors[0]).toEqual(expect.objectContaining({
      acId: 'AC-1', actor: expect.any(String), action: expect.stringContaining('PATCH'), expectedResponse: expect.stringContaining('200'),
    }));
    expect(matrix.uncoveredAc).toEqual(['AC-2']);
    expect(matrix.coreCoverage).toBe(50);
  });

  it('发现只断言 403 但未验证拒绝后状态不变，并补充 Non-Mutation 设计断言', () => {
    const requirement = parseAcceptanceRequirement(`# 权限更新\n\n## Acceptance Criteria\n\n- AC-1 普通用户 PATCH /api/resources/1 返回 403，403 后数据不能修改。`);
    const testCase = caseFor('AC-1', [{ type: 'STATUS_CODE', expected: 403 }]);
    const matrix = buildRequirementCoverageMatrix({ requirement, testCases: [testCase], profiles: {
      [testCase.id]: { caseId: testCase.id, signature: 'one', informationScore: 1, core: true },
    } });
    expect(matrix.behaviors[0].missingAssertions).toContain('MISSING_POST_STATE_ASSERTION');
    expect(matrix.behaviors[0].supplementalAssertions).toContainEqual(expect.objectContaining({ kind: 'NON_MUTATION' }));
    expect(matrix.blockedAc).toEqual(['AC-1']);
  });

  it('仅在 Requirement/Invariant 有依据时启用扩展维度，并提取关键业务不变量', () => {
    const requirement = parseAcceptanceRequirement(`# 支付任务\n\n## 业务规则\n\n- 失败不能扣费。\n- 重复提交只能创建一个任务。\n\n## Acceptance Criteria\n\n- AC-1 重复 POST /api/tasks 返回同一任务。`);
    const testCase = caseFor('AC-1', [{ type: 'STATUS_CODE', expected: 200 }]);
    const invariants = buildDevTestInvariants({ requirement, testCases: [testCase] });
    expect(invariants.map((item) => item.kind)).toEqual(expect.arrayContaining(['BILLING', 'IDEMPOTENCY']));
    const dimensions = extendedDimensionsOf(requirement, invariants, [testCase]);
    expect(dimensions.find((item) => item.dimension === 'BILLING')?.applicable).toBe(true);
    expect(dimensions.find((item) => item.dimension === 'IDEMPOTENCY')?.applicable).toBe(true);
    expect(dimensions.find((item) => item.dimension === 'AUDIT')?.applicable).toBe(false);
  });
});
