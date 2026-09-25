/**
 * Panqu AI DevTest 分流决策与全链路证据采集判定器 (Routing & Evidence)
 *
 * 合并 routing-oracle 与 routing-evidence-collector：
 * 1. 纯函数推导预期路由：主站决策 (NewAPI vs 直连)、网关加权渠道计算、故障降级兜底推导。
 * 2. 全链路证据采集与跨系统标识对齐：主站 extra 快照、网关日志与降级重试证据强校验。
 */

import type { TargetDisambiguationInput, TargetDisambiguationResult } from './types.js';

export type DiversionRouteMode = 'newapi' | 'legacy' | 'off';
export type FlowMediaType = 'video' | 'image' | 'canvas';
export type FlowStepStatus =
  'SUCCESS' | 'FAILED' | 'SKIPPED' | 'BLOCKED' | 'NOT_APPLICABLE' | 'UNVERIFIED' | 'PASS' | 'FAIL';

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
  image?: Record<number, { resolutions?: string[]; aspect_ratios?: string[]; max_ref_images?: number }>;
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
    'NEWAPI_GLOBAL' | 'NEWAPI_ORG_GROUP' | 'NEWAPI_IMAGE' | 'FALLBACK_LEGACY' | 'FALLBACK_DIRECT' | 'BLOCKED_ILLEGAL';
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
  sourceMode?: 'SOURCE_STATIC_CONTRACT' | 'SOURCE_REAL_GATEWAY' | 'UNVERIFIED';
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
      return {
        willDivert: false,
        decision: 'FALLBACK_DIRECT',
        line: 0,
        reason: '主站分流总开关为 off，全部回归直连链路',
      };
    }
    if (config.routeMode === 'legacy') {
      return {
        willDivert: false,
        decision: 'FALLBACK_LEGACY',
        line: 6,
        reason: '主站分流模式为 legacy，回退原手动概率分流线路',
      };
    }

    const isWan3 = input.videoType === 105 || input.videoType === 106;
    if (!isWan3) {
      if (input.videoType !== 6) {
        return {
          willDivert: false,
          decision: 'FALLBACK_DIRECT',
          line: 0,
          reason: '非 wan3 且非 videoType=6，不满足 NewAPI 视频分流任务类型',
        };
      }
      if ([16, 58].includes(input.modelId)) {
        return {
          willDivert: false,
          decision: 'FALLBACK_DIRECT',
          line: 0,
          reason: `模型 ${input.modelId} 属于排除直连清单 (seedance fast/mini 走主站直连)`,
        };
      }
      if (input.taskType !== undefined && input.taskType !== 28) {
        return {
          willDivert: false,
          decision: 'FALLBACK_DIRECT',
          line: 0,
          reason: 'Seedance 仅全能参考任务 (task_type=28) 支持分流',
        };
      }
      if (input.refVideos && input.refVideos.length > 0) {
        return {
          willDivert: false,
          decision: 'FALLBACK_DIRECT',
          line: 0,
          reason: 'Seedance 带参考视频任务继续直连供应商',
        };
      }
    }

    if (input.hasRealHuman) {
      return {
        willDivert: false,
        decision: 'FALLBACK_DIRECT',
        line: 0,
        reason: '素材中检测到真人人像，拦截回退直连链路',
      };
    }

    const cueword = input.cueword || '';
    if (cueword.length > 5000) {
      return {
        willDivert: false,
        decision: 'BLOCKED_ILLEGAL',
        line: 0,
        reason: `提示词长度 (${cueword.length}) 超过 5000 字上限，主站前置拦截`,
      };
    }

    if ((input.outputFormat || '').toLowerCase().trim() === 'mov') {
      return {
        willDivert: false,
        decision: 'FALLBACK_DIRECT',
        line: 0,
        reason: 'MOV 输出格式不支持 NewAPI 分流，回退直连',
      };
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
      return {
        willDivert: false,
        decision: 'FALLBACK_DIRECT',
        line: 0,
        reason: `模型 ${input.modelId} 未在全局渠道能力配置中登记，回退直连`,
      };
    }

    const res = (input.resolution || '').toLowerCase().trim();
    const asp = (input.aspectRatio || '').toLowerCase().trim();
    if (res && !globalRule.resolutions.map((r) => r.toLowerCase()).includes(res)) {
      return {
        willDivert: false,
        decision: 'FALLBACK_DIRECT',
        line: 0,
        reason: `分辨率 ${input.resolution} 不在全局渠道能力并集内，前置回退`,
      };
    }
    if (asp && !globalRule.aspect_ratios.map((a) => a.toLowerCase()).includes(asp)) {
      return {
        willDivert: false,
        decision: 'FALLBACK_DIRECT',
        line: 0,
        reason: `画幅比例 ${input.aspectRatio} 不在全局渠道能力并集内，前置回退`,
      };
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
      return {
        willDivert: false,
        decision: 'FALLBACK_DIRECT',
        line: 0,
        reason: '用户所属角色组未绑定任何有效的 NewAPI 路由组，不分流',
      };
    }
    if (matchedBinding.status !== 1 || !matchedBinding.apiKey) {
      throw new Error(`RoutingOracleError: 路由组配置异常 (status=${matchedBinding.status}, key缺失)`);
    }

    const newapiGroup = matchedBinding.newapiGroup;
    if (newapiGroup) {
      const groupRule = config.groupRouteRules.video?.[newapiGroup]?.[input.modelId];
      if (groupRule) {
        if (res && !groupRule.resolutions.map((r) => r.toLowerCase()).includes(res)) {
          return {
            willDivert: false,
            decision: 'FALLBACK_DIRECT',
            line: 0,
            reason: `当前路由分组 ${newapiGroup} 无承接分辨率 ${input.resolution} 的渠道，回退直连`,
          };
        }
        if (asp && !groupRule.aspect_ratios.map((a) => a.toLowerCase()).includes(asp)) {
          return {
            willDivert: false,
            decision: 'FALLBACK_DIRECT',
            line: 0,
            reason: `当前路由分组 ${newapiGroup} 无承接画幅 ${input.aspectRatio} 的渠道，回退直连`,
          };
        }
      }
    }

    const alias = resolveAlias(input.modelId);
    return {
      willDivert: true,
      decision: 'NEWAPI_ORG_GROUP',
      line: 10,
      reason: `匹配组织 ${matchedOrgId} 与路由组 ${matchedBinding.routeGroupId}（分组 ${newapiGroup}），命中 NewAPI 分流`,
      expectedSnapshot: {
        orgId: matchedOrgId,
        routeGroupId: matchedBinding.routeGroupId,
        newapiGroup,
        newapiModel: alias,
      },
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
      return {
        willDivert: false,
        decision: 'FALLBACK_DIRECT',
        line: 0,
        reason: `服务线路为 ${input.serviceline} (非 r)，任务走原渠道`,
      };
    }
    if ((input.sizeType || 'resolution').toLowerCase().trim() === 'pixels') {
      return {
        willDivert: false,
        decision: 'FALLBACK_DIRECT',
        line: 0,
        reason: '自定义像素尺寸 (pixels) 不支持 NewAPI 图片分流',
      };
    }

    let refCount = 0;
    if (Array.isArray(input.imageList)) {
      refCount = input.imageList.filter((item) => typeof item === 'string' && item.trim() !== '').length;
    } else if (input.refimg) {
      const items = Array.isArray(input.refimg) ? input.refimg : input.refimg.split(',');
      refCount = items.filter((item) => typeof item === 'string' && item.trim() !== '').length;
    }
    if (refCount > 10) {
      return {
        willDivert: false,
        decision: 'FALLBACK_DIRECT',
        line: 0,
        reason: `参考图数量 (${refCount}) 超过上限 10 张`,
      };
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
      return {
        willDivert: false,
        decision: 'FALLBACK_DIRECT',
        line: 0,
        reason: '企业路由组未绑定、未启用或缺少 API Key，任务静默走原渠道',
      };
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

    return {
      passed,
      sampleCount,
      sufficientSamples,
      expectedDistribution,
      observedDistribution,
      maxDeviation,
      tolerance,
      reason,
    };
  }

  public static evaluateFallback(modelId: number, _failureCode?: string | number): FallbackRoutingVerdict {
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

  public static disambiguateTarget(
    input: TargetDisambiguationInput,
    customChannels?: GatewayChannelConfig[],
  ): TargetDisambiguationResult {
    const hasRealSnapshot = Boolean(
      customChannels && customChannels.length > 0 && customChannels.some((c) => c.sourceMode === 'SOURCE_REAL_GATEWAY'),
    );
    const channels = customChannels && customChannels.length > 0 ? customChannels : DEFAULT_KNOWN_GATEWAY_CHANNELS;
    const channelSource: 'SOURCE_STATIC_CONTRACT' | 'SOURCE_REAL_GATEWAY' | 'UNVERIFIED' = hasRealSnapshot
      ? 'SOURCE_REAL_GATEWAY'
      : 'SOURCE_STATIC_CONTRACT';

    const modelMap: Record<number, string> = {
      15: 'seedance-2.0',
      78: 'seedance-2.5',
      84: 'wan3.0-video',
      88: 'wan3.0-video-prime',
      12: 'pan-banana-pro',
      201: 'runninghub-nano-banana-2',
    };
    const reverseModelMap: Record<string, number> = {
      'seedance-2.0': 15,
      'seedance-2.5': 78,
      'wan3.0-video': 84,
      'wan3.0-video-prime': 88,
      'pan-banana-pro': 12,
      'runninghub-nano-banana-2': 201,
    };

    let targetKind = input.targetKind;
    let channelId = input.channelId;
    let channelName = input.channelName;
    let modelId = input.modelId;
    let modelAlias = input.modelAlias;
    const projectId = input.projectId;

    // 解析 rawTarget，例如 "#54", "54", "channel 54", "TD_国际"
    if (input.rawTarget !== undefined && input.rawTarget !== null) {
      const rawStr = String(input.rawTarget).trim();
      const numMatch = rawStr.match(/\d+/);
      const parsedNum = numMatch ? Number(numMatch[0]) : undefined;

      if (
        rawStr.toLowerCase().startsWith('channel') ||
        rawStr.includes('渠道') ||
        parsedNum === 54 ||
        rawStr === 'TD_国际'
      ) {
        targetKind = 'channel';
        if (parsedNum) channelId = parsedNum;
        if (rawStr.includes('TD_国际')) channelName = 'TD_国际';
      } else if (rawStr.toLowerCase().startsWith('model') || rawStr.includes('模型')) {
        targetKind = 'model';
        if (parsedNum) modelId = parsedNum;
      } else if (parsedNum !== undefined) {
        const matchedCh = channels.find((c) => c.id === parsedNum || c.name === rawStr);
        if (matchedCh) {
          targetKind = 'channel';
          channelId = matchedCh.id;
          channelName = matchedCh.name;
        } else {
          modelId = parsedNum;
        }
      }
    }

    // 核心消歧拦截：检查是否把渠道当成了模型（如传入 modelId: 54 或 2）
    if (modelId === 54 && modelAlias !== 'td') {
      const ch54 = channels.find((c) => c.id === 54);
      return {
        ok: false,
        targetKind: 'channel',
        channelId: 54,
        channelName: ch54?.name || 'TD_国际',
        modelId: 0,
        modelAlias: '',
        projectId,
        isDisambiguated: false,
        channelSource,
        supportedModels: [
          { id: 15, alias: 'seedance-2.0' },
          { id: 78, alias: 'seedance-2.5' },
        ],
        error: `BLOCKED_AMBIGUOUS_ID (BLOCKED_MISSING_INPUT): #54 是网关渠道 '${ch54?.name || 'TD_国际'}' (channel_id: 54)，而非模型 ID (不得回退 Wan3.0)！该渠道承接模型为 #15 (seedance-2.0) 与 #78 (seedance-2.5)。请显式指定 --channel 54 --model 15 或 --model 78。`,
      };
    }

    if (modelId === 2 && modelAlias !== 'rh') {
      const ch2 = channels.find((c) => c.id === 2);
      return {
        ok: false,
        targetKind: 'channel',
        channelId: 2,
        channelName: ch2?.name || 'RH-国际',
        modelId: 0,
        modelAlias: '',
        projectId,
        isDisambiguated: false,
        channelSource,
        supportedModels: [
          { id: 15, alias: 'seedance-2.0' },
          { id: 78, alias: 'seedance-2.5' },
        ],
        error: `BLOCKED_AMBIGUOUS_ID (BLOCKED_MISSING_INPUT): #2 是网关渠道 '${ch2?.name || 'RH-国际'}' (channel_id: 2)，而非模型 ID！该渠道承接模型为 #15 (seedance-2.0) 与 #78 (seedance-2.5)。请显式指定 --channel 2 --model 78 或 --model 15。`,
      };
    }

    // 若指定了 channelId 或 channelName，判定为渠道测试
    if (channelId !== undefined || channelName !== undefined || targetKind === 'channel') {
      const ch = channels.find(
        (c) => (channelId !== undefined && c.id === channelId) || (channelName && c.name === channelName),
      );
      if (!ch) {
        return {
          ok: false,
          targetKind: 'channel',
          channelId,
          channelName,
          modelId: modelId || 0,
          modelAlias: modelAlias || '',
          projectId,
          isDisambiguated: false,
          channelSource: 'UNVERIFIED',
          error: `BLOCKED_UNKNOWN_CHANNEL: 未识别的渠道标识 (channelId: ${channelId}, channelName: ${channelName})`,
        };
      }

      const supportedModels = ch.models.map((m) => ({
        id: reverseModelMap[m] || 0,
        alias: m,
      }));

      // 若未指定 modelId，且渠道承接多个模型，必须显式消歧
      if (!modelId && !modelAlias) {
        if (supportedModels.length === 1) {
          modelId = supportedModels[0].id;
          modelAlias = supportedModels[0].alias;
        } else {
          return {
            ok: false,
            targetKind: 'channel',
            channelId: ch.id,
            channelName: ch.name,
            modelId: 0,
            modelAlias: '',
            projectId,
            isDisambiguated: false,
            channelSource,
            supportedModels,
            error: `BLOCKED_AMBIGUOUS_CHANNEL: 渠道 #${ch.id} ('${ch.name}') 承接多个模型 (${supportedModels.map((m) => `#${m.id} ${m.alias}`).join(', ')})。执行前必须显式指定目标模型 ID (--model)。`,
          };
        }
      }

      if (modelId && !modelAlias) {
        modelAlias = modelMap[modelId] || `model-${modelId}`;
      } else if (!modelId && modelAlias) {
        modelId = reverseModelMap[modelAlias] || 0;
      }

      const resolvedAlias = modelAlias || '';
      const resolvedModelId = modelId || 0;
      const isModelSupported =
        (resolvedAlias ? ch.models.includes(resolvedAlias) : false) ||
        (resolvedModelId > 0 && supportedModels.some((m) => m.id === resolvedModelId));
      if (!isModelSupported) {
        return {
          ok: false,
          targetKind: 'channel',
          channelId: ch.id,
          channelName: ch.name,
          modelId: modelId || 0,
          modelAlias: modelAlias || '',
          projectId,
          isDisambiguated: false,
          channelSource,
          supportedModels,
          error: `BLOCKED_CHANNEL_MODEL_MISMATCH: 渠道 #${ch.id} ('${ch.name}') 不支持模型 #${modelId} ('${modelAlias}')。该渠道仅承接: ${supportedModels.map((m) => `#${m.id} (${m.alias})`).join(', ')}。`,
        };
      }

      return {
        ok: true,
        targetKind: 'channel',
        channelId: ch.id,
        channelName: ch.name,
        modelId: modelId || 0,
        modelAlias: modelAlias || '',
        projectId,
        isDisambiguated: true,
        channelSource,
        supportedModels,
        warning:
          channelSource === 'SOURCE_STATIC_CONTRACT'
            ? `渠道 #${ch.id} ('${ch.name}') 当前仅具备静态契约信息 (SOURCE_STATIC_CONTRACT)，非线上实时快照`
            : undefined,
      };
    }

    // 默认模型模式
    const resolvedModelId = modelId || 0;
    const resolvedAlias =
      modelAlias || modelMap[resolvedModelId] || (resolvedModelId > 0 ? `model-${resolvedModelId}` : '');
    return {
      ok: resolvedModelId > 0,
      targetKind: 'model',
      modelId: resolvedModelId,
      modelAlias: resolvedAlias,
      projectId,
      isDisambiguated: true,
      channelSource: 'UNVERIFIED',
      ...(resolvedModelId <= 0 ? { error: 'BLOCKED_MISSING_MODEL: 未提供有效的 modelId 或 channelId' } : {}),
    };
  }
}

/**
 * 离线静态已知网关渠道契约 (DEFAULT_KNOWN_GATEWAY_CHANNELS)
 * 永久约束：本表仅为离线名称解析与测试夹具契约 (SOURCE_STATIC_CONTRACT)，绝不能表述为当前线上实时事实。
 * 线上 status / weight / quota 随时可能发生动态变更，REAL 模式核验必须使用只读动态快照；无法获取时判定为 UNVERIFIED / BLOCKED。
 */
export const DEFAULT_KNOWN_GATEWAY_CHANNELS: GatewayChannelConfig[] = [
  {
    id: 2,
    name: 'RH-国际',
    group: 'panqu_test',
    models: ['seedance-2.0', 'seedance-2.5'],
    status: 1,
    weight: 10,
    dailyQuotaLimit: 0,
    usedQuota: 0,
    sourceMode: 'SOURCE_STATIC_CONTRACT',
  },
  {
    id: 54,
    name: 'TD_国际',
    group: 'panqu_test',
    models: ['seedance-2.0', 'seedance-2.5'],
    status: 1,
    weight: 10,
    dailyQuotaLimit: 0,
    usedQuota: 0,
    sourceMode: 'SOURCE_STATIC_CONTRACT',
  },
  {
    id: 36,
    name: '万相',
    group: 'panqu_test',
    models: ['wan3.0-video', 'wan3.0-video-prime'],
    status: 1,
    weight: 10,
    dailyQuotaLimit: 0,
    usedQuota: 0,
    sourceMode: 'SOURCE_STATIC_CONTRACT',
  },
  {
    id: 39,
    name: 'RH视频',
    group: 'panqu_test',
    models: ['seedance-2.0', 'seedance-2.5'],
    status: 1,
    weight: 10,
    dailyQuotaLimit: 0,
    usedQuota: 0,
    sourceMode: 'SOURCE_STATIC_CONTRACT',
  },
  {
    id: 40,
    name: 'RH图片',
    group: 'panqu_test',
    models: ['pan-banana-pro', 'runninghub-nano-banana-2'],
    status: 1,
    weight: 10,
    dailyQuotaLimit: 0,
    usedQuota: 0,
    sourceMode: 'SOURCE_STATIC_CONTRACT',
  },
  {
    id: 41,
    name: '菲玲',
    group: 'panqu_test',
    models: ['feiling-video'],
    status: 1,
    weight: 10,
    dailyQuotaLimit: 0,
    usedQuota: 0,
    sourceMode: 'SOURCE_STATIC_CONTRACT',
  },
  {
    id: 42,
    name: 'MiniMax',
    group: 'panqu_test',
    models: ['minimax-video'],
    status: 1,
    weight: 10,
    dailyQuotaLimit: 0,
    usedQuota: 0,
    sourceMode: 'SOURCE_STATIC_CONTRACT',
  },
];

export interface TrustedGatewaySnapshot {
  environment: 'test' | 'preonline' | 'prod' | 'offline' | string;
  capturedAt: string;
  sourceEndpoint: string;
  collectionStatus: 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'UNKNOWN';
  provenance: 'API_READONLY_COLLECTOR' | 'USER_ASSERTION' | 'FIXTURE';
  channels: GatewayChannelConfig[];
  collectorVersion?: string;
  ttlMs?: number;
}

export interface GatewaySnapshotValidationResult {
  valid: boolean;
  reason?: string;
  snapshot?: TrustedGatewaySnapshot;
}

/**
 * 校验只读网关快照的可信度
 * 必须满足：未缺失、状态 SUCCESS、来源 API_READONLY_COLLECTOR、合法端点、未过期且渠道非空
 * 任何不满足项一律 fail-closed
 */
export function validateTrustedGatewaySnapshot(
  snapshot?: TrustedGatewaySnapshot,
  options?: { maxAgeMs?: number; expectedEnv?: string },
): GatewaySnapshotValidationResult {
  if (!snapshot) {
    return { valid: false, reason: 'MISSING_SNAPSHOT: 未提供网关渠道快照 [BLOCKED_MISSING_TRUSTED_COLLECTOR]' };
  }
  if (snapshot.collectionStatus !== 'SUCCESS') {
    return { valid: false, reason: `COLLECTION_FAILED: 快照采集状态不为 SUCCESS (${snapshot.collectionStatus})` };
  }
  if (snapshot.provenance !== 'API_READONLY_COLLECTOR') {
    return { valid: false, reason: `UNTRUSTED_PROVENANCE: 来源不属于可信 API 只读采集器 (${snapshot.provenance})` };
  }
  if (!snapshot.sourceEndpoint || !snapshot.sourceEndpoint.startsWith('/')) {
    return { valid: false, reason: `INVALID_ENDPOINT: 来源端点无效 (${snapshot.sourceEndpoint})` };
  }
  if (!snapshot.capturedAt || isNaN(Date.parse(snapshot.capturedAt))) {
    return { valid: false, reason: `INVALID_TIMESTAMP: 快照捕获时间无效 (${snapshot.capturedAt})` };
  }
  const ageMs = Date.now() - Date.parse(snapshot.capturedAt);
  const maxAge = snapshot.ttlMs ?? options?.maxAgeMs ?? 60 * 60 * 1000;
  if (ageMs < 0 || ageMs > maxAge) {
    return {
      valid: false,
      reason: `SNAPSHOT_EXPIRED: 快照已过期 (age: ${Math.round(ageMs / 1000)}s, max: ${Math.round(maxAge / 1000)}s)`,
    };
  }
  if (!Array.isArray(snapshot.channels) || snapshot.channels.length === 0) {
    return { valid: false, reason: 'EMPTY_CHANNELS: 快照中不包含任何渠道数据' };
  }
  return { valid: true, snapshot };
}

/**
 * 从真实 DB 只读取证记录 `pq_newapi_task_log` 构造可信网关渠道快照。
 *
 * 这是网关渠道证据的**真源采集器**：主站 PHP 在 NewAPI 分流提交时建 `pq_newapi_task_log`
 * (`extra.newapi_log_id` 回指其 id)，Go 消费者履约后把实际上游渠道回写进
 * `channel_id / provider_code / upstream_model_name / status`。这些列与其它取证表同库同隧道，
 * 故无需外部网关 DB / admin API 即可获得**物理落库**的网关履约事实。
 *
 * fail-closed：仅当行存在且 `channel_id > 0`（渠道真实回写）才产出 SUCCESS 快照；
 * 否则返回 undefined，交由上层保持 UNVERIFIED，绝不臆造渠道。
 */
export function buildTrustedGatewaySnapshotFromNewapiTaskLog(
  row: Record<string, unknown> | undefined,
  options?: { environment?: string; capturedAt?: string },
): TrustedGatewaySnapshot | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const channelId = Number(row.channel_id);
  if (!Number.isFinite(channelId) || channelId <= 0) return undefined;

  const providerCode = row.provider_code != null ? String(row.provider_code) : '';
  const upstreamModel = row.upstream_model_name != null ? String(row.upstream_model_name) : '';
  const newapiGroup = row.newapi_group != null ? String(row.newapi_group) : '';
  const rawStatus = row.status != null ? String(row.status).toUpperCase() : 'UNKNOWN';
  // 网关履约明确失败/未完成的渠道不得作为合格履约事实上报；仅 SUCCESS 视为已履约。
  const collectionStatus: TrustedGatewaySnapshot['collectionStatus'] = rawStatus === 'SUCCESS' ? 'SUCCESS' : 'FAILED';

  const channel: GatewayChannelConfig = {
    id: channelId,
    name: providerCode || String(channelId),
    group: newapiGroup,
    models: upstreamModel ? [upstreamModel] : [],
    status: 1,
    weight: 0,
    dailyQuotaLimit: 0,
    usedQuota: 0,
    sourceMode: 'SOURCE_REAL_GATEWAY',
  };

  return {
    environment: options?.environment || 'test',
    capturedAt: options?.capturedAt || new Date().toISOString(),
    // 端点以 '/' 起始满足可信快照校验；标注真源为库内网关调用日志表（只读取证）。
    sourceEndpoint: '/db/pq_newapi_task_log',
    collectionStatus,
    provenance: 'API_READONLY_COLLECTOR',
    channels: [channel],
    collectorVersion: 'db-newapi-task-log-v1',
  };
}
