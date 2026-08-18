// Worker 定义（Phase 24.4）：TestWorker 接口与元数据
// 选择依据：Environment + Capability + Concurrency + Health

/** Worker 健康状态 */
export type WorkerHealth = 'healthy' | 'degraded' | 'down';

/** Worker 注册信息 */
export interface WorkerRegistration {
  workerId: string;
  capabilities: string[];
  environments: string[];
  maxConcurrency: number;
}

/** 运行中的 Worker（含健康与负载） */
export interface TestWorker extends WorkerRegistration {
  health: WorkerHealth;
  /** 当前并发占用数 */
  busy: number;
  registeredAt: string;
  lastHeartbeatAt?: string;
  lastError?: string;
}

/** Worker 执行器：接收 Job，返回执行结果 */
export type WorkerExecutor = (job: unknown) => Promise<unknown>;

/** 内部条目：Worker 元数据 + 执行器 */
export interface WorkerEntry {
  worker: TestWorker;
  execute: WorkerExecutor;
}
