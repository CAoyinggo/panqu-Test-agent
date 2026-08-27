import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { parseAcceptanceRequirement } from '../../../src/acceptance/requirement-parser.js';
import { discoverDevTestEnvironment } from '../../../src/devtest/environment-discovery.js';

const REQUIREMENT = parseAcceptanceRequirement(`# Health

GET /health
公开接口，无需认证。
响应返回 200。
AC-1 GET /health 返回 200。
`);

describe('DevTest Environment Discovery', () => {
  it('显式 Base URL 是开发者选择，Preflight 探测 Health/API 后使用它', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'devtest-env-'));
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
    const result = await discoverDevTestEnvironment({
      explicitBaseUrl: 'http://127.0.0.1:43123', environment: 'local', projectRoot: root,
      requirement: REQUIREMENT, fetchImpl,
    });
    expect(result.selectedBaseUrl).toBe('http://127.0.0.1:43123');
    expect(result.ambiguous).toBe(false);
    expect(result.checks).toEqual(expect.objectContaining({ baseUrl: 'READY', health: 'READY', api: 'READY' }));
  });

  it('多个可访问候选不自动选择，明确 AMBIGUOUS_ENVIRONMENT', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'devtest-env-'));
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const result = await discoverDevTestEnvironment({
      environment: 'local', projectRoot: root, requirement: REQUIREMENT, fetchImpl, allowLocalDefaults: true,
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.ambiguous).toBe(true);
    expect(result.selectedBaseUrl).toBeUndefined();
    expect(result.reason).toContain('AMBIGUOUS_ENVIRONMENT');
  });

  it('没有提供环境时降级为静态分析，不猜测 localhost 也不发网络请求', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'devtest-env-'));
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const result = await discoverDevTestEnvironment({
      environment: 'local', projectRoot: root, requirement: REQUIREMENT, fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'BLOCKED',
      selectedBaseUrl: undefined,
      candidates: [],
      reason: expect.stringContaining('ENVIRONMENT_NOT_PROVIDED_STATIC_ONLY'),
      executableDimensions: [],
    });
    expect(result.blockedDimensions).toContainEqual({
      dimension: 'API', reason: 'ENVIRONMENT_NOT_PROVIDED_STATIC_ONLY',
    });
  });

  it('项目配置地址只作为静态候选，未显式授权时不探针', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'devtest-env-'));
    await writeFile(path.join(root, '.env'), 'TESTFLOW_BASE_URL=http://127.0.0.1:43124\n', 'utf8');
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const result = await discoverDevTestEnvironment({
      environment: 'local', projectRoot: root, requirement: REQUIREMENT, fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.reason).toContain('ENVIRONMENT_NOT_PROVIDED_STATIC_ONLY');
    expect(result.candidates).toContainEqual(expect.objectContaining({
      source: 'PROJECT_CONFIG', reachable: false, error: 'ENVIRONMENT_CANDIDATE_NOT_AUTHORIZED',
    }));

    const authorized = await discoverDevTestEnvironment({
      environment: 'local', projectRoot: root, requirement: REQUIREMENT, fetchImpl,
      allowDiscoveredEnvironmentProbe: true,
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(authorized.selectedBaseUrl).toBe('http://127.0.0.1:43124');
  });

  it('DRY_RUN 只解析候选环境，不发出 Health/API 网络探针', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'devtest-env-'));
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const result = await discoverDevTestEnvironment({
      explicitBaseUrl: 'http://127.0.0.1:43123', environment: 'local', projectRoot: root,
      requirement: REQUIREMENT, fetchImpl, probeNetwork: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'BLOCKED',
      selectedBaseUrl: 'http://127.0.0.1:43123',
      reason: expect.stringContaining('DRY_RUN_ENVIRONMENT_NOT_PROBED'),
    });
    expect(result.candidates).toContainEqual(expect.objectContaining({
      url: 'http://127.0.0.1:43123', reachable: false, error: 'DRY_RUN_ENVIRONMENT_NOT_PROBED',
    }));
  });
});
