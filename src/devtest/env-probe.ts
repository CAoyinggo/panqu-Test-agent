/**
 * Panqu 真实测试环境只读探针与连通性巡检 (Environment Probe)
 *
 * 核心能力：
 * 1. 只读探测主站 test/preonline 环境连通性与响应耗时
 * 2. 校验 Session/Cookie 凭据有效性与 CSRF 存活性
 * 3. 探活核心业务端点状态（视频、图片、网关接口）
 * 4. 针对指定模型推导分流配置完备度与可用渠道
 * 5. 输出结构化健康状态与开发者排障建议（零副作用，不产生写入与扣费）
 */

import { readFile } from 'node:fs/promises';
import { RoutingOracle, type GatewayChannelConfig, type MainSiteConfigSnapshot } from './routing.js';
import type { ChangeScenario, DiscoveredModelContract, DiscoveredFact, FactSource } from './types.js';

export function createDiscoveredFact<T>(
  value: T,
  source: FactSource,
  options?: { details?: string; warning?: string },
): DiscoveredFact<T> {
  const isTrusted = source === 'SOURCE_API' || source === 'SOURCE_INPUT' || source === 'SOURCE_STATIC_CONTRACT';
  return {
    value,
    source,
    determined: isTrusted,
    allowPass: isTrusted,
    details: options?.details,
    warning: options?.warning,
  };
}

export interface EnvProbeOptions {
  env?: 'test' | 'preonline' | string;
  baseUrl?: string;
  gatewayUrl?: string;
  sessionFile?: string;
  modelId?: number;
  mediaType?: 'video' | 'image';
  userGroupIds?: number[];
  mock?: boolean;
  timeoutMs?: number;
  scenario?: ChangeScenario;
  changeType?: 'new_model' | 'diversion_change';
  flowType?: 'direct' | 'diversion' | string;
  resolution?: string;
  duration?: number;
  aspectRatio?: string;
  pointsPerSecond?: number;
  customPoints?: number;
  price?: number;
  alias?: string;
  isGlobal?: boolean;
  supportedResolutions?: string[];
  supportedAspectRatios?: string[];
  maxRefImages?: number;
  mainConfig?: Partial<MainSiteConfigSnapshot>;
  channels?: GatewayChannelConfig[];
  requirement?: string;
}

export interface EndpointProbeResult {
  name: string;
  url: string;
  method: 'GET' | 'HEAD' | 'OPTIONS';
  reachable: boolean;
  statusCode?: number;
  latencyMs?: number;
  message: string;
}

export interface ModelReadinessVerdict {
  modelId: number;
  mediaType: 'video' | 'image';
  decision: 'DIVERTED' | 'DIRECT' | 'UNKNOWN';
  willDivert: boolean;
  routeLine: number;
  newapiModel?: string;
  candidateChannelCount: number;
  isBlockedByQuota: boolean;
  issues: string[];
}

export interface EnvProbeReport {
  ok: boolean;
  status: 'HEALTHY' | 'DEGRADED' | 'BLOCKED';
  env: string;
  baseUrl: string;
  gatewayUrl: string;
  probedAt: string;
  auth: {
    status: 'VALID' | 'EXPIRED' | 'MISSING';
    details: string;
    hasSession: boolean;
  };
  endpoints: EndpointProbeResult[];
  modelReadiness?: ModelReadinessVerdict;
  discoveredContract?: DiscoveredModelContract;
  recommendations: string[];
}

export interface StaticModelInfo {
  alias: string;
  isGlobal: boolean;
  resolutions: string[];
  aspectRatios: string[];
  durations?: number[];
  supportsReferenceVideo?: boolean;
  supportsFirstLastFrame?: boolean;
  serviceline?: string;
  maxRefImages?: number;
  pricingPerSecond?: number;
  fixedPrice?: number;
  hasFallback?: boolean;
}

export const STATIC_MODELS: Record<'video' | 'image', Record<number, StaticModelInfo>> = {
  video: {
    84: {
      alias: 'wan3.0-video',
      isGlobal: true,
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'],
      durations: [4, 5],
      supportsReferenceVideo: true,
      supportsFirstLastFrame: true,
      pricingPerSecond: 14,
      hasFallback: false,
    },
    88: {
      alias: 'wan3.0-video-prime',
      isGlobal: true,
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'],
      durations: [4, 5],
      supportsReferenceVideo: true,
      supportsFirstLastFrame: true,
      pricingPerSecond: 22,
      hasFallback: false,
    },
    15: {
      alias: 'seedance-2.0',
      isGlobal: false,
      resolutions: ['480p', '720p', '1080p', '4k'],
      aspectRatios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'],
      durations: [3, 4, 5],
      supportsReferenceVideo: false,
      supportsFirstLastFrame: true,
      pricingPerSecond: 25,
      hasFallback: true,
    },
    78: {
      alias: 'seedance-2.5',
      isGlobal: false,
      resolutions: ['480p', '720p', '1080p', '4k'],
      aspectRatios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'],
      durations: [3, 4, 5],
      supportsReferenceVideo: false,
      supportsFirstLastFrame: true,
      pricingPerSecond: 28,
      hasFallback: true,
    },
  },
  image: {
    205: {
      alias: 'gpt-image-2.5',
      isGlobal: false,
      resolutions: ['1k', '2k', '4k'],
      aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '5:4', '4:5'],
      serviceline: 'r',
      maxRefImages: 10,
    },
    12: {
      alias: 'pan-banana-pro',
      isGlobal: true,
      resolutions: ['1k', '2k', '4k'],
      aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '5:4', '4:5'],
      serviceline: 'r',
      maxRefImages: 10,
    },
    201: {
      alias: 'runninghub-nano-banana-2',
      isGlobal: false,
      resolutions: ['1k', '2k', '4k'],
      aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
      serviceline: 'r',
      maxRefImages: 10,
      fixedPrice: 5,
    },
  },
};

export interface ParsedChangeIntent {
  modelId?: number;
  mediaType?: 'video' | 'image';
  changeType?: 'new_model' | 'diversion_change';
  scenario?: ChangeScenario;
  price?: number;
  customPoints?: number;
  pointsPerSecond?: number;
  isGlobal?: boolean;
  alias?: string;
  raw: string;
}

export function parseChangeIntent(input: string): ParsedChangeIntent {
  const text = (input || '').trim();
  let mediaType: 'video' | 'image' | undefined;
  if (/视频|video/i.test(text)) {
    mediaType = 'video';
  } else if (/图片|生图|image/i.test(text)) {
    mediaType = 'image';
  }

  let modelId: number | undefined;
  const modelMatch =
    text.match(/(?:模型|model|#)\s*(\d{2,5})/i) ||
    text.match(/(\d{2,5})\s*(?:模型|model)/i) ||
    text.match(/\b(\d{2,5})\b/);
  if (modelMatch) {
    modelId = Number(modelMatch[1]);
  }

  // If mediaType was not explicitly stated in text, infer from known static models
  if (!mediaType && modelId !== undefined) {
    if (STATIC_MODELS.video[modelId]) {
      mediaType = 'video';
    } else if (STATIC_MODELS.image[modelId]) {
      mediaType = 'image';
    }
  }

  let changeType: 'new_model' | 'diversion_change' | undefined;
  if (/分流|切到|切流|newapi|diversion/i.test(text)) {
    changeType = 'diversion_change';
  } else if (/新增|接入|上线|新模型|direct|new/i.test(text)) {
    changeType = 'new_model';
  }

  let isGlobal: boolean | undefined;
  if (/--is-global|--global|全量/i.test(text)) {
    isGlobal = true;
  }

  let price: number | undefined;
  let customPoints: number | undefined;
  let pointsPerSecond: number | undefined;

  const ppsMatch =
    text.match(/(?:--points-per-second|每秒|每秒积分|pt\/s)\s*[:=]?\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/(\d+(?:\.\d+)?)\s*(?:积分每秒|pt\/s|分每秒)/i);
  if (ppsMatch) {
    pointsPerSecond = Number(ppsMatch[1]);
    price = pointsPerSecond;
  }

  const priceMatch =
    text.match(/(?:--price|--custom-points|单价|积分|pt)\s*[:=]?\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/(?:单价|价格)\s*[:=]?\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/(\d+(?:\.\d+)?)\s*(?:积分|pt)\b/i);
  if (priceMatch && !ppsMatch) {
    const val = Number(priceMatch[1]);
    price = val;
    if (mediaType === 'video') {
      pointsPerSecond = val;
    } else {
      customPoints = val;
    }
  } else if (ppsMatch && mediaType === 'video') {
    pointsPerSecond = price;
  }

  if (price !== undefined && customPoints === undefined && mediaType === 'image') {
    customPoints = price;
  }

  let scenario: ChangeScenario | undefined;
  if (mediaType && (changeType || modelId !== undefined)) {
    const isDiversion =
      changeType === 'diversion_change' ||
      (changeType === undefined &&
        modelId !== undefined &&
        (STATIC_MODELS.video[modelId] !== undefined || STATIC_MODELS.image[modelId] !== undefined));
    if (mediaType === 'image') {
      scenario = isDiversion ? 'IMAGE_DIVERSION_CHANGE' : 'IMAGE_NEW_MODEL';
    } else {
      scenario = isDiversion ? 'VIDEO_DIVERSION_CHANGE' : 'VIDEO_NEW_MODEL';
    }
  }

  if (!changeType && scenario) {
    changeType = scenario.endsWith('DIVERSION_CHANGE') ? 'diversion_change' : 'new_model';
  }

  return {
    modelId,
    mediaType,
    changeType,
    scenario,
    price,
    customPoints,
    pointsPerSecond,
    isGlobal,
    raw: input,
  };
}

export function identifyChangeScenario(
  mediaType: 'video' | 'image',
  modelId: number,
  options: {
    scenario?: ChangeScenario;
    changeType?: 'new_model' | 'diversion_change';
    flowType?: 'direct' | 'diversion' | string;
    requirement?: string;
  } = {},
): ChangeScenario {
  if (options.scenario) return options.scenario;
  let isDiversion: boolean;
  if (options.changeType === 'diversion_change' || options.flowType === 'diversion') {
    isDiversion = true;
  } else if (options.changeType === 'new_model' || options.flowType === 'direct') {
    isDiversion = false;
  } else if (options.requirement) {
    const parsed = parseChangeIntent(options.requirement);
    if (parsed.changeType === 'diversion_change') {
      isDiversion = true;
    } else if (parsed.changeType === 'new_model') {
      isDiversion = false;
    } else {
      isDiversion = Boolean(STATIC_MODELS[mediaType]?.[modelId]);
    }
  } else {
    isDiversion = Boolean(STATIC_MODELS[mediaType]?.[modelId]);
  }

  if (mediaType === 'image') {
    return isDiversion ? 'IMAGE_DIVERSION_CHANGE' : 'IMAGE_NEW_MODEL';
  }
  return isDiversion ? 'VIDEO_DIVERSION_CHANGE' : 'VIDEO_NEW_MODEL';
}

export function discoverModelContract(
  modelId: number,
  mediaType: 'video' | 'image',
  options: EnvProbeOptions = {},
): DiscoveredModelContract {
  const scenario = identifyChangeScenario(mediaType, modelId, options);
  const staticInfo = STATIC_MODELS[mediaType]?.[modelId];
  const conflicts: Array<{ field: string; message: string; apiValue?: unknown; staticValue?: unknown }> = [];
  const manualRequiredItems: Array<{ field: string; reason: string; requiredAction: string }> = [];

  // 1. Alias
  let alias: DiscoveredFact<string>;
  if (options.alias) {
    if (staticInfo && staticInfo.alias !== options.alias) {
      conflicts.push({
        field: 'alias',
        message: `显式输入 alias=${options.alias} 与静态已知别名 ${staticInfo.alias} 冲突 [CONFIG_MISMATCH]`,
        apiValue: options.alias,
        staticValue: staticInfo.alias,
      });
    }
    alias = createDiscoveredFact(options.alias, 'SOURCE_INPUT');
  } else if (options.mainConfig?.modelAliases?.[modelId]) {
    const inputAlias = options.mainConfig.modelAliases[modelId];
    if (staticInfo && staticInfo.alias !== inputAlias) {
      conflicts.push({
        field: 'alias',
        message: `配置输入 alias=${inputAlias} 与静态已知别名 ${staticInfo.alias} 冲突 [CONFIG_MISMATCH]`,
        apiValue: inputAlias,
        staticValue: staticInfo.alias,
      });
    }
    alias = createDiscoveredFact(inputAlias, 'SOURCE_INPUT');
  } else if (staticInfo) {
    alias = createDiscoveredFact(staticInfo.alias, 'SOURCE_STATIC_CONTRACT');
  } else {
    const fallbackAlias = mediaType === 'video' ? `new-video-model-${modelId}` : `new-image-model-${modelId}`;
    alias = createDiscoveredFact(fallbackAlias, 'SOURCE_DEFAULT_FALLBACK', {
      warning: `模型 #${modelId} 别名未在系统登记，需人工确认与 NewAPI 渠道别名保持一致`,
    });
    manualRequiredItems.push({
      field: 'alias',
      reason: `未知模型 #${modelId} 的 NewAPI 映射别名缺失`,
      requiredAction: '请通过 --alias 或在配置中传入真实别名',
    });
  }

  // 2. isGlobal
  let isGlobal: DiscoveredFact<boolean>;
  if (options.isGlobal !== undefined) {
    if (staticInfo && staticInfo.isGlobal !== options.isGlobal) {
      conflicts.push({
        field: 'isGlobal',
        message: `显式输入 isGlobal=${options.isGlobal} 与静态已知值 ${staticInfo.isGlobal} 冲突 [CONFIG_MISMATCH]`,
        apiValue: options.isGlobal,
        staticValue: staticInfo.isGlobal,
      });
    }
    isGlobal = createDiscoveredFact(options.isGlobal, 'SOURCE_INPUT');
  } else if (options.mainConfig?.globalModelIds) {
    const fromConfig = options.mainConfig.globalModelIds.includes(modelId);
    isGlobal = createDiscoveredFact(fromConfig, 'SOURCE_INPUT');
  } else if (staticInfo) {
    isGlobal = createDiscoveredFact(staticInfo.isGlobal, 'SOURCE_STATIC_CONTRACT');
  } else {
    isGlobal = createDiscoveredFact(false, 'SOURCE_DEFAULT_FALLBACK', {
      details: '未知模型默认非全量开放，需验证组织路由组',
    });
  }

  // 3. Supported resolutions
  let supportedResolutions: DiscoveredFact<string[]>;
  const inputResolutions = options.supportedResolutions
    || (mediaType === 'video'
        ? options.mainConfig?.globalRouteRules?.video?.[modelId]?.resolutions
        : options.mainConfig?.globalRouteRules?.image?.[modelId]?.resolutions);
  if (inputResolutions && inputResolutions.length > 0) {
    supportedResolutions = createDiscoveredFact(inputResolutions, 'SOURCE_INPUT');
  } else if (staticInfo) {
    supportedResolutions = createDiscoveredFact(staticInfo.resolutions, 'SOURCE_STATIC_CONTRACT');
  } else if (options.resolution) {
    supportedResolutions = createDiscoveredFact([options.resolution], 'SOURCE_INPUT');
  } else {
    const defaultRes = mediaType === 'video' ? ['720p'] : ['1k'];
    supportedResolutions = createDiscoveredFact(defaultRes, 'MANUAL_REQUIRED', {
      warning: '无法获取模型完整分辨率支持列表，临时基于默认规格测试，需人工确认能力矩阵',
    });
    manualRequiredItems.push({
      field: 'supportedResolutions',
      reason: `未知模型 #${modelId} 支持的分辨率列表缺失`,
      requiredAction: '请通过 --resolution 显式指定或补充能力规则',
    });
  }

  // 4. Supported aspect ratios
  let supportedAspectRatios: DiscoveredFact<string[]>;
  const inputAspectRatios = options.supportedAspectRatios
    || (mediaType === 'video'
        ? options.mainConfig?.globalRouteRules?.video?.[modelId]?.aspect_ratios
        : options.mainConfig?.globalRouteRules?.image?.[modelId]?.aspect_ratios);
  if (inputAspectRatios && inputAspectRatios.length > 0) {
    supportedAspectRatios = createDiscoveredFact(inputAspectRatios, 'SOURCE_INPUT');
  } else if (staticInfo) {
    supportedAspectRatios = createDiscoveredFact(staticInfo.aspectRatios, 'SOURCE_STATIC_CONTRACT');
  } else if (options.aspectRatio) {
    supportedAspectRatios = createDiscoveredFact([options.aspectRatio], 'SOURCE_INPUT');
  } else {
    const defaultAsp = mediaType === 'video' ? ['16:9'] : ['1:1'];
    supportedAspectRatios = createDiscoveredFact(defaultAsp, 'SOURCE_DEFAULT_FALLBACK', {
      details: '未知模型画幅使用默认比例',
    });
  }

  // 5. Pricing
  const intentPrice = options.requirement ? parseChangeIntent(options.requirement) : undefined;
  const explicitCustomPoints = options.customPoints !== undefined
    ? options.customPoints
    : (mediaType === 'image' && options.price !== undefined ? options.price : intentPrice?.customPoints);
  const explicitPointsPerSecond = options.pointsPerSecond !== undefined
    ? options.pointsPerSecond
    : (mediaType === 'video' && options.price !== undefined ? options.price : intentPrice?.pointsPerSecond);

  let pricing: DiscoveredModelContract['pricing'];
  if (explicitCustomPoints !== undefined) {
    pricing = {
      customPoints: createDiscoveredFact(explicitCustomPoints, 'SOURCE_INPUT'),
      isPricingDetermined: true,
      allowPass: true,
      source: 'SOURCE_INPUT',
    };
  } else if (explicitPointsPerSecond !== undefined) {
    pricing = {
      pointsPerSecond: createDiscoveredFact(explicitPointsPerSecond, 'SOURCE_INPUT'),
      isPricingDetermined: true,
      allowPass: true,
      source: 'SOURCE_INPUT',
    };
  } else if (staticInfo?.pricingPerSecond !== undefined) {
    pricing = {
      pointsPerSecond: createDiscoveredFact(staticInfo.pricingPerSecond, 'SOURCE_STATIC_CONTRACT'),
      isPricingDetermined: true,
      allowPass: true,
      source: 'SOURCE_STATIC_CONTRACT',
    };
  } else if (staticInfo?.fixedPrice !== undefined) {
    pricing = {
      customPoints: createDiscoveredFact(staticInfo.fixedPrice, 'SOURCE_STATIC_CONTRACT'),
      isPricingDetermined: true,
      allowPass: true,
      source: 'SOURCE_STATIC_CONTRACT',
    };
  } else if (modelId === 205) {
    const res = (options.resolution || '1k').toLowerCase();
    const pts = res.includes('2k') || res.includes('flare') || res.includes('hd') || res.includes('4k') ? 15 : 10;
    pricing = {
      customPoints: createDiscoveredFact(pts, 'SOURCE_STATIC_CONTRACT'),
      isPricingDetermined: true,
      allowPass: true,
      source: 'SOURCE_STATIC_CONTRACT',
    };
  } else if (modelId === 12) {
    const res = (options.resolution || '1k').toLowerCase();
    const pts = res.includes('4k') ? 15 : res.includes('2k') ? 10 : 5;
    pricing = {
      customPoints: createDiscoveredFact(pts, 'SOURCE_STATIC_CONTRACT'),
      isPricingDetermined: true,
      allowPass: true,
      source: 'SOURCE_STATIC_CONTRACT',
    };
  } else {
    pricing = {
      isPricingDetermined: false,
      allowPass: false,
      source: 'MANUAL_REQUIRED',
    };
    manualRequiredItems.push({
      field: 'pricing',
      reason: `未发现模型 #${modelId} 真实刊例单价，无法执行防资损流水对账`,
      requiredAction: '必须通过 --points-per-second 或 --price 显式提供真实单价，否则账务验证将被阻断',
    });
  }

  // 6. Org bindings
  let orgBindings: DiscoveredFact<Record<number, { routeGroupId: number; newapiGroup: string; status: number }>> | undefined;
  if (options.mainConfig?.orgBindings) {
    const raw = options.mainConfig.orgBindings;
    const mapped: Record<number, { routeGroupId: number; newapiGroup: string; status: number }> = {};
    for (const [k, v] of Object.entries(raw)) {
      mapped[Number(k)] = { routeGroupId: v.routeGroupId, newapiGroup: v.newapiGroup, status: v.status };
    }
    orgBindings = createDiscoveredFact(mapped, 'SOURCE_INPUT');
  } else if (options.userGroupIds && options.userGroupIds.length > 0) {
    const mapped: Record<number, { routeGroupId: number; newapiGroup: string; status: number }> = {};
    for (const gid of options.userGroupIds) {
      mapped[gid] = { routeGroupId: 1, newapiGroup: 'panqu_test', status: 1 };
    }
    orgBindings = createDiscoveredFact(mapped, 'SOURCE_INPUT');
  } else {
    orgBindings = createDiscoveredFact(
      { 10: { routeGroupId: 1, newapiGroup: 'panqu_test', status: 1 } },
      'SOURCE_STATIC_CONTRACT',
      { details: '默认使用组织 10 (panqu_test 组)' },
    );
  }

  // 7. Video specifics
  let supportedDurations: DiscoveredFact<number[]> | undefined;
  let supportsReferenceVideo: DiscoveredFact<boolean> | undefined;
  let supportsFirstLastFrame: DiscoveredFact<boolean> | undefined;
  if (mediaType === 'video') {
    if (staticInfo?.durations) {
      supportedDurations = createDiscoveredFact(staticInfo.durations, 'SOURCE_STATIC_CONTRACT');
    } else if (options.duration) {
      supportedDurations = createDiscoveredFact([options.duration], 'SOURCE_INPUT');
    } else {
      supportedDurations = createDiscoveredFact([4, 5], 'SOURCE_DEFAULT_FALLBACK');
    }

    supportsReferenceVideo = createDiscoveredFact(
      staticInfo?.supportsReferenceVideo ?? false,
      staticInfo ? 'SOURCE_STATIC_CONTRACT' : 'SOURCE_DEFAULT_FALLBACK',
    );
    supportsFirstLastFrame = createDiscoveredFact(
      staticInfo?.supportsFirstLastFrame ?? true,
      staticInfo ? 'SOURCE_STATIC_CONTRACT' : 'SOURCE_DEFAULT_FALLBACK',
    );
  }

  // 8. Image specifics
  let serviceline: DiscoveredFact<string> | undefined;
  let maxRefImages: DiscoveredFact<number> | undefined;
  if (mediaType === 'image') {
    serviceline = createDiscoveredFact(
      staticInfo?.serviceline ?? 'r',
      staticInfo ? 'SOURCE_STATIC_CONTRACT' : 'SOURCE_DEFAULT_FALLBACK',
    );
    const inputMaxRef = options.maxRefImages !== undefined
      ? options.maxRefImages
      : options.mainConfig?.globalRouteRules?.image?.[modelId]?.max_ref_images;
    if (inputMaxRef !== undefined) {
      maxRefImages = createDiscoveredFact(inputMaxRef, 'SOURCE_INPUT');
    } else {
      maxRefImages = createDiscoveredFact(
        staticInfo?.maxRefImages ?? (modelId === 201 || modelId === 205 || modelId === 12 ? 10 : 0),
        staticInfo ? 'SOURCE_STATIC_CONTRACT' : 'SOURCE_DEFAULT_FALLBACK',
      );
    }
  }

  // 9. Capabilities bundle
  const capabilities = {
    resolutions: supportedResolutions,
    aspectRatios: supportedAspectRatios,
    durations: supportedDurations,
    supportsReferenceVideo,
    supportsFirstLastFrame,
    maxRefImages,
  };

  // 10. Routing Fact
  let routing: DiscoveredModelContract['routing'];
  if (options.flowType === 'direct') {
    routing = createDiscoveredFact(
      { routeLine: 0, willDivert: false, decision: 'FALLBACK_DIRECT', isGlobal: false },
      'SOURCE_INPUT',
    );
  } else if (isGlobal.value) {
    routing = createDiscoveredFact(
      { routeLine: 10, willDivert: true, decision: 'NEWAPI_GLOBAL', isGlobal: true },
      isGlobal.source,
    );
  } else {
    routing = createDiscoveredFact(
      {
        routeLine: 10,
        willDivert: true,
        decision: mediaType === 'video' ? 'NEWAPI_ORG_GROUP' : 'NEWAPI_IMAGE',
        isGlobal: false,
        group: 'panqu_test',
      },
      staticInfo ? 'SOURCE_STATIC_CONTRACT' : 'SOURCE_DEFAULT_FALLBACK',
    );
  }

  // 11. Fallback Fact
  let fallback: DiscoveredModelContract['fallback'];
  if ([15, 78].includes(modelId)) {
    fallback = createDiscoveredFact(
      { hasPolicy: true, action: 'VOLCENGINE_RETRY_QUEUE' as const },
      'SOURCE_STATIC_CONTRACT',
      { details: 'Seedance 模型分流失败派发火山重试队列' },
    );
  } else if ([84, 88].includes(modelId)) {
    fallback = createDiscoveredFact(
      { hasPolicy: true, action: 'DIRECT_FAIL_NO_RETRY' as const },
      'SOURCE_STATIC_CONTRACT',
      { details: '非 Seedance 模型分流失败直接报错中断' },
    );
  } else {
    fallback = createDiscoveredFact(
      { hasPolicy: false, action: 'NONE' as const },
      'SOURCE_DEFAULT_FALLBACK',
      { details: '未知模型无特殊容灾策略' },
    );
  }

  return {
    modelId,
    mediaType,
    scenario,
    alias,
    isGlobal,
    capabilities,
    supportedResolutions,
    supportedAspectRatios,
    supportedDurations,
    supportsReferenceVideo,
    supportsFirstLastFrame,
    serviceline,
    maxRefImages,
    routing,
    pricing,
    fallback,
    orgBindings,
    conflicts,
    manualRequiredItems,
  };
}

export class EnvironmentProbe {
  public static async probe(options: EnvProbeOptions = {}): Promise<EnvProbeReport> {
    const env = options.env || 'test';
    const baseUrl = options.baseUrl || (env === 'preonline' ? 'https://preonline.panqu.com' : 'https://test.panqu.com');
    const gatewayUrl = options.gatewayUrl || 'https://aiapis.panqu.com';
    const timeoutMs = options.timeoutMs ?? 5000;
    const isMock = options.mock ?? true;

    if (!isMock) {
      const allowedEnvironments = new Set(['test', 'preonline', 'sandbox', 'local']);
      if (!allowedEnvironments.has(env)) throw new Error(`REAL_ENV_NOT_ALLOWED: ${env}`);
      if (env === 'local') {
        const localHosts = new Set(['127.0.0.1', 'localhost']);
        this.assertAllowedRealUrl(baseUrl, localHosts, true);
        this.assertAllowedRealUrl(gatewayUrl, new Set([...localHosts, 'aiapis.panqu.com']), true);
      } else {
        this.assertAllowedRealUrl(baseUrl, new Set(['test.panqu.com', 'preonline.panqu.com', 'sandbox.panqu.com']));
        this.assertAllowedRealUrl(gatewayUrl, new Set(['aiapis.panqu.com', 'test-aiapis.panqu.com', 'preonline-aiapis.panqu.com', 'sandbox-aiapis.panqu.com']));
      }
    }

    let cookie = '';
    if (options.sessionFile) {
      try {
        const raw = await readFile(options.sessionFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.cookie_string === 'string') cookie = parsed.cookie_string;
        else if (Array.isArray(parsed.sessions)) {
          const session = parsed.sessions.find((item: { env?: string }) => item.env === env);
          if (typeof session?.cookie_string === 'string') cookie = session.cookie_string;
        }
        else if (Array.isArray(parsed.cookies)) {
          cookie = parsed.cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
        }
      } catch {
        // session file missing or unreadable
      }
    }

    if (isMock) {
      return this.generateMockReport(env, baseUrl, gatewayUrl, cookie, options);
    }

    return this.executeRealProbe(env, baseUrl, gatewayUrl, cookie, options, timeoutMs);
  }

  private static assertAllowedRealUrl(value: string, allowedHosts: Set<string>, allowHttp = false): void {
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new Error(`REAL_URL_NOT_ALLOWED: ${value}`); }
    const validProtocol = allowHttp ? (parsed.protocol === 'https:' || parsed.protocol === 'http:') : parsed.protocol === 'https:';
    if (!validProtocol || parsed.username || parsed.password || (!allowHttp && parsed.port) || !allowedHosts.has(parsed.hostname)) {
      throw new Error(`REAL_URL_NOT_ALLOWED: ${value}`);
    }
  }

  private static generateMockReport(
    env: string,
    baseUrl: string,
    gatewayUrl: string,
    cookie: string,
    options: EnvProbeOptions,
  ): EnvProbeReport {
    const hasSession = Boolean(cookie && cookie.trim().length > 0);
    const endpoints: EndpointProbeResult[] = [
      {
        name: '主站入口与网关握手',
        url: `${baseUrl}/`,
        method: 'GET',
        reachable: true,
        statusCode: 200,
        latencyMs: 42,
        message: '主站连接正常，HTTP 200 OK',
      },
      {
        name: '视频生成任务状态端点',
        url: `${baseUrl}/aivideo/v2/video/getEditData`,
        method: 'GET',
        reachable: true,
        statusCode: hasSession ? 200 : 401,
        latencyMs: 58,
        message: hasSession ? '接口鉴权通过' : '未提供会话 Cookie，返回 401 Unauthorized',
      },
      {
        name: 'NewAPI 统一网关状态',
        url: `${gatewayUrl}/health`,
        method: 'GET',
        reachable: true,
        statusCode: 200,
        latencyMs: 35,
        message: 'NewAPI 网关运行正常',
      },
    ];

    let modelReadiness: ModelReadinessVerdict | undefined;
    const recommendations: string[] = [];

    if (typeof options.modelId === 'number' || options.mediaType) {
      const mediaType = options.mediaType || 'video';
      const modelId = options.modelId ?? (mediaType === 'video' ? 84 : 201);
      const userGroupIds = options.userGroupIds || [10];

      const config: MainSiteConfigSnapshot = {
        routeMode: 'newapi',
        globalModelIds: [88, 12],
        globalApiKey: 'test-global',
        globalRouteRules: {
          video: {
            84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
            88: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
          },
        },
        groupRouteRules: {
          video: {
            panqu_test: {
              84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
            },
          },
        },
        orgBindings: {
          10: { routeGroupId: 1, newapiGroup: 'panqu_test', status: 1, apiKey: 'test-org' },
        },
      };

      const mainVerdict = mediaType === 'video'
        ? RoutingOracle.evaluateVideoMainSite({
            videoType: 6,
            modelId,
            taskType: 28,
            cueword: 'probe_test',
            resolution: '720p',
            aspectRatio: '16:9',
            userGroupIds,
          }, config)
        : RoutingOracle.evaluateImageMainSite({
            selmodelsId: modelId,
            serviceline: 'r',
            userGroupIds,
          }, config);

      const targetModel = mainVerdict.expectedSnapshot?.newapiModel || (mediaType === 'video' ? 'wan3.0-video' : 'runninghub-nano-banana-2');
      const channels: GatewayChannelConfig[] = [
        {
          id: 36,
          name: '万相—yhuo',
          group: mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test',
          models: [targetModel],
          status: 1,
          weight: 10,
          dailyQuotaLimit: 0,
          usedQuota: 0,
        },
      ];

      const gatewayVerdict = RoutingOracle.evaluateGatewayRouting(
        mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test',
        targetModel,
        10,
        channels,
      );

      const issues: string[] = [];
      if (!mainVerdict.willDivert) {
        issues.push(`主站未命中分流 (${mainVerdict.reason})`);
      }
      if (gatewayVerdict.candidateChannelIds.length === 0) {
        issues.push('NewAPI 网关没有可用渠道承接该模型');
      }

      modelReadiness = {
        modelId,
        mediaType,
        decision: mainVerdict.decision as 'DIVERTED' | 'DIRECT' | 'UNKNOWN',
        willDivert: mainVerdict.willDivert,
        routeLine: mainVerdict.line,
        newapiModel: targetModel,
        candidateChannelCount: gatewayVerdict.candidateChannelIds.length,
        isBlockedByQuota: gatewayVerdict.isBlockedByQuota,
        issues,
      };

      if (issues.length > 0) {
        recommendations.push(...issues.map((issue) => `[模型配置] ${issue}`));
      }
    }

    let discoveredContract: DiscoveredModelContract | undefined;
    if (typeof options.modelId === 'number' || options.mediaType) {
      const mediaType = options.mediaType || 'video';
      const modelId = options.modelId ?? (mediaType === 'video' ? 84 : 201);
      discoveredContract = discoverModelContract(modelId, mediaType, options);
      for (const item of discoveredContract.manualRequiredItems) {
        recommendations.push(`[待人工提供-${item.field}] ${item.reason} -> ${item.requiredAction}`);
      }
      for (const conflict of discoveredContract.conflicts) {
        recommendations.push(`[配置冲突-${conflict.field}] ${conflict.message}`);
      }
    }

    if (!hasSession) {
      recommendations.push('[会话凭据] 未提供 Session Cookie，真实接口提交与轮询将受限。可通过 --session-file 传入已登录会话。');
    }

    const isAllOk = endpoints.every((e) => e.reachable) && (!modelReadiness || modelReadiness.issues.length === 0);
    const hasFatal = endpoints.some((e) => !e.reachable);

    return {
      ok: isAllOk,
      status: hasFatal ? 'BLOCKED' : isAllOk ? 'HEALTHY' : 'DEGRADED',
      env,
      baseUrl,
      gatewayUrl,
      probedAt: new Date().toISOString(),
      auth: {
        status: hasSession ? 'VALID' : 'MISSING',
        details: hasSession ? 'Cookie 已配置' : '缺少 Cookie/Session',
        hasSession,
      },
      endpoints,
      modelReadiness,
      discoveredContract,
      recommendations,
    };
  }

  private static async executeRealProbe(
    env: string,
    baseUrl: string,
    gatewayUrl: string,
    cookie: string,
    options: EnvProbeOptions,
    timeoutMs: number,
  ): Promise<EnvProbeReport> {
    const hasSession = Boolean(cookie && cookie.trim().length > 0);
    const endpoints: EndpointProbeResult[] = [];
    const recommendations: string[] = [];

    const probeEndpoint = async (
      name: string,
      url: string,
      method: 'GET' | 'HEAD' | 'OPTIONS',
      headers: Record<string, string> = {},
    ): Promise<EndpointProbeResult> => {
      const startTime = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, {
          method,
          headers: {
            'User-Agent': 'DevTest-EnvProbe/1.0',
            ...headers,
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        const latency = Date.now() - startTime;
        return {
          name,
          url,
          method,
          reachable: true,
          statusCode: res.status,
          latencyMs: latency,
          message: `HTTP ${res.status} (${latency}ms)`,
        };
      } catch (err) {
        const latency = Date.now() - startTime;
        return {
          name,
          url,
          method,
          reachable: false,
          latencyMs: latency,
          message: `连接失败: ${(err as Error).message}`,
        };
      }
    };

    // 1. 主站根目录连通性
    endpoints.push(await probeEndpoint('主站连通性', `${baseUrl}/`, 'HEAD'));

    // 2. 会话探测（如提供了 Cookie）
    const authHeaders: Record<string, string> = {};
    if (hasSession) authHeaders['Cookie'] = cookie;
    endpoints.push(await probeEndpoint('业务鉴权端点', `${baseUrl}/aivideo/v2/video/getEditData`, 'GET', authHeaders));

    // 3. NewAPI 网关
    endpoints.push(await probeEndpoint('NewAPI 网关连通性', `${gatewayUrl}/health`, 'GET'));

    const authCheck = endpoints.find((e) => e.name === '业务鉴权端点');
    let authStatus: 'VALID' | 'EXPIRED' | 'MISSING' = 'MISSING';
    let authDetails = '未提供会话 Cookie';

    if (hasSession) {
      if (authCheck?.statusCode === 200) {
        authStatus = 'VALID';
        authDetails = '会话 Cookie 有效';
      } else if (authCheck?.statusCode === 401 || authCheck?.statusCode === 403) {
        authStatus = 'EXPIRED';
        authDetails = `会话已过期或无权访问 (HTTP ${authCheck.statusCode})`;
        recommendations.push('[会话凭据] 会话 Cookie 已失效，请在浏览器重新登录后更新 session 文件');
      } else {
        authStatus = 'VALID';
        authDetails = `响应状态 ${authCheck?.statusCode || '未知'}`;
      }
    } else {
      recommendations.push('[会话凭据] 建议提供 --session-file 或设置 Cookie 进行完整鉴权测试');
    }

    const unreachable = endpoints.filter((e) => !e.reachable);
    if (unreachable.length > 0) {
      for (const u of unreachable) {
        recommendations.push(`[网络连通] 无法访问 ${u.name} (${u.url})，请检查网络代理或防火墙`);
      }
    }

    let discoveredContract: DiscoveredModelContract | undefined;
    if (typeof options.modelId === 'number' || options.mediaType) {
      const mediaType = options.mediaType || 'video';
      const modelId = options.modelId ?? (mediaType === 'video' ? 84 : 201);
      discoveredContract = discoverModelContract(modelId, mediaType, options);
      for (const item of discoveredContract.manualRequiredItems) {
        recommendations.push(`[待人工提供-${item.field}] ${item.reason} -> ${item.requiredAction}`);
      }
      for (const conflict of discoveredContract.conflicts) {
        recommendations.push(`[配置冲突-${conflict.field}] ${conflict.message}`);
      }
    }

    const ok = unreachable.length === 0 && authStatus !== 'EXPIRED';
    const status = unreachable.length > 0 ? 'BLOCKED' : ok ? 'HEALTHY' : 'DEGRADED';

    return {
      ok,
      status,
      env,
      baseUrl,
      gatewayUrl,
      probedAt: new Date().toISOString(),
      auth: {
        status: authStatus,
        details: authDetails,
        hasSession,
      },
      endpoints,
      discoveredContract,
      recommendations,
    };
  }
}
