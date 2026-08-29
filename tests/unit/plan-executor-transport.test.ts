// plan-executor-transport 集成测试：真实 Node HTTP + defaultTransport（无 LLM、无真实公网）。
//
// 说明：本文件只验证「传输层」行为（socket 绑定 pinned IP、Host 头不可覆盖、慢响应体 abort），
// 不代表业务计划被允许访问 loopback/内网——业务层 SSRF 校验在 executePlan 的 resolveSafeAddresses 中
// 独立生效（本测试直接调用 defaultTransport，绕过业务校验，仅验证传输层正确性）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultTransport, executePlan, type PinnedHttpTransport } from '../../src/agents/orchestration/plan-executor.js';
import { validatePlan } from '../../src/agents/plan/plan-contract.js';

let server: http.Server;
let port: number;
const slowResponses = new Set<http.ServerResponse>();
const redirectResponses = new Set<http.ServerResponse>();
let redirectClosedCount = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/host') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host ?? null }));
      return;
    }
    if (req.url === '/slow') {
      // 慢响应体：先写一部分，然后挂起，模拟「慢/无限 body」场景。
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial-');
      slowResponses.add(res);
      req.on('close', () => slowResponses.delete(res));
      return;
    }
    if (req.url === '/redirect-infinite') {
      // 302 + 永不结束的 body：用于验证「重定向体不需要保留时，drain 必须销毁流而非等待 body 排空」。
      res.writeHead(302, { location: '/ok' });
      redirectResponses.add(res);
      const interval = setInterval(() => {
        if (res.destroyed || res.writableEnded || res.writableFinished) { clearInterval(interval); return; }
        res.write('x'.repeat(1024));
      }, 1);
      res.on('close', () => { clearInterval(interval); redirectClosedCount += 1; });
      res.on('error', () => { clearInterval(interval); });
      req.on('close', () => { clearInterval(interval); });
      return;
    }
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, host: req.headers.host ?? null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const res of slowResponses) res.destroy();
  slowResponses.clear();
  for (const res of redirectResponses) res.destroy();
  redirectResponses.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 单测用：executePlan 层强制走真实 defaultTransport，但 pins 到 127.0.0.1（仅传输层测试手段，业务 SSRF 由 resolveSafeAddresses 独立保证）。 */
const localTransport: PinnedHttpTransport = (r) => defaultTransport({ ...r, addresses: ['127.0.0.1'] });

function apiPlan(targetUrl: string, path: string): Record<string, unknown> {
  return {
    requirement_summary: '传输层集成',
    target_url: targetUrl,
    environment: 'test',
    test_scope: 'api',
    test_cases: [
      {
        id: 'C1',
        name: 'case',
        priority: 'P0',
        type: 'API',
        steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: path }],
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 200 }],
      },
    ],
    risks: [],
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function req(url: URL, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return defaultTransport({
    url,
    method: 'GET',
    headers,
    addresses: ['127.0.0.1'],
    timeoutMs: 5000,
    signal: signal ?? new AbortController().signal,
  });
}

describe('defaultTransport：pinned lookup 真实连接（Node 24 options.all=true）', () => {
  it('用 pinned IP 连接仅监听 127.0.0.1 的服务，且 lookup 只返回 pinned 地址', async () => {
    const url = new URL(`http://pinned.example.test:${port}/health`);
    const resp = await req(url);
    expect(resp.status).toBe(200);
    const text = await resp.readText(1024);
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(JSON.parse(text.text)).toMatchObject({ ok: true });
  });
});

describe('defaultTransport：Host / hop-by-hop 头不能被用户覆盖', () => {
  it('用户传入 host/connection 后，服务端实际收到的 Host 仍等于原 URL host', async () => {
    const url = new URL(`http://pinned.example.test:${port}/host`);
    const resp = await req(url, { host: 'evil.example', Host: 'evil.example', hOsT: 'evil.example', connection: 'keep-alive' });
    expect(resp.status).toBe(200);
    const text = await resp.readText(1024);
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    const body = JSON.parse(text.text) as { host: string | null };
    expect(body.host).toBe(url.host);
    expect(body.host).not.toContain('evil.example');
  });
});

describe('defaultTransport：慢响应体 abort', () => {
  it('慢 body 在 AbortSignal 触发后返回 ABORTED，不把部分 body 当正常响应', async () => {
    const controller = new AbortController();
    const url = new URL(`http://pinned.example.test:${port}/slow`);
    const resp = await req(url, {}, controller.signal);
    expect(resp.status).toBe(200);

    const readPromise = resp.readText(1_000_000, controller.signal);
    setTimeout(() => controller.abort(), 30);
    const outcome = await readPromise;
    expect(outcome).toEqual({ ok: false, error: 'ABORTED' });
  });
});

describe('defaultTransport：无限重定向体 drain 销毁（不等待 body 排空）', () => {
  it('drain 立即销毁响应流，服务端观察到 close，且不等待 body 结束', async () => {
    const countBefore = redirectClosedCount;
    const url = new URL(`http://pinned.example.test:${port}/redirect-infinite`);
    const resp = await req(url);
    expect(resp.status).toBe(302);

    const started = Date.now();
    await resp.drain();
    expect(Date.now() - started).toBeLessThan(500); // 不等待 body 结束
    await waitUntil(() => redirectClosedCount > countBefore, 2000); // 服务端观察到连接关闭
  });
});

describe('executePlan：慢响应体分类与重定向体释放（真实本地 HTTP）', () => {
  it('慢 body + httpTimeoutMs 到期 → ERROR/TIMEOUT', async () => {
    const origin = `http://slow.example.test:${port}`;
    const v = validatePlan(apiPlan(`${origin}/`, '/slow'));
    if (!v.ok) throw new Error('plan 应合法');

    const result = await executePlan(v.normalized, {
      allowedTargetOrigins: new Set([origin]),
      resolveHost: async () => ['93.184.216.34'],
      transport: localTransport,
      httpTimeoutMs: 80,
    });
    expect(result.caseResults[0].status).toBe('ERROR');
    expect(result.caseResults[0].http?.statusText).toBe('TIMEOUT');
  });

  it('慢 body + budget_duration 先耗尽 → BLOCKED_BY_BUDGET', async () => {
    const origin = `http://slow.example.test:${port}`;
    const v = validatePlan(apiPlan(`${origin}/`, '/slow'));
    if (!v.ok) throw new Error('plan 应合法');

    const result = await executePlan(v.normalized, {
      allowedTargetOrigins: new Set([origin]),
      resolveHost: async () => ['93.184.216.34'],
      transport: localTransport,
      budgetDurationMs: 40,
    });
    expect(result.caseResults[0].status).toBe('BLOCKED_BY_BUDGET');
  });

  it('302 + 无限 body：executor drain 后继续跳转并 PASSED，服务端观察到 close', async () => {
    const countBefore = redirectClosedCount;
    const origin = `http://redirect.example.test:${port}`;
    const v = validatePlan(apiPlan(`${origin}/`, '/redirect-infinite'));
    if (!v.ok) throw new Error('plan 应合法');

    const result = await executePlan(v.normalized, {
      allowedTargetOrigins: new Set([origin]),
      resolveHost: async () => ['93.184.216.34'],
      transport: localTransport,
      httpTimeoutMs: 2000,
    });
    expect(result.caseResults[0].status).toBe('PASSED');
    await waitUntil(() => redirectClosedCount > countBefore, 2000);
  });
});