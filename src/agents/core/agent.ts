// 统一 Agent 接口：所有 Agent（Requirement / TestDesign / Risk / Data / Execution / Analysis）必须遵循
// 通过泛型定义输入/输出，保证各阶段产物类型安全、可替换。
import type { AgentContext } from './agent-context.js';
import type { AgentResult } from './agent-result.js';

/** 统一 Agent 接口 */
export interface TestAgent<TInput = unknown, TOutput = unknown> {
  /** Agent 唯一名称（如 'requirement' / 'test-design'） */
  name: string;
  /** 版本号 */
  version: string;
  /** 职责描述（注册表/报告展示用） */
  description?: string;
  /** 执行单个阶段 */
  execute(input: TInput, context: AgentContext): Promise<TOutput>;
}

/** 抽象基类：实现公共字段，子类只需提供 name/description/execute */
export abstract class BaseAgent<TInput = unknown, TOutput = unknown> implements TestAgent<TInput, TOutput> {
  abstract name: string;
  version = '0.1.0';
  /** 职责描述（可选，缺省为空） */
  description?: string;

  abstract execute(input: TInput, context: AgentContext): Promise<TOutput>;

  /** 便捷包装：捕获异常并返回结构化 AgentResult（供 Orchestrator 消费） */
  async runWithResult(input: TInput, context: AgentContext): Promise<AgentResult<TOutput>> {
    const startedAt = Date.now();
    try {
      const data = await this.execute(input, context);
      return {
        agent: this.name,
        success: true,
        data,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      return {
        agent: this.name,
        success: false,
        error: (e as Error).message,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  }
}
