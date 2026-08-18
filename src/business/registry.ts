// Business Registry：业务注册中心（Phase 21.1）
// 职责：统一注册 / 查询 / 解析业务定义与适配器。
// 单例模式：引擎与 Agent 通过 getBusinessRegistry() 获取同一实例；
// 测试可用 createBusinessRegistry() 构造隔离实例，或 resetBusinessRegistry() 重置单例。

import type { BusinessDefinition } from './business-schema.js';
import { createBusinessAdapter, type BusinessAdapter } from './adapters/business-adapter.js';

/** 注册表条目：业务定义 + 适配器 */
export interface BusinessEntry {
  definition: BusinessDefinition;
  adapter: BusinessAdapter;
  /** 注册时间（ISO） */
  registeredAt: string;
}

/** 业务注册中心 */
export class BusinessRegistry {
  private readonly entries = new Map<string, BusinessEntry>();

  /** 注册业务：id 重复抛错（防止静默覆盖导致行为漂移） */
  register(definition: BusinessDefinition, adapter?: BusinessAdapter): BusinessEntry {
    const id = definition.id?.trim();
    if (!id) throw new Error('业务注册失败：缺少 id');
    if (this.entries.has(id)) throw new Error(`业务注册失败：${id} 已存在`);
    const entry: BusinessEntry = {
      definition,
      adapter: adapter ?? createBusinessAdapter(definition),
      registeredAt: new Date().toISOString(),
    };
    this.entries.set(id, entry);
    return entry;
  }

  /** 注销业务（测试 / 热更新用） */
  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): BusinessEntry | null {
    return this.entries.get(id) ?? null;
  }

  /** 全部已注册业务（按注册时间稳定排序：id 升序） */
  list(): BusinessEntry[] {
    return [...this.entries.values()].sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /** 依据 feature（用例目录名 / 需求 feature）解析归属业务；未命中返回 null */
  resolveByFeature(feature: string): BusinessEntry | null {
    if (!feature) return null;
    for (const entry of this.entries.values()) {
      if (entry.adapter.matchFeature(feature)) return entry;
    }
    return null;
  }

  /** 依据能力标签解析归属业务（如 text-to-video → wan3）；未命中返回 null */
  resolveByCapability(capability: string): BusinessEntry | null {
    const c = (capability ?? '').trim().toLowerCase();
    if (!c) return null;
    for (const entry of this.entries.values()) {
      if (entry.definition.capabilities.some((x) => x.toLowerCase() === c)) return entry;
    }
    return null;
  }

  /** 依据 scene 解析归属业务；未命中返回 null */
  resolveByScene(scene: string): BusinessEntry | null {
    if (!scene) return null;
    for (const entry of this.entries.values()) {
      if (entry.adapter.resolveScene(scene)) return entry;
    }
    return null;
  }

  /** 全部已注册业务 id 列表 */
  ids(): string[] {
    return this.list().map((e) => e.definition.id);
  }
}

/** 创建独立注册表实例（测试隔离 / 自定义装配） */
export function createBusinessRegistry(): BusinessRegistry {
  return new BusinessRegistry();
}

let singleton: BusinessRegistry | null = null;

/** 获取全局单例注册表（首次调用自动加载内置业务） */
export async function getBusinessRegistry(): Promise<BusinessRegistry> {
  if (!singleton) {
    singleton = createBusinessRegistry();
    const { loadBuiltinBusinesses } = await import('./loader.js');
    loadBuiltinBusinesses(singleton);
  }
  return singleton;
}

/** 重置全局单例（仅测试使用） */
export function resetBusinessRegistry(): void {
  singleton = null;
}
