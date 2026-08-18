// Agent 执行结果：统一的阶段产出/失败结构（供 Orchestrator 与报告消费）
export interface AgentResult<T = unknown> {
  /** Agent 名称 */
  agent: string;
  /** 是否成功 */
  success: boolean;
  /** 阶段产物（成功时） */
  data?: T;
  /** 错误信息（失败时） */
  error?: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  /** 重试次数 */
  retries?: number;
}

/** 便捷：创建成功结果 */
export function okResult<T>(agent: string, data: T, startedAt: number, retries = 0): AgentResult<T> {
  return { agent, success: true, data, startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt, retries };
}

/** 便捷：创建失败结果 */
export function failResult(agent: string, error: string, startedAt: number, retries = 0): AgentResult<never> {
  return { agent, success: false, error, startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt, retries };
}
