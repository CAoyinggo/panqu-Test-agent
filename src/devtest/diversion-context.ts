/**
 * 分流上下文与统一预测 (Diversion Context)
 * =============================================================================
 * 贯穿 plan→verify 的分流决策单一入口。以真实 line=10 路由规则为锚：
 *  - 有规则(routeRules/groupRules 存在) → 调用 newapi-route-eligibility 的
 *    evaluateVideoDiversion/evaluateImageDiversion 得 **grounded** 裁决；
 *  - 无规则 → 返回 **provisional** 假设（调用方保持既有场景默认，不据此改判，避免破坏离线行为）。
 * 媒体感知：视频落库标记 extra.diversion=10；图片 extra.newapi_image=1（Goods.php:1078…）。
 * 纯叶子模块（仅依赖 newapi-route-eligibility），运行时无反向依赖、无环。
 */
import {
  evaluateVideoDiversion,
  evaluateImageDiversion,
  type RouteRules,
  type GroupedRouteRules,
  type RouteMode,
} from './newapi-route-eligibility.js';

export type DiversionMarker = 'diversion' | 'newapi_image';

/** 媒体感知的落库分流标记键。 */
export function diversionMarkerKey(mediaType: 'video' | 'image'): DiversionMarker {
  return mediaType === 'image' ? 'newapi_image' : 'diversion';
}
/** 该标记命中时的期望值：视频 diversion=10；图片 newapi_image=1。 */
export function diversionMarkerExpectedValue(mediaType: 'video' | 'image'): number {
  return mediaType === 'image' ? 1 : 10;
}

export interface DiversionPrediction {
  willDivert: boolean;
  decision: string;
  line: 0 | 10;
  marker: DiversionMarker;
  markerExpectedValue: number;
  provenance: 'GROUNDED_ROUTE_RULES' | 'PROVISIONAL_ASSUMPTION';
  reason: string;
  hardError?: boolean;
}

export interface PredictDiversionInput {
  mediaType: 'video' | 'image';
  modelId: number;
  alias: string;
  isGlobalModel: boolean;
  resolution: string;
  aspect?: string;
  serviceline?: string;
  modelClass?: 'normal' | 'image25' | 'mj_v82' | 'image2_lowcost';
  routeMode?: RouteMode;
  routeRules?: RouteRules | null;
  groupRules?: GroupedRouteRules | null;
  routeGroup?: { newapi_group: string; usable: boolean } | null;
  hasGlobalApiKey?: boolean;
}

// APPEND_PREDICT

/**
 * 统一分流预测。有 line=10 路由规则时以资格引擎给出 grounded 裁决；否则 provisional（调用方勿据此改判）。
 * plan 上下文缺少运行时态(全局Key/路由组可用性)，此处对配置级门槛取合理默认(存在即视为就绪)，
 * 仅确定性地判"模型×分辨率×画面比例是否在启用渠道能力内"——真实运行时仍以 verify 的落库标记为准。
 */
export function predictDiversion(input: PredictDiversionInput): DiversionPrediction {
  const marker = diversionMarkerKey(input.mediaType);
  const markerExpectedValue = diversionMarkerExpectedValue(input.mediaType);
  const routeMode: RouteMode = input.routeMode ?? 'newapi';
  const hasRules = Boolean(input.routeRules || input.groupRules);

  if (!hasRules || routeMode !== 'newapi') {
    return {
      willDivert: false,
      decision: routeMode === 'newapi' ? 'PROVISIONAL_NO_RULES' : `PROVISIONAL_ROUTE_MODE_${routeMode.toUpperCase()}`,
      line: 0,
      marker,
      markerExpectedValue,
      provenance: 'PROVISIONAL_ASSUMPTION',
      reason:
        routeMode === 'newapi'
          ? '未提供 line=10 路由规则，分流预测为假设值，交实测/人工确认（不作硬断言）'
          : `分流总开关 routeMode=${routeMode}，非 newapi`,
    };
  }

  if (input.mediaType === 'video') {
    const r = evaluateVideoDiversion({
      routeMode,
      eligible: true,
      modelId: input.modelId,
      isGlobalModel: input.isGlobalModel,
      alias: input.alias,
      hasGlobalApiKey: input.hasGlobalApiKey ?? true,
      resolution: input.resolution,
      aspect: input.aspect ?? 'auto',
      routeGroup: input.routeGroup ?? (input.groupRules ? { newapi_group: 'default', usable: true } : null),
      routeRules: input.routeRules,
      groupRules: input.groupRules,
    });
    return {
      willDivert: r.line === 10,
      decision: r.decision,
      line: r.line,
      marker,
      markerExpectedValue,
      provenance: 'GROUNDED_ROUTE_RULES',
      reason: r.reason,
      hardError: r.hardError,
    };
  }

  const r = evaluateImageDiversion({
    selmodelsId: input.modelId,
    alias: input.alias,
    isGlobalModel: input.isGlobalModel,
    hasGlobalApiKey: input.hasGlobalApiKey ?? true,
    serviceline: input.serviceline ?? 'r',
    resolution: input.resolution,
    aspect: input.aspect,
    modelClass: input.modelClass,
    routeGroup: input.routeGroup ?? (input.groupRules ? { newapi_group: 'default', usable: true } : null),
    routeRules: input.routeRules,
    groupRules: input.groupRules,
  });
  return {
    willDivert: r.diverted,
    decision: r.decision,
    line: r.diverted ? 10 : 0,
    marker,
    markerExpectedValue,
    provenance: 'GROUNDED_ROUTE_RULES',
    reason: r.reason,
    hardError: r.hardError,
  };
}
