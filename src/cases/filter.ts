// 用例筛选器：按标签 / 名称子串 / 场景筛选，AND 组合
import type { LoadedCase } from './loader.js';
import { logger } from '../utils/logger.js';

export interface FilterOptions {
  /** 按标签筛选（匹配 tags 数组中任一标签包含此子串） */
  grep?: string | null;
  /** 按名称子串筛选（大小写不敏感） */
  filter?: string | null;
  /** 按场景类型筛选（匹配 scene 字段包含此子串） */
  scene?: string | null;
}

/**
 * 筛选用例：支持 grep/filter/scene 三种维度，AND 组合。
 * 无匹配时返回空数组（调用方应报错退出，而非空跑）。
 */
export function filterCases(cases: LoadedCase[], opts: FilterOptions): LoadedCase[] {
  const { grep, filter, scene } = opts;
  const hasFilter = !!(grep || filter || scene);

  if (!hasFilter) return cases;

  const result = cases.filter((c) => {
    // grep：匹配 tags 数组
    if (grep) {
      const tags = (c.def.tags as string[] | undefined) || [];
      if (!tags.some((t: string) => t.toLowerCase().includes(grep.toLowerCase()))) return false;
    }
    // filter：匹配名称子串（大小写不敏感）
    if (filter) {
      if (!c.name.toLowerCase().includes(filter.toLowerCase())) return false;
    }
    // scene：匹配场景字段
    if (scene) {
      if (!c.def.scene.toLowerCase().includes(scene.toLowerCase())) return false;
    }
    return true;
  });

  logger.info(
    `用例筛选：${grep ? `grep="${grep}" ` : ''}${filter ? `filter="${filter}" ` : ''}${scene ? `scene="${scene}" ` : ''}→ ${result.length}/${cases.length} 匹配`,
  );

  return result;
}
