/**
 * Diversion Pricing Authority (feishu 分流渠道表 → 测试基准)
 * =============================================================================
 * 用户指令 (2026-09-24)：分流测试的「成本价对比」与「可分流分辨率/能力判定」
 * 一律以飞书《分流渠道表》为权威来源。本模块把该表的本地快照
 * (`assets/panqu-newapi-diversion/references/feishu-live-pricing-cache.json`)
 * 加载为可查询的判定依据，供分流/新渠道接入测试消费。
 *
 * 纯逻辑 + 只读文件，零网络。fail-closed：数据缺失即抛错，绝不臆造价格。
 * 三条铁律（写入 _meta.invariants，本模块据此判定）：
 *  1. 刊例价(积分/秒)不随分流渠道变化——同 (模型,分辨率) 只允许唯一值；
 *  2. 折扣渠道成本 = 火山官方价 × 折扣系数（已在 costPriceComputed 解析）；
 *  3. 某渠道对某 (模型,分辨率) 可分流，当且仅当表中存在对应行且能力列满足。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface PriceRow {
  row: number;
  channel: string | null;
  model: string | null;
  billing: string | null;
  resolution: string | null;
  aspectRatios: string | null;
  virtualPortrait: string | null;
  realPortrait: string | null;
  universalRef: string | null;
  firstLastFrame: string | null;
  costPriceRaw: string | null;
  costPriceComputed: number | null;
  costFormula: string | null;
  listPricePoints: number | string | null;
  concurrency: string | null;
  notes: string | null;
}

export interface LineMapEntry {
  line: string | null;
  site: string | null;
  code: string | null;
  provider: string | null;
  category: string | null;
  models: string | null;
  discount: string | null;
  schedulerStatus: string | null;
  docNote: string | null;
}

export interface DiversionPricingCache {
  _meta: Record<string, unknown>;
  lineMapping: LineMapEntry[];
  domesticVideo: PriceRow[];
  internationalVideo: PriceRow[];
  imageLines: PriceRow[];
  rawSheets?: Record<string, string[][]>;
}

/** 渠道调度接入状态（用于分流资格）。 */
export type ChannelStatus = 'active' | 'pending' | 'offline' | 'unknown';

const DEFAULT_CACHE_PATH = fileURLToPath(
  new URL('./assets/panqu-newapi-diversion/references/feishu-live-pricing-cache.json', import.meta.url),
);

let _cache: DiversionPricingCache | null = null;
let _cachePath: string | null = null;

// APPEND_MARKER

/** 加载分流定价快照（默认路径，可注入 path 供测试）。fail-closed。 */
export function loadDiversionPricing(path?: string): DiversionPricingCache {
  const target = path ?? DEFAULT_CACHE_PATH;
  if (_cache && _cachePath === target) return _cache;
  let text: string;
  try {
    text = readFileSync(target, 'utf-8');
  } catch (err) {
    throw new Error(
      `分流定价快照缺失，无法进行成本/资格判定 [FEISHU_PRICING_UNAVAILABLE]: ${target} — ` +
        `请先用 scripts 刷新飞书《分流渠道表》快照。原因: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = JSON.parse(text) as DiversionPricingCache;
  if (!Array.isArray(parsed.domesticVideo) || !Array.isArray(parsed.lineMapping)) {
    throw new Error('分流定价快照结构非法 [FEISHU_PRICING_MALFORMED]');
  }
  _cache = parsed;
  _cachePath = target;
  return parsed;
}

/** 测试隔离用：清空模块级缓存。 */
export function __resetPricingCache(): void {
  _cache = null;
  _cachePath = null;
}

/** 归一化分辨率：'720p/无参考视频' | '480P' | '4K' → '720p' | '480p' | '4k'。 */
export function normalizeResolution(res: string | null | undefined): string {
  if (!res) return '';
  const m = String(res).toLowerCase().match(/(\d+\s*k|\d+\s*p|\d+)/);
  if (!m) return '';
  return m[1].replace(/\s+/g, '').replace(/^(\d+)$/, '$1p');
}

/** 归一化模型名：小写去空格，'Seedance 2.0' | 'Seedance2.0' → 'seedance2.0'。 */
export function normalizeModel(model: string | null | undefined): string {
  if (!model) return '';
  return String(model).toLowerCase().replace(/\s+/g, '');
}

/** 定价查询作用域：国内线路(默认) / 国际线路 / 全部。 */
export type PricingScope = 'domestic' | 'international' | 'all';

function scopedRows(cache: DiversionPricingCache, scope: PricingScope = 'domestic'): PriceRow[] {
  if (scope === 'international') return cache.internationalVideo;
  if (scope === 'all') return [...cache.domesticVideo, ...cache.internationalVideo];
  return cache.domesticVideo;
}

/** 该行是否为「有参考视频」计费变体（输入+输出计费，成本不同）。 */
function rowRefVideo(r: PriceRow): boolean {
  return /有参考/.test(r.resolution || '');
}

/**
 * 行匹配：模型 + 分辨率一致。默认只匹配「无参考视频」基准行（refVideo=false），
 * 避免「有参考视频」的低价变体污染成本对比；显式传 refVideo=true 时只匹配有参考行。
 */
function matchRow(r: PriceRow, model: string, resolution: string, refVideo = false): boolean {
  return (
    normalizeModel(r.model) === normalizeModel(model) &&
    normalizeResolution(r.resolution) === normalizeResolution(resolution) &&
    rowRefVideo(r) === refVideo
  );
}

/**
 * 铁律 1：解析某 (模型,分辨率) 的刊例价（积分/秒或每次）。
 * 跨渠道必须唯一，否则抛错（暴露表内不一致，绝不猜）。返回 null 表示表中无此项。
 *
 * ⚠️ 作用域=**视频**：飞书《分流渠道表》图片子表为空（imageLines=0），本函数对图片模型恒返回 null。
 * 运行时刊例价真源是 `pq_absetting`@AB 库（已实测：视频 m78 → 21/46/115 与本表一致；图片 m12 → 10/10/15，
 * 但分辨率是统一整数码表（getPointsFromAbSetting:271-278）：480P=1/720P=768P=2/1080P=3/1K=4/2K=5/4K=6，选取逻辑见 PointsService::getPointsFromAbSetting）。
 * 图片计费请显式传 customPoints（取自运行时 absetting），勿指望本表。详见 channel-cost-discount-catalog.md §五。
 */
export function resolveListPrice(
  cache: DiversionPricingCache,
  q: { model: string; resolution: string; refVideo?: boolean; scope?: PricingScope },
): number | null {
  const vals = new Set<number>();
  for (const r of scopedRows(cache, q.scope)) {
    if (matchRow(r, q.model, q.resolution, q.refVideo) && typeof r.listPricePoints === 'number') {
      vals.add(r.listPricePoints);
    }
  }
  if (vals.size === 0) return null;
  if (vals.size > 1) {
    throw new Error(
      `刊例价跨渠道不一致 [LIST_PRICE_INVARIANT_VIOLATION] ${q.model}@${q.resolution}: {${[...vals].join(', ')}} — 分流不应改变用户扣费，请核对飞书表。`,
    );
  }
  return [...vals][0];
}

function channelMatches(r: PriceRow, channelOrCode: string, cache: DiversionPricingCache): boolean {
  const target = channelOrCode.toLowerCase();
  const ch = (r.channel || '').toLowerCase();
  if (ch.includes(target)) return true;
  // 允许用线路 code（HS/RH-CN/SJB…）或 provider 名匹配
  const entry = cache.lineMapping.find(
    (m) => (m.code || '').toLowerCase() === target || (m.provider || '').toLowerCase() === target,
  );
  if (entry && entry.provider && ch.includes(entry.provider.toLowerCase())) return true;
  return false;
}

/** 解析某渠道对某 (模型,分辨率) 的成本价（¥，已解析折扣公式）。null=表中无此组合。
 * 注意：国际线路(scope='international')成本列为「成本USD」，与国内¥不可直接比较。 */
export function resolveChannelCost(
  cache: DiversionPricingCache,
  q: { model: string; resolution: string; channel: string; refVideo?: boolean; scope?: PricingScope },
): number | null {
  for (const r of scopedRows(cache, q.scope)) {
    if (matchRow(r, q.model, q.resolution, q.refVideo) && channelMatches(r, q.channel, cache) && r.costPriceComputed != null) {
      return r.costPriceComputed;
    }
  }
  return null;
}

/** 线路号 → 线路映射条目（line 可为 '1'..'9' 或 '新增'；code 亦可）。 */
export function lookupLine(cache: DiversionPricingCache, lineOrCode: string | number): LineMapEntry | null {
  const key = String(lineOrCode).toLowerCase();
  return (
    cache.lineMapping.find((m) => String(m.line).toLowerCase() === key || (m.code || '').toLowerCase() === key) ?? null
  );
}

/** 归一化调度接入状态为四态。 */
export function channelStatus(cache: DiversionPricingCache, channelOrCode: string): ChannelStatus {
  const key = channelOrCode.toLowerCase();
  const entry = cache.lineMapping.find(
    (m) =>
      (m.code || '').toLowerCase() === key ||
      (m.provider || '').toLowerCase().includes(key) ||
      key.includes((m.provider || '######').toLowerCase()),
  );
  const s = entry?.schedulerStatus || '';
  if (!s) return 'unknown';
  if (/下线|不上线|暂停/.test(s)) return 'offline';
  if (/待接入|待测试|待分流|接入中/.test(s)) return 'pending';
  if (/已接入/.test(s)) return 'active';
  return 'unknown';
}

/**
 * 铁律 3（粗粒度/业务目录级）：某渠道对某 (模型,分辨率[,能力]) 在**飞书业务表**中是否登记且能力列满足。
 * ⚠️ 这**不是运行时分流资格**。运行时真源是 NewAPI 网关渠道配置（模型×分辨率×**画面比例**×启用），
 * 见 `newapi-route-eligibility.ts` / `references/newapi-eligibility-gate.md`。本函数只用于业务侧圈定候选渠道。
 * 返回 { eligible, reason, status, row }。能力门槛：universalRef/firstLastFrame/realPortrait。
 */
export function isDiversionEligible(
  cache: DiversionPricingCache,
  q: {
    model: string;
    resolution: string;
    channel: string;
    require?: { universalRef?: boolean; firstLastFrame?: boolean; realPortrait?: boolean };
    requireActive?: boolean;
    refVideo?: boolean;
    scope?: PricingScope;
  },
): { eligible: boolean; reason: string; status: ChannelStatus; row: PriceRow | null } {
  const status = channelStatus(cache, q.channel);
  const row =
    scopedRows(cache, q.scope).find((r) => matchRow(r, q.model, q.resolution, q.refVideo) && channelMatches(r, q.channel, cache)) ??
    null;
  if (!row) {
    return { eligible: false, reason: `表中无 ${q.channel} 的 ${q.model}@${q.resolution} 行，不在可分流范围`, status, row: null };
  }
  if (q.requireActive !== false && status === 'offline') {
    return { eligible: false, reason: `渠道 ${q.channel} 已下线/暂停 (status=${status})`, status, row };
  }
  const req = q.require || {};
  if (req.universalRef && !/^是/.test(row.universalRef || '')) {
    return { eligible: false, reason: `不支持全能参考 (universalRef='${row.universalRef}')`, status, row };
  }
  if (req.firstLastFrame && !/^是/.test(row.firstLastFrame || '')) {
    return { eligible: false, reason: `不支持首尾帧 (firstLastFrame='${row.firstLastFrame}')`, status, row };
  }
  if (req.realPortrait && !/^是/.test(row.realPortrait || '')) {
    return { eligible: false, reason: `不支持真人人像 (realPortrait='${row.realPortrait}')`, status, row };
  }
  return { eligible: true, reason: 'OK', status, row };
}

/** 该渠道+模型在表中登记的「可分流分辨率」集合（归一化）。 */
export function eligibleResolutions(
  cache: DiversionPricingCache,
  q: { model: string; channel: string; scope?: PricingScope },
): string[] {
  const set = new Set<string>();
  for (const r of scopedRows(cache, q.scope)) {
    if (normalizeModel(r.model) === normalizeModel(q.model) && channelMatches(r, q.channel, cache)) {
      const nr = normalizeResolution(r.resolution);
      if (nr) set.add(nr);
    }
  }
  return [...set];
}

export interface RankedChannel {
  channel: string;
  cost: number;
  listPricePoints: number | string | null;
  status: ChannelStatus;
  formula: string | null;
}

/**
 * 成本价对比：某 (模型,分辨率) 下所有渠道按成本升序排列。
 * onlyActive=true 时剔除 offline/pending，得到「当前真正可承接的最优成本渠道」。
 */
export function rankChannelsByCost(
  cache: DiversionPricingCache,
  q: { model: string; resolution: string; onlyActive?: boolean; refVideo?: boolean; scope?: PricingScope },
): RankedChannel[] {
  const seen = new Map<string, RankedChannel>();
  for (const r of scopedRows(cache, q.scope)) {
    if (!matchRow(r, q.model, q.resolution, q.refVideo) || r.costPriceComputed == null || !r.channel) continue;
    const status = channelStatus(cache, r.channel);
    if (q.onlyActive && status !== 'active') continue;
    const prev = seen.get(r.channel);
    if (!prev || r.costPriceComputed < prev.cost) {
      seen.set(r.channel, {
        channel: r.channel,
        cost: r.costPriceComputed,
        listPricePoints: r.listPricePoints,
        status,
        formula: r.costFormula,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.cost - b.cost);
}

