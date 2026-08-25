// 业务识别与生成器注册表：识别业务 → 对应 Generator；Unknown → UNKNOWN（绝不静默回退 WAN3）。
//
// 修复的旧问题：业务无法识别时 feature 被兜底为 'wan3'（requirement-parser 三元恒 wan3、
// LLM Prompt 明示「无法判断时用 wan3」、生成器 `feature || 'wan3'`），
// 导致非视频业务（甚至完全无关业务）被生成 WAN3 视频用例并可能真实提交执行。
//
// 识别结果：
//   wan3 / video  → VideoGenerator（scene='video'，有真实 Processor，DSL 可真实执行）
//   user / order / payment / 其它已注册业务 → 对应 Generator（DSL 结构可执行，Processor 未接入时执行层如实 NOT_EXECUTED）
//   unknown       → UnknownGenerator（不伪造任何业务用例，返回空集并显式标注）
import type { CanonicalSceneId } from '../../core/canonical-scene.js';
import type { Requirement } from '../requirement/requirement-schema.js';
import type { TestCase } from './testcase-schema.js';

/** 业务类别 */
export type BusinessKind = 'wan3' | 'video' | 'user' | 'order' | 'payment' | string;

/** 业务画像（生成器分发依据） */
export interface BusinessProfile {
  /** 业务类别（'unknown' 表示无法识别） */
  kind: BusinessKind | 'unknown';
  /** 原 feature 名（保留原样，不做 wan3 改写） */
  feature: string;
  /** 是否视频类业务（有 video Processor，DSL 可真实执行） */
  isVideo: boolean;
  /** 对应的 canonical scene（有真实 Processor；无则 null） */
  processorScene: CanonicalSceneId | null;
}

/** 业务生成器契约 */
export interface BusinessTestCaseGenerator {
  /** 业务类别标识 */
  readonly kind: BusinessKind;
  /** 生成该业务的测试用例（必须全部通过 DSL 可执行性检查） */
  generate(req: Requirement, profile: BusinessProfile, opts: { maxCases?: number }): TestCase[];
}

/**
 * 识别业务：feature 名 → 能力关键词 → unknown。
 * 注意：识别不出来就返回 unknown —— 不猜测、不回退 wan3（危险兜底已删除）。
 */
export function identifyBusiness(feature: string, capabilities: string[] = []): BusinessProfile {
  const f = (feature ?? '').trim().toLowerCase();
  const caps = capabilities.map((c) => String(c).toLowerCase());

  // 视频类：wan3 或任何视频能力/关键词（t2v / i2v / video / 首尾帧 / 全能参考）
  if (f === 'wan3' || f.includes('video')
    || caps.some((c) => /video|t2v|i2v|first-last-frame|full-reference/.test(c))) {
    return { kind: f === 'wan3' ? 'wan3' : 'video', feature: feature || 'wan3', isVideo: true, processorScene: 'video' };
  }
  // 已知非视频业务
  if (f === 'user' || f === 'order' || f === 'payment') {
    return { kind: f, feature, isVideo: false, processorScene: null };
  }
  // 无法识别：诚实返回 unknown（禁止伪装成任何业务）
  return { kind: 'unknown', feature: feature || 'unknown', isVideo: false, processorScene: null };
}

// ── 生成器注册表 ──

const registry = new Map<string, BusinessTestCaseGenerator>();

/** 注册业务生成器（同名覆盖，供扩展 XXX 业务） */
export function registerBusinessGenerator(generator: BusinessTestCaseGenerator): void {
  registry.set(generator.kind, generator);
}

/** 按业务画像取生成器：精确匹配 → 视频类 → unknown 兜底（空生成器，绝不伪造） */
export function resolveBusinessGenerator(profile: BusinessProfile): BusinessTestCaseGenerator {
  const exact = registry.get(profile.kind);
  if (exact) return exact;
  if (profile.isVideo) return registry.get('video')!;
  return registry.get('unknown')!;
}

/** 已注册的业务类别（诊断/预检用） */
export function listBusinessKinds(): string[] {
  return Array.from(registry.keys());
}
