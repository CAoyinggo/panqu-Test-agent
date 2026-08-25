import { describe, expect, it } from 'vitest';
import {
  evaluateExecutionPolicy,
  type Requirement,
  type RiskAssessment,
  type RiskItem,
  type TestCase,
} from '../../src/agents/index.js';
import type { ExecutionPlan } from '../../src/agents/execution/execution-schema.js';
import { executionPlanFingerprint } from '../../src/agents/execution/execution-schema.js';
import { EXECUTION_POLICY_VERSION } from '../../src/agents/policy/policy-gate.js';
import type { DataPlan } from '../../src/agents/data/data-schema.js';

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    feature: 'profile',
    goal: '验证用户资料查询',
    capabilities: ['query'],
    inputs: [],
    requirements: [],
    businessRules: [],
    dependencies: [],
    constraints: [],
    risks: [],
    source: '验证用户资料查询',
    ...overrides,
  };
}

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-01',
    feature: 'profile',
    name: '查询用户资料',
    priority: 'P2',
    tags: [],
    steps: [{ action: 'query', scene: 'default' }],
    assertions: [{ target: 'response', path: 'code', operator: 'equals', expected: 0 }],
    ...overrides,
  };
}

function assessment(items: RiskItem[] = [], recommendedSkip = false): RiskAssessment {
  const high = items.filter((item) => item.level === 'high').length;
  const medium = items.filter((item) => item.level === 'medium').length;
  const low = items.filter((item) => item.level === 'low').length;
  return {
    feature: 'profile',
    risks: items,
    issues: [],
    summary: { high, medium, low, overall: high ? 'high' : medium ? 'medium' : 'low', recommendedSkip },
  };
}

function risk(category: RiskItem['category'], level: RiskItem['level'] = 'high'): RiskItem {
  return {
    id: `risk-${category}`,
    category,
    level,
    title: `${category} risk`,
    desc: `${category} risk`,
    mitigation: 'review',
  };
}

function approved(id: string, environment = 'test', plan?: ExecutionPlan) {
  return {
    status: 'APPROVED' as const,
    id,
    approvedBy: 'policy-reviewer',
    environment,
    executionPlanFingerprint: plan ? executionPlanFingerprint(plan) : undefined,
    policyVersion: EXECUTION_POLICY_VERSION,
    createdAt: '2026-08-23T00:00:00.000Z',
    expiresAt: '2099-08-23T00:00:00.000Z',
  };
}

function executionPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    order: ['tc-01'], concurrency: 1, enableRetry: true, reason: 'policy contract',
    policy: { realExecution: true },
    ...overrides,
  };
}

function dataPlan(factoryName = 'default'): DataPlan {
  return {
    feature: 'profile', needsSetup: true, factoryName,
    setupActions: [], teardownActions: [], caseAssignments: [], generateParams: {}, dataContext: {},
  };
}

describe('execution policy gate contract', () => {
  it('allows a low-risk test execution', () => {
    const result = evaluateExecutionPolicy({
      requirement: requirement(),
      risk: assessment(),
      testCases: [testCase()],
      environment: 'test',
    });
    expect(result.verdict).toBe('ALLOW');
    expect(result.allowed).toBe(true);
  });

  it('hard-blocks an explicit no-real-execution constraint even with approval', () => {
    const result = evaluateExecutionPolicy({
      requirement: requirement({ constraints: ['禁止真实执行'] }),
      risk: assessment(),
      testCases: [testCase()],
      approval: approved('apr-1'),
    });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasons).toContain('Requirement 明确禁止真实执行');
  });

  it('hard-blocks a test-only constraint in production before approval can apply', () => {
    const result = evaluateExecutionPolicy({
      requirement: requirement({ constraints: ['仅限测试环境执行'] }),
      risk: assessment(),
      testCases: [testCase()],
      environment: 'production',
      approval: approved('apr-prod'),
    });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasons).toContain('Requirement 仅允许测试环境执行，当前为 production');
  });

  it('turns recommendedSkip into approval-required and permits only after approval', () => {
    const input = {
      requirement: requirement(),
      risk: assessment([risk('concurrency')], true),
      testCases: [testCase({ priority: 'P0' as const })],
      environment: 'test',
    };
    expect(evaluateExecutionPolicy(input).verdict).toBe('APPROVAL_REQUIRED');
    expect(evaluateExecutionPolicy({ ...input, approval: approved('apr-2') }).verdict).toBe('ALLOW');
  });

  it('requires approval for production + risky operation', () => {
    const plan = executionPlan();
    const input = {
      requirement: requirement(),
      risk: assessment([risk('timeout')]),
      testCases: [testCase()],
      environment: 'production',
      executionPlan: plan,
    };
    const pending = evaluateExecutionPolicy(input);
    expect(pending.verdict).toBe('APPROVAL_REQUIRED');
    expect(pending.reasons).toContain('production + risky operation 默认拒绝，必须人工审批');
    expect(evaluateExecutionPolicy({ ...input, approval: approved('apr-prod', 'production', plan) }).verdict).toBe('ALLOW');
  });

  it('hard-blocks production billing unless project policy explicitly allows it', () => {
    const plan = executionPlan();
    const input = {
      requirement: requirement({ businessRules: ['积分正确扣减'] }),
      risk: assessment([risk('billing')], true),
      testCases: [testCase({ assertions: [{ target: 'billing', path: 'amount', operator: 'gt', expected: 0 }] })],
      environment: 'production',
      executionPlan: plan,
      approval: approved('apr-billing', 'production', plan),
    };
    expect(evaluateExecutionPolicy(input).verdict).toBe('BLOCK');
    expect(evaluateExecutionPolicy({ ...input, projectPolicy: { allowRealBilling: true } }).verdict).toBe('ALLOW');
  });

  it('treats project allowHighRiskOperations=false as a non-overridable block', () => {
    const result = evaluateExecutionPolicy({
      requirement: requirement(),
      risk: assessment([risk('timeout')]),
      testCases: [testCase()],
      projectPolicy: { allowHighRiskOperations: false },
      approval: approved('apr-cannot-override'),
    });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasons).toContain('项目策略禁止高风险操作');
  });

  it('blocks unverified required data isolation before execution', () => {
    const input = {
      requirement: requirement({ constraints: ['必须数据隔离'] }),
      risk: assessment([risk('security')]),
      testCases: [testCase()],
      projectPolicy: { requireDataIsolation: true },
      approval: approved('apr-security'),
    };
    expect(evaluateExecutionPolicy(input).verdict).toBe('BLOCK');
    expect(evaluateExecutionPolicy({
      ...input,
      projectPolicy: { requireDataIsolation: true, dataIsolationVerified: true },
    }).verdict).toBe('ALLOW');
  });

  it('allows dry-run without overriding a project ban on real execution', () => {
    const result = evaluateExecutionPolicy({
      requirement: requirement(),
      risk: assessment([risk('billing')], true),
      testCases: [testCase()],
      dryRun: true,
      projectPolicy: { allowRealExecution: false, allowRealBilling: false },
    });
    expect(result.realExecution).toBe(false);
    expect(result.verdict).toBe('ALLOW');
  });

  it('does not accept an APPROVED flag without approval identity evidence', () => {
    const result = evaluateExecutionPolicy({
      requirement: requirement(),
      risk: assessment([risk('timeout')]),
      testCases: [testCase()],
      approval: { status: 'APPROVED' },
    });
    expect(result.verdict).toBe('APPROVAL_REQUIRED');
    expect(result.checks.find((check) => check.name === 'humanApproval')?.detail).toContain('缺少');
  });

  it('blocks a tampered Execution Plan before execution', () => {
    const result = evaluateExecutionPolicy({
      requirement: requirement(), risk: assessment(), testCases: [testCase()],
      executionPlan: executionPlan({ order: ['unknown-case'] }),
    });
    expect(result.verdict).toBe('BLOCK');
    expect(result.checks.find((check) => check.name === 'executionPlan'))
      .toMatchObject({ passed: false, blocking: true });
  });

  it('blocks execution when the real-time budget is already exhausted', () => {
    const result = evaluateExecutionPolicy({
      requirement: requirement(), risk: assessment(), testCases: [testCase()],
      executionPlan: executionPlan(),
      budgetStatus: {
        tokensUsed: 100, llmCalls: 1, agentCalls: 3, toolCalls: 0, casesUsed: 0,
        durationMs: 10, exceeded: ['maxTokens'], exceededAny: true,
      },
    });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasons).toContain('执行前预算已耗尽：maxTokens');
  });

  it('blocks a Data Plan whose factory is outside the project data-policy allowlist', () => {
    const result = evaluateExecutionPolicy({
      requirement: requirement(), risk: assessment(), testCases: [testCase()],
      executionPlan: executionPlan(), dataPlan: dataPlan('unsafe-factory'),
      projectPolicy: { allowedDataFactories: ['isolated-test-data'] },
    });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasons).toContain('数据工厂 unsafe-factory 不在项目白名单');
  });

  it('dry-run 只审核计划，不因数据工厂白名单触发真实准备阻断', () => {
    const result = evaluateExecutionPolicy({
      requirement: requirement(), risk: assessment(), testCases: [testCase()],
      dryRun: true,
      executionPlan: executionPlan({ dryRun: true }),
      dataPlan: dataPlan('planning-only-factory'),
      projectPolicy: { allowedDataFactories: ['isolated-test-data'] },
    });
    expect(result.verdict).toBe('ALLOW');
    expect(result.realExecution).toBe(false);
  });
});
