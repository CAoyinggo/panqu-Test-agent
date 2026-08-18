// Agent 注册表：统一登记/查询所有 Agent（按名称），支持运行时替换实现
import type { TestAgent } from './agent.js';

/** Agent 注册表 */
export class AgentRegistry {
  private agents = new Map<string, TestAgent>();

  /** 注册 Agent（同名覆盖） */
  register<TInput = unknown, TOutput = unknown>(agent: TestAgent<TInput, TOutput>): void {
    this.agents.set(agent.name, agent as TestAgent);
  }

  /** 按名称获取 Agent */
  get<TInput = unknown, TOutput = unknown>(name: string): TestAgent<TInput, TOutput> | undefined {
    return this.agents.get(name) as TestAgent<TInput, TOutput> | undefined;
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  /** 列出全部已注册 Agent 名称 */
  list(): string[] {
    return Array.from(this.agents.keys());
  }

  /** 列出全部 Agent（含描述，供报告/调试） */
  listWithMeta(): Array<{ name: string; version: string; description?: string }> {
    return Array.from(this.agents.values()).map((a) => ({
      name: a.name,
      version: a.version,
      description: a.description,
    }));
  }

  /** 移除 Agent（测试/替换用） */
  unregister(name: string): boolean {
    return this.agents.delete(name);
  }

  clear(): void {
    this.agents.clear();
  }
}
