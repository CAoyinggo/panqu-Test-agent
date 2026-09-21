import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentProbe } from '../../../src/devtest/env-probe.js';

describe('EnvironmentProbe - 真实测试环境只读探针与巡检', () => {
  it('在 MOCK 模式下探测 test 环境，输出端点健康状态与模型就绪判定', async () => {
    const report = await EnvironmentProbe.probe({
      env: 'test',
      mock: true,
      modelId: 84,
      mediaType: 'video',
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('HEALTHY');
    expect(report.env).toBe('test');
    expect(report.baseUrl).toBe('https://test.panqu.com');
    expect(report.gatewayUrl).toBe('https://apitest.panqu.com');
    expect(report.endpoints.length).toBeGreaterThanOrEqual(3);
    expect(report.endpoints.every((e) => e.reachable)).toBe(true);
    expect(report.modelReadiness).toBeDefined();
    expect(report.modelReadiness?.willDivert).toBe(true);
    expect(report.modelReadiness?.newapiModel).toBe('wan3.0-video');
    expect(report.modelReadiness?.candidateChannelCount).toBeGreaterThan(0);
  });

  it('未提供会话凭证时标记 auth.status 为 MISSING 并给出指引建议', async () => {
    const report = await EnvironmentProbe.probe({
      env: 'test',
      mock: true,
    });

    expect(report.auth.hasSession).toBe(false);
    expect(report.auth.status).toBe('MISSING');
    expect(report.recommendations.some((r) => r.includes('Session Cookie'))).toBe(true);
  });

  it('从 session 文件读取凭证时标记 auth.status 为 VALID', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devtest-env-probe-'));
    const sessionFile = path.join(directory, 'session.json');
    try {
      await writeFile(sessionFile, JSON.stringify({ sessions: [{ env: 'test', cookie_string: 'PHPSESSID=session_test_token_123' }] }));
      const report = await EnvironmentProbe.probe({ env: 'test', sessionFile, mock: true });
      expect(report.auth.hasSession).toBe(true);
      expect(report.auth.status).toBe('VALID');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('默认使用受控仿真，并拒绝真实模式的非测试地址', async () => {
    expect((await EnvironmentProbe.probe({ env: 'test' })).endpoints).toHaveLength(3);
    await expect(EnvironmentProbe.probe({ env: 'test', baseUrl: 'https://example.com', mock: false }))
      .rejects.toThrow('REAL_URL_NOT_ALLOWED');
  });
});
