import { createServer } from 'node:http';

export const EFFECTIVENESS_REQUIREMENT = `# Resource response contract
## API
GET /resources
无需认证。
返回 200。
## Acceptance Criteria
AC-1 GET /resources 查询资源返回 HTTP 200，响应 data.id="resource-a"，data.name="demo"，data.enabled=false，data.count=0。
`;

// Independent seeded SUT. Samples are developer-visible regression checks, not a blind benchmark.
// It never receives generated cases, assertions, expected results or scorer callbacks.
export const EFFECTIVENESS_SAMPLES = [
  { id: 'status-regression', fault: 'status', target: 'STATUS_CODE' },
  { id: 'id-corrupted', fault: 'wrong-id', target: 'data.id' },
  { id: 'id-missing', fault: 'missing-id', target: 'data.id' },
  { id: 'name-missing', fault: 'missing-name', target: 'data.name' },
  { id: 'false-field-missing', fault: 'missing-enabled', target: 'data.enabled' },
  { id: 'zero-field-missing', fault: 'missing-count', target: 'data.count' },
  { id: 'number-corrupted', fault: 'wrong-count', target: 'data.count' },
  { id: 'type-corrupted', fault: 'string-count', target: 'data.count' },
  { id: 'network-word-in-data', fault: 'network-name', target: 'data.name' },
  { id: 'timeout-word-in-data', fault: 'timeout-name', target: 'data.name' },
  { id: 'auth-word-in-data', fault: 'auth-name', target: 'data.name' },
  { id: 'processor-word-in-data', fault: 'processor-name', target: 'data.name' },
  { id: 'healthy', fault: 'none', target: null },
  { id: 'healthy-extra-fields', fault: 'extra-fields', target: null },
  { id: 'healthy-key-order', fault: 'key-order', target: null },
  { id: 'healthy-no-cache', fault: 'no-cache', target: null },
  { id: 'gateway-outage', fault: 'gateway', target: null },
  { id: 'disconnected-transport', fault: 'disconnect', target: null },
] as const;

export type EffectivenessSample = typeof EFFECTIVENESS_SAMPLES[number];

export async function startEffectivenessFixture(fault: EffectivenessSample['fault']) {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/health') { response.writeHead(200); response.end('{"ok":true}'); return; }
    requests++;
    if (request.url !== '/resources' || request.method !== 'GET') { response.writeHead(404); response.end(); return; }
    if (fault === 'disconnect') { request.socket.destroy(); return; }
    if (fault === 'gateway') { response.writeHead(503); response.end('{"upstream":"unavailable"}'); return; }
    const resource: Record<string, unknown> = { id: 'resource-a', name: 'demo', enabled: false, count: 0 };
    if (fault === 'wrong-id') resource.id = 'resource-b';
    if (fault === 'missing-id') delete resource.id;
    if (fault === 'missing-name') delete resource.name;
    if (fault === 'missing-enabled') delete resource.enabled;
    if (fault === 'missing-count') delete resource.count;
    if (fault === 'wrong-count') resource.count = 7;
    if (fault === 'string-count') resource.count = '0';
    if (fault === 'network-name') resource.name = 'network unavailable';
    if (fault === 'timeout-name') resource.name = 'timeout';
    if (fault === 'auth-name') resource.name = 'authorization token 401';
    if (fault === 'processor-name') resource.name = 'processor';
    if (fault === 'extra-fields') resource.debugHint = 'network timeout auth processor';
    const data = fault === 'key-order' ? Object.fromEntries(Object.entries(resource).reverse()) : resource;
    response.writeHead(fault === 'status' ? 201 : 200, { 'Content-Type': 'application/json',
      ...(fault === 'no-cache' ? { 'Cache-Control': 'no-store' } : {}) });
    response.end(JSON.stringify({ data }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests: () => requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
