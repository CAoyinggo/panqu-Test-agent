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

export interface MainSiteTaskRowEvidence {
  taskId: number;
  line: number;
  status: number;
  extraRaw?: string | Record<string, unknown>;
  parsedExtra: {
    diversion?: number;
    newapi_image?: number;
    newapi_org_id?: number;
    newapi_route_group_id?: number;
    newapi_group?: string;
    newapi_model?: string;
    newapi_log_id?: number;
    channel_id?: number;
    channel_name?: string;
    points?: number;
    [key: string]: unknown;
  };
}

export interface GatewayTaskLogEvidence {
  logId?: number;
  id?: number;
  aiTaskId?: number;
  ai_task_id?: number;
  newapiTaskId?: string;
  newapi_task_id?: string;
  channelId?: number;
  channel_id?: number;
  channelName?: string;
  channel_name?: string;
  providerCode?: string;
  provider_code?: string;
  upstreamModelName?: string;
  upstream_model_name?: string;
  upstreamTaskId?: string;
  upstream_task_id?: string;
  status?: string;
}

export interface FallbackRetryLogEvidence {
  retryLogId?: number;
  id?: number;
  taskId?: number;
  task_id?: number;
  sourceId?: number;
  source_id?: number;
  fallbackTaskId?: string;
  fallback_task_id?: string;
  originalError?: string;
  err_msg?: string;
  status?: number;
}

export interface CrossSystemIdMap {
  mainTaskId: number;
  newapiLogId?: number;
  newapiTaskId?: string;
  upstreamTaskId?: string;
  fallbackTaskId?: string;
}

export interface CollectedRoutingEvidence {
  mediaType: FlowMediaType;
  idMap: CrossSystemIdMap;
  mainSite?: MainSiteTaskRowEvidence;
  gatewayLog?: GatewayTaskLogEvidence;
  fallbackLog?: FallbackRetryLogEvidence;
  hasDirectProof: boolean;
  evidenceState: 'VERIFIED' | 'UNVERIFIED' | 'MISMATCH';
  verificationStatus: FlowStepStatus;
  reasons: string[];
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

export class RoutingEvidenceCollector {
  public static parseExtra(rawExtra?: string | Record<string, unknown>): Record<string, unknown> {
    if (!rawExtra) return {};
    if (typeof rawExtra === 'object' && rawExtra !== null) return rawExtra;
    if (typeof rawExtra === 'string') {
      try {
        const parsed = JSON.parse(rawExtra);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }

  public static correlateAndVerify(params: {
    taskId: number;
    mediaType: FlowMediaType;
    expectedMainSite: MainSiteRoutingVerdict;
    expectedGateway?: GatewayRoutingVerdict;
    expectedFallback?: FallbackRoutingVerdict;
    mainSiteRow?: {
      id: number;
      line?: number;
      status?: number;
      extra?: string | Record<string, unknown>;
    };
    gatewayLog?: GatewayTaskLogEvidence;
    fallbackLog?: FallbackRetryLogEvidence;
    requireGatewayEvidence?: boolean;
  }): CollectedRoutingEvidence {
    const { taskId, mediaType, expectedMainSite, expectedGateway, expectedFallback } = params;
    const reasons: string[] = [];

    let mainSiteEvidence: MainSiteTaskRowEvidence | undefined;
    if (params.mainSiteRow) {
      if (Number(params.mainSiteRow.id) !== Number(taskId)) {
        reasons.push(`主站任务 ID 冲突: 请求 ${taskId} vs 证据行 ${params.mainSiteRow.id}，拒绝归属`);
      } else {
        const parsed = this.parseExtra(params.mainSiteRow.extra);
        mainSiteEvidence = {
          taskId,
          line: Number(params.mainSiteRow.line ?? parsed.diversion ?? 0),
          status: Number(params.mainSiteRow.status ?? 0),
          extraRaw: params.mainSiteRow.extra,
          parsedExtra: parsed as MainSiteTaskRowEvidence['parsedExtra'],
        };
      }
    }

    let gatewayEvidence: GatewayTaskLogEvidence | undefined;
    if (params.gatewayLog) {
      const gatewayTaskId = params.gatewayLog.ai_task_id ?? params.gatewayLog.aiTaskId;
      const gatewayLogId = params.gatewayLog.id ?? params.gatewayLog.logId;
      const matchesTaskId = gatewayTaskId !== undefined && Number(gatewayTaskId) === Number(taskId);
      const matchesLogId =
        mainSiteEvidence?.parsedExtra.newapi_log_id &&
        gatewayLogId &&
        Number(gatewayLogId) === Number(mainSiteEvidence.parsedExtra.newapi_log_id);

      if (!matchesTaskId && !matchesLogId) {
        reasons.push(`网关日志与主任务未建立显式 ID 绑定 (logTaskId=${gatewayTaskId})，拒绝归属`);
      } else {
        gatewayEvidence = {
          logId: gatewayLogId,
          aiTaskId: gatewayTaskId,
          newapiTaskId: params.gatewayLog.newapi_task_id ?? params.gatewayLog.newapiTaskId,
          channelId: params.gatewayLog.channel_id ?? params.gatewayLog.channelId,
          channelName: params.gatewayLog.channel_name ?? params.gatewayLog.channelName,
          providerCode: params.gatewayLog.provider_code ?? params.gatewayLog.providerCode,
          upstreamModelName: params.gatewayLog.upstream_model_name ?? params.gatewayLog.upstreamModelName,
          upstreamTaskId: params.gatewayLog.upstream_task_id ?? params.gatewayLog.upstreamTaskId,
          status: params.gatewayLog.status,
        };
      }
    }

    let fallbackEvidence: FallbackRetryLogEvidence | undefined;
    if (params.fallbackLog) {
      const fbTaskId = params.fallbackLog.task_id ?? params.fallbackLog.taskId;
      if (fbTaskId !== undefined && Number(fbTaskId) !== Number(taskId)) {
        reasons.push(`兜底日志任务 ID (${fbTaskId}) 与主任务 ID (${taskId}) 不匹配`);
      } else {
        fallbackEvidence = {
          retryLogId: params.fallbackLog.retryLogId ?? params.fallbackLog.id,
          taskId: Number(fbTaskId ?? taskId),
          sourceId: params.fallbackLog.sourceId ?? params.fallbackLog.source_id,
          fallbackTaskId: params.fallbackLog.fallbackTaskId ?? params.fallbackLog.fallback_task_id,
          originalError: params.fallbackLog.originalError ?? params.fallbackLog.err_msg,
          status: params.fallbackLog.status,
        };
      }
    }

    const idMap: CrossSystemIdMap = {
      mainTaskId: taskId,
      newapiLogId: mainSiteEvidence?.parsedExtra.newapi_log_id || gatewayEvidence?.logId,
      newapiTaskId: gatewayEvidence?.newapiTaskId,
      upstreamTaskId: gatewayEvidence?.upstreamTaskId,
      fallbackTaskId: fallbackEvidence?.fallbackTaskId,
    };

    const hasDirectProof = Boolean(mainSiteEvidence && Object.keys(mainSiteEvidence.parsedExtra).length > 0);
    if (!hasDirectProof) {
      return {
        mediaType,
        idMap,
        mainSite: mainSiteEvidence,
        gatewayLog: gatewayEvidence,
        fallbackLog: fallbackEvidence,
        hasDirectProof: false,
        evidenceState: 'UNVERIFIED',
        verificationStatus: 'BLOCKED',
        reasons: ['缺少主站底层 extra 路由快照直接证据，严禁假设分流通过'],
      };
    }

    const actualExtra = mainSiteEvidence!.parsedExtra;
    const actualDiverted = mediaType === 'video'
      ? Number(actualExtra.diversion ?? mainSiteEvidence!.line) === 10
      : Number(actualExtra.newapi_image ?? 0) === 1;

    if (expectedMainSite.willDivert && !actualDiverted) {
      reasons.push(`主站路由不匹配: 预期进入 NewAPI 分流 (${expectedMainSite.decision})，实际为直连或回退`);
    } else if (!expectedMainSite.willDivert && actualDiverted) {
      reasons.push(`主站路由不匹配: 预期走原线路/直连 (${expectedMainSite.decision})，实际意外触发了 NewAPI 分流`);
    }

    if (expectedMainSite.willDivert && expectedMainSite.expectedSnapshot) {
      const exp = expectedMainSite.expectedSnapshot;
      if (exp.orgId !== undefined && actualExtra.newapi_org_id !== undefined && Number(actualExtra.newapi_org_id) !== exp.orgId) {
        if (exp.orgId !== 0 && Number(actualExtra.newapi_org_id) !== 0) {
          reasons.push(`路由快照组织 ID 不一致: 预期 org_id=${exp.orgId}, 实际 newapi_org_id=${actualExtra.newapi_org_id}`);
        }
      }
      if (exp.newapiGroup && actualExtra.newapi_group && String(actualExtra.newapi_group) !== exp.newapiGroup) {
        reasons.push(`路由快照分组不一致: 预期 group='${exp.newapiGroup}', 实际 newapi_group='${actualExtra.newapi_group}'`);
      }
      if (exp.newapiModel && actualExtra.newapi_model && String(actualExtra.newapi_model) !== exp.newapiModel) {
        reasons.push(`路由快照模型别名不一致: 预期 model='${exp.newapiModel}', 实际 newapi_model='${actualExtra.newapi_model}'`);
      }
    }

    if (actualDiverted && expectedGateway) {
      if (gatewayEvidence) {
        const actualChannelName = gatewayEvidence.channelName || actualExtra.channel_name;
        const actualChannelId = gatewayEvidence.channelId || actualExtra.channel_id;
        if (expectedGateway.candidateChannelIds.length > 0) {
          const idMatched = actualChannelId ? expectedGateway.candidateChannelIds.includes(Number(actualChannelId)) : false;
          const nameMatched = actualChannelName ? expectedGateway.allowedChannels.includes(String(actualChannelName)) : false;
          if (!idMatched && !nameMatched) {
            reasons.push(`网关调度渠道非法: 实际渠道 (${actualChannelName || actualChannelId}) 不在合法候选集合 [${expectedGateway.allowedChannels.join(', ')}] 内`);
          }
        }
      } else if (params.requireGatewayEvidence) {
        reasons.push('已验证主站分流快照，但未采集到网关底层调度日志，实际网关渠道未验真');
      }
    }

    if (expectedFallback && (mainSiteEvidence?.status === 3 || gatewayEvidence?.status === 'FAILED' || fallbackEvidence)) {
      if (expectedFallback.recordRetryLog && !fallbackEvidence) {
        reasons.push('任务失败时预期触发火山兜底降级并记录 retrylog，但未采集到对应的 retrylog 证据');
      } else if (!expectedFallback.recordRetryLog && fallbackEvidence) {
        reasons.push('预期不进入兜底重试列表，但采集到了异常的 retrylog 记录');
      }
    }

    let evidenceState: 'VERIFIED' | 'UNVERIFIED' | 'MISMATCH' = 'VERIFIED';
    if (!hasDirectProof || reasons.some((r) => r.includes('未采集到') || r.includes('未验真'))) {
      evidenceState = 'UNVERIFIED';
    } else if (reasons.length > 0) {
      evidenceState = 'MISMATCH';
    }

    const passed = reasons.length === 0;
    const verificationStatus: FlowStepStatus = passed ? 'PASS' : evidenceState === 'UNVERIFIED' ? 'BLOCKED' : 'FAIL';

    return {
      mediaType,
      idMap,
      mainSite: mainSiteEvidence,
      gatewayLog: gatewayEvidence,
      fallbackLog: fallbackEvidence,
      hasDirectProof: true,
      evidenceState,
      verificationStatus,
      reasons,
    };
  }
}
