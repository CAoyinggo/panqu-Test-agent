import { describe, expect, it } from 'vitest';
import {
  checkDslExecutable,
  filterDslExecutable,
  generateTestCases,
  generateTestCasesWithBusiness,
  identifyBusiness,
} from '../../src/agents/index.js';
import type { Requirement } from '../../src/agents/requirement/requirement-schema.js';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';

function requirement(partial: Partial<Requirement> = {}): Requirement {
  const value = {
    feature: 'Resource', goal: '验证 Requirement 声明的业务结果', version: 'v1',
    capabilities: [], inputs: [], requirements: [], businessRules: [], dependencies: [], constraints: [], risks: [],
    ...partial,
  };
  return {
    ...value,
    capabilities: value.capabilities ?? [], inputs: value.inputs ?? [], requirements: value.requirements ?? [],
    businessRules: value.businessRules ?? [], dependencies: value.dependencies ?? [],
  };
}

function expectExecutable(cases: TestCase[]): void {
  for (const testCase of cases) expect(checkDslExecutable(testCase).executable).toBe(true);
}

describe('通用业务识别与确定性生成器', () => {
  it('任何显式业务域都使用同一 generic 生成器，不按产品或功能分发', () => {
    for (const feature of ['User', 'Order', 'Document', 'Tenant Resource']) {
      expect(identifyBusiness(feature)).toMatchObject({ kind: 'generic', feature, isVideo: false, processorScene: null });
    }
  });

  it('空业务域保持 unknown，不猜测默认产品', () => {
    expect(identifyBusiness('')).toMatchObject({ kind: 'unknown', processorScene: null });
    expect(identifyBusiness('unknown')).toMatchObject({ kind: 'unknown', processorScene: null });
  });

  it('输入组合、边界、依赖和并发只由 Requirement 触发', () => {
    const generated = generateTestCasesWithBusiness(requirement({
      requirements: [{ name: 'quantity', values: [1, 2, 5] }],
      dependencies: ['Resource Service'],
      businessRules: ['并发操作必须互不污染'],
      capabilities: ['concurrency'],
    }));
    expect(generated.business.kind).toBe('generic');
    expect(generated.generatorKind).toBe('generic');
    expect(generated.cases.some((item) => item.tags.includes('boundary'))).toBe(true);
    expect(generated.cases.some((item) => item.tags.includes('dependency'))).toBe(true);
    expect(generated.cases.some((item) => item.tags.includes('concurrency'))).toBe(true);
    expectExecutable(generated.cases);

    const minimal = generateTestCases(requirement());
    expect(minimal.some((item) => item.tags.includes('concurrency'))).toBe(false);
  });

  it('生成输入字段只来自 Requirement，不注入功能专属字段', () => {
    const declared = new Set(['resourceName', 'quantity']);
    const cases = generateTestCases(requirement({
      requirements: [{ name: 'resourceName', values: ['alpha'] }, { name: 'quantity', values: [1, 2] }],
    }));
    const inputKeys = cases.flatMap((item) => item.steps.flatMap((step) => step.input ? Object.keys(step.input) : []));
    expect(inputKeys.every((key) => declared.has(key))).toBe(true);
    expectExecutable(cases);
  });
});

describe('checkDslExecutable compatibility gate', () => {
  const base = {
    id: 'tc-1', feature: 'Resource', name: 'requirement-derived case', priority: 'P0' as const,
    tags: [], steps: [{ action: 'submit', input: {} }], assertions: [],
  };

  it('合法既有 DSL 用例通过', () => {
    expect(checkDslExecutable({ ...base, assertions: [{ operator: 'exists', target: 'submit', path: 'result' }] }).executable).toBe(true);
  });

  it('缺执行锚点、wait 条件或确定性 expected 时 fail-close', () => {
    expect(checkDslExecutable({ ...base, steps: [{ action: 'query' }] }).executable).toBe(false);
    expect(checkDslExecutable({ ...base, steps: [{ action: 'submit' }, { action: 'wait' }] }).executable).toBe(false);
    expect(checkDslExecutable({ ...base, assertions: [{ operator: 'equals', target: 'submit', path: 'result' }] }).executable).toBe(false);
  });

  it('filterDslExecutable 过滤不可执行项并返回原因', () => {
    const drops: string[] = [];
    const valid = { ...base, assertions: [{ operator: 'exists' as const, target: 'submit' as const, path: 'result' }] };
    const kept = filterDslExecutable([valid as TestCase, { ...valid, id: 'bad', steps: [] } as TestCase],
      (_testCase, problems) => drops.push(...problems));
    expect(kept).toHaveLength(1);
    expect(drops.length).toBeGreaterThan(0);
  });
});
