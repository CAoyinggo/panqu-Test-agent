import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPlatformServer } from '../../src/platform/api/server.js';
import { createPlatformService } from '../../src/platform/service/factory.js';
import { PostgresStartup } from '../../src/platform/service/startup.js';
import {
  createPostgresPool,
  requirePostgresConnectionString,
} from '../../src/platform/storage/postgres/pg-database.js';

function fakePool(query: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>) {
  return {
    query: vi.fn(query),
    end: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PostgreSQL production startup contract', () => {
  it('DATABASE_URL 缺失时 fail-fast，且不存在 postgres/postgres 回退', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => createPostgresPool()).toThrow(/显式配置 DATABASE_URL/);
    expect(() => requirePostgresConnectionString(undefined)).toThrow(/禁止使用默认连接/);
  });

  it('production/staging 拒绝显式 postgres/postgres 弱默认凭据', () => {
    expect(() => requirePostgresConnectionString(
      'postgresql://postgres:postgres@db.example.test:5432/platform',
      true,
    )).toThrow(/禁止使用 postgres\/postgres/);
  });

  it('严格按 DB Connection → Migration → READY 顺序启动', async () => {
    const order: string[] = [];
    const pool = fakePool(async (sql) => {
      order.push(sql === 'SELECT 1' ? 'connect' : `query:${sql}`);
      return { rows: [], rowCount: 0 };
    });
    let startup!: PostgresStartup;
    startup = new PostgresStartup(pool as unknown as Pool, async () => {
      expect(startup.status().state).toBe('MIGRATING');
      order.push('migrate');
      return ['v1'];
    });

    expect(startup.status()).toMatchObject({ state: 'NOT_READY', ready: false });
    await startup.start();

    expect(order).toEqual(['connect', 'migrate']);
    expect(startup.status()).toMatchObject({
      state: 'READY',
      ready: true,
      storage: 'postgres',
      appliedMigrations: ['v1'],
    });
    await startup.close();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('迁移失败时保持 FAILED、关闭 pool，HTTP Server 不绑定端口', async () => {
    const pool = fakePool(async (sql) => {
      if (sql === 'SELECT 1') return { rows: [], rowCount: 1 };
      throw new Error('migration ddl rejected');
    });
    const bundle = createPlatformService({
      storage: 'postgres',
      databaseUrl: 'postgresql://platform:strong-password@db.example.test:5432/platform',
      postgresPool: pool as unknown as Pool,
      mode: 'test',
      jwtSecret: 'postgres-startup-test-secret',
      seedProject: false,
      seedUsers: false,
    });
    const server = createPlatformServer({
      service: bundle.service,
      auth: bundle.auth,
      mode: 'test',
      token: 'test-token',
    });

    await expect(server.listen()).rejects.toThrow(/PostgreSQL 初始化失败.*migration ddl rejected/);
    expect(server.address()).toBeUndefined();
    expect(bundle.startupStatus()).toMatchObject({ state: 'FAILED', ready: false });
    expect(pool.end).toHaveBeenCalledOnce();

    const health = await bundle.service.health();
    expect(health).toMatchObject({ ok: false, status: 'DOWN' });
    expect(health.checks[0]).toMatchObject({ name: 'startup', ok: false });
    await server.close();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('只有迁移成功并进入 READY 后 HTTP Server 才绑定端口', async () => {
    const sqlOrder: string[] = [];
    const pool = fakePool(async (sql) => {
      sqlOrder.push(sql);
      return { rows: [], rowCount: 0 };
    });
    const bundle = createPlatformService({
      storage: 'postgres',
      databaseUrl: 'postgresql://platform:strong-password@db.example.test:5432/platform',
      postgresPool: pool as unknown as Pool,
      mode: 'test',
      jwtSecret: 'postgres-startup-success-secret',
      seedProject: false,
      seedUsers: false,
    });
    const server = createPlatformServer({
      service: bundle.service,
      auth: bundle.auth,
      mode: 'test',
      token: 'test-token',
    });

    expect(server.address()).toBeUndefined();
    expect(bundle.startupStatus()).toMatchObject({ state: 'NOT_READY', ready: false });
    const { port } = await server.listen();

    expect(port).toBeGreaterThan(0);
    expect(bundle.startupStatus()).toMatchObject({ state: 'READY', ready: true, appliedMigrations: ['v1'] });
    expect(sqlOrder[0]).toBe('SELECT 1');
    expect(sqlOrder[1]).toContain('CREATE TABLE IF NOT EXISTS "_migrations"');
    await server.close();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('production + postgres 在 Service 装配期也强制显式 DATABASE_URL', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => createPlatformService({
      storage: 'postgres',
      mode: 'production',
      jwtSecret: 'a-production-jwt-secret-with-sufficient-length',
      seedProject: false,
      seedUsers: false,
      allowDefaultCredentials: false,
    })).toThrow(/显式配置 DATABASE_URL/);
  });
});
