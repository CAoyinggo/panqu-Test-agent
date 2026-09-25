/**
 * verify 裁决投影组（verdict-projection）
 * =============================================================================
 * 由 verify-pipeline 物理分解而来（ARCHITECTURE_FREEZE §2.2 Phase 6 授权，2026-09-24）：
 * buildAutoDiversionEligibility / computeRegressionDiff / buildDiffItems / computeFinalVerdict。
 * 行为等价搬迁，零逻辑改动；共享类型经 `import type` 引自 verify-pipeline（运行时无反向依赖，无环）。
 * verify-pipeline 原样 re-export 本模块以保持公共导出面零变化。
 */
/**
 * Panqu AI DevTest — verify 证据流水线 (Phase 4 物理分解)
 *
 * 本模块依据 docs/ARCHITECTURE_FREEZE.md §2.2「Phase 4 core-kernel 物理分解授权」
 * (2026-09-23 人工明确授权) 从 core-kernel.ts 原样抽出,承载 verify 动作的证据采集与
 * 裁决投影流水线:resolveVerifyContext / collectTaskEvidence / collectMediaEvidence /
 * collectBillingEvidence / computeRegressionDiff / buildDiffItems / computeFinalVerdict。
 * 行为与原实现完全等价,未新增任何裁决语义或中间层。
 *
 * 依赖方向:core-kernel → verify-pipeline → 下层能力模块。严禁反向 import core-kernel。
 * 单一裁决权威仍为 canonical-verdict-engine;本模块只做证据搬运与投影。
 */

import type { discoverModelContract } from './env-probe.js';

import type { BillingOracle } from './billing.js';

import type { inspectMp4Buffer } from './media-inspector.js';

import type {
  ExpectedVsActual,
  DiffItem,
  DiversionBaseline,
  DiversionRegressionDiff,
  AcceptanceResult,
  EvidenceCompleteness,
  ProductionAcceptanceReport,
} from './types.js';
import { evaluateBusinessVerification, formatMemoryCandidate } from './domain-knowledge.js';
import type {
  CanonicalTestSpec,
  CanonicalEvidenceEnvelope,
  ExecutionMode,
  DeterministicAssertion,
} from './canonical-protocol.js';
import { evaluateCanonicalVerdict } from './canonical-verdict-engine.js';
import {
  buildCanonicalEvidenceFromVerifyFacts,
  projectCanonicalVerdictToLegacy,
  type CanonicalVerifyFacts,
  type LegacyLifecycleContext,
} from './legacy-protocol-mappers.js';
import type { EvidenceProducerContext } from './execution-ports.js';
import { mapVerdictToExportRecord } from './result-sink.js';
import { resolveRequirementTraceForSpec } from './requirement-trace.js';
import { DatabaseEvidenceProducer, resolveDatabaseCredentialsPath } from './database-evidence-producer.js';

import { DiversionEligibilityProducer, type DiversionEligibilityInput } from './diversion-eligibility-producer.js';
import { readDiversionConfig, toEligibilityRules } from './diversion-config-reader.js';
import { classifyDbForensics } from './db-preflight.js';

import type {
  MediaEvidence,
  BillingEvidence,
  VerifyKernelOptions,
  VerifyKernelResult,
  BuildDiffItemsOptions,
  ComputeFinalVerdictArgs,
} from './verify-pipeline.js';

/**
 * 一键构造分流资格断言输入：DB 侧规则/模型上下文经 readDiversionConfig+toEligibilityRules 自动补全，
 * 与调用方给的请求参数（分辨率/画面比例/路由组等）合并。fail-closed：配置读不到→返回 undefined（不产断言）。
 * VITEST 下若未给 config 则跳过真实读库，避免测试触网。
 */
export async function buildAutoDiversionEligibility(
  options: VerifyKernelOptions,
  modelId: number,
): Promise<DiversionEligibilityInput | undefined> {
  const a = options.autoDiversionEligibility;
  if (!a) return undefined;
  const mediaType = a.mediaType ?? options.mediaType ?? 'video';
  let cfg = a.config;
  if (!cfg) {
    if (process.env.VITEST) return undefined;
    cfg = await readDiversionConfig({ credPath: a.credPath, scriptPath: a.scriptPath, timeoutMs: a.timeoutMs });
  }
  if (cfg.status !== 'VERIFIED') return undefined;
  const b = toEligibilityRules(cfg, modelId);
  const resolution = a.resolution ?? options.resolution ?? '';
  const aspect = a.aspect ?? 'auto';
  if (mediaType === 'image') {
    return {
      mediaType: 'image',
      image: {
        selmodelsId: modelId,
        modelClass: a.modelClass,
        isGlobalModel: b.isGlobalModel,
        alias: b.alias,
        hasGlobalApiKey: b.hasGlobalApiKey,
        serviceline: a.serviceline ?? 'r',
        sizeType: a.sizeType,
        refImageCount: a.refImageCount,
        resolution,
        aspect,
        routeGroup: a.routeGroup ?? null,
        routeRules: b.routeRules,
        groupRules: b.groupRules,
      },
    };
  }
  return {
    mediaType: 'video',
    video: {
      routeMode: b.routeMode,
      eligible: a.eligible ?? true,
      modelId,
      isGlobalModel: b.isGlobalModel,
      alias: b.alias,
      hasGlobalApiKey: b.hasGlobalApiKey,
      resolution,
      aspect,
      routeGroup: a.routeGroup ?? null,
      routeRules: b.routeRules,
      groupRules: b.groupRules,
    },
  };
}
// ============================================================================
// Helper 5: computeRegressionDiff
// ============================================================================
export function computeRegressionDiff(
  baseline: DiversionBaseline | undefined,
  contract: ReturnType<typeof discoverModelContract>,
  billing: ReturnType<typeof BillingOracle.reconcileTaskLedger> | undefined,
  expectedPoints: number,
  artifact: ReturnType<typeof inspectMp4Buffer> | undefined,
  billingEvidence: BillingEvidence,
  mediaEvidence: MediaEvidence,
  isDbExtraVerified: boolean,
  isGatewayChannelRequired: boolean,
  isGatewayChannelVerified: boolean,
  terminalStatus?: string,
): DiversionRegressionDiff | undefined {
  if (!baseline) return undefined;

  const expectedChanges: Array<{ field: string; before: unknown; after: unknown; reason: string }> = [];
  const observedChanges: Array<{ field: string; before: unknown; after: unknown }> = [];
  const unexpectedChanges: Array<{ field: string; before: unknown; after: unknown; reason: string }> = [];
  const missingEvidence: string[] = [];

  // 1. 路由变化比对
  const currentRouting = contract.routing.value;
  const willDivertChanged = baseline.willDivert !== currentRouting.willDivert;
  const routeLineChanged = baseline.routeLine !== currentRouting.routeLine;
  if (willDivertChanged || routeLineChanged) {
    observedChanges.push({
      field: 'routing',
      before: `${baseline.decision} (line:${baseline.routeLine}, divert:${baseline.willDivert})`,
      after: `${currentRouting.decision} (line:${currentRouting.routeLine}, divert:${currentRouting.willDivert})`,
    });
    if (currentRouting.willDivert) {
      expectedChanges.push({
        field: 'routing',
        before: `${baseline.decision} (line:${baseline.routeLine})`,
        after: `${currentRouting.decision} (line:${currentRouting.routeLine})`,
        reason: '分流规则变更按预期切换至 NewAPI 路由',
      });
    } else {
      unexpectedChanges.push({
        field: 'routing',
        before: `${baseline.decision} (line:${baseline.routeLine})`,
        after: `${currentRouting.decision} (line:${currentRouting.routeLine})`,
        reason: '分流变更未能成功使流量切换至 NewAPI，仍为 Direct',
      });
    }
  } else if (!currentRouting.willDivert) {
    unexpectedChanges.push({
      field: 'routing',
      before: `${baseline.decision} (line:${baseline.routeLine})`,
      after: `${currentRouting.decision} (line:${currentRouting.routeLine})`,
      reason: '分流变更未生效，路由未发生预期切换 (未分流至 NewAPI)',
    });
  }

  // 2. 积分对账漂移比对
  const actualPoints = billing ? billing.netDeductedPoints : expectedPoints;
  if (actualPoints !== baseline.expectedPoints) {
    unexpectedChanges.push({
      field: 'billingPoints',
      before: baseline.expectedPoints,
      after: actualPoints,
      reason: `分流变更导致扣费积分发生非预期漂移 (基线: ${baseline.expectedPoints} pt, 实际: ${actualPoints} pt)`,
    });
    observedChanges.push({
      field: 'billingPoints',
      before: baseline.expectedPoints,
      after: actualPoints,
    });
  }

  // 3. 产物完整性与格式比对
  if (artifact) {
    if (!artifact.decodable) {
      unexpectedChanges.push({
        field: 'artifactDecodability',
        before: true,
        after: false,
        reason: '分流变更后产物损坏不可解码',
      });
      observedChanges.push({
        field: 'artifactDecodability',
        before: true,
        after: false,
      });
    }
    if (artifact.format && baseline.artifactFormat) {
      const actualFmt = artifact.format.toLowerCase();
      const baseFmt = baseline.artifactFormat.toLowerCase();
      const matches =
        (baseFmt === 'png/jpg' &&
          (actualFmt.includes('png') || actualFmt.includes('jpg') || actualFmt.includes('jpeg'))) ||
        (baseFmt === 'mp4' && actualFmt.includes('mp4')) ||
        actualFmt.includes(baseFmt) ||
        baseFmt.includes(actualFmt);
      if (!matches) {
        unexpectedChanges.push({
          field: 'artifactFormat',
          before: baseline.artifactFormat,
          after: artifact.format,
          reason: `分流变更后产物格式与基线不一致 (基线: ${baseline.artifactFormat}, 实际: ${artifact.format})`,
        });
        observedChanges.push({
          field: 'artifactFormat',
          before: baseline.artifactFormat,
          after: artifact.format,
        });
      }
    }
  }

  // 4. 别名一致性比对
  if (baseline.alias && contract.alias.value && baseline.alias !== contract.alias.value) {
    unexpectedChanges.push({
      field: 'alias',
      before: baseline.alias,
      after: contract.alias.value,
      reason: `模型别名与基线不一致 (基线: ${baseline.alias}, 实际: ${contract.alias.value})，可能导致既有业务调用失效`,
    });
    observedChanges.push({
      field: 'alias',
      before: baseline.alias,
      after: contract.alias.value,
    });
  }

  // 5. 关键证据缺失记录
  if (billingEvidence.status === 'UNVERIFIED') {
    missingEvidence.push('billingEvidence: 缺失实际账单流水证据');
  }
  if (mediaEvidence.status === 'UNVERIFIED' && terminalStatus !== 'FAILED') {
    missingEvidence.push('mediaEvidence: 缺失物理产物验证证据');
  }
  if (!isDbExtraVerified) {
    missingEvidence.push('MANUAL_DB_EVIDENCE_REQUIRED:extra.diversion (需DB只读核查 extra.diversion=10)');
  }
  if (isGatewayChannelRequired && !isGatewayChannelVerified) {
    missingEvidence.push('MANUAL_GATEWAY_CHANNEL_REQUIRED:缺少 NewAPI 视频模型网关渠道证据');
  }

  const isRegression = unexpectedChanges.length > 0;
  let regressionStatus: 'CLEAN' | 'REGRESSION' | 'UNKNOWN';
  if (unexpectedChanges.length > 0) {
    regressionStatus = 'REGRESSION';
  } else if (missingEvidence.length > 0) {
    regressionStatus = 'UNKNOWN';
  } else {
    regressionStatus = 'CLEAN';
  }

  return {
    expectedChanges,
    observedChanges,
    unexpectedChanges,
    missingEvidence,
    isRegression,
    regressionStatus,
  };
}

// ============================================================================
// Helper 6: buildDiffItems
// ============================================================================
export function buildDiffItems(args: BuildDiffItemsOptions): DiffItem[] {
  const { options, ctx, taskResult, mediaResult, billingResult, regressionDiff } = args;
  const { mediaType, expectedPoints, contract, resolution } = ctx;
  const { terminalStatus, taskEvidence, artifactBuffer, mediaArtifactSource, runtimeDetails, routingFacts } =
    taskResult;
  const { artifact } = mediaResult;
  const { billing, billingSource } = billingResult;
  const {
    isDbExtraVerified,
    extraObj,
    extraProvenance,
    hasEvidenceConflict,
    conflictReasons,
    targetChannelId,
    targetChannelName,
    actualChannelId,
    actualChannelName,
    isFallbackExecution,
    channelMatched,
    channelProvenance,
    channelMismatchReason,
    isActualChannelAssertedOnly,
    fallbackChannel,
    retryProvider,
    isGatewayChannelRequired,
    isGatewayChannelVerified,
    hasRealGatewaySnapshot,
    hasServerActualChannelFact,
    serverActualChannelId,
    snapshotValidation,
    isRealMode,
    gatewayChannelEvidence,
  } = routingFacts;

  const businessValidation =
    args.businessValidation ||
    evaluateBusinessVerification({
      taskId: ctx.taskId,
      modelId: ctx.modelId,
      mediaType: ctx.mediaType,
      apiResult: options.apiResult,
      taskTerminalStatus: terminalStatus === 'PROCESSING' ? 'UNKNOWN' : terminalStatus,
      mediaEvidence: {
        status: mediaResult.mediaEvidence.status,
        format: mediaResult.mediaEvidence.format,
        decodable: mediaResult.mediaEvidence.decodable,
        ownership: mediaResult.mediaEvidence.ownership,
        reason: mediaResult.mediaEvidence.reason,
      },
      billingEvidence: {
        status: billingResult.billingEvidence.status,
        netDeductedPoints: billingResult.billingEvidence.netDeductedPoints,
        expectedPoints: billingResult.billingEvidence.expectedPoints,
        reason: billingResult.billingEvidence.reason,
      },
      invariantsEvidence: {
        status: billingResult.invariantsEvidence.status,
        antiDoubleBilling: billingResult.invariantsEvidence.antiDoubleBilling,
        netChargeZero: billingResult.invariantsEvidence.netChargeZero,
        refundIdempotency: billingResult.invariantsEvidence.refundIdempotency,
        reason: billingResult.invariantsEvidence.reason,
      },
      paramRelations:
        options.projectId !== undefined || options.folderId !== undefined || options.isFolderInProject !== undefined
          ? {
              projectId: options.projectId,
              folderId: options.folderId,
              isFolderInProject: options.isFolderInProject,
            }
          : undefined,
      channelAssertion:
        targetChannelId !== undefined
          ? {
              targetChannelId,
              targetChannelName,
              actualChannelId,
              actualChannelName,
              fallbackChannel,
              retryProvider,
              hasEvidenceConflict,
              conflictReasons,
              isActualChannelAssertedOnly,
            }
          : undefined,
    });

  const diffItems: DiffItem[] = [
    {
      field: 'taskStatus',
      layer: 'execution',
      expected: options.terminalStatus ?? 'SUCCESS',
      actual: terminalStatus,
      matched: terminalStatus === (options.terminalStatus ?? 'SUCCESS'),
      status:
        terminalStatus === (options.terminalStatus ?? 'SUCCESS')
          ? 'PASS'
          : terminalStatus === 'UNKNOWN'
            ? 'BLOCKED'
            : 'FAIL',
      diff:
        terminalStatus === (options.terminalStatus ?? 'SUCCESS')
          ? 'MATCH'
          : `Expected ${options.terminalStatus ?? 'SUCCESS'}, got ${terminalStatus}`,
      critical: true,
      evidence: taskEvidence.source,
    },
    {
      field: 'mediaFormat',
      layer: 'artifact',
      expected: mediaType === 'video' ? 'mp4' : 'png/jpg',
      actual: artifact?.format || (terminalStatus === 'FAILED' ? 'NONE_TASK_FAILED' : 'MISSING_MEDIA'),
      matched: terminalStatus === 'FAILED' ? true : Boolean(artifact?.decodable),
      status: terminalStatus === 'FAILED' ? 'PASS' : artifact?.decodable ? 'PASS' : artifactBuffer ? 'FAIL' : 'BLOCKED',
      diff:
        terminalStatus === 'FAILED'
          ? 'MATCH (失败任务无产物)'
          : artifact?.decodable
            ? 'MATCH'
            : artifactBuffer
              ? `产物无法解码: ${artifact?.format || 'CORRUPTED'}`
              : '缺少媒体产物证据 [BLOCKED]',
      critical: true,
      evidence: mediaArtifactSource,
    },
    {
      field: 'billingPoints',
      layer: 'billing',
      expected: terminalStatus === 'FAILED' ? 0 : expectedPoints,
      actual: billing ? billing.netDeductedPoints : 'NO_SCORE_LOGS',
      matched: billing
        ? billing.netDeductedPoints === (terminalStatus === 'FAILED' ? 0 : expectedPoints) && contract.pricing.allowPass
        : false,
      status: !contract.pricing.allowPass
        ? 'BLOCKED'
        : billing
          ? billing.netDeductedPoints === (terminalStatus === 'FAILED' ? 0 : expectedPoints)
            ? 'PASS'
            : 'FAIL'
          : 'BLOCKED',
      diff: !contract.pricing.allowPass
        ? `刊例定价未确定 (${contract.pricing.source}) [BLOCKED]`
        : billing
          ? billing.netDeductedPoints === (terminalStatus === 'FAILED' ? 0 : expectedPoints)
            ? 'MATCH'
            : `Expected ${terminalStatus === 'FAILED' ? 0 : expectedPoints} pts, got ${billing.netDeductedPoints} pts`
          : '未提供账单流水，缺少真实账务证据 [BLOCKED_NO_LOGS]',
      critical: true,
      evidence: billingSource,
    },
    {
      field: 'diversionExtra',
      layer: 'routing',
      expected: contract.isGlobal.value
        ? 'extra.diversion=10 (global)'
        : 'extra.diversion=10 (org) / extra.newapi_image=1',
      actual: isDbExtraVerified
        ? `CONFIRMED_VIA_READONLY_HTTP_API (${JSON.stringify(extraObj)})`
        : runtimeDetails?.endpoints?.getEditData?.queryStatus === 'UNVERIFIED_MISSING_PROJECT_ID'
          ? 'UNVERIFIED_MISSING_PROJECT_ID'
          : 'NOT_FOUND_IN_HTTP_API_OR_DB (MANUAL_REQUIRED)',
      matched: isDbExtraVerified,
      status: isDbExtraVerified ? 'PASS' : 'MANUAL_REQUIRED',
      diff: isDbExtraVerified
        ? 'MATCH'
        : runtimeDetails?.endpoints?.getEditData?.queryStatus === 'UNVERIFIED_MISSING_PROJECT_ID'
          ? '缺少 projectId，无法查询 /aivideo/v2/video/getEditData 接口 [UNVERIFIED_MISSING_PROJECT_ID]'
          : '未从只读 HTTP 接口获取到 extra.diversion，需以只读权限查询 DB 验证落库 [MANUAL_REQUIRED]',
      critical: false,
      evidence: extraProvenance,
    },
    {
      field: 'businessValidation',
      layer: 'domain',
      expected: 'BUSINESS_SUCCESS',
      actual: businessValidation.businessSuccess
        ? 'BUSINESS_SUCCESS'
        : businessValidation.status === 'FAIL'
          ? 'BUSINESS_FAIL'
          : 'BUSINESS_UNVERIFIED',
      matched: businessValidation.businessSuccess,
      status: businessValidation.businessSuccess ? 'PASS' : businessValidation.status === 'FAIL' ? 'FAIL' : 'BLOCKED',
      diff: businessValidation.businessSuccess
        ? 'MATCH'
        : businessValidation.reasons.join('; ') || '业务级验证未全部满足',
      critical: true,
      evidence: 'evaluateBusinessVerification',
    },
  ];

  if (hasEvidenceConflict) {
    diffItems.push({
      field: 'evidenceConflict',
      layer: 'routing',
      expected: 'Caller assertions match server facts',
      actual: 'EVIDENCE_CONFLICT',
      matched: false,
      status: 'FAIL',
      diff: conflictReasons.join('; '),
      critical: true,
      evidence: 'EVIDENCE_CONFLICT',
    });
  }

  if (targetChannelId !== undefined) {
    diffItems.push({
      field: 'channelAttribution',
      layer: 'routing',
      expected: `Channel #${targetChannelId} ('${targetChannelName || targetChannelId}')`,
      actual:
        actualChannelId !== undefined
          ? `Channel #${actualChannelId} ('${actualChannelName || actualChannelId}')${isFallbackExecution ? ` [Fallback: ${fallbackChannel || retryProvider}]` : ''}`
          : 'UNVERIFIED_RUNTIME_CHANNEL',
      matched: channelMatched === true && !isFallbackExecution && !hasEvidenceConflict && !isActualChannelAssertedOnly,
      status:
        channelMatched === true && !isFallbackExecution && !hasEvidenceConflict && !isActualChannelAssertedOnly
          ? 'PASS'
          : channelMatched === false || isFallbackExecution || hasEvidenceConflict
            ? 'FAIL'
            : 'BLOCKED',
      diff: hasEvidenceConflict
        ? `存在证据冲突: ${conflictReasons.join('; ')}`
        : isActualChannelAssertedOnly
          ? '实际执行渠道仅来自调用者入参断言，无服务端运行时证据证实 [UNVERIFIED_ASSERTED_INPUT]'
          : channelMismatchReason || 'MATCH',
      critical: true,
      evidence: channelProvenance,
    });
  }

  if (isGatewayChannelRequired) {
    const isCallerAssertedReal =
      isRealMode &&
      (Boolean(options.gatewayChannelConfirmed) ||
        Boolean(options.channels && options.channels.some((c) => c.sourceMode === 'SOURCE_REAL_GATEWAY')));
    const snapshotFailure = options.gatewaySnapshot && !snapshotValidation?.valid;

    diffItems.push({
      field: 'gatewayChannel',
      layer: 'routing',
      expected: 'NewAPI upstream channel configured',
      actual: isGatewayChannelVerified
        ? hasRealGatewaySnapshot
          ? `${(options.gatewaySnapshot?.channels || options.channels)?.length} channel(s) (REAL_GATEWAY_SNAPSHOT)`
          : hasServerActualChannelFact
            ? `Channel #${serverActualChannelId}`
            : 'CONFIRMED (FIXTURE)'
        : snapshotFailure
          ? `FAIL_CLOSED (${snapshotValidation?.reason})`
          : isCallerAssertedReal
            ? 'UNVERIFIED_USER_ASSERTION (REAL 模式禁止外部断言作为网关实际渠道履约证据)'
            : 'MISSING_GATEWAY_CHANNEL_EVIDENCE [BLOCKED_MISSING_TRUSTED_COLLECTOR]',
      matched: isGatewayChannelVerified,
      status: isGatewayChannelVerified ? 'PASS' : 'MANUAL_REQUIRED',
      diff: isGatewayChannelVerified
        ? 'MATCH (网关实际履约渠道已核验)'
        : snapshotFailure
          ? `网关渠道快照未通过可信校验: ${snapshotValidation?.reason} [FAIL_CLOSED]`
          : isCallerAssertedReal
            ? 'REAL 模式下禁止仅凭外部断言 (--gateway-channel-confirmed) 满足网关渠道验证，必须提供 NewAPI 网关真实快照 (SOURCE_REAL_GATEWAY) [BLOCKED_MISSING_TRUSTED_COLLECTOR]'
            : '缺少 NewAPI 网关上游通道确认证据 [MANUAL_GATEWAY_CHANNEL_REQUIRED:BLOCKED_MISSING_TRUSTED_COLLECTOR]',
      critical: true,
      evidence: gatewayChannelEvidence,
    });
  }

  if (options.unconfirmedStatic) {
    diffItems.push({
      field: 'staticContractConfirmation',
      layer: 'contract',
      expected: 'Static contract confirmed by real data/manual input',
      actual: 'UNCONFIRMED_STATIC',
      matched: false,
      status: 'BLOCKED',
      diff: '静态契约未经过线上事实或人工输入验真 [BLOCKED]',
      critical: true,
      evidence: 'SOURCE_STATIC_CONTRACT',
    });
  }

  if (artifact?.dimensions) {
    const expectedRes = String(options.expectedResolution || resolution || '720p')
      .toLowerCase()
      .trim();
    const { width, height } = artifact.dimensions;
    const minDim = Math.min(width, height);
    // 分辨率档位 → 特征像素(短边)。视频/图片档位都以「短边≈档位数」为特征
    // (如 720p→短边720；1k 图片 1792x1024→短边1024)。档位与像素并非严格一一对应(随画面比例浮动)，
    // 故仅在短边落入 ±15% 容差时判 PASS；无法自动确证时判 MANUAL_REQUIRED，绝不臆断 PASS(堵住"永远 MATCH"的假验证)。
    const tierMap: Record<string, number> = {
      '480p': 480,
      '720p': 720,
      '768p': 768,
      '1080p': 1080,
      '2k': 2048,
      '4k': 4096,
      '1k': 1024,
    };
    const tier = tierMap[expectedRes];
    const dimMatched = tier !== undefined && Math.abs(minDim - tier) <= tier * 0.15;
    diffItems.push({
      field: 'dimensions',
      layer: 'artifact',
      expected: expectedRes,
      actual: `${width}x${height}`,
      matched: dimMatched,
      status: dimMatched ? 'PASS' : 'MANUAL_REQUIRED',
      diff: dimMatched
        ? 'MATCH'
        : `分辨率档位(${expectedRes})与实际像素(${width}x${height})无法自动确证一致，需人工确认 [MANUAL_REQUIRED]`,
      critical: false,
      evidence: `${mediaArtifactSource}:${artifact.format}`,
    });
  }

  if (regressionDiff) {
    diffItems.push({
      field: 'diversionRegression',
      layer: 'regression',
      expected: 'No unexpected changes',
      actual: regressionDiff.isRegression
        ? `${regressionDiff.unexpectedChanges.length} unexpected change(s)`
        : regressionDiff.regressionStatus === 'UNKNOWN'
          ? 'Regression status unknown (missing evidence)'
          : 'Clean (no regression)',
      matched: !regressionDiff.isRegression && regressionDiff.regressionStatus === 'CLEAN',
      status: regressionDiff.isRegression ? 'FAIL' : regressionDiff.regressionStatus === 'UNKNOWN' ? 'BLOCKED' : 'PASS',
      diff: regressionDiff.isRegression
        ? regressionDiff.unexpectedChanges.map((u) => u.reason).join('; ')
        : regressionDiff.regressionStatus === 'UNKNOWN'
          ? '缺少基线比对关键证据，无法确定无回归 [regressionStatus: UNKNOWN]'
          : 'MATCH',
      critical: true,
      evidence: 'BaselineComparison',
    });
  }

  if (contract.conflicts.length > 0) {
    diffItems.push({
      field: 'configurationConsistency',
      layer: 'contract',
      expected: 'No config conflicts',
      actual: `${contract.conflicts.length} conflict(s): ${contract.conflicts.map((c) => c.message).join('; ')}`,
      matched: false,
      status: 'FAIL',
      diff: contract.conflicts.map((c) => c.message).join('; '),
      critical: true,
      evidence: 'CONFIG_MISMATCH',
    });
  }

  return diffItems;
}

// ============================================================================
// Helper 7: computeFinalVerdict
// ============================================================================
export async function computeFinalVerdict(args: ComputeFinalVerdictArgs): Promise<VerifyKernelResult> {
  const { options, ctx, taskResult, mediaResult, billingResult, regressionDiff, diffItems } = args;

  const { taskId, modelId, mediaType, contract, expectedPoints, session, executionMode } = ctx;
  const { terminalStatus, taskEvidence, artifactBuffer, artifactOwnership, routingFacts } = taskResult;
  const { artifact, mediaEvidence } = mediaResult;
  const { billing, billingEvidence, invariants, scoreLogsToReconcile } = billingResult;
  const {
    targetChannelId,
    targetChannelName,
    actualChannelId,
    actualChannelName,
    isActualChannelAssertedOnly,
    hasEvidenceConflict,
    conflictReasons,
    isFallbackExecution,
    channelMatched,
    channelProvenance,
    fallbackProvenance,
    retryProvenance,
    extraProvenance,
    gatewayChannelProvenance,
    isDbExtraVerified,
    isGatewayChannelRequired,
    isGatewayChannelVerified,
    targetChannelFailed,
    targetChannelUnverified: _targetChannelUnverified,
    snapshotValidation,
    fallbackChannel,
    retryProvider,
    channelMismatchReason,
    extraObj,
    hasRealGatewaySnapshot,
    isRealMode,
  } = routingFacts;

  const businessValidation =
    args.businessValidation ||
    evaluateBusinessVerification({
      taskId,
      modelId,
      mediaType,
      apiResult: options.apiResult,
      taskTerminalStatus: terminalStatus === 'PROCESSING' ? 'UNKNOWN' : terminalStatus,
      mediaEvidence: {
        status: mediaEvidence.status,
        format: mediaEvidence.format,
        decodable: mediaEvidence.decodable,
        ownership: mediaEvidence.ownership,
        reason: mediaEvidence.reason,
      },
      billingEvidence: {
        status: billingEvidence.status,
        netDeductedPoints: billingEvidence.netDeductedPoints,
        expectedPoints: billingEvidence.expectedPoints,
        reason: billingEvidence.reason,
      },
      invariantsEvidence: {
        status: billingResult.invariantsEvidence.status,
        antiDoubleBilling: billingResult.invariantsEvidence.antiDoubleBilling,
        netChargeZero: billingResult.invariantsEvidence.netChargeZero,
        refundIdempotency: billingResult.invariantsEvidence.refundIdempotency,
        reason: billingResult.invariantsEvidence.reason,
      },
      paramRelations:
        options.projectId !== undefined || options.folderId !== undefined || options.isFolderInProject !== undefined
          ? {
              projectId: options.projectId,
              folderId: options.folderId,
              isFolderInProject: options.isFolderInProject,
            }
          : undefined,
      channelAssertion:
        targetChannelId !== undefined
          ? {
              targetChannelId,
              targetChannelName,
              actualChannelId,
              actualChannelName,
              fallbackChannel,
              retryProvider,
              hasEvidenceConflict,
              conflictReasons,
              isActualChannelAssertedOnly,
            }
          : undefined,
    });

  const reasons: string[] = [];
  if (taskEvidence.status === 'PROCESSING' || terminalStatus === 'PROCESSING') {
    reasons.push(
      `任务 #${taskId} 仍在排队/生成中 (进度: ${taskEvidence.progress ?? options.progress ?? 0}%)，未到达终态。`,
    );
  }
  if (taskEvidence.status === 'FAIL') reasons.push(`任务执行失败: ${taskEvidence.error || '任务状态异常'}`);
  if (taskEvidence.status === 'UNVERIFIED') reasons.push(taskEvidence.error || '任务状态未确认 [UNVERIFIED]');
  if (mediaEvidence.status === 'FAIL') reasons.push(`产物物理完整性校验失败: ${mediaEvidence.reason || '文件损坏'}`);
  if (mediaEvidence.status === 'UNVERIFIED' && terminalStatus !== 'FAILED') {
    reasons.push(mediaEvidence.reason || '媒体产物状态未确认 [UNVERIFIED]');
  }
  if (billingEvidence.status === 'FAIL') reasons.push(`账单审计失败: ${billingEvidence.reason}`);
  if (billingEvidence.status === 'UNVERIFIED') {
    reasons.push(billingEvidence.reason || '账单流水证据未确认 [UNVERIFIED]');
  }
  if (billingResult.invariantsEvidence.status === 'FAIL') {
    reasons.push(billingResult.invariantsEvidence.reason || '违背金融安全不变量 [FAIL]');
  }
  if (regressionDiff?.isRegression) {
    for (const u of regressionDiff.unexpectedChanges) {
      reasons.push(`[分流回归阻断] ${u.reason}`);
    }
  }
  if (contract.conflicts.length > 0) {
    for (const c of contract.conflicts) {
      reasons.push(`[配置冲突] ${c.message}`);
    }
  }
  if (hasEvidenceConflict) {
    for (const c of conflictReasons) {
      if (!reasons.includes(c)) reasons.push(c);
    }
  }
  if (isActualChannelAssertedOnly) {
    reasons.push('实际执行渠道仅来自调用者入参断言，无服务端运行时证据证实 [PROVISIONAL_EVIDENCE]');
  }
  if (channelMismatchReason) {
    reasons.push(`[渠道履约失败] ${channelMismatchReason}`);
  }
  if (businessValidation.status === 'FAIL') {
    for (const r of businessValidation.reasons) {
      if (!reasons.includes(r)) reasons.push(r);
    }
  }

  // 证据完整度计算
  const requiredEvidence: string[] = [
    'taskTerminalStatus',
    'mediaArtifactDecodable',
    'billingLedgerReconciled',
    'pricingDetermined',
    'diversionDbExtra',
  ];
  if (isGatewayChannelRequired) {
    requiredEvidence.push('gatewayChannelConfirmed');
  }
  if (targetChannelId !== undefined) {
    requiredEvidence.push('targetChannelFulfilled');
  }
  if (options.baseline) {
    requiredEvidence.push('baselineRegressionVerified');
  }

  const availableEvidence: string[] = [];
  const missingEvidence: string[] = [];

  if (taskEvidence.status === 'PASS' || (terminalStatus === 'FAILED' && options.terminalStatus === 'FAILED')) {
    availableEvidence.push('taskTerminalStatus');
  } else {
    missingEvidence.push(
      taskEvidence.status === 'FAIL' ? 'taskTerminalStatus:FAILED' : 'taskTerminalStatus:UNVERIFIED',
    );
  }

  if (mediaEvidence.status === 'PASS' || (terminalStatus === 'FAILED' && !artifactBuffer)) {
    availableEvidence.push('mediaArtifactDecodable');
  } else {
    missingEvidence.push(
      mediaEvidence.status === 'FAIL' ? 'mediaArtifactDecodable:CORRUPTED' : 'mediaArtifactDecodable:UNVERIFIED',
    );
  }

  if (billingEvidence.status === 'PASS') {
    availableEvidence.push('billingLedgerReconciled');
  } else {
    missingEvidence.push(
      billingEvidence.status === 'FAIL' ? 'billingLedgerReconciled:AUDIT_FAILED' : 'billingLedgerReconciled:NO_LOGS',
    );
  }

  if (
    contract.pricing.allowPass &&
    contract.pricing.isPricingDetermined &&
    contract.pricing.source !== 'SOURCE_DEFAULT_FALLBACK'
  ) {
    availableEvidence.push('pricingDetermined');
  } else {
    missingEvidence.push(`pricingDetermined:${contract.pricing.source}`);
  }

  if (isDbExtraVerified) {
    availableEvidence.push('diversionDbExtra');
  } else {
    missingEvidence.push('MANUAL_DB_EVIDENCE_REQUIRED:extra.diversion');
  }

  if (isGatewayChannelRequired) {
    if (isGatewayChannelVerified) {
      availableEvidence.push('gatewayChannelConfirmed');
    } else {
      missingEvidence.push('MANUAL_GATEWAY_CHANNEL_REQUIRED:gatewayChannel');
    }
  }

  if (targetChannelId !== undefined) {
    if (channelMatched === true && !isFallbackExecution) {
      availableEvidence.push('targetChannelFulfilled');
    } else if (targetChannelFailed) {
      missingEvidence.push('targetChannelFulfilled:FAILED');
    } else {
      missingEvidence.push('targetChannelFulfilled:UNVERIFIED');
    }
  }

  if (options.baseline) {
    if (regressionDiff && regressionDiff.regressionStatus === 'CLEAN') {
      availableEvidence.push('baselineRegressionVerified');
    } else if (regressionDiff && regressionDiff.regressionStatus === 'REGRESSION') {
      missingEvidence.push('baselineRegressionVerified:REGRESSION_DETECTED');
    } else {
      missingEvidence.push('baselineRegressionVerified:UNKNOWN_DUE_TO_MISSING_EVIDENCE');
    }
  }

  const isComplete = missingEvidence.length === 0;
  const evidenceCompleteness: EvidenceCompleteness = {
    requiredEvidence,
    availableEvidence,
    missingEvidence,
    isComplete,
  };

  // ==========================================================================
  // Canonical Verdict Engine 唯一最终业务裁决求值
  // ==========================================================================
  const capturedAt = options.capturedAt || new Date().toISOString();
  const testId = options.testId || options.spec?.testId || `verify-${taskId}`;
  const environment = options.environment || options.spec?.environment || options.env || 'test';
  const rawMode: 'real' | 'offline' | 'fixture' =
    options.mode === 'mock' || options.isSimulated || executionMode === 'offline'
      ? 'offline'
      : executionMode === 'fixture'
        ? 'fixture'
        : executionMode === 'real' || options.executionMode?.toLowerCase() === 'real'
          ? 'real'
          : session
            ? 'real'
            : 'fixture';
  const canonicalExecutionMode: ExecutionMode =
    rawMode === 'real' ? 'REAL' : rawMode === 'offline' ? 'OFFLINE' : 'FIXTURE';

  const facts: CanonicalVerifyFacts = {
    testId,
    capturedAt,
    environment,
    executionMode: rawMode,
    taskId,
    modelId,
    mediaType,
    progress: options.progress,
    task: taskEvidence,
    artifact: artifact
      ? {
          ...artifact,
          ownership: artifactOwnership,
          status: mediaEvidence.status,
        }
      : undefined,
    artifactOwnership,
    billing: billing
      ? {
          status: billingEvidence.status,
          passed: billing.passed,
          settledPoints: billing.settledPoints,
          netDeductedPoints: billing.netDeductedPoints,
          preDeductedPoints: billing.preDeductedPoints,
          expectedPoints,
          hasViolations: Boolean(
            billing.duplicateCharged ||
            billing.duplicateRefunded ||
            billing.missingRefund ||
            billing.underCharged ||
            billing.overCharged ||
            billing.antiDoubleBilling === false ||
            billing.netChargeZero === false ||
            billing.refundIdempotency === false,
          ),
        }
      : undefined,
    billingAudit: billing && scoreLogsToReconcile && scoreLogsToReconcile.length > 0 ? 'AUDITED' : 'SKIPPED_NO_LOGS',
    expectedChargeSource: billingEvidence?.expectedChargeSource,
    pricingAllowPass: contract?.pricing?.allowPass,
    invariants,
    channelDetail: businessValidation?.channelDetail,
    provenance: {
      actualChannelId: channelProvenance,
      fallbackChannel: fallbackProvenance,
      retryProvider: retryProvenance,
      extra: extraProvenance,
      gatewayChannel: gatewayChannelProvenance,
    },
    isActualChannelAssertedOnly,
    hasEvidenceConflict,
    conflictReasons,
    regressionDiff: regressionDiff
      ? {
          isRegression: regressionDiff.isRegression,
          regressionStatus: regressionDiff.regressionStatus,
          unexpectedChanges: regressionDiff.unexpectedChanges,
        }
      : undefined,
    contractConflicts: contract.conflicts.length > 0 ? contract.conflicts : undefined,
    businessValidationStatus: businessValidation.status,
    gatewayChannelFact:
      isGatewayChannelRequired && (options.gatewaySnapshot || options.gatewayChannelConfirmed || options.channels)
        ? {
            verified: isGatewayChannelVerified,
            required: true,
            failureReason:
              options.gatewaySnapshot && !snapshotValidation?.valid
                ? snapshotValidation?.reason
                : isRealMode && !hasRealGatewaySnapshot
                  ? '真实模式下外部断言 (--gateway-channel-confirmed) 严禁作为网关履约事实，缺少 NewAPI 网关真实快照'
                  : undefined,
          }
        : undefined,
    isDbExtraVerified,
  };

  const evidenceRes = buildCanonicalEvidenceFromVerifyFacts(facts);
  let envelopes: CanonicalEvidenceEnvelope[] = evidenceRes.success && evidenceRes.value ? evidenceRes.value : [];
  if (Array.isArray(options.extraEnvelopes)) {
    envelopes = [...envelopes, ...options.extraEnvelopes];
  }

  // 聚合 options.evidenceProducers 产出的真实观察信封
  const producers = [...(options.evidenceProducers ?? [])];
  const dbCollectionToUse = taskResult.dbEvidence ?? options.dbRawCollection;
  const hasDbProducer = producers.some((p) => p.producerName === 'database-evidence-producer');
  const shouldAttachDbProducer =
    !hasDbProducer &&
    (dbCollectionToUse !== undefined ||
      options.dbVerify === true ||
      (options.dbVerify !== false &&
        !process.env.VITEST &&
        Boolean(resolveDatabaseCredentialsPath(options.dbCredPath))));

  if (shouldAttachDbProducer) {
    producers.push(new DatabaseEvidenceProducer());
  }

  // opt-in：分流运行时资格断言（预测 vs 落库分流标记）。diversionEligibility 直传优先；
  // 否则 autoDiversionEligibility 一键读 line=10 配置自动构造（VITEST 下不触网）。
  const hasDiversionProducer = producers.some((p) => p.producerName === 'diversion-eligibility-producer');
  const effectiveDiversionEligibility =
    options.diversionEligibility ??
    (options.autoDiversionEligibility ? await buildAutoDiversionEligibility(options, modelId) : undefined);
  if (!hasDiversionProducer && effectiveDiversionEligibility) {
    producers.push(new DiversionEligibilityProducer(effectiveDiversionEligibility, dbCollectionToUse));
  }

  if (producers.length > 0) {
    const producerContext: EvidenceProducerContext = {
      testId,
      environment,
      subjectType: 'task',
      subjectId: taskId,
      executionMode: canonicalExecutionMode,
      taskId,
      modelId,
      mediaType,
      capturedAt,
    };
    for (const producer of producers) {
      try {
        const raw =
          producer.producerName === 'database-evidence-producer'
            ? dbCollectionToUse
            : producer.producerName.includes('visual') || producer.sourceType === 'AI_OBSERVATION'
              ? (options.uiVisualRawCollection ?? options.uiRawCollection)
              : (options.uiRawCollection ?? options);
        const produced = await producer.produce(raw, producerContext);
        if (Array.isArray(produced)) {
          envelopes.push(...produced);
        }
      } catch (err) {
        envelopes.push({
          evidenceId: `${testId}-${producer.producerName}-err`,
          testId,
          sourceTool: producer.producerName,
          sourceType: producer.sourceType,
          evidenceKey: `${producer.sourceType}:PRODUCER_ERROR`,
          observationStatus: 'UNVERIFIED',
          capturedAt,
          environment,
          subjectType: 'task',
          subjectId: taskId,
          normalizedFields: {
            error: err instanceof Error ? err.message : String(err),
          },
          provenance: `${producer.producerName}:FALLBACK`,
          confidence: 0,
          immutable: true,
          redacted: true,
          collectionStatus: 'COLLECTION_FAILED',
        });
      }
    }
  }

  let canonicalSpec: CanonicalTestSpec;
  if (options.spec) {
    canonicalSpec = options.spec;
    if (hasEvidenceConflict) {
      const isRealSpec = canonicalExecutionMode === 'REAL';
      const conflictKey = isRealSpec ? 'SERVER_API:EVIDENCE_CONFLICT' : 'FIXTURE:EVIDENCE_CONFLICT';
      const hasConflictReq = canonicalSpec.requiredEvidence.includes(conflictKey);
      const hasConflictAssertion = canonicalSpec.deterministicAssertions.some(
        (a) => a.evidenceKey === conflictKey || a.actualField === 'hasConflict',
      );
      if (!hasConflictReq || !hasConflictAssertion) {
        canonicalSpec = {
          ...canonicalSpec,
          requiredEvidence: hasConflictReq
            ? canonicalSpec.requiredEvidence
            : [...canonicalSpec.requiredEvidence, conflictKey],
          deterministicAssertions: hasConflictAssertion
            ? canonicalSpec.deterministicAssertions
            : [
                ...canonicalSpec.deterministicAssertions,
                {
                  field: 'hasConflict',
                  operator: 'EQUALS',
                  expectedValue: false,
                  description: '无多方证据冲突',
                  critical: true,
                  evidenceKey: conflictKey,
                  actualField: 'hasConflict',
                },
              ],
        };
      }
    }
  } else {
    const isRealSpec = canonicalExecutionMode === 'REAL';
    const taskKey = isRealSpec ? 'SERVER_API:TASK_STATUS' : 'FIXTURE:TASK_STATUS';
    const routingKey = isRealSpec ? 'SERVER_API:ROUTING_CHANNEL' : 'FIXTURE:ROUTING_CHANNEL';

    const reqEvidence: string[] = [taskKey];
    if (mediaType === 'video' || mediaType === 'image') {
      reqEvidence.push('MEDIA_BINARY:CONTAINER_CHECK');
    }
    const isBillingInScope =
      (contract.pricing.allowPass &&
        contract.pricing.isPricingDetermined &&
        contract.pricing.source !== 'SOURCE_DEFAULT_FALLBACK') ||
      (expectedPoints !== undefined && expectedPoints > 0) ||
      (scoreLogsToReconcile && scoreLogsToReconcile.length > 0) ||
      !contract.pricing.allowPass ||
      !contract.pricing.isPricingDetermined;
    if (isBillingInScope) {
      reqEvidence.push('BILLING_LEDGER:TASK_RECORDS');
    }
    if (isRealSpec && (dbCollectionToUse !== undefined || options.dbVerify === true || !process.env.VITEST)) {
      reqEvidence.push('SERVER_API:DB_TASK_RECORD');
      if (isBillingInScope || terminalStatus !== 'UNKNOWN' || (expectedPoints !== undefined && expectedPoints > 0)) {
        reqEvidence.push('BILLING_LEDGER:DB_SCORE_LOGS');
      }
    }
    if (targetChannelId !== undefined) {
      reqEvidence.push(routingKey);
    }
    if (options.baseline) {
      reqEvidence.push(isRealSpec ? 'SERVER_API:REGRESSION_BASELINE' : 'FIXTURE:REGRESSION_BASELINE');
    }
    // 业务一致性、证据冲突、领域校验总是加入必需证据 (禁止仅在失败时加入)
    reqEvidence.push(isRealSpec ? 'SERVER_API:CONTRACT_CONSISTENCY' : 'FIXTURE:CONTRACT_CONSISTENCY');
    reqEvidence.push(isRealSpec ? 'SERVER_API:EVIDENCE_CONFLICT' : 'FIXTURE:EVIDENCE_CONFLICT');
    reqEvidence.push(isRealSpec ? 'SERVER_API:BUSINESS_VALIDATION' : 'FIXTURE:BUSINESS_VALIDATION');

    // 网关渠道证据要求 (REAL 模式或显式传入网关配置/确认时要求)
    const isGatewayInScope =
      isRealSpec ||
      options.gatewayChannelConfirmed !== undefined ||
      options.gatewaySnapshot !== undefined ||
      options.channels !== undefined;
    if (isGatewayChannelRequired && isGatewayInScope) {
      reqEvidence.push(isRealSpec ? 'SERVER_API:GATEWAY_CHANNEL' : 'FIXTURE:GATEWAY_CHANNEL');
    }

    // 需要核验 extra.diversion 时，即使没有 DB/API 证据也必须要求对应 evidenceKey
    const isDiversionScenario =
      contract.scenario === 'IMAGE_DIVERSION_CHANGE' ||
      contract.scenario === 'VIDEO_DIVERSION_CHANGE' ||
      options.changeType === 'diversion_change';
    const isExtraRequired = !contract.isGlobal.value && isDiversionScenario;
    if (isExtraRequired) {
      reqEvidence.push(isRealSpec ? 'SERVER_API:EXTRA_DIVERSION' : 'FIXTURE:EXTRA_DIVERSION');
    }

    const deterministicAssertions: DeterministicAssertion[] = [];

    // 计费断言
    if (
      typeof expectedPoints === 'number' &&
      contract.pricing.allowPass &&
      contract.pricing.isPricingDetermined &&
      terminalStatus !== 'UNKNOWN'
    ) {
      deterministicAssertions.push({
        field: 'billing.actualCharge',
        operator: 'EQUALS',
        expectedValue: expectedPoints,
        description: '预期刊例积分扣减值与实际计费一致',
        critical: true,
        evidenceKey: 'BILLING_LEDGER:TASK_RECORDS',
        actualField: 'actualCharge',
      });
    }

    // 路由承接渠道断言
    if (typeof targetChannelId === 'number' && targetChannelId > 0) {
      deterministicAssertions.push({
        field: 'routing.expectedChannelId',
        operator: 'EQUALS',
        expectedValue: targetChannelId,
        description: '预期承接网关渠道 ID',
        critical: true,
        evidenceKey: routingKey,
        actualField: 'actualValue',
      });
    }

    // 回归基线断言
    if (options.baseline) {
      deterministicAssertions.push({
        field: 'regression.isRegression',
        operator: 'EQUALS',
        expectedValue: false,
        description: '基线比对无非预期回归',
        critical: true,
        evidenceKey: isRealSpec ? 'SERVER_API:REGRESSION_BASELINE' : 'FIXTURE:REGRESSION_BASELINE',
        actualField: 'isRegression',
      });
    }

    // 契约一致性断言 (总是加入)
    deterministicAssertions.push({
      field: 'contract.conflictsCount',
      operator: 'EQUALS',
      expectedValue: 0,
      description: '配置无冲突',
      critical: true,
      evidenceKey: isRealSpec ? 'SERVER_API:CONTRACT_CONSISTENCY' : 'FIXTURE:CONTRACT_CONSISTENCY',
      actualField: 'conflictsCount',
    });

    // 证据冲突断言 (总是加入)
    deterministicAssertions.push({
      field: 'evidence.hasConflict',
      operator: 'EQUALS',
      expectedValue: false,
      description: '无多方证据冲突',
      critical: true,
      evidenceKey: isRealSpec ? 'SERVER_API:EVIDENCE_CONFLICT' : 'FIXTURE:EVIDENCE_CONFLICT',
      actualField: 'hasConflict',
    });

    // 真实数据变更场景强制执行数据库物理落库与账务对账断言
    if (isRealSpec && (dbCollectionToUse !== undefined || options.dbVerify === true || !process.env.VITEST)) {
      deterministicAssertions.push({
        field: 'db.taskFound',
        operator: 'EQUALS',
        expectedValue: true,
        description: '前台任务表 pq_aivideo_new 物理记录存在',
        critical: true,
        evidenceKey: 'SERVER_API:DB_TASK_RECORD',
        actualField: 'taskFound',
      });
      deterministicAssertions.push({
        field: 'db.backendTaskFound',
        operator: 'EQUALS',
        expectedValue: true,
        description: '后台调度表 pq_volcengine_ai_task 关联记录存在',
        critical: true,
        evidenceKey: 'SERVER_API:DB_TASK_RECORD',
        actualField: 'backendTaskFound',
      });
      if (terminalStatus === 'SUCCESS') {
        deterministicAssertions.push({
          field: 'db.frontendStatus',
          operator: 'EQUALS',
          expectedValue: 2,
          description: '前台任务表 task_status 为 2 (SUCCESS)',
          critical: true,
          evidenceKey: 'SERVER_API:DB_TASK_RECORD',
          actualField: 'frontendStatus',
        });
        if (
          typeof expectedPoints === 'number' &&
          expectedPoints > 0 &&
          contract.pricing.allowPass &&
          contract.pricing.isPricingDetermined
        ) {
          deterministicAssertions.push({
            field: 'db.billingNetPoints',
            operator: 'EQUALS',
            expectedValue: expectedPoints,
            description: '成功任务数据库积分净扣等于刊例定价',
            critical: true,
            evidenceKey: 'BILLING_LEDGER:DB_SCORE_LOGS',
            actualField: 'netPoints',
          });
        }
      } else if (terminalStatus === 'FAILED') {
        deterministicAssertions.push({
          field: 'db.billingNetPoints',
          operator: 'EQUALS',
          expectedValue: 0,
          description: '失败任务数据库积分净扣必须归零 (预扣与退款一致)',
          critical: true,
          evidenceKey: 'BILLING_LEDGER:DB_SCORE_LOGS',
          actualField: 'netPoints',
        });
      }
    }

    const resolvedReq = resolveRequirementTraceForSpec({
      requirementId: options.requirementId,
      requirementText: options.requirementText,
      requirement: options.requirement,
      changedPaths: options.changedPaths,
      traces: options.traces,
      testId,
    });

    // 防御纵深: canonicalSpec.target/inputs.taskId 契约要求非负整数。上游边界 (media-flow 提交解析)
    // 已归一, 此处再兜底一层——数值型 id (含 SUT 返回的数字字符串) 归一为整数; 真正非法的值保持原样,
    // 交由 canonical 校验器如实拦截, 绝不静默放行伪 taskId。
    const parsedSpecTaskId = Number(taskId);
    const canonicalTaskId =
      Number.isFinite(parsedSpecTaskId) && parsedSpecTaskId >= 0 ? Math.trunc(parsedSpecTaskId) : taskId;

    canonicalSpec = {
      testId,
      requirementId: resolvedReq.requirementId,
      scenario: contract.scenario || 'VERIFY_ACCEPTANCE',
      environment,
      executionMode: canonicalExecutionMode,
      target: {
        targetType: 'model',
        modelId,
        expectedChannelId: targetChannelId,
        taskId: canonicalTaskId,
      },
      inputs: {
        taskId: canonicalTaskId,
        expectedPoints,
        targetChannelId,
        pricingDetermined: contract.pricing.isPricingDetermined,
        pricingAllowPass: contract.pricing.allowPass,
      },
      deterministicAssertions,
      costLimit: {
        maxCostPoints: 0,
        allowZeroCostOnly: true,
      },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: reqEvidence,
      metadata: {
        allowPassPricing: contract.pricing.allowPass,
        requirementTrace: resolvedReq.trace || {
          requirementId: resolvedReq.requirementId,
          requirementText: resolvedReq.requirementText,
          impactAnalysis: resolvedReq.impactAnalysis,
        },
        impactAnalysis: resolvedReq.impactAnalysis,
      },
    };
  }

  // 生产环境唯一业务裁决求值
  const canonicalResult = evaluateCanonicalVerdict(canonicalSpec, envelopes);

  // 导出单向写入 (ResultSink: 只写不读，绝不篡改 canonicalResult 与 presentation)
  let exportDelivery:
    | {
        success: boolean;
        sinkName: string;
        recordId: string;
        error?: string;
      }
    | undefined;
  if (options.resultSink) {
    try {
      const record = mapVerdictToExportRecord(canonicalResult, {
        spec: canonicalSpec,
        exportedAt: capturedAt,
      });
      await options.resultSink.sink(record);
      exportDelivery = {
        success: true,
        sinkName: options.resultSink.sinkName,
        recordId: record.recordId,
      };
    } catch (sinkErr) {
      exportDelivery = {
        success: false,
        sinkName: options.resultSink.sinkName,
        recordId: `rec-${testId}`,
        error: sinkErr instanceof Error ? sinkErr.message : String(sinkErr),
      };
    }
  }

  const isProcessing =
    Boolean(options.isProcessing) || options.terminalStatus === 'PROCESSING' || taskEvidence.status === 'PROCESSING';

  // 单向兼容投影为下游消费展示结构：仅传入生命周期展示上下文，严禁传入业务验收事实
  const displayContext: LegacyLifecycleContext = {
    terminalStatus,
    isProcessing,
    progress: options.progress,
  };

  const presentation = projectCanonicalVerdictToLegacy(canonicalResult, displayContext);
  const acceptance: AcceptanceResult = presentation.acceptance;
  const verdict = presentation.verdict;

  const verifiedList: string[] = availableEvidence.slice();
  const unverifiedList: string[] = missingEvidence.filter((e) => !e.startsWith('MANUAL_'));
  const manualList: string[] = missingEvidence.filter((e) => e.startsWith('MANUAL_'));

  const unexpectedChanges = regressionDiff?.unexpectedChanges || [];

  let regressionSummary: ProductionAcceptanceReport['regressionSummary'] | undefined;
  if (regressionDiff) {
    regressionSummary = {
      isRegression: regressionDiff.isRegression,
      regressionStatus: regressionDiff.regressionStatus || (regressionDiff.isRegression ? 'REGRESSION' : 'UNKNOWN'),
      fields: Array.from(
        new Set([
          ...regressionDiff.unexpectedChanges.map((u) => u.field),
          ...regressionDiff.observedChanges.map((o) => o.field),
        ]),
      ),
      details: regressionDiff.unexpectedChanges.map((u) => u.reason),
    };
  }

  const reportReasons: string[] = Array.from(new Set([...reasons, ...presentation.reasons]));
  if (acceptance === 'UNVERIFIED' || acceptance === 'BLOCKED') {
    if (!isDbExtraVerified) {
      reportReasons.push(
        '[证据不足] 无法确认 extra 字段落库，需只读查询 /aivideo/v2/video/getEditData 或只读 DB 验证 extra.diversion=10 [MANUAL_DB_EVIDENCE_REQUIRED]',
      );
    }
    if (isGatewayChannelRequired && !isGatewayChannelVerified) {
      reportReasons.push('[证据不足] 缺少 NewAPI 视频模型网关渠道与上游通道确认 [MANUAL_GATEWAY_CHANNEL_REQUIRED]');
    }
    if (regressionDiff?.regressionStatus === 'UNKNOWN') {
      reportReasons.push('[回归分析未定] 因基线验证证据不完整，分流回归状态为 UNKNOWN，无法确认 CLEAN');
    }
  }

  const acceptanceReport: ProductionAcceptanceReport = {
    scenario: contract.scenario,
    acceptance,
    verified: verifiedList,
    unverified: unverifiedList,
    manualEvidenceRequired: manualList,
    unexpectedChanges,
    regressionSummary,
    reasons: reportReasons,
    summaryText: `[${acceptance}] 场景: ${contract.scenario} | 终态: ${terminalStatus} | 证据完整度: ${availableEvidence.length}/${requiredEvidence.length}${isComplete ? ' (COMPLETE)' : ' (INCOMPLETE)'}`,
  };

  const expectedVsActual: ExpectedVsActual = {
    taskId,
    modelId,
    mediaType,
    matched: presentation.passed,
    allMatched: presentation.passed,
    diffs: diffItems,
    items: diffItems,
    missingEvidence: isDbExtraVerified
      ? regressionDiff?.missingEvidence || []
      : ['MANUAL_DB_EVIDENCE_REQUIRED:extra.diversion', ...(regressionDiff?.missingEvidence || [])],
    evidenceStatus: {
      extraSnapshot: isDbExtraVerified ? 'VERIFIED' : 'MANUAL_DB_EVIDENCE_REQUIRED',
      taskStatus: taskEvidence.status === 'PASS' ? 'VERIFIED' : 'UNVERIFIED',
      mediaArtifact: mediaEvidence.status === 'PASS' ? 'VERIFIED' : 'UNVERIFIED',
      billingLedger: billingEvidence.status === 'PASS' ? 'VERIFIED' : 'UNVERIFIED',
    },
    manualVerificationGuide: {
      extraQuerySql: `SELECT id, extra, task_status FROM ${mediaType === 'image' ? 'pq_aivideo_goods' : 'pq_aivideo_new'} WHERE id = ${Number(taskId) || 0} LIMIT 1;`,
      notice: isDbExtraVerified
        ? '已通过只读 HTTP API (/aivideo/v2/video/getEditData) 成功获取 extra 分流落库证据，无需手动查询数据库。'
        : `主站 HTTP 查询接口（/apiGetStatus 或常规任务详情接口）不返回 extra 字段。如需核实真实分流落库 (${mediaType === 'image' ? 'extra.newapi_image=1' : 'extra.diversion=10'})，可优先通过只读 HTTP API (/aivideo/v2/video/getEditData) 或以只读权限查询 DB ${mediaType === 'image' ? 'pq_aivideo_goods（图片按模式亦可能在 character/scene/fusion）' : 'pq_aivideo_new'} 表。`,
    },
    regressionDiff,
    evidenceCompleteness,
  };

  const memoryCandidate =
    presentation.status === 'FAILED' ||
    presentation.verdict === 'FAIL' ||
    businessValidation.matchedFailurePatterns.length > 0
      ? formatMemoryCandidate({
          taskId,
          modelId,
          mediaType,
          matchedFailurePatterns: businessValidation.matchedFailurePatterns,
          reasons: reportReasons,
          terminalStatus,
        })
      : undefined;

  return {
    ok: !ctx.sessionLoadError,
    passed: presentation.passed,
    taskId,
    modelId,
    mediaType,
    status: ctx.sessionLoadError ? 'ERROR' : presentation.status,
    verdict,
    acceptance,
    mode: session ? 'real' : 'mock',
    executionMode,
    progress: options.progress ?? taskEvidence.progress,
    probeDurationMs: taskResult.probeDurationMs,
    artifact,
    billing,
    billingAudit: billing && scoreLogsToReconcile && scoreLogsToReconcile.length > 0 ? 'AUDITED' : 'SKIPPED_NO_LOGS',
    invariants,
    evidence: {
      task: taskEvidence,
      media: mediaEvidence,
      billing: billingEvidence,
      invariants: billingResult.invariantsEvidence,
      business: businessValidation,
    },
    evidenceCompleteness,
    reasons: reportReasons,
    expectedVsActual,
    acceptanceReport,
    contract,
    businessValidation,
    memoryCandidate,
    hasEvidenceConflict,
    conflictReasons,
    isActualChannelAssertedOnly,
    channelDetail: businessValidation.channelDetail,
    provenance: {
      actualChannelId: channelProvenance,
      fallbackChannel: fallbackProvenance,
      retryProvider: retryProvenance,
      extra: extraProvenance,
      gatewayChannel: gatewayChannelProvenance,
    },
    channelBoundaryClarification: {
      mainSiteDiversionTag: {
        status: isDbExtraVerified ? 'CONFIRMED' : 'UNVERIFIED',
        value: extraObj?.diversion,
        provenance: extraProvenance,
        boundaryNotice: '主站数据库中的 diversion 字段仅能证明主站分流标记落库，不能证明网关实际履约渠道',
      },
      gatewayUpstreamChannel: {
        verified: isGatewayChannelVerified,
        actualChannelId: isGatewayChannelVerified ? actualChannelId : undefined,
        provenance: gatewayChannelProvenance,
        boundaryNotice: isRealMode
          ? '真实模式下不得把外部断言（如 --gateway-channel-confirmed）提升为事实；必须通过网关可信快照'
          : '仿真模式下允许通过外部声明确认渠道',
      },
    },
    canonicalVerdict: canonicalResult,
    canonicalEnvelopes: envelopes,
    canonicalSpec,
    exportDelivery,
    dbEvidence: dbCollectionToUse,
    dbForensicsCategory: classifyDbForensics(dbCollectionToUse).category,
  };
}
