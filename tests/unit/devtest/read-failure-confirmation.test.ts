import { describe, expect, it, vi } from 'vitest';
import type { TestCase, TestStep } from '../../../src/agents/test-design/testcase-schema.js';
import { ReadFailureConfirmingProcessor } from '../../../src/devtest/read-failure-confirmation.js';
import { buildTestOracleResults } from '../../../src/devtest/oracle-engine.js';

function apiCase(method: NonNullable<TestStep['method']> = 'GET'): TestCase {
  return { id: 'READ', feature: 'resource', name: 'read resource', priority: 'P0', testType: 'API',
    executionMode: 'EXECUTABLE', protocol: 'HTTP', tags: [],
    source: { requirementId: 'REQ', testPointId: 'TP', acceptanceCriteriaIds: ['AC-1'], apiSpecId: 'resources', apiOperationKey: `${method} /resources` },
    steps: [{ type: 'HTTP_REQUEST', method, url: '/resources' }],
    assertions: [{ type: 'STATUS_CODE', expected: 200 }, { type: 'JSON_VALUE', path: 'data.count', expected: 0 }],
    evidenceRequirements: [
      { channel: 'API_REQUEST', phase: 'DURING', required: true, description: 'request', factIds: [] },
      { channel: 'API_RESPONSE', phase: 'AFTER', required: true, description: 'response', factIds: [] },
    ],
  } as TestCase;
}

async function run(responses: Array<() => Response | Promise<Response>>, testCase = apiCase(), extra = {}) {
  let index = 0;
  const fetchImpl = vi.fn(async () => responses[Math.min(index++, responses.length - 1)]());
  const result = await new ReadFailureConfirmingProcessor().execute(testCase, {
    baseUrl: 'http://127.0.0.1:3000', fetchImpl: fetchImpl as typeof fetch, timeoutMs: 1000,
    apiSpecs: [{ id: 'resources', operationKey: `${testCase.steps[0].method} /resources`,
      method: testCase.steps[0].method!, path: '/resources', authPolicy: 'AUTH_NOT_REQUIRED',
      pathParams: [], query: [], headers: [], body: [], responses: [{ status: 200 }] }], ...extra,
  });
  const oracle = buildTestOracleResults({ testCases: [testCase], results: [result], invariants: [], consistency: [] })[0];
  return { result, oracle, fetchImpl };
}

const response = (count: unknown, status = 200) => () => new Response(JSON.stringify({ data: { count } }), {
  status, headers: { 'Content-Type': 'application/json' },
});

describe('bounded read failure confirmation', () => {
  it('reproduces the same failed fact once and preserves both observations', async () => {
    const { result, oracle, fetchImpl } = await run([response(7)]);
    expect(fetchImpl, JSON.stringify(result)).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'FAIL', pass: false, evidence: { readFailureConfirmation: {
      status: 'REPRODUCED', attempts: 2, repeat: { status: 'FAIL', executed: true, response: { body: { data: { count: 7 } } } },
    } } });
    expect(oracle.verdict).toBe('FAIL');
  });

  it.each([['pass on repeat', 0], ['different failure on repeat', 9]])('%s is not silently healed or confirmed', async (_name, count) => {
    const { result, oracle, fetchImpl } = await run([response(7), response(count)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('FAIL');
    expect(result.pass).toBe(false);
    expect(result.evidence.response?.body).toEqual({ data: { count: 7 } });
    expect(result.evidence.readFailureConfirmation?.status).toBe('INCONSISTENT');
    expect(oracle).toMatchObject({ verdict: 'UNKNOWN', transientSignal: 'READ_RESULT_INCONSISTENT' });
  });

  it('repeat transport failure preserves first failure but cannot confirm it', async () => {
    const { result, oracle, fetchImpl } = await run([response(7), () => { throw new Error('ECONNRESET'); }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.evidence.readFailureConfirmation?.status).toBe('INCONCLUSIVE');
    expect(oracle).toMatchObject({ verdict: 'UNKNOWN', transientSignal: 'READ_CONFIRMATION_INCOMPLETE' });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('never repeats %s even when it fails', async (method) => {
    const { result, fetchImpl } = await run([response(7)], apiCase(method));
    expect(result.status).toBe('FAIL');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.evidence.readFailureConfirmation).toBeUndefined();
  });

  it.each([['healthy', response(0)], ['gateway', response(7, 503)], ['network failure', () => { throw new Error('fetch failed'); }]])('does not repeat %s', async (_name, respond) => {
    const { result, fetchImpl } = await run([respond as () => Response]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.evidence.readFailureConfirmation).toBeUndefined();
  });

  it('respects scenario opt-out and abort before a repeat', async () => {
    const optedOut = await run([response(7)], apiCase(), { allowReadFailureConfirmation: false });
    expect(optedOut.fetchImpl).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const aborted = await run([() => { controller.abort(); return response(7)(); }], apiCase(), { signal: controller.signal });
    expect(aborted.fetchImpl).toHaveBeenCalledTimes(1);
    expect(aborted.result.evidence.readFailureConfirmation).toBeUndefined();
  });

  it('keeps the original timeout budget across both attempts', async () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1000);
      const { fetchImpl, result } = await run([() => { now.mockReturnValue(2500); return response(7)(); }]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.evidence.readFailureConfirmation).toBeUndefined();
    } finally { now.mockRestore(); }
  });

  it('does not repeat a case requiring state evidence or containing multiple steps', async () => {
    const stateful = apiCase();
    stateful.evidenceRequirements!.push({ channel: 'DATABASE_STATE', phase: 'AFTER', required: true, description: 'state', factIds: [] });
    const first = await run([response(7)], stateful);
    expect(first.fetchImpl.mock.calls.length).toBeLessThanOrEqual(1);
    const compound = apiCase();
    compound.steps.push({ type: 'HTTP_REQUEST', method: 'POST', url: '/resources' });
    const second = await run([response(7)], compound);
    expect(second.fetchImpl.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('an empty/unparsed response stays UNKNOWN, not a confirmed missing-field bug', async () => {
    const { result, oracle, fetchImpl } = await run([() => new Response('', { status: 200 })]);
    expect(oracle).toMatchObject({ verdict: 'UNKNOWN', transientSignal: 'EMPTY_RESPONSE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.evidence.readFailureConfirmation).toBeUndefined();
  });
});
