import { afterEach, describe, expect, it } from 'vitest';
import type { AssertionDefinition, TestCase, TestStep } from '../../src/agents/test-design/testcase-schema.js';
import { ApiProcessor, buildAcceptanceDefects, runAcceptanceApiCases } from '../../src/acceptance/api-processor.js';
import type { ApiSpec } from '../../src/acceptance/requirement-ir.js';
import { startFakeApiServer, type FakeApiServer } from './helpers/fake-api-server.js';

let server: FakeApiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function apiCase(method: NonNullable<TestStep['method']>, assertions?: AssertionDefinition[]): TestCase {
  return {
    id: `API-${method}`,
    feature: 'HTTP Contract',
    name: `${method} contract`,
    priority: 'P0',
    testType: 'API',
    executionMode: 'EXECUTABLE',
    protocol: 'HTTP',
    source: { requirementId: 'REQ-HTTP', testPointId: 'TP-HTTP', acceptanceCriteriaIds: ['AC-HTTP'], apiSpecId: 'API-HTTP', apiOperationKey: `${method} /echo/{id}` },
    actor: { id: 'user-a', userId: 'user-a', tokenRef: 'user-a-token' },
    tags: ['acceptance'],
    steps: [{
      type: 'HTTP_REQUEST', method, url: '/echo/{id}', pathParams: { id: 'resource-1' },
      query: { mode: 'contract' }, headers: { 'x-client': 'acceptance' },
      body: method === 'GET' ? undefined : { name: 'payload' },
    }],
    assertions: assertions ?? [
      { type: 'STATUS_CODE', expected: 200 },
      { type: 'RESPONSE_HEADER', header: 'x-contract', expected: 'acceptance-v1' },
      { type: 'JSON_VALUE', path: 'data.method', expected: method },
      { type: 'JSON_VALUE', path: 'data.id', expected: 'resource-1' },
      { type: 'JSON_VALUE', path: 'data.query.mode', expected: 'contract' },
      { type: 'JSON_VALUE', path: 'data.authorization', expected: 'Bearer token-user-a' },
      { type: 'JSON_PATH', path: 'data.body' },
      { type: 'TYPE', path: 'data', expected: 'object' },
      { type: 'CONTAINS', path: 'data.id', expected: 'source' },
    ],
  };
}

function apiSpec(testCase: TestCase): ApiSpec {
  const step = testCase.steps[0];
  testCase.source!.apiOperationKey = `${step.method} ${step.url}`;
  return {
    id: 'API-HTTP', operationKey: `${step.method} ${step.url}`, authPolicy: 'AUTH_UNKNOWN', method: step.method!, path: step.url!,
    pathParams: [...(step.url?.matchAll(/\{([^}]+)\}/g) ?? [])].map((match) => ({
      name: match[1], type: 'string', required: true, nullable: false, location: 'path' as const,
    })),
    query: [{ name: 'mode', type: 'string', required: false, nullable: false, location: 'query' }],
    headers: [{ name: 'x-client', type: 'string', required: false, nullable: false, location: 'header' }],
    body: step.method === 'GET' || step.method === 'HEAD' ? [] : [{ name: 'name', type: 'string', required: false, nullable: false, location: 'body' }],
    responses: testCase.assertions
      .filter((assertion) => assertion.type === 'STATUS_CODE' && typeof assertion.expected === 'number')
      .map((assertion) => ({ status: assertion.expected as number })),
  };
}

const runtime = (baseUrl: string, testCase: TestCase) => ({
  baseUrl,
  actorHeaders: { 'user-a-token': { Authorization: 'Bearer token-user-a' } },
  apiSpecs: [apiSpec(testCase)],
});

describe('ApiProcessor real HTTP contract', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const)('executes %s through a real HTTP server', async (method) => {
    server = await startFakeApiServer();
    const test = apiCase(method);
    const result = await new ApiProcessor().execute(test, runtime(server.baseUrl, test));
    expect(result.status).toBe('PASS');
    expect(result.executed).toBe(true);
    expect(result.processorInvoked).toBe(true);
    expect(result.evidence.request?.url).toContain('/echo/resource-1?mode=contract');
    expect(result.evidence.response?.status).toBe(200);
    expect(result.evidence.assertions.every((assertion) => assertion.pass)).toBe(true);
    expect(server.requests).toHaveLength(1);
  });

  it('uses body, path, query, headers, actor session and deterministic assertions', async () => {
    server = await startFakeApiServer();
    const test = apiCase('PATCH');
    const result = await new ApiProcessor().execute(test, runtime(server.baseUrl, test));
    expect(result.status).toBe('PASS');
    expect(server.requests[0].headers['x-client']).toBe('acceptance');
    expect(server.requests[0].body).toEqual({ name: 'payload' });
    expect(result.evidence.assertions).toHaveLength(9);
  });

  it('routes FAIL to defects, but never turns BLOCKED/NOT_EXECUTED into product defects', async () => {
    server = await startFakeApiServer();
    const failed = apiCase('GET', [{ type: 'STATUS_CODE', expected: 201 }]);
    const failResult = await new ApiProcessor().execute(failed, runtime(server.baseUrl, failed));
    const blocked = apiCase('GET');
    const blockedResult = await new ApiProcessor().execute(blocked, { baseUrl: server.baseUrl, actorHeaders: {}, apiSpecs: [apiSpec(blocked)] });
    const descriptive = { ...apiCase('GET'), executionMode: 'DESCRIPTIVE_ONLY' as const };
    const notExecuted = await new ApiProcessor().execute(descriptive, runtime(server.baseUrl, descriptive));
    expect([failResult.status, blockedResult.status, notExecuted.status]).toEqual(['FAIL', 'BLOCKED', 'NOT_EXECUTED']);
    expect(buildAcceptanceDefects([failResult, blockedResult, notExecuted])).toHaveLength(1);
  });

  it('blocks before HTTP when no effective assertion exists', async () => {
    server = await startFakeApiServer();
    const test = apiCase('GET', []);
    const result = await new ApiProcessor().execute(test, runtime(server.baseUrl, test));
    expect(result.status).toBe('BLOCKED');
    expect(result.executed).toBe(false);
    expect(result.processorInvoked).toBe(false);
    expect(result.pass).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it('does not execute malformed assertions as product failures', async () => {
    server = await startFakeApiServer();
    const malformed = apiCase('GET', [{ type: 'JSON_VALUE', expected: 'value' }]);
    const result = await new ApiProcessor().execute(malformed, runtime(server.baseUrl, malformed));
    expect(result.status).toBe('NOT_EXECUTED');
    expect(result.executed).toBe(false);
    expect(server.requests).toHaveLength(0);
    expect(buildAcceptanceDefects([result])).toHaveLength(0);
  });

  it.each([401, 403, 404, 429, 500])('treats expected HTTP %s as PASS rather than a product failure', async (status) => {
    server = await startFakeApiServer();
    const test = apiCase('GET', [{ type: 'STATUS_CODE', expected: status }]);
    test.steps[0] = { type: 'HTTP_REQUEST', method: 'GET', url: `/status/${status}` };
    test.actor = undefined;
    const result = await new ApiProcessor().execute(test, { baseUrl: server.baseUrl, apiSpecs: [apiSpec(test)] });
    expect(result).toMatchObject({ status: 'PASS', pass: true, executed: true, classification: 'SUCCESS' });
    expect(buildAcceptanceDefects([result])).toHaveLength(0);
  });

  it('classifies invalid JSON assertion mismatch as PRODUCT_FAILURE with a reproducible defect', async () => {
    server = await startFakeApiServer();
    const test = apiCase('GET', [{ type: 'JSON_PATH', path: 'data.id' }]);
    test.steps[0] = { type: 'HTTP_REQUEST', method: 'GET', url: '/invalid-json' };
    test.actor = undefined;
    const result = await new ApiProcessor().execute(test, { baseUrl: server.baseUrl, runId: 'RUN-TEST', apiSpecs: [apiSpec(test)] });
    expect(result).toMatchObject({ status: 'FAIL', classification: 'PRODUCT_FAILURE', executed: true });
    expect(buildAcceptanceDefects([result], 'test', { runId: 'RUN-TEST', testCases: [test] })[0]).toMatchObject({
      runId: 'RUN-TEST', caseId: test.id, acceptanceCriteriaIds: ['AC-HTTP'], confidence: 0.7,
    });
  });

  it.each([401, 403, 429, 500, 502, 503, 504])('does not attribute unexpected HTTP %s to a component from status alone', async (status) => {
    server = await startFakeApiServer();
    const test = apiCase('GET', [{ type: 'STATUS_CODE', expected: 200 }]);
    test.steps[0] = { type: 'HTTP_REQUEST', method: 'GET', url: `/status/${status}` };
    test.actor = undefined;
    const result = await new ApiProcessor().execute(test, { baseUrl: server.baseUrl, apiSpecs: [apiSpec(test)] });

    expect(result).toMatchObject({
      status: 'FAIL', classification: 'UNCONFIRMED', executed: true,
      attribution: { classification: 'UNCONFIRMED', confidence: 'LOW' },
    });
    expect(result.attribution.reason).toContain(`HTTP ${status}`);
    expect(result.attribution.evidenceSources).toEqual(expect.arrayContaining(['HTTP_RESPONSE', 'ASSERTION_EVIDENCE']));
    expect(buildAcceptanceDefects([result])).toHaveLength(0);
  });

  it('classifies timeout and connection refusal as environment failures, not product defects', async () => {
    server = await startFakeApiServer({ slowResponseMs: 100 });
    const slow = apiCase('GET', [{ type: 'STATUS_CODE', expected: 200 }]);
    slow.steps[0] = { type: 'HTTP_REQUEST', method: 'GET', url: '/slow' };
    slow.actor = undefined;
    const timedOut = await new ApiProcessor().execute(slow, { baseUrl: server.baseUrl, timeoutMs: 5, apiSpecs: [apiSpec(slow)] });
    const closedUrl = server.baseUrl;
    await server.close();
    server = undefined;
    const refused = await new ApiProcessor().execute(slow, { baseUrl: closedUrl, timeoutMs: 100, apiSpecs: [apiSpec(slow)] });
    expect(timedOut).toMatchObject({ status: 'TIMEOUT', classification: 'ENVIRONMENT_FAILURE', pass: false });
    expect(refused).toMatchObject({ status: 'BLOCKED', classification: 'ENVIRONMENT_FAILURE', pass: false });
    expect(buildAcceptanceDefects([timedOut, refused])).toHaveLength(0);
  });

  it('reports a timed-out mutation as possibly committed instead of claiming it never executed', async () => {
    const test = apiCase('POST', [{ type: 'STATUS_CODE', expected: 201 }]);
    let committed = 0;
    const commitThenHang: typeof fetch = async (_input, init) => {
      committed++;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
      });
    };

    const result = await new ApiProcessor().execute(test, {
      ...runtime('http://acceptance.invalid', test), fetchImpl: commitThenHang, timeoutMs: 5,
    });

    expect(committed).toBe(1);
    expect(result).toMatchObject({
      status: 'TIMEOUT', executed: false, processorInvoked: true, pass: false,
      classification: 'UNCONFIRMED',
      evidence: {
        transport: {
          requestDispatched: true, responseCompleted: false,
          outcome: 'UNKNOWN', sideEffect: 'POSSIBLY_COMMITTED',
        },
      },
      attribution: { classification: 'UNCONFIRMED', confidence: 'HIGH' },
    });
    expect(result.error).toContain('EXECUTION_UNKNOWN/POSSIBLY_EXECUTED');
    expect(buildAcceptanceDefects([result])).toHaveLength(0);
  });

  it('returns BLOCKED when processor is absent and outcome is fail-closed', async () => {
    server = await startFakeApiServer();
    const test = apiCase('GET');
    const run = await runAcceptanceApiCases([test], { ...runtime(server.baseUrl, test), processor: null });
    expect(run.results[0].status).toBe('BLOCKED');
    expect(run.results[0].pass).toBe(false);
    expect(run.outcome.executed).toBe(false);
    expect(run.outcome.passed).toBe(0);
  });

  it('aborts the in-flight request at the Run deadline and never starts remaining Cases', async () => {
    const first = apiCase('GET', [{ type: 'STATUS_CODE', expected: 200 }]);
    const second = { ...apiCase('GET', [{ type: 'STATUS_CODE', expected: 200 }]), id: 'API-GET-2' };
    let requests = 0;
    const hangingFetch: typeof fetch = async (_input, init) => {
      requests++;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
      });
    };

    const run = await runAcceptanceApiCases([first, second], {
      ...runtime('http://127.0.0.1:1', first), fetchImpl: hangingFetch, timeoutMs: 500, deadlineMs: 10,
    });

    expect(requests).toBe(1);
    expect(run.results[0]).toMatchObject({ status: 'CANCELLED', executed: false, processorInvoked: true, classification: 'EXECUTION_BLOCKED' });
    expect(run.results[1]).toMatchObject({ status: 'CANCELLED', executed: false, processorInvoked: false, classification: 'EXECUTION_BLOCKED' });
    expect(run.results.every((result) => result.pass === false)).toBe(true);
  });

  it('does not return PASS when the deadline wins after headers arrive but before the response body completes', async () => {
    const test = apiCase('GET', [{ type: 'STATUS_CODE', expected: 200 }]);
    const delayedBodyFetch: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('{"ok":true}'));
          controller.close();
        }, 30);
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const run = await runAcceptanceApiCases([test], {
      ...runtime('http://acceptance.invalid', test), fetchImpl: delayedBodyFetch,
      timeoutMs: 100, deadlineMs: 5,
    });

    expect(run.results[0]).toMatchObject({
      status: 'CANCELLED', pass: false, executed: false, processorInvoked: true,
      classification: 'EXECUTION_BLOCKED',
      attribution: { confidence: 'HIGH' },
    });
  });
});
