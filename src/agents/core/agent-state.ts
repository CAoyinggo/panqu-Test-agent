// Agent 运行状态：追踪 Orchestrator 各阶段状态（pending/running/completed/failed/skipped/waiting-approval）
export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting-approval';

export interface StageState {
  name: string;
  status: StageStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

/** Agent 运行状态跟踪器（供 Orchestrator 与报告使用） */
export class AgentRunState {
  private stages: Record<string, StageState> = {};

  constructor(
    public readonly taskId: string,
    stageNames: string[] = [],
  ) {
    for (const name of stageNames) this.stages[name] = { name, status: 'pending' };
  }

  /** 设置阶段状态（自动补时间戳） */
  setStatus(name: string, status: StageStatus, error?: string): void {
    const st = this.stages[name] ?? (this.stages[name] = { name, status: 'pending' });
    st.status = status;
    if (status === 'running') st.startedAt = Date.now();
    if (status === 'completed' || status === 'failed') st.completedAt = Date.now();
    if (error !== undefined) st.error = error;
  }

  getStatus(name: string): StageStatus {
    return this.stages[name]?.status ?? 'pending';
  }

  getState(name: string): StageState | undefined {
    return this.stages[name];
  }

  /** 是否全部阶段完成（或跳过/失败） */
  isDone(): boolean {
    return Object.values(this.stages).every((s) =>
      s.status === 'completed' || s.status === 'failed' || s.status === 'skipped' || s.status === 'waiting-approval',
    );
  }

  /** 是否有失败阶段 */
  hasFailure(): boolean {
    return Object.values(this.stages).some((s) => s.status === 'failed');
  }

  /** 序列化（报告/日志用） */
  toJSON(): { taskId: string; stages: Record<string, StageState> } {
    return { taskId: this.taskId, stages: this.stages };
  }
}
