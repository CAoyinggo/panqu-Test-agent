import { createClient } from 'redis';
import { redactSensitiveText } from '../../core/redact.js';

export interface RateLimitDecision {
  limited: boolean;
  remaining: number;
  resetAt: string;
  limit: number;
}

export interface RateLimiter {
  readonly kind: 'memory' | 'redis';
  start(): Promise<void>;
  consume(key: string, nowMs?: number): Promise<RateLimitDecision>;
  close(): Promise<void>;
}

interface MemoryRateLimitEntry {
  windowStart: number;
  count: number;
  expiresAt: number;
}

export interface TtlLruRateLimiterOptions {
  limit: number;
  windowMs?: number;
  ttlMs?: number;
  maxEntries?: number;
  sweepIntervalMs?: number;
}

/**
 * 单实例开发/测试限流器。Map 的插入顺序作为 LRU 队列，TTL 清理处理闲置 key，
 * maxEntries 则提供硬上限，避免高基数 IP 使内存无限增长。
 */
export class TtlLruRateLimiter implements RateLimiter {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, MemoryRateLimitEntry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly sweepIntervalMs: number;
  private nextSweepAt = 0;

  constructor(options: TtlLruRateLimiterOptions) {
    this.limit = positiveInteger(options.limit, 'limit');
    this.windowMs = positiveInteger(options.windowMs ?? 60_000, 'windowMs');
    this.ttlMs = positiveInteger(options.ttlMs ?? 5 * 60_000, 'ttlMs');
    this.maxEntries = positiveInteger(options.maxEntries ?? 10_000, 'maxEntries');
    this.sweepIntervalMs = nonNegativeInteger(options.sweepIntervalMs ?? 30_000, 'sweepIntervalMs');
    if (this.ttlMs < this.windowMs) throw new Error('ttlMs 必须大于或等于 windowMs，避免活动窗口提前失效');
  }

  async start(): Promise<void> {}

  async consume(key: string, nowMs = Date.now()): Promise<RateLimitDecision> {
    this.sweep(nowMs);
    const previous = this.entries.get(key);
    let entry: MemoryRateLimitEntry;
    if (!previous || nowMs >= previous.expiresAt || nowMs - previous.windowStart >= this.windowMs) {
      entry = { windowStart: nowMs, count: 1, expiresAt: nowMs + this.ttlMs };
    } else {
      entry = { ...previous, count: previous.count + 1, expiresAt: nowMs + this.ttlMs };
    }

    // delete + set 将最近访问项移到 Map 尾部；达到上限时淘汰头部最久未使用项。
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
    return decision(entry.count, this.limit, entry.windowStart + this.windowMs, nowMs);
  }

  async close(): Promise<void> {
    this.entries.clear();
  }

  entryCount(): number {
    return this.entries.size;
  }

  private sweep(nowMs: number): void {
    if (nowMs < this.nextSweepAt) return;
    for (const [key, entry] of this.entries) {
      if (nowMs >= entry.expiresAt) this.entries.delete(key);
    }
    this.nextSweepAt = nowMs + this.sweepIntervalMs;
  }
}

export interface RedisRateLimitClient {
  readonly isOpen: boolean;
  connect(): Promise<unknown>;
  ping(): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface RedisRateLimiterOptions {
  url: string;
  limit: number;
  windowMs?: number;
  keyPrefix?: string;
  connectTimeoutMs?: number;
}

export interface RedisRateLimiterClientOptions {
  client: RedisRateLimitClient;
  ownsClient?: boolean;
  limit: number;
  windowMs?: number;
  keyPrefix?: string;
}

const REDIS_CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

/** 多实例生产限流器：INCR + PEXPIRE 在 Redis Lua 中原子执行。 */
export class RedisRateLimiter implements RateLimiter {
  readonly kind = 'redis' as const;
  private readonly client: RedisRateLimitClient;
  private readonly ownsClient: boolean;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly keyPrefix: string;

  constructor(options: RedisRateLimiterClientOptions) {
    this.client = options.client;
    this.ownsClient = options.ownsClient ?? false;
    this.limit = positiveInteger(options.limit, 'limit');
    this.windowMs = positiveInteger(options.windowMs ?? 60_000, 'windowMs');
    this.keyPrefix = options.keyPrefix?.trim() || 'panqu:rate-limit';
  }

  async start(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
    await this.client.ping();
  }

  async consume(key: string, nowMs = Date.now()): Promise<RateLimitDecision> {
    const raw = await this.client.eval(REDIS_CONSUME_SCRIPT, {
      keys: [`${this.keyPrefix}:${key}`],
      arguments: [String(this.windowMs)],
    });
    if (!Array.isArray(raw) || raw.length < 2) throw new Error('Redis 限流脚本返回值无效');
    const count = Number(raw[0]);
    const ttl = Number(raw[1]);
    if (!Number.isFinite(count) || !Number.isFinite(ttl)) throw new Error('Redis 限流脚本返回非数字结果');
    return decision(count, this.limit, nowMs + Math.max(0, ttl), nowMs);
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.client.isOpen) await this.client.quit();
  }
}

export function requireRedisUrl(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) throw new Error('[rate-limit] production/staging 必须显式配置 REDIS_URL，禁止回退进程内 Map');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('[rate-limit] REDIS_URL 不是合法 URL');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('[rate-limit] REDIS_URL 协议必须是 redis:// 或 rediss://');
  }
  return raw;
}

export function createRedisRateLimiter(options: RedisRateLimiterOptions): RedisRateLimiter {
  const { url: rawUrl, connectTimeoutMs: rawConnectTimeoutMs, ...limiterOptions } = options;
  const url = requireRedisUrl(rawUrl);
  const connectTimeoutMs = positiveInteger(rawConnectTimeoutMs ?? 5_000, 'connectTimeoutMs');
  const client = createClient({
    url,
    socket: {
      connectTimeout: connectTimeoutMs,
      reconnectStrategy: false,
    },
  }) as unknown as RedisRateLimitClient;
  client.on('error', (error) => {
    process.stderr.write(`[rate-limit] Redis 连接异常：${redactSensitiveText(error.message)}\n`);
  });
  return new RedisRateLimiter({ ...limiterOptions, client, ownsClient: true });
}

function decision(count: number, limit: number, resetAtMs: number, nowMs: number): RateLimitDecision {
  return {
    limited: count > limit,
    remaining: Math.max(0, limit - count),
    resetAt: new Date(Math.max(nowMs, resetAtMs)).toISOString(),
    limit,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`);
  return value;
}
