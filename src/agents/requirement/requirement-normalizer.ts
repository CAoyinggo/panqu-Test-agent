// Requirement Normalizer：统一的需求归一化入口
// 目标：Phase 10 增强 —— 支持多种输入形态（自然语言 / Markdown / 接口文档 / 结构化对象），
// 输出统一的结构化 Requirement（含 goal / constraints / risks / version / source），
// 并保留原始需求文本（审计）与需求版本。
// 与 schema.ts 的 normalizeRequirement 区别：本模块是「输入入口」，负责格式识别与文档预处理；
// schema 的 normalize 负责「字段规整」。LLM 路径与规则路径最终都收敛到本模块产出的完整 Requirement。

import {
  Requirement,
  normalizeRequirement,
} from './requirement-schema.js';
import { parseRequirement } from './requirement-parser.js';

/** 归一化选项 */
export interface NormalizeRequirementOptions {
  /** 记录原始来源文本（缺省取输入文本） */
  source?: string;
  /** 需求版本（缺省 v1） */
  version?: string;
}

/** 归一化结果：结构化需求 + 审计信息 */
export interface NormalizedRequirementBundle {
  requirement: Requirement;
  /** 原始输入（需求文本/文档全文，审计用） */
  original: string;
  /** 解析模式：rules（确定性） */
  mode: 'rules';
}

/** 判断输入是否为结构化对象（Record） */
function isRecordInput(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/**
 * 从 Markdown / 文档文本中提取「可解析的需求正文」。
 * - 移除代码块 / 表格 / URL / 图片
 * - 提取标题、列表项、正文段落，合并为可被规则解析的连续文本
 * 说明：仅做轻量文本规整，不重写解析逻辑；结构化文档若含 feature 等字段将直接走对象分支。
 */
export function extractRequirementText(doc: string): string {
  if (!doc) return '';
  return doc
    .replace(/```[\s\S]*?```/g, ' ')            // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')      // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // 链接 → 保留文本
    .replace(/\|.*\|/g, ' ')                    // 表格行
    .replace(/^#{1,6}\s*/gm, ' ')               // 标题符号
    .replace(/^[-*+]\s+/gm, ' ')                // 列表符号
    .replace(/`([^`]*)`/g, '$1')                // 行内代码
    .replace(/\s+/g, ' ')                       // 压缩空白
    .trim();
}

/**
 * 统一归一化入口：任意输入 → 完整 Requirement。
 * 对象输入：直接 normalizeRequirement（含新字段规整）。
 * 文本输入：先做文档规整 → 规则解析（确定性兜底），保留原始文本与版本。
 */
export function normalizeRequirementInput(
  input: string | Record<string, unknown> | Requirement,
  options: NormalizeRequirementOptions = {},
): Requirement {
  const version = options.version; // 显式版本优先（未指定则取已有版本，兜底 v1）

  // 对象输入（结构化 / 已解析 Requirement）
  if (isRecordInput(input)) {
    const req = normalizeRequirement(input as Record<string, unknown>);
    return {
      ...req,
      version: version ?? req.version ?? 'v1',
      source: options.source ?? req.source,
    };
  }

  // 文本输入（自然语言 / Markdown / 文档）
  const original = options.source ?? String(input);
  const plain = extractRequirementText(String(input));
  const req = parseRequirement(plain, original);
  return { ...req, version: version ?? req.version ?? 'v1' };
}

/** 便捷：显式给需求附版本（覆盖既有版本） */
export function withRequirementVersion(req: Requirement, version = 'v1'): Requirement {
  return { ...req, version };
}

/** 审计摘要：把 Requirement 压缩为一行可读文本（报告/日志用） */
export function summarizeRequirement(req: Requirement): string {
  return [
    req.feature,
    req.goal ?? '',
    `能力[${req.capabilities.join(',')}]`,
    `规则[${req.businessRules.join(',')}]`,
    req.constraints?.length ? `约束[${req.constraints.join(',')}]` : '',
    req.risks?.length ? `风险[${req.risks.join(',')}]` : '',
    `置信度${req.confidence ?? '-'}`,
  ]
    .filter(Boolean)
    .join(' | ');
}

/** 重导出便于外部消费 */
export { normalizeRequirement } from './requirement-schema.js';
