// 故障注入仓储（Phase 26.4 S3）：模拟 Storage / Database 短暂不可用
// 包装任意 Repository<T>，通过 flip(down) 触发"数据库不可用"（所有操作抛错），
// 用于验证：Health=DEGRADED、Scheduler=PAUSED、Run 不丢失、恢复后继续。
// 熔断器透明透传；可用 inner 绕过熔断器直接读取底层数据（验证数据未丢失/未清空）。

import type { Entity, Repository } from './repository.js';

/** 熔断器仓储：down=true 时所有操作抛 "Database unavailable" */
export class FaultyRepository<T extends Entity> implements Repository<T> {
  private down = false;
  constructor(public readonly inner: Repository<T>) {}

  isDown(): boolean {
    return this.down;
  }

  /** 切换故障状态：true=不可用，false=恢复 */
  flip(down: boolean): void {
    this.down = down;
  }

  private guard<R>(op: () => Promise<R>): Promise<R> {
    if (this.down) return Promise.reject(new Error('Database unavailable（模拟存储故障）'));
    return op();
  }

  create(input: Omit<T, 'id'> & { id?: string }): Promise<T> {
    return this.guard(() => this.inner.create(input));
  }
  get(id: string): Promise<T | null> {
    return this.guard(() => this.inner.get(id));
  }
  update(id: string, input: Partial<Omit<T, 'id'>>): Promise<T> {
    return this.guard(() => this.inner.update(id, input));
  }
  delete(id: string): Promise<void> {
    return this.guard(() => this.inner.delete(id));
  }
  query(filter?: Partial<T>, q?: { limit?: number; offset?: number }): Promise<T[]> {
    return this.guard(() => this.inner.query(filter, q));
  }
  count(): Promise<number> {
    return this.guard(() => this.inner.count());
  }
  clear(): Promise<void> {
    return this.guard(() => this.inner.clear());
  }
}

/** 熔断器控制器：配合 factory.wrapRepository 注入，批量 flip 全部/指定集合 */
export interface BreakerController {
  /** 交给工厂的包装器（name 为集合名，如 runs/jobs/audit） */
  wrap<T extends Entity>(name: string, repo: Repository<T>): Repository<T>;
  /** 全部集合切换故障 */
  setAll(down: boolean): void;
  /** 指定集合切换故障 */
  set(name: string, down: boolean): void;
  /** 指定集合当前状态 */
  isDown(name: string): boolean;
  /** 绕过熔断器直读底层仓储（验证数据未丢失 / 未清空） */
  inner<T extends Entity>(name: string): Repository<T> | undefined;
}

/** 创建熔断器控制器 */
export function createBreaker(): BreakerController {
  const breakers = new Map<string, FaultyRepository<Entity>>();
  return {
    wrap<T extends Entity>(name: string, repo: Repository<T>): Repository<T> {
      const fb = new FaultyRepository<T>(repo);
      breakers.set(name, fb as FaultyRepository<Entity>);
      return fb;
    },
    setAll(down: boolean): void {
      for (const b of breakers.values()) b.flip(down);
    },
    set(name: string, down: boolean): void {
      const b = breakers.get(name);
      if (!b) throw new Error(`未包装的集合：${name}`);
      b.flip(down);
    },
    isDown(name: string): boolean {
      return breakers.get(name)?.isDown() ?? false;
    },
    inner<T extends Entity>(name: string): Repository<T> | undefined {
      return breakers.get(name)?.inner as Repository<T> | undefined;
    },
  };
}
