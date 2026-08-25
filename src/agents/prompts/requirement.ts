// Requirement Agent 系统提示词（版本化管理）
// v1：与 Phase 1-9 内嵌提示词等价，抽出为可版本化/可 A/B 的 PromptDefinition。
import { PromptDefinition, promptRegistry } from './registry.js';
import { REQUIREMENT_JSON_SCHEMA } from '../requirement/requirement-schema.js';

const SYSTEM_PROMPT_V1 = `你是测试需求解析器。将用户的自然语言测试需求转换为结构化 JSON。
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

/** Requirement Prompt v1 定义 */
export const REQUIREMENT_PROMPT_V1: PromptDefinition = {
  key: 'requirement.v1',
  name: 'requirement',
  version: 'v1',
  purpose: '将自然语言/文档测试需求解析为结构化 Requirement',
  inputSchema: { type: 'string', description: '测试需求文本或文档内容' },
  outputSchema: REQUIREMENT_JSON_SCHEMA,
  model: 'high',
  temperature: 0,
  system: SYSTEM_PROMPT_V1,
};

/** 注册 Requirement Prompt（幂等） */
export function registerRequirementPrompts(registry = promptRegistry): void {
  if (!registry.get('requirement.v1')) {
    registry.register(REQUIREMENT_PROMPT_V1);
  }
}

// 模块加载时注册到全局注册表
registerRequirementPrompts();
