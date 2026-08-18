// Business Loader：业务定义加载（Phase 21.1）
// 两种接入方式：
//   1. 内置业务：BUILTIN_BUSINESSES（平台一级业务）
//   2. 外部定义目录：BUSINESS_DEFS_DIR 指向的目录下每个 *.json 为一个业务定义，
//      校验通过后注册 —— 新增业务无需修改任何代码（零代码接入）。

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { validateBusinessDefinition, type BusinessDefinition } from './business-schema.js';
import type { BusinessRegistry } from './registry.js';
import { BUILTIN_BUSINESSES } from './definitions/index.js';

/** 外部业务定义目录环境变量 */
export const BUSINESS_DEFS_DIR_ENV = 'BUSINESS_DEFS_DIR';

/** 注册内置业务到指定注册表（跳过已存在的 id，允许先手动覆盖） */
export function loadBuiltinBusinesses(registry: BusinessRegistry): BusinessRegistry {
  for (const def of BUILTIN_BUSINESSES) {
    if (!registry.has(def.id)) registry.register(def);
  }
  return registry;
}

/**
 * 从外部目录加载业务定义（*.json），校验后注册。
 * - 目录不存在：静默返回 0（不视为错误）
 * - 单个文件校验失败：告警并跳过，不影响其他文件
 * - id 与已注册业务冲突：告警并跳过（不覆盖）
 * 返回成功注册数量。
 */
export async function loadBusinessDefinitionsFromDir(registry: BusinessRegistry, dir: string): Promise<number> {
  if (!dir) return 0;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return 0; // 目录不存在或不可读
  }
  let loaded = 0;
  for (const file of files.sort()) {
    const full = path.join(dir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf-8'));
      const def: BusinessDefinition = await validateBusinessDefinition(raw);
      if (registry.has(def.id)) {
        logger.warn(`业务定义跳过（${def.id} 已注册）：${full}`);
        continue;
      }
      registry.register(def);
      loaded += 1;
    } catch (e) {
      logger.warn(`业务定义加载失败 ${full}：${(e as Error).message}`);
    }
  }
  return loaded;
}

/** 业务注册中心初始化选项 */
export interface InitBusinessRegistryOptions {
  /** 外部业务定义目录（缺省读环境变量 BUSINESS_DEFS_DIR） */
  externalDir?: string;
  /** 是否加载内置业务（默认 true） */
  builtin?: boolean;
}

/**
 * 初始化业务注册中心：内置业务 + 外部定义目录。
 * 返回 { registry, externalLoaded }。
 */
export async function initBusinessRegistry(
  registry: BusinessRegistry,
  options: InitBusinessRegistryOptions = {},
): Promise<{ registry: BusinessRegistry; externalLoaded: number }> {
  if (options.builtin !== false) loadBuiltinBusinesses(registry);
  const dir = options.externalDir ?? process.env[BUSINESS_DEFS_DIR_ENV] ?? '';
  const externalLoaded = await loadBusinessDefinitionsFromDir(registry, dir);
  return { registry, externalLoaded };
}
