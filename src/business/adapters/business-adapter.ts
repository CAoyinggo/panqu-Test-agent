// Business Adapter：业务与共享引擎之间的桥接层（Phase 21.1）
// 设计原则：新增业务只通过 BusinessDefinition + BusinessAdapter 接入，
// 不修改 Core Engine / Pipeline / Assertion。
// DefaultBusinessAdapter 为通用实现：仅凭 BusinessDefinition 即可完成接入（零代码）。

import type { BusinessDefinition } from '../business-schema.js';

/** 业务适配器：描述业务如何映射到共享引擎的 scene / adapter / 断言集 */
export interface BusinessAdapter {
  /** 所属业务 id */
  readonly businessId: string;
  /** 判断 feature（用例目录名 / 需求 feature）是否归属本业务 */
  matchFeature(feature: string): boolean;
  /** 将业务场景名解析为引擎可处理的 scene；不属于本业务返回 null */
  resolveScene(scene: string): string | null;
  /** 该业务用例默认使用的执行适配器名（TaskDef.adapter，供引擎断言路由） */
  defaultAdapterName(): string;
  /** 该业务声明的断言档案（断言集标识列表，供后续按业务路由断言；声明式，不侵入 core） */
  assertionProfile(): string[];
}

/** 通用业务适配器：基于 BusinessDefinition 的确定性实现 */
export class DefaultBusinessAdapter implements BusinessAdapter {
  readonly businessId: string;

  constructor(private readonly definition: BusinessDefinition) {
    this.businessId = definition.id;
  }

  /** feature 归属判定：等于业务 id，或命中业务声明的场景/能力（大小写不敏感） */
  matchFeature(feature: string): boolean {
    const f = (feature ?? '').trim().toLowerCase();
    if (!f) return false;
    if (f === this.businessId.toLowerCase()) return true;
    return this.definition.scenes.some((s) => s.toLowerCase() === f);
  }

  /** scene 解析：命中业务声明的场景（子串包含，与 SceneHandler.match 语义一致） */
  resolveScene(scene: string): string | null {
    const s = (scene ?? '').trim();
    if (!s) return null;
    const hit = this.definition.scenes.find((x) => s.includes(x) || x.includes(s));
    return hit ?? null;
  }

  /** 默认执行适配器名 = 业务 id（wan3 保持 'wan3' 与既有行为一致） */
  defaultAdapterName(): string {
    return this.businessId;
  }

  /** 断言档案：默认使用与业务 id 同名的档案；wan3 保留既有默认断言集标识 */
  assertionProfile(): string[] {
    if (this.businessId === 'wan3') {
      return ['db-check', 'billing-check', 'status-flow-check', 'isolation-check', 'account-check', 'security-check', 'chaos-check'];
    }
    return [`${this.businessId}-default`];
  }
}

/** 依据业务定义创建默认适配器 */
export function createBusinessAdapter(definition: BusinessDefinition): BusinessAdapter {
  return new DefaultBusinessAdapter(definition);
}
