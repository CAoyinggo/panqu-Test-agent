import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runAcceptancePipeline } from '../../src/acceptance/acceptance-pipeline.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';

interface ProbeServer {
  baseUrl: string;
  requests: Array<{ url: string; authorization?: string }>;
  close(): Promise<void>;
}

let server: ProbeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function startProbeServer(statusFor: (authorization?: string) => number): Promise<ProbeServer> {
  const requests: ProbeServer['requests'] = [];
  const httpServer: Server = createServer((request, response) => {
    const authorization = request.headers.authorization;
    requests.push({ url: request.url ?? '/', authorization });
    response.statusCode = statusFor(authorization);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('probe server failed to start');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    }),
  };
}

const publicActorRequirement = [
  '# Public endpoint',
  'GET /public',
  '| actor | role | token |',
  '|---|---|---|',
  '| alice | USER | token-a |',
  '无需认证',
  '返回 200',
  'AC-1 alice 无需认证即可访问，返回 200',
].join('\n');

describe('Acceptance authentication and target fail-close contracts', () => {
  it('proves AUTH_NOT_REQUIRED with an anonymous request even when the scoped fact names an Actor', async () => {
    const requirement = parseAcceptanceRequirement(publicActorRequirement);
    const cases = generateAcceptanceApiCases(requirement, generateTestPoints(requirement));
    const scopedCases = cases.filter((testCase) => testCase.source?.acceptanceCriteriaIds.includes('AC-1'));

    expect(requirement.apis[0].authPolicy).toBe('AUTH_NOT_REQUIRED');
    expect(scopedCases.some((testCase) => testCase.executionMode === 'EXECUTABLE')).toBe(true);
    expect(scopedCases.filter((testCase) => testCase.executionMode === 'EXECUTABLE')
      .every((testCase) => testCase.actor === undefined
        && testCase.steps.every((step) => step.actor === undefined))).toBe(true);

    // This server intentionally succeeds only when a token is present. A
    // credentialed request would therefore create a false proof of public access.
    server = await startProbeServer((authorization) => authorization ? 200 : 401);
    const execution = await runAcceptancePipeline({
      markdown: publicActorRequirement,
      project: 'auth-not-required-regression',
      baseUrl: server.baseUrl,
      environment: 'local',
      scope: ['AC-1'],
      actorHeaders: { alice: { Authorization: 'Bearer token-a' } },
      safetyPolicy: {
        environment: 'local',
        operationPolicies: { 'GET /public': { effect: 'READ' } },
      },
    });

    expect(server.requests).toEqual([{ url: '/public', authorization: undefined }]);
    expect(execution.results.some((result) => result.executed === true && result.status === 'FAIL')).toBe(true);
    expect(execution.results.every((result) => result.status !== 'PASS')).toBe(true);
  });

  it('blocks AUTH_UNKNOWN before Data Prepare and HTTP, including direct case compilation', async () => {
    const markdown = [
      '# Create order',
      'POST /orders',
      '| name | type | location | required | default |',
      '|---|---|---|---|---|',
      '| name | string | body | yes | order |',
      '返回 201',
      'AC-1 创建成功返回 201',
    ].join('\n');
    const requirement = parseAcceptanceRequirement(markdown);
    const cases = generateAcceptanceApiCases(requirement, generateTestPoints(requirement));
    const authWarning = requirement.warnings.find((warning) => warning.code === 'AUTH_UNKNOWN');

    expect(requirement.apis[0].authPolicy).toBe('AUTH_UNKNOWN');
    expect(authWarning).toMatchObject({ blocking: true });
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(cases.every((testCase) => String(testCase.design?.reason).includes('AUTH_POLICY_UNKNOWN'))).toBe(true);

    server = await startProbeServer(() => 201);
    const lifecycle = { prepared: 0, cleaned: 0 };
    const execution = await runAcceptancePipeline({
      markdown,
      project: 'auth-unknown-regression',
      baseUrl: server.baseUrl,
      environment: 'local',
      lifecycle: {
        prepare: async () => { lifecycle.prepared++; },
        cleanup: async () => { lifecycle.cleaned++; },
      },
      safetyPolicy: {
        environment: 'local',
        operationPolicies: { 'POST /orders': { effect: 'WRITE' } },
      },
    });

    expect(server.requests).toHaveLength(0);
    expect(lifecycle).toEqual({ prepared: 0, cleaned: 0 });
    expect(execution.results.every((result) => result.executed === false && result.status !== 'PASS')).toBe(true);
  });

  it('rejects a baseUrl path prefix before Data Prepare instead of targeting the origin root', async () => {
    const markdown = [
      '# Create order',
      'POST /orders',
      '无需认证',
      '| name | type | location | required | default |',
      '|---|---|---|---|---|',
      '| name | string | body | yes | order |',
      '返回 201',
      'AC-1 创建成功返回 201',
    ].join('\n');
    server = await startProbeServer(() => 201);
    const lifecycle = { prepared: 0, cleaned: 0 };

    const execution = await runAcceptancePipeline({
      markdown,
      project: 'base-path-regression',
      baseUrl: `${server.baseUrl}/sandbox/`,
      environment: 'local',
      lifecycle: {
        prepare: async () => { lifecycle.prepared++; },
        cleanup: async () => { lifecycle.cleaned++; },
      },
      safetyPolicy: {
        environment: 'local',
        operationPolicies: { 'POST /orders': { effect: 'WRITE' } },
      },
    });

    expect(server.requests).toHaveLength(0);
    expect(lifecycle).toEqual({ prepared: 0, cleaned: 0 });
    expect(execution.results.some((result) => result.status === 'BLOCKED'
      && result.error?.includes('API_BASE_URL_INVALID'))).toBe(true);
    expect(execution.results.every((result) => result.executed === false && result.status !== 'PASS')).toBe(true);
  });
});
