// Prompt Registry：统一管理 Agent System Prompt（版本化）
// 目标：禁止把 Prompt 硬编码在 Agent TypeScript 中；每个 Prompt 带 version/purpose/input/output/model/temperature，
// 方便后续 Prompt A/B Test 与按模型路由。
// 兼容策略：Agent 优先从 Registry 取 Prompt，未注册时回退到内置常量，保证既有行为不变。

/** Prompt 定义 */
export interface PromptDefinition {
  /** 唯一键（如 requirement.v1） */
  key: string;
  /** Prompt 名（如 requirement / test-design / risk） */
  name: string;
  /** 版本号（如 v1 / v2） */
  version: string;
  /** 用途说明 */
  purpose: string;
  /** 输入 Schema（提示词接受的输入结构，用于诊断/评测） */
  inputSchema: unknown;
  /** 输出 Schema（要求 LLM 严格输出的结构，用于校验） */
  outputSchema: unknown;
  /** 推荐模型等级（如 high / medium / low，供 Model Router 路由） */
  model?: 'high' | 'medium' | 'low' | string;
  /** 采样温度 */
  temperature?: number;
  /** 系统提示词内容 */
  system: string;
}

/** Prompt 注册表 */
export class PromptRegistry {
  private prompts = new Map<string, PromptDefinition>();

  /** 注册 Prompt（同名同版本覆盖） */
  register(prompt: PromptDefinition): void {
    this.prompts.set(prompt.key, prompt);
  }

  /** 按完整 key 获取（如 requirement.v1） */
  get(key: string): PromptDefinition | undefined {
    return this.prompts.get(key);
  }

  /** 按名+版本获取；未指定版本时取该名最新注册版本 */
  getVersion(name: string, version?: string): PromptDefinition | undefined {
    if (version) return this.prompts.get(`${name}.${version}`);
    const keys = Array.from(this.prompts.keys()).filter((k) => k.startsWith(`${name}.`));
    if (!keys.length) return undefined;
    // 版本号按 v 后数字排序取最大
    keys.sort((a, b) => {
      const na = Number(a.slice(a.lastIndexOf('.') + 1).replace(/\D/g, '') || 0);
      const nb = Number(b.slice(b.lastIndexOf('.') + 1).replace(/\D/g, '') || 0);
      return nb - na;
    });
    return this.prompts.get(keys[0]);
  }

  /** 列出全部 Prompt */
  list(): PromptDefinition[] {
    return Array.from(this.prompts.values());
  }

  /** 列出某名字的全部版本（供 A/B Test） */
  listVersions(name: string): PromptDefinition[] {
    return Array.from(this.prompts.values()).filter((p) => p.name === name);
  }

  /** 移除（测试/替换用） */
  unregister(key: string): boolean {
    return this.prompts.delete(key);
  }

  clear(): void {
    this.prompts.clear();
  }
}

/** 全局默认 Prompt 注册表（各 Agent 模块注册自身 Prompt） */
export const promptRegistry = new PromptRegistry();
