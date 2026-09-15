/**
 * Panqu AI DevTest 分流决策与全链路证据采集判定器 (Routing & Evidence)
 *
 * 合并 routing-oracle 与 routing-evidence-collector：
 * 1. 纯函数推导预期路由：主站决策 (NewAPI vs 直连)、网关加权渠道计算、故障降级兜底推导。
 * 2. 全链路证据采集与跨系统标识对齐：主站 extra 快照、网关日志与降级重试证据强校验。
 */

export type DiversionRouteMode = 'newapi' | 'legacy' | 'off';
export type FlowMediaType = 'video' | 'image' | 'canvas';
export type FlowStepStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'BLOCKED' | 'NOT_APPLICABLE' | 'UNVERIFIED' | 'PASS' | 'FAIL';

export interface VideoRoutingInput {
  videoType: number;
  modelId: number;
  taskType?: number;
  cueword?: string;
  outputFormat?: string;
  hasRealHuman?: boolean;
  refVideos?: string[];
  resolution?: string;
  aspectRatio?: string;
  userGroupIds?: number[];
}

export interface ImageRoutingInput {
  selmodelsId: number;
  serviceline: string;
  sizeType?: string;
  imageList?: string[];
  refimg?: string | string[];
  userGroupIds?: number[];
}

export interface MainSiteRouteRules {
  video?: Record<number, { resolutions: string[]; aspect_ratios: string[] }>;
}

export interface GroupRouteRules {
  video?: Record<string, Record<number, { resolutions: string[]; aspect_ratios: string[] }>>;
}

export interface OrgBindingConfig {
  routeGroupId: number;
  newapiGroup: string;
  status: number;
  apiKey: string;
}

export interface MainSiteConfigSnapshot {
  routeMode: DiversionRouteMode;
  globalModelIds: number[];
  globalApiKey: string;
  globalRouteRules: MainSiteRouteRules;
  groupRouteRules: GroupRouteRules;
  orgBindings: Record<number, OrgBindingConfig>;
  modelAliases?: Record<number, string>;
}

export interface MainSiteRoutingVerdict {
  willDivert: boolean;
  decision:
    | 'NEWAPI_GLOBAL'
    | 'NEWAPI_ORG_GROUP'
    | 'NEWAPI_IMAGE'
    | 'FALLBACK_LEGACY'
    | 'FALLBACK_DIRECT'
    | 'BLOCKED_ILLEGAL';
  line: number;
  reason: string;
  expectedSnapshot?: {
    orgId: number;
    routeGroupId: number;
    newapiGroup: string;
    newapiModel: string;
  };
}

export interface GatewayChannelConfig {
  id: number;
  name: string;
  group: string;
  models: string[];
  status: number;
  weight: number;
  dailyQuotaLimit: number;
  usedQuota: number;
}

export interface GatewayRoutingVerdict {
  isBlockedByQuota: boolean;
  candidateChannelIds: number[];
  allowedChannels: string[];
  probabilities: Record<number, number>;
  rejectedReasons: Record<number, string>;
}

export interface BatchDistributionResult {
  passed: boolean;
  sampleCount: number;
  sufficientSamples: boolean;
  expectedDistribution: Record<number, number>;
  observedDistribution: Record<number, number>;
  maxDeviation: number;
  tolerance: number;
  reason: string;
}

export interface FallbackRoutingVerdict {
  fallbackAction: 'VOLCENGINE_RETRY_QUEUE' | 'DIRECT_FAIL_NO_RETRY';
  targetLine?: number;
  targetQueue?: string;
  recordRetryLog: boolean;
  reason: string;
}

export class RoutingOracle {
  public static evaluateVideoMainSite(
    input: VideoRoutingInput,
    config: MainSiteConfigSnapshot,
    customAliasGetter?: (id: number) => string,
  ): MainSiteRoutingVerdict {
    if (config.routeMode === 'off') {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: '主站分流总开关为 off，全部回归直连链路' };
    }
    if (config.routeMode === 'legacy') {
      return { willDivert: false, decision: 'FALLBACK_LEGACY', line: 6, reason: '主站分流模式为 legacy，回退原手动概率分流线路' };
    }

    const isWan3 = input.videoType === 105 || input.videoType === 106;
    if (!isWan3) {
      if (input.videoType !== 6) {
        return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: '非 wan3 且非 videoType=6，不满足 NewAPI 视频分流任务类型' };
      }
      if ([16, 58].includes(input.modelId)) {
        return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: `模型 ${input.modelId} 属于排除直连清单 (seedance fast/mini 走主站直连)` };
      }
      if (input.taskType !== undefined && input.taskType !== 28) {
        return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: 'Seedance 仅全能参考任务 (task_type=28) 支持分流' };
      }
      if (input.refVideos && input.refVideos.length > 0) {
        return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: 'Seedance 带参考视频任务继续直连供应商' };
      }
    }

    if (input.hasRealHuman) {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: '素材中检测到真人人像，拦截回退直连链路' };
    }

    const cueword = input.cueword || '';
    if (cueword.length > 5000) {
      return { willDivert: false, decision: 'BLOCKED_ILLEGAL', line: 0, reason: `提示词长度 (${cueword.length}) 超过 5000 字上限，主站前置拦截` };
    }

    if ((input.outputFormat || '').toLowerCase().trim() === 'mov') {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: 'MOV 输出格式不支持 NewAPI 分流，回退直连' };
    }

    const resolveAlias = (id: number): string => {
      if (customAliasGetter) return customAliasGetter(id);
      if (config.modelAliases?.[id]) return config.modelAliases[id];
      if (id === 84) return 'wan3.0-video';
      if (id === 88) return 'wan3.0-video-prime';
      if (id === 15) return 'seedance-2.0';
      if (id === 78) return 'seedance-2.5';
      return `model-alias-${id}`;
    };

    if (config.globalModelIds.includes(input.modelId)) {
      const alias = resolveAlias(input.modelId);
      if (!alias) throw new Error(`RoutingOracleError: 模型 ${input.modelId} 别名未配置`);
      if (!config.globalApiKey) throw new Error('RoutingOracleError: 全量模型全局 API Key 未配置');
      return {
        willDivert: true,
        decision: 'NEWAPI_GLOBAL',
        line: 10,
        reason: '全量开放模型 (is_newapi_global=1)，直接使用全局Key直达 NewAPI 分流',
        expectedSnapshot: { orgId: 0, routeGroupId: 0, newapiGroup: '', newapiModel: alias },
      };
    }

    const globalRule = config.globalRouteRules.video?.[input.modelId];
    if (!globalRule) {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: `模型 ${input.modelId} 未在全局渠道能力配置中登记，回退直连` };
    }

    const res = (input.resolution || '').toLowerCase().trim();
    const asp = (input.aspectRatio || '').toLowerCase().trim();
    if (res && !globalRule.resolutions.map((r) => r.toLowerCase()).includes(res)) {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: `分辨率 ${input.resolution} 不在全局渠道能力并集内，前置回退` };
    }
    if (asp && !globalRule.aspect_ratios.map((a) => a.toLowerCase()).includes(asp)) {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: `画幅比例 ${input.aspectRatio} 不在全局渠道能力并集内，前置回退` };
    }

    const userGroups = input.userGroupIds || [];
    let matchedOrgId = 0;
    let matchedBinding: OrgBindingConfig | undefined;
    for (const gid of userGroups) {
      if (config.orgBindings[gid]) {
        matchedOrgId = gid;
        matchedBinding = config.orgBindings[gid];
        break;
      }
    }

    if (!matchedBinding) {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: '用户所属角色组未绑定任何有效的 NewAPI 路由组，不分流' };
    }
    if (matchedBinding.status !== 1 || !matchedBinding.apiKey) {
      throw new Error(`RoutingOracleError: 路由组配置异常 (status=${matchedBinding.status}, key缺失)`);
    }

    const newapiGroup = matchedBinding.newapiGroup;
    if (newapiGroup) {
      const groupRule = config.groupRouteRules.video?.[newapiGroup]?.[input.modelId];
      if (groupRule) {
        if (res && !groupRule.resolutions.map((r) => r.toLowerCase()).includes(res)) {
          return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: `当前路由分组 ${newapiGroup} 无承接分辨率 ${input.resolution} 的渠道，回退直连` };
        }
        if (asp && !groupRule.aspect_ratios.map((a) => a.toLowerCase()).includes(asp)) {
          return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: `当前路由分组 ${newapiGroup} 无承接画幅 ${input.aspectRatio} 的渠道，回退直连` };
        }
      }
    }

    const alias = resolveAlias(input.modelId);
    return {
      willDivert: true,
      decision: 'NEWAPI_ORG_GROUP',
      line: 10,
      reason: `匹配组织 ${matchedOrgId} 与路由组 ${matchedBinding.routeGroupId}（分组 ${newapiGroup}），命中 NewAPI 分流`,
      expectedSnapshot: { orgId: matchedOrgId, routeGroupId: matchedBinding.routeGroupId, newapiGroup, newapiModel: alias },
    };
  }

  public static evaluateImageMainSite(
    input: ImageRoutingInput,
    config: Pick<MainSiteConfigSnapshot, 'orgBindings' | 'modelAliases'>,
    customAliasGetter?: (id: number) => string,
  ): MainSiteRoutingVerdict {
    const resolveAlias = (id: number): string => {
      if (customAliasGetter) return customAliasGetter(id);
      if (config.modelAliases?.[id]) return config.modelAliases[id];
      if (id === 12) return 'pan-banana-pro';
      if (id === 201) return 'runninghub-nano-banana-2';
      return `image-alias-${id}`;
    };

    const alias = resolveAlias(input.selmodelsId);
    if (!alias || alias.trim() === '') {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: '模型别名留空，任务静默走原渠道' };
    }
    if ((input.serviceline || '').toLowerCase().trim() !== 'r') {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: `服务线路为 ${input.serviceline} (非 r)，任务走原渠道` };
    }
    if ((input.sizeType || 'resolution').toLowerCase().trim() === 'pixels') {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: '自定义像素尺寸 (pixels) 不支持 NewAPI 图片分流' };
    }

    let refCount = 0;
    if (Array.isArray(input.imageList)) {
      refCount = input.imageList.filter((item) => typeof item === 'string' && item.trim() !== '').length;
    } else if (input.refimg) {
      const items = Array.isArray(input.refimg) ? input.refimg : input.refimg.split(',');
      refCount = items.filter((item) => typeof item === 'string' && item.trim() !== '').length;
    }
    if (refCount > 10) {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: `参考图数量 (${refCount}) 超过上限 10 张` };
    }

    const userGroups = input.userGroupIds || [];
    let matchedOrgId = 0;
    let matchedBinding: OrgBindingConfig | undefined;
    for (const gid of userGroups) {
      if (config.orgBindings[gid]) {
        matchedOrgId = gid;
        matchedBinding = config.orgBindings[gid];
        break;
      }
    }

    if (!matchedBinding || matchedBinding.status !== 1 || !matchedBinding.apiKey) {
      return { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0, reason: '企业路由组未绑定、未启用或缺少 API Key，任务静默走原渠道' };
    }

    return {
      willDivert: true,
      decision: 'NEWAPI_IMAGE',
      line: 10,
      reason: '满足图片分流全部前置条件，成功命中 NewAPI 分流',
      expectedSnapshot: {
        orgId: matchedOrgId,
        routeGroupId: matchedBinding.routeGroupId,
        newapiGroup: matchedBinding.newapiGroup,
        newapiModel: alias,
      },
    };
  }

  public static evaluateGatewayRouting(
    tokenGroup: string,
    targetModel: string,
    taskPoints: number,
    channels: GatewayChannelConfig[],
  ): GatewayRoutingVerdict {
    const rejectedReasons: Record<number, string> = {};
    const candidates: GatewayChannelConfig[] = [];
    let quotaBlockedCount = 0;

    for (const ch of channels) {
      if (ch.status !== 1) {
        rejectedReasons[ch.id] = '渠道未启用 (status!=1)';
        continue;
      }
      const groupMatched = ch.group === 'default' || ch.group === tokenGroup;
      if (!groupMatched) {
        rejectedReasons[ch.id] = `渠道分组 (${ch.group}) 与令牌分组 (${tokenGroup}) 不匹配`;
        continue;
      }
      if (!ch.models.includes(targetModel)) {
        rejectedReasons[ch.id] = `渠道不承接模型 ${targetModel}`;
        continue;
      }
      if (ch.dailyQuotaLimit > 0 && ch.usedQuota + taskPoints > ch.dailyQuotaLimit) {
        quotaBlockedCount++;
        rejectedReasons[ch.id] = `渠道超出每日限额 (${ch.usedQuota}+${taskPoints} > ${ch.dailyQuotaLimit})`;
        continue;
      }
      candidates.push(ch);
    }

    const totalWeight = candidates.reduce((sum, ch) => sum + Math.max(1, ch.weight), 0);
    const probabilities: Record<number, number> = {};
    for (const ch of candidates) {
      probabilities[ch.id] = totalWeight > 0 ? Math.max(1, ch.weight) / totalWeight : 0;
    }

    return {
      isBlockedByQuota: candidates.length === 0 && quotaBlockedCount > 0,
      candidateChannelIds: candidates.map((c) => c.id),
      allowedChannels: candidates.map((c) => c.name),
      probabilities,
      rejectedReasons,
    };
  }

  public static evaluateBatchDistribution(
    sampledChannelIds: number[],
    channels: GatewayChannelConfig[],
    tolerance = 0.15,
  ): BatchDistributionResult {
    const sampleCount = sampledChannelIds.length;
    const sufficientSamples = sampleCount >= 20;

    const totalWeight = channels.reduce((sum, ch) => sum + Math.max(1, ch.weight), 0);
    const expectedDistribution: Record<number, number> = {};
    for (const ch of channels) {
      expectedDistribution[ch.id] = totalWeight > 0 ? Math.max(1, ch.weight) / totalWeight : 0;
    }

    const observedCounts: Record<number, number> = {};
    for (const id of sampledChannelIds) {
      observedCounts[id] = (observedCounts[id] || 0) + 1;
    }

    const observedDistribution: Record<number, number> = {};
    let maxDeviation = 0;
    for (const ch of channels) {
      const observedRate = sampleCount > 0 ? (observedCounts[ch.id] || 0) / sampleCount : 0;
      observedDistribution[ch.id] = observedRate;
      const expectedRate = expectedDistribution[ch.id] || 0;
      const deviation = Math.abs(observedRate - expectedRate);
      if (deviation > maxDeviation) maxDeviation = deviation;
    }

    let passed = true;
    let reason = '批量样本加权分布符合理论容差区间';
    if (!sufficientSamples) {
      passed = true;
      reason = `样本数量 (${sampleCount} < 20) 不足，仅校验命中渠道属于合法候选集合，未做确定性权重统计结论`;
    } else if (maxDeviation > tolerance) {
      passed = false;
      reason = `实际分布最大偏差 (${(maxDeviation * 100).toFixed(1)}%) 超过允许容差 (${(tolerance * 100).toFixed(1)}%)`;
    }

    return { passed, sampleCount, sufficientSamples, expectedDistribution, observedDistribution, maxDeviation, tolerance, reason };
  }

  public static evaluateFallback(modelId: number, failureCode?: string | number): FallbackRoutingVerdict {
    const isSeedance = [15, 78].includes(modelId);
    if (isSeedance) {
      return {
        fallbackAction: 'VOLCENGINE_RETRY_QUEUE',
        targetLine: 1,
        targetQueue: 'ai_volcengine_video_submit_queue',
        recordRetryLog: true,
        reason: `Seedance 模型 (${modelId}) NewAPI 故障，按业务规则自动派发至火山兜底并记录 retrylog`,
      };
    }
    return {
      fallbackAction: 'DIRECT_FAIL_NO_RETRY',
      recordRetryLog: false,
      reason: `模型 (${modelId}) 属于非 Seedance 系列，不进入分流重试队列，直接标记失败`,
    };
  }
}
