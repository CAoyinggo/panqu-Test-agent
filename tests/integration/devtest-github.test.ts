import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DevTestGitHubClient,
  githubBusinessWritePolicy,
  renderGitHubDevTestSummary,
  type DevTestGitHubContext,
} from '../../src/devtest/github-integration.js';
import { DEFAULT_DEVTEST_CONFIG } from '../../src/devtest/cli-config.js';
import type { DevTestRunResult } from '../../src/devtest/types.js';

const servers: Server[] = [];

afterEach(async () => {
  delete process.env.DEVTEST_ALLOW_WRITES;
  delete process.env.DEVTEST_ENVIRONMENT_KIND;
  delete process.env.DEVTEST_SANDBOX;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('GitHub Check/PR comment integration', () => {
  it('reports GENERATED, EXECUTABLE, EXECUTED, VERIFIED and every required evidence family separately', () => {
    const summary = renderGitHubDevTestSummary({
      conclusion: 'READY', runId: 'RUN-CONTROLLED',
      deliveryCoverage: {
        cases: { generated: 6, executable: 6, executed: 6, verified: 6, passed: 6, failed: 0, blocked: 0, notTested: 0 },
        evidence: { coverage: 100 },
      },
      acceptanceTraces: [
        { result: 'PASS', evidence: { required: ['API_RESPONSE'], collected: ['API_RESPONSE'] } },
        { result: 'PASS', evidence: { required: ['DATABASE_STATE'], collected: ['DATABASE_STATE'] } },
        { result: 'PASS', evidence: { required: ['QUEUE_MESSAGE'], collected: ['QUEUE_MESSAGE'] } },
      ],
      invariants: [{ kind: 'NON_MUTATION', status: 'VERIFIED' }],
      dataLifecycle: { cleanupStatus: 'VERIFIED' },
      oracleResults: [{ verdict: 'PASS' }],
    } as unknown as DevTestRunResult);

    for (const expected of [
      '| GENERATED | 6 |', '| EXECUTABLE | 6 |', '| EXECUTED | 6 |', '| VERIFIED | 6 |',
      '| Response | 1 | 1 | 1 |', '| State / DB | 1 | 1 | 1 |',
      '| Non-Mutation | 1 | 1 | 1 |', '| Side Effect / Log / Queue | 1 | 1 | 1 |',
      'Oracle: PASS 1 · FAIL 0 · BLOCKED/UNKNOWN 0', 'Cleanup: VERIFIED · Evidence coverage: 100%',
    ]) expect(summary).toContain(expected);
  });

  it('uses create-once/update-after semantics for both Check Run and PR comment', async () => {
    const checks: Array<{ id: number; external_id: string }> = [];
    const comments: Array<{ id: number; body: string }> = [];
    const calls: Array<{ method: string; pathname: string; body?: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://github.mock');
      const method = request.method ?? 'GET';
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : undefined;
      calls.push({ method, pathname: `${url.pathname}${url.search}`, body });
      let result: unknown;
      let status = 200;
      if (method === 'GET' && url.pathname.endsWith('/check-runs')) {
        result = { check_runs: checks };
      } else if (method === 'POST' && url.pathname.endsWith('/check-runs')) {
        const created = { id: 101, external_id: String(body?.external_id) };
        checks.push(created);
        result = created;
        status = 201;
      } else if (method === 'PATCH' && url.pathname.includes('/check-runs/')) {
        result = checks[0];
      } else if (method === 'GET' && url.pathname.endsWith('/comments')) {
        result = comments;
      } else if (method === 'POST' && url.pathname.endsWith('/comments')) {
        const created = { id: 201, body: String(body?.body) };
        comments.push(created);
        result = created;
        status = 201;
      } else if (method === 'PATCH' && url.pathname.includes('/issues/comments/')) {
        comments[0].body = String(body?.body);
        result = comments[0];
      } else {
        result = { message: 'not found' };
        status = 404;
      }
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const client = new DevTestGitHubClient({
      token: 'test-token-never-logged', repository: 'example/project', apiBase: `http://127.0.0.1:${address.port}`,
    });
    const checkInput = {
      sha: 'abc123', name: 'DevTest', externalId: 'devtest:example/project:abc123', conclusion: 'neutral' as const,
      summary: 'GENERATED 4 · EXECUTABLE 3 · EXECUTED 2 · VERIFIED 1',
    };
    const firstCheck = await client.upsertCheck(checkInput);
    const secondCheck = await client.upsertCheck({ ...checkInput, conclusion: 'success' });
    const firstComment = await client.upsertPullRequestComment({
      pullRequestNumber: 7, marker: '<!-- devtest-report -->', body: '<!-- devtest-report -->\nfirst',
    });
    const secondComment = await client.upsertPullRequestComment({
      pullRequestNumber: 7, marker: '<!-- devtest-report -->', body: '<!-- devtest-report -->\nupdated',
    });

    expect(firstCheck).toEqual({ id: 101, created: true });
    expect(secondCheck).toEqual({ id: 101, created: false });
    expect(firstComment).toEqual({ id: 201, created: true });
    expect(secondComment).toEqual({ id: 201, created: false });
    expect(calls.filter((call) => call.method === 'POST' && call.pathname.endsWith('/check-runs'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'PATCH' && call.pathname.includes('/check-runs/'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'POST' && call.pathname.endsWith('/comments'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'PATCH' && call.pathname.includes('/issues/comments/'))).toHaveLength(1);
    expect(comments[0].body).toContain('updated');
    expect(JSON.stringify(calls)).not.toContain('test-token-never-logged');
  });

  it('always blocks business writes for fork PRs and requires explicit test/sandbox enablement otherwise', () => {
    const context = (fork: boolean): DevTestGitHubContext => ({
      eventName: 'pull_request', repository: 'example/project', sha: 'abc', pullRequestNumber: 1, fork,
    });
    process.env.DEVTEST_ALLOW_WRITES = 'true';
    process.env.DEVTEST_ENVIRONMENT_KIND = 'sandbox';
    process.env.DEVTEST_SANDBOX = 'true';
    expect(githubBusinessWritePolicy({ context: context(true), config: DEFAULT_DEVTEST_CONFIG }))
      .toMatchObject({ allowed: false, sandbox: false, reason: 'FORK_PR_WRITE_BLOCKED' });
    expect(githubBusinessWritePolicy({ context: context(false), config: DEFAULT_DEVTEST_CONFIG }))
      .toMatchObject({ allowed: true, sandbox: true });
    process.env.DEVTEST_ENVIRONMENT_KIND = 'production';
    expect(githubBusinessWritePolicy({ context: context(false), config: DEFAULT_DEVTEST_CONFIG }))
      .toMatchObject({ allowed: false, reason: 'TEST_OR_SANDBOX_ENVIRONMENT_REQUIRED' });
  });
});
