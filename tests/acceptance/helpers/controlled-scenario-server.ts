import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ScenarioHookResult } from '../../../src/acceptance/scenario-runner.js';
import type { ApiSpec, HttpMethod, ParameterSpec } from '../../../src/acceptance/requirement-ir.js';

export interface ControlledIdentity {
  actorId: string;
  tenantId: string;
  projectId: string;
}

export interface ControlledProfileSeed {
  kind: 'PROFILE';
  profileId: string;
  ownerActorId: string;
  displayName: string;
  email: string;
  role: string;
  tenantId: string;
  projectId: string;
}

export interface ControlledWorkflowSeed {
  kind: 'WORKFLOW';
  runId: string;
  contentRef: string;
  uploadId: string;
  taskId: string;
  resultRef: string;
}

export interface ControlledResourceCounts {
  profiles: number;
  payloads: number;
  uploads: number;
  tasks: number;
  results: number;
  total: number;
}

export interface ControlledCleanupExpectation extends ControlledResourceCounts {
  profileMutations: number;
}

export interface ControlledServerScenarioDefinition {
  scenarioId: string;
  prepareHook: string;
  cleanupHook: string;
  variables: Readonly<Record<string, unknown>>;
  actorHeaders: Readonly<Record<string, Record<string, string>>>;
  identities: Readonly<Record<string, ControlledIdentity>>;
  apiSpecs: readonly ApiSpec[];
  fixture: ControlledProfileSeed | ControlledWorkflowSeed;
  expectedOperationCount: number;
  cleanupExpectation: ControlledCleanupExpectation;
}

export interface ControlledRecordedRequest {
  method: string;
  path: string;
  authorization?: string;
  body: unknown;
  remoteAddress?: string;
}

export interface ControlledScenarioLifecycle {
  prepared: number;
  cleaned: number;
  cleanupSnapshots: ControlledCleanupExpectation[];
}

export interface ControlledScenarioServer {
  baseUrl: string;
  requests: ControlledRecordedRequest[];
  lifecycle: ControlledScenarioLifecycle;
  prepare(definition: ControlledServerScenarioDefinition, runId: string): ScenarioHookResult;
  cleanup(definition: ControlledServerScenarioDefinition): ScenarioHookResult;
  resourceCounts(): ControlledResourceCounts;
  profileMutationCount(): number;
  close(): Promise<void>;
}

interface StoredProfile extends Omit<ControlledProfileSeed, 'kind' | 'profileId'> {
  id: string;
  revision: number;
  canonicalDigest: string;
}

interface StoredUpload {
  id: string;
  runId: string;
  contentRef: string;
}

interface StoredTask {
  id: string;
  runId: string;
  sourceUploadId: string;
  status: 'COMPLETED';
  resultRef: string;
}

interface StoredResult {
  ref: string;
  runId: string;
  taskId: string;
}

function parameter(
  name: string,
  location: ParameterSpec['location'],
  type: ParameterSpec['type'] = 'string',
  required = true,
): ParameterSpec {
  return { name, location, type, required, nullable: false };
}

function apiSpec(options: {
  id: string;
  method: HttpMethod;
  path: string;
  body?: ParameterSpec[];
  statuses: number[];
}): ApiSpec {
  return {
    id: options.id,
    operationKey: `${options.method} ${options.path}`,
    authPolicy: 'AUTH_REQUIRED',
    method: options.method,
    path: options.path,
    headers: [parameter('Authorization', 'header')],
    query: [],
    pathParams: [],
    body: options.body ?? [],
    responses: options.statuses.map((status) => ({ status })),
  };
}

export function createProfileFixtureApiSpecs(options: {
  scenarioId: string;
  profileId: string;
  observerReads: boolean;
  writeFields: readonly string[];
  writeStatus: number;
}): ApiSpec[] {
  const readPath = options.observerReads
    ? `/__fixtures/profile-observer/users/${options.profileId}`
    : `/__fixtures/profile/users/${options.profileId}`;
  const writePath = `/__fixtures/profile/users/${options.profileId}`;
  return [
    apiSpec({ id: `${options.scenarioId}:read-profile`, method: 'GET', path: readPath, statuses: [200] }),
    apiSpec({
      id: `${options.scenarioId}:write-profile`,
      method: 'PUT',
      path: writePath,
      body: options.writeFields.map((name) => parameter(name, 'body')),
      statuses: [options.writeStatus],
    }),
  ];
}

export function createWorkflowFixtureApiSpecs(options: {
  scenarioId: string;
  runId: string;
  taskId: string;
}): ApiSpec[] {
  return [
    apiSpec({
      id: `${options.scenarioId}:create-upload`, method: 'POST', path: '/__fixtures/workflow/uploads', statuses: [201],
      body: [parameter('contentRef', 'body'), parameter('runId', 'body')],
    }),
    apiSpec({
      id: `${options.scenarioId}:create-task`, method: 'POST', path: '/__fixtures/workflow/tasks', statuses: [202],
      body: [parameter('uploadId', 'body'), parameter('runId', 'body')],
    }),
    apiSpec({
      id: `${options.scenarioId}:task-status`, method: 'GET',
      path: `/__fixtures/workflow/tasks/${options.taskId}/status`, statuses: [200],
    }),
    apiSpec({
      id: `${options.scenarioId}:task-detail`, method: 'GET',
      path: `/__fixtures/workflow/tasks/${options.taskId}`, statuses: [200],
    }),
    apiSpec({
      id: `${options.scenarioId}:run-observer`, method: 'GET',
      path: `/__fixtures/workflow-observer/runs/${options.runId}`, statuses: [200],
    }),
  ];
}

/** Pack 侧的声明保持纯数据，运行时只允许测试显式 import 的受控定义。 */
export function defineControlledServerScenario<T extends ControlledServerScenarioDefinition>(definition: T): T {
  return definition;
}

function profileDigest(profile: Omit<StoredProfile, 'canonicalDigest'>): string {
  return createHash('sha256').update(JSON.stringify({
    id: profile.id,
    ownerActorId: profile.ownerActorId,
    displayName: profile.displayName,
    email: profile.email,
    role: profile.role,
    tenantId: profile.tenantId,
    projectId: profile.projectId,
    revision: profile.revision,
  })).digest('hex');
}

function publicProfile(profile: StoredProfile): Record<string, unknown> {
  const fields = {
    id: profile.id,
    displayName: profile.displayName,
    email: profile.email,
    role: profile.role,
    tenantId: profile.tenantId,
    projectId: profile.projectId,
  };
  return {
    ...fields,
    revision: profile.revision,
    canonicalDigest: profile.canonicalDigest,
    profile: fields,
  };
}

function send(response: ServerResponse, status: number, body: unknown, requestId: number): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': `controlled-${requestId}`,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function exactCounts(actual: ControlledCleanupExpectation, expected: ControlledCleanupExpectation): boolean {
  return Object.keys(expected).every((key) => actual[key as keyof ControlledCleanupExpectation] === expected[key as keyof ControlledCleanupExpectation]);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

/**
 * 真实监听 127.0.0.1 随机端口的确定性业务夹具。所有 Scenario Operation
 * 都必须经过 Node HTTP 栈和全局 fetch；Prepare/Cleanup 只操作本实例隔离内存。
 */
export async function startControlledScenarioServer(): Promise<ControlledScenarioServer> {
  const requests: ControlledRecordedRequest[] = [];
  const lifecycle: ControlledScenarioLifecycle = { prepared: 0, cleaned: 0, cleanupSnapshots: [] };
  const profiles = new Map<string, StoredProfile>();
  const payloads = new Map<string, string>();
  const uploads = new Map<string, StoredUpload>();
  const tasks = new Map<string, StoredTask>();
  const results = new Map<string, StoredResult>();
  let activeDefinition: ControlledServerScenarioDefinition | undefined;
  let profileMutations = 0;
  let requestSequence = 0;

  const resourceCounts = (): ControlledResourceCounts => {
    const counts = {
      profiles: profiles.size,
      payloads: payloads.size,
      uploads: uploads.size,
      tasks: tasks.size,
      results: results.size,
    };
    return { ...counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) };
  };

  const identityOf = (request: IncomingMessage): ControlledIdentity | undefined => {
    const token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return activeDefinition?.identities[token];
  };

  const server = createServer(async (request, response) => {
    const currentRequestId = ++requestSequence;
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const body = await readBody(request);
      requests.push({
        method: request.method ?? 'GET',
        path: url.pathname,
        authorization: request.headers.authorization,
        body,
        remoteAddress: request.socket.remoteAddress,
      });
      const identity = identityOf(request);
      if (!activeDefinition || !identity) {
        send(response, 401, { error: { code: 'UNAUTHORIZED' } }, currentRequestId);
        return;
      }

      const profileMatch = url.pathname.match(/^\/__fixtures\/profile\/users\/([^/]+)$/);
      const observerMatch = url.pathname.match(/^\/__fixtures\/profile-observer\/users\/([^/]+)$/);
      if (observerMatch && request.method === 'GET') {
        const profile = profiles.get(decodeURIComponent(observerMatch[1]));
        send(response, profile ? 200 : 404,
          profile ? { data: publicProfile(profile) } : { error: { code: 'PROFILE_NOT_FOUND' } }, currentRequestId);
        return;
      }
      if (profileMatch) {
        const profile = profiles.get(decodeURIComponent(profileMatch[1]));
        if (!profile) {
          send(response, 404, { error: { code: 'PROFILE_NOT_FOUND' } }, currentRequestId);
          return;
        }
        if (request.method === 'GET') {
          if (profile.ownerActorId !== identity.actorId) {
            send(response, 403, { error: { code: 'PROFILE_READ_FORBIDDEN' } }, currentRequestId);
            return;
          }
          send(response, 200, { data: publicProfile(profile) }, currentRequestId);
          return;
        }
        if (request.method === 'PUT') {
          if (profile.ownerActorId !== identity.actorId) {
            send(response, 403, { error: { code: 'PROFILE_WRITE_FORBIDDEN' } }, currentRequestId);
            return;
          }
          const input = recordOf(body);
          const protectedFields = ['role', 'tenantId', 'projectId'];
          if (!input || protectedFields.some((field) => Object.prototype.hasOwnProperty.call(input, field))) {
            send(response, 422, { error: { code: 'PROFILE_FIELD_NOT_WRITABLE' } }, currentRequestId);
            return;
          }
          if (typeof input.displayName !== 'string' || !input.displayName.trim()) {
            send(response, 422, { error: { code: 'PROFILE_INPUT_INVALID' } }, currentRequestId);
            return;
          }
          profile.displayName = input.displayName;
          profile.revision++;
          profile.canonicalDigest = profileDigest(profile);
          profileMutations++;
          send(response, 200, { data: publicProfile(profile) }, currentRequestId);
          return;
        }
      }

      if (url.pathname === '/__fixtures/workflow/uploads' && request.method === 'POST') {
        const input = recordOf(body);
        const fixture = activeDefinition.fixture;
        if (fixture.kind !== 'WORKFLOW' || input?.runId !== fixture.runId || input.contentRef !== fixture.contentRef
          || payloads.get(fixture.contentRef) !== fixture.runId) {
          send(response, 422, { error: { code: 'UPLOAD_INPUT_INVALID' } }, currentRequestId);
          return;
        }
        uploads.set(fixture.uploadId, { id: fixture.uploadId, runId: fixture.runId, contentRef: fixture.contentRef });
        send(response, 201, { data: { uploadId: fixture.uploadId } }, currentRequestId);
        return;
      }
      if (url.pathname === '/__fixtures/workflow/tasks' && request.method === 'POST') {
        const input = recordOf(body);
        const fixture = activeDefinition.fixture;
        if (fixture.kind !== 'WORKFLOW' || input?.runId !== fixture.runId || input.uploadId !== fixture.uploadId
          || !uploads.has(fixture.uploadId)) {
          send(response, 422, { error: { code: 'TASK_BINDING_INVALID' } }, currentRequestId);
          return;
        }
        tasks.set(fixture.taskId, {
          id: fixture.taskId,
          runId: fixture.runId,
          sourceUploadId: fixture.uploadId,
          status: 'COMPLETED',
          resultRef: fixture.resultRef,
        });
        results.set(fixture.resultRef, { ref: fixture.resultRef, runId: fixture.runId, taskId: fixture.taskId });
        send(response, 202, { data: { taskId: fixture.taskId, status: 'QUEUED' } }, currentRequestId);
        return;
      }
      const statusMatch = url.pathname.match(/^\/__fixtures\/workflow\/tasks\/([^/]+)\/status$/);
      if (statusMatch && request.method === 'GET') {
        const task = tasks.get(decodeURIComponent(statusMatch[1]));
        send(response, task ? 200 : 404,
          task ? { data: { taskId: task.id, status: task.status } } : { error: { code: 'TASK_NOT_FOUND' } }, currentRequestId);
        return;
      }
      const taskMatch = url.pathname.match(/^\/__fixtures\/workflow\/tasks\/([^/]+)$/);
      if (taskMatch && request.method === 'GET') {
        const task = tasks.get(decodeURIComponent(taskMatch[1]));
        send(response, task ? 200 : 404,
          task ? { data: {
            taskId: task.id,
            status: task.status,
            sourceUploadId: task.sourceUploadId,
            resultRef: task.resultRef,
          } } : { error: { code: 'TASK_NOT_FOUND' } }, currentRequestId);
        return;
      }
      const observer = url.pathname.match(/^\/__fixtures\/workflow-observer\/runs\/([^/]+)$/);
      if (observer && request.method === 'GET') {
        const runId = decodeURIComponent(observer[1]);
        send(response, 200, { data: {
          uploadCount: [...uploads.values()].filter((item) => item.runId === runId).length,
          taskCount: [...tasks.values()].filter((item) => item.runId === runId).length,
          resultCount: [...results.values()].filter((item) => item.runId === runId).length,
        } }, currentRequestId);
        return;
      }

      send(response, 404, { error: { code: 'CONTROLLED_ROUTE_NOT_FOUND' } }, currentRequestId);
    } catch (error) {
      send(response, 500, { error: { code: 'CONTROLLED_FIXTURE_ERROR', message: (error as Error).message } }, currentRequestId);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('CONTROLLED_FIXTURE_START_FAILED');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    lifecycle,
    prepare: (definition, runId) => {
      if (activeDefinition || resourceCounts().total > 0) throw new Error('CONTROLLED_FIXTURE_NOT_ISOLATED');
      if (!runId) throw new Error('CONTROLLED_FIXTURE_RUN_ID_REQUIRED');
      activeDefinition = definition;
      profileMutations = 0;
      if (definition.fixture.kind === 'PROFILE') {
        const seed = definition.fixture;
        const profile: Omit<StoredProfile, 'canonicalDigest'> = {
          id: seed.profileId,
          ownerActorId: seed.ownerActorId,
          displayName: seed.displayName,
          email: seed.email,
          role: seed.role,
          tenantId: seed.tenantId,
          projectId: seed.projectId,
          revision: 1,
        };
        profiles.set(profile.id, { ...profile, canonicalDigest: profileDigest(profile) });
      } else {
        payloads.set(definition.fixture.contentRef, definition.fixture.runId);
      }
      lifecycle.prepared++;
      return { variables: { ...definition.variables } };
    },
    cleanup: (definition) => {
      if (activeDefinition?.scenarioId !== definition.scenarioId) throw new Error('CONTROLLED_FIXTURE_SCENARIO_MISMATCH');
      const snapshot = { ...resourceCounts(), profileMutations };
      lifecycle.cleanupSnapshots.push(snapshot);
      if (!exactCounts(snapshot, definition.cleanupExpectation)) {
        throw new Error(`CONTROLLED_FIXTURE_PRE_CLEANUP_MISMATCH：expected=${JSON.stringify(definition.cleanupExpectation)} actual=${JSON.stringify(snapshot)}`);
      }
      profiles.clear();
      payloads.clear();
      uploads.clear();
      tasks.clear();
      results.clear();
      activeDefinition = undefined;
      lifecycle.cleaned++;
      const after = resourceCounts();
      if (after.total !== 0) throw new Error(`CONTROLLED_FIXTURE_CLEANUP_INCOMPLETE：${JSON.stringify(after)}`);
      return { variables: { cleanupResourceCount: after.total } };
    },
    resourceCounts,
    profileMutationCount: () => profileMutations,
    close: () => closeServer(server),
  };
}
