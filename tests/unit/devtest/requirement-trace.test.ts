/**
 * Panqu AI DevTest — Requirement Trace & Impact Analysis 测试套件 (wardenIQ 原生吸收)
 *
 * 核心架构边界验证 (docs/ARCHITECTURE_FREEZE.md):
 * 1. 最小数据模型：requirementId -> testIds -> sourceRefs；
 * 2. 纯函数影响分析：changedPaths -> affectedTests、coverageGaps、riskInputs；
 * 3. 零基础设施依赖：绝对不接数据库、UI或任务管理系统；
 * 4. 覆盖缺口与风险输入精确输出，输出对象深层冻结。
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeImpact,
  buildRequirementTraceIndex,
  type RequirementTrace,
} from '../../../src/devtest/requirement-trace.js';
import type { CanonicalTestSpec } from '../../../src/devtest/canonical-protocol.js';

describe('Requirement Trace & Impact Analysis 测试套件 (wardenIQ 原生吸收)', () => {
  const sampleTraces: RequirementTrace[] = [
    {
      requirementId: 'REQ-BILLING-001',
      description: '账单幂等退款与反重复计费审计',
      testIds: ['test-billing-idempotent-001', 'test-billing-anti-double-002'],
      sourceRefs: ['src/devtest/billing.ts'],
    },
    {
      requirementId: 'REQ-ROUTING-001',
      description: '渠道消歧与 NewAPI 网关分流决策',
      testIds: ['test-routing-disambiguation-001'],
      sourceRefs: ['src/devtest/routing.ts'],
    },
    {
      requirementId: 'REQ-ORPHAN-001',
      description: '有源码但暂未编写测试用例的需求',
      testIds: [], // 空测试列表，测试覆盖缺口
      sourceRefs: ['src/devtest/orphan-module.ts'],
    },
  ];

  const sampleSpecs: CanonicalTestSpec[] = [
    {
      testId: 'test-billing-idempotent-001',
      requirementId: 'REQ-BILLING-001',
      scenario: 'BILLING_IDEMPOTENT_CHECK',
      environment: 'offline',
      executionMode: 'FIXTURE',
      target: { targetType: 'scenario' },
      inputs: {},
      deterministicAssertions: [
        {
          field: 'refundCount',
          operator: 'EQUALS',
          expectedValue: 1,
          critical: true,
        },
      ],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['BILLING_LEDGER:TASK_RECORDS'],
    },
    {
      testId: 'test-billing-anti-double-002',
      requirementId: 'REQ-BILLING-001',
      scenario: 'BILLING_ONLINE_SUBMIT',
      environment: 'real',
      executionMode: 'REAL', // 触发 UNSAFE_EXECUTION_MODE 风险
      target: { targetType: 'scenario' },
      inputs: {},
      deterministicAssertions: [
        {
          field: 'chargeCount',
          operator: 'EQUALS',
          expectedValue: 1,
          critical: true,
        },
      ],
      costLimit: { maxCostPoints: 20 }, // 触发 POSITIVE_COST_LIMIT 风险
      sideEffectPolicy: 'ALLOW_PAID', // 触发 PAID_OR_SUBMIT_SIDE_EFFECT 风险
      requiredEvidence: ['BILLING_LEDGER:TASK_RECORDS'],
    },
    {
      testId: 'test-routing-disambiguation-001',
      requirementId: 'REQ-ROUTING-001',
      scenario: 'ROUTING_DISAMBIGUATION',
      environment: 'offline',
      executionMode: 'FIXTURE',
      target: { targetType: 'scenario' },
      inputs: {},
      deterministicAssertions: [
        // 缺少 critical 断言，触发 MISSING_CRITICAL_ASSERTIONS 风险
        {
          field: 'channelName',
          operator: 'EQUALS',
          expectedValue: 'default',
          critical: false,
        },
      ],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['SERVER_API:ROUTING_FACT'],
    },
  ];

  // --------------------------------------------------------------------------
  // 1. 基础模型与索引表构建
  // --------------------------------------------------------------------------
  it('1. buildRequirementTraceIndex 正确构建以 requirementId 为键的不可变索引', () => {
    const index = buildRequirementTraceIndex(sampleTraces);
    expect(index.size).toBe(3);
    expect(index.has('REQ-BILLING-001')).toBe(true);
    expect(index.get('REQ-BILLING-001')?.sourceRefs).toContain('src/devtest/billing.ts');
  });

  // --------------------------------------------------------------------------
  // 2. 影响分析：精确输出受影响测试用例与关联需求
  // --------------------------------------------------------------------------
  it('2. 当变更 billing.ts 时，analyzeImpact 纯函数精确输出受影响需求与用例', () => {
    const result = analyzeImpact({
      changedPaths: ['src/devtest/billing.ts'],
      traces: sampleTraces,
      testSpecs: sampleSpecs,
    });

    expect(result.changedPaths).toEqual(['src/devtest/billing.ts']);
    expect(result.affectedRequirements).toEqual(['REQ-BILLING-001']);
    expect(result.affectedTests).toEqual([
      'test-billing-anti-double-002',
      'test-billing-idempotent-001',
    ]);
    expect(result.coverageGaps).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 3. 覆盖缺口检测：未关联 trace 的变更文件
  // --------------------------------------------------------------------------
  it('3. 当变更未受追踪的文件时，analyzeImpact 精确报告覆盖缺口 (coverageGaps)', () => {
    const result = analyzeImpact({
      changedPaths: ['src/devtest/new-untracked-feature.ts'],
      traces: sampleTraces,
      testSpecs: sampleSpecs,
    });

    expect(result.affectedTests).toHaveLength(0);
    expect(result.coverageGaps).toHaveLength(1);
    expect(result.coverageGaps[0].changedPath).toBe('src/devtest/new-untracked-feature.ts');
    expect(result.coverageGaps[0].reason).toContain('缺少测试覆盖');
  });

  // --------------------------------------------------------------------------
  // 4. 覆盖缺口检测：需求存在但 testIds 为空
  // --------------------------------------------------------------------------
  it('4. 当变更命中了没有测试用例的需求时，精确报告用例缺失缺口', () => {
    const result = analyzeImpact({
      changedPaths: ['src/devtest/orphan-module.ts'],
      traces: sampleTraces,
      testSpecs: sampleSpecs,
    });

    expect(result.affectedRequirements).toContain('REQ-ORPHAN-001');
    expect(result.affectedTests).toHaveLength(0);
    expect(result.coverageGaps).toHaveLength(1);
    expect(result.coverageGaps[0].requirementId).toBe('REQ-ORPHAN-001');
    expect(result.coverageGaps[0].reason).toContain('未关联任何测试用例');
  });

  // --------------------------------------------------------------------------
  // 5. 风险输入分析：四类核心风险精确识别
  // --------------------------------------------------------------------------
  it('5. analyzeImpact 纯函数精确识别受影响测试中的四类风险输入', () => {
    const result = analyzeImpact({
      changedPaths: ['src/devtest/billing.ts', 'src/devtest/routing.ts'],
      traces: sampleTraces,
      testSpecs: sampleSpecs,
    });

    expect(result.affectedTests).toHaveLength(3);

    const riskTypes = result.riskInputs.map((r) => r.riskType);
    expect(riskTypes).toContain('PAID_OR_SUBMIT_SIDE_EFFECT');
    expect(riskTypes).toContain('POSITIVE_COST_LIMIT');
    expect(riskTypes).toContain('MISSING_CRITICAL_ASSERTIONS');
    expect(riskTypes).toContain('UNSAFE_EXECUTION_MODE');

    // 验证特定用例的具体风险
    const billingAntiDoubleRisks = result.riskInputs.filter(
      (r) => r.testId === 'test-billing-anti-double-002'
    );
    expect(billingAntiDoubleRisks.some((r) => r.riskType === 'PAID_OR_SUBMIT_SIDE_EFFECT')).toBe(true);
    expect(billingAntiDoubleRisks.some((r) => r.riskType === 'POSITIVE_COST_LIMIT')).toBe(true);
    expect(billingAntiDoubleRisks.some((r) => r.riskType === 'UNSAFE_EXECUTION_MODE')).toBe(true);

    const routingRisks = result.riskInputs.filter(
      (r) => r.testId === 'test-routing-disambiguation-001'
    );
    expect(routingRisks.some((r) => r.riskType === 'MISSING_CRITICAL_ASSERTIONS')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 6. 确定性与纯函数保障：无副作用且输出冻结
  // --------------------------------------------------------------------------
  it('6. 影响分析为严格只读纯函数，不依赖外部系统，结果对象深层冻结', () => {
    const result = analyzeImpact({
      changedPaths: ['./src/devtest/billing.ts'],
      traces: sampleTraces,
      testSpecs: sampleSpecs,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.changedPaths)).toBe(true);
    expect(Object.isFrozen(result.affectedRequirements)).toBe(true);
    expect(Object.isFrozen(result.affectedTests)).toBe(true);
    expect(Object.isFrozen(result.coverageGaps)).toBe(true);
    expect(Object.isFrozen(result.riskInputs)).toBe(true);
  });
});
