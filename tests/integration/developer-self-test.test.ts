import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDeveloperSelfTest } from '../../src/self-test/self-test-runner.js';
import { BillingObserver, BrowserObserver, StateObserver } from '../../src/observers/callback-observers.js';
import { ObserverRegistry } from '../../src/observers/registry.js';

let server: http.Server;
let baseUrl: string;
let mutationCalls = 0;
let billingCharges = 0;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    response.setHeader('x-request-id', `req-${Date.now()}`);
    if (request.method === 'GET' && request.url === '/crud/1') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 1, name: 'Ada' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/crud') {
      mutationCalls++;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 2 }));
      return;
    }
    if (request.method === 'GET' && request.url === '/tasks/1/status') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 1, status: 'SUCCEEDED' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/billing/charge') {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        if (!body || body === '{}') {
          response.writeHead(422, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'amount required' }));
          return;
        }
        billingCharges++;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ charged: true }));
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/ui') {
      response.setHeader('content-type', 'text/html');
      response.end('<main data-state="ready"><button>Submit</button></main>');
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

const publicOperation = (path: string, method: 'get' | 'post', status: number) => ({
  document: { paths: { [path]: { [method]: { security: [], responses: { [status]: { description: 'controlled contract' } } } } } },
  ref: `controlled-openapi:${method}:${path}`,
});

describe('Developer Self-Test controlled real HTTP flow', () => {
  it('CRUD: executes the real read path and blocks the write path in SAFE before mutation', async () => {
    const report = await runDeveloperSelfTest({ environment: 'test', module: 'crud', changedFiles: ['routes.ts'] }, {
      mode: 'SAFE', baseUrl,
      changedContents: new Map([['routes.ts', "router.get('/crud/1', read); router.post('/crud', create);"]]),
      openApiDocuments: [publicOperation('/crud/1', 'get', 200), publicOperation('/crud', 'post', 201)],
      runtimeProbes: [{ method: 'GET', path: '/crud/1' }],
    });
    expect(report.scenarios.some((item) => item.result.status === 'PASS' && item.result.executed)).toBe(true);
    expect(report.scenarios.some((item) => item.safety.reasons.some((reason) => reason.includes('SAFE_MODE_SIDE_EFFECT_BLOCKED')))).toBe(true);
    expect(mutationCalls).toBe(0);
    expect(report.result).toBe('PARTIAL');
  });

  it('Async: executes status observation but blocks terminal-state claim without a state oracle', async () => {
    const stateObserver = new StateObserver(async () => ({ id: 1, status: 'SUCCEEDED' }), 'controlled-task-store');
    const report = await runDeveloperSelfTest({ environment: 'test', module: 'task', entrypoints: [`${baseUrl}/tasks/1/status`] }, {
      mode: 'SAFE', baseUrl,
      openApiDocuments: [publicOperation('/tasks/1/status', 'get', 200)],
      runtimeProbes: [{ method: 'GET', path: '/tasks/1/status' }],
      observers: new ObserverRegistry([stateObserver]),
    });
    expect(report.scenarios.some((item) => item.result.status === 'PASS')).toBe(true);
    expect(report.scenarios.some((item) => item.scenario.tags?.includes('async-state') && item.result.status === 'BLOCKED')).toBe(true);
    expect(report.unknowns.some((item) => item.type === 'UNKNOWN_STATE')).toBe(true);
  });

  it('Billing/Mutation: runs only the explicit validation-reject probe and produces no charge', async () => {
    const report = await runDeveloperSelfTest({ environment: 'test', module: 'billing', changedFiles: ['billing-controller.ts'] }, {
      mode: 'SAFE', baseUrl,
      changedContents: new Map([['billing-controller.ts', "router.post('/billing/charge', charge); // billing charge"]]),
      openApiDocuments: [publicOperation('/billing/charge', 'post', 201)],
      runtimeProbes: [{
        method: 'POST', path: '/billing/charge',
        invalidProbe: { body: {}, expectedRejectStatuses: [422], sideEffectFree: true },
      }],
      observers: new ObserverRegistry([new BillingObserver(async () => ({ charges: billingCharges }), 'controlled-billing-ledger')]),
    });
    expect(report.scenarios.some((item) => item.scenario.tags?.includes('validation') && item.result.status === 'PASS')).toBe(true);
    expect(billingCharges).toBe(0);
    expect(report.scenarios.every((item) => item.result.status !== 'PASS' || item.result.evidence.length > 0)).toBe(true);
  });

  it('UI: requires and records Browser evidence in addition to the real HTTP response', async () => {
    const browser = new BrowserObserver(async () => {
      const response = await fetch(`${baseUrl}/ui`);
      return { dom: await response.text(), url: `${baseUrl}/ui` };
    }, 'controlled-browser-dom');
    const report = await runDeveloperSelfTest({ environment: 'test', module: 'ui', changedFiles: ['view.tsx'] }, {
      mode: 'SAFE', baseUrl,
      changedContents: new Map([['view.tsx', "export function Panel(){ return <button>Submit</button> }; fetch('/ui')"]]),
      openApiDocuments: [publicOperation('/ui', 'get', 200)],
      runtimeProbes: [{ method: 'GET', path: '/ui' }],
      observers: new ObserverRegistry([browser]),
    });
    const ui = report.scenarios.find((item) => item.scenario.tags?.includes('ui'));
    expect(ui?.result.status).toBe('PASS');
    expect(ui?.result.evidence.some((item) => item.kind === 'SCREENSHOT' && item.verified)).toBe(true);
    expect(report.evidence.kinds.SCREENSHOT).toBeGreaterThan(0);
  });
});
