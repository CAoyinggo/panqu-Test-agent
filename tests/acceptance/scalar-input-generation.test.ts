import { describe, expect, it } from 'vitest';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';

function compile(type: string, min = '', max = '', values = '', defaultValue = '', location = 'body') {
  const markdown = `# 参数校验
POST /validate
无需认证。
| 参数 | 位置 | 类型 | 必填 | 可空 | 最小值 | 最大值 | 枚举 | 默认值 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| value | ${location} | ${type} | 是 | 否 | ${min} | ${max} | ${values} | ${defaultValue} |
返回 201、400。
AC-1 value 合法时返回 201。
AC-2 value 非法、类型错误或不在枚举中时返回 400。`;
  const requirement = parseAcceptanceRequirement(markdown, { documentId: 'scalar-input.md' });
  return { requirement, cases: generateAcceptanceApiCases(requirement, generateTestPoints(requirement, buildAcceptanceTestDesign(requirement))) };
}

describe('scalar input vectors obey the entire explicit contract', () => {
  it('never calls enum-excluded numeric boundaries successful and generates a single-fault enum violation', () => {
    const { requirement, cases } = compile('integer', '1', '3', '1,3', '1');
    expect(requirement.apis[0].body[0]).toMatchObject({ min: 1, max: 3, enum: [1, 3] });
    const inputs = cases.filter((item) => item.executionMode === 'EXECUTABLE' && item.parameterContext);
    expect(inputs.length).toBeGreaterThan(0);
    for (const item of inputs) if (item.parameterContext!.expectedOutcome === 'ACCEPT') {
      expect([1, 3]).toContain(item.parameterContext!.testData);
    }
    expect(cases.some((item) => (item.parameterCoverage ?? []).some((coverage) =>
      coverage.boundaryVectors.includes('ENUM_INVALID') && coverage.testData === 2 && coverage.expectedOutcome === 'REJECT'))).toBe(true);
  });

  it('does not label an allowed integer decimal sample as a rejection outside its claimed dimension', () => {
    const { cases } = compile('integer', '1', '2');
    const decimals = cases.flatMap((item) => (item.parameterCoverage ?? []).filter((p) => p.boundaryVectors.includes('DECIMAL')));
    expect(decimals.length).toBeGreaterThan(0);
    for (const item of decimals) {
      expect(Number.isInteger(item.testData)).toBe(false);
      expect(Number(item.testData)).toBeGreaterThanOrEqual(1);
      expect(Number(item.testData)).toBeLessThanOrEqual(2);
    }
  });

  it('tests both boolean values and explicit null/wrong-type rejection without replacing false defaults', () => {
    const { cases } = compile('boolean', '', '', '', 'false');
    const inputs = cases.flatMap((item) => item.parameterCoverage ?? []);
    expect(inputs.filter((item) => item.expectedOutcome === 'ACCEPT').map((item) => item.testData)).toEqual(expect.arrayContaining([true, false]));
    expect(inputs.filter((item) => item.expectedOutcome === 'REJECT').map((item) => item.testData)).toEqual(expect.arrayContaining([null, 'false']));
    // These are write requests: generated negatives must retain the Observer gate.
    expect(cases.filter((item) => item.parameterContext?.expectedOutcome === 'REJECT')
      .every((item) => item.executionMode === 'DESIGNED_ONLY')).toBe(true);
  });

  it('does not fabricate a successful integer baseline for an interval containing no integer', () => {
    const { cases } = compile('integer', '0.1', '0.9');
    expect(cases.filter((item) => item.executionMode === 'EXECUTABLE' && item.parameterContext?.expectedOutcome === 'ACCEPT')).toEqual([]);
  });

  it('keeps missing-field coverage separate from an unavailable decimal sample', () => {
    const { cases } = compile('integer', '1', '3', '1,3');
    const missing = cases.filter((item) => item.parameterCoverage?.some((p) => p.boundaryVectors.includes('MISSING')));
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((item) => !item.design?.reason?.includes('SINGLE_FAULT_VECTOR_UNAVAILABLE'))).toBe(true);
    const decimal = cases.filter((item) => item.parameterContext?.boundaryVector === 'DECIMAL');
    expect(decimal.length).toBeGreaterThan(0);
    expect(decimal.every((item) => item.executionMode === 'DESIGNED_ONLY'
      && item.design?.reason?.includes('SINGLE_FAULT_VECTOR_UNAVAILABLE'))).toBe(true);
  });

  it('does not claim a bound-only rejection when the input also violates enum', () => {
    const { cases } = compile('integer', '1', '3', '1,3');
    const mixed = cases.filter((item) => ['MIN_MINUS', 'MAX_PLUS'].includes(item.parameterContext?.boundaryVector ?? ''));
    expect(mixed.length).toBeGreaterThan(0);
    expect(mixed.every((item) => item.executionMode === 'DESIGNED_ONLY'
      && item.design?.reason?.includes('SINGLE_FAULT_VECTOR_UNAVAILABLE'))).toBe(true);
  });

  it.each([['boolean', '', '', 'true,false'], ['integer', '1', '2', '1,2']])(
    'retains an explicit gap when %s enum exhausts the legal domain', (type, min, max, values) => {
      const { cases } = compile(type, min, max, values);
      const invalid = cases.filter((item) => item.parameterContext?.boundaryVector === 'ENUM_INVALID');
      expect(invalid.length).toBeGreaterThan(0);
      expect(invalid.every((item) => item.executionMode === 'DESIGNED_ONLY'
        && item.design?.reason?.includes('SINGLE_FAULT_VECTOR_UNAVAILABLE'))).toBe(true);
    });

  it.each([['0.1', '2.9'], ['', '-2']])('uses legal integer baselines for min=%s max=%s', (min, max) => {
    const { cases } = compile('integer', min, max);
    const accepted = cases.filter((item) => item.executionMode === 'EXECUTABLE' && item.parameterContext?.expectedOutcome === 'ACCEPT');
    expect(accepted.length).toBeGreaterThan(0);
    for (const item of accepted) {
      const value = item.parameterContext!.testData as number;
      expect(Number.isInteger(value)).toBe(true);
      if (min) expect(value).toBeGreaterThanOrEqual(Number(min));
      expect(value).toBeLessThanOrEqual(Number(max));
    }
  });

  it('does not serialize a boolean wrong-type query to the legal false token', () => {
    const { cases } = compile('boolean', '', '', '', '', 'query');
    const wrongType = cases.flatMap((item) => item.parameterCoverage ?? [])
      .filter((p) => p.boundaryVectors.includes('INVALID_TYPE'));
    expect(wrongType.length).toBeGreaterThan(0);
    expect(wrongType.every((p) => !['true', 'false'].includes(String(p.testData)))).toBe(true);
  });
});
