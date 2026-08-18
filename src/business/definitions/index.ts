// 内置业务定义（Phase 21.1）：wan3 + 5 个新业务
// 新增业务优先通过外部定义目录接入（见 loader.ts 的 BUSINESS_DEFS_DIR），
// 内置定义仅覆盖平台一级业务。

import type { BusinessDefinition } from '../business-schema.js';

/** WAN3 AI 视频生成（既有业务，定义与现状对齐：scene=video，7 项默认断言） */
export const WAN3_BUSINESS: BusinessDefinition = {
  id: 'wan3',
  name: 'WAN3 Video Generation',
  version: '1.0',
  scenes: ['video'],
  environments: ['test', 'preonline'],
  capabilities: ['text-to-video', 'image-to-video', 'first-last-frame', 'omni-reference'],
  riskPolicy: {
    forbiddenActions: ['real-billing', 'delete-data'],
    requireApproval: true,
    maxConcurrency: 10,
    focusRiskCategories: ['billing', 'concurrency', 'timeout'],
  },
  testPolicy: {
    defaultSuite: 'regression',
    p0Required: true,
    coverageThreshold: 0.9,
    allowedEnvironments: ['test', 'preonline'],
  },
  description: '盼趣 AI 视频生成业务（文生视频 / 图生视频 / 首尾帧 / 全能参考）',
};

/** AI 图像生成 */
export const IMAGE_GENERATION_BUSINESS: BusinessDefinition = {
  id: 'image-generation',
  name: 'AI Image Generation',
  version: '1.0',
  scenes: ['image-generation'],
  environments: ['test'],
  capabilities: ['text-to-image', 'image-to-image', 'image-edit', 'inpainting'],
  riskPolicy: {
    forbiddenActions: ['delete-data'],
    requireApproval: true,
    focusRiskCategories: ['billing', 'security'],
  },
  testPolicy: {
    defaultSuite: 'smoke',
    p0Required: true,
    coverageThreshold: 0.9,
  },
  description: 'AI 图像生成业务（文生图 / 图生图 / 图像编辑 / 局部重绘）',
};

/** Chat / LLM 对话 */
export const CHAT_BUSINESS: BusinessDefinition = {
  id: 'chat',
  name: 'Chat / LLM Conversation',
  version: '1.0',
  scenes: ['chat'],
  environments: ['test'],
  capabilities: ['single-turn', 'multi-turn', 'streaming', 'context-memory'],
  riskPolicy: {
    forbiddenActions: ['delete-data'],
    requireApproval: true,
    focusRiskCategories: ['security', 'timeout'],
  },
  testPolicy: {
    defaultSuite: 'smoke',
    p0Required: true,
    coverageThreshold: 0.85,
  },
  description: 'LLM 对话业务（单轮 / 多轮 / 流式 / 上下文记忆）',
};

/** AI 音乐生成 */
export const MUSIC_BUSINESS: BusinessDefinition = {
  id: 'music',
  name: 'AI Music Generation',
  version: '1.0',
  scenes: ['music'],
  environments: ['test'],
  capabilities: ['text-to-music', 'lyrics-generation', 'music-continuation'],
  riskPolicy: {
    forbiddenActions: ['delete-data'],
    requireApproval: true,
    focusRiskCategories: ['billing', 'timeout'],
  },
  testPolicy: {
    defaultSuite: 'smoke',
    p0Required: true,
    coverageThreshold: 0.85,
  },
  description: 'AI 音乐生成业务（文生音乐 / 歌词生成 / 音乐续写）',
};

/** 数字人 */
export const DIGITAL_HUMAN_BUSINESS: BusinessDefinition = {
  id: 'digital-human',
  name: 'Digital Human',
  version: '1.0',
  scenes: ['digital-human'],
  environments: ['test'],
  capabilities: ['text-to-speech', 'avatar-driving', 'lip-sync'],
  riskPolicy: {
    forbiddenActions: ['delete-data'],
    requireApproval: true,
    focusRiskCategories: ['billing', 'timeout', 'security'],
  },
  testPolicy: {
    defaultSuite: 'smoke',
    p0Required: true,
    coverageThreshold: 0.85,
  },
  description: '数字人业务（TTS / 形象驱动 / 口型同步）',
};

/** AI 工作流编排 */
export const WORKFLOW_BUSINESS: BusinessDefinition = {
  id: 'workflow',
  name: 'AI Workflow Orchestration',
  version: '1.0',
  scenes: ['workflow'],
  environments: ['test'],
  capabilities: ['workflow-execution', 'node-orchestration', 'branch-routing'],
  riskPolicy: {
    forbiddenActions: ['delete-data'],
    requireApproval: true,
    focusRiskCategories: ['concurrency', 'timeout', 'dependency'],
  },
  testPolicy: {
    defaultSuite: 'regression',
    p0Required: true,
    coverageThreshold: 0.9,
  },
  description: 'AI 工作流编排业务（流程执行 / 节点编排 / 分支路由）',
};

/** 全部内置业务定义 */
export const BUILTIN_BUSINESSES: BusinessDefinition[] = [
  WAN3_BUSINESS,
  IMAGE_GENERATION_BUSINESS,
  CHAT_BUSINESS,
  MUSIC_BUSINESS,
  DIGITAL_HUMAN_BUSINESS,
  WORKFLOW_BUSINESS,
];
