import { describe, expect, it } from 'vitest';
import { ContractRegistry } from '../../../src/contracts/registry.js';
import { ContractResolver } from '../../../src/contracts/resolver.js';
import { discoverChanges } from '../../../src/discovery/change/change-discovery.js';
import { discoverFrontendNetworkFromSource, discoverOpenApi, discoverRoutesFromSource } from '../../../src/discovery/api/source-scanners.js';
import { operationToContractCandidate, resolveDiscoveredOperations } from '../../../src/discovery/api/api-discovery.js';
import { probeRuntime } from '../../../src/discovery/api/runtime-discovery.js';
import { buildOperationGraph } from '../../../src/discovery/operation-graph.js';

describe('Phase 2 API Discovery', () => {
  it('discovers route/controller/frontend/OpenAPI operations from content', () => {
    expect(discoverRoutesFromSource("router.get('/users/:id', getUser); Route::post('/users', 'create'); @Delete('/users/{id}')", 'routes.ts'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'GET', path: '/users/:id' }),
        expect.objectContaining({ method: 'POST', path: '/users' }),
        expect.objectContaining({ method: 'DELETE', path: '/users/{id}' }),
      ]));
    expect(discoverFrontendNetworkFromSource("fetch('/api/users', { method: 'POST' }); axios.get('/api/users/1')", 'view.tsx'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'POST', path: '/api/users' }),
        expect.objectContaining({ method: 'GET', path: '/api/users/1' }),
      ]));
    expect(discoverOpenApi({ paths: { '/tasks/{id}': { get: { security: [], responses: { 200: {} } } } } }, 'openapi.json')[0])
      .toMatchObject({ method: 'GET', path: '/tasks/{id}', auth: { required: false } });
  });

  it('inspects file content and reports symbols, fields and side effects', async () => {
    const contents = new Map([['src/user-controller.ts', `
      class UserController {}
      router.post('/users', (req, res) => { db.insert(req.body.name); res.json({ id: 1, name: req.body.name }); });
    `]]);
    const result = await discoverChanges(['src/user-controller.ts'], { contents });
    expect(result.files[0]).toMatchObject({ contentInspected: true, symbols: ['UserController'] });
    expect(result.files[0].requestFields).toContain('name');
    expect(result.files[0].responseFields).toEqual(expect.arrayContaining(['id', 'name']));
    expect(result.files[0].sideEffects).toContain('DATA_MUTATION');
  });

  it('keeps discovery as Candidate and lets Resolver decide status/conflict', () => {
    const resolver = new ContractResolver(new ContractRegistry());
    const operation = discoverRoutesFromSource("router.get('/health', handler)", 'routes.ts')[0];
    const candidate = operationToContractCandidate(operation, resolver, 'test');
    expect(candidate.candidate.metadata).toMatchObject({ discoveryCandidate: true });
    expect(resolver.resolve({ id: operation.id }).status).toBe('UNKNOWN');
    const [resolved] = resolveDiscoveredOperations([operation], resolver, 'test');
    expect(resolved.resolution.status).toBe('RESOLVED');
  });

  it('allows only read probes or explicit side-effect-free reject probes', async () => {
    await expect(probeRuntime({ method: 'POST', path: '/generate' }, { baseUrl: 'http://example.test' })).rejects.toThrow('UNSAFE_RUNTIME_PROBE');
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: 'invalid' }), {
      status: 422, headers: { 'content-type': 'application/json', 'x-request-id': 'trace-1' },
    });
    const observed = await probeRuntime({
      method: 'POST', path: '/generate', invalidProbe: { body: {}, expectedRejectStatuses: [422], sideEffectFree: true },
    }, { baseUrl: 'http://example.test', fetchImpl });
    expect(observed).toMatchObject({ safeProbe: true, observed: { status: 422, traceId: 'trace-1' } });
  });

  it('builds deterministic resource and side-effect dependencies', () => {
    const operations = [
      ...discoverRoutesFromSource("router.post('/users', create); router.get('/users', list)", 'routes.ts'),
    ];
    operations[0].sideEffects = ['DATA_MUTATION'];
    const graph = buildOperationGraph(operations);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'RESOURCE' }),
      expect.objectContaining({ kind: 'SIDE_EFFECT', to: 'effect:DATA_MUTATION' }),
    ]));
  });
});
