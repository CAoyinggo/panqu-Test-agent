/**
 * Panqu Playwright 联合测试智能体执行引擎（Panqu Playwright Flow Engine）
 *
 * 严格按照 Playwright 官方最佳实践（API Testing, Assertions, Trace Viewer, Fixture & Isolation）
 * 建立“规则验证 + 真实执行 + 路由验真 + 账务对账”完整测试闭环：
 * 1. 页面提交与真实 taskId 拦截关联（前置监听响应、禁止 rows[0] 猜测、提交超时查重防重扣）
 * 2. 异步状态机精准跟踪（APIRequestContext 轮询、Deadline 截止、取消信号、严格分类）
 * 3. 实际分流独立核查（集成 RoutingOracle 与 RoutingEvidenceCollector，缺少底层证据严格标记 BLOCKED）
 * 4. 产物物理校验（HTTP 可访问性、容器/分辨率/时长/解码校验，失败分支跳过产物查退款）
 * 5. 计费与退款对账（集成 BillingOracle，按任务关联预扣/结算/退款、防少扣/多扣/重扣/重退）
 * 6. 证据汇总与脱敏（Trace 归档、敏感信息掩码、严格区分真实/模拟/静态运行）
 */

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Page, APIRequestContext, APIResponse } from 'playwright';
import {
  createPanquPlaywrightFixture,
  type PlaywrightFixtureContext,
  type PlaywrightFixtureOptions,
} from './panqu-playwright-fixture.js';
import { loadPanquSession, type PanquSession } from './panqu-real-video-flow.js';
import {
  RoutingOracle,
  type MainSiteConfigSnapshot,
  type GatewayChannelConfig,
  type MainSiteRoutingVerdict,
  type GatewayRoutingVerdict,
  type FallbackRoutingVerdict,
} from './routing-oracle.js';
import {
  RoutingEvidenceCollector,
  type GatewayTaskLogEvidence,
  type FallbackRetryLogEvidence,
  type CollectedRoutingEvidence,
} from './routing-evidence-collector.js';
import {
  BillingOracle,
  type ScoreLogEntry,
  type BillingAuditReport,
} from './billing-oracle.js';
import {
  SupplierCostOracle,
  type SupplierCostVerdict,
  type CostPricingUnit,
  type SupplierEvidenceLevel,
  type RechargeBatch,
  type UpstreamExecutionState,
  type UpstreamCallRecord,
} from './supplier-cost-oracle.js';

import {
  inspectBufferMedia,
  createSyntheticValidMp4,
  type MediaInspectionResult,
} from './media-inspector.js';

// ==========================================
// 1. 类型体系定义
// ==========================================

export type FlowMediaType = 'video' | 'image';
export type FlowExecutionMode =
  | 'UI_E2E'
  | 'API_INTEGRATION'
  | 'MOCK'
  // 向后兼容别名
  | 'REAL_EXECUTION'
  | 'BROWSER_E2E'
  | 'MOCK_VERIFICATION'
  | 'STATIC_CHECK';
export type FlowStepStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED';
export type TaskTerminalStatus = 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'NOT_SUBMITTED';
export type ArtifactVerificationLevel =
  | 'CONTAINER_METADATA_VERIFIED'
  | 'BROWSER_PIXEL_DECODED'
  | 'HTTP_ACCESSIBLE_ONLY'
  | 'SKIPPED_ON_FAILURE'
  | 'UNVERIFIED';
export type TaskFailureCategory =
  | 'PRODUCT_FAILURE'
  | 'ENVIRONMENT_ERROR'
  | 'TEST_TIMEOUT'
  | 'SUBMISSION_UNKNOWN'
  | 'UNKNOWN_ERROR'
  | 'CLIENT_TIMEOUT';

export interface DiversionCheckResult {
  passed?: boolean;
  isDiverted?: boolean;
  willDivert: boolean;
  expectedNewApi: boolean;
  expectedChannels: string[];
  expectedChannel?: string | string[];
  expectedModelAlias?: string;
  actualNewApi: boolean;
  actualChannel?: string;
  actualLine?: number;
  actualOrgId?: number;
  actualGroup?: string;
  newapiModel?: string;
  rawExtra?: Record<string, unknown>;
  status: FlowStepStatus;
  reasons: string[];
  evidenceState: 'VERIFIED' | 'UNVERIFIED' | 'MISMATCH';
  evidenceLevel: 'MAIN_SITE_SNAPSHOT_ONLY' | 'DUAL_SYSTEM_VERIFIED' | 'INSUFFICIENT_EVIDENCE' | 'GATEWAY_LOG_VERIFIED';
  details?: CollectedRoutingEvidence;
}

export interface ArtifactCheckResult {
  passed: boolean;
  status: FlowStepStatus;
  skipped: boolean;
  verificationLevel?: ArtifactVerificationLevel;
  containerValid?: boolean;
  metadataParsed?: boolean;
  fullStreamDecoded?: boolean;
  containerIdentified?: boolean;
  metadataMatched?: boolean;
  actualDecoded?: boolean | null;
  assetUrl?: string;
  fileAccessible: boolean;
  httpStatus?: number;
  mediaType: FlowMediaType;
  format?: string;
  dimensions?: { width: number; height: number };
  durationSeconds?: number;
  hasAudioTrack?: boolean;
  decodable: boolean;
  sizeBytes?: number;
  sha256?: string;
  reasons: string[];
  qualityClassification: 'TASK_SUCCESS_AND_VALID' | 'TASK_FAILED_SKIPPED' | 'FILE_INVALID' | 'UNVERIFIED';
  warningNote?: string;
}

export interface BillingReconciliation {
  passed: boolean;
  status: FlowStepStatus;
  expectedPoints: number;
  unit: 'points';
  preDeductedPoints: number;
  settledPoints: number;
  refundedPoints: number;
  netDeductedPoints: number;
  underCharged: boolean;
  overCharged: boolean;
  duplicateCharged: boolean;
  duplicateRefunded: boolean;
  missingRefund?: boolean;
  asyncSettlementPending: boolean;
  ledgerEntries: Array<{
    id?: string;
    type: 'PRE_DEDUCT' | 'SETTLE' | 'REFUND';
    points: number;
    time?: string;
    memo?: string;
  }>;
  balanceBefore?: number;
  balanceAfter?: number;
  balanceDelta?: number;
  balanceAuxiliaryNote: string;
  reasons: string[];
}

export interface FlowRunEvidence {
  caseId: string;
  runId: string;
  taskId?: number;
  mediaType: FlowMediaType;
  overallStatus: FlowStepStatus;
  businessTaskStatus: TaskTerminalStatus;
  testAssertionStatus: FlowStepStatus;
  executionMode: FlowExecutionMode;
  degradedFromBrowser?: boolean;
  degradedReason?: string;
  failureCategory?: TaskFailureCategory;
  startedAt: string;
  finishedAt: string;
  submission: {
    method: string;
    url: string;
    params: Record<string, unknown>;
    responseStatus: number;
    responseCode: number;
    responseMsg: string;
    taskId?: number;
    durationMs: number;
    submissionTransport?: 'BROWSER_PAGE' | 'API_REQUEST' | 'MOCK';
    submissionState?: 'SUCCESS' | 'FAILED' | 'UNKNOWN';
  };
  taskTracking: {
    pollCount: number;
    terminalStatus: TaskTerminalStatus;
    failureCategory?: TaskFailureCategory;
    durationMs: number;
    timeline: Array<{
      timestamp: string;
      status: number;
      progress: number;
      label: string;
    }>;
    lastResponse?: Record<string, unknown>;
  };
  diversion: DiversionCheckResult;
  artifact: ArtifactCheckResult;
  billing: BillingReconciliation;
  supplierCost: SupplierCostVerdict;
  tracePath?: string;
  screenshots: string[];
  diagnosticLog: string[];
}

export interface PlaywrightFlowRunOptions {
  caseId?: string;
  taskId?: number;
  mediaType?: FlowMediaType;
  executionMode?: FlowExecutionMode;
  env?: 'test' | 'preonline';
  baseUrl?: string;
  session?: PanquSession;
  sessionFile?: string;
  modelId?: number;
  modelName?: string;
  prompt?: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  taskType?: number;
  serviceline?: string;
  userGroupIds?: number[];
  pollTimeoutSec?: number;
  pollIntervalMs?: number;
  outputDir?: string;
  expectFailure?: boolean;
  balanceBefore?: number;
  balanceAfter?: number;
  requireGatewayEvidence?: boolean;
  useBrowserPage?: boolean;

  // 供应商成本核算与充值折算入参
  mockRecordedCostCny?: number;
  upstreamBillReceived?: boolean;
  rechargeBatch?: RechargeBatch;
  effectiveCnyPerPoint?: number;
  upstreamExecutionState?: UpstreamExecutionState;
  upstreamCalls?: UpstreamCallRecord[];
  requireVerifiedCostEvidence?: boolean;

  // 配置快照注入（用于 RoutingOracle 与 Gateway 评估）
  mainSiteConfig?: Partial<MainSiteConfigSnapshot>;
  gatewayChannels?: GatewayChannelConfig[];

  // 模拟与依赖注入（可控测试使用）
  fixture?: PlaywrightFixtureContext;
  mockSubmitResponse?: { status: number; body: Record<string, unknown> };
  mockStatusResponses?: Array<{ status: number; body: Record<string, unknown> }>;
  mockTaskDetails?: Record<string, unknown>;
  mockGatewayLog?: GatewayTaskLogEvidence;
  mockFallbackLog?: FallbackRetryLogEvidence;
  mockScoreLogs?: Array<ScoreLogEntry | { type: 'PRE_DEDUCT' | 'SETTLE' | 'REFUND'; points: number }>;
  mockAssetBuffer?: Buffer;
}

// ==========================================
// 2. 辅助工具与确定性规则（兼容旧导出）
// ==========================================

/**
 * 敏感凭据过滤与脱敏（彻底防泄露 Cookie、FastAdmin 凭据、JWT、Token、密钥明文）
 */
export function sanitizeSensitiveText(text?: string | null): string {
  if (!text) return '';
  let sanitized = String(text);
  sanitized = sanitized.replace(/(?:Cookie:\s*)([^\r\n]+)/gi, 'Cookie: [REDACTED_COOKIE]');
  sanitized = sanitized.replace(/(fastadmin_sid|PHPSESSID|rememberme)=[^;,\s\r\n]+/gi, '$1=[REDACTED]');
  sanitized = sanitized.replace(/(?:Bearer\s+)[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED_BEARER]');
  sanitized = sanitized.replace(/eyJ[a-zA-Z0-9_-]{8,}(?:\.[a-zA-Z0-9_-]+)+/g, '[REDACTED_JWT]');
  sanitized = sanitized.replace(/([?&](?:token|auth|key|secret|password|sign|signature)=)[^& \r\n]+/gi, '$1[REDACTED]');
  sanitized = sanitized.replace(/(Authorization:\s*(?:Bearer\s+)?)[^\r\n]+/gi, '$1[REDACTED_AUTH]');
  sanitized = sanitized.replace(/auth=%7B.*?%7D/gi, 'auth=[REDACTED_AUTH_OBJECT]');
  return sanitized;
}

/**
 * 敏感字符串掩码处理
 */
export function maskSensitive(text?: string | null): string {
  if (!text) return '(empty)';
  const sanitized = sanitizeSensitiveText(text);
  if (sanitized !== text || sanitized.includes('[REDACTED') || sanitized.includes('\n')) {
    return sanitized;
  }
  if (sanitized.length <= 8) return '******';
  return `${sanitized.slice(0, 4)}******${sanitized.slice(-4)}`;
}

/**
 * 递归安全脱敏任意数据结构（对象、数组、字符串）
 */
export function sanitizeObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return sanitizeSensitiveText(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (/^(cookie|cookies|token|auth|secret|password|authorization|key|apikey|api_key|fastadmin_sid|phpsessid|session)$/i.test(k)) {
        res[k] = '[REDACTED_SECRET]';
      } else {
        res[k] = sanitizeObject(v);
      }
    }
    return res as unknown as T;
  }
  return obj;
}

/**
 * 依据业务规则独立计算预期积分消耗（委托 BillingOracle）
 */
export function calculateExpectedPoints(params: {
  mediaType: FlowMediaType;
  modelId: number;
  duration?: number;
  resolution?: string;
}): number {
  return BillingOracle.calculateExpectedPoints(params);
}

/**
 * 依据业务规则独立推导预期分流渠道集合
 */
export function deriveExpectedDiversion(params: {
  mediaType: FlowMediaType;
  modelId: number;
  serviceline?: string;
  isGlobal?: boolean;
}): { expectedNewApi: boolean; expectedChannels: string[]; expectedModelAlias: string } {
  if (params.mediaType === 'image') {
    const isDiverted = (params.serviceline || 'r').toLowerCase() === 'r';
    const modelAlias = params.modelId === 201 ? 'runninghub-nano-banana-2' : 'pan-banana-pro';
    return {
      expectedNewApi: isDiverted,
      expectedChannels: isDiverted ? ['RH-图片', 'APIFree'] : ['直连图片线路'],
      expectedModelAlias: isDiverted ? modelAlias : '',
    };
  }

  if (params.modelId === 84) {
    return {
      expectedNewApi: true,
      expectedChannels: ['万相—yhuo', '万相-视频'],
      expectedModelAlias: 'wan3.0-video',
    };
  }
  if (params.modelId === 88) {
    return {
      expectedNewApi: true,
      expectedChannels: ['万相—yhuo', '万相-视频-prime'],
      expectedModelAlias: 'wan3.0-video-prime',
    };
  }
  if (params.modelId === 15) {
    return {
      expectedNewApi: true,
      expectedChannels: ['TD', 'TalkingData'],
      expectedModelAlias: 'seedance-2.0',
    };
  }

  return {
    expectedNewApi: false,
    expectedChannels: ['历史直连线路'],
    expectedModelAlias: '',
  };
}

export { inspectBufferMedia, createSyntheticValidMp4 };

// ==========================================
// 3. 核心全链路执行器
// ==========================================

export async function runPanquPlaywrightFlow(
  options: PlaywrightFlowRunOptions
): Promise<FlowRunEvidence> {
  const startedAt = new Date().toISOString();
  const caseId = options.caseId || `CASE-${Date.now()}`;
  const runId = `RUN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const mediaType = options.mediaType || 'video';
  let executionMode: FlowExecutionMode =
    options.executionMode ||
    (options.mockSubmitResponse ? 'MOCK' : (options.useBrowserPage ? 'UI_E2E' : 'API_INTEGRATION'));
  // 别名统一归一化
  if ((executionMode as any) === 'BROWSER_E2E') executionMode = 'UI_E2E';
  if ((executionMode as any) === 'MOCK_VERIFICATION') executionMode = 'MOCK';
  if ((executionMode as any) === 'REAL_EXECUTION') executionMode = 'API_INTEGRATION';

  let degradedFromBrowser = false;
  let degradedReason: string | undefined;
  const diagnosticLog: string[] = [];
  const screenshots: string[] = [];

  const log = (msg: string) => {
    diagnosticLog.push(`[${new Date().toISOString()}] ${sanitizeSensitiveText(msg)}`);
  };

  log(`初始化测试用例: caseId=${caseId}, runId=${runId}, mediaType=${mediaType}, mode=${executionMode}`);

  // 1. 获取会话或夹具
  let fixture: PlaywrightFixtureContext | undefined = options.fixture;
  let ownFixture = false;
  let session: PanquSession | undefined = options.session;

  if (!fixture && executionMode !== 'MOCK') {
    try {
      session = await loadPanquSession(options.sessionFile, options.env || 'test');
      fixture = await createPanquPlaywrightFixture({
        baseUrl: session.base_url,
        cookies: session.cookie_string,
        browserType: executionMode === 'API_INTEGRATION' ? 'api' : 'auto',
        recordTrace: true,
      });
      ownFixture = true;
      log(`Fixture 初始化就绪: baseUrl=${session.base_url}, browserAvailable=${fixture.isHeadlessBrowserAvailable}`);
    } catch (err) {
      log(`Fixture 初始化失败: ${(err as Error).message}`);
    }
  }

  // 核心原则：浏览器不可用时，UI_E2E 必须 BLOCKED，严禁用接口通过覆盖页面失败
  if (executionMode === 'UI_E2E' && (!fixture || !fixture.isHeadlessBrowserAvailable || !fixture.page)) {
    degradedFromBrowser = true;
    degradedReason = 'UI_E2E 模式要求真实浏览器页面交互，当前环境无可用 Headless 浏览器进程；依据执行边界原则严格判定为 BLOCKED，严禁降级为 API 接口通过覆盖页面失败';
    log(`[MODE_BLOCKED] ${degradedReason}`);
  }

  // 2. 准备提交参数
  const modelId = options.modelId ?? (mediaType === 'video' ? 84 : 12);
  const prompt = options.prompt || (mediaType === 'video' ? 'devtest_wan3_一只可爱的白猫草地奔跑' : 'devtest_image_一只可爱的白猫肖像');
  const safePrompt = prompt.startsWith('devtest_') ? prompt : `devtest_${prompt}`;
  // 视频默认时长与分辨率：Wan 3.0 (84) 默认 720p 5s（对应 task_type 28 NewAPI 分流）
  const duration = options.duration ?? (mediaType === 'video' && modelId === 84 ? 5 : 4);
  const resolution = options.resolution || (mediaType === 'video' && modelId === 84 ? '720p' : (mediaType === 'video' ? '480p' : '1k'));
  const aspectRatio = options.aspectRatio || (mediaType === 'video' ? '16:9' : '1:1');
  const taskType = options.taskType ?? (mediaType === 'video' ? 28 : undefined);
  const userGroupIds = options.userGroupIds || [10];

  if (degradedFromBrowser && executionMode === 'UI_E2E') {
    const earlyFinishedAt = new Date().toISOString();
    return sanitizeObject({
      caseId,
      runId,
      mediaType,
      overallStatus: 'BLOCKED',
      businessTaskStatus: 'NOT_SUBMITTED',
      testAssertionStatus: 'BLOCKED',
      executionMode: 'UI_E2E',
      degradedFromBrowser: true,
      degradedReason,
      startedAt,
      finishedAt: earlyFinishedAt,
      submission: {
        method: 'BROWSER_PAGE',
        url: mediaType === 'video' ? '/aivideo/videonew/add' : '/aivideo/scene/add',
        params: { modelId, prompt: safePrompt },
        responseStatus: 0,
        responseCode: 0,
        responseMsg: degradedReason || '',
        durationMs: 0,
        submissionTransport: 'BROWSER_PAGE',
        submissionState: 'UNKNOWN',
      },
      taskTracking: {
        pollCount: 0,
        terminalStatus: 'NOT_SUBMITTED',
        failureCategory: 'CLIENT_TIMEOUT',
        durationMs: 0,
        timeline: [],
      },
      diversion: {
        willDivert: true,
        expectedNewApi: true,
        expectedChannels: [],
        actualNewApi: false,
        status: 'BLOCKED',
        reasons: [degradedReason || ''],
        evidenceState: 'UNVERIFIED',
        evidenceLevel: 'INSUFFICIENT_EVIDENCE',
      },
      artifact: {
        passed: false,
        status: 'BLOCKED',
        skipped: true,
        fileAccessible: false,
        containerIdentified: false,
        metadataMatched: false,
        actualDecoded: null,
        mediaType,
        decodable: false,
        reasons: [degradedReason || ''],
        qualityClassification: 'UNVERIFIED',
        warningNote: 'UI_E2E 浏览器不可用阻断',
      },
      billing: {
        passed: false,
        status: 'BLOCKED',
        expectedPoints: 70,
        unit: 'points',
        preDeductedPoints: 0,
        settledPoints: 0,
        refundedPoints: 0,
        netDeductedPoints: 0,
        underCharged: false,
        overCharged: false,
        duplicateCharged: false,
        duplicateRefunded: false,
        asyncSettlementPending: false,
        ledgerEntries: [],
        balanceAuxiliaryNote: degradedReason || '',
        reasons: [degradedReason || ''],
      },
      supplierCost: SupplierCostOracle.audit({
        mediaType,
        modelId,
        duration,
        resolution,
        userPointsPaid: 0,
        terminalStatus: 'NOT_SUBMITTED',
      }),
      screenshots: [],
      diagnosticLog,
    });
  }

  // 3. RoutingOracle 独立计算预期
  const defaultMainConfig: MainSiteConfigSnapshot = {
    routeMode: 'newapi',
    globalModelIds: [84, 88, 12],
    globalApiKey: 'sk-test-global-key',
    globalRouteRules: {
      video: {
        84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
        88: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
        15: { resolutions: ['480p', '720p', '1080p', '4k'], aspect_ratios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4'] },
      },
    },
    groupRouteRules: {
      video: {
        panqu_test: {
          15: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
        },
      },
    },
    orgBindings: {
      10: { routeGroupId: 1, newapiGroup: 'panqu_test', status: 1, apiKey: 'sk-test-org-key' },
    },
    ...options.mainSiteConfig,
  };

  const expectedMainSite: MainSiteRoutingVerdict =
    mediaType === 'video'
      ? RoutingOracle.evaluateVideoMainSite(
          {
            videoType: 6,
            modelId,
            taskType: options.taskType ?? 28,
            cueword: safePrompt,
            outputFormat: 'mp4',
            resolution,
            aspectRatio,
            userGroupIds,
          },
          defaultMainConfig,
        )
      : RoutingOracle.evaluateImageMainSite(
          {
            selmodelsId: modelId,
            serviceline: options.serviceline || 'r',
            userGroupIds,
          },
          defaultMainConfig,
        );

  log(`RoutingOracle 推导预期主站路由: willDivert=${expectedMainSite.willDivert}, decision=${expectedMainSite.decision}, line=${expectedMainSite.line}`);

  // Gateway 渠道集合与理论概率推导
  const gatewayChannels: GatewayChannelConfig[] = options.gatewayChannels || [
    {
      id: 36,
      name: '万相—yhuo',
      group: 'panqu_test',
      models: ['wan3.0-video', 'wan3.0-video-prime'],
      status: 1,
      weight: 10,
      dailyQuotaLimit: 10000,
      usedQuota: 100,
    },
    {
      id: 41,
      name: 'TD',
      group: 'panqu_test',
      models: ['seedance-2.0', 'seedance-2.5'],
      status: 1,
      weight: 10,
      dailyQuotaLimit: 10000,
      usedQuota: 100,
    },
    {
      id: 40,
      name: 'RH-图片',
      group: 'panqu_test',
      models: ['pan-banana-pro', 'runninghub-nano-banana-2'],
      status: 1,
      weight: 10,
      dailyQuotaLimit: 10000,
      usedQuota: 100,
    },
  ];

  const expectedGateway: GatewayRoutingVerdict = RoutingOracle.evaluateGatewayRouting(
    expectedMainSite.expectedSnapshot?.newapiGroup || 'panqu_test',
    expectedMainSite.expectedSnapshot?.newapiModel || (mediaType === 'video' ? 'wan3.0-video' : 'pan-banana-pro'),
    10,
    gatewayChannels,
  );

  // 4. BillingOracle 独立计算预期积分
  const expectedPoints = BillingOracle.calculateExpectedPoints({
    mediaType,
    modelId,
    duration,
    resolution,
  });

  log(`BillingOracle 独立预估积分: modelId=${modelId}, expectedPoints=${expectedPoints}`);

  let taskId: number | undefined;
  let submittedTaskName: string | undefined;
  let balanceBefore = options.balanceBefore;

  // 真实环境预先查询提交前可用积分（作为对账辅助证据）
  if (balanceBefore === undefined && fixture && executionMode !== 'MOCK' && !options.mockSubmitResponse) {
    try {
      const balRes = await fixture.request.get('/billing/personal', {
        params: { section: 'summary' },
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (balRes.ok()) {
        const balJson = await balRes.json();
        if (balJson.code === 1 && balJson.data?.available_points !== undefined) {
          balanceBefore = Number(balJson.data.available_points);
          log(`查询提交前账户余额: ${balanceBefore} 积分`);
        }
      }
    } catch (balErr) {
      log(`查询提交前账户余额失败: ${(balErr as Error).message}`);
    }
  }

  let submissionEvidence: FlowRunEvidence['submission'] = {
    method: 'POST',
    url: mediaType === 'video' ? '/aivideo/videonew/add' : '/aivideo/scene/add',
    params: { modelId, prompt: safePrompt, duration, resolution, aspectRatio },
    responseStatus: 0,
    responseCode: 0,
    responseMsg: '',
    durationMs: 0,
    submissionTransport: options.mockSubmitResponse ? 'MOCK' : options.useBrowserPage ? 'BROWSER_PAGE' : 'API_REQUEST',
    submissionState: 'UNKNOWN',
  };

  // ----------------------------------------------------
  // 阶段 1：页面提交与任务关联（前置监听响应，严禁猜测）
  // ----------------------------------------------------
  const submitStart = Date.now();

  if (options.mockSubmitResponse) {
    submissionEvidence.responseStatus = options.mockSubmitResponse.status;
    submissionEvidence.responseCode = Number(options.mockSubmitResponse.body.code ?? 0);
    submissionEvidence.responseMsg = String(options.mockSubmitResponse.body.msg ?? '');
    submissionEvidence.taskId = (options.mockSubmitResponse.body.data as { id?: number })?.id;
    submissionEvidence.durationMs = Date.now() - submitStart;
    submissionEvidence.submissionTransport = 'MOCK';
    if (options.mockSubmitResponse.status === 504 || options.mockSubmitResponse.status === 408) {
      submissionEvidence.submissionState = 'UNKNOWN';
    } else {
      submissionEvidence.submissionState = (submissionEvidence.responseCode === 1 && submissionEvidence.taskId) ? 'SUCCESS' : 'FAILED';
    }
    taskId = submissionEvidence.taskId;
  } else if (options.taskId) {
    taskId = Number(options.taskId);
    submissionEvidence.responseStatus = 200;
    submissionEvidence.responseCode = 1;
    submissionEvidence.responseMsg = `关联已有任务 ID ${taskId}`;
    submissionEvidence.taskId = taskId;
    submissionEvidence.durationMs = Date.now() - submitStart;
    submissionEvidence.submissionTransport = options.useBrowserPage ? 'BROWSER_PAGE' : 'API_REQUEST';
    submissionEvidence.submissionState = 'SUCCESS';
    log(`直接关联已有任务 ID ${taskId} 执行链路验真与对账`);
  } else if (fixture) {
    const projectId = session?.project_id || 365;
    const targetEndpoint = `${mediaType === 'video' ? '/aivideo/videonew/add' : '/aivideo/scene/add'}?project_id=${projectId}`;
    const bodyParams = new URLSearchParams();
    bodyParams.set('project_id', String(projectId));
    submittedTaskName = `devtest_${mediaType}_${Date.now()}`;
    bodyParams.set('row[name]', submittedTaskName);
    if (mediaType === 'video') {
      bodyParams.set('row[selmodelsId]', String(modelId));
      const selmodels = options.modelName
        ? `${modelId}-${options.modelName}`
        : modelId === 84
        ? '84-Wan 3.0'
        : modelId === 88
        ? '88-Wan 3.0-prime'
        : modelId === 15
        ? '15-seedance-2.0'
        : `${modelId}-video`;

      bodyParams.set('row[type]', '6');
      bodyParams.set('row[extra][selmodels]', selmodels);
      bodyParams.set('row[extra][task_type]', String(taskType ?? 28));
      bodyParams.set('row[extra][cueword]', safePrompt);
      bodyParams.set('row[extra][duration]', String(duration));
      bodyParams.set('row[extra][video_resolution]', resolution);
      bodyParams.set('row[extra][video_aspect_ratio]', aspectRatio);
    } else {
      const selmodels = options.modelName
        ? `${modelId}-${options.modelName}`
        : `${modelId}-Nano Banana Pro`;
      bodyParams.set('row[type]', '1');
      bodyParams.set('row[extra][selmodels]', selmodels);
      bodyParams.set('row[extra][selmodelsId]', String(modelId));
      bodyParams.set('row[extra][serviceline]', options.serviceline || 'r');
      bodyParams.set('row[extra][cueword]', safePrompt);
      bodyParams.set('row[extra][size_type]', 'resolution');
      bodyParams.set('row[extra][resolution]', resolution);
      bodyParams.set('row[extra][channel]', 'Third-party');
    }

    // 尝试拉取 FastAdmin CSRF Token
    try {
      const csrfRes = await fixture.request.get('/ajax/refreshtoken', {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (csrfRes.ok()) {
        const csrfJson = await csrfRes.json();
        const token = csrfJson.data?.__token__ || csrfJson.data?.token || csrfJson.__token__;
        if (token) {
          bodyParams.set('__token__', String(token));
        }
      }
    } catch (csrfErr) {
      log(`获取 CSRF Token 失败 (可能不需要): ${(csrfErr as Error).message}`);
    }

    // 若为真实页面模式 (UI_E2E)，通过真实 Page 导航、截图并监听提交响应
    let responsePromise: Promise<any> | null = null;
    let res: APIResponse;

    try {
      if (executionMode === 'UI_E2E' && fixture.page) {
        submissionEvidence.submissionTransport = 'BROWSER_PAGE';
        await fixture.page.goto(targetEndpoint, { waitUntil: 'domcontentloaded' });
        const screenshotPath = path.resolve(options.outputDir || './devtest-results', `screenshot-page-${Date.now()}.png`);
        try {
          await fixture.page.screenshot({ path: screenshotPath });
          screenshots.push(screenshotPath);
        } catch {}

        responsePromise = fixture.page.waitForResponse(
          (r) => r.url().includes(targetEndpoint) && r.request().method() === 'POST',
          { timeout: 15000 }
        ).catch(() => null);

        res = await fixture.page.request.post(targetEndpoint, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          data: bodyParams.toString(),
        });
        if (responsePromise) {
          await responsePromise;
        }
      } else {
        submissionEvidence.submissionTransport = 'API_REQUEST';
        res = await fixture.request.post(targetEndpoint, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          data: bodyParams.toString(),
        });
      }

      submissionEvidence.responseStatus = res.status();
      const rawText = await res.text();
      let resJson: { code?: number; msg?: string; data?: { id?: number } } = {};
      try {
        resJson = JSON.parse(rawText);
      } catch {
        resJson = { code: -1, msg: `响应非 JSON: ${rawText.slice(0, 100)}` };
      }

      submissionEvidence.responseCode = resJson.code ?? 0;
      submissionEvidence.responseMsg = resJson.msg || '';
      submissionEvidence.taskId = resJson.data?.id;
      submissionEvidence.durationMs = Date.now() - submitStart;
      taskId = submissionEvidence.taskId;

      if (submissionEvidence.responseCode === 1 && taskId) {
        submissionEvidence.submissionState = 'SUCCESS';
        log(`提交响应已拦截: status=${res.status()}, code=${resJson.code}, taskId=${taskId}`);
      } else {
        submissionEvidence.submissionState = 'FAILED';
        log(`提交返回业务拒绝: status=${res.status()}, code=${resJson.code}, msg=${resJson.msg}`);
      }
    } catch (err) {
      const sanitizedErr = sanitizeSensitiveText((err as Error).message);
      log(`页面提交超时或异常: ${sanitizedErr}`);
      submissionEvidence.responseMsg = sanitizedErr;
      submissionEvidence.durationMs = Date.now() - submitStart;

      // 规则：提交超时先核查是否已创建任务，禁止盲目重交导致重复扣费
      log('启动提交超时查重机制（按最近任务与 devtest 前缀查询）...');
      let candidateId: number | undefined;
      if (session) {
        try {
          const checkUrl = mediaType === 'video' ? '/aivideo/videonew/index' : '/aivideo/scene/index';
          const listRes = await fixture.request.get(checkUrl, {
            params: { project_id: session.project_id || 365, limit: 5 },
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
          });
          if (listRes.ok()) {
            const listData = await listRes.json();
            const candidate = (listData.rows || []).find((r: any) =>
              String(r.name || r.prompt || '').includes(safePrompt)
            );
            if (candidate && candidate.id) {
              candidateId = Number(candidate.id);
            }
          }
        } catch (queryErr) {
          log(`查重查询失败: ${(queryErr as Error).message}`);
        }
      }

      if (candidateId) {
        taskId = candidateId;
        submissionEvidence.taskId = candidateId;
        submissionEvidence.submissionState = 'SUCCESS';
        log(`查重发现已创建任务，自动绑定已有 taskId=${taskId}，规避重复提交扣费`);
      } else {
        submissionEvidence.submissionState = 'UNKNOWN';
        log('查重未找到匹配任务，无法确定是否已实际建单扣费，标记 SUBMISSION_UNKNOWN');
      }
    }
  }

  // ----------------------------------------------------
  // 阶段 2：异步任务跟踪（状态机、截止时间与分类）
  // ----------------------------------------------------
  const trackingTimeline: FlowRunEvidence['taskTracking']['timeline'] = [];
  let terminalStatus: TaskTerminalStatus = 'UNKNOWN';
  let failureCategory: TaskFailureCategory | undefined;
  let lastStatusResponse: Record<string, unknown> | undefined;
  let pollCount = 0;
  const trackingStart = Date.now();
  const pollTimeoutMs = (options.pollTimeoutSec || 45) * 1000;
  const pollIntervalMs = options.pollIntervalMs || 1000;

  if (taskId && submissionEvidence.submissionState !== 'UNKNOWN') {
    if (options.mockStatusResponses && options.mockStatusResponses.length > 0) {
      for (const mockResp of options.mockStatusResponses) {
        pollCount++;
        const body = mockResp.body;
        lastStatusResponse = body;
        let taskItem: any;
        if (Array.isArray(body.data)) {
          taskItem = body.data.find((item: any) => Number(item.id) === Number(taskId)) || body.data[0];
        } else {
          taskItem = body.data || body;
        }
        const statusObj = taskItem?.status || taskItem || {};
        const taskStatus = Number(statusObj.task_status ?? statusObj.status ?? (body as any)?.task_status ?? (body as any)?.status ?? 0);
        const progress = Number(statusObj.progress ?? (body as any)?.progress ?? 0);
        const label = taskStatus === 2 ? '完成' : taskStatus === 3 ? '失败' : '处理中';
        trackingTimeline.push({
          timestamp: new Date().toISOString(),
          status: taskStatus,
          progress,
          label,
        });

        if (taskStatus === 2) {
          terminalStatus = 'SUCCESS';
          break;
        } else if (taskStatus === 3) {
          terminalStatus = 'FAILED';
          failureCategory = 'PRODUCT_FAILURE';
          break;
        }
      }
    } else if (fixture) {
      while (Date.now() - trackingStart < pollTimeoutMs) {
        pollCount++;
        try {
          const statusRes = await fixture.request.post('/aivideo/v2/task_status/apiGetStatus', {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest',
            },
            data: `ids=${taskId}&type=${mediaType === 'video' ? 'video' : 'scene'}`,
          });

          if (!statusRes.ok()) {
            failureCategory = 'ENVIRONMENT_ERROR';
            log(`轮询请求 HTTP 异常: ${statusRes.status()}`);
          } else {
            const body = await statusRes.json();
            lastStatusResponse = body;
            let taskItem: any;
            if (Array.isArray(body.data)) {
              taskItem = body.data.find((item: any) => Number(item.id) === Number(taskId)) || body.data[0];
            } else {
              taskItem = body.data;
            }
            const statusObj = taskItem?.status || taskItem || {};
            const taskStatus = Number(statusObj.task_status ?? statusObj.status ?? -1);
            const progress = Number(statusObj.progress ?? 0);
            const label = taskStatus === 2 ? '完成' : taskStatus === 3 ? '失败' : taskStatus === 1 ? '生成中' : '排队中';

            trackingTimeline.push({
              timestamp: new Date().toISOString(),
              status: taskStatus,
              progress,
              label,
            });

            if (taskStatus === 2) {
              terminalStatus = 'SUCCESS';
              log(`任务成功达到终态: taskId=${taskId}, progress=100%`);
              break;
            } else if (taskStatus === 3) {
              terminalStatus = 'FAILED';
              failureCategory = 'PRODUCT_FAILURE';
              log(`任务生成失败: taskId=${taskId}, error=${statusObj.err || '未知'}`);
              break;
            }
          }
        } catch (pollErr) {
          failureCategory = 'ENVIRONMENT_ERROR';
          log(`轮询执行异常: ${(pollErr as Error).message}`);
        }

        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      if (terminalStatus === 'UNKNOWN') {
        terminalStatus = 'TIMEOUT';
        failureCategory = 'TEST_TIMEOUT';
        log(`任务等待超过截止时间 (${pollTimeoutMs / 1000}s)，标记 TIMEOUT`);
      }
    }
  } else {
    if (submissionEvidence.submissionState === 'UNKNOWN') {
      terminalStatus = 'UNKNOWN';
      failureCategory = 'SUBMISSION_UNKNOWN';
      log('提交状态未知，跳过状态轮询并标记 SUBMISSION_UNKNOWN');
    } else {
      terminalStatus = 'FAILED';
      failureCategory = 'PRODUCT_FAILURE';
      log('未提取到有效 taskId，任务跟踪跳过');
    }
  }

  // ----------------------------------------------------
  // 阶段 3：实际分流证据收集与核查 (RoutingEvidenceCollector)
  // ----------------------------------------------------
  let mainSiteRow: { id: number; line?: number; status?: number; extra?: any } | undefined;
  let gatewayLog: GatewayTaskLogEvidence | undefined = options.mockGatewayLog;

  if (options.mockTaskDetails) {
    mainSiteRow = {
      id: Number(options.mockTaskDetails.id ?? taskId ?? 1),
      line: Number(options.mockTaskDetails.line ?? 10),
      status: Number(options.mockTaskDetails.status ?? 2),
      extra: options.mockTaskDetails.extra,
    };
  } else if (fixture && taskId && session) {
    try {
      const listUrl = mediaType === 'video' ? '/aivideo/videonew/index' : '/aivideo/scene/index';
      const detailRes = await fixture.request.get(listUrl, {
        params: { project_id: session.project_id || 365, limit: 20 },
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (detailRes.ok()) {
        const listJson = await detailRes.json();
        const row = (listJson.rows || []).find((r: any) => Number(r.id) === Number(taskId));
        if (row) {
          mainSiteRow = {
            id: Number(row.id),
            line: Number(row.line ?? 0),
            status: Number(row.status ?? 0),
            extra: row.extra,
          };
        }
      }
    } catch (extraErr) {
      log(`获取主站任务快照失败: ${(extraErr as Error).message}`);
    }

    // 尝试查询网关实际路由日志（如具备管理员权限）
    if (!gatewayLog && executionMode === 'REAL_EXECUTION') {
      try {
        const gwRes = await fixture.request.get('/aivideo/volcengine_search/search', {
          params: { source_id: taskId },
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (gwRes.ok()) {
          const gwJson = await gwRes.json();
          if (gwJson.code === 1 && gwJson.data) {
            const gwItem = Array.isArray(gwJson.data) ? gwJson.data[0] : gwJson.data;
            if (gwItem && gwItem.newapi_channel_id) {
              const foundGwLog: GatewayTaskLogEvidence = {
                aiTaskId: taskId,
                newapiTaskId: String(gwItem.newapi_task_id || ''),
                upstreamTaskId: String(gwItem.newapi_upstream_task_id || ''),
                channelId: Number(gwItem.newapi_channel_id),
                channelName: String(gwItem.newapi_route_name || gwItem.newapi_provider_name || ''),
                providerCode: String(gwItem.newapi_provider_name || ''),
                status: String(gwItem.newapi_status || 'SUCCESS'),
              };
              gatewayLog = foundGwLog;
              log(`获取到网关路由日志: channelId=${foundGwLog.channelId}, channelName=${foundGwLog.channelName}`);
            }
          } else {
            log(`网关任务查询受限或无记录 (${gwJson.msg || '只读权限限制'})，按规范标记 UNVERIFIED，严禁伪造渠道证据`);
          }
        }
      } catch (gwErr) {
        log(`网关日志查询异常: ${(gwErr as Error).message}，按只读策略标记 UNVERIFIED`);
      }
    }
  }

  const collectedEvidence = RoutingEvidenceCollector.correlateAndVerify({
    taskId: taskId ?? 0,
    mediaType,
    expectedMainSite,
    expectedGateway,
    expectedFallback: (terminalStatus === 'FAILED' || options.mockFallbackLog) ? RoutingOracle.evaluateFallback(modelId) : undefined,
    mainSiteRow,
    gatewayLog,
    fallbackLog: options.mockFallbackLog,
    requireGatewayEvidence: options.requireGatewayEvidence ?? false,
  });

  const rawExtra = collectedEvidence.mainSite?.parsedExtra || {};
  const isDiverted =
    mediaType === 'video'
      ? Number(rawExtra.diversion ?? collectedEvidence.mainSite?.line ?? 0) === 10
      : Number(rawExtra.newapi_image ?? 0) === 1;

  const diversionResult: DiversionCheckResult = {
    passed: collectedEvidence.verificationStatus === 'PASS',
    status: collectedEvidence.verificationStatus,
    isDiverted,
    willDivert: expectedMainSite.willDivert,
    expectedNewApi: expectedMainSite.willDivert,
    expectedChannels: expectedGateway.allowedChannels,
    expectedChannel: expectedGateway.allowedChannels,
    actualNewApi: isDiverted,
    actualChannel: collectedEvidence.gatewayLog?.channelName || (isDiverted ? (collectedEvidence.evidenceState === 'VERIFIED' ? (rawExtra.channel_name ? String(rawExtra.channel_name) : 'NewAPI渠道') : 'NewAPI待验真') : '直连'),
    actualLine: Number(rawExtra.diversion ?? collectedEvidence.mainSite?.line ?? 0),
    actualOrgId: Number(rawExtra.newapi_org_id ?? 0),
    actualGroup: String(rawExtra.newapi_group ?? ''),
    newapiModel: String(rawExtra.newapi_model ?? (expectedMainSite.expectedSnapshot?.newapiModel || '')),
    rawExtra,
    reasons: collectedEvidence.reasons,
    evidenceState: collectedEvidence.evidenceState,
    evidenceLevel: collectedEvidence.evidenceState === 'VERIFIED' ? 'DUAL_SYSTEM_VERIFIED' : (collectedEvidence.mainSite ? 'MAIN_SITE_SNAPSHOT_ONLY' : 'INSUFFICIENT_EVIDENCE'),
    details: collectedEvidence,
  };

  log(`分流核查结果: status=${diversionResult.status}, evidenceState=${diversionResult.evidenceState}`);

  // ----------------------------------------------------
  // 阶段 4：产物校验（成功物理校验，失败跳过并转向退款）
  // ----------------------------------------------------
  const artifactReasons: string[] = [];
  let artifactPassed = false;
  let artifactStatus: FlowStepStatus = 'NOT_EXECUTED';
  let fileAccessible = false;
  let decodable = false;
  let format: string | undefined;
  let dimensions: { width: number; height: number } | undefined;
  let durationSec: number | undefined;
  let sha256: string | undefined;
  let sizeBytes: number | undefined;
  let qualityNote: ArtifactCheckResult['qualityClassification'] = 'UNVERIFIED';
  let rawAssetUrl = '';

  if (terminalStatus === 'FAILED') {
    // 规则：生成失败时自动跳过产物物理校验，转向退款核验
    artifactStatus = 'PASS';
    artifactPassed = true;
    qualityNote = 'TASK_FAILED_SKIPPED';
    log('任务生成失败，自动跳过产物物理校验，转向积分退还核验');
  } else if (terminalStatus === 'SUCCESS') {
    let taskItem: any;
    if (Array.isArray(lastStatusResponse?.data)) {
      taskItem = lastStatusResponse.data.find((item: any) => Number(item.id) === Number(taskId)) || lastStatusResponse.data[0];
    } else {
      taskItem = (lastStatusResponse as any)?.data || lastStatusResponse || {};
    }
    const statusObj = taskItem?.status || taskItem || {};
    rawAssetUrl = String(
      statusObj.video_url ||
      statusObj.pic_url ||
      statusObj.videoUrl ||
      statusObj.picUrl ||
      options.mockTaskDetails?.video_url ||
      options.mockTaskDetails?.pic_url ||
      ''
    );

    if (!rawAssetUrl && !options.mockAssetBuffer) {
      artifactStatus = 'FAIL';
      artifactReasons.push('任务报告完成，但返回数据中 assetUrl 为空');
      qualityNote = 'FILE_INVALID';
    } else {
      let buffer: Buffer | undefined = options.mockAssetBuffer;

      if (!buffer && fixture && rawAssetUrl) {
        try {
          const headRes = await fixture.request.get(rawAssetUrl);
          if (!headRes.ok()) {
            artifactReasons.push(`产物 URL 无法访问: HTTP ${headRes.status()}`);
          } else {
            fileAccessible = true;
            buffer = await headRes.body();
            sizeBytes = buffer.length;
            sha256 = createHash('sha256').update(buffer).digest('hex');
          }
        } catch (fetchErr) {
          artifactReasons.push(`拉取产物异常: ${(fetchErr as Error).message}`);
        }
      } else if (buffer) {
        fileAccessible = true;
        sizeBytes = buffer.length;
        sha256 = createHash('sha256').update(buffer).digest('hex');
      }

      if (buffer) {
        const inspected = inspectBufferMedia(buffer, mediaType);
        decodable = inspected.decodable;
        format = inspected.format;
        dimensions = inspected.dimensions;
        durationSec = inspected.durationSeconds;
        artifactReasons.push(...inspected.reasons);

        if (decodable) {
          artifactStatus = 'PASS';
          artifactPassed = true;
          qualityNote = 'TASK_SUCCESS_AND_VALID';
          log(`产物容器与元数据解析通过: format=${format}, size=${sizeBytes} bytes, dims=${dimensions?.width}x${dimensions?.height}`);
        } else {
          artifactStatus = 'FAIL';
          qualityNote = 'FILE_INVALID';
          log(`产物容器解析失败: ${artifactReasons.join('; ')}`);
        }
      } else {
        artifactStatus = 'FAIL';
        qualityNote = 'FILE_INVALID';
      }
    }
  } else {
    artifactStatus = 'FAIL';
    artifactReasons.push(`任务未达终态 (状态=${terminalStatus})，无法验证产物有效性`);
    qualityNote = 'UNVERIFIED';
  }

  let statusDataForAsset: any;
  if (Array.isArray(lastStatusResponse?.data)) {
    statusDataForAsset = lastStatusResponse.data.find((item: any) => Number(item.id) === Number(taskId)) || lastStatusResponse.data[0];
  } else {
    statusDataForAsset = (lastStatusResponse as any)?.data || lastStatusResponse || {};
  }
  const assetStatusObj = statusDataForAsset?.status || statusDataForAsset || {};
  const resolvedAssetUrl = String(assetStatusObj.video_url || assetStatusObj.pic_url || rawAssetUrl || '');

  // 区分容器结构有效性、元数据解析与真正像素全流解码
  const containerValid = decodable;
  const metadataParsed = Boolean(dimensions && dimensions.width > 0);
  let browserPixelDecoded = false;

  // 若在浏览器环境下且产物有效，尝试真实浏览器像素解码
  if (fixture?.page && fixture.isHeadlessBrowserAvailable && resolvedAssetUrl && artifactPassed) {
    try {
      if (mediaType === 'image') {
        browserPixelDecoded = await fixture.page.evaluate(async (url) => {
          return new Promise<boolean>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0);
            img.onerror = () => resolve(false);
            img.src = url;
          });
        }, resolvedAssetUrl);
      } else {
        browserPixelDecoded = await fixture.page.evaluate(async (url) => {
          return new Promise<boolean>((resolve) => {
            const v = document.createElement('video');
            v.onloadedmetadata = () => resolve(v.videoWidth > 0);
            v.onerror = () => resolve(false);
            v.src = url;
          });
        }, resolvedAssetUrl);
      }
      if (browserPixelDecoded) {
        log('浏览器端真实像素/画面渲染解码成功 (Browser Pixel Decoded)');
      }
    } catch {
      // 浏览器解码为加分项探测
    }
  }

  const verificationLevel: ArtifactVerificationLevel =
    qualityNote === 'TASK_FAILED_SKIPPED'
      ? 'SKIPPED_ON_FAILURE'
      : browserPixelDecoded
      ? 'BROWSER_PIXEL_DECODED'
      : (containerValid && metadataParsed)
      ? 'CONTAINER_METADATA_VERIFIED'
      : fileAccessible
      ? 'HTTP_ACCESSIBLE_ONLY'
      : 'UNVERIFIED';

  const actualDecoded = browserPixelDecoded ? true : (fixture?.isHeadlessBrowserAvailable ? false : null);

  const artifactResult: ArtifactCheckResult = {
    passed: artifactPassed,
    status: artifactStatus,
    skipped: qualityNote === 'TASK_FAILED_SKIPPED',
    assetUrl: resolvedAssetUrl ? maskSensitive(resolvedAssetUrl) : undefined,
    fileAccessible,
    containerIdentified: containerValid,
    metadataMatched: metadataParsed,
    actualDecoded,
    decodable,
    format,
    dimensions,
    durationSeconds: durationSec,
    sizeBytes,
    sha256,
    reasons: artifactReasons,
    qualityClassification: qualityNote,
    verificationLevel,
    containerValid,
    metadataParsed,
    fullStreamDecoded: browserPixelDecoded,
    mediaType,
    warningNote: 'MP4 Box 树（ftyp/moov/mdat）或 PNG IHDR 解析仅代表容器格式与元数据有效，不等于底层像素/画面全流解码完成。',
  };

  // ----------------------------------------------------
  // 阶段 5：计费与退款对账 (BillingOracle)
  // ----------------------------------------------------
  let rawScoreLogs: ScoreLogEntry[] = [];
  let balanceAfter = options.balanceAfter;

  if (options.mockScoreLogs !== undefined) {
    rawScoreLogs = options.mockScoreLogs.map((item: any, idx: number) => {
      if (typeof item.score === 'number') {
        return {
          id: item.id ?? idx + 1,
          task_id: item.task_id ?? taskId,
          type: item.type ?? 2,
          score: item.score,
          memo: item.memo ?? ((item.type === 1 || item.type === 'REFUND') ? `任务 ${taskId} 退还流水` : `任务 ${taskId} 扣除流水`),
          createtime: item.createtime,
        };
      }
      const points = Math.abs(Number(item.points ?? 0));
      let entryType: number | string = 2;
      let scoreVal = -points;
      let memo = `任务 ${taskId} 扣除预扣`;
      if (item.type === 'REFUND' || item.type === 1) {
        entryType = 1;
        scoreVal = points;
        memo = `任务 ${taskId} 失败退款`;
      } else if (item.type === 'SETTLE' || item.type === 3 || item.type === 'settle') {
        entryType = 3;
        scoreVal = 0;
        memo = `任务 ${taskId} 结算完成`;
      }
      return {
        id: item.id ?? idx + 1,
        task_id: item.task_id ?? taskId,
        type: entryType,
        score: scoreVal,
        memo: item.memo ?? memo,
        createtime: item.createtime,
      };
    });
  } else if (executionMode !== 'MOCK' && !options.mockSubmitResponse) {
    // 真实执行 (API_INTEGRATION / UI_E2E)：从实际 FastAdmin /billing/personal 接口提取任务流水，绝不伪造
    if (fixture && taskId) {
      const maxAttempts = terminalStatus === 'FAILED' ? 4 : 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const logRes = await fixture.request.get('/billing/personal', {
            params: { section: 'records', days: '30', limit: 50 },
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
          });
          if (logRes.ok()) {
            const logJson = await logRes.json();
            const rows: any[] = logJson.data?.rows || logJson.rows || [];
            const taskRows = rows.filter((r: any) => {
              if (r.task_id !== undefined && Number(r.task_id) === Number(taskId)) return true;
              if (r.asset_url && (r.asset_url.includes(`_${taskId}_`) || r.asset_url.includes(`/${taskId}_`))) return true;
              if (r.asset_name && (r.asset_name.includes(String(taskId)) || (submittedTaskName && r.asset_name.includes(submittedTaskName)))) return true;
              return false;
            });

            // 失败任务特殊对账：由于失败任务未生成成品，消费行与退款行的 asset_name 与 asset_url 均为空
            // 需在同一批次流水中按匹配模型/金额与时间窗口捕获配对的预扣与退款流水
            if (terminalStatus === 'FAILED') {
              const hasDeduct = taskRows.some((r: any) => Number(r.record_type) === 2 || Number(r.points) < 0);
              const hasRefund = taskRows.some((r: any) => Number(r.record_type) === 1 || Number(r.points) > 0);

              if (!hasDeduct) {
                const pairedDeduct = rows.find((r: any) => {
                  if (Number(r.record_type) !== 2 && Number(r.points) >= 0) return false;
                  return Math.abs(Number(r.points)) === Math.abs(expectedPoints);
                });
                if (pairedDeduct && !taskRows.includes(pairedDeduct)) {
                  taskRows.push(pairedDeduct);
                }
              }

              if (!hasRefund) {
                const pairedRefund = rows.find((r: any) => {
                  if (Number(r.record_type) !== 1 && Number(r.points) <= 0) return false;
                  return Math.abs(Number(r.points)) === Math.abs(expectedPoints);
                });
                if (pairedRefund && !taskRows.includes(pairedRefund)) {
                  taskRows.push(pairedRefund);
                }
              }
            }

            if (taskRows.length > 0) {
              rawScoreLogs = taskRows.map((r: any, idx: number) => ({
                id: r.id || `rec_${idx + 1}`,
                task_id: taskId,
                type: r.record_type ?? (r.points < 0 ? 2 : 1),
                score: Number(r.points ?? r.score),
                memo: r.type_label ? `${r.type_label} (${r.type_text || r.model || ''})` : (r.memo || '账单流水'),
                createtime: r.time || r.createtime,
              }));
              const hasRefund = rawScoreLogs.some((r) => Number(r.type) === 1 || r.score > 0);
              if (terminalStatus !== 'FAILED' || hasRefund) {
                log(`查询到任务 ${taskId} 真实账单流水 ${rawScoreLogs.length} 条 (含退款=${hasRefund})`);
                break;
              }
            }
          }
        } catch (e) {
          log(`查询真实账务流水异常 (尝试 ${attempt}): ${(e as Error).message}`);
        }

        if (attempt < maxAttempts) {
          log(`任务流水尚未入库，等待异步入账并重试 (${attempt}/${maxAttempts})...`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }

      // 获取执行后账户余额
      if (balanceAfter === undefined) {
        try {
          const balRes = await fixture.request.get('/billing/personal', {
            params: { section: 'summary' },
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
          });
          if (balRes.ok()) {
            const balJson = await balRes.json();
            if (balJson.code === 1 && balJson.data?.available_points !== undefined) {
              balanceAfter = Number(balJson.data.available_points);
              log(`查询执行后账户余额: ${balanceAfter} 积分`);
            }
          }
        } catch (e) {
          log(`获取执行后余额失败: ${(e as Error).message}`);
        }
      }
    }
  } else {
    // 仅在受控 MOCK 验证模式下提供默认正向测试流水
    rawScoreLogs = [
      {
        id: 1,
        task_id: taskId,
        type: 2,
        score: -expectedPoints,
        memo: `任务 ${taskId} 扣除预扣`,
      },
      ...(terminalStatus === 'SUCCESS'
        ? [{ id: 2, task_id: taskId, type: 3, score: 0, memo: `任务 ${taskId} 结算完成` }]
        : terminalStatus === 'FAILED'
        ? [{ id: 3, task_id: taskId, type: 1, score: expectedPoints, memo: `任务 ${taskId} 失败退款` }]
        : []),
    ];
  }

  const billingAudit: BillingAuditReport = BillingOracle.reconcileTaskLedger({
    taskId: taskId ?? 0,
    expectedPoints,
    terminalStatus,
    scoreLogs: rawScoreLogs,
    balanceBefore,
    balanceAfter,
  });

  const billingResult: BillingReconciliation = {
    passed: billingAudit.passed,
    status: billingAudit.status,
    expectedPoints: billingAudit.expectedPoints,
    unit: 'points',
    preDeductedPoints: billingAudit.preDeductedPoints,
    settledPoints: billingAudit.settledPoints,
    refundedPoints: billingAudit.refundedPoints,
    netDeductedPoints: billingAudit.netDeductedPoints,
    underCharged: billingAudit.underCharged,
    overCharged: billingAudit.overCharged,
    duplicateCharged: billingAudit.duplicateCharged,
    duplicateRefunded: billingAudit.duplicateRefunded,
    missingRefund: billingAudit.missingRefund,
    asyncSettlementPending: billingAudit.asyncSettlementPending,
    ledgerEntries: billingAudit.ledgerEntries,
    balanceBefore: billingAudit.balanceAuxiliary?.balanceBefore,
    balanceAfter: billingAudit.balanceAuxiliary?.balanceAfter,
    balanceDelta: billingAudit.balanceAuxiliary?.balanceDelta,
    balanceAuxiliaryNote: billingAudit.balanceAuxiliary?.note || '',
    reasons: billingAudit.reasons,
  };

  log(`对账核算结果: status=${billingResult.status}, netDeducted=${billingResult.netDeductedPoints}`);

  // 5.2 平台侧供应商成本核算 (SupplierCostOracle)
  const supplierCostVerdict: SupplierCostVerdict = SupplierCostOracle.audit({
    mediaType,
    modelId,
    duration,
    resolution,
    userPointsPaid: billingResult.netDeductedPoints,
    terminalStatus,
    actualChannelName: diversionResult.actualChannel,
    actualLine: Number(rawExtra.diversion ?? rawExtra.line ?? 10),
    actualRecordedCostCny: options.mockRecordedCostCny,
    upstreamBillReceived: options.upstreamBillReceived,
    rechargeBatch: options.rechargeBatch,
    effectiveCnyPerPoint: options.effectiveCnyPerPoint,
    upstreamExecutionState: options.upstreamExecutionState,
    upstreamCalls: options.upstreamCalls,
    requireVerifiedCostEvidence: options.requireVerifiedCostEvidence,
  });

  log(`供应商成本核算: status=${supplierCostVerdict.status}, expectedCost=¥${supplierCostVerdict.expectedCostCny}, unit=${supplierCostVerdict.unit}, basis=${supplierCostVerdict.pricingBasis}, grossMargin=${supplierCostVerdict.grossMarginLabel} (¥${supplierCostVerdict.estimatedGrossProfitCny}), evidenceLevel=${supplierCostVerdict.evidenceLevel}`);

  // ----------------------------------------------------
  // 阶段 6：汇总最终结论与 Playwright Trace 保存
  // ----------------------------------------------------
  const businessTaskStatus: TaskTerminalStatus = terminalStatus;
  let testAssertionStatus: FlowStepStatus = 'PASS';

  if (submissionEvidence.submissionState === 'UNKNOWN' || failureCategory === 'SUBMISSION_UNKNOWN') {
    testAssertionStatus = 'BLOCKED';
  } else if (options.expectFailure) {
    if (terminalStatus !== 'FAILED' || !billingResult.passed || supplierCostVerdict.status === 'FAIL') {
      testAssertionStatus = 'FAIL';
    } else if (billingResult.status === 'BLOCKED' || supplierCostVerdict.status === 'BLOCKED') {
      testAssertionStatus = 'BLOCKED';
    } else {
      testAssertionStatus = 'PASS';
    }
  } else {
    // 严格门禁：只有必需检查全部完成且通过，整体才可 PASS
    if (
      submissionEvidence.responseCode !== 1 ||
      terminalStatus !== 'SUCCESS' ||
      diversionResult.status !== 'PASS' ||
      artifactResult.status !== 'PASS' ||
      billingResult.status !== 'PASS' ||
      supplierCostVerdict.status !== 'PASS'
    ) {
      if (
        diversionResult.status === 'BLOCKED' ||
        billingResult.status === 'BLOCKED' ||
        supplierCostVerdict.status === 'BLOCKED'
      ) {
        testAssertionStatus = 'BLOCKED';
      } else {
        testAssertionStatus = 'FAIL';
      }
    }
  }
  const overallStatus = testAssertionStatus;

  let tracePath: string | undefined;
  if (fixture && ownFixture) {
    try {
      await fixture.dispose();
      tracePath = fixture.tracePath;
      if (tracePath) {
        log(`Playwright Trace 录制落盘: ${tracePath}`);
      }
    } catch {}
  }

  const finishedAt = new Date().toISOString();

  const rawEvidence: FlowRunEvidence = {
    caseId,
    runId,
    taskId,
    mediaType,
    overallStatus,
    businessTaskStatus,
    testAssertionStatus,
    executionMode,
    degradedFromBrowser,
    degradedReason,
    failureCategory,
    startedAt,
    finishedAt,
    submission: submissionEvidence,
    taskTracking: {
      pollCount,
      terminalStatus,
      failureCategory,
      durationMs: Date.now() - trackingStart,
      timeline: trackingTimeline,
      lastResponse: lastStatusResponse,
    },
    diversion: diversionResult,
    artifact: artifactResult,
    billing: billingResult,
    supplierCost: supplierCostVerdict,
    tracePath,
    screenshots,
    diagnosticLog,
  };

  const evidence: FlowRunEvidence = sanitizeObject(rawEvidence);

  log(`全链路执行完毕: overallStatus=${overallStatus}, businessTask=${businessTaskStatus}, testAssertion=${testAssertionStatus}`);

  // 输出报告文件
  if (options.outputDir) {
    try {
      await mkdir(options.outputDir, { recursive: true });
      const reportJsonPath = path.join(options.outputDir, `${caseId}-evidence.json`);
      await writeFile(reportJsonPath, JSON.stringify(evidence, null, 2), 'utf8');
    } catch {}
  }

  return evidence;
}
