/**
 * 数据驱动定价目录解析器 —— 单一价源 = official-pricing-catalog.json（可编辑/可刷新，勿把价格写死进代码）。
 * `modelIndex` 把工具模型 ID 映射到目录条目；视频为 PER_SECOND 费率(调用方 ×时长)，图片为 FIXED 总分。
 * 目录 status=UNVERIFIED_PENDING_AUTH(人工草案)，但关键项已与现实对齐：84/88/15 与 billing 单测一致、
 * 78(21/46/115) 与 pq_absetting 实测一致、12(1k=10) 与真实扣费一致。未命中/解析失败一律返回 undefined，
 * 交调用方 fail-closed 回退，绝不臆造价格。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface CatalogEntry {
  billingType?: string;
  price?: number;
  resolutions?: Record<string, number>;
}
type IndexValue = string | { default?: string; byServiceline?: Record<string, string> };
interface Catalog {
  status?: string;
  modelIndex?: { video?: Record<string, IndexValue>; image?: Record<string, IndexValue> };
  video?: Record<string, CatalogEntry>;
  image?: Record<string, CatalogEntry>;
}

const CATALOG_PATH = fileURLToPath(
  new URL('./assets/panqu-billing/references/official-pricing-catalog.json', import.meta.url),
);

let cached: Catalog | null | undefined;
function loadCatalog(pathOverride?: string): Catalog | null {
  if (cached !== undefined && !pathOverride) return cached;
  try {
    const parsed = JSON.parse(readFileSync(pathOverride || CATALOG_PATH, 'utf-8')) as Catalog;
    if (!pathOverride) cached = parsed;
    return parsed;
  } catch {
    if (!pathOverride) cached = null;
    return null;
  }
}

// APPEND_RESOLVER

/** 归一化分辨率到目录键：小写去空格；'720'→'720p'、去尾 'p' 再比。 */
function normalizeResolutionKey(res: string | undefined, keys: string[]): string | undefined {
  if (!res) return undefined;
  const r = res.toLowerCase().trim();
  if (keys.includes(r)) return r;
  if (/^\d+$/.test(r) && keys.includes(`${r}p`)) return `${r}p`;
  const noP = r.replace(/p$/, '');
  return keys.find((k) => k.replace(/p$/, '') === noP);
}

export interface CatalogPriceResult {
  value: number;
  billingType: 'PER_SECOND' | 'FIXED';
  catalogKey: string;
  resolutionKey?: string;
  status?: string;
}

/**
 * 从数据目录解析某模型在某分辨率(图片可含 serviceline)的价格。
 * 视频返回 PER_SECOND 费率(需 ×时长)，图片返回 FIXED 总分。未映射/未命中/无价一律 undefined。
 */
export function resolveCatalogModelPrice(params: {
  mediaType: 'video' | 'image';
  modelId: number;
  resolution?: string;
  serviceline?: string;
  catalogPathOverride?: string;
}): CatalogPriceResult | undefined {
  const cat = loadCatalog(params.catalogPathOverride);
  if (!cat) return undefined;
  const rawKey = cat.modelIndex?.[params.mediaType]?.[String(params.modelId)];
  if (!rawKey) return undefined;
  let catalogKey: string | undefined;
  if (typeof rawKey === 'string') {
    catalogKey = rawKey;
  } else {
    const sl = (params.serviceline || '').toLowerCase().trim();
    catalogKey = (sl && rawKey.byServiceline?.[sl]) || rawKey.default;
  }
  if (!catalogKey) return undefined;
  const entry = cat[params.mediaType]?.[catalogKey];
  if (!entry) return undefined;
  const billingType: 'PER_SECOND' | 'FIXED' =
    entry.billingType === 'PER_SECOND' || entry.billingType === 'FIXED'
      ? entry.billingType
      : params.mediaType === 'video'
        ? 'PER_SECOND'
        : 'FIXED';
  if (entry.resolutions && Object.keys(entry.resolutions).length > 0) {
    const keys = Object.keys(entry.resolutions);
    const rk = normalizeResolutionKey(params.resolution, keys) || (keys.includes('720p') ? '720p' : keys[0]);
    const value = entry.resolutions[rk];
    if (typeof value !== 'number') return undefined;
    return { value, billingType, catalogKey, resolutionKey: rk, status: cat.status };
  }
  if (typeof entry.price === 'number') {
    return { value: entry.price, billingType, catalogKey, status: cat.status };
  }
  return undefined;
}
