// Agent 上下文：贯穿整个 Agent 生命周期，所有 Agent 共享同一份上下文。
// 包含：任务标识、阶段产物、ToolRegistry、Memory、LLM、Logger。
import type { LLMProvider } from '../../llm/index.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { TestMemory } from '../memory/memory-store.js';
import { AgentRuntime } from './agent-runtime.js';
import { logger as defaultLogger } from '../../utils/logger.js';
import { redactSensitiveText } from '../../core/redact.js';

/** 日志接口（与现有 utils/logger.ts 单例结构一致） */
export interface AgentLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  step(msg: string): void;
}

/** Agent 上下文 */
export interface AgentContext {
  /** 任务 ID */
  taskId: string;
  /** 功能模块（如 wan3 / user / order） */
  feature: string;
  /** 执行环境（test / preonline / prod） */
  environment: string;

  /** 需求解析产物 */
  requirement?: unknown;
  /** 测试设计产物 */
  testCases?: unknown[];
  /** 风险评估产物 */
  riskAssessment?: unknown;
  /** 执行结果 */
  executionResults?: unknown[];
  /** 历史记录 */
  history?: unknown[];

  /** 工具注册表（Agent 只能通过 Tool 调用执行能力） */
  tools: ToolRegistry;
  /** 记忆（历史执行/失败/根因） */
  memory: TestMemory;
  /** LLM Provider（原始 Provider；Agent 不直接调用，统一走 runtime） */
  llm: LLMProvider;
  /**
   * Agent 运行时（LLM 调用唯一链路：PromptRegistry → ModelRouter → Provider → Retry/Timeout → Tracer/Budget）。
   * 所有 Agent 的 LLM 调用必须经 context.runtime.generate(...)，禁止直连 context.llm（治理约束）。
   */
  runtime: AgentRuntime;
  /** 日志 */
  logger: AgentLogger;

  /** 扩展元数据 */
  metadata: Record<string, unknown>;
}

/** 创建 AgentContext 的便捷入口 */
export interface CreateAgentContextOptions {
  taskId: string;
  feature: string;
  environment: string;
  tools: ToolRegistry;
  memory: TestMemory;
  llm: LLMProvider;
  logger?: AgentLogger;
  /** 注入运行时（缺省围绕 llm + 全局 ModelRouter/PromptRegistry 构建） */
  runtime?: AgentRuntime;
  requirement?: unknown;
  testCases?: unknown[];
  riskAssessment?: unknown;
  executionResults?: unknown[];
  history?: unknown[];
  metadata?: Record<string, unknown>;
}

/** 便捷工厂：构建 AgentContext（未指定 logger 时使用默认 logger） */
export function createAgentContext(opts: CreateAgentContextOptions): AgentContext {
  const logger = redactingLogger(opts.logger ?? defaultLogger);
  return {
    taskId: opts.taskId,
    feature: opts.feature,
    environment: opts.environment,
    requirement: opts.requirement,
    testCases: opts.testCases,
    riskAssessment: opts.riskAssessment,
    executionResults: opts.executionResults,
    history: opts.history,
    tools: opts.tools,
    memory: opts.memory,
    llm: opts.llm,
    runtime: opts.runtime ?? new AgentRuntime({ llm: opts.llm, logger }),
    logger,
    metadata: opts.metadata ?? {},
  };
}

function redactingLogger(base: AgentLogger): AgentLogger {
  return {
    debug: (message) => base.debug(redactSensitiveText(message)),
    info: (message) => base.info(redactSensitiveText(message)),
    warn: (message) => base.warn(redactSensitiveText(message)),
    error: (message) => base.error(redactSensitiveText(message)),
    step: (message) => base.step(redactSensitiveText(message)),
  };
}
