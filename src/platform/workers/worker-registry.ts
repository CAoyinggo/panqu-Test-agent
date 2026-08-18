// Worker Registry（Phase 24.4）：注册 / 注销 / 心跳 / 健康 / 优雅停机

import type { WorkerEntry, WorkerExecutor, WorkerHealth, WorkerRegistration, TestWorker } from './worker.js';

export interface WorkerRegistryOptions {
  /** 心跳超时判定 DOWN 的阈值（毫秒，默认 30s） */
  heartbeatTimeoutMs?: number;
  now?: () => string;
  nowMs?: () => number;
}

export class WorkerRegistry {
  private entries = new Map<string, WorkerEntry>();
  private readonly heartbeatTimeoutMs: number;
  private readonly now: () => string;
  private readonly nowMs: () => number;

  constructor(opts: WorkerRegistryOptions = {}) {
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 30_000;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  register(reg: WorkerRegistration, execute: WorkerExecutor): TestWorker {
    if (this.entries.has(reg.workerId)) throw new Error(`Worker 已注册：${reg.workerId}`);
    const worker: TestWorker = {
      ...reg,
      health: 'healthy',
      busy: 0,
      registeredAt: this.now(),
      lastHeartbeatAt: this.now(),
    };
    this.entries.set(reg.workerId, { worker, execute });
    return worker;
  }

  unregister(workerId: string): void {
    if (!this.entries.delete(workerId)) throw new Error(`Worker 不存在：${workerId}`);
  }

  get(workerId: string): TestWorker | null {
    return this.entries.get(workerId)?.worker ?? null;
  }

  list(): TestWorker[] {
    return [...this.entries.values()].map((e) => e.worker);
  }

  /** 心跳：刷新时间并恢复 healthy */
  heartbeat(workerId: string): TestWorker {
    const e = this.entries.get(workerId);
    if (!e) throw new Error(`Worker 不存在：${workerId}`);
    e.worker.lastHeartbeatAt = this.now();
    e.worker.health = e.worker.health === 'down' ? 'healthy' : e.worker.health;
    return e.worker;
  }

  /** 主动标记 DOWN（崩溃 / 关机） */
  markDown(workerId: string, error?: string): TestWorker {
    const e = this.entries.get(workerId);
    if (!e) throw new Error(`Worker 不存在：${workerId}`);
    e.worker.health = 'down';
    e.worker.lastError = error;
    return e.worker;
  }

  /** 健康评估：心跳超时 → down */
  evaluateHealth(workerId: string): WorkerHealth {
    const w = this.entries.get(workerId)?.worker;
    if (!w) return 'down';
    if (w.health === 'down') return 'down';
    if (w.lastHeartbeatAt) {
      const since = this.nowMs() - Date.parse(w.lastHeartbeatAt);
      if (Number.isFinite(since) && since > this.heartbeatTimeoutMs) {
        w.health = 'down';
      }
    }
    return w.health;
  }

  /** 全部健康 Worker（healthy/degraded，按注册顺序稳定） */
  healthyWorkers(): TestWorker[] {
    return this.list().filter((w) => this.evaluateHealth(w.workerId) !== 'down');
  }

  /** 占用 / 释放并发槽位 */
  acquire(workerId: string): void {
    const w = this.entries.get(workerId)?.worker;
    if (w) w.busy += 1;
  }

  release(workerId: string): void {
    const w = this.entries.get(workerId)?.worker;
    if (w && w.busy > 0) w.busy -= 1;
  }

  /** 优雅停机：标记 down + 注销 */
  gracefulShutdown(workerId: string): void {
    this.markDown(workerId, 'graceful-shutdown');
    this.unregister(workerId);
  }

  count(): number {
    return this.entries.size;
  }

  getExecutor(workerId: string): WorkerExecutor | null {
    return this.entries.get(workerId)?.execute ?? null;
  }
}
