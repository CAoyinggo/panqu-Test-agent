import { describe, expect, it, vi } from 'vitest';
import { createPlatformServer } from '../../src/platform/api/server.js';
import {
  RedisRateLimiter,
  requireRedisUrl,
  TtlLruRateLimiter,
  type RateLimiter,
  type RedisRateLimitClient,
} from '../../src/platform/api/rate-limiter.js';
import { createPlatformService } from '../../src/platform/service/factory.js';

describe('TTL/LRU in-memory rate limiter', () => {
  it('TTL 清理闲置 key，LRU 硬上限淘汰最久未使用项', async () => {
    const limiter = new TtlLruRateLimiter({
      limit: 2,
      windowMs: 1_000,
      ttlMs: 1_000,
      maxEntries: 2,
      sweepIntervalMs: 0,
    });

    await limiter.consume('a', 0);
    await limiter.consume('b', 10);
    await limiter.consume('a', 20); // a 成为最近使用，b 成为 LRU
    await limiter.consume('c', 30);
    expect(limiter.entryCount()).toBe(2);
    expect((await limiter.consume('b', 40)).remaining).toBe(1); // b 已淘汰，重新计数
    expect(limiter.entryCount()).toBe(2);

    await limiter.consume('fresh', 2_000);
    expect(limiter.entryCount()).toBe(1); // 其余闲置 key 已过 TTL
  });

  it('固定窗口内超过配额返回 limited，并给出正确 resetAt', async () => {
    const limiter = new TtlLruRateLimiter({ limit: 2, windowMs: 60_000 });
    expect(await limiter.consume('ip', 1_000)).toMatchObject({ limited: false, remaining: 1 });
    expect(await limiter.consume('ip', 2_000)).toMatchObject({ limited: false, remaining: 0 });
    expect(await limiter.consume('ip', 3_000)).toEqual({
      limited: true,
      remaining: 0,
      resetAt: new Date(61_000).toISOString(),
      limit: 2,
    });
  });
});

describe('Redis production rate limiter', () => {
  it('通过 Lua EVAL 原子消费共享配额', async () => {
    let count = 0;
    const client: RedisRateLimitClient = {
      isOpen: true,
      connect: vi.fn(async () => undefined),
      ping: vi.fn(async () => 'PONG'),
      eval: vi.fn(async (_script, options) => {
        expect(options.keys).toEqual(['test:limit:127.0.0.1']);
        expect(options.arguments).toEqual(['60000']);
        count += 1;
        return [count, 60_000];
      }),
      quit: vi.fn(async () => undefined),
      on: vi.fn(),
    };
    const limiter = new RedisRateLimiter({ client, limit: 1, keyPrefix: 'test:limit' });

    await limiter.start();
    expect(await limiter.consume('127.0.0.1', 1_000)).toMatchObject({ limited: false, remaining: 0 });
    expect(await limiter.consume('127.0.0.1', 2_000)).toMatchObject({ limited: true, remaining: 0 });
    expect(client.eval).toHaveBeenCalledTimes(2);
    expect(client.ping).toHaveBeenCalledOnce();
  });

  it('production/staging 缺少 Redis 配置或注入内存后端时 fail-fast', () => {
    vi.stubEnv('REDIS_URL', '');
    const bundle = createPlatformService({ seedProject: false, seedUsers: false, jwtSecret: 'rate-limit-production-secret' });
    expect(() => createPlatformServer({ service: bundle.service, auth: bundle.auth, mode: 'production' })).toThrow(/必须显式配置 REDIS_URL/);
    expect(() => createPlatformServer({
      service: bundle.service,
      auth: bundle.auth,
      mode: 'staging',
      rateLimiter: new TtlLruRateLimiter({ limit: 10 }),
    })).toThrow(/必须使用 Redis 限流器/);
    vi.unstubAllEnvs();
  });

  it('Redis 启动失败时 API 不绑定端口', async () => {
    const bundle = createPlatformService({ seedProject: false, seedUsers: false, jwtSecret: 'rate-limit-startup-secret' });
    const failingLimiter: RateLimiter = {
      kind: 'redis',
      start: vi.fn(async () => { throw new Error('redis unavailable'); }),
      consume: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const server = createPlatformServer({
      service: bundle.service,
      auth: bundle.auth,
      mode: 'production',
      rateLimiter: failingLimiter,
    });

    await expect(server.listen()).rejects.toThrow(/redis unavailable/);
    expect(server.address()).toBeUndefined();
    expect(failingLimiter.close).toHaveBeenCalledOnce();
    await server.close();
  });

  it('只接受 redis:// 和 rediss:// URL', () => {
    expect(requireRedisUrl('redis://localhost:6379')).toBe('redis://localhost:6379');
    expect(requireRedisUrl('rediss://redis.example.test:6380')).toBe('rediss://redis.example.test:6380');
    expect(() => requireRedisUrl('http://localhost')).toThrow(/协议必须/);
  });
});
