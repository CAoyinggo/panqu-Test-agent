// Tool Registry：统一登记/调用 Agent Tool（含安全边界）
// 职责：登记、查询、带超时的安全调用、错误捕获、权限执行（Phase 10-18 安全边界）、审计日志（脱敏）。
// 安全边界：
//   - Agent 只能通过本注册表调用执行能力，禁止直接触碰底层模块。
//   - 生产环境（prod/preonline）：read/safe 放行；risky/dangerous 需审批，无审批则默认拒绝（strict）。
//   - 审计日志中的输入统一经 redactSensitive 脱敏，敏感字段（token/password/secret 等）不落明文。
import type { AgentContext } from '../core/agent-context.js';
import { AgentTool, ToolResult, okToolResult, failToolResult, redactSensitive } from './tool.js';

/** 审计条目 */
export interface ToolAuditEntry {
  name: string;
  input: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** 权限拦截原因（被 DENY 时） */
  reason?: string;
}

export interface ToolRegistryOptions {
  /** 默认超时（毫秒，默认 30s） */
  defaultTimeoutMs?: number;
  /** 审计日志回调（每次调用记录 name/脱敏 input 摘要/耗时/结果） */
  onAudit?: (entry: ToolAuditEntry) => void;
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

  constructor(options: ToolRegistryOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.audit = options.onAudit;
    this.environment = options.environment;
    this.permissionPolicy = options.permissionPolicy ?? 'strict';
    this.onApproval = options.onApproval;
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
   * 安全调用 Tool：权限检查 → 查找 → 超时保护 → 错误捕获 → 审计（输入脱敏）。
   * 无论 Tool 内部抛错、超时或被权限拦截，都返回结构化的 ToolResult（不向调用方抛异常）。
   */
  async call<TInput = unknown, TOutput = unknown>(
    name: string,
    input: TInput,
    context: AgentContext,
  ): Promise<ToolResult<TOutput>> {
    const startedAt = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      const error = `Tool 未注册：${name}（可用：${this.list().join(', ') || '无'}）`;
      this.audit?.({ name, input: redactSensitive(input), ok: false, durationMs: 0, error });
      return failToolResult(error, startedAt);
    }

    // 权限执行（安全边界）
    const permit = await this.enforcePermission(tool, context);
    if (!permit.allowed) {
      this.audit?.({ name, input: redactSensitive(input), ok: false, durationMs: 0, reason: permit.reason });
      context.logger.warn(`[安全] Tool 被拦截：${name} - ${permit.reason}`);
      return failToolResult(permit.reason, startedAt);
    }

    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Tool 超时（${timeoutMs}ms）：${name}`)), timeoutMs);
    });

    try {
      const result = await Promise.race([tool.execute(input, context), timeoutPromise]);
      this.audit?.({ name, input: redactSensitive(input), ok: true, durationMs: Date.now() - startedAt });
      return okToolResult(result as TOutput, startedAt);
    } catch (e) {
      const error = (e as Error).message;
      this.audit?.({ name, input: redactSensitive(input), ok: false, durationMs: Date.now() - startedAt, error });
      context.logger.warn(`Tool 调用失败：${name} - ${error}`);
      return failToolResult(error, startedAt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
