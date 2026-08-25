// AgentRuntime：Agent 执行的统一运行时（横切层唯一入口）。
//
// 目标：杜绝「A 链路用 ModelRouter / B 链路直连 LLM / C 链路自写 Prompt / D 链路自实现 Retry」
// 的碎片化。所有 Agent 的 LLM 调用与阶段执行都经过本运行时，统一串联：
//
//   Pipeline / Orchestrator
//      ↓ runStage（预算 → Tracer → 重试 → 真 abort 超时）
//   Agent
//      ↓ generate（唯一 LLM 入口）
//   PromptRegistry（提示词版本化，覆盖 Agent 内置回退）
//      ↓
//   ModelRouter（模型档位 / fallbackModel / temperature / maxTokens / timeout）
//      ↓
//   LLM Provider（请求级 model 注入 + AbortSignal）
//      ↓
//   Tracer / Budget / Retry（recordLLM / recordRetry / recordFallback / token 计量）
//
// 行为约定：
// - Prompt 来源优先级：PromptRegistry 注册版本 > Agent 内置常量（spec.system，向后兼容）；
// - 参数优先级：显式 spec 覆盖 > PromptDefinition > ModelRouter 路由；
// - 仅对可重试错误（超时/网络/408/429/5xx）重试与换模型；配置/鉴权错误直接抛出（不掩盖问题）；
// - 每次调用按路由 timeoutMs 真实中止（AbortSignal 传给 Provider 的 fetch）。
import { sanitizeLLMResponse, type LLMProvider, type LLMResponse } from '../../llm/index.js';
import { classifyLLMError, isRetryable, llmRetryDelayMs, type LLMRetryPolicy } from '../../llm/llm-errors.js';
import { modelRouter, ModelRouter, type RouteConfig, type TaskKind } from '../../llm/model-router.js';
import type { PromptRegistry } from '../prompts/registry.js';
import { promptRegistry } from '../prompts/registry.js';
// 副作用导入：确保内置 Prompt 在任何 Runtime 使用前已注册（唯一注册入口 builtin.ts）
import '../prompts/builtin.js';
import type { AgentTracer } from '../observability/tracer.js';
import type { AgentBudget } from '../observability/budget.js';
import { UsageMeter, BudgetExceededError } from '../observability/usage-meter.js';
import type { AgentLogger } from './agent-context.js';
import { ExecutionAbortError } from '../../core/abort.js';
import { CodedError, ErrorCode } from '../../core/errors.js';

/** LLM 调用规格（Agent → Runtime 的唯一调用形态） */
export interface LLMCallSpec {
  /** 任务类型（决定模型路由 / 超时 / 参数；同时作为 PromptRegistry 查询名） */
  task: TaskKind;
  /** 发起调用的 Agent 名（Tracer/Budget 归属） */
  agent: string;
  /** 内置系统提示词（PromptRegistry 未注册该任务的提示词时回退使用） */
  system: string;
  /** 用户输入内容 */
  user: string;
  jsonMode?: boolean;
  /** 显式覆盖温度（> PromptDefinition > Router） */
  temperature?: number;
  /** 显式覆盖最大输出 token */
  maxTokens?: number;
  /** 外部取消信号（与调用超时级联） */
  signal?: AbortSignal;
}

/** 阶段执行规格 */
export interface StageSpec {
  /** 阶段归属 Agent 名（Tracer span） */
  agent: string;
  /** 阶段名 */
  stage: string;
  /** 关键阶段：预算超限也继续执行；失败向上抛出 */
  essential: boolean;
  /** 单阶段超时毫秒（缺省 runtime 默认 60s；触发即 abort 信号） */
  timeoutMs?: number;
  /** 失败重试次数（缺省 runtime 默认 0） */
  retries?: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
}

/** 阶段执行结果（区分成功/失败，调用方决定 essential 语义） */
export type StageResult<T> = { ok: true; value: T } | { ok: false; error: string; cause?: unknown };

export interface AgentRuntimeOptions {
  /** LLM Provider（真实 / Mock；Runtime 是唯一调用方） */
  llm: LLMProvider;
  router?: ModelRouter;
  prompts?: PromptRegistry;
  tracer?: AgentTracer;
  budget?: AgentBudget;
  /** 用量计量器（实时计费/预算管理；缺省由 budget 构建，或构建无限额计量器） */
  meter?: UsageMeter;
  logger?: AgentLogger;
  /** 单阶段默认超时（默认 60s） */
  defaultStageTimeoutMs?: number;
  /** 单阶段默认重试次数（默认 0） */
  defaultStageRetries?: number;
  /** LLM 主模型重试次数（默认 2 = 有限重试；另有 fallbackModel 兜底尝试） */
  llmRetries?: number;
  /** 重试退避基数毫秒（默认 500，指数退避 + full jitter） */
  retryBackoffMs?: number;
  /** 重试策略覆盖（封顶 / jitter 开关；测试可关 jitter 换确定性） */
  retryPolicy?: Partial<LLMRetryPolicy>;
}

export interface RuntimePolicySnapshot {
  models: Partial<Record<TaskKind, RouteConfig>>;
  prompts: Array<{
    task: TaskKind;
    key: string;
    version: string;
    model?: string;
    temperature?: number;
  }>;
}

export interface AgentRuntimeForkOptions {
  tracer?: AgentTracer;
  budget?: AgentBudget;
  meter?: UsageMeter;
  logger?: AgentLogger;
}

/**
 * Agent 运行时：LLM 调用与阶段执行的唯一链路。
 * Pipeline 与 Orchestrator 共用同一实例，保证横切策略（Prompt/Model/Retry/Trace/Budget）单点治理。
 */
export class AgentRuntime {
  readonly llm: LLMProvider;
  private readonly router: ModelRouter;
  private readonly prompts: PromptRegistry;
  private readonly tracer?: AgentTracer;
  private readonly budget?: AgentBudget;
  private readonly meter: UsageMeter;
  private readonly logger?: AgentLogger;
  private readonly stageTimeoutMs: number;
  private readonly stageRetries: number;
  private readonly llmRetries: number;
  private readonly retryBackoffMs: number;
  private readonly retryPolicy: Partial<LLMRetryPolicy>;

  constructor(options: AgentRuntimeOptions) {
    this.llm = options.llm;
    this.router = options.router ?? modelRouter;
    this.prompts = options.prompts ?? promptRegistry;
    this.tracer = options.tracer;
    this.budget = options.budget;
    this.meter = options.meter ?? new UsageMeter({ budget: options.budget });
    this.logger = options.logger;
    this.stageTimeoutMs = options.defaultStageTimeoutMs ?? 60_000;
    this.stageRetries = options.defaultStageRetries ?? 0;
    this.llmRetries = options.llmRetries ?? 2;
    this.retryBackoffMs = options.retryBackoffMs ?? 500;
    this.retryPolicy = { baseMs: this.retryBackoffMs, ...options.retryPolicy };
  }

  /**
   * 为一次 Orchestrator 运行创建隔离 Runtime，同时保留已注入的 Model/Prompt Policy。
   * 避免 Pipeline 重建 Runtime 时悄悄退回全局默认策略。
   */
  fork(options: AgentRuntimeForkOptions): AgentRuntime {
    return new AgentRuntime({
      llm: this.llm,
      router: this.router,
      prompts: this.prompts,
      tracer: options.tracer,
      budget: options.budget,
      meter: options.meter,
      logger: options.logger ?? this.logger,
      defaultStageTimeoutMs: this.stageTimeoutMs,
      defaultStageRetries: this.stageRetries,
      llmRetries: this.llmRetries,
      retryBackoffMs: this.retryBackoffMs,
      retryPolicy: this.retryPolicy,
    });
  }

  /** 返回不含 Prompt 正文的策略快照，供 Orchestrator / Report 审计。 */
  policySnapshot(tasks: readonly TaskKind[]): RuntimePolicySnapshot {
    const models: Partial<Record<TaskKind, RouteConfig>> = {};
    const prompts: RuntimePolicySnapshot['prompts'] = [];
    for (const task of tasks) {
      models[task] = this.router.route(task);
      const prompt = this.prompts.getVersion(task);
      if (prompt) {
        prompts.push({
          task,
          key: prompt.key,
          version: prompt.version,
          model: prompt.model,
          temperature: prompt.temperature,
        });
      }
    }
    return { models, prompts };
  }

  /**
   * LLM 调用唯一入口：PromptRegistry（覆盖内置）→ ModelRouter（模型/参数/超时）→
   * Provider（请求级 model + AbortSignal）→ 可重试错误重试/换模型 → Tracer/Budget 记录。
   */
  async generate(spec: LLMCallSpec): Promise<LLMResponse> {
    const route = this.router.route(spec.task);
    const promptDef = this.prompts.getVersion(spec.task);
    const system = promptDef?.system ?? spec.system;
    const temperature = spec.temperature ?? promptDef?.temperature ?? route.temperature;
    const maxTokens = spec.maxTokens ?? route.maxTokens;
    const timeoutMs = route.timeoutMs ?? 30_000;
    // maxTokens 只覆盖输出；输入 Prompt 同样产生费用，调用前必须一并预留。
    const estimatedInputTokens = Math.max(1, Math.ceil((system.length + spec.user.length) / 4));
    if (route.maxInputTokens !== undefined && estimatedInputTokens > route.maxInputTokens) {
      throw new CodedError(
        ErrorCode.REQUEST_TOO_LARGE,
        `LLM_CONTEXT_OVERFLOW：输入约 ${estimatedInputTokens} tokens，超过 ${spec.task} 上限 ${route.maxInputTokens}`,
        { expose: true, details: { task: spec.task, estimatedInputTokens, maxInputTokens: route.maxInputTokens } },
      );
    }

    // 模型链：主模型（×(1+llmRetries)）→ 回退模型（×1）
    const models = route.fallbackModel && route.fallbackModel !== route.model
      ? [route.model, route.fallbackModel]
      : [route.model];

    let lastError: unknown;
    for (let m = 0; m < models.length; m++) {
      const model = models[m];
      const attempts = m === 0 ? this.llmRetries + 1 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0 || m > 0) {
          this.tracer?.recordRetry(spec.agent);
          // 退避策略：Retry-After（限流）优先；否则指数退避 + full jitter（封顶）
          const delay = llmRetryDelayMs(classifyLLMError(lastError), Math.max(0, attempt - 1 + m), this.retryPolicy) ?? this.retryBackoffMs;
          this.logger?.debug?.(`[runtime] LLM 重试 ${spec.task}${m > 0 ? `（切换 ${model}）` : ''} ${attempt}/${attempts - 1}（等待 ${delay}ms）`);
          await new Promise((r) => setTimeout(r, delay));
        }
        // 每次调用独立超时（AbortSignal 级联外部取消；真实中止 Provider fetch）
        const controller = new AbortController();
        const unlink = spec.signal ? linkSignal(controller, spec.signal) : () => undefined;
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new ExecutionAbortError('TIMEOUT', `LLM 调用超时（${timeoutMs}ms）：${spec.task}（模型 ${model}）`);
            controller.abort(err);
            reject(err);
          }, timeoutMs);
        });
        // ── 实时计费（LLM Decorator）：执行前预留额度，完成后按实际用量结算 ──
        let reserve = 0;
        try {
          reserve = this.meter.beforeLLM(maxTokens, estimatedInputTokens); // 预留失败/已 STOP → 立即抛 BudgetExceededError
          const resp = await Promise.race([
            this.llm.generate({
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: spec.user },
              ],
              temperature,
              maxTokens,
              jsonMode: spec.jsonMode,
              model,
              signal: controller.signal,
            }),
            timeoutPromise,
          ]);
          const inputTokens = resp.usage?.inputTokens ?? 0;
          const outputTokens = resp.usage?.outputTokens ?? 0;
          this.meter.settleLLM(reserve, inputTokens, outputTokens); // 实时扣减 → 超限即 STOP
          this.tracer?.recordLLM(spec.agent, inputTokens, outputTokens, resp.latencyMs);
          return sanitizeLLMResponse(resp);
        } catch (e) {
          if (reserve > 0) this.meter.settleLLMFailure(reserve); // 释放预留；调用次数仍计量
          if (e instanceof BudgetExceededError) throw e; // STOP 不可重试
          lastError = e;
          const failure = classifyLLMError(e);
          // 配置/鉴权等不可重试错误：直接暴露（换模型/重试只会掩盖问题）
          if (!isRetryable(failure)) throw e;
          const isLastAttempt = attempt === attempts - 1 && m === models.length - 1;
          if (isLastAttempt) break;
        } finally {
          if (timer) clearTimeout(timer);
          unlink();
        }
      }
      // 主模型链失败 → 记录回退（若有回退模型）
      if (m === 0 && models.length > 1) {
        this.tracer?.recordFallback(spec.agent);
        this.logger?.warn?.(`[runtime] ${spec.task} 主模型失败，切换回退模型：${models[1]}`);
      }
    }
    throw lastError;
  }

  /**
   * 阶段执行（Pipeline / Orchestrator 共用）：
   * 预算检查（非关键阶段超限跳过）→ Tracer span → 重试 → 真 abort 超时。
   * fn 收到取消信号：可贯穿到 Tool/LLM（Runtime.generate 接受 signal）。
   */
  async runStage<T>(spec: StageSpec, fn: (signal: AbortSignal) => Promise<T>): Promise<StageResult<T>> {
    // 预算：非关键阶段超限直接跳过（STOP 后一切增强阶段不再运行）；
    // 关键阶段继续执行但其中 LLM/Tool 调用会被 meter fail-fast（花费立即停止，
    // Agent 降级到确定性回退完成阶段 —— 兼顾「立即 STOP 计费」与「核心流程可收尾」）
    if (this.budget) {
      this.budget.addAgentCall();
      const b = this.budget.check();
      if (!b.ok && !spec.essential) {
        this.logger?.warn?.(`[runtime] ${spec.stage} 因预算超限跳过（${b.exceeded.join('，')}）`);
        return { ok: false, error: `预算超限跳过（${b.exceeded.join('，')}）` };
      }
      if (!b.ok) {
        this.logger?.warn?.(`[runtime] ${spec.stage} 预算超限但为关键阶段继续（${b.exceeded.join('，')}）`);
      }
    }

    const timeoutMs = spec.timeoutMs ?? this.stageTimeoutMs;
    const retries = spec.retries ?? this.stageRetries;
    const spanId = this.tracer?.startSpan(spec.agent, spec.stage);

    let lastError: string | undefined;
    let lastCause: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const unlink = spec.signal ? linkSignal(controller, spec.signal) : () => undefined;
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new ExecutionAbortError('TIMEOUT', `阶段超时（${timeoutMs}ms）：${spec.stage}（已发送中止信号）`);
          controller.abort(err);
          reject(err);
        }, timeoutMs);
      });
      try {
        if (attempt > 0) {
          this.tracer?.recordRetry(spec.agent);
          this.logger?.info?.(`[runtime] 阶段 ${spec.stage} 重试 ${attempt}/${retries}`);
        }
        const value = await Promise.race([fn(controller.signal), timeoutPromise]);
        this.tracer?.endSpan(spanId!, { success: true, status: 'ok' });
        return { ok: true, value };
      } catch (e) {
        lastError = (e as Error).message;
        lastCause = e;
        this.logger?.warn?.(`[runtime] 阶段 ${spec.stage} 失败：${lastError}`);
      } finally {
        if (timer) clearTimeout(timer);
        unlink();
      }
    }

    this.tracer?.endSpan(spanId!, { success: false, status: 'error', error: lastError });
    return { ok: false, error: lastError!, cause: lastCause };
  }
}

/** 外部取消信号级联到调用 controller（保留原因） */
function linkSignal(child: AbortController, parent: AbortSignal): () => void {
  const forward = () => {
    if (!child.signal.aborted) child.abort(parent.reason);
  };
  if (parent.aborted) {
    forward();
    return () => undefined;
  }
  parent.addEventListener('abort', forward, { once: true });
  return () => parent.removeEventListener('abort', forward);
}
