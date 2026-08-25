// Requirement Agent：将用户/QA 的自然语言测试需求转换为结构化 Requirement
// 策略：LLM 解析（带 JSON Schema 提示）→ ajv 校验 → 失败回退到确定性规则解析器。
// 保证下游永远消费结构化 Requirement，而非不可控的自然语言。

import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import { parseLLMJson } from '../../llm/index.js';
import {
  Requirement,
  REQUIREMENT_JSON_SCHEMA,
  isRequirementLike,
  validateRequirement,
} from './requirement-schema.js';
import { parseRequirement } from './requirement-parser.js';
import { extractRequirementText, normalizeRequirementInput } from './requirement-normalizer.js';
import { promptRegistry } from '../prompts/registry.js';

/** 系统提示词：要求 LLM 严格按 Schema 输出 JSON（默认内置，可被 Prompt Registry 覆盖） */
const SYSTEM_PROMPT = `你是测试需求解析器。将用户的自然语言测试需求转换为结构化 JSON。
输出必须严格符合如下 JSON Schema（只输出 JSON，不要任何解释或 Markdown 围栏）：
${JSON.stringify(REQUIREMENT_JSON_SCHEMA, null, 2)}

规则：
- feature 为功能模块名（如 wan3 / user / order / payment），无法判断时必须输出 "unknown"（禁止猜测为 wan3）
- goal 为一句话测试目标（如 验证文生视频完整链路）
- requirements 为参数取值数组，例如 {"name":"resolution","values":["720P","1080P"]}
- capabilities 用英文标签（如 text-to-video / image-to-video）
- businessRules / dependencies 用简短中文短语
- constraints 为测试约束（如 禁止真实扣费、仅限测试环境），未提及则为空数组
- risks 为风险标签（如 timeout / billing / concurrency / security），按原文合理推断
- version 固定为 "v1"
- 若原文未提及某字段，用空数组或合理推断，不要编造具体取值`;

/** 从 Prompt Registry 取系统提示词（未注册时回退内置常量） */
function resolveSystemPrompt(): string {
  return promptRegistry.getVersion('requirement')?.system ?? SYSTEM_PROMPT;
}

/** 解析需求输入 */
export interface RequirementAgentInput {
  /** 自然语言需求文本 / Markdown / 接口文档 */
  text: string;
  /** 可选：feature 提示（帮助 LLM/规则判断） */
  hintFeature?: string;
  /** 输入格式：text（默认）/ markdown / document（文档，自动提取需求正文） */
  format?: 'text' | 'markdown' | 'document';
  /** 需求版本（默认 v1） */
  version?: string;
}

/** Requirement Agent */
export class RequirementAgent extends BaseAgent<RequirementAgentInput | string, Requirement> {
  name = 'requirement';
  version = '0.3.0';
  description = '将自然语言/文档测试需求解析为结构化 Requirement（LLM 优先，规则兜底）';

  async execute(input: RequirementAgentInput | string, context: AgentContext): Promise<Requirement> {
    const text = typeof input === 'string' ? input : input.text;
    const hintFeature = typeof input === 'string' ? undefined : input.hintFeature;
    // context.feature / 显式 hint 来自可信调用面，LLM 不得把业务域改写成无关 feature。
    const trustedFeature = hintFeature
      ?? (context.feature && context.feature !== 'default' && context.feature !== 'unknown' ? context.feature : undefined);
    const format = typeof input === 'string' ? 'text' : (input.format ?? 'text');
    const version = typeof input === 'string' ? undefined : input.version;
    if (!text || !text.trim()) {
      throw new Error('需求文本为空：请提供自然语言测试需求');
    }

    // 文档/Markdown 输入：先提取可解析的需求正文
    const parseText = format === 'text' ? text : extractRequirementText(text);
    if (!parseText) {
      throw new Error('无法从文档中提取有效的需求正文');
    }

    // 1. 尝试 LLM 解析（含 Mock，失败则回退）
    try {
      const llmResult = await this.parseWithLLM(parseText, trustedFeature, context);
      context.logger.info(`需求解析完成（LLM，feature=${llmResult.feature}，confidence=${llmResult.confidence ?? '-'}）`);
      return withVersion(llmResult, version, text);
    } catch (e) {
      context.logger.warn(`LLM 解析需求失败，回退规则解析：${(e as Error).message}`);
    }

    // 2. 规则解析兜底（确定性，永不走 LLM）
    const ruleResult = parseRequirement(parseText, text);
    // 原文没有足够关键词时，使用可信调用上下文补齐业务域；绝不覆盖原文明确识别出的其他 feature。
    if (ruleResult.feature === 'unknown' && trustedFeature) {
      ruleResult.feature = trustedFeature;
      ruleResult.goal = `验证 ${trustedFeature} 完整链路`;
    }
    context.logger.info(`需求解析完成（规则，feature=${ruleResult.feature}，confidence=${ruleResult.confidence ?? '-'}）`);
    return withVersion(ruleResult, version, text);
  }

  /** LLM 解析：构造提示 → 解析 JSON → 归一化 + ajv 校验 */
  private async parseWithLLM(text: string, hintFeature: string | undefined, context: AgentContext): Promise<Requirement> {
    const userContent = (hintFeature ? `功能模块提示：${hintFeature}\n\n` : '') + `测试需求：${text}`;
    const resp = await context.runtime.generate({
      task: 'requirement',
      agent: this.name,
      system: resolveSystemPrompt(),
      user: userContent,
      temperature: 0,
      jsonMode: true,
    });

    const parsed = parseLLMJson(resp); // 非法 JSON 会抛错 → 回退
    if (!isRequirementLike(parsed)) {
      throw new Error('LLM 输出缺少 feature 字段');
    }
    // ajv 校验（不通过抛错 → 回退），通过则归一化
    const validated = await validateRequirement(parsed);
    assertRequirementGrounded(validated, parseRequirement(text, text), hintFeature);
    validated.source = text;
    validated.confidence = Math.max(validated.confidence ?? 0, 0.9);
    return validated;
  }
}

/**
 * LLM Schema 合法只证明“形状正确”，不能证明业务正确。
 * 使用可信 hint + 确定性关键词基线约束 feature/capability，语义漂移时抛错走规则回退。
 */
function assertRequirementGrounded(
  candidate: Requirement,
  deterministic: Requirement,
  trustedFeature?: string,
): void {
  const expectedFeature = trustedFeature ?? (deterministic.feature !== 'unknown' ? deterministic.feature : undefined);
  if (expectedFeature && candidate.feature !== expectedFeature) {
    throw new Error(`LLM 需求语义不一致：feature=${candidate.feature}，原始需求=${expectedFeature}`);
  }
  // 两侧都声明能力时至少应有一个交集；允许 LLM 使用更具体的能力集合，也允许只给 feature 的最小合法输出。
  if (deterministic.capabilities.length > 0 && candidate.capabilities.length > 0
    && !deterministic.capabilities.some((item) => candidate.capabilities.includes(item))) {
    throw new Error(`LLM 需求语义不一致：能力 ${candidate.capabilities.join('、')} 与原始需求无交集`);
  }
}

/** 统一附版本 + 保留原始需求文本（normalizeRequirementInput 的轻量封装） */
function withVersion(req: Requirement, version: string | undefined, original: string): Requirement {
  return normalizeRequirementInput(req, { source: original, version });
}

/** 便捷工厂：创建 Requirement Agent 实例 */
export function createRequirementAgent(): RequirementAgent {
  return new RequirementAgent();
}

// 重导出 schema / parser / normalizer 便于外部消费
export { Requirement, RequirementItem } from './requirement-schema.js';
export { parseRequirement } from './requirement-parser.js';
export { REQUIREMENT_JSON_SCHEMA, normalizeRequirement, validateRequirement, isRequirementLike } from './requirement-schema.js';
export { normalizeRequirementInput, extractRequirementText, summarizeRequirement } from './requirement-normalizer.js';
