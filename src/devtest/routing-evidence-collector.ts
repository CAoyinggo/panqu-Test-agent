/**
 * RoutingEvidenceCollector - 全链路分流路由证据采集与跨系统标识对齐器
 *
 * 核心原则：
 * 1. 使用 taskId 和可用的 requestId / traceId 强绑定主站、网关与消费端
 * 2. 严禁使用“最新一条日志”猜测归属，必须建立跨系统显式 ID 映射
 * 3. 采集主站 extra 快照、网关 pq_newapi_task_log、降级重试 pq_aivideo_diversion_retrylog
 * 4. 缺少底层实际路由证据时，严格标记未验证 (UNVERIFIED / BLOCKED)，不能报分流通过
 */

import type { FlowMediaType, FlowStepStatus } from './panqu-playwright-engine.js';
import type { MainSiteRoutingVerdict, GatewayRoutingVerdict, FallbackRoutingVerdict } from './routing-oracle.js';

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
  newapiTaskId?: string; // task_xxx
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
  status?: string; // INIT, SUBMITTING, SUBMITTED, IN_PROGRESS, SUCCESS, FAILED
  requestPayloadMasked?: string;
  submitResponseMasked?: string;
  queryCount?: number;
}

export interface FallbackRetryLogEvidence {
  retryLogId?: number;
  id?: number;
  taskId?: number;
  task_id?: number;
  sourceId?: number;
  source_id?: number;
  fallbackTaskId?: string; // cgt-xxx
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

export class RoutingEvidenceCollector {
  /**
   * 解析主站任务行中的 extra 字段
   */
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

  /**
   * 关联与校验全链路路由证据
   */
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

    // 1. 提取主站证据
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

    // 2. 提取网关证据
    let gatewayEvidence: GatewayTaskLogEvidence | undefined;
    if (params.gatewayLog) {
      // 强校验 ai_task_id 或 newapi_log_id
      const matchesTaskId = params.gatewayLog.ai_task_id && Number(params.gatewayLog.ai_task_id) === Number(taskId);
      const matchesLogId =
        mainSiteEvidence?.parsedExtra.newapi_log_id &&
        params.gatewayLog.id &&
        Number(params.gatewayLog.id) === Number(mainSiteEvidence.parsedExtra.newapi_log_id);

      if (!matchesTaskId && !matchesLogId) {
        reasons.push(`网关日志与主任务未建立显式 ID 绑定 (logTaskId=${params.gatewayLog.ai_task_id})，拒绝归属`);
      } else {
        gatewayEvidence = {
          logId: params.gatewayLog.id,
          aiTaskId: params.gatewayLog.ai_task_id,
          newapiTaskId: params.gatewayLog.newapi_task_id,
          channelId: params.gatewayLog.channel_id,
          channelName: params.gatewayLog.channel_name,
          providerCode: params.gatewayLog.provider_code,
          upstreamModelName: params.gatewayLog.upstream_model_name,
          upstreamTaskId: params.gatewayLog.upstream_task_id,
          status: params.gatewayLog.status,
        };
      }
    }

    // 3. 提取兜底重试证据
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

    // 4. 构建跨系统 ID 映射
    const idMap: CrossSystemIdMap = {
      mainTaskId: taskId,
      newapiLogId: mainSiteEvidence?.parsedExtra.newapi_log_id || gatewayEvidence?.logId,
      newapiTaskId: gatewayEvidence?.newapiTaskId,
      upstreamTaskId: gatewayEvidence?.upstreamTaskId,
      fallbackTaskId: fallbackEvidence?.fallbackTaskId,
    };

    // 5. 核心断言判定
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
    let actualDiverted = false;

    if (mediaType === 'video') {
      actualDiverted = Number(actualExtra.diversion ?? mainSiteEvidence!.line) === 10;
    } else {
      actualDiverted = Number(actualExtra.newapi_image ?? 0) === 1;
    }

    // 校验主站预期
    if (expectedMainSite.willDivert && !actualDiverted) {
      reasons.push(
        `主站路由不匹配: 预期进入 NewAPI 分流 (${expectedMainSite.decision})，实际为直连或回退 (diversion=${actualExtra.diversion ?? 0}, newapi_image=${actualExtra.newapi_image ?? 0})`
      );
    } else if (!expectedMainSite.willDivert && actualDiverted) {
      reasons.push(
        `主站路由不匹配: 预期走原线路/直连 (${expectedMainSite.decision})，实际意外触发了 NewAPI 分流`
      );
    }

    // 校验路由快照关键属性 (如组织、分组、模型别名)
    if (expectedMainSite.willDivert && expectedMainSite.expectedSnapshot) {
      const exp = expectedMainSite.expectedSnapshot;
      if (exp.orgId !== undefined && actualExtra.newapi_org_id !== undefined && Number(actualExtra.newapi_org_id) !== exp.orgId) {
        if (exp.orgId !== 0 && Number(actualExtra.newapi_org_id) !== 0 && Number(actualExtra.newapi_org_id) !== exp.orgId) {
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

    // 校验网关渠道是否在允许集合内
    if (actualDiverted && expectedGateway) {
      if (gatewayEvidence) {
        const actualChannelName = gatewayEvidence.channelName || actualExtra.channel_name;
        const actualChannelId = gatewayEvidence.channelId || actualExtra.channel_id;

        if (expectedGateway.candidateChannelIds.length > 0) {
          const idMatched = actualChannelId ? expectedGateway.candidateChannelIds.includes(Number(actualChannelId)) : false;
          const nameMatched = actualChannelName ? expectedGateway.allowedChannels.includes(String(actualChannelName)) : false;

          if (!idMatched && !nameMatched) {
            reasons.push(
              `网关调度渠道非法: 实际渠道 (${actualChannelName || actualChannelId}) 不在合法候选集合 [${expectedGateway.allowedChannels.join(', ')}] 内`
            );
          }
        }
      } else if (params.requireGatewayEvidence) {
        reasons.push('已验证主站分流快照，但未采集到网关底层调度日志，实际网关渠道未验真');
      }
    }

    // 校验降级路径 (仅当任务失败或显式提供了降级证据时)
    if (expectedFallback && (mainSiteEvidence?.status === 3 || gatewayEvidence?.status === 'FAILED' || fallbackEvidence)) {
      if (expectedFallback.recordRetryLog && !fallbackEvidence) {
        reasons.push(`任务失败时预期触发火山兜底降级并记录 retrylog，但未采集到对应的 retrylog 证据`);
      } else if (!expectedFallback.recordRetryLog && fallbackEvidence) {
        reasons.push(`预期不进入兜底重试列表，但采集到了异常的 retrylog 记录`);
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
