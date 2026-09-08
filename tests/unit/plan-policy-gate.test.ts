// plan-policy-gate 单元测试：execute_test_plan 路径的确定性门禁（无 LLM、无网络）。
// 覆盖验收：environment=test 放行；preonline/prod 永远 BLOCK（APPROVAL_BACKEND_NOT_IMPLEMENTED）；
//           origin 允许列表 fail-closed / 未在列表 BLOCK；CRITICAL/billing/security 风险 BLOCK；
//           budget 取值校验。
import { describe, it, expect } from 'vitest';
import { evaluatePlanPolicyGate, parseAllowedOrigins } from '../../src/agents/plan/plan-policy-gate.js';
import { validatePlan, type NormalizedPlan } from '../../src/agents/plan/plan-contract.js';

function normalize(input: Record<string, unknown>): NormalizedPlan {
  const v = validatePlan(input);
  if (!v.ok) throw new Error('plan should be valid: ' + JSON.stringify(v.errors));
  return v.normalized;
}

function basePlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirement_summary: '测试需求',
    target_url: 'https://api.example.com/',
    environment: 'test',
    test_scope: 'api',
    test_cases: [
      {
        id: 'C1',
        name: '健康检查',
        priority: 'P1',
        type: 'API',
        steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/health' }],
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 200 }],
      },
    ],
    risks: [],
    ...overrides,
  };
}

const ALLOWED = new Set(['https://api.example.com']);

describe('plan-policy-gate：environment', () => {
  it('environment=test + 允许列表 + GET → ALLOW', () => {
    const result = evaluatePlanPolicyGate(normalize(basePlan()), { allowedTargetOrigins: ALLOWED });
    expect(result.verdict).toBe('ALLOW');
    expect(result.blockingReasons).toHaveLength(0);
  });

  it('preonline 永远 BLOCK（APPROVAL_BACKEND_NOT_IMPLEMENTED）', () => {
    const result = evaluatePlanPolicyGate(normalize(basePlan({ environment: 'preonline' })), { allowedTargetOrigins: ALLOWED });
    expect(result.verdict).toBe('BLOCK');
    const env = result.checks.find((c) => c.name === 'environment');
    expect(env?.passed).toBe(false);
    expect(result.blockingReasons.join(' ')).toContain('APPROVAL_BACKEND_NOT_IMPLEMENTED');
  });

  it('prod 永远 BLOCK', () => {
    const result = evaluatePlanPolicyGate(normalize(basePlan({ environment: 'prod' })), { allowedTargetOrigins: ALLOWED });
    expect(result.verdict).toBe('BLOCK');
    expect(result.blockingReasons.join(' ')).toContain('APPROVAL_BACKEND_NOT_IMPLEMENTED');
  });
});

describe('plan-policy-gate：origin 允许列表', () => {
  it('未配置允许列表 fail-closed', () => {
    const result = evaluatePlanPolicyGate(normalize(basePlan()), {});
    expect(result.verdict).toBe('BLOCK');
    expect(result.blockingReasons.join(' ')).toContain('未配置');
  });

  it('origin 不在允许列表 BLOCK', () => {
    const result = evaluatePlanPolicyGate(normalize(basePlan({ target_url: 'https://evil.example.com/' })), {
      allowedTargetOrigins: ALLOWED,
    });
    expect(result.verdict).toBe('BLOCK');
    expect(result.blockingReasons.join(' ')).toContain('不在服务端允许列表');
  });

  it('parseAllowedOrigins 解析逗号分隔 origin 并去除尾部斜杠', () => {
    const s = parseAllowedOrigins('https://test.panqu.com, https://example.com/ ');
    expect(s.has('https://test.panqu.com')).toBe(true);
    expect(s.has('https://example.com')).toBe(true);
    expect(parseAllowedOrigins('')).toEqual(new Set());
  });
});

describe('plan-policy-gate：风险', () => {
  it('CRITICAL 风险 BLOCK', () => {
    const result = evaluatePlanPolicyGate(normalize(basePlan({
      risks: [{ id: 'R1', level: 'CRITICAL', category: '稳定性', description: 'x', affected_cases: ['C1'] }],
    })), { allowedTargetOrigins: ALLOWED });
    expect(result.verdict).toBe('BLOCK');
    expect(result.checks.find((c) => c.name === 'risk_level')?.passed).toBe(false);
  });

  it('billing 风险 BLOCK', () => {
    const result = evaluatePlanPolicyGate(normalize(basePlan({
      risks: [{ id: 'R1', level: 'MEDIUM', category: 'billing', description: '扣费', affected_cases: ['C1'] }],
    })), { allowedTargetOrigins: ALLOWED });
    expect(result.verdict).toBe('BLOCK');
    expect(result.checks.find((c) => c.name === 'billing')?.passed).toBe(false);
  });

  it('security 风险 BLOCK', () => {
    const result = evaluatePlanPolicyGate(normalize(basePlan({
      risks: [{ id: 'R1', level: 'MEDIUM', category: 'security', description: '越权', affected_cases: ['C1'] }],
    })), { allowedTargetOrigins: ALLOWED });
    expect(result.verdict).toBe('BLOCK');
    expect(result.checks.find((c) => c.name === 'security')?.passed).toBe(false);
  });
});

describe('plan-policy-gate：budget 取值', () => {
  it('budget_cases 非正整数 BLOCK', () => {
    const result = evaluatePlanPolicyGate(normalize(basePlan()), { allowedTargetOrigins: ALLOWED, budgetCases: 0 });
    expect(result.verdict).toBe('BLOCK');
    expect(result.checks.find((c) => c.name === 'budget')?.passed).toBe(false);
  });
});