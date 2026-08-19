// Agent Tool：Agent 访问执行能力的唯一通道
// 安全约束：禁止 LLM 直接执行 eval/exec/shell/任意文件写/任意数据库操作，
// 所有底层能力必须封装为 Tool，并经过 Schema 校验 + 超时 + 错误处理 + 审计日志。
import type { AgentContext } from '../core/agent-context.js';
// 28.3：脱敏工具上移至共享层 src/core/redact.ts，此处保留再导出以兼容既有调用方
export { redactSensitive, SENSITIVE_KEYS } from '../../core/redact.js';

/** Tool 调用结果（统一结构，不抛异常给 Agent 推理层） */
export interface ToolResult<TOutput = unknown> {
  ok: boolean;
  /** 输出（成功时） */
  data?: TOutput;
  /** 错误信息（失败时） */
  error?: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

/** Tool 权限等级（安全边界）：决定生产环境的放行策略 */
export type ToolPermission = 'read' | 'safe' | 'risky' | 'dangerous';

/** Agent Tool 接口 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  /** Tool 名称（如 executeTest / queryHistory） */
  name: string;
  /** 描述（供 Agent 判断何时调用） */
  description: string;
  /** 输入 Schema（JSON Schema 或简化描述） */
  inputSchema: unknown;
  /** 输出 Schema */
  outputSchema: unknown;
  /** 超时（毫秒，默认 registry 级默认） */
  timeoutMs?: number;
  /** 权限等级（默认 safe）：read 只读 / safe 安全 / risky 风险（大并发/扣费/删除数据）/ dangerous 生产危险（真实扣费/删库/系统命令） */
  permission?: ToolPermission;
  /** 生产环境是否一律禁止（显式声明覆盖权限推导） */
  deniedInProduction?: boolean;
  /** 执行 */
  execute(input: TInput, context: AgentContext): Promise<TOutput>;
}

/** 便捷：创建成功结果 */
export function okToolResult<T>(data: T, startedAt: number): ToolResult<T> {
  return { ok: true, data, startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt };
}

/** 便捷：创建失败结果 */
export function failToolResult(error: string, startedAt: number): ToolResult<never> {
  return { ok: false, error, startedAt, completedAt: Date.now(), durationMs: Date.now() - startedAt };
}
