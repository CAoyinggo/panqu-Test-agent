// Agent State Machine：完整状态机（Phase 16/17 失败可恢复）
// 主路径：INIT → REQUIREMENT_PARSED → TEST_DESIGNED → RISK_ASSESSED → TEST_SELECTED
//         → DATA_READY → EXECUTING → ANALYZING → RCA → DEFECT → HEALING
//         → MEMORY_UPDATED → COMPLETED
// 异常态：FAILED / PAUSED / WAITING_APPROVAL / CANCELLED
// 能力：transition / checkpoint / resume / pause / cancel / retry。
// 与既有 AgentRunState（阶段级）并存：本机关注「Agent 全流程状态」，用于失败恢复与断点续跑。

/** 状态机状态 */
export type MachineState =
  | 'INIT'
  | 'REQUIREMENT_PARSED'
  | 'TEST_DESIGNED'
  | 'RISK_ASSESSED'
  | 'TEST_SELECTED'
  | 'DATA_READY'
  | 'EXECUTING'
  | 'ANALYZING'
  | 'RCA'
  | 'DEFECT'
  | 'HEALING'
  | 'MEMORY_UPDATED'
  | 'COMPLETED'
  | 'FAILED'
  | 'PAUSED'
  | 'WAITING_APPROVAL'
  | 'CANCELLED';

/** 主路径顺序（用于合法性判断） */
export const MAIN_STATES: readonly MachineState[] = [
  'INIT', 'REQUIREMENT_PARSED', 'TEST_DESIGNED', 'RISK_ASSESSED', 'TEST_SELECTED',
  'DATA_READY', 'EXECUTING', 'ANALYZING', 'RCA', 'DEFECT', 'HEALING',
  'MEMORY_UPDATED', 'COMPLETED',
];

/** 异常态 */
export const EXCEPTION_STATES: readonly MachineState[] = ['FAILED', 'PAUSED', 'WAITING_APPROVAL', 'CANCELLED'];

/** 是否为合法状态 */
export function isMachineState(v: unknown): v is MachineState {
  return [...MAIN_STATES, ...EXCEPTION_STATES].includes(v as MachineState);
}

/** 检查点：阶段名 → 产物快照 */
export interface CheckpointMap {
  [stage: string]: unknown;
}

/** Agent 状态机 */
export class AgentStateMachine {
  private state: MachineState = 'INIT';
  private checkpoints: CheckpointMap = {};
  private readonly history: MachineState[] = [];

  constructor(
    public readonly taskId: string,
    private logger?: { info(msg: string): void; warn(msg: string): void },
  ) {}

  /** 当前状态 */
  current(): MachineState {
    return this.state;
  }

  /** 状态是否已结束（终态） */
  isTerminal(): boolean {
    return this.state === 'COMPLETED' || this.state === 'CANCELLED';
  }

  /** 状态机是否处于异常态（需要恢复） */
  isRecoverable(): boolean {
    return this.state === 'FAILED' || this.state === 'PAUSED' || this.state === 'WAITING_APPROVAL';
  }

  /** 主路径序号（非法返回 -1） */
  private indexOf(s: MachineState): number {
    return MAIN_STATES.indexOf(s);
  }

  /** 是否允许转移到 next */
  canTransition(next: MachineState): boolean {
    if (!isMachineState(next)) return false;
    if (this.state === next) return false;
    // 终态不可再转移
    if (this.isTerminal()) return false;

    // 从异常态只能 resume / retry / cancel（由 resume/cancel/retry 处理）
    if (this.isRecoverable()) {
      return next === 'CANCELLED';
    }

    // 进入异常态：从任何活动主状态都允许
    if (EXCEPTION_STATES.includes(next)) return true;

    // 主路径必须严格顺序前进（仅允许下一步）；跳转到后续阶段由 resume 完成
    const cur = this.indexOf(this.state);
    const nxt = this.indexOf(next);
    if (cur === -1 || nxt === -1) return false;
    return nxt === cur + 1;
  }

  /** 转移（合法才生效，非法记录日志并返回 false） */
  transition(next: MachineState, data?: unknown): boolean {
    if (!this.canTransition(next)) {
      this.logger?.warn?.(`状态机非法转移：${this.state} → ${next}`);
      return false;
    }
    this.history.push(this.state);
    this.state = next;
    if (data !== undefined) this.setCheckpoint(next, data);
    this.logger?.info?.(`状态机：${this.state} → ${next}`);
    return true;
  }

  /** 保存阶段产物到检查点（resume 时从此恢复） */
  setCheckpoint(stage: string, data: unknown): void {
    this.checkpoints[stage] = data;
  }

  /** 读取检查点 */
  getCheckpoint(stage: string): unknown {
    return this.checkpoints[stage];
  }

  /** 已保存的检查点阶段名 */
  checkpointStages(): string[] {
    return Object.keys(this.checkpoints);
  }

  /** 最后的活动主状态（异常态前的状态，resume/retry 目标） */
  lastActive(): MachineState {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const s = this.history[i];
      if (MAIN_STATES.includes(s)) return s;
    }
    return 'INIT';
  }

  /** 暂停（活动态 → PAUSED） */
  pause(): boolean {
    if (this.isTerminal() || this.isRecoverable()) return false;
    return this.transition('PAUSED');
  }

  /** 取消（任意非终态 → CANCELLED） */
  cancel(): boolean {
    if (this.isTerminal()) return false;
    this.history.push(this.state);
    this.state = 'CANCELLED';
    this.logger?.info?.(`状态机：已取消（CANCELLED）`);
    return true;
  }

  /** 从异常态恢复到指定主状态（默认恢复到最后一个活动状态） */
  resume(from?: MachineState): boolean {
    if (!this.isRecoverable()) return false;
    const target = from && MAIN_STATES.includes(from) ? from : this.lastActive();
    this.history.push(this.state);
    this.state = target;
    this.logger?.info?.(`状态机：已恢复 ${target}`);
    return true;
  }

  /** 失败重试：FAILED → 最后一个活动状态 */
  retry(): boolean {
    if (this.state !== 'FAILED') return false;
    return this.resume();
  }

  /** 等待审批（活动态 → WAITING_APPROVAL） */
  waitForApproval(): boolean {
    if (this.isTerminal() || this.isRecoverable()) return false;
    return this.transition('WAITING_APPROVAL');
  }

  /** 标记失败 */
  fail(): boolean {
    if (this.isTerminal()) return false;
    return this.transition('FAILED');
  }

  /** 序列化（持久化/恢复用） */
  toJSON(): { taskId: string; state: MachineState; checkpoints: CheckpointMap; history: MachineState[] } {
    return { taskId: this.taskId, state: this.state, checkpoints: this.checkpoints, history: this.history };
  }

  /** 从序列化恢复（用于 checkpoint 续跑） */
  static fromJSON(data: { taskId?: string; state?: unknown; checkpoints?: CheckpointMap; history?: MachineState[] }): AgentStateMachine {
    const m = new AgentStateMachine(String(data.taskId ?? ''));
    if (isMachineState(data.state)) m.state = data.state;
    m.checkpoints = data.checkpoints ?? {};
    m.history.push(...(Array.isArray(data.history) ? data.history.filter(isMachineState) : []));
    return m;
  }
}
