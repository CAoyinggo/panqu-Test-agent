import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FakeApiServer {
  baseUrl: string;
  requests: RecordedRequest[];
  lifecycle: { prepared: number; cleaned: number };
  users(): Record<string, { id: string; nickname: string; age: number; tenantId: string }>;
  close(): Promise<void>;
}

export interface FakeApiServerOptions {
  profileSuccessStatus?: number;
  slowResponseMs?: number;
  /** Test-only product defect injection for the deterministic /status/:code endpoint. */
  forcedStatuses?: Record<string, number>;
}

interface Identity {
  userId: string;
  role: 'USER' | 'ADMIN';
  tenantId: string;
}

const IDENTITIES: Record<string, Identity> = {
  'token-user-a': { userId: 'user-a', role: 'USER', tenantId: 'tenant-a' },
  'token-user-b': { userId: 'user-b', role: 'USER', tenantId: 'tenant-a' },
  'token-admin': { userId: 'admin', role: 'ADMIN', tenantId: 'tenant-a' },
  'token-tenant-b-user': { userId: 'user-c', role: 'USER', tenantId: 'tenant-b' },
};

const INITIAL_USERS: Record<string, { id: string; nickname: string; age: number; tenantId: string }> = {
  'user-a': { id: 'user-a', nickname: 'Alice', age: 20, tenantId: 'tenant-a' },
  'user-b': { id: 'user-b', nickname: 'Bob', age: 25, tenantId: 'tenant-a' },
  'user-c': { id: 'user-c', nickname: 'Carol', age: 30, tenantId: 'tenant-b' },
};

function freshUsers(): Record<string, { id: string; nickname: string; age: number; tenantId: string }> {
  return structuredClone(INITIAL_USERS);
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': `fake-${Date.now().toString(36)}`,
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendRaw(response: ServerResponse, status: number, body: string, contentType = 'text/plain'): void {
  response.writeHead(status, { 'content-type': contentType, 'x-request-id': `fake-${Date.now().toString(36)}` });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function identityOf(request: IncomingMessage): Identity | undefined {
  const authorization = request.headers.authorization ?? '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  return IDENTITIES[token];
}

async function handleProfile(
  request: IncomingMessage,
  response: ServerResponse,
  id: string,
  body: unknown,
  users: Record<string, { id: string; nickname: string; age: number; tenantId: string }>,
  successStatus: number,
): Promise<void> {
  const identity = identityOf(request);
  if (!identity) {
    send(response, 401, { error: { code: 'UNAUTHORIZED' } });
    return;
  }
  const user = users[id];
  if (!user) {
    send(response, 404, { error: { code: 'NOT_FOUND' } });
    return;
  }
  if (identity.tenantId !== user.tenantId || (identity.role !== 'ADMIN' && identity.userId !== id)) {
    send(response, 403, { error: { code: 'FORBIDDEN' } });
    return;
  }
  if (request.method !== 'PUT') {
    send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    send(response, 400, { error: { code: 'INVALID_PARAMETER' } });
    return;
  }
  const payload = body as Record<string, unknown>;
  const nicknameValid = typeof payload.nickname === 'string'
    && payload.nickname.length >= 2 && payload.nickname.length <= 20;
  const ageValid = !Object.hasOwn(payload, 'age')
    || (typeof payload.age === 'number' && Number.isInteger(payload.age) && payload.age >= 1 && payload.age <= 100);
  if (!nicknameValid || !ageValid) {
    send(response, 400, { error: { code: 'INVALID_PARAMETER' } });
    return;
  }
  user.nickname = payload.nickname as string;
  if (typeof payload.age === 'number') user.age = payload.age;
  send(response, successStatus, { data: { ...user, email: 'developer@example.com', phone: '13800138000' } });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

/** 仅监听本机随机端口的真实 HTTP Server，供开发验收 E2E 使用。 */
export async function startFakeApiServer(options: FakeApiServerOptions = {}): Promise<FakeApiServer> {
  const requests: RecordedRequest[] = [];
  const lifecycle = { prepared: 0, cleaned: 0 };
  let users = freshUsers();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const body = await readBody(request);
      requests.push({ method: request.method ?? 'GET', url: url.toString(), headers: { ...request.headers }, body });

      if (url.pathname === '/test-support/prepare' && request.method === 'POST') {
        users = freshUsers();
        lifecycle.prepared++;
        send(response, 200, { ok: true });
        return;
      }
      if (url.pathname === '/test-support/cleanup' && request.method === 'POST') {
        users = freshUsers();
        lifecycle.cleaned++;
        send(response, 200, { ok: true });
        return;
      }
      if (url.pathname === '/invalid-json') {
        sendRaw(response, 200, '{not-json', 'application/json');
        return;
      }
      if (url.pathname === '/slow') {
        setTimeout(() => send(response, 200, { ok: true }), options.slowResponseMs ?? 100);
        return;
      }
      const forcedStatus = url.pathname.match(/^\/status\/([1-5]\d{2})$/);
      if (forcedStatus) {
        const status = options.forcedStatuses?.[url.pathname] ?? Number(forcedStatus[1]);
        send(response, status, { status });
        return;
      }

      const profile = url.pathname.match(/^\/api\/users\/([^/]+)$/);
      if (profile) {
        await handleProfile(request, response, decodeURIComponent(profile[1]), body, users, options.profileSuccessStatus ?? 200);
        return;
      }

      const echo = url.pathname.match(/^\/echo\/([^/]+)$/);
      if (echo && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method ?? '')) {
        send(response, 200, {
          data: {
            method: request.method,
            id: decodeURIComponent(echo[1]),
            query: Object.fromEntries(url.searchParams),
            body: body ?? null,
            authorization: request.headers.authorization ?? null,
          },
        }, { 'x-contract': 'acceptance-v1' });
        return;
      }

      send(response, 404, { error: { code: 'NOT_FOUND' } });
    } catch (error) {
      send(response, 500, { error: { code: 'FAKE_SERVER_ERROR', message: (error as Error).message } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake API Server 启动失败');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    lifecycle,
    users: () => structuredClone(users),
    close: () => closeServer(server),
  };
}
