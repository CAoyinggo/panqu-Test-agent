/**
 * NewAPI 分流「运行时资格」判定（model × resolution × aspect-ratio × enabled）
 * =============================================================================
 * 纠正：飞书《分流渠道表》是**业务刊例/成本**元数据，**不是运行时资格真源**。
 * 运行时是否分流由 **NewAPI 网关渠道配置**（`apitest.panqu.com/channels` 的「模型与分组」：
 * 每模型 → 允许分辨率(1K/2K/4K…) + 允许画面比例(1:1…4:5)）决定，网关配置由
 * `Channel.php` 同步进本地 `pq_aivideo_diversion_config`(line=10) 的
 * `newapi_route_rules` / `newapi_route_group_rules` JSON，创建任务前由
 * `NewapiDiversionRuleService` / `NewapiImageDiversionService` 前置拦截。
 *
 * 本模块**忠实镜像**该 PHP 门槛，供分流测试对 (模型,分辨率,画面比例,渠道启用) 做断言。
 * 取证来源（已逐行核对，2026-09-24）：
 *  - `application/admin/service/NewapiDiversionRuleService.php`
 *      isModelRoutable :198-232 / isModelRoutableForGroup :246-312 /
 *      matchesImageCapability :361-381 / isImageModelRoutable :322-330 /
 *      isRequestEligible :155-187 / normalizeAspectRatio :486-491 / getRouteMode :62-70
 *  - `application/admin/service/NewapiImageDiversionService.php` check :37-103 / applySnapshot :118-150
 *  - `application/admin/controller/aivideo/Videonew.php` check_diversion :1321-1409
 *
 * 纯函数：规则 JSON 作为入参（测试用 fixture，或从 DB line=10 读入），零 I/O。
 */

/** 归一化画面比例：小写去空格；adaptive/auto → 'auto'；其余原样（对应 PHP normalizeAspectRatio）。 */
export function normalizeAspectRatio(value: string | null | undefined): string {
  const v = String(value ?? '')
    .toLowerCase()
    .trim();
  return v === 'adaptive' || v === 'auto' ? 'auto' : v;
}

function normRes(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .trim();
}

/** 单模型能力（视频）：允许分辨率 + 允许画面比例。 */
export interface VideoCapability {
  resolutions?: unknown[];
  aspect_ratios?: unknown[];
}

/** 单模型能力（图片）：多个启用渠道，每渠道各自的分辨率/画面比例（不并集）。 */
export interface ImageCapability {
  channels?: Array<{ resolutions?: unknown[]; aspect_ratios?: unknown[] }>;
}

/** newapi_route_rules：全局并集规则。 */
export interface RouteRules {
  video?: Record<string, VideoCapability>;
  image?: Record<string, ImageCapability>;
}

/** newapi_route_group_rules：按 newapi_group 分组的规则。 */
export interface GroupedRouteRules {
  video?: Record<string, Record<string, VideoCapability>>;
  image?: Record<string, Record<string, ImageCapability>>;
}

// APPEND_1

/** 视频·全局并集资格（NewapiDiversionRuleService::isModelRoutable :198-232）。规则缺失→false。 */
export function isVideoModelRoutable(
  routeRules: RouteRules | null | undefined,
  q: { modelId: number; resolution: string; aspect: string },
): boolean {
  const video = routeRules?.video;
  if (!video || typeof video !== 'object') return false;
  const cap = video[String(q.modelId)];
  if (!cap || typeof cap !== 'object') return false;
  const resolution = normRes(q.resolution);
  const aspect = normalizeAspectRatio(q.aspect);
  const resolutions = (cap.resolutions ?? []).map((x) => normRes(String(x)));
  const aspects = (cap.aspect_ratios ?? []).map((x) => normalizeAspectRatio(String(x)));
  return resolutions.includes(resolution) && aspects.includes(aspect);
}

/** 视频·按路由组资格（isModelRoutableForGroup :246-312）。group 空 / 规则空 → true（放行兜底）。 */
export function isVideoModelRoutableForGroup(
  groupRules: GroupedRouteRules | null | undefined,
  q: { modelId: number; resolution: string; aspect: string; group: string },
): boolean {
  if (String(q.group ?? '').trim() === '') return true;
  const video = groupRules?.video;
  if (!video || typeof video !== 'object' || Object.keys(video).length === 0) return true;

  const resolution = normRes(q.resolution);
  const aspect = normalizeAspectRatio(q.aspect);
  const accessible = ['default'];
  for (const part of String(q.group).split(',')) {
    const p = part.toLowerCase().trim();
    if (p !== '' && !accessible.includes(p)) accessible.push(p);
  }
  const resolutions: string[] = [];
  const aspects: string[] = [];
  for (const g of accessible) {
    const cap = video[g]?.[String(q.modelId)];
    if (!cap || typeof cap !== 'object') continue;
    for (const r of cap.resolutions ?? []) {
      const rv = normRes(String(r));
      if (rv !== '' && !resolutions.includes(rv)) resolutions.push(rv);
    }
    for (const a of cap.aspect_ratios ?? []) {
      const av = normalizeAspectRatio(String(a));
      if (av !== '' && !aspects.includes(av)) aspects.push(av);
    }
  }
  return resolutions.includes(resolution) && aspects.includes(aspect);
}

/** 图片·单模型能力匹配（matchesImageCapability :361-381）：同一启用渠道须同时支持分辨率+画面比例。 */
export function matchesImageCapability(
  cap: ImageCapability | null | undefined,
  q: { resolution?: string; aspect?: string },
): boolean {
  if (!cap || typeof cap !== 'object') return false;
  const resolution = normRes(q.resolution ?? '2k');
  const aspect = normalizeAspectRatio(q.aspect ?? '1:1');
  for (const ch of cap.channels ?? []) {
    if (!ch || typeof ch !== 'object') continue;
    const resolutions = (ch.resolutions ?? []).map((x) => normRes(String(x)));
    const aspects = (ch.aspect_ratios ?? []).map((x) => normalizeAspectRatio(String(x)));
    if (resolution !== '' && aspect !== '' && resolutions.includes(resolution) && aspects.includes(aspect)) {
      return true;
    }
  }
  return false;
}

/** 图片·全局并集资格（isImageModelRoutable :322-330）。 */
export function isImageModelRoutable(
  routeRules: RouteRules | null | undefined,
  q: { modelId: number; resolution?: string; aspect?: string },
): boolean {
  return matchesImageCapability(routeRules?.image?.[String(q.modelId)], q);
}

/** 图片·按路由组资格（isImageModelRoutableForGroup :340-358）。 */
export function isImageModelRoutableForGroup(
  groupRules: GroupedRouteRules | null | undefined,
  q: { modelId: number; resolution?: string; aspect?: string; group: string },
): boolean {
  const image = groupRules?.image;
  if (!image || typeof image !== 'object') return false;
  const groups = [
    'default',
    ...String(q.group ?? '')
      .toLowerCase()
      .split(','),
  ];
  for (const g of groups) {
    if (matchesImageCapability(image[g.trim()]?.[String(q.modelId)], q)) return true;
  }
  return false;
}

// APPEND_2

/** Seedance 允许参与分流的 task_type（UNIVERSAL 28 / FIRST_LAST_FRAME 29 / LITE_FIRST_LAST_FRAME 51）。 */
export const DEFAULT_ALLOWED_SEEDANCE_TASK_TYPES = [28, 29, 51];
/** 排除分流的模型（seedance-2.0-mini 58 / seedance-2.0-fast 16 走主站）。 */
export const DEFAULT_EXCLUDED_MODEL_IDS = [16, 58];

/** 视频硬性资格（NewapiDiversionRuleService::isRequestEligible :155-187）。isWan3 由调用方判定。 */
export function isVideoRequestEligible(
  q: {
    isWan3: boolean;
    videoType: number;
    selmodelsId: number;
    taskType?: number;
    hasRealHumanPortrait?: boolean;
    cuewordLength?: number;
    outputFormat?: string;
  },
  opts?: { allowedTaskTypes?: number[]; excludedModelIds?: number[] },
): boolean {
  const allowed = opts?.allowedTaskTypes ?? DEFAULT_ALLOWED_SEEDANCE_TASK_TYPES;
  const excluded = opts?.excludedModelIds ?? DEFAULT_EXCLUDED_MODEL_IDS;
  if (!q.isWan3) {
    if (q.videoType !== 6) return false;
    if (excluded.includes(q.selmodelsId)) return false;
    if (q.taskType !== undefined && !allowed.includes(q.taskType)) return false;
  }
  if (q.hasRealHumanPortrait) return false;
  if ((q.cuewordLength ?? 0) > 5000) return false;
  if (
    String(q.outputFormat ?? '')
      .toLowerCase()
      .trim() === 'mov'
  )
    return false;
  return true;
}

export type RouteMode = 'newapi' | 'legacy' | 'off';

export type VideoDiversionDecision =
  | 'OFF'
  | 'LEGACY'
  | 'INELIGIBLE'
  | 'NEWAPI_GLOBAL'
  | 'NEWAPI_ORG_GROUP'
  | 'FALLBACK_NOT_ROUTABLE'
  | 'FALLBACK_NO_ROUTE_GROUP'
  | 'FALLBACK_GROUP_NOT_ROUTABLE'
  | 'CONFIG_ERROR';

export interface VideoDiversionInput {
  routeMode: RouteMode;
  eligible: boolean;
  modelId: number;
  isGlobalModel: boolean;
  alias: string;
  hasGlobalApiKey: boolean;
  resolution: string;
  aspect: string;
  routeGroup?: { newapi_group: string; usable: boolean } | null;
  routeRules?: RouteRules | null;
  groupRules?: GroupedRouteRules | null;
  legacyResult?: number;
}

/**
 * 视频分流决策，忠实镜像 Videonew::check_diversion :1321-1409。
 * 返回 line=10（命中 NewAPI）或 0（直连）；hardError=true 表示 PHP 侧会抛异常中断提交（非静默回退）。
 * 关键：**全量模型跳过分辨率/画面比例校验**（isModelRoutable 只在非全量分支执行）。
 */
export function evaluateVideoDiversion(input: VideoDiversionInput): {
  line: 0 | 10;
  decision: VideoDiversionDecision;
  reason: string;
  hardError?: boolean;
} {
  if (input.routeMode === 'off') return { line: 0, decision: 'OFF', reason: '分流模式=off，全部直连' };
  if (input.routeMode === 'legacy') {
    const line = (input.legacyResult ?? 0) as 0 | 10;
    return { line, decision: 'LEGACY', reason: 'legacy 概率分流（旧线路 2/5/6/7），本模块不判定，取 legacyResult' };
  }
  if (!input.eligible) return { line: 0, decision: 'INELIGIBLE', reason: '未过硬性资格(isRequestEligible)，直连' };

  if (input.isGlobalModel) {
    if (input.alias === '')
      return { line: 0, decision: 'CONFIG_ERROR', reason: '全量模型别名未配置(Ai.php)，提交中断', hardError: true };
    if (!input.hasGlobalApiKey)
      return { line: 0, decision: 'CONFIG_ERROR', reason: '全量模型全局Key未配置，提交中断', hardError: true };
    return { line: 10, decision: 'NEWAPI_GLOBAL', reason: '全量模型→全局Key（跳过分辨率/画面比例校验）' };
  }

  if (!isVideoModelRoutable(input.routeRules, input)) {
    return {
      line: 0,
      decision: 'FALLBACK_NOT_ROUTABLE',
      reason: `模型/分辨率/画面比例不在启用渠道能力并集内 (res=${input.resolution}, aspect=${input.aspect})，回退直连`,
    };
  }
  if (!input.routeGroup)
    return { line: 0, decision: 'FALLBACK_NO_ROUTE_GROUP', reason: '未解析到企业路由组，回退直连' };
  if (!input.routeGroup.usable)
    return { line: 0, decision: 'CONFIG_ERROR', reason: '路由组停用/缺Key，提交中断', hardError: true };
  if (input.alias === '')
    return { line: 0, decision: 'CONFIG_ERROR', reason: '分组模型别名未配置，提交中断', hardError: true };
  if (!isVideoModelRoutableForGroup(input.groupRules, { ...input, group: input.routeGroup.newapi_group })) {
    return {
      line: 0,
      decision: 'FALLBACK_GROUP_NOT_ROUTABLE',
      reason: `路由组分组[${input.routeGroup.newapi_group}]内无该模型/分辨率/画面比例渠道，回退直连`,
    };
  }
  return { line: 10, decision: 'NEWAPI_ORG_GROUP', reason: `命中企业路由组[${input.routeGroup.newapi_group}]` };
}

// APPEND_3

export type ImageModelClass = 'normal' | 'image2_lowcost' | 'image25' | 'mj_v82';

export type ImageDiversionDecision =
  | 'NEWAPI_IMAGE_GLOBAL'
  | 'NEWAPI_IMAGE_ORG_GROUP'
  | 'NEWAPI_IMAGE25_GLOBAL'
  | 'NEWAPI_MJ_V82'
  | 'IMAGE25_NO_CHANNEL'
  | 'FALLBACK_IMAGE2_LOWCOST_PAUSED'
  | 'FALLBACK_NO_ALIAS'
  | 'FALLBACK_SERVICELINE'
  | 'FALLBACK_PIXELS'
  | 'FALLBACK_REF_LIMIT'
  | 'FALLBACK_NOT_ROUTABLE'
  | 'FALLBACK_NO_GLOBAL_KEY'
  | 'FALLBACK_NO_ROUTE_GROUP'
  | 'FALLBACK_GROUP_UNUSABLE'
  | 'FALLBACK_GROUP_NOT_ROUTABLE';

export interface ImageDiversionInput {
  selmodelsId: number;
  modelClass?: ImageModelClass;
  isGlobalModel: boolean;
  alias: string;
  hasGlobalApiKey: boolean;
  serviceline: string;
  sizeType?: string;
  refImageCount?: number;
  resolution?: string;
  aspect?: string;
  routeGroup?: { newapi_group: string; usable: boolean } | null;
  routeRules?: RouteRules | null;
  groupRules?: GroupedRouteRules | null;
}

/**
 * 图片分流决策，忠实镜像 NewapiImageDiversionService::check :37-103 + applySnapshot :118-150。
 * 关键差异（对比视频）：**图片全量模型仍校验分辨率/画面比例**（isImageModelRoutable 在全量分支之前执行）；
 * 分组不可用是**静默回退**（返回 null），非异常；Image2.5 无渠道时抛用户错误(hardError)；MJ v8.2 无条件分流。
 */
export function evaluateImageDiversion(input: ImageDiversionInput): {
  diverted: boolean;
  decision: ImageDiversionDecision;
  reason: string;
  hardError?: boolean;
} {
  const cls = input.modelClass ?? 'normal';
  const imgQ = { modelId: input.selmodelsId, resolution: input.resolution, aspect: input.aspect };

  // applySnapshot 首段：Image2.5 / MJ v8.2 特判
  if (cls === 'image25') {
    if (input.alias === '' || !input.hasGlobalApiKey || !isImageModelRoutable(input.routeRules, imgQ)) {
      return {
        diverted: false,
        decision: 'IMAGE25_NO_CHANNEL',
        reason: '所选分辨率/画幅暂无可用图片渠道（抛用户错误，提交中断）',
        hardError: true,
      };
    }
    return {
      diverted: true,
      decision: 'NEWAPI_IMAGE25_GLOBAL',
      reason: 'Image2.5→全局NewAPI（已校验分辨率/画面比例）',
    };
  }
  if (cls === 'mj_v82') {
    return { diverted: true, decision: 'NEWAPI_MJ_V82', reason: 'MJ v8.2 固定路由，无分辨率/画面比例校验' };
  }

  // check()：静默回退型资格
  if (cls === 'image2_lowcost')
    return {
      diverted: false,
      decision: 'FALLBACK_IMAGE2_LOWCOST_PAUSED',
      reason: 'Image2低价版(57)暂停分流，回退原渠道',
    };
  if (input.alias === '')
    return { diverted: false, decision: 'FALLBACK_NO_ALIAS', reason: '模型别名留空=不分流，回退原渠道' };
  if (String(input.serviceline).toLowerCase().trim() !== 'r')
    return {
      diverted: false,
      decision: 'FALLBACK_SERVICELINE',
      reason: `serviceline≠r (=${input.serviceline})，回退原渠道`,
    };
  if (
    String(input.sizeType ?? 'resolution')
      .toLowerCase()
      .trim() === 'pixels'
  )
    return { diverted: false, decision: 'FALLBACK_PIXELS', reason: 'size_type=pixels(自定义像素)，回退原渠道' };
  if ((input.refImageCount ?? 0) > 10)
    return { diverted: false, decision: 'FALLBACK_REF_LIMIT', reason: `参考图>${10}，回退原渠道` };

  if (!isImageModelRoutable(input.routeRules, imgQ)) {
    return {
      diverted: false,
      decision: 'FALLBACK_NOT_ROUTABLE',
      reason: `无启用渠道同时支持 res=${input.resolution ?? '2k'}/aspect=${input.aspect ?? '1:1'}，回退原渠道`,
    };
  }
  if (input.isGlobalModel) {
    if (!input.hasGlobalApiKey)
      return { diverted: false, decision: 'FALLBACK_NO_GLOBAL_KEY', reason: '全量图片模型全局Key未配置，回退原渠道' };
    return { diverted: true, decision: 'NEWAPI_IMAGE_GLOBAL', reason: '全量图片模型→全局Key' };
  }
  if (!input.routeGroup)
    return { diverted: false, decision: 'FALLBACK_NO_ROUTE_GROUP', reason: '未解析到企业路由组，回退原渠道' };
  if (!input.routeGroup.usable)
    return { diverted: false, decision: 'FALLBACK_GROUP_UNUSABLE', reason: '路由组停用/缺Key，回退原渠道' };
  if (!isImageModelRoutableForGroup(input.groupRules, { ...imgQ, group: input.routeGroup.newapi_group })) {
    return {
      diverted: false,
      decision: 'FALLBACK_GROUP_NOT_ROUTABLE',
      reason: `路由组分组[${input.routeGroup.newapi_group}]内无该图片模型渠道，回退原渠道`,
    };
  }
  return {
    diverted: true,
    decision: 'NEWAPI_IMAGE_ORG_GROUP',
    reason: `命中企业路由组[${input.routeGroup.newapi_group}]`,
  };
}
