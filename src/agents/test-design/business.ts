// 通用业务识别与生成器注册表。业务名称仅作为 Requirement 数据，不参与模板选择。
import type { CanonicalSceneId } from '../../core/canonical-scene.js';
import type { Requirement } from '../requirement/requirement-schema.js';
import type { TestCase } from './testcase-schema.js';

export type BusinessKind = string;

export interface BusinessProfile {
  kind: BusinessKind | 'unknown';
  feature: string;
  /** 兼容既有消费方；通用生成器不按产品类型推断 Processor。 */
  isVideo: boolean;
  /** Processor 只能由运行时能力解析，不能由业务名称硬编码。 */
  processorScene: CanonicalSceneId | null;
}

export interface BusinessTestCaseGenerator {
  readonly kind: BusinessKind;
  generate(req: Requirement, profile: BusinessProfile, opts: { maxCases?: number }): TestCase[];
}

/**
 * 识别 Requirement 是否声明了业务域。任何非空业务域都使用同一通用生成规则；
 * Unknown 保持 Unknown，不猜测产品、功能或执行器。
 */
export function identifyBusiness(feature: string, _capabilities: string[] = []): BusinessProfile {
  const normalized = (feature ?? '').trim();
  if (!normalized || normalized.toLowerCase() === 'unknown') {
    return { kind: 'unknown', feature: normalized || 'unknown', isVideo: false, processorScene: null };
  }
  return { kind: 'generic', feature: normalized, isVideo: false, processorScene: null };
}

const registry = new Map<string, BusinessTestCaseGenerator>();

export function registerBusinessGenerator(generator: BusinessTestCaseGenerator): void {
  registry.set(generator.kind, generator);
}

export function resolveBusinessGenerator(profile: BusinessProfile): BusinessTestCaseGenerator {
  return registry.get(profile.kind) ?? registry.get(profile.kind === 'unknown' ? 'unknown' : 'generic')!;
}

export function listBusinessKinds(): string[] {
  return Array.from(registry.keys());
}
