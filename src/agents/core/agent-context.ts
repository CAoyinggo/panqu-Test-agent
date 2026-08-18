// Agent 上下文：贯穿整个 Agent 生命周期，所有 Agent 共享同一份上下文。
// 包含：任务标识、阶段产物、ToolRegistry、Memory、LLM、Logger。
import type { LLMProvider } from '../../llm/index.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { TestMemory } from '../memory/memory-store.js';
import { logger as defaultLogger } from '../../utils/logger.js';

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
  /** LLM Provider（推理能力） */
  llm: LLMProvider;
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
  requirement?: unknown;
  testCases?: unknown[];
  riskAssessment?: unknown;
  executionResults?: unknown[];
  history?: unknown[];
  metadata?: Record<string, unknown>;
}

/** 便捷工厂：构建 AgentContext（未指定 logger 时使用默认 logger） */
export function createAgentContext(opts: CreateAgentContextOptions): AgentContext {
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
    logger: opts.logger ?? defaultLogger,
    metadata: opts.metadata ?? {},
  };
}
