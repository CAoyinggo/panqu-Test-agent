// Change Impact Analyzer：变更影响分析（Phase 21.3）
// 输入：代码 / 模型 / 接口 / 配置 / 价格 / 环境 / 需求变化
// 输出：受影响业务 / 能力 / TestCase / 风险 + 命中原因
// 确定性实现：基于业务注册中心（能力映射）+ 测试资产库（用例标签/内容匹配），不依赖 LLM。

import type { BusinessRegistry } from '../business/registry.js';
import type { TestAssetStore } from '../test-assets/asset-store.js';
import type { ChangeEvent, ImpactAnalysis } from './regression-schema.js';

/** 变更类型 → 风险描述模板 */
const CHANGE_RISK_HINTS: Record<ChangeEvent['type'], string> = {
  code: '代码变化可能引入行为回归',
  model: '模型变化影响生成质量与输出一致性',
  api: '接口变化影响请求/响应兼容性',
  config: '配置变化影响环境一致性与端点可用性',
  pricing: '价格变化影响计费正确性',
  environment: '环境变化影响服务可用性与依赖连通',
  requirement: '需求变化影响既有用例的覆盖有效性',
};

/** 从 target 提取关键词（支持 biz/capability 形态与多词） */
function targetKeywords(change: ChangeEvent): string[] {
  const parts = change.target.split(/[/:@\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const kw = new Set<string>(parts);
  if (change.from) kw.add(change.from.toLowerCase());
  if (change.to) kw.add(change.to.toLowerCase());
  return [...kw];
}

/**
 * 变更影响分析。
 * @param store 测试资产库（提供受影响用例）
 * @param registry 业务注册中心（提供业务/能力映射，可选）
 */
export function analyzeChangeImpact(
  change: ChangeEvent,
  store: TestAssetStore,
  registry?: BusinessRegistry,
): ImpactAnalysis {
  const reasons: string[] = [];
  const businesses = new Set<string>();
  const capabilities = new Set<string>();

  // 1. 定位受影响业务
  if (change.businessId && registry?.has(change.businessId)) {
    businesses.add(change.businessId);
    reasons.push(`变更显式归属业务：${change.businessId}`);
  } else if (registry) {
    const byFeature = registry.resolveByFeature(change.target)
      ?? registry.resolveByCapability(change.target)
      ?? registry.resolveByScene(change.target);
    if (byFeature) {
      businesses.add(byFeature.definition.id);
      reasons.push(`目标「${change.target}」命中业务 ${byFeature.definition.id}`);
    }
    // target 形如 wan3/text-to-video：逐段解析
    for (const kw of targetKeywords(change)) {
      const hit = registry.resolveByCapability(kw) ?? registry.resolveByScene(kw) ?? registry.resolveByFeature(kw);
      if (hit) {
        if (!businesses.has(hit.definition.id)) {
          businesses.add(hit.definition.id);
          reasons.push(`关键词「${kw}」命中业务 ${hit.definition.id}`);
        }
        if (hit.definition.capabilities.some((c) => c.toLowerCase() === kw)) capabilities.add(kw);
      }
    }
  }

  // 全局型变更（code / config / environment）未定位到业务时影响全部业务
  const isGlobalType = ['code', 'config', 'environment'].includes(change.type);
  if (!businesses.size && isGlobalType && registry) {
    for (const entry of registry.list()) businesses.add(entry.definition.id);
    reasons.push(`${change.type} 类变更未定位具体业务，按全局变更处理`);
  }

  // 2. 受影响能力：命中业务的 capabilities 中与 target 关键词相关的部分（无关键词命中则全部）
  if (registry && !capabilities.size) {
    const kws = targetKeywords(change);
    for (const biz of businesses) {
      const def = registry.get(biz)?.definition;
      if (!def) continue;
      const related = def.capabilities.filter((c) => kws.some((k) => c.toLowerCase().includes(k) || k.includes(c.toLowerCase())));
      for (const c of related.length ? related : def.capabilities) capabilities.add(c);
    }
    if (capabilities.size) reasons.push(`受影响能力来自业务声明：${[...capabilities].join(', ')}`);
  }

  // 3. 受影响用例：feature 归属命中 或 tags/content 含变更关键词/能力
  const kws = targetKeywords(change);
  const affectedCases: string[] = [];
  const candidates = store.query({ type: 'test-case', includeArchived: false });
  for (const asset of candidates) {
    const hay = `${asset.feature} ${asset.tags.join(' ')} ${JSON.stringify(asset.content ?? {})}`.toLowerCase();
    if (businesses.has(asset.feature)) {
      affectedCases.push(asset.id);
      reasons.push(`用例 ${asset.id} 归属受影响业务 ${asset.feature}`);
      continue;
    }
    const hitKw = [...capabilities, ...kws].find((k) => k && hay.includes(k));
    if (hitKw) {
      affectedCases.push(asset.id);
      reasons.push(`用例 ${asset.id} 命中变更关键词「${hitKw}」`);
    }
  }

  // 4. 受影响风险
  const affectedRisks = [CHANGE_RISK_HINTS[change.type]];
  if (change.type === 'pricing') affectedRisks.push('积分/计费断言需重新核对');
  if (change.type === 'model') affectedRisks.push('生成结果基线可能漂移，需对比历史');

  return {
    change,
    affectedBusinesses: [...businesses].sort(),
    affectedCapabilities: [...capabilities].sort(),
    affectedCases: affectedCases.sort(),
    affectedRisks,
    reasons,
  };
}
