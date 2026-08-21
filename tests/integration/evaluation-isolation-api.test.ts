// Phase 51.1：AI Evaluation API / JWT / Project Scope 集成隔离
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import { createPlatformServer, type PlatformHttpServer } from '../../src/platform/api/index.js';
import { standardEnvironments } from '../../src/platform/projects/project-schema.js';
import { ProjectAIQualityRegistry } from '../../src/ai-quality/project-service.js';

interface ServerHarness {
  url: string;
  server: PlatformHttpServer;
  request(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: unknown }>;
}

const opened: ServerHarness[] = [];

async function makeServer(): Promise<{ harness: ServerHarness; projects: ProjectAIQualityRegistry }> {
  const bundle = createPlatformService({ seedProject: true, seedUsers: true, jwtSecret: 'phase51-isolation-secret' });
  await bundle.auth.ensureSeeded();
  for (const id of ['order', 'catalog']) {
    if (!bundle.projects.getProject(id)) bundle.projects.createProject({ id, name: id.toUpperCase(), businesses: [id], environments: standardEnvironments() });
  }
  const projects = new ProjectAIQualityRegistry();
  projects.forProject('wan3').ingest({ domain: 'RISK', prediction: 'P2', actual: 'P0', feedbackType: 'INCORRECT', source: 'HUMAN', channel: 'HUMAN_CORRECTION' });
  projects.forProject('order').ingest({ domain: 'RCA', prediction: 'NETWORK', actual: 'MODEL', feedbackType: 'INCORRECT', source: 'HUMAN', channel: 'RCA_VERIFICATION' });
  projects.forProject('catalog');
  projects.forProject('wan3').runContinuousEval({ schedule: 'NIGHTLY', createdBy: 'qa-a' });
  await bundle.telemetry.recordExecution({ runId: 'eval-a', projectId: 'wan3', phase: 'evaluation', result: 'success', durationMs: 10 });
  await bundle.telemetry.recordExecution({ runId: 'eval-b', projectId: 'order', phase: 'evaluation', result: 'success', durationMs: 20 });

  const server = createPlatformServer({ service: bundle.service, auth: bundle.auth, mode: 'test', aiQualityProjects: projects });
  const { url } = await server.listen();
  const harness: ServerHarness = {
    url,
    server,
    async request(method, path, token, body) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, data: JSON.parse(text) as unknown };
    },
  };
  opened.push(harness);
  return { harness, projects };
}

async function login(h: ServerHarness, username: string, password: string): Promise<string> {
  const result = await h.request('POST', '/auth/login', undefined, { username, password });
  expect(result.status).toBe(200);
  return (result.data as { accessToken: string }).accessToken;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.server.close();
});

describe('Phase 51.1 Multi-Project Evaluation Isolation API', () => {
  it('User A 只允许 Project A；User B 只允许 Project B', async () => {
    const { harness } = await makeServer();
    const userA = await login(harness, 'qa-a', 'qa123456');
    const userB = await login(harness, 'qa-b', 'qa123456');

    expect((await harness.request('GET', '/api/evaluation/scope?projectId=wan3', userA)).status).toBe(200);
    expect((await harness.request('GET', '/api/evaluation/scope?projectId=order', userA)).status).toBe(403);
    expect((await harness.request('GET', '/api/evaluation/scope?projectId=order', userB)).status).toBe(200);
    expect((await harness.request('GET', '/api/evaluation/scope?projectId=wan3', userB)).status).toBe(403);
  });

  it('Evaluation / Benchmark / GroundTruth / History / Telemetry 全部 project scoped', async () => {
    const { harness } = await makeServer();
    const admin = await login(harness, 'admin', 'admin123');
    for (const endpoint of ['report', 'benchmarks', 'ground-truth', 'history', 'telemetry']) {
      const a = await harness.request('GET', `/api/evaluation/${endpoint}?projectId=wan3`, admin);
      const b = await harness.request('GET', `/api/evaluation/${endpoint}?projectId=order`, admin);
      expect(a.status, endpoint).toBe(200);
      expect(b.status, endpoint).toBe(200);
      expect((a.data as { projectId: string }).projectId).toBe('wan3');
      expect((b.data as { projectId: string }).projectId).toBe('order');
    }
    const historyA = await harness.request('GET', '/api/evaluation/history?projectId=wan3', admin);
    const historyB = await harness.request('GET', '/api/evaluation/history?projectId=order', admin);
    expect((historyA.data as { runs: unknown[] }).runs).toHaveLength(1);
    expect((historyB.data as { runs: unknown[] }).runs).toHaveLength(0);
    const telemetryA = await harness.request('GET', '/api/evaluation/telemetry?projectId=wan3', admin);
    expect((telemetryA.data as { events: Array<{ projectId: string }> }).events.every((e) => e.projectId === 'wan3')).toBe(true);
  });

  it('原有 AI API 也按 projectId 分区，不能从另一项目按 ID 读取或修改', async () => {
    const { harness, projects } = await makeServer();
    const admin = await login(harness, 'admin', 'admin123');
    const feedbackA = projects.forProject('wan3').feedback.list()[0];

    const listA = await harness.request('GET', '/api/ai-feedback?projectId=wan3', admin);
    const listB = await harness.request('GET', '/api/ai-feedback?projectId=order', admin);
    expect((listA.data as Array<{ domain: string }>)[0].domain).toBe('RISK');
    expect((listB.data as Array<{ domain: string }>)[0].domain).toBe('RCA');

    const crossWrite = await harness.request('POST', `/api/ai-feedback/${feedbackA.id}/verify?projectId=order`, admin, {});
    expect(crossWrite.status).toBe(400);
    expect(projects.forProject('wan3').feedback.get(feedbackA.id)?.verified).toBe(false);
  });
});
