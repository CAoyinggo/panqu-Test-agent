import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { runAcceptanceApiCases } from '../../src/acceptance/api-processor.js';
import { selectDevTestCases } from '../../src/devtest/dimension-selector.js';

async function fixture(fault: boolean) {
  const received: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const raw = url.searchParams.get('value');
    received.push(raw ?? '<missing>');
    // Independent implementation: never reads test vectors or expected results.
    if (url.pathname === '/validate') {
      const value = raw === null || raw === '' ? NaN : Number(raw);
      response.statusCode = Number.isInteger(value) && value >= 1 && value <= (fault ? 4 : 3) ? 200 : 400;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ value: fault && url.pathname === '/echo' ? raw?.toLowerCase().replace('-', '') : raw }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { received, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

describe('input coverage survives selection and real HTTP execution', () => {
  it.each([false, true])('detects upper-bound off-by-one without deep mode (fault=%s)', async (fault) => {
    const requirement = parseAcceptanceRequirement(`# 数量查询
GET /validate
无需认证。
| 参数 | 位置 | 类型 | 必填 | 可空 | 最小值 | 最大值 |
| --- | --- | --- | --- | --- | --- | --- |
| value | query | integer | 是 | 否 | 1 | 3 |
返回 200、400。
AC-1 value 为 1 到 3 的整数时返回 200。
AC-2 value 非法、缺失、类型错误或超出范围时返回 400。`);
    const cases = generateAcceptanceApiCases(requirement, generateTestPoints(requirement, buildAcceptanceTestDesign(requirement)));
    const selection = selectDevTestCases(cases, { maxCases: 100 });
    const upper = selection.selected.filter((item) => item.parameterCoverage?.some((p) => p.boundaryVectors.includes('MAX_PLUS') && p.testData === 4));
    expect(upper.length).toBeGreaterThan(0);
    const server = await fixture(fault);
    try {
      const run = await runAcceptanceApiCases(selection.selected, { baseUrl: server.baseUrl, apiSpecs: requirement.apis });
      expect(server.received).toEqual(expect.arrayContaining(['1', '3', '4']));
      expect(run.results.filter((result) => upper.some((item) => item.id === result.caseId))
        .every((result) => result.executed && result.status === (fault ? 'FAIL' : 'PASS'))).toBe(true);
      if (!fault) expect(run.results.filter((result) => result.executed).every((result) => result.status === 'PASS')).toBe(true);
    } finally { await server.close(); }
  });

  it.each([false, true])('sends case/sign variants and detects corrupted echoes (fault=%s)', async (fault) => {
    const requirement = parseAcceptanceRequirement(`# Echo
GET /echo
无需认证。
| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| value | query | string | 是 |
返回 200。`);
    const api = requirement.apis[0];
    const cases: TestCase[] = ['Alpha', 'alpha', '-1', '1'].map((value, index) => ({
      id: `echo-${index}`, name: 'echo input', feature: 'echo', priority: 'P0', testType: 'API',
      protocol: 'HTTP', executionMode: 'EXECUTABLE', tags: [],
      source: { requirementId: requirement.id, testPointId: 'echo', acceptanceCriteriaIds: [], apiSpecId: api.id, apiOperationKey: api.operationKey },
      steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/echo', query: { value } }],
      assertions: [{ type: 'STATUS_CODE', expected: 200 }, { type: 'JSON_VALUE', path: 'value', expected: value }],
    }));
    const selection = selectDevTestCases(cases, { maxCases: 10 });
    expect(selection.selected).toHaveLength(4);
    const server = await fixture(fault);
    try {
      const run = await runAcceptanceApiCases(selection.selected, { baseUrl: server.baseUrl, apiSpecs: requirement.apis });
      expect(server.received.sort()).toEqual(['Alpha', 'alpha', '-1', '1'].sort());
      expect(run.results.every((result) => result.executed)).toBe(true);
      expect(run.results.filter((result) => result.status === 'FAIL')).toHaveLength(fault ? 2 : 0);
      expect(run.results.filter((result) => result.status === 'PASS')).toHaveLength(fault ? 2 : 4);
    } finally { await server.close(); }
  });
});
