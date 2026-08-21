// E2E：Production Deployment（Phase 26.1）
// 验证：可重复部署链路（build → preflight → health → smoke → version）
//       /api/version 公开端点（无需认证）、构建溯源、回滚版本兼容、.env 模板无敏感值。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPlatformService } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import { buildVersionInfo, isVersionCompatible, PLATFORM_VERSION } from '../../src/platform/version.js';
import { runPlatformSmoke } from '../../src/platform/ops/smoke.js';
import { runPlatformPreflight, preflightSummary } from '../../src/platform/ops/preflight.js';

const REPO = path.resolve(import.meta.dirname, '../..');

describe('Phase 26.1 Production Deployment', () => {
  it('版本溯源：buildVersionInfo 返回 version/commit/buildTime/environment，可被覆盖', () => {
    const info = buildVersionInfo();
    expect(info.version).toBe(PLATFORM_VERSION);
    expect(['development', 'test', 'staging', 'production']).toContain(info.environment);
    const overridden = buildVersionInfo({ version: '4.2.0', commit: 'abc123', buildTime: 't0', environment: 'staging' });
    expect(overridden).toEqual({ version: '4.2.0', commit: 'abc123', buildTime: 't0', environment: 'staging' });
  });

  it('回滚兼容性：主版本相同、次版本差 ≤1 兼容（v4.2 → v4.1 回滚），主版本不同不兼容', () => {
    expect(isVersionCompatible('4.2.0', '4.1.0')).toBe(true);
    expect(isVersionCompatible('4.2.0', '4.2.3')).toBe(true);
    expect(isVersionCompatible('4.2.0', '5.0.0')).toBe(false);
    expect(isVersionCompatible('4.2.0', '4.0.0')).toBe(false);
  });

  it('GET /api/version：无需认证即可访问，返回四字段', async () => {
    const bundle = createPlatformService({ seedProject: true });
    const server = createPlatformServer({ service: bundle.service, token: 't' });
    const { port } = await server.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/version`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, string>;
      expect(body.version).toBe(PLATFORM_VERSION);
      expect(typeof body.commit).toBe('string');
      expect(typeof body.buildTime).toBe('string');
      expect(typeof body.environment).toBe('string');
    } finally {
      await server.close();
    }
  });

  it('部署配置模板：config/env 下三个 .env 模板存在且不含真实敏感值，.gitignore 白名单放行', () => {
    for (const name of ['.env.example', '.env.staging.example', '.env.production.example']) {
      const file = path.join(REPO, 'config', 'env', name);
      expect(fs.existsSync(file), `${name} 存在`).toBe(true);
      const content = fs.readFileSync(file, 'utf-8');
      // 不允许真实密钥入库：这些字段要么为空要么是占位符
      for (const field of ['JWT_SECRET', 'DATABASE_URL', 'LLM_API_KEY', 'FEISHU_WEBHOOK_URL']) {
        const line = content.split('\n').find((l) => l.startsWith(`${field}=`));
        expect(line, `${name} 含 ${field} 行`).toBeDefined();
        expect(line!.split('=')[1].trim(), `${name} 的 ${field} 必须为空`).toBe('');
      }
    }
    const gitignore = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('!config/env/.env.staging.example');
    expect(gitignore).toContain('!config/env/.env.production.example');
  });

  it('部署验收链：sqlite(staging) 下 health 全 ok、preflight 无 BLOCK、smoke 全 PASS', async () => {
    // preflight（独立于实例；正常环境无 BLOCK）
    const pchecks = await runPlatformPreflight({ checkPostgres: false });
    const psummary = preflightSummary(pchecks);
    expect(psummary.block).toBe(0);

    // smoke（独立临时 SQLite，真实运营闭环）
    const smoke = await runPlatformSmoke();
    expect(smoke.ok).toBe(true);
    expect(smoke.runStatus).toBe('COMPLETED');

    // 实例健康检查（sqlite staging 数据目录）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panqu-deploy-'));
    try {
      const bundle = createPlatformService({ seedProject: true, dataDir: dir, storage: 'sqlite', jwtSecret: 'deploy-secret' });
      const health = await bundle.service.health();
      expect(health.ok).toBe(true);
      const names = health.checks.map((c) => c.name);
      for (const n of ['projects', 'runs', 'scheduler', 'workers', 'approvals', 'audit', 'telemetry', 'activation']) {
        expect(names).toContain(n);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
