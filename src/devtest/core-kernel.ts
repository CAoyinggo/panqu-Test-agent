import { existsSync } from 'node:fs';
import {
  EnvironmentProbe,
  discoverModelContract,
  parseChangeIntent,
  STATIC_MODELS,
  type EnvProbeReport,
} from './env-probe.js';
import {
  RoutingOracle,
  DEFAULT_KNOWN_GATEWAY_CHANNELS,
  type MainSiteConfigSnapshot,
  type GatewayRoutingVerdict,
  type GatewayChannelConfig,
} from './routing.js';
import { BillingOracle } from './billing.js';
import type {
  ChangeScenario,
  DiscoveredModelContract,
  TestPlan,
  TestPlanBlockedItem,
  ChangeContract,
  AcceptanceResult,
  TargetKind,
  TargetDisambiguationResult,
} from './types.js';
import {
  resolveDomainContext,
  generateDomainExecutionPlan,
  type DomainProbeAnalysis,
  type DomainExecutionPlan,
  type Experience,
} from './domain-knowledge.js';
import {
  type CanonicalTestSpec,
  type SideEffectPolicy,
  type TestCostLimit,
  validateCanonicalTestSpec,
  validateEvidenceEnvelope,
} from './canonical-protocol.js';
import {
  mapPlanToCanonicalTestSpec,
  mapProbeToCanonicalTestSpec,
  mapExecuteToCanonicalTestSpec,
} from './legacy-protocol-mappers.js';
import { validateExecutionResult, type ExecutionAdapter, type ExecutionResult } from './execution-ports.js';
import type { RequirementTrace } from './requirement-trace.js';
// Phase 4 物理分解 (见 docs/ARCHITECTURE_FREEZE.md §2.2)：generateDynamicTestPlan / PlanKernelOptions
// 已迁至 plan-generator.ts,verify 证据流水线已迁至 verify-pipeline.ts;此处 import 供本模块
// plan()/verify() 编排调用,并对公共类型做 re-export,保持 src/devtest/index.ts 公共契约零变化。
import { generateDynamicTestPlan, type PlanKernelOptions } from './plan-generator.js';
export { generateDynamicTestPlan };
export type { PlanKernelOptions };
import {
  resolveVerifyContext,
  collectTaskEvidence,
  collectMediaEvidence,
  collectBillingEvidence,
  computeRegressionDiff,
  buildDiffItems,
  computeFinalVerdict,
  type VerifyKernelOptions,
  type VerifyKernelResult,
} from './verify-pipeline.js';
export type { VerifyKernelOptions, VerifyKernelResult };
export type {
  EvidenceStatus,
  InvariantDetail,
  TaskEvidence,
  MediaEvidence,
  BillingEvidence,
  InvariantsEvidence,
  VerificationEvidence,
} from './verify-pipeline.js';

export interface ProbeKernelOptions {
  env?: string;
  baseUrl?: string;
  gatewayUrl?: string;
  sessionFile?: string;
  mock?: boolean;
  timeoutMs?: number;
  requirement?: string;
  modelId?: number;
  mediaType?: 'video' | 'image';
  extraExperiences?: Experience[];
  projectRoot?: string;
  testId?: string;
  changedPaths?: readonly string[];
  traces?: readonly RequirementTrace[];
}
export interface ProbeKernelResult {
  ok: boolean;
  status: 'HEALTHY' | 'DEGRADED' | 'BLOCKED';
  env: string;
  baseUrl: string;
  gatewayUrl: string;
  probedAt: string;
  auth: { status: 'VALID' | 'EXPIRED' | 'MISSING'; details: string; hasSession: boolean };
  endpoints: Array<{
    name: string;
    url: string;
    reachable: boolean;
    statusCode?: number;
    latencyMs?: number;
    message: string;
  }>;
  candidateChannelCount: number;
  recommendations: string[];
  domainAnalysis?: DomainProbeAnalysis;
  canonicalSpec?: CanonicalTestSpec;
}

export async function probe(options: ProbeKernelOptions = {}): Promise<ProbeKernelResult> {
  const env = options.env || 'test';
  const domainAnalysis = resolveDomainContext({
    requirement: options.requirement,
    modelId: options.modelId,
    mediaType: options.mediaType,
    extraExperiences: options.extraExperiences,
    projectRoot: options.projectRoot,
  });
  try {
    const r: EnvProbeReport = await EnvironmentProbe.probe({
      env: env as 'test' | 'preonline',
      baseUrl: options.baseUrl,
      gatewayUrl: options.gatewayUrl,
      sessionFile: options.sessionFile,
      mock: options.mock ?? false,
      timeoutMs: options.timeoutMs ?? 5000,
    });
    const canonicalSpec = mapProbeToCanonicalTestSpec(
      options as Record<string, unknown>,
      r as unknown as Record<string, unknown>,
      {
        testId: options.testId,
        requirement: options.requirement,
        changedPaths: options.changedPaths,
        traces: options.traces,
      },
    );
    return {
      ok: r.ok,
      status: r.status,
      env: r.env,
      baseUrl: r.baseUrl,
      gatewayUrl: r.gatewayUrl,
      probedAt: r.probedAt,
      auth: r.auth,
      endpoints: r.endpoints,
      candidateChannelCount: r.modelReadiness?.candidateChannelCount ?? 2,
      recommendations: r.recommendations,
      domainAnalysis,
      canonicalSpec,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const canonicalSpec = mapProbeToCanonicalTestSpec(options as Record<string, unknown>, undefined, {
      testId: options.testId,
      requirement: options.requirement,
      changedPaths: options.changedPaths,
      traces: options.traces,
    });
    return {
      ok: false,
      status: 'BLOCKED',
      env,
      baseUrl: options.baseUrl || 'https://unknown',
      gatewayUrl: options.gatewayUrl || 'https://unknown',
      probedAt: new Date().toISOString(),
      auth: { status: 'MISSING', details: msg, hasSession: false },
      endpoints: [],
      candidateChannelCount: 0,
      recommendations: [`探活异常: ${msg}`],
      domainAnalysis,
      canonicalSpec,
    };
  }
}

export interface PlanKernelResult {
  ok: boolean;
  modelId: number;
  mediaType: 'video' | 'image';
  flowType: 'direct' | 'diversion';
  decision: string;
  willDivert: boolean;
  routeLine: number;
  expectedPoints: number;
  expectedSnapshot?: { orgId: number; routeGroupId: number; newapiGroup: string; newapiModel: string };
  gatewayRouting: GatewayRoutingVerdict;
  candidateChannels: string[];
  reason: string;
  scenario: ChangeScenario;
  scenarioName: string;
  changeType: 'new_model' | 'diversion_change';
  contract: DiscoveredModelContract;
  changeContract?: ChangeContract;
  testPlan: TestPlan;
  blocked: TestPlanBlockedItem[];
  pricingStatus: 'DETERMINED' | 'MANUAL_REQUIRED' | 'UNVERIFIED';
  missingInputs?: string[];
  acceptanceForecast?: AcceptanceResult;
  executable?: boolean;
  blockerCode?: string;
  testerActionSummary?: {
    automatedSummary: string[];
    skippedSummary: string[];
    manualRequiredSummary: string[];
    nextStep: string;
  };
  domainPlan?: DomainExecutionPlan;
  disambiguation?: TargetDisambiguationResult;
  canonicalSpec?: CanonicalTestSpec;
}

export async function plan(options: PlanKernelOptions): Promise<PlanKernelResult> {
  const intent = options.requirement ? parseChangeIntent(options.requirement) : undefined;
  const disambiguation = RoutingOracle.disambiguateTarget(
    {
      targetKind: options.targetKind,
      channelId: options.channelId,
      channelName: options.channelName,
      modelId: options.modelId ?? intent?.modelId,
      modelAlias: options.alias,
      projectId: options.projectId,
      rawTarget: options.rawTarget,
    },
    options.channels,
  );

  if (!disambiguation.ok) {
    const dummyContract = discoverModelContract(options.modelId || 84, options.mediaType || 'video');
    const blockedPlan: PlanKernelResult = {
      ok: false,
      modelId: options.modelId || 0,
      mediaType: options.mediaType || 'video',
      flowType: 'direct',
      decision: 'BLOCKED_AMBIGUOUS_TARGET',
      willDivert: false,
      routeLine: 0,
      expectedPoints: 0,
      gatewayRouting: {
        isBlockedByQuota: false,
        candidateChannelIds: [],
        allowedChannels: [],
        probabilities: {},
        rejectedReasons: {},
      },
      candidateChannels: [],
      reason: disambiguation.error || '目标对象歧义，已被门禁拦截',
      scenario: 'VIDEO_NEW_MODEL',
      scenarioName: '对象消歧阻断',
      changeType: 'new_model',
      contract: dummyContract,
      testPlan: {
        scenario: 'VIDEO_NEW_MODEL',
        scenarioName: '对象消歧阻断',
        modelId: options.modelId || 0,
        mediaType: options.mediaType || 'video',
        changeType: 'new_model',
        contract: dummyContract,
        tests: [],
        blocked: [
          {
            field: 'target_id',
            reason: disambiguation.error || '目标 ID 歧义',
            requiredAction: '请显式区分 --channel 与 --model',
          },
        ],
        expectedEvidence: ['03_gateway_channels.json'],
        summary: disambiguation.error || '消歧拦截',
      },
      blocked: [
        {
          field: 'target_id',
          reason: disambiguation.error || '目标 ID 歧义',
          requiredAction: '请显式区分 --channel 与 --model',
        },
      ],
      pricingStatus: 'MANUAL_REQUIRED',
      disambiguation,
    };
    const specRes = mapPlanToCanonicalTestSpec(blockedPlan, {
      testId: options.testId || `plan-blocked-${Date.now()}`,
      requirement: options.requirement,
      changedPaths: options.changedPaths,
      traces: options.traces,
      executionMode: options.mode === 'real' ? 'REAL' : 'FIXTURE',
    });
    return {
      ...blockedPlan,
      canonicalSpec: specRes.value,
    };
  }

  const modelId = disambiguation.modelId || (options.modelId ?? intent?.modelId ?? 84);
  const mediaType = options.mediaType ?? intent?.mediaType ?? 'video';
  const customPoints =
    options.customPoints ??
    (mediaType === 'image' && options.price !== undefined ? options.price : intent?.customPoints);
  const pointsPerSecond =
    options.pointsPerSecond ??
    (mediaType === 'video' && options.price !== undefined ? options.price : intent?.pointsPerSecond);
  const changeTypeOpt = options.changeType ?? intent?.changeType;
  const scenarioOpt = options.scenario ?? intent?.scenario;

  const isGlobalOpt = options.isGlobal ?? intent?.isGlobal;

  const contract = discoverModelContract(modelId, mediaType, {
    ...options,
    modelId,
    mediaType,
    alias: disambiguation.modelAlias || options.alias,
    isGlobal: isGlobalOpt,
    customPoints,
    pointsPerSecond,
    changeType: changeTypeOpt,
    scenario: scenarioOpt,
  });
  const scenario = contract.scenario;
  const changeType: 'new_model' | 'diversion_change' = changeTypeOpt
    ? changeTypeOpt
    : options.flowType === 'direct'
      ? 'new_model'
      : options.flowType === 'diversion'
        ? 'diversion_change'
        : scenario.includes('DIVERSION')
          ? 'diversion_change'
          : 'new_model';

  const flowType: 'direct' | 'diversion' =
    options.flowType === 'direct'
      ? 'direct'
      : options.flowType === 'diversion'
        ? 'diversion'
        : changeType === 'new_model'
          ? 'direct'
          : 'diversion';

  const targetChannelId = disambiguation.channelId ?? options.channelId;
  const targetChannelName = disambiguation.channelName ?? options.channelName;

  const isRhPricingConflict = Boolean(
    (targetChannelId === 2 || targetChannelName === 'RH-国际') &&
    modelId === 78 &&
    options.price === undefined &&
    options.pointsPerSecond === undefined &&
    options.customPoints === undefined,
  );

  if (isRhPricingConflict) {
    contract.pricing.isPricingDetermined = false;
    contract.pricing.allowPass = false;
    contract.pricing.source = 'MANUAL_REQUIRED';
  }

  const duration =
    options.duration ?? contract.supportedDurations?.value?.[0] ?? (mediaType === 'video' ? 4 : undefined);
  const resolution =
    options.resolution ?? contract.supportedResolutions.value[0] ?? (mediaType === 'video' ? '720p' : '1k');
  const expectedPoints = isRhPricingConflict
    ? 0
    : BillingOracle.calculateExpectedPoints({
        mediaType,
        modelId,
        duration,
        resolution,
        customPoints: customPoints ?? contract.pricing.customPoints?.value,
        pointsPerSecond: pointsPerSecond ?? contract.pricing.pointsPerSecond?.value,
      });

  const isSeedance = [15, 16, 58, 78].includes(modelId);
  const videoType = isSeedance ? 6 : 105;

  const baseConfig: MainSiteConfigSnapshot = {
    routeMode: flowType === 'direct' ? 'off' : 'newapi',
    globalModelIds: flowType === 'direct' ? [] : contract.isGlobal.value ? [modelId, 84, 88] : [84, 88],
    globalApiKey: 'sk-panqu-devtest-key',
    globalRouteRules: {
      video: {
        84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
        88: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
        ...(mediaType === 'video'
          ? {
              [modelId]: {
                resolutions: contract.supportedResolutions.value,
                aspect_ratios: contract.supportedAspectRatios.value,
              },
            }
          : {}),
      },
    },
    groupRouteRules: {},
    orgBindings: contract.orgBindings?.value
      ? Object.fromEntries(
          Object.entries(contract.orgBindings.value).map(([k, v]) => [
            Number(k),
            {
              routeGroupId: v.routeGroupId,
              newapiGroup: v.newapiGroup,
              status: v.status,
              apiKey: v.apiKey || 'sk-org-key',
            },
          ]),
        )
      : { 10: { routeGroupId: 1, newapiGroup: 'panqu_test', status: 1, apiKey: 'sk-org-key' } },
    modelAliases: {
      84: 'wan3.0-video',
      88: 'wan3.0-video-prime',
      201: 'runninghub-nano-banana-2',
      205: 'gpt-image-2.5',
      [modelId]: contract.alias.value,
    },
    ...options.mainConfig,
  };

  const mainVerdict =
    mediaType === 'video'
      ? RoutingOracle.evaluateVideoMainSite(
          {
            videoType,
            modelId,
            resolution,
            aspectRatio: options.aspectRatio ?? contract.supportedAspectRatios.value[0] ?? '16:9',
            userGroupIds: options.userGroupIds ?? [10],
          },
          baseConfig,
        )
      : flowType === 'direct'
        ? {
            willDivert: false,
            decision: 'FALLBACK_DIRECT' as const,
            line: 0,
            reason: '新图片模型采用代码直连链路接入，免走 NewAPI 网关分流 [FALLBACK_DIRECT]',
            expectedSnapshot: {
              newapiGroup: '',
              orgId: 0,
              routeGroupId: 0,
              newapiModel: contract.alias.value,
            },
          }
        : RoutingOracle.evaluateImageMainSite(
            {
              selmodelsId: modelId,
              serviceline: contract.serviceline?.value ?? 'r',
              userGroupIds: options.userGroupIds ?? [10],
            },
            baseConfig,
          );

  const targetModel = baseConfig.modelAliases?.[modelId] || contract.alias.value;
  const targetGroup = mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test';
  let channels: GatewayChannelConfig[];

  if (options.channels && options.channels.length > 0) {
    channels =
      targetChannelId !== undefined ? options.channels.filter((c) => c.id === targetChannelId) : options.channels;
  } else if (targetChannelId !== undefined) {
    const matchedKnown = DEFAULT_KNOWN_GATEWAY_CHANNELS.find((c) => c.id === targetChannelId);
    if (matchedKnown) {
      channels = [matchedKnown];
    } else {
      channels = [
        {
          id: targetChannelId,
          name: targetChannelName || `channel-${targetChannelId}`,
          group: targetGroup,
          models: [targetModel],
          status: 1,
          weight: 10,
          dailyQuotaLimit: 0,
          usedQuota: 0,
          sourceMode: 'SOURCE_STATIC_CONTRACT',
        },
      ];
    }
  } else if (mainVerdict.willDivert) {
    channels = [
      {
        id: 1,
        name: `${targetModel}主渠道`,
        group: targetGroup,
        models: [targetModel],
        status: 1,
        weight: 100,
        dailyQuotaLimit: 0,
        usedQuota: 0,
      },
    ];
  } else {
    channels = [];
  }

  const gwVerdict = RoutingOracle.evaluateGatewayRouting(targetGroup, targetModel, expectedPoints, channels);
  const testPlan = generateDynamicTestPlan(contract, options, mainVerdict, gwVerdict, expectedPoints);

  const domainPlan = generateDomainExecutionPlan({
    modelId,
    mediaType,
    flowType,
    resolution:
      options.resolution || contract.supportedResolutions.value[0] || (contract.mediaType === 'video' ? '720p' : '1k'),
    requirement: options.requirement,
    expectedPoints,
    extraExperiences: options.extraExperiences,
    projectRoot: options.projectRoot,
  });

  // 若根据真实上下文匹配到了历史已确认业务经验，动态增强测试计划
  if (domainPlan.relevantExperiences && domainPlan.relevantExperiences.length > 0) {
    for (const exp of domainPlan.relevantExperiences) {
      if (!exp.requiredPlanCheck) continue;

      const expTestId = `history-${exp.id.toLowerCase()}`;
      if (!testPlan.tests.some((t) => t.id === expTestId)) {
        testPlan.tests.push({
          id: expTestId,
          layer: exp.requiredPlanCheck.stage === 'TASK_VERIFY' ? 'execution' : 'billing',
          purpose: `[历史经验核验] ${exp.title}: ${exp.symptom}`,
          input: {
            modelId,
            mediaType,
            relatedExperienceId: exp.id,
            patternId: exp.related_pattern_id,
          },
          expected: {
            verificationRule: exp.requiredPlanCheck.verificationMethod || exp.verification || 'PASS',
            expectedOutcome: exp.requiredPlanCheck.expectedOutcome || '核验通过',
          },
          requiredEvidence: ['billing_reconciliation', 'business_invariants'],
          executionMode: 'real_task',
          status: 'READY',
          rationale: {
            whyIncluded: `历史上在 ${exp.context} 曾出现业务风险 (${exp.id})`,
            riskAddressed: exp.root_cause || exp.symptom,
          },
        });
      }
    }
  }

  const changeContract: ChangeContract = {
    scenario,
    modelId,
    mediaType,
    changeType,
    beforeState: {
      flowType: changeType === 'diversion_change' ? 'direct' : 'none',
      routeLine: 0,
      decision: changeType === 'diversion_change' ? 'FALLBACK_DIRECT' : undefined,
      pricing:
        changeType === 'diversion_change'
          ? `${expectedPoints} pt (baseline)`
          : contract.pricing.isPricingDetermined
            ? `${expectedPoints} pt`
            : '未确定 (MANUAL_REQUIRED)',
    },
    afterState: {
      flowType,
      routeLine: mainVerdict.line,
      decision: mainVerdict.decision,
      pricing: contract.pricing.isPricingDetermined ? `${expectedPoints} pt` : '未确定 (MANUAL_REQUIRED)',
    },
    requiredFacts: [
      'modelId',
      'mediaType',
      'pricing',
      'supportedResolutions',
      'supportedAspectRatios',
      ...(changeType === 'diversion_change' ? ['isGlobal', 'routeGroup', 'candidateChannels'] : []),
    ],
    discoveredFacts: {
      alias: { value: contract.alias.value, source: contract.alias.source, determined: contract.alias.determined },
      isGlobal: {
        value: contract.isGlobal.value,
        source: contract.isGlobal.source,
        determined: contract.isGlobal.determined,
      },
      supportedResolutions: {
        value: contract.supportedResolutions.value,
        source: contract.supportedResolutions.source,
        determined: contract.supportedResolutions.determined,
      },
      supportedAspectRatios: {
        value: contract.supportedAspectRatios.value,
        source: contract.supportedAspectRatios.source,
        determined: contract.supportedAspectRatios.determined,
      },
      ...(contract.supportedDurations
        ? {
            supportedDurations: {
              value: contract.supportedDurations.value,
              source: contract.supportedDurations.source,
              determined: contract.supportedDurations.determined,
            },
          }
        : {}),
      routing: {
        value: contract.routing.value,
        source: contract.routing.source,
        determined: contract.routing.determined,
      },
      pricing: {
        value: contract.pricing.pointsPerSecond?.value ?? contract.pricing.customPoints?.value ?? expectedPoints,
        source: contract.pricing.source,
        determined: contract.pricing.isPricingDetermined,
      },
    },
    missingFacts: contract.manualRequiredItems.map((m) => m.field),
    capabilities: {
      resolutions: contract.supportedResolutions.value,
      aspectRatios: contract.supportedAspectRatios.value,
      durations: contract.supportedDurations?.value,
      maxRefImages: contract.maxRefImages?.value,
      supportsReferenceVideo: contract.supportsReferenceVideo?.value,
      supportsFirstLastFrame: contract.supportsFirstLastFrame?.value,
    },
    pricing: {
      determined: contract.pricing.isPricingDetermined,
      allowPass: contract.pricing.allowPass,
      points: contract.pricing.customPoints?.value ?? (mediaType === 'image' ? expectedPoints : undefined),
      pointsPerSecond:
        contract.pricing.pointsPerSecond?.value ??
        (mediaType === 'video' ? expectedPoints / (duration || 4) : undefined),
      source: contract.pricing.source,
    },
    routingExpectation: {
      mode: mainVerdict.willDivert ? 'DIVERSION' : 'DIRECT',
      willDivert: mainVerdict.willDivert,
      routeLine: mainVerdict.line,
      decision: mainVerdict.decision,
      isGlobal: contract.isGlobal.value,
      group: mainVerdict.expectedSnapshot?.newapiGroup,
    },
    fallbackPolicy: contract.fallback?.value.action,
    testObjectives: testPlan.tests.map((t) => `${t.id}: ${t.purpose}`),
  };
  testPlan.changeContract = changeContract;

  let executable = true;
  let blockerCode: string | undefined;

  if (targetChannelId !== undefined) {
    executable = false;
    blockerCode = 'BLOCKED_CANNOT_ENFORCE_CHANNEL';
    testPlan.blocked.push({
      field: 'channel_enforcement',
      reason: `主站提交接口 (/aivideo/videonew/add) 不支持指定下游渠道参数，无法确保请求路由至目标渠道 #${targetChannelId} ('${targetChannelName || targetChannelId}') [BLOCKED_CANNOT_ENFORCE_CHANNEL]`,
      requiredAction: '需服务端接口支持渠道锁定，或在网关层将该模型独占绑定至目标渠道',
    });
  }

  if (isRhPricingConflict) {
    testPlan.blocked.push({
      field: 'pricing',
      reason:
        'RH 国际版适用单价存在冲突 (静态刊例 28 pt/s vs 历史实际/排期 21 pt/s)，单价尚未确认为线上事实 [UNVERIFIED]',
      requiredAction: '请提供明确经过审计的 RH 渠道计费标准或显式指定 --price',
    });
  }

  const missingInputs: string[] = [];
  if (!contract.pricing.isPricingDetermined || !contract.pricing.allowPass) {
    missingInputs.push('pricing');
  }
  if (
    options.mode === 'real' &&
    !options.sessionFile &&
    !existsSync('session.json') &&
    !existsSync('.panqu/session.json') &&
    !process.env.PANQU_SESSION_COOKIES_FILE
  ) {
    missingInputs.push('session/auth');
  }
  if (
    (scenario === 'IMAGE_DIVERSION_CHANGE' || scenario === 'VIDEO_DIVERSION_CHANGE') &&
    contract.alias.source === 'SOURCE_DEFAULT_FALLBACK'
  ) {
    missingInputs.push('baseline/alias');
  }
  for (const b of testPlan.blocked) {
    const f = b.missingField || b.field;
    if (!missingInputs.includes(f)) {
      missingInputs.push(f);
    }
  }

  const acceptanceForecast: AcceptanceResult = testPlan.blocked.length > 0 ? 'BLOCKED' : 'UNVERIFIED';

  const planTestId = options.testId || `plan-${modelId}-${scenario}`;
  const specRes = mapPlanToCanonicalTestSpec(
    {
      scenario,
      scenarioName: testPlan.scenarioName,
      modelId,
      mediaType,
      flowType,
      decision: mainVerdict.decision,
      willDivert: mainVerdict.willDivert,
      routeLine: mainVerdict.line,
      expectedPoints,
      changeType,
      contract,
      testPlan,
      blocked: testPlan.blocked,
      pricingStatus: isRhPricingConflict
        ? 'UNVERIFIED'
        : contract.pricing.isPricingDetermined
          ? 'DETERMINED'
          : 'MANUAL_REQUIRED',
      missingInputs,
      executable,
      blockerCode,
    } as any,
    {
      testId: planTestId,
      requirement: options.requirement,
      changedPaths: options.changedPaths,
      traces: options.traces,
    },
  );
  const canonicalSpec = specRes.success && specRes.value ? specRes.value : undefined;

  return {
    ok: true,
    modelId,
    mediaType,
    flowType,
    decision: mainVerdict.decision,
    willDivert: mainVerdict.willDivert,
    routeLine: mainVerdict.line,
    expectedPoints,
    expectedSnapshot: mainVerdict.expectedSnapshot,
    gatewayRouting: gwVerdict,
    candidateChannels: gwVerdict.allowedChannels,
    reason: mainVerdict.reason,
    scenario,
    scenarioName: testPlan.scenarioName,
    changeType,
    contract,
    changeContract,
    testPlan,
    blocked: testPlan.blocked,
    pricingStatus: isRhPricingConflict
      ? 'UNVERIFIED'
      : contract.pricing.isPricingDetermined
        ? 'DETERMINED'
        : 'MANUAL_REQUIRED',
    missingInputs,
    acceptanceForecast,
    executable,
    blockerCode,
    testerActionSummary: testPlan.testerActionSummary,
    domainPlan,
    disambiguation,
    canonicalSpec,
  };
}

export interface ExecuteKernelOptions {
  modelId?: number;
  mediaType?: 'video' | 'image';
  resolution?: string;
  duration?: number;
  aspectRatio?: string;
  mode?: 'mock' | 'real';
  prompt?: string;
  sessionFile?: string;
  env?: 'test' | 'preonline';
  serviceline?: string;
  channels?: GatewayChannelConfig[];
  contract?: DiscoveredModelContract;
  flow?: string;
  flowType?: 'direct' | 'diversion';
  extraParams?: Record<string, unknown>;
  budgetPoints?: number;
  customPoints?: number;
  pointsPerSecond?: number;
  price?: number;
  alias?: string;
  channelId?: number;
  channelName?: string;
  targetKind?: TargetKind;
  projectId?: number;
  rawTarget?: string | number;
  testId?: string;
  requirement?: string;
  requirementId?: string;
  requirementText?: string;
  sideEffectPolicy?: SideEffectPolicy;
  costLimit?: TestCostLimit;
  allowSubmit?: boolean;
  allowPaid?: boolean;
  maxCostPoints?: number;
  executionAdapter?: ExecutionAdapter;
  canonicalSpec?: CanonicalTestSpec;
  changedPaths?: readonly string[];
  traces?: readonly RequirementTrace[];
}
export interface ExecuteKernelResult {
  ok: boolean;
  taskId: number;
  simulationId?: string;
  isSimulated?: boolean;
  mode: 'mock' | 'real';
  modelId: number;
  mediaType: 'video' | 'image';
  status: 'SUBMITTED' | 'SUCCESS' | 'FAILED' | 'ERROR' | 'BLOCKED';
  points: number;
  message: string;
  credentialsMasked?: string;
  rawResponse?: Record<string, unknown>;
  disambiguation?: TargetDisambiguationResult;
  blockerCode?: string;
  canonicalSpec?: CanonicalTestSpec;
  executionResult?: ExecutionResult;
}

export interface ExecuteCanonicalDependencies {
  readonly executionAdapter?: ExecutionAdapter;
  readonly channels?: GatewayChannelConfig[];
  readonly sessionFile?: string;
  readonly env?: 'test' | 'preonline';
}

/**
 * 内部标准规范执行中枢 (Canonical Execution Engine)
 * - 唯一执行意图输入为 CanonicalTestSpec；
 * - 绝对不得直接调用 submitMediaTask，所有正常执行必须经过 ExecutionAdapter；
 * - 执行所有前置门禁：Spec 校验、目标消歧、计费规则、权限与副作用策略校验；
 * - 门禁或适配器失败时统一产出规范 ExecutionResult 放入统一返回结构。
 */
export async function executeCanonical(
  spec: Readonly<CanonicalTestSpec>,
  dependencies: ExecuteCanonicalDependencies,
): Promise<ExecuteKernelResult> {
  const modelId = Number(spec.target?.modelId ?? 84);
  const mediaType =
    (spec.inputs?.mediaType as 'video' | 'image') || (spec.scenario?.startsWith('IMAGE') ? 'image' : 'video');
  const mode = spec.executionMode === 'REAL' ? 'real' : 'mock';
  const targetKind = (spec.target?.targetType as TargetKind) || 'model';
  const channelId = spec.target?.expectedChannelId ?? spec.target?.channelId;
  const channelName = spec.metadata?.channelName as string | undefined;
  const projectId = spec.target?.projectId;
  const rawTarget = spec.metadata?.rawTarget as string | undefined;
  const alias = spec.metadata?.alias as string | undefined;
  const customPoints = spec.metadata?.customPoints as number | undefined;
  const pointsPerSecond = spec.metadata?.pointsPerSecond as number | undefined;
  const price = spec.metadata?.price as number | undefined;
  const resolution = spec.inputs?.resolution as string | undefined;
  const duration = spec.inputs?.duration as number | undefined;

  // 1. CanonicalTestSpec 协议自检门禁 (在任何 I/O 或 Adapter 调用前阻断)
  const specValidation = validateCanonicalTestSpec(spec);
  if (!specValidation.valid) {
    const errorMsg = `BLOCKED_INVALID_TEST_SPEC: CanonicalTestSpec 校验失败: ${specValidation.errors.map((e) => `[${e.field}] ${e.message}`).join('; ')}`;
    const execRes: ExecutionResult = {
      executionId: `exec-${spec.testId}-invalid-spec`,
      testId: spec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: { code: 'BLOCKED_INVALID_TEST_SPEC', message: errorMsg },
    };
    return {
      ok: false,
      taskId: 0,
      mode,
      modelId,
      mediaType,
      status: 'BLOCKED',
      points: 0,
      message: errorMsg,
      blockerCode: 'BLOCKED_INVALID_TEST_SPEC',
      canonicalSpec: spec as CanonicalTestSpec,
      executionResult: execRes,
    };
  }

  // 1.1 运行依赖一致性门禁：为兼容旧调用可暂时接收 env，但只用于一致性校验；与 spec.environment 不一致时阻断
  if (dependencies.env !== undefined && dependencies.env !== spec.environment) {
    const errorMsg = `BLOCKED_SPEC_INPUT_CONFLICT: 运行依赖 env ('${dependencies.env}') 与 canonicalSpec.environment ('${spec.environment}') 不一致，禁止产生双事实源冲突；执行环境必须完全以 canonicalSpec.environment 为准`;
    const execRes: ExecutionResult = {
      executionId: `exec-${spec.testId}-env-conflict`,
      testId: spec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: { code: 'BLOCKED_SPEC_INPUT_CONFLICT', message: errorMsg },
    };
    return {
      ok: false,
      taskId: 0,
      mode,
      modelId,
      mediaType,
      status: 'BLOCKED',
      points: 0,
      message: errorMsg,
      blockerCode: 'BLOCKED_SPEC_INPUT_CONFLICT',
      canonicalSpec: spec as CanonicalTestSpec,
      executionResult: execRes,
    };
  }

  // 1.2 环境枚举与未知环境防御门禁 (Fail-Closed)
  // 未知环境必须 fail-closed，禁止默认指向 test、preonline 或 production
  const isKnownEnv =
    spec.executionMode === 'REAL'
      ? spec.environment === 'test' || spec.environment === 'preonline'
      : spec.environment === 'test' || spec.environment === 'preonline' || spec.environment === 'offline';
  if (!isKnownEnv) {
    const errorMsg = `BLOCKED_UNKNOWN_ENVIRONMENT: 未知或不受支持的执行环境 "${spec.environment}" (模式: ${spec.executionMode})，仅支持显式白名单 ('test', 'preonline'${spec.executionMode === 'OFFLINE' ? ", 'offline'" : ''})，严禁默认指向 test/preonline/production [FAIL_CLOSED]`;
    const execRes: ExecutionResult = {
      executionId: `exec-${spec.testId}-unknown-env`,
      testId: spec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: { code: 'BLOCKED_UNKNOWN_ENVIRONMENT', message: errorMsg },
    };
    return {
      ok: false,
      taskId: 0,
      mode,
      modelId,
      mediaType,
      status: 'BLOCKED',
      points: 0,
      message: errorMsg,
      blockerCode: 'BLOCKED_UNKNOWN_ENVIRONMENT',
      canonicalSpec: spec as CanonicalTestSpec,
      executionResult: execRes,
    };
  }

  // 2. 目标消歧门禁
  const disambiguation = RoutingOracle.disambiguateTarget(
    {
      targetKind,
      channelId,
      channelName,
      modelId,
      modelAlias: alias,
      projectId,
      rawTarget,
      mode,
    },
    dependencies.channels,
  );

  if (!disambiguation.ok) {
    const errorMsg = disambiguation.error || '目标对象消歧拦截';
    const execRes: ExecutionResult = {
      executionId: `exec-${spec.testId}-disambiguation-blocked`,
      testId: spec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: { code: 'BLOCKED_TARGET_DISAMBIGUATION', message: errorMsg },
    };
    return {
      ok: false,
      taskId: 0,
      mode,
      modelId,
      mediaType,
      status: 'BLOCKED',
      points: 0,
      message: errorMsg,
      blockerCode: 'BLOCKED_TARGET_DISAMBIGUATION',
      disambiguation,
      canonicalSpec: spec as CanonicalTestSpec,
      executionResult: execRes,
    };
  }

  // 3. 目标渠道真实执行门禁 (BLOCKED_CANNOT_ENFORCE_CHANNEL)
  if (
    mode === 'real' &&
    (disambiguation.targetKind === 'channel' || channelId !== undefined || channelName !== undefined)
  ) {
    const extraSnapshotNotice =
      disambiguation.channelSource === 'SOURCE_STATIC_CONTRACT'
        ? '（附加证据缺口：该渠道缺少线上实时快照，当前仅为 SOURCE_STATIC_CONTRACT 静态契约）'
        : '';
    const errorMsg = `BLOCKED_CANNOT_ENFORCE_CHANNEL: 主站提交接口 (/aivideo/videonew/add) 不支持指定下游渠道参数，无法保证任务命中目标渠道 #${disambiguation.channelId} ('${disambiguation.channelName || `channel-${disambiguation.channelId}`}'); 严禁伪造参数发起真实提交。${extraSnapshotNotice}`;
    const execRes: ExecutionResult = {
      executionId: `exec-${spec.testId}-channel-blocked`,
      testId: spec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: { code: 'BLOCKED_CANNOT_ENFORCE_CHANNEL', message: errorMsg },
    };
    return {
      ok: false,
      taskId: 0,
      mode: 'real',
      modelId,
      mediaType,
      status: 'BLOCKED',
      points: 0,
      blockerCode: 'BLOCKED_CANNOT_ENFORCE_CHANNEL',
      message: errorMsg,
      disambiguation,
      canonicalSpec: spec as CanonicalTestSpec,
      executionResult: execRes,
    };
  }

  // 4. 定价与契约门禁
  const resolvedModelId = disambiguation.modelId || modelId;
  const passedAlias = disambiguation.modelAlias || alias;
  const contract =
    (spec.metadata?.contract as DiscoveredModelContract | undefined) ||
    discoverModelContract(resolvedModelId, mediaType, {
      resolution,
      duration,
      customPoints,
      pointsPerSecond,
      price,
      alias: passedAlias,
    });

  const effectiveDuration =
    duration ?? contract.supportedDurations?.value?.[0] ?? (mediaType === 'video' ? 4 : undefined);
  const effectiveResolution =
    resolution ?? contract.supportedResolutions.value[0] ?? (mediaType === 'video' ? '720p' : '1k');

  if (!contract.pricing.allowPass) {
    const errorMsg = `模型 #${resolvedModelId} 刊例定价未确定 (${contract.pricing.source})，拒绝伪造定价执行任务 [BLOCKED / MANUAL_REQUIRED]。请通过 --price 或 --points-per-second 显式提供真实单价。`;
    const execRes: ExecutionResult = {
      executionId: `exec-${spec.testId}-pricing-blocked`,
      testId: spec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: { code: 'BLOCKED_PRICING_UNDETERMINED', message: errorMsg },
    };
    return {
      ok: false,
      taskId: 0,
      mode,
      modelId: resolvedModelId,
      mediaType,
      status: 'BLOCKED',
      points: 0,
      message: errorMsg,
      blockerCode: 'BLOCKED_PRICING_UNDETERMINED',
      disambiguation,
      canonicalSpec: spec as CanonicalTestSpec,
      executionResult: execRes,
    };
  }

  // 5. 别名门禁
  let effectiveAlias: string | undefined;
  if (mediaType === 'video') {
    const explicitAlias = typeof passedAlias === 'string' ? passedAlias.trim() : undefined;
    if (explicitAlias && explicitAlias.length > 0) {
      effectiveAlias = explicitAlias;
    } else if (STATIC_MODELS.video[resolvedModelId]) {
      effectiveAlias = resolvedModelId === 84 ? 'Wan3.0' : STATIC_MODELS.video[resolvedModelId].alias;
    } else if (
      contract.alias &&
      contract.alias.determined === true &&
      contract.alias.allowPass === true &&
      contract.alias.source !== 'SOURCE_DEFAULT_FALLBACK' &&
      contract.alias.source !== 'MANUAL_REQUIRED' &&
      typeof contract.alias.value === 'string' &&
      contract.alias.value.trim().length > 0
    ) {
      effectiveAlias = contract.alias.value.trim();
    }

    if (!effectiveAlias) {
      const errorMsg = `未知视频模型 #${resolvedModelId} 缺少显式 alias，拒绝猜测为 Wan3.0 执行 [BLOCKED_MISSING_INPUT]。请显式传入 alias 参数。`;
      const execRes: ExecutionResult = {
        executionId: `exec-${spec.testId}-alias-blocked`,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: { code: 'BLOCKED_MISSING_INPUT', message: errorMsg },
      };
      return {
        ok: false,
        taskId: 0,
        mode,
        modelId: resolvedModelId,
        mediaType,
        status: 'BLOCKED',
        points: 0,
        message: errorMsg,
        blockerCode: 'BLOCKED_MISSING_INPUT',
        disambiguation,
        canonicalSpec: spec as CanonicalTestSpec,
        executionResult: execRes,
      };
    }
  }

  const points = BillingOracle.calculateExpectedPoints({
    mediaType,
    modelId: resolvedModelId,
    duration: effectiveDuration,
    resolution: effectiveResolution,
    customPoints: customPoints ?? contract.pricing.customPoints?.value,
    pointsPerSecond: pointsPerSecond ?? contract.pricing.pointsPerSecond?.value,
  });

  // 6. 副作用与预算授权门禁 (关闭 REAL 自动授权，显式授权检查)
  if (spec.executionMode === 'REAL') {
    if (spec.sideEffectPolicy === 'READ_ONLY') {
      const errorMsg =
        'REAL 执行模式下 sideEffectPolicy 为 READ_ONLY，缺少显式 ALLOW_SUBMIT 或 ALLOW_PAID 授权，已在提交前安全阻断 [BLOCKED_UNAUTHORIZED_REAL_SUBMIT]';
      const execRes: ExecutionResult = {
        executionId: `exec-${spec.testId}-unauthorized-blocked`,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: { code: 'BLOCKED_UNAUTHORIZED_REAL_SUBMIT', message: errorMsg },
      };
      return {
        ok: false,
        taskId: 0,
        mode: 'real',
        modelId: resolvedModelId,
        mediaType,
        status: 'BLOCKED',
        points,
        message: errorMsg,
        blockerCode: 'BLOCKED_UNAUTHORIZED_REAL_SUBMIT',
        disambiguation,
        canonicalSpec: spec as CanonicalTestSpec,
        executionResult: execRes,
      };
    }

    if (points > 0) {
      if (spec.sideEffectPolicy !== 'ALLOW_PAID') {
        const errorMsg = `付费执行预期扣除 ${points} 积分，但 sideEffectPolicy 未显式授权为 ALLOW_PAID (当前为: ${spec.sideEffectPolicy}) [BLOCKED_UNAUTHORIZED_PAID_EXECUTION]`;
        const execRes: ExecutionResult = {
          executionId: `exec-${spec.testId}-unauthorized-paid`,
          testId: spec.testId,
          status: 'BLOCKED',
          evidence: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          error: { code: 'BLOCKED_UNAUTHORIZED_PAID_EXECUTION', message: errorMsg },
        };
        return {
          ok: false,
          taskId: 0,
          mode: 'real',
          modelId: resolvedModelId,
          mediaType,
          status: 'BLOCKED',
          points,
          message: errorMsg,
          blockerCode: 'BLOCKED_UNAUTHORIZED_PAID_EXECUTION',
          disambiguation,
          canonicalSpec: spec as CanonicalTestSpec,
          executionResult: execRes,
        };
      }

      if (spec.costLimit.allowZeroCostOnly || spec.costLimit.maxCostPoints < points) {
        const errorMsg = `付费执行预算不足：预期消耗 ${points} 积分，但授权预算上限为 ${spec.costLimit.maxCostPoints} 积分 [BLOCKED_INSUFFICIENT_COST_LIMIT]`;
        const execRes: ExecutionResult = {
          executionId: `exec-${spec.testId}-insufficient-cost`,
          testId: spec.testId,
          status: 'BLOCKED',
          evidence: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          error: { code: 'BLOCKED_INSUFFICIENT_COST_LIMIT', message: errorMsg },
        };
        return {
          ok: false,
          taskId: 0,
          mode: 'real',
          modelId: resolvedModelId,
          mediaType,
          status: 'BLOCKED',
          points,
          message: errorMsg,
          blockerCode: 'BLOCKED_INSUFFICIENT_COST_LIMIT',
          disambiguation,
          canonicalSpec: spec as CanonicalTestSpec,
          executionResult: execRes,
        };
      }
    }
  }

  // 7. Adapter 检查 (无 Adapter 时严格阻断，禁止静默回退内置执行路径)
  if (!dependencies.executionAdapter) {
    const errorMsg =
      'BLOCKED_NO_EXECUTION_ADAPTER: core-kernel 必须注入 ExecutionAdapter 才能执行，禁止静默回退内置执行路径';
    const execRes: ExecutionResult = {
      executionId: `exec-${spec.testId}-no-adapter`,
      testId: spec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: { code: 'BLOCKED_NO_EXECUTION_ADAPTER', message: errorMsg },
    };
    return {
      ok: false,
      taskId: 0,
      mode,
      modelId: resolvedModelId,
      mediaType,
      status: 'BLOCKED',
      points,
      message: errorMsg,
      blockerCode: 'BLOCKED_NO_EXECUTION_ADAPTER',
      disambiguation,
      canonicalSpec: spec as CanonicalTestSpec,
      executionResult: execRes,
    };
  }

  const adapter = dependencies.executionAdapter;

  // 8. Adapter 调用前门禁 (执行器隔离与模式检查，失败时 Adapter 调用次数必须为 0)
  if (!adapter.supportedModes.includes(spec.executionMode)) {
    const errorMsg = `BLOCKED_UNSUPPORTED_MODE: 适配器 ${adapter.adapterName} 不支持 executionMode: ${spec.executionMode}`;
    const execRes: ExecutionResult = {
      executionId: `exec-${spec.testId}-unsupported-mode`,
      testId: spec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: { code: 'BLOCKED_UNSUPPORTED_MODE', message: errorMsg },
    };
    return {
      ok: false,
      taskId: 0,
      mode,
      modelId: resolvedModelId,
      mediaType,
      status: 'BLOCKED',
      points,
      message: errorMsg,
      blockerCode: 'BLOCKED_UNSUPPORTED_MODE',
      disambiguation,
      canonicalSpec: spec as CanonicalTestSpec,
      executionResult: execRes,
    };
  }

  if (!adapter.supportedSideEffectPolicies.includes(spec.sideEffectPolicy)) {
    const errorMsg = `BLOCKED_UNSUPPORTED_POLICY: 适配器 ${adapter.adapterName} 不支持 sideEffectPolicy: ${spec.sideEffectPolicy}`;
    const execRes: ExecutionResult = {
      executionId: `exec-${spec.testId}-unsupported-policy`,
      testId: spec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: { code: 'BLOCKED_UNSUPPORTED_POLICY', message: errorMsg },
    };
    return {
      ok: false,
      taskId: 0,
      mode,
      modelId: resolvedModelId,
      mediaType,
      status: 'BLOCKED',
      points,
      message: errorMsg,
      blockerCode: 'BLOCKED_UNSUPPORTED_POLICY',
      disambiguation,
      canonicalSpec: spec as CanonicalTestSpec,
      executionResult: execRes,
    };
  }

  // 9. 通过 Adapter 执行 (context 只携带运行设施，例如 session、时钟或受控依赖；严禁以 env 作为独立执行依据)
  const adapterContext: Record<string, unknown> = {
    sessionFile: dependencies.sessionFile,
  };

  const effectiveSpec: CanonicalTestSpec = {
    ...spec,
    inputs: {
      ...spec.inputs,
      resolution: effectiveResolution,
      duration: effectiveDuration,
      aspectRatio: (spec.inputs?.aspectRatio as string | undefined) ?? contract.supportedAspectRatios?.value?.[0],
      serviceline: (spec.inputs?.serviceline as string | undefined) ?? contract.serviceline?.value,
    },
    metadata: {
      ...spec.metadata,
      alias: effectiveAlias,
      contract,
    },
  };

  let execRes: ExecutionResult;
  try {
    execRes = await adapter.execute(effectiveSpec, adapterContext);
    validateExecutionResult(execRes);
    if (Array.isArray(execRes?.evidence)) {
      for (const env of execRes.evidence) {
        if (!env || typeof env !== 'object' || env.testId !== effectiveSpec.testId) {
          throw new Error(
            `BLOCKED_INVALID_ADAPTER_OUTPUT: 证据信封 testId (${env?.testId}) 与执行规格 testId (${effectiveSpec.testId}) 不一致`,
          );
        }
        const v = validateEvidenceEnvelope(env);
        if (!v.valid) {
          throw new Error(
            `BLOCKED_INVALID_ADAPTER_OUTPUT: 证据信封校验失败: ${v.errors.map((e) => e.message).join('; ')}`,
          );
        }
        if (env.environment !== effectiveSpec.environment) {
          throw new Error(
            `BLOCKED_INVALID_ADAPTER_OUTPUT: 证据信封 [${env.evidenceId}] 的实际环境 ("${env.environment}") 与期望环境 ("${effectiveSpec.environment}") 不一致，拒绝环境篡改证据`,
          );
        }
      }
    }
  } catch (err: any) {
    const isVerdictViolation =
      err?.message?.includes('ADAPTER_ILLEGAL_VERDICT_FIELD') || err?.message?.includes('FORBIDDEN_VERDICT_FIELDS');
    const isAdapterOutputInvalid =
      err?.message?.includes('BLOCKED_INVALID_ADAPTER_OUTPUT') ||
      err?.message?.includes('validateExecutionResult') ||
      isVerdictViolation;
    const errorCode = isAdapterOutputInvalid ? 'BLOCKED_INVALID_ADAPTER_OUTPUT' : 'ADAPTER_EXECUTION_ERROR';
    const rawMsg = err instanceof Error ? err.message : String(err);
    const errorMsg = rawMsg.startsWith(errorCode) ? rawMsg : `${errorCode}: ${rawMsg}`;
    const blockedRes: ExecutionResult = {
      executionId: `exec-${effectiveSpec.testId}-adapter-error`,
      testId: effectiveSpec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: { code: errorCode, message: errorMsg },
    };
    return {
      ok: false,
      taskId: 0,
      mode,
      modelId: resolvedModelId,
      mediaType,
      status: 'BLOCKED',
      points,
      message: errorMsg,
      blockerCode: errorCode,
      disambiguation,
      canonicalSpec: effectiveSpec,
      executionResult: blockedRes,
    };
  }

  // 11. TestID 严格一致性校验
  if (execRes.testId !== effectiveSpec.testId) {
    const errorMsg = `BLOCKED_TEST_ID_MISMATCH: Adapter 输出 testId "${execRes.testId}" 与 CanonicalTestSpec testId "${effectiveSpec.testId}" 不一致`;
    const mismatchRes: ExecutionResult = {
      executionId: execRes.executionId,
      testId: effectiveSpec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt: execRes.startedAt,
      completedAt: execRes.completedAt,
      error: { code: 'BLOCKED_TEST_ID_MISMATCH', message: errorMsg },
    };
    return {
      ok: false,
      taskId: 0,
      mode,
      modelId: resolvedModelId,
      mediaType,
      status: 'BLOCKED',
      points,
      message: errorMsg,
      blockerCode: 'BLOCKED_TEST_ID_MISMATCH',
      disambiguation,
      canonicalSpec: effectiveSpec,
      executionResult: mismatchRes,
    };
  }

  const taskId = (execRes.metadata?.taskId as number) || 0;
  const isOk = execRes.status === 'SUBMITTED' || execRes.status === 'COMPLETED';

  return {
    ok: isOk,
    taskId,
    mode,
    modelId: resolvedModelId,
    mediaType,
    status: execRes.status === 'COMPLETED' ? 'SUCCESS' : (execRes.status as any),
    points,
    message: execRes.error?.message || (execRes.metadata?.message as string) || `任务执行完成 [${execRes.status}]`,
    disambiguation,
    canonicalSpec: effectiveSpec,
    executionResult: execRes,
    credentialsMasked: execRes.metadata?.credentialsMasked as string | undefined,
    rawResponse: execRes.metadata?.rawResponse as Record<string, unknown> | undefined,
    isSimulated: execRes.metadata?.isSimulated as boolean | undefined,
    simulationId:
      (execRes.metadata?.simulationId as string | undefined) ||
      (execRes.metadata?.isSimulated ? `sim-offline-${effectiveSpec.testId}` : undefined),
  };
}

export async function execute(options: ExecuteKernelOptions): Promise<ExecuteKernelResult> {
  // 1. 若传入 canonicalSpec，禁止同时传入任何业务 legacy 字段；只允许 executionAdapter、sessionFile、env、channels 等运行依赖
  if (options.canonicalSpec) {
    const spec = options.canonicalSpec;
    const allowedRuntimeKeys = new Set(['canonicalSpec', 'executionAdapter', 'sessionFile', 'env', 'channels']);
    const conflictKeys = Object.keys(options).filter(
      (k) => !allowedRuntimeKeys.has(k) && (options as Record<string, unknown>)[k] !== undefined,
    );
    if (conflictKeys.length > 0) {
      const errorMsg = `BLOCKED_SPEC_INPUT_CONFLICT: 传入 canonicalSpec 时禁止同时传入任何业务 legacy 字段 (发现冲突字段: ${conflictKeys.join(', ')})；只允许传入运行设施依赖 (executionAdapter, sessionFile, env, channels)`;
      const execRes: ExecutionResult = {
        executionId: `exec-${spec.testId}-conflict`,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: { code: 'BLOCKED_SPEC_INPUT_CONFLICT', message: errorMsg },
      };
      return {
        ok: false,
        taskId: 0,
        mode: spec.executionMode === 'REAL' ? 'real' : 'mock',
        modelId: spec.target?.modelId ?? 84,
        mediaType: (spec.inputs?.mediaType as 'video' | 'image') ?? 'video',
        status: 'BLOCKED' as const,
        points: 0,
        message: errorMsg,
        blockerCode: 'BLOCKED_SPEC_INPUT_CONFLICT',
        canonicalSpec: spec,
        executionResult: execRes,
      };
    }

    if (options.env !== undefined && options.env !== spec.environment) {
      const errorMsg = `BLOCKED_SPEC_INPUT_CONFLICT: 运行参数 env ('${options.env}') 与 canonicalSpec.environment ('${spec.environment}') 不一致，禁止产生双事实源冲突；执行环境必须完全以 canonicalSpec.environment 为准`;
      const execRes: ExecutionResult = {
        executionId: `exec-${spec.testId}-env-conflict`,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: { code: 'BLOCKED_SPEC_INPUT_CONFLICT', message: errorMsg },
      };
      return {
        ok: false,
        taskId: 0,
        mode: spec.executionMode === 'REAL' ? 'real' : 'mock',
        modelId: spec.target?.modelId ?? 84,
        mediaType: (spec.inputs?.mediaType as 'video' | 'image') ?? 'video',
        status: 'BLOCKED' as const,
        points: 0,
        message: errorMsg,
        blockerCode: 'BLOCKED_SPEC_INPUT_CONFLICT',
        canonicalSpec: spec,
        executionResult: execRes,
      };
    }

    return executeCanonical(spec, {
      executionAdapter: options.executionAdapter,
      channels: options.channels,
      sessionFile: options.sessionFile,
      env: options.env,
    });
  }

  // 2. 对外兼容函数负责把 legacy options 单向转换为 Canonical TestSpec
  const resolvedModelId = options.modelId ?? 84;
  const resolvedMediaType = options.mediaType ?? 'video';
  const resolvedContract =
    options.contract ||
    discoverModelContract(resolvedModelId, resolvedMediaType, {
      resolution: options.resolution,
      duration: options.duration,
      customPoints: options.customPoints,
      pointsPerSecond: options.pointsPerSecond,
      price: options.price,
      alias: options.alias,
    });

  const canonicalSpec = mapExecuteToCanonicalTestSpec(
    {
      ...options,
      modelId: resolvedModelId,
      mediaType: resolvedMediaType,
      contract: resolvedContract,
    } as unknown as Record<string, unknown>,
    {
      testId: options.testId,
      requirement: options.requirement,
      changedPaths: options.changedPaths,
      traces: options.traces,
      sideEffectPolicy: options.sideEffectPolicy,
      costLimit: options.costLimit,
      allowSubmit: options.allowSubmit,
      allowPaid: options.allowPaid,
      maxCostPoints: options.maxCostPoints,
    },
  );

  return executeCanonical(canonicalSpec, {
    executionAdapter: options.executionAdapter,
    channels: options.channels,
    sessionFile: options.sessionFile,
    env: options.env,
  });
}

export async function verify(options: VerifyKernelOptions): Promise<VerifyKernelResult> {
  const ctx = await resolveVerifyContext(options, options.contract);
  const taskResult = await collectTaskEvidence(ctx, options);
  const mediaResult = collectMediaEvidence(taskResult, ctx);
  const billingResult = await collectBillingEvidence(ctx, taskResult, options);
  const regressionDiff = computeRegressionDiff(
    options.baseline,
    ctx.contract,
    billingResult.billing,
    ctx.expectedPoints,
    mediaResult.artifact,
    billingResult.billingEvidence,
    mediaResult.mediaEvidence,
    taskResult.routingFacts.isDbExtraVerified,
    taskResult.routingFacts.isGatewayChannelRequired,
    taskResult.routingFacts.isGatewayChannelVerified,
    taskResult.terminalStatus,
  );
  const diffItems = buildDiffItems({
    options,
    ctx,
    taskResult,
    mediaResult,
    billingResult,
    regressionDiff,
  });
  return await computeFinalVerdict({
    options,
    ctx,
    taskResult,
    mediaResult,
    billingResult,
    regressionDiff,
    diffItems,
  });
}
