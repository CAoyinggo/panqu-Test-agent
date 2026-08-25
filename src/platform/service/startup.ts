import type { Pool } from 'pg';
import { applyPostgresMigrations } from '../ops/migrations.js';

export type PlatformStartupState =
  | 'NOT_READY'
  | 'CONNECTING'
  | 'MIGRATING'
  | 'READY'
  | 'FAILED'
  | 'CLOSED';

export interface PlatformStartupStatus {
  state: PlatformStartupState;
  ready: boolean;
  storage: 'none' | 'postgres';
  appliedMigrations: string[];
  error?: string;
}

export interface PlatformStartup {
  start(): Promise<void>;
  close(): Promise<void>;
  status(): PlatformStartupStatus;
}

type MigrationRunner = (pool: Pool) => Promise<string[]>;

/** 非 PostgreSQL 后端无需异步准备，创建后即 Ready。 */
export function createReadyStartup(): PlatformStartup {
  return {
    async start() {},
    async close() {},
    status: () => ({ state: 'READY', ready: true, storage: 'none', appliedMigrations: [] }),
  };
}

/**
 * PostgreSQL fail-fast 启动状态机：Connection → Migration → READY。
 * 任一步失败都会保持 FAILED、关闭连接池并向调用方抛错；绝不降级继续服务。
 */
export class PostgresStartup implements PlatformStartup {
  private state: PlatformStartupState = 'NOT_READY';
  private appliedMigrations: string[] = [];
  private error?: string;
  private startPromise?: Promise<void>;
  private poolClosed = false;

  constructor(
    private readonly pool: Pool,
    private readonly migrate: MigrationRunner = applyPostgresMigrations,
  ) {}

  start(): Promise<void> {
    if (this.state === 'READY') return Promise.resolve();
    if (this.state === 'CLOSED') return Promise.reject(new Error('[startup] PostgreSQL 连接池已关闭，不能再次启动'));
    if (this.state === 'FAILED') return Promise.reject(new Error(this.error ?? '[startup] PostgreSQL 启动失败'));
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.run();
    return this.startPromise;
  }

  private async run(): Promise<void> {
    try {
      this.state = 'CONNECTING';
      await this.pool.query('SELECT 1');

      this.state = 'MIGRATING';
      this.appliedMigrations = await this.migrate(this.pool);

      this.state = 'READY';
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.state = 'FAILED';
      this.error = `[startup] PostgreSQL 初始化失败：${message}`;
      await this.endPool();
      throw new Error(this.error, { cause });
    }
  }

  async close(): Promise<void> {
    await this.endPool();
    if (this.state !== 'FAILED') this.state = 'CLOSED';
  }

  status(): PlatformStartupStatus {
    return {
      state: this.state,
      ready: this.state === 'READY',
      storage: 'postgres',
      appliedMigrations: [...this.appliedMigrations],
      error: this.error,
    };
  }

  private async endPool(): Promise<void> {
    if (this.poolClosed) return;
    this.poolClosed = true;
    await this.pool.end().catch(() => undefined);
  }
}
