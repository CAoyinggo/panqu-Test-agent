// Tool Registry：统一登记/调用 Agent Tool（含安全边界）
// 职责：登记、查询、带超时的安全调用、错误捕获、权限执行（Phase 10-18 安全边界）、审计日志（脱敏）。
// 安全边界：
//   - Agent 只能通过本注册表调用执行能力，禁止直接触碰底层模块。
//   - 生产环境（prod/preonline）：read/safe 放行；risky/dangerous 需审批，无审批则默认拒绝（strict）。
//   - 审计日志中的输入统一经 redactSensitive 脱敏，敏感字段（token/password/secret 等）不落明文。
import type { AgentContext } from '../core/agent-context.js';
import { AgentTool, ToolResult, okToolResult, failToolResult, redactSensitive } from './tool.js';
import { ExecutionAbortError, abortReasonOf, isExecutionAbortError } from '../../core/abort.js';
import type { UsageMeter } from '../observability/usage-meter.js';

/** 审计条目 */
export interface ToolAuditEntry {
  name: string;
  input: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** 终态分类（TIMEOUT / CANCELLED / OK） */
  status?: 'OK' | 'TIMEOUT' | 'CANCELLED';
  /** 权限拦截原因（被 DENY 时） */
  reason?: string;
}

export interface ToolRegistryOptions {
  /** 默认超时（毫秒，默认 30s） */
  defaultTimeoutMs?: number;
  /** 审计日志回调（每次调用记录 name/脱敏 input 摘要/耗时/结果） */
  onAudit?: (entry: ToolAuditEntry) => void;
  /** 用量计量器（Tool Decorator：调用前 STOP 检查、调用后实时扣减次数/成本） */
  meter?: UsageMeter;
  /** 当前环境（test/preonline/prod），缺省取 context.environment */
  environment?: string;
  /** 权限策略：strict（默认，生产危险操作拒绝） / permissive（生产危险操作仅告警放行） */
  permissionPolicy?: 'strict' | 'permissive';
  /** 审批回调：risky/dangerous 操作在生产环境的放行决策（默认无 → strict 拒绝） */
  onApproval?: (name: string, description: string) => boolean | Promise<boolean>;
}

/** Tool Registry */
export class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  private defaultTimeoutMs: number;
  private audit: ToolRegistryOptions['onAudit'];
  private environment?: string;
  private permissionPolicy: 'strict' | 'permissive';
  private onApproval?: ToolRegistryOptions['onApproval'];
  private meter?: UsageMeter;

  constructor(options: ToolRegistryOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.audit = options.onAudit;
    this.environment = options.environment;
    this.permissionPolicy = options.permissionPolicy ?? 'strict';
    this.onApproval = options.onApproval;
    this.meter = options.meter;
  }

  /** 注入/更新用量计量器（Pipeline 运行时注入带预算的实例；已有则覆盖） */
  setMeter(meter: UsageMeter | undefined): void {
    this.meter = meter;
  }

  /** 注册 Tool（同名覆盖） */
  register<TInput = unknown, TOutput = unknown>(tool: AgentTool<TInput, TOutput>): void {
    this.tools.set(tool.name, tool as AgentTool);
  }

  /** 按名称获取 Tool */
  get<TInput = unknown, TOutput = unknown>(name: string): AgentTool<TInput, TOutput> | undefined {
    return this.tools.get(name) as AgentTool<TInput, TOutput> | undefined;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 列出全部 Tool 名称 */
  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 列出全部 Tool 元信息（供 Agent 决策） */
  listWithMeta(): Array<{ name: string; description: string; inputSchema: unknown; outputSchema: unknown; permission?: string }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      permission: t.permission ?? 'safe',
    }));
  }

  /** 移除 Tool */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  clear(): void {
    this.tools.clear();
  }

  /** 判断是否为生产环境 */
  private isProd(env: string): boolean {
    const e = env.toLowerCase();
    return e === 'prod' || e === 'production' || e === 'preonline';
  }

  /** 权限执行：生产环境 risky/dangerous 需审批，无审批默认拒绝（strict） */
  private async enforcePermission(
    tool: AgentTool,
    context: AgentContext,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const env = this.environment ?? context.environment ?? 'test';
    if (!this.isProd(env)) return { allowed: true };

    if (tool.deniedInProduction === true) {
      return { allowed: false, reason: `生产环境禁止操作：${tool.name}` };
    }
    const perm = tool.permission ?? 'safe';
    if (perm === 'read' || perm === 'safe') {
      return { allowed: true };
    }
    // risky / dangerous → 需审批
    if (this.onApproval) {
      try {
        const ok = await this.onApproval(tool.name, tool.description);
        if (ok) return { allowed: true };
        return { allowed: false, reason: `生产环境 ${perm} 操作未获审批：${tool.name}` };
      } catch {
        return { allowed: false, reason: `生产环境 ${perm} 操作审批异常，默认拒绝：${tool.name}` };
      }
    }
    if (this.permissionPolicy === 'permissive') {
      context.logger.warn(`[安全] 生产环境执行 ${perm} Tool：${tool.name}（permissive 策略放行）`);
      return { allowed: true };
    }
    return { allowed: false, reason: `生产环境禁止 ${perm} 操作（需人工审批）：${tool.name}` };
  }

  /**
   * 安全调用 Tool：权限检查 → 查找 → 超时保护（真实中止）→ 错误捕获 → 审计（输入脱敏）。
   * 无论 Tool 内部抛错、超时或被权限拦截，都返回结构化的 ToolResult（不向调用方抛异常）。
   *
   * 超时/取消语义（v2）：超时触发 AbortController 并把 signal 传入 tool.execute ——
   * Tool 把信号贯穿到底层（Engine → Pipeline → HTTP fetch），底层任务真实停止，
   * 而非仅上层放弃等待。终态通过 ToolResult.status 明确为 TIMEOUT / CANCELLED。
   */
  async call<TInput = unknown, TOutput = unknown>(
    name: string,
    input: TInput,
    context: AgentContext,
    callOpts: { signal?: AbortSignal } = {},
  ): Promise<ToolResult<TOutput>> {
    const startedAt = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      const error = `Tool 未注册：${name}（可用：${this.list().join(', ') || '无'}）`;
      this.audit?.({ name, input: redactSensitive(input), ok: false, durationMs: 0, status: 'OK', error });
      return failToolResult(error, startedAt);
    }

    // 权限执行（安全边界）
    const permit = await this.enforcePermission(tool, context);
    if (!permit.allowed) {
      this.audit?.({ name, input: redactSensitive(input), ok: false, durationMs: 0, status: 'OK', reason: permit.reason });
      context.logger.warn(`[安全] Tool 被拦截：${name} - ${permit.reason}`);
      return failToolResult(permit.reason, startedAt);
    }

    // ── Tool Decorator（实时计费）：调用前 STOP 检查（超限不再执行任何 Tool）──
    if (this.meter) {
      try {
        this.meter.beforeTool();
      } catch (e) {
        const error = (e as Error).message;
        this.audit?.({ name, input: redactSensitive(input), ok: false, durationMs: 0, status: 'OK', reason: error });
        context.logger.warn(`[预算] Tool 调用被 STOP：${name} - ${error}`);
        return failToolResult(error, startedAt);
      }
    }

    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;

    // 取消信号：Tool 超时 + 外部取消（callOpts.signal）级联到 tool.execute
    const abort = new AbortController();
    const unlinkExternal = callOpts.signal
      ? linkToolSignal(abort, callOpts.signal)
      : () => undefined;

    // 终止竞争：超时（TIMEOUT）或外部取消（CANCELLED）任一触发即结算，
    // 同时把 AbortSignal 传入 tool.execute —— Tool 将信号贯穿到底层，真实停止。
    const abortPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        const err = new ExecutionAbortError('TIMEOUT', `Tool 超时（${timeoutMs}ms）：${name}（已向底层发送中止信号）`);
        abort.abort(err);
        reject(err);
      }, timeoutMs);
      abort.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const reason = abort.signal.reason;
        reject(isExecutionAbortError(reason)
          ? reason
          : new ExecutionAbortError('CANCELLED', `Tool 调用被取消：${name}`));
      }, { once: true });
    });

    try {
      const result = await Promise.race([tool.execute(input, context, abort.signal), abortPromise]);
      this.meter?.afterTool(); // 实时扣减 Tool 次数 → 超限即 STOP 后续调用
      this.audit?.({ name, input: redactSensitive(input), ok: true, durationMs: Date.now() - startedAt, status: 'OK' });
      return okToolResult(result as TOutput, startedAt);
    } catch (e) {
      this.meter?.afterTool(); // 失败调用同样计量
      const reason = abortReasonOf(e);
      const status = reason ?? 'OK';
      const error = reason
        ? `${reason}：${(e as Error).message}`
        : (e as Error).message;
      this.audit?.({ name, input: redactSensitive(input), ok: false, durationMs: Date.now() - startedAt, status, error });
      context.logger.warn(reason ? `Tool 调用被中止：${name} - ${error}` : `Tool 调用失败：${name} - ${error}`);
      return failToolResult(error, startedAt, status);
    } finally {
      unlinkExternal();
    }
  }
}

/** 外部取消信号级联到 Tool 调用的 abort controller */
function linkToolSignal(child: AbortController, parent: AbortSignal): () => void {
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
