// Agent Orchestrator：统一调度 Agent 阶段
// 支持：阶段跳过（已有产物）、人工审批（AUTO/REVIEW/MANUAL）、阶段重试、部分阶段失败降级、产物串联。
// 典型流程：Requirement → TestDesign → Risk → Data → Execution → Analysis → Memory
import type { AgentContext } from '../core/agent-context.js';
import { AgentRunState, StageStatus } from '../core/agent-state.js';
import type { AgentRegistry } from '../core/agent-registry.js';
import type { TestAgent } from '../core/agent.js';

/** 审批模式 */
export type ApprovalMode = 'AUTO' | 'REVIEW' | 'MANUAL';

/** 审批策略 */
export interface ApprovalPolicy {
  mode: ApprovalMode;
  /** 审批提示信息（MANUAL/REVIEW 时展示给用户） */
  message?: string;
  /** 审批人（可选） */
  approver?: string;
}

/** 单阶段定义 */
export interface AgentStage {
  /** 阶段名（唯一，如 'requirement'） */
  name: string;
  /** 注册表内 Agent 名称（缺省则等价于阶段名） */
  agent?: string;
  /** 阶段描述 */
  description?: string;
  /** 跳过条件（返回 true 则跳过该阶段） */
  skip?: (ctx: AgentContext, outputs: Record<string, unknown>) => boolean | Promise<boolean>;
  /** 审批策略（缺省 AUTO） */
  approval?: ApprovalPolicy;
  /** 阶段输入（从上下文与先前产物计算；缺省取上一阶段产物） */
  input?: (ctx: AgentContext, outputs: Record<string, unknown>) => unknown;
}

/** 阶段计划 */
export interface AgentPlan {
  taskId: string;
  stages: AgentStage[];
}

/** Orchestrator 配置 */
export interface OrchestratorOptions {
  registry: AgentRegistry;
  /** 审批回调：true 通过 / false 拒绝。缺省对所有审批一律放行 */
  approvalHandler?: (stage: AgentStage, payload: unknown) => boolean | Promise<boolean>;
  /** 单阶段最大重试次数（默认 0） */
  maxStageRetries?: number;
  /** 阶段失败后是否中止后续阶段（默认 false = 继续后续阶段） */
  abortOnStageFailure?: boolean;
  /** 单阶段执行超时（毫秒，默认 60s） */
  stageTimeoutMs?: number;
}

/** Orchestrator 运行结果 */
export interface OrchestratorRunResult {
  taskId: string;
  success: boolean;
  stages: Record<string, StageStatus>;
  stageStates: Record<string, unknown>;
  outputs: Record<string, unknown>;
  durationMs: number;
}

/** Agent Orchestrator */
export class AgentOrchestrator {
  private registry: AgentRegistry;
  private approvalHandler: NonNullable<OrchestratorOptions['approvalHandler']>;
  private maxStageRetries: number;
  private abortOnStageFailure: boolean;
  private stageTimeoutMs: number;

  constructor(options: OrchestratorOptions) {
    this.registry = options.registry;
    this.approvalHandler = options.approvalHandler ?? (() => true);
    this.maxStageRetries = options.maxStageRetries ?? 0;
    this.abortOnStageFailure = options.abortOnStageFailure ?? false;
    this.stageTimeoutMs = options.stageTimeoutMs ?? 60_000;
  }

  /** 执行计划 */
  async run(plan: AgentPlan, context: AgentContext): Promise<OrchestratorRunResult> {
    const t0 = Date.now();
    const state = new AgentRunState(plan.taskId, plan.stages.map((s) => s.name));
    const outputs: Record<string, unknown> = {};

    for (const stage of plan.stages) {
      context.logger.step(`▶ Agent 阶段：${stage.name}${stage.description ? `（${stage.description}）` : ''}`);

      // 1. 跳过判定
      let skip = false;
      if (stage.skip) {
        try {
          skip = await stage.skip(context, outputs);
        } catch (e) {
          context.logger.warn(`阶段 ${stage.name} 跳过判定异常（按不跳过处理）：${(e as Error).message}`);
        }
      }
      if (skip) {
        state.setStatus(stage.name, 'skipped');
        context.logger.info(`  ⏭ 阶段 ${stage.name} 已跳过`);
        continue;
      }

      // 2. 计算输入（供审批与执行共用）
      const input = this.resolveInput(stage, context, outputs);

      // 3. 审批判定
      const approval = stage.approval ?? { mode: 'AUTO' as ApprovalMode };
      if (approval.mode !== 'AUTO') {
        let approved: boolean;
        try {
          approved = await this.approvalHandler(stage, input);
        } catch (e) {
          context.logger.error(`阶段 ${stage.name} 审批处理异常：${(e as Error).message}`);
          approved = false;
        }
        if (!approved) {
          state.setStatus(stage.name, 'failed', `人工审批未通过（mode=${approval.mode}）`);
          context.logger.error(`  ✋ 阶段 ${stage.name} 未通过人工审批，已标记失败`);
          if (this.abortOnStageFailure) break;
          continue;
        }
        context.logger.info(`  ✅ 阶段 ${stage.name} 已通过人工审批（mode=${approval.mode}）`);
      }

      // 4. 执行（带重试 + 超时）
      const agent = this.registry.get(stage.agent ?? stage.name);
      if (!agent) {
        state.setStatus(stage.name, 'failed', `Agent 未注册：${stage.agent ?? stage.name}`);
        context.logger.error(`  ❌ Agent 未注册：${stage.agent ?? stage.name}`);
        if (this.abortOnStageFailure) break;
        continue;
      }

      let lastError: string | undefined;
      let result: unknown | undefined;
      for (let attempt = 0; attempt <= this.maxStageRetries; attempt++) {
        if (attempt > 0) context.logger.info(`  🔄 阶段 ${stage.name} 重试 ${attempt}/${this.maxStageRetries}`);
        state.setStatus(stage.name, 'running');
        try {
          result = await this.runWithTimeout(agent, input, context, stage.name);
          lastError = undefined;
          break;
        } catch (e) {
          lastError = (e as Error).message;
          context.logger.warn(`  阶段 ${stage.name} 执行失败：${lastError}`);
        }
      }

      if (lastError) {
        state.setStatus(stage.name, 'failed', lastError);
        outputs[stage.name] = { error: lastError };
        if (this.abortOnStageFailure) break;
        continue;
      }

      state.setStatus(stage.name, 'completed');
      outputs[stage.name] = result;
      context.logger.info(`  ✔ 阶段 ${stage.name} 完成`);
    }

    return {
      taskId: plan.taskId,
      success: !state.hasFailure(),
      stages: Object.fromEntries(plan.stages.map((s) => [s.name, state.getStatus(s.name)])),
      stageStates: state.toJSON().stages as Record<string, unknown>,
      outputs,
      durationMs: Date.now() - t0,
    };
  }

  /** 计算阶段输入：优先自定义 input 函数，缺省取上一阶段产物 */
  private resolveInput(stage: AgentStage, context: AgentContext, outputs: Record<string, unknown>): unknown {
    if (stage.input) return stage.input(context, outputs);
    const keys = Object.keys(outputs);
    return keys.length ? outputs[keys[keys.length - 1]] : undefined;
  }

  /** 带超时的 Agent 执行 */
  private async runWithTimeout<TInput, TOutput>(
    agent: TestAgent<TInput, TOutput>,
    input: TInput,
    context: AgentContext,
    stageName: string,
  ): Promise<TOutput> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`阶段超时（${this.stageTimeoutMs}ms）：${stageName}`)), this.stageTimeoutMs);
    });
    try {
      return await Promise.race([agent.execute(input, context), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
