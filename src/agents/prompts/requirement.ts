// Requirement Agent 系统提示词（版本化管理）
// v1：历史兼容；v2：加入事实认知边界、歧义与可追溯来源。
import { PromptDefinition, promptRegistry } from './registry.js';
import { REQUIREMENT_JSON_SCHEMA } from '../requirement/requirement-schema.js';

export const REQUIREMENT_SYSTEM_PROMPT_V1 = `你是测试需求解析器。将用户的自然语言测试需求转换为结构化 JSON。
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

export const REQUIREMENT_SYSTEM_PROMPT_V2 = `你是开发验收的需求理解器。将输入需求转换为结构化 JSON；只输出 JSON，不要解释或 Markdown 围栏。
输出必须严格符合如下 JSON Schema：
${JSON.stringify(REQUIREMENT_JSON_SCHEMA, null, 2)}

解析目标：识别功能、Actor、Action、Resource、业务规则、预期结果、状态、权限、数据关系、接口、字段和约束。

认知边界（强制）：
- understanding.facts 中每项必须标记 knowledge=EXPLICIT / INFERRED / UNKNOWN。
- EXPLICIT 只用于需求原文明示的信息，并必须在 source 中逐字引用可定位的原文片段。
- INFERRED 只能是有来源依据、用于辅助设计的推导，必须降低 confidence；不得当作产品规则或确定 Oracle。
- UNKNOWN 用于缺 Actor、Expected、状态、权限、边界、接口等无法判断的信息；同时写入 understanding.unknowns。
- 歧义写入 understanding.ambiguities，给出需要确认的问题和受影响 fact ID；禁止选择一种解释替用户做决定。
- 原文未提及的字段、状态码、角色权限、参数边界、幂等或并发语义不得补成常见默认值。

字段规则：
- feature 为功能模块；无法判断时必须为 "unknown"。
- goal 是原需求支持的一句话业务目标，不能使用“功能正常”等空泛表述。
- requirements 只保存原文明确的参数取值；未知值保留在 understanding.unknowns，不得猜值。
- capabilities、businessRules、dependencies、constraints、risks 必须能回溯到 EXPLICIT/INFERRED fact。
- risks 只描述验证风险，不得反向创造需求。
- version 使用需求中明确版本；未提供时为 "v1"。
- 所有数组在无内容时输出空数组；不要用“合理推断”填满缺失信息。`;

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
  system: REQUIREMENT_SYSTEM_PROMPT_V1,
};

/** Requirement Prompt v2：开发验收使用的默认版本。 */
export const REQUIREMENT_PROMPT_V2: PromptDefinition = {
  key: 'requirement.v2',
  name: 'requirement',
  version: 'v2',
  purpose: '将需求解析为带 EXPLICIT/INFERRED/UNKNOWN 边界和歧义清单的结构化 Requirement',
  inputSchema: { type: 'string', description: 'PRD、需求描述或 Markdown 文档正文' },
  outputSchema: REQUIREMENT_JSON_SCHEMA,
  model: 'high',
  temperature: 0,
  system: REQUIREMENT_SYSTEM_PROMPT_V2,
};

/** 注册 Requirement Prompt（幂等） */
export function registerRequirementPrompts(registry = promptRegistry): void {
  if (!registry.get('requirement.v1')) {
    registry.register(REQUIREMENT_PROMPT_V1);
  }
  if (!registry.get('requirement.v2')) {
    registry.register(REQUIREMENT_PROMPT_V2);
  }
}

// 模块加载时注册到全局注册表
registerRequirementPrompts();
