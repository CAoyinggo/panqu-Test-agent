import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EnvironmentProbe, discoverModelContract, parseChangeIntent, STATIC_MODELS, type EnvProbeReport } from './env-probe.js';
import {
  RoutingOracle,
  DEFAULT_KNOWN_GATEWAY_CHANNELS,
  validateTrustedGatewaySnapshot,
  type MainSiteConfigSnapshot,
  type GatewayRoutingVerdict,
  type GatewayChannelConfig,
  type MainSiteRoutingVerdict,
  type TrustedGatewaySnapshot,
  type GatewaySnapshotValidationResult,
} from './routing.js';
import { BillingOracle, type ScoreLogEntry, type BillingAuditReport } from './billing.js';
import { inspectMp4Buffer, inspectImageBuffer, type MediaInspectionResult } from './media-inspector.js';
import { pollTaskStatus, loadPanquSession, queryTaskBillingLogs, queryTaskRuntimeDetails, type PanquSession, type TaskStatusSnapshot, type TaskRuntimeDetails } from './media-flow.js';
import type {
  ChangeScenario,
  DiscoveredModelContract,
  TestCasePlan,
  TestPlan,
  TestPlanBlockedItem,
  ChangeContract,
  ExpectedVsActual,
  DiffItem,
  DiffStatus,
  DiversionBaseline,
  DiversionRegressionDiff,
  AcceptanceResult,
  EvidenceCompleteness,
  ProductionAcceptanceReport,
  MemoryCandidatePayload,
  TargetKind,
  TargetDisambiguationInput,
  TargetDisambiguationResult,
} from './types.js';
import {
  resolveDomainContext,
  generateDomainExecutionPlan,
  evaluateBusinessVerification,
  formatMemoryCandidate,
  type DomainProbeAnalysis,
  type DomainExecutionPlan,
  type BusinessVerificationResult,
  type Experience,
} from './domain-knowledge.js';
import {
  type CanonicalTestSpec,
  type CanonicalEvidenceEnvelope,
  type ExecutionMode,
  type DeterministicAssertion,
  type SideEffectPolicy,
  type TestCostLimit,
  validateCanonicalTestSpec,
  validateEvidenceEnvelope,
} from './canonical-protocol.js';
import {
  evaluateCanonicalVerdict,
  type CanonicalVerdictResult,
} from './canonical-verdict-engine.js';
import {
  mapPlanToCanonicalTestSpec,
  mapProbeToCanonicalTestSpec,
  mapExecuteToCanonicalTestSpec,
  buildCanonicalEvidenceFromVerifyFacts,
  projectCanonicalVerdictToLegacy,
  type CanonicalVerifyFacts,
  type LegacyLifecycleContext,
} from './legacy-protocol-mappers.js';
import {
  validateExecutionResult,
  PanquMediaExecutionAdapter,
  type ExecutionAdapter,
  type ExecutionResult,
  type EvidenceProducer,
  type EvidenceProducerContext,
} from './execution-ports.js';
import {
  mapVerdictToExportRecord,
  type ResultSink,
} from './result-sink.js';
import {
  resolveRequirementTraceForSpec,
  type RequirementTrace,
} from './requirement-trace.js';

export interface ProbeKernelOptions {
  env?: string; baseUrl?: string; gatewayUrl?: string; sessionFile?: string; mock?: boolean; timeoutMs?: number;
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
  ok: boolean; status: 'HEALTHY' | 'DEGRADED' | 'BLOCKED'; env: string; baseUrl: string; gatewayUrl: string;
  probedAt: string; auth: { status: 'VALID' | 'EXPIRED' | 'MISSING'; details: string; hasSession: boolean };
  endpoints: Array<{ name: string; url: string; reachable: boolean; statusCode?: number; latencyMs?: number; message: string }>;
  candidateChannelCount: number; recommendations: string[];
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
      env: env as 'test' | 'preonline', baseUrl: options.baseUrl, gatewayUrl: options.gatewayUrl,
      sessionFile: options.sessionFile, mock: options.mock ?? false, timeoutMs: options.timeoutMs ?? 5000,
    });
    const canonicalSpec = mapProbeToCanonicalTestSpec(options as Record<string, unknown>, r as unknown as Record<string, unknown>, {
      testId: options.testId,
      requirement: options.requirement,
      changedPaths: options.changedPaths,
      traces: options.traces,
    });
    return {
      ok: r.ok, status: r.status, env: r.env, baseUrl: r.baseUrl, gatewayUrl: r.gatewayUrl,
      probedAt: r.probedAt, auth: r.auth, endpoints: r.endpoints,
      candidateChannelCount: r.modelReadiness?.candidateChannelCount ?? 2, recommendations: r.recommendations,
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
      ok: false, status: 'BLOCKED', env, baseUrl: options.baseUrl || 'https://unknown',
      gatewayUrl: options.gatewayUrl || 'https://unknown', probedAt: new Date().toISOString(),
      auth: { status: 'MISSING', details: msg, hasSession: false }, endpoints: [], candidateChannelCount: 0,
      recommendations: [`探活异常: ${msg}`],
      domainAnalysis,
      canonicalSpec,
    };
  }
}


export interface PlanKernelOptions {
  modelId?: number;
  mediaType?: 'video' | 'image';
  flowType?: string;
  requirement?: string;
  resolution?: string;
  duration?: number;
  aspectRatio?: string;
  userGroupIds?: number[];
  mainConfig?: Partial<MainSiteConfigSnapshot>;
  channels?: GatewayChannelConfig[];
  scenario?: ChangeScenario;
  changeType?: 'new_model' | 'diversion_change';
  pointsPerSecond?: number;
  customPoints?: number;
  price?: number;
  alias?: string;
  isGlobal?: boolean;
  mode?: 'real' | 'mock';
  sessionFile?: string;
  extraExperiences?: Experience[];
  projectRoot?: string;
  channelId?: number;
  channelName?: string;
  targetKind?: TargetKind;
  projectId?: number;
  rawTarget?: string | number;
  testId?: string;
  changedPaths?: readonly string[];
  traces?: readonly RequirementTrace[];
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


export function generateDynamicTestPlan(
  contract: DiscoveredModelContract,
  options: PlanKernelOptions,
  mainVerdict: MainSiteRoutingVerdict,
  gwVerdict: GatewayRoutingVerdict,
  expectedPoints: number,
): TestPlan {
  const scenario = contract.scenario;
  const changeType: 'new_model' | 'diversion_change' = scenario.includes('DIVERSION')
    ? 'diversion_change'
    : 'new_model';

  let scenarioName = '';
  switch (scenario) {
    case 'IMAGE_NEW_MODEL':
      scenarioName = `新图片模型直接接入测试 (#${contract.modelId})`;
      break;
    case 'VIDEO_NEW_MODEL':
      scenarioName = `新视频模型直接接入测试 (#${contract.modelId})`;
      break;
    case 'IMAGE_DIVERSION_CHANGE':
      scenarioName = `已有图片模型新增 NewAPI 分流测试 (#${contract.modelId})`;
      break;
    case 'VIDEO_DIVERSION_CHANGE':
      scenarioName = `已有视频模型新增 NewAPI 分流测试 (#${contract.modelId})`;
      break;
  }

  const tests: TestCasePlan[] = [];
  const expectedEvidence: string[] = [];
  const blocked: TestPlanBlockedItem[] = [];
  const skippedTests: Array<{ id: string; name: string; whySkipped: string; rule: string }> = [];

  if (!contract.pricing.isPricingDetermined) {
    blocked.push({
      field: 'pricing',
      reason: `未发现模型 #${contract.modelId} 真实刊例单价，无法执行防资损流水对账`,
      requiredAction: '必须通过 --points-per-second 或 --price 显式提供真实单价，否则账务验证将被阻断',
    });
  }

  for (const item of contract.manualRequiredItems) {
    if (!blocked.some((b) => b.field === item.field)) {
      blocked.push({
        field: item.field,
        reason: item.reason,
        requiredAction: item.requiredAction,
      });
    }
  }

  const res = options.resolution || contract.supportedResolutions.value[0] || (contract.mediaType === 'video' ? '720p' : '1k');
  const dur = options.duration || contract.supportedDurations?.value?.[0] || (contract.mediaType === 'video' ? 4 : undefined);

  if (scenario === 'IMAGE_NEW_MODEL') {
    tests.push(
      {
        id: 'routing-direct',
        layer: 'routing',
        purpose: '新图片模型直接接入，免路由组鉴权走直连',
        input: { selmodelsId: contract.modelId, serviceline: 'r', flowType: 'direct' },
        expected: { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0 },
        requiredEvidence: ['routing_decision'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: '新图片模型直接接入，验证免路由组鉴权走直连链路',
          riskAddressed: '防止新上线模型被错误拦截或分流至未配置网关',
        },
      },
    );

    const maxRef = contract.capabilities.maxRefImages?.value ?? contract.maxRefImages?.value ?? 0;
    if (maxRef > 0) {
      tests.push({
        id: 'boundary-refimg',
        layer: 'boundary',
        purpose: `参考图数量超限 (>${maxRef}张) 边界拦截防护`,
        input: { refCount: maxRef + 1 },
        expected: { allowed: false, reason: `超过上限 ${maxRef} 张` },
        requiredEvidence: ['boundary_intercept'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: `该模型支持最多 ${maxRef} 张参考图，核验超限拦截边界`,
          riskAddressed: '防止超限参考图导致后端显存溢出或渲染崩溃',
        },
      });
    } else {
      skippedTests.push({
        id: 'boundary-refimg',
        name: '参考图超限拦截',
        whySkipped: '该图片模型不支持参考图 (maxRefImages=0)，无需生成参考图边界拦截测试',
        rule: '非参考图模型跳过参考图边界',
      });
    }

    tests.push(
      {
        id: 'real-task-submit',
        layer: 'execution',
        purpose: '提交生图任务并获取 taskId',
        input: { modelId: contract.modelId, resolution: res, serviceline: 'r' },
        expected: { taskStatus: 'SUCCESS', hasTaskId: true },
        requiredEvidence: ['taskId', 'taskStatus', 'imageUrl'],
        executionMode: 'real_task',
        status: 'READY',
        rationale: {
          whyIncluded: '向生图接口发起任务并获取 taskId 存活状态',
          riskAddressed: '验证接口鉴权、参数解析与真实任务创建落库能力',
        },
      },
      {
        id: 'artifact-png',
        layer: 'artifact',
        purpose: 'PNG/JPEG 产物二进制 IHDR 物理尺寸核验',
        input: { resolution: res },
        expected: { formatValid: true, dimensionsMatch: true },
        requiredEvidence: ['png_ihdr', 'file_size'],
        executionMode: 'real_task',
        status: 'READY',
        rationale: {
          whyIncluded: '提取二进制流解析 PNG IHDR 头，核验物理尺寸与格式合规性',
          riskAddressed: '防止返回空图、假图或规格不符的损坏文件',
        },
      },
      {
        id: 'billing-invariants',
        layer: 'billing',
        purpose: '防重复扣费与退款幂等对账核验',
        input: { modelId: contract.modelId, expectedPoints },
        expected: { antiDoubleBilling: true, netChargeZero: true, refundIdempotency: true },
        requiredEvidence: ['scoreLogs', 'auditReport'],
        executionMode: 'real_task',
        status: contract.pricing.isPricingDetermined ? 'READY' : 'BLOCKED',
        skipReason: contract.pricing.isPricingDetermined ? undefined : '真实刊例单价缺失，账务对账已阻断 (BLOCKED / MANUAL_REQUIRED)',
        rationale: {
          whyIncluded: '核验证明图片模型刊例扣费与防重复扣费三大不变量',
          riskAddressed: '防范计费异常、重复扣款或失败漏退',
        },
      },
    );
    expectedEvidence.push('taskId', 'taskStatus', 'imageUrl', 'png_ihdr', 'scoreLogs', 'auditReport');

    skippedTests.push(
      {
        id: 'gateway-candidate',
        name: 'NewAPI网关加权调度',
        whySkipped: '本次为 Direct 直连接入，不涉及 NewAPI 网关渠道加权与配额检查',
        rule: 'DIRECT 接入免网关调度',
      },
      {
        id: 'route-group-isolation',
        name: '组织路由组隔离',
        whySkipped: 'Direct 直连接入，免组织与路由组绑定鉴权',
        rule: 'DIRECT 接入免组织隔离',
      },
      {
        id: 'fallback-policy',
        name: '重试兜底降级',
        whySkipped: 'Direct 直连接入，无 NewAPI 失败降级策略',
        rule: 'DIRECT 接入无重试降级',
      },
      {
        id: 'gateway-eligibility-guard',
        name: '通用网关准入门禁',
        whySkipped: '图片模型直接接入，不涉及视频专用长提示词与 MOV 格式门禁',
        rule: '生图模型跳过视频网关准入门禁',
      },
    );
  } else if (scenario === 'VIDEO_NEW_MODEL') {
    tests.push(
      {
        id: 'routing-direct',
        layer: 'routing',
        purpose: '新视频模型直接接入，验证主站直连线路 0 判定',
        input: { modelId: contract.modelId, flowType: 'direct' },
        expected: { willDivert: false, decision: 'FALLBACK_DIRECT', line: 0 },
        requiredEvidence: ['routing_decision'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: '新视频模型直接接入，验证主站直连线路 0 判定',
          riskAddressed: '防止新视频模型被错误分流至未配置网关',
        },
      },
      {
        id: 'gateway-eligibility-guard',
        layer: 'boundary',
        purpose: '网关前置门禁准入校验：超长提示词 (>5000字) 拦截',
        input: { cuewordLength: 5001 },
        expected: { allowed: false, decision: 'BLOCKED_ILLEGAL' },
        requiredEvidence: ['boundary_intercept'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: '验证网关前置门禁对超长提示词的前置拦截',
          riskAddressed: '防止非法或超限提示词打垮下游模型推理',
        },
      },
      {
        id: 'real-task-submit',
        layer: 'execution',
        purpose: '调用 /aivideo/v2/generate/video 提交视频生成任务',
        input: { modelId: contract.modelId, resolution: res, duration: dur },
        expected: { taskStatus: 'SUCCESS', hasTaskId: true },
        requiredEvidence: ['taskId', 'taskStatus', 'videoUrl'],
        executionMode: 'real_task',
        status: 'READY',
        rationale: {
          whyIncluded: '调用主站视频接口发起生成并获取 taskId 存活状态',
          riskAddressed: '验证主站视频任务创建与参数校验',
        },
      },
      {
        id: 'artifact-mp4',
        layer: 'artifact',
        purpose: '抓取前 64KB 二进制流，解析 MP4 Box 树核验分辨率与时长规格及物理验真',
        input: { resolution: res, duration: dur },
        expected: { boxValid: true, dimensionsMatch: true, durationMatches: true },
        requiredEvidence: ['mp4_box_tree', 'mdat_present'],
        executionMode: 'real_task',
        status: 'READY',
        rationale: {
          whyIncluded: '抓取前 64KB 二进制流，解析 MP4 Box 树（ftyp/moov/mdat）并核验规格',
          riskAddressed: '物理验真防止黑屏、空文件或规格不符的损坏产物',
        },
      },
      {
        id: 'billing-invariants',
        layer: 'billing',
        purpose: '防重复扣款与失败净扣归零三大不变量核验',
        input: { modelId: contract.modelId, expectedPoints },
        expected: { antiDoubleBilling: true, netChargeZero: true, refundIdempotency: true },
        requiredEvidence: ['scoreLogs', 'auditReport'],
        executionMode: 'real_task',
        status: contract.pricing.isPricingDetermined ? 'READY' : 'BLOCKED',
        skipReason: contract.pricing.isPricingDetermined ? undefined : '真实刊例单价缺失，账务对账已阻断 (BLOCKED / MANUAL_REQUIRED)',
        rationale: {
          whyIncluded: '防重复扣款与失败净扣归零三大不变量核验',
          riskAddressed: '防范视频生成高额资损与重扣',
        },
      },
    );
    expectedEvidence.push('taskId', 'taskStatus', 'videoUrl', 'mp4_box_tree', 'scoreLogs', 'auditReport');

    skippedTests.push(
      {
        id: 'gateway-candidate',
        name: 'NewAPI网关加权调度',
        whySkipped: '本次为 Direct 直连接入，不涉及 NewAPI 网关加权调度与渠道限额',
        rule: 'DIRECT 接入免网关调度',
      },
      {
        id: 'route-group-isolation',
        name: '组织路由组隔离',
        whySkipped: 'Direct 直连接入，免组织与路由组绑定鉴权',
        rule: 'DIRECT 接入免组织隔离',
      },
      {
        id: 'fallback-policy',
        name: '重试兜底降级',
        whySkipped: 'Direct 直连接入，无 NewAPI 失败降级策略',
        rule: 'DIRECT 接入无重试降级',
      },
      {
        id: 'boundary-refimg',
        name: '生图参考图边界',
        whySkipped: '视频生成不涉及生图参考图超限边界测试',
        rule: '视频模型跳过生图参考图边界',
      },
    );
    if (!contract.supportedResolutions.value.includes('1080p')) {
      skippedTests.push({
        id: 'boundary-1080p',
        name: '1080P高分辨率边界',
        whySkipped: '该视频模型规格不支持 1080p，避免生成超出模型能力范围的无效用例',
        rule: '超出能力边界不测',
      });
    }
  } else if (scenario === 'IMAGE_DIVERSION_CHANGE') {
    tests.push(
      {
        id: 'baseline-direct',
        layer: 'routing',
        purpose: 'Baseline 回归：非 serviceline=r 请求仍走原渠道',
        input: { selmodelsId: contract.modelId, serviceline: 't' },
        expected: { willDivert: false, decision: 'FALLBACK_DIRECT' },
        requiredEvidence: ['baseline_routing'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: 'Baseline 回归：非 serviceline=r 请求仍走原渠道直连',
          riskAddressed: '防止非切流业务线被误伤劫持',
        },
      },
      {
        id: 'gateway-eligibility-guard',
        layer: 'boundary',
        purpose: '网关前置门禁准入校验：自定义像素尺寸 (pixels) 不支持 NewAPI 分流，拦截回退直连',
        input: { sizeType: 'pixels' },
        expected: { willDivert: false, decision: 'FALLBACK_DIRECT' },
        requiredEvidence: ['boundary_intercept'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: '验证网关准入门禁对非标尺寸的拦截与直连回退',
          riskAddressed: '防止非标准分辨率分流至不支持的 NewAPI 渠道导致任务异常',
        },
      },
      {
        id: contract.isGlobal.value ? 'routing-global' : 'routing-group',
        layer: 'routing',
        purpose: contract.isGlobal.value
          ? '全量开放生图模型命中全局分流'
          : '非全量生图模型满足组织配置命中 NEWAPI_IMAGE 组织分流，预期快照写入 newapi_image=1',
        input: { selmodelsId: contract.modelId, serviceline: 'r', sizeType: 'resolution' },
        expected: { willDivert: true, decision: 'NEWAPI_IMAGE', line: 10, newapiModel: contract.alias.value },
        requiredEvidence: ['routing_decision', 'expectedSnapshot'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: contract.isGlobal.value ? '验证全量开放生图模型命中全局分流' : '验证非全量生图模型命中组织路由组分流',
          riskAddressed: '防范分流切流规则未生效或配置遗漏',
        },
      },
      {
        id: 'gateway-candidate',
        layer: 'routing',
        purpose: 'NewAPI 网关上游渠道加权调度候选与每日配额校验',
        input: { tokenGroup: mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test', targetModel: contract.alias.value, expectedPoints },
        expected: { isBlockedByQuota: false, candidateCount: gwVerdict.candidateChannelIds.length },
        requiredEvidence: ['gateway_channel'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: '核验 NewAPI 网关是否存在有效上游渠道承接该生图模型请求',
          riskAddressed: '防范 NewAPI 网关无可用上游渠道导致生图任务挂死',
        },
      },
    );
    if (!contract.isGlobal.value) {
      tests.push({
        id: 'route-group-isolation',
        layer: 'routing',
        purpose: '组织路由组未绑定或 Key 缺失时，平滑回退原渠道',
        input: { userGroupIds: [99999] },
        expected: { willDivert: false, decision: 'FALLBACK_DIRECT' },
        requiredEvidence: ['isolation_routing'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: '未绑定组织或密钥缺失时平滑回退原直连渠道',
          riskAddressed: '防止配置缺失导致用户生图报错',
        },
      });
    } else {
      skippedTests.push({
        id: 'route-group-isolation',
        name: '组织路由组隔离',
        whySkipped: '该模型配置为全量开放 (is_newapi_global=1)，所有组织无条件切流，无需测试组织隔离',
        rule: '全量模型免组织隔离',
      });
    }

    tests.push(
      {
        id: 'real-task-diversion',
        layer: 'execution',
        purpose: '真实提交分流生图任务并验证状态',
        input: { modelId: contract.modelId, serviceline: 'r', resolution: res },
        expected: { taskStatus: 'SUCCESS', hasTaskId: true },
        requiredEvidence: ['taskId', 'taskStatus', 'imageUrl', 'MANUAL_DB_EVIDENCE_REQUIRED:extra.newapi_image=1'],
        executionMode: 'real_task',
        status: 'READY',
        rationale: {
          whyIncluded: '真实提交分流生图任务并验证落库状态',
          riskAddressed: '验证分流后任务真实创建与 taskId 生成',
        },
      },
      {
        id: 'artifact-png',
        layer: 'artifact',
        purpose: 'PNG/JPEG 产物物理尺寸核验，证明分流后图片规格未被破坏',
        input: { resolution: res },
        expected: { formatValid: true, dimensionsMatch: true },
        requiredEvidence: ['png_ihdr'],
        executionMode: 'real_task',
        status: 'READY',
        rationale: {
          whyIncluded: 'PNG/JPEG 产物物理尺寸核验，证明分流后图片规格未被破坏',
          riskAddressed: '防范 NewAPI 供应商篡改图片格式或规格',
        },
      },
      {
        id: 'billing-invariants',
        layer: 'billing',
        purpose: '核验证明新增分流未破坏原有防重复扣费与退款幂等',
        input: { modelId: contract.modelId, expectedPoints },
        expected: { antiDoubleBilling: true, netChargeZero: true, refundIdempotency: true },
        requiredEvidence: ['scoreLogs', 'auditReport'],
        executionMode: 'real_task',
        status: contract.pricing.isPricingDetermined ? 'READY' : 'BLOCKED',
        skipReason: contract.pricing.isPricingDetermined ? undefined : '真实刊例单价缺失，账务对账已阻断 (BLOCKED / MANUAL_REQUIRED)',
        rationale: {
          whyIncluded: '核验证明新增分流未破坏原有防重复扣费与退款幂等',
          riskAddressed: '防范切流后计费规则篡改或重扣',
        },
      },
    );
    expectedEvidence.push('taskId', 'taskStatus', 'imageUrl', 'png_ihdr', 'scoreLogs', 'MANUAL_DB_EVIDENCE_REQUIRED:extra.newapi_image=1');

    skippedTests.push(
      {
        id: 'fallback-policy',
        name: '重试兜底降级',
        whySkipped: '图片分流不走 SD 视频重试队列',
        rule: '生图分流无重试队列',
      },
      {
        id: 'gateway-eligibility-guard',
        name: '通用网关准入门禁',
        whySkipped: '图片生图分流不涉及视频专用长提示词门禁',
        rule: '生图分流跳过视频网关准入门禁',
      },
    );
  } else {
    tests.push(
      {
        id: 'gateway-eligibility-guard',
        layer: 'boundary',
        purpose: '网关前置门禁准入校验：MOV 输出格式不支持 NewAPI 分流，拦截回退直连',
        input: { outputFormat: 'mov' },
        expected: { willDivert: false, decision: 'FALLBACK_DIRECT' },
        requiredEvidence: ['boundary_intercept'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: '验证网关准入门禁对 MOV 等非标格式的拦截与直连回退',
          riskAddressed: '防止下游供应商不支持 MOV 格式导致分流任务失败',
        },
      },
    );

    if (contract.supportedResolutions.value.includes('1080p')) {
      tests.push({
        id: 'boundary-1080p',
        layer: 'boundary',
        purpose: '验证 1080p 高清规格分流规则契约',
        input: { modelId: contract.modelId, resolution: '1080p' },
        expected: { willDivert: true },
        requiredEvidence: ['routing_decision'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: '验证 1080p 高清规格分流规则契约',
          riskAddressed: '验证高清规格是否被正确切流至支持 1080p 的渠道',
        },
      });
    }

    if (contract.isGlobal.value) {
      tests.push({
        id: 'routing-global',
        layer: 'routing',
        purpose: '全量开放模型 (is_newapi_global=1) 绕过组织，直接使用全局Key直达 NewAPI (orgId=0, line=10)',
        input: { modelId: contract.modelId },
        expected: { willDivert: true, decision: 'NEWAPI_GLOBAL', line: 10, orgId: 0, newapiModel: contract.alias.value },
        requiredEvidence: ['routing_decision', 'expectedSnapshot'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: '全量开放模型命中全局分流 (LINE=10)',
          riskAddressed: '验证全量模型无条件切流规则生效',
        },
      });
      skippedTests.push({
        id: 'route-group-isolation',
        name: '组织路由组隔离',
        whySkipped: '该模型配置为全量开放 (is_newapi_global=1)，所有组织无条件切流，无需测试组织隔离',
        rule: '全量模型免组织隔离',
      });
    } else {
      tests.push({
        id: 'routing-group',
        layer: 'routing',
        purpose: '非全量模型满足组织配置与能力并集命中 NEWAPI_ORG_GROUP 分流',
        input: { modelId: contract.modelId, userGroupIds: options.userGroupIds || [10] },
        expected: { willDivert: true, decision: 'NEWAPI_ORG_GROUP', line: 10 },
        requiredEvidence: ['routing_decision', 'expectedSnapshot'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: '非全量模型满足组织配置与能力并集命中 NEWAPI_ORG_GROUP 分流',
          riskAddressed: '验证组织绑定与能力并集分流规则',
        },
      });
    }

    tests.push({
      id: 'gateway-candidate',
      layer: 'routing',
      purpose: 'NewAPI 网关按分组过滤有效渠道并检查每日配额',
      input: { tokenGroup: mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test', targetModel: contract.alias.value, expectedPoints },
      expected: { isBlockedByQuota: false, candidateCount: gwVerdict.candidateChannelIds.length },
      requiredEvidence: ['candidateChannels'],
      executionMode: 'plan_only',
      status: 'READY',
      rationale: {
        whyIncluded: 'NewAPI 网关按分组过滤有效渠道并检查每日配额',
        riskAddressed: '防止配额超限或无可用渠道打垮网关',
      },
    });

    if (contract.fallback?.value.hasPolicy) {
      tests.push({
        id: 'fallback-policy',
        layer: 'fallback',
        purpose: contract.fallback.value.action === 'VOLCENGINE_RETRY_QUEUE'
          ? 'Seedance 模型分流失败自动派发至火山重试队列并标记 is_need_fallback=1'
          : `模型 #${contract.modelId} 属于非 Seedance 系列，分流失败直接报错中断，严禁进入重试列表`,
        input: { modelId: contract.modelId },
        expected: contract.fallback.value.action === 'VOLCENGINE_RETRY_QUEUE'
          ? { fallbackAction: 'VOLCENGINE_RETRY_QUEUE', recordRetryLog: true }
          : { fallbackAction: 'DIRECT_FAIL_NO_RETRY', recordRetryLog: false },
        requiredEvidence: ['fallback_verdict'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: contract.fallback.value.action === 'VOLCENGINE_RETRY_QUEUE'
            ? 'Seedance 模型分流失败自动派发至火山重试队列并标记 is_need_fallback=1'
            : `模型 #${contract.modelId} 属于非 Seedance 系列，分流失败直接报错中断，严禁进入重试列表`,
          riskAddressed: '严格防范非 SD 模型错误进入重试队列造成二次故障',
        },
      });
    }

    tests.push(
      {
        id: 'real-task-diversion',
        layer: 'execution',
        purpose: '真实提交分流视频生成任务并验证状态',
        input: { modelId: contract.modelId, resolution: res, duration: dur },
        expected: { taskStatus: 'SUCCESS', hasTaskId: true },
        requiredEvidence: ['taskId', 'taskStatus', 'videoUrl', 'MANUAL_DB_EVIDENCE_REQUIRED:extra.diversion=10'],
        executionMode: 'real_task',
        status: 'READY',
        rationale: {
          whyIncluded: '真实提交分流视频生成任务并验证状态',
          riskAddressed: '验证端到端提交流程完整性',
        },
      },
      {
        id: 'artifact-mp4',
        layer: 'artifact',
        purpose: 'MP4 Box 物理验真，证明分流后视频容器与编码规格完整可用',
        input: { resolution: res },
        expected: { boxValid: true, dimensionsMatch: true },
        requiredEvidence: ['mp4_box_tree'],
        executionMode: 'real_task',
        status: 'READY',
        rationale: {
          whyIncluded: 'MP4 Box 物理验真，证明分流后视频容器与编码规格完整可用',
          riskAddressed: '防范下游供应商返回空流、截断流或损坏容器',
        },
      },
      {
        id: 'billing-invariants',
        layer: 'billing',
        purpose: '积分对账与三大账务不变量核验，证明分流未破坏原有防重复扣费',
        input: { modelId: contract.modelId, expectedPoints },
        expected: { antiDoubleBilling: true, netChargeZero: true, refundIdempotency: true },
        requiredEvidence: ['scoreLogs', 'auditReport'],
        executionMode: 'real_task',
        status: contract.pricing.isPricingDetermined ? 'READY' : 'BLOCKED',
        skipReason: contract.pricing.isPricingDetermined ? undefined : '真实刊例单价缺失，账务对账已阻断 (BLOCKED / MANUAL_REQUIRED)',
        rationale: {
          whyIncluded: '积分对账与三大账务不变量核验，证明分流未破坏原有防重复扣费',
          riskAddressed: '防范分流导致重复扣费、失败漏退等重大资损',
        },
      },
    );
    expectedEvidence.push('taskId', 'taskStatus', 'videoUrl', 'mp4_box_tree', 'scoreLogs', 'MANUAL_DB_EVIDENCE_REQUIRED:extra.diversion=10');

    skippedTests.push(
      {
        id: 'boundary-refimg',
        name: '生图参考图边界',
        whySkipped: '视频模型不涉及生图参考图超限边界测试',
        rule: '视频模型跳过生图参考图边界',
      },
      {
        id: 'gateway-eligibility-guard',
        name: '通用网关准入门禁',
        whySkipped: '视频接口使用预设分辨率，生图自定义像素门禁不适用于视频模型',
        rule: '视频模型跳过生图网关准入门禁',
      },
    );
  }

  let baseline: DiversionBaseline | undefined;
  let regressionExpectations: Array<{ field: string; expectedChange: boolean; description: string }> | undefined;

  if (scenario === 'IMAGE_DIVERSION_CHANGE' || scenario === 'VIDEO_DIVERSION_CHANGE') {
    baseline = {
      flowType: 'direct',
      routeLine: 0,
      willDivert: false,
      decision: 'FALLBACK_DIRECT',
      expectedPoints,
      alias: contract.alias.value,
      artifactFormat: contract.mediaType === 'video' ? 'mp4' : 'png/jpg',
    };
    regressionExpectations = [
      { field: 'routing', expectedChange: true, description: '分流线路由 Direct(0) 切流至 NewAPI(10)' },
      { field: 'billing', expectedChange: false, description: '基准刊例价不发生非预期回归' },
      { field: 'artifact', expectedChange: false, description: '产物容器及解码物理结构完好' },
      { field: 'alias', expectedChange: false, description: '模型别名映射保持一致' },
    ];
  }

  const automatedSummary = tests.map((t) => `[${t.layer.padEnd(9)}] ${t.id}: ${t.purpose}`);
  const skippedSummary = skippedTests.map((s) => `[${s.id}] ${s.name}: ${s.whySkipped} (${s.rule})`);
  const manualRequiredSummary: string[] = [];
  if (blocked.length > 0) {
    for (const b of blocked) {
      manualRequiredSummary.push(`${b.field}: ${b.reason} -> ${b.requiredAction}`);
    }
  }
  if (changeType === 'diversion_change') {
    manualRequiredSummary.push(
      contract.mediaType === 'video'
        ? '底层落库核验: 执行 SQL `SELECT extra FROM pq_aivideo_new WHERE id = <taskId>;` 确认 extra.diversion=10'
        : '底层落库核验: 执行 SQL `SELECT extra FROM pq_ai_tasks WHERE id = <taskId>;` 确认 extra.newapi_image=1'
    );
  } else {
    if (contract.mediaType === 'video') {
      manualRequiredSummary.push('物理产物核验: 抽检任务产物 MP4 Box 结构（moov/mdat 原子完整性）及 OSS 归档存储下载可用性');
    } else {
      manualRequiredSummary.push('物理产物核验: 抽检生图产物 PNG IHDR 头物理尺寸完整性及 OSS 归档存储');
    }
  }

  let nextStep = '';
  if (blocked.length > 0) {
    nextStep = `先补充缺失事实 (${blocked.map(b => b.missingField || b.field).join(', ')})，然后再执行真实任务`;
  } else {
    const videoParams = contract.mediaType === 'video'
      ? ` --resolution ${res}${dur !== undefined ? ` --duration ${dur}` : ''}`
      : '';
    nextStep = `执行任务: devtest execute --model ${contract.modelId} --media ${contract.mediaType}${videoParams} --mode real${options.sessionFile ? ` --session-file ${options.sessionFile}` : ''}`;
  }

  const testerActionSummary = {
    automatedSummary,
    skippedSummary,
    manualRequiredSummary,
    nextStep,
  };

  const summary = `### 📋 动态生成测试计划 [${scenarioName}]
- **模型**: #${contract.modelId} (${contract.mediaType}) | 别名: ${contract.alias.value} [来源: ${contract.alias.source}]
- **变更类型**: ${changeType === 'new_model' ? '新模型直接接入' : '已有模型新增分流'}
- **全量开放**: ${contract.isGlobal.value ? '是 (NEWAPI_GLOBAL)' : '否 (组织路由组)'} [来源: ${contract.isGlobal.source}]
- **计划测试项**: 共 ${tests.length} 项测试 (就绪 ${tests.filter((t) => t.status === 'READY').length} 项, 阻断 ${blocked.length} 项, 已安全裁剪跳过 ${skippedTests.length} 项)
- **刊例定价**: ${contract.pricing.isPricingDetermined ? `${expectedPoints} pt [来源: ${contract.pricing.source}]` : '未确定 (BLOCKED)'}`;

  return {
    scenario,
    scenarioName,
    modelId: contract.modelId,
    mediaType: contract.mediaType,
    changeType,
    contract,
    tests,
    skippedTests,
    blocked,
    expectedEvidence,
    summary,
    baseline,
    regressionExpectations,
    testerActionSummary,
  };
}

export async function plan(options: PlanKernelOptions): Promise<PlanKernelResult> {
  const intent = options.requirement ? parseChangeIntent(options.requirement) : undefined;
  const disambiguation = RoutingOracle.disambiguateTarget({
    targetKind: options.targetKind,
    channelId: options.channelId,
    channelName: options.channelName,
    modelId: options.modelId ?? intent?.modelId,
    modelAlias: options.alias,
    projectId: options.projectId,
    rawTarget: options.rawTarget,
  }, options.channels);

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
        blocked: [{
          field: 'target_id',
          reason: disambiguation.error || '目标 ID 歧义',
          requiredAction: '请显式区分 --channel 与 --model',
        }],
        expectedEvidence: ['03_gateway_channels.json'],
        summary: disambiguation.error || '消歧拦截',
      },
      blocked: [{
        field: 'target_id',
        reason: disambiguation.error || '目标 ID 歧义',
        requiredAction: '请显式区分 --channel 与 --model',
      }],
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
  const customPoints = options.customPoints ?? (mediaType === 'image' && options.price !== undefined ? options.price : intent?.customPoints);
  const pointsPerSecond = options.pointsPerSecond ?? (mediaType === 'video' && options.price !== undefined ? options.price : intent?.pointsPerSecond);
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

  const flowType: 'direct' | 'diversion' = options.flowType === 'direct'
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
    options.customPoints === undefined
  );

  if (isRhPricingConflict) {
    contract.pricing.isPricingDetermined = false;
    contract.pricing.allowPass = false;
    contract.pricing.source = 'MANUAL_REQUIRED';
  }

  const duration = options.duration ?? contract.supportedDurations?.value?.[0] ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? contract.supportedResolutions.value[0] ?? (mediaType === 'video' ? '720p' : '1k');
  const expectedPoints = isRhPricingConflict ? 0 : BillingOracle.calculateExpectedPoints({
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
    globalModelIds: flowType === 'direct' ? [] : (contract.isGlobal.value ? [modelId, 84, 88] : [84, 88]),
    globalApiKey: 'sk-panqu-devtest-key',
    globalRouteRules: {
      video: {
        84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
        88: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
        ...(mediaType === 'video' ? { [modelId]: { resolutions: contract.supportedResolutions.value, aspect_ratios: contract.supportedAspectRatios.value } } : {}),
      },
    },
    groupRouteRules: {},
    orgBindings: contract.orgBindings?.value
      ? Object.fromEntries(
          Object.entries(contract.orgBindings.value).map(([k, v]) => [
            Number(k),
            { routeGroupId: v.routeGroupId, newapiGroup: v.newapiGroup, status: v.status, apiKey: v.apiKey || 'sk-org-key' },
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

  const mainVerdict = mediaType === 'video'
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
    channels = targetChannelId !== undefined ? options.channels.filter(c => c.id === targetChannelId) : options.channels;
  } else if (targetChannelId !== undefined) {
    const matchedKnown = DEFAULT_KNOWN_GATEWAY_CHANNELS.find(c => c.id === targetChannelId);
    if (matchedKnown) {
      channels = [matchedKnown];
    } else {
      channels = [{
        id: targetChannelId,
        name: targetChannelName || `channel-${targetChannelId}`,
        group: targetGroup,
        models: [targetModel],
        status: 1,
        weight: 10,
        dailyQuotaLimit: 0,
        usedQuota: 0,
        sourceMode: 'SOURCE_STATIC_CONTRACT',
      }];
    }
  } else if (mainVerdict.willDivert) {
    channels = [{ id: 1, name: `${targetModel}主渠道`, group: targetGroup, models: [targetModel], status: 1, weight: 100, dailyQuotaLimit: 0, usedQuota: 0 }];
  } else {
    channels = [];
  }

  const gwVerdict = RoutingOracle.evaluateGatewayRouting(targetGroup, targetModel, expectedPoints, channels);
  const testPlan = generateDynamicTestPlan(contract, options, mainVerdict, gwVerdict, expectedPoints);

  const domainPlan = generateDomainExecutionPlan({
    modelId,
    mediaType,
    flowType,
    resolution: options.resolution || contract.supportedResolutions.value[0] || (contract.mediaType === 'video' ? '720p' : '1k'),
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
      pricing: changeType === 'diversion_change'
        ? `${expectedPoints} pt (baseline)`
        : contract.pricing.isPricingDetermined ? `${expectedPoints} pt` : '未确定 (MANUAL_REQUIRED)',
    },
    afterState: {
      flowType,
      routeLine: mainVerdict.line,
      decision: mainVerdict.decision,
      pricing: contract.pricing.isPricingDetermined ? `${expectedPoints} pt` : '未确定 (MANUAL_REQUIRED)',
    },
    requiredFacts: [
      'modelId', 'mediaType', 'pricing', 'supportedResolutions', 'supportedAspectRatios',
      ...(changeType === 'diversion_change' ? ['isGlobal', 'routeGroup', 'candidateChannels'] : [])
    ],
    discoveredFacts: {
      alias: { value: contract.alias.value, source: contract.alias.source, determined: contract.alias.determined },
      isGlobal: { value: contract.isGlobal.value, source: contract.isGlobal.source, determined: contract.isGlobal.determined },
      supportedResolutions: { value: contract.supportedResolutions.value, source: contract.supportedResolutions.source, determined: contract.supportedResolutions.determined },
      supportedAspectRatios: { value: contract.supportedAspectRatios.value, source: contract.supportedAspectRatios.source, determined: contract.supportedAspectRatios.determined },
      ...(contract.supportedDurations ? { supportedDurations: { value: contract.supportedDurations.value, source: contract.supportedDurations.source, determined: contract.supportedDurations.determined } } : {}),
      routing: { value: contract.routing.value, source: contract.routing.source, determined: contract.routing.determined },
      pricing: { value: contract.pricing.pointsPerSecond?.value ?? contract.pricing.customPoints?.value ?? expectedPoints, source: contract.pricing.source, determined: contract.pricing.isPricingDetermined },
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
      pointsPerSecond: contract.pricing.pointsPerSecond?.value ?? (mediaType === 'video' ? (expectedPoints / (duration || 4)) : undefined),
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
    testObjectives: testPlan.tests.map(t => `${t.id}: ${t.purpose}`),
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
      reason: 'RH 国际版适用单价存在冲突 (静态刊例 28 pt/s vs 历史实际/排期 21 pt/s)，单价尚未确认为线上事实 [UNVERIFIED]',
      requiredAction: '请提供明确经过审计的 RH 渠道计费标准或显式指定 --price',
    });
  }

  const missingInputs: string[] = [];
  if (!contract.pricing.isPricingDetermined || !contract.pricing.allowPass) {
    missingInputs.push('pricing');
  }
  if (options.mode === 'real' && !options.sessionFile && !existsSync('session.json') && !existsSync('.panqu/session.json') && !process.env.PANQU_SESSION_COOKIES_FILE) {
    missingInputs.push('session/auth');
  }
  if ((scenario === 'IMAGE_DIVERSION_CHANGE' || scenario === 'VIDEO_DIVERSION_CHANGE') && contract.alias.source === 'SOURCE_DEFAULT_FALLBACK') {
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
  const specRes = mapPlanToCanonicalTestSpec({
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
    pricingStatus: isRhPricingConflict ? 'UNVERIFIED' : (contract.pricing.isPricingDetermined ? 'DETERMINED' : 'MANUAL_REQUIRED'),
    missingInputs,
    executable,
    blockerCode,
  } as any, {
    testId: planTestId,
    requirement: options.requirement,
    changedPaths: options.changedPaths,
    traces: options.traces,
  });
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
    pricingStatus: isRhPricingConflict ? 'UNVERIFIED' : (contract.pricing.isPricingDetermined ? 'DETERMINED' : 'MANUAL_REQUIRED'),
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
  modelId?: number; mediaType?: 'video' | 'image'; resolution?: string; duration?: number;
  aspectRatio?: string; mode?: 'mock' | 'real'; prompt?: string; sessionFile?: string;
  env?: 'test' | 'preonline'; serviceline?: string;
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
  ok: boolean; taskId: number; simulationId?: string; isSimulated?: boolean; mode: 'mock' | 'real'; modelId: number; mediaType: 'video' | 'image';
  status: 'SUBMITTED' | 'SUCCESS' | 'FAILED' | 'ERROR' | 'BLOCKED'; points: number; message: string;
  credentialsMasked?: string; rawResponse?: Record<string, unknown>;
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
  dependencies: ExecuteCanonicalDependencies
): Promise<ExecuteKernelResult> {
  const modelId = Number(spec.target?.modelId ?? 84);
  const mediaType = (spec.inputs?.mediaType as 'video' | 'image')
    || (spec.scenario?.startsWith('IMAGE') ? 'image' : 'video');
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
  const resolution = (spec.inputs?.resolution as string | undefined);
  const duration = (spec.inputs?.duration as number | undefined);

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
  const isKnownEnv = spec.executionMode === 'REAL'
    ? (spec.environment === 'test' || spec.environment === 'preonline')
    : (spec.environment === 'test' || spec.environment === 'preonline' || spec.environment === 'offline');
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
  const disambiguation = RoutingOracle.disambiguateTarget({
    targetKind,
    channelId,
    channelName,
    modelId,
    modelAlias: alias,
    projectId,
    rawTarget,
    mode,
  }, dependencies.channels);

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
  if (mode === 'real' && (disambiguation.targetKind === 'channel' || channelId !== undefined || channelName !== undefined)) {
    const extraSnapshotNotice = disambiguation.channelSource === 'SOURCE_STATIC_CONTRACT'
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
  const contract = (spec.metadata?.contract as DiscoveredModelContract | undefined) || discoverModelContract(resolvedModelId, mediaType, {
    resolution,
    duration,
    customPoints,
    pointsPerSecond,
    price,
    alias: passedAlias,
  });

  const effectiveDuration = duration ?? contract.supportedDurations?.value?.[0] ?? (mediaType === 'video' ? 4 : undefined);
  const effectiveResolution = resolution ?? contract.supportedResolutions.value[0] ?? (mediaType === 'video' ? '720p' : '1k');

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
      const errorMsg = 'REAL 执行模式下 sideEffectPolicy 为 READ_ONLY，缺少显式 ALLOW_SUBMIT 或 ALLOW_PAID 授权，已在提交前安全阻断 [BLOCKED_UNAUTHORIZED_REAL_SUBMIT]';
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
    const errorMsg = 'BLOCKED_NO_EXECUTION_ADAPTER: core-kernel 必须注入 ExecutionAdapter 才能执行，禁止静默回退内置执行路径';
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
          throw new Error(`BLOCKED_INVALID_ADAPTER_OUTPUT: 证据信封 testId (${env?.testId}) 与执行规格 testId (${effectiveSpec.testId}) 不一致`);
        }
        const v = validateEvidenceEnvelope(env);
        if (!v.valid) {
          throw new Error(`BLOCKED_INVALID_ADAPTER_OUTPUT: 证据信封校验失败: ${v.errors.map((e) => e.message).join('; ')}`);
        }
        if (env.environment !== effectiveSpec.environment) {
          throw new Error(
            `BLOCKED_INVALID_ADAPTER_OUTPUT: 证据信封 [${env.evidenceId}] 的实际环境 ("${env.environment}") 与期望环境 ("${effectiveSpec.environment}") 不一致，拒绝环境篡改证据`
          );
        }
      }
    }
  } catch (err: any) {
    const isVerdictViolation = err?.message?.includes('ADAPTER_ILLEGAL_VERDICT_FIELD') || err?.message?.includes('FORBIDDEN_VERDICT_FIELDS');
    const isAdapterOutputInvalid = err?.message?.includes('BLOCKED_INVALID_ADAPTER_OUTPUT') || err?.message?.includes('validateExecutionResult') || isVerdictViolation;
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
    simulationId: (execRes.metadata?.simulationId as string | undefined) || (execRes.metadata?.isSimulated ? `sim-offline-${effectiveSpec.testId}` : undefined),
  };
}

export async function execute(options: ExecuteKernelOptions): Promise<ExecuteKernelResult> {
  // 1. 若传入 canonicalSpec，禁止同时传入任何业务 legacy 字段；只允许 executionAdapter、sessionFile、env、channels 等运行依赖
  if (options.canonicalSpec) {
    const spec = options.canonicalSpec;
    const allowedRuntimeKeys = new Set([
      'canonicalSpec',
      'executionAdapter',
      'sessionFile',
      'env',
      'channels',
    ]);
    const conflictKeys = Object.keys(options).filter(
      (k) => !allowedRuntimeKeys.has(k) && (options as Record<string, unknown>)[k] !== undefined
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
  const resolvedContract = options.contract || discoverModelContract(resolvedModelId, resolvedMediaType, {
    resolution: options.resolution,
    duration: options.duration,
    customPoints: options.customPoints,
    pointsPerSecond: options.pointsPerSecond,
    price: options.price,
    alias: options.alias,
  });

  const canonicalSpec = mapExecuteToCanonicalTestSpec({
    ...options,
    modelId: resolvedModelId,
    mediaType: resolvedMediaType,
    contract: resolvedContract,
  } as unknown as Record<string, unknown>, {
    testId: options.testId,
    requirement: options.requirement,
    changedPaths: options.changedPaths,
    traces: options.traces,
    sideEffectPolicy: options.sideEffectPolicy,
    costLimit: options.costLimit,
    allowSubmit: options.allowSubmit,
    allowPaid: options.allowPaid,
    maxCostPoints: options.maxCostPoints,
  });

  return executeCanonical(canonicalSpec, {
    executionAdapter: options.executionAdapter,
    channels: options.channels,
    sessionFile: options.sessionFile,
    env: options.env,
  });
}


async function fetchFirst64K(url: string, timeoutMs = 8000): Promise<{ buffer: Buffer; tailBuffer?: Buffer; durationMs: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-65535', 'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0' }, signal: ctrl.signal });
    if (!res.ok && res.status !== 206) return null;
    const arrayBuf = await res.arrayBuffer();
    let buf = Buffer.from(arrayBuf);
    let tail: Buffer | undefined;
    if (res.status === 200) {
      if (buf.length > 65536) {
        const head = buf.subarray(0, 65536);
        tail = buf.subarray(Math.max(0, buf.length - 65536));
        buf = head;
      }
      return { buffer: buf, tailBuffer: tail, durationMs: Date.now() - start };
    }
    const headBuf = buf.subarray(0, 65536);
    const quickInspection = inspectMp4Buffer(headBuf);
    if (quickInspection.decodable) {
      return { buffer: headBuf, durationMs: Date.now() - start };
    }
    const contentRange = res.headers.get('content-range');
    const match = contentRange ? /\/(\d+)$/.exec(contentRange) : null;
    const totalSize = match ? parseInt(match[1], 10) : 0;
    if (totalSize > headBuf.length) {
      const tailSize = Math.min(65536, totalSize);
      const tailStart = Math.max(0, totalSize - tailSize);
      try {
        const tailRes = await fetch(url, {
          headers: { Range: `bytes=${tailStart}-${totalSize - 1}`, 'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0' },
          signal: ctrl.signal,
        });
        if (tailRes.ok || tailRes.status === 206) {
          tail = Buffer.from(await tailRes.arrayBuffer());
        }
      } catch {
        // 保留 headBuf 继续走既有 fail-closed 校验
      }
    }
    return { buffer: headBuf, tailBuffer: tail, durationMs: Date.now() - start };
  } catch { return null; } finally { clearTimeout(timer); }
}

export type EvidenceStatus = 'PASS' | 'FAIL' | 'UNVERIFIED';

export interface InvariantDetail {
  status: EvidenceStatus;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface TaskEvidence {
  status: 'PASS' | 'FAIL' | 'PROCESSING' | 'UNVERIFIED';
  source: string;
  terminalStatus?: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN';
  taskStatus?: number;
  progress?: number;
  error?: string;
  videoUrl?: string;
  imageUrl?: string;
  isSimulated?: boolean;
}

export interface MediaEvidence {
  status: EvidenceStatus;
  source: string;
  ownership: 'VERIFIED' | 'UNVERIFIED';
  format?: string;
  dimensions?: { width: number; height: number };
  durationSeconds?: number;
  hasMdat?: boolean;
  decodable?: boolean;
  reason?: string;
}

export interface BillingEvidence {
  status: EvidenceStatus;
  source: string;
  expectedPoints?: number;
  expectedChargeSource?: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION';
  preDeductedPoints?: number;
  settledPoints?: number;
  refundedPoints?: number;
  netDeductedPoints?: number;
  reason?: string;
}

export interface InvariantsEvidence {
  status: EvidenceStatus;
  antiDoubleBilling?: boolean;
  netChargeZero?: boolean;
  refundIdempotency?: boolean;
  details?: {
    antiDoubleBilling: InvariantDetail;
    netChargeZero: InvariantDetail;
    refundIdempotency: InvariantDetail;
  };
  reason?: string;
}

export interface VerificationEvidence {
  task: TaskEvidence;
  media: MediaEvidence;
  billing: BillingEvidence;
  invariants: InvariantsEvidence;
  business?: BusinessVerificationResult;
}

export interface VerifyKernelOptions {
  taskId: number; modelId?: number; mediaType?: 'video' | 'image'; scoreLogs?: ScoreLogEntry[];
  expectedPoints?: number; assetBuffer?: Buffer; artifactBuffer?: Buffer; tailBuffer?: Buffer; terminalStatus?: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'PROCESSING';
  resolution?: string; duration?: number; sessionFile?: string; env?: 'test' | 'preonline';
  baseUrl?: string; cookies?: string; videoUrl?: string; imageUrl?: string; pollTimeoutSec?: number;
  pollIntervalMs?: number;
  onProgress?: (snapshot: TaskStatusSnapshot) => void;
  artifactOwnership?: 'VERIFIED' | 'UNVERIFIED' | 'UNBOUND';
  isSimulated?: boolean;
  expectedChargeSource?: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION';
  contract?: DiscoveredModelContract;
  expectedResolution?: string;
  expectedDuration?: number;
  expectedWillDivert?: boolean;
  baseline?: DiversionBaseline;
  dbExtraConfirmed?: boolean;
  dbExtra?: Record<string, unknown>;
  gatewayChannelConfirmed?: boolean;
  channels?: GatewayChannelConfig[];
  gatewaySnapshot?: TrustedGatewaySnapshot;
  unconfirmedStatic?: boolean;
  customPoints?: number;
  pointsPerSecond?: number;
  price?: number;
  apiResult?: { ok: boolean; code?: number; message?: string };
  projectId?: number;
  folderId?: number;
  isFolderInProject?: boolean;
  alias?: string;
  channelId?: number;
  channelName?: string;
  targetKind?: TargetKind;
  actualChannelId?: number;
  actualChannelName?: string;
  fallbackChannel?: string;
  retryProvider?: string;
  extra?: Record<string, unknown>;
  session?: PanquSession;
  taskDetail?: Record<string, unknown>;
  retryLog?: Record<string, unknown>;
  exceptionalTask?: Record<string, unknown>;
  changeType?: 'new_model' | 'diversion_change';
  spec?: CanonicalTestSpec;
  requirement?: string;
  requirementId?: string;
  requirementText?: string;
  changedPaths?: readonly string[];
  traces?: readonly RequirementTrace[];
  resultSink?: ResultSink;
  evidenceProducers?: EvidenceProducer[];
  uiRawCollection?: unknown;
  uiVisualRawCollection?: unknown;
}
export interface VerifyKernelResult {
  ok: boolean; passed: boolean; taskId: number; modelId: number; mediaType: 'video' | 'image';
  status: 'SUCCESS' | 'FAILED' | 'PROCESSING' | 'UNVERIFIED' | 'ERROR';
  verdict: 'PASS' | 'FAIL' | 'UNVERIFIED' | 'PROCESSING';
  acceptance: AcceptanceResult;
  evidenceCompleteness: EvidenceCompleteness;
  acceptanceReport: ProductionAcceptanceReport;
  mode: 'real' | 'mock';
  executionMode: 'real' | 'offline' | 'fixture';
  progress?: number; probeDurationMs?: number; artifact?: MediaInspectionResult; billing?: BillingAuditReport;
  billingAudit: 'AUDITED' | 'SKIPPED_NO_LOGS';
  invariants?: { antiDoubleBilling: boolean; netChargeZero: boolean; refundIdempotency: boolean };
  evidence: VerificationEvidence;
  reasons: string[];
  expectedVsActual?: ExpectedVsActual;
  contract?: DiscoveredModelContract;
  businessValidation?: BusinessVerificationResult;
  memoryCandidate?: MemoryCandidatePayload;
  hasEvidenceConflict?: boolean;
  conflictReasons?: string[];
  isActualChannelAssertedOnly?: boolean;
  channelDetail?: BusinessVerificationResult['channelDetail'];
  provenance?: {
    actualChannelId: string;
    fallbackChannel: string;
    retryProvider: string;
    extra: string;
    gatewayChannel?: string;
  };
  canonicalVerdict?: CanonicalVerdictResult;
  canonicalEnvelopes?: CanonicalEvidenceEnvelope[];
  canonicalSpec?: CanonicalTestSpec;
  exportDelivery?: {
    success: boolean;
    sinkName: string;
    recordId: string;
    error?: string;
  };
}

export async function verify(options: VerifyKernelOptions): Promise<VerifyKernelResult> {
  const { taskId } = options;
  const mediaType = options.mediaType || 'video';
  const modelId = options.modelId ?? (mediaType === 'video' ? 84 : 201);
  const customPoints = options.customPoints ?? (mediaType === 'image' && options.price !== undefined ? options.price : undefined);
  const pointsPerSecond = options.pointsPerSecond ?? (mediaType === 'video' && options.price !== undefined ? options.price : undefined);

  const contract = options.contract || discoverModelContract(modelId, mediaType, {
    duration: options.duration,
    resolution: options.resolution,
    customPoints: customPoints ?? (mediaType === 'image' ? options.expectedPoints : undefined),
    pointsPerSecond,
    price: options.price,
    alias: options.alias,
  });

  const duration = options.duration ?? contract.supportedDurations?.value?.[0] ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? contract.supportedResolutions.value[0] ?? (mediaType === 'video' ? '720p' : '1k');

  const expectedPoints = options.expectedPoints ?? BillingOracle.calculateExpectedPoints({
    mediaType,
    modelId,
    duration,
    resolution,
    customPoints: customPoints ?? contract.pricing.customPoints?.value,
    pointsPerSecond: pointsPerSecond ?? contract.pricing.pointsPerSecond?.value,
  });
  const expectedChargeSource: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION' = options.expectedChargeSource ?? 'DEVTEST_EXPECTATION';

  let session: PanquSession | null = null;
  let sessionLoadError: string | undefined;
  const autoSession = options.sessionFile || (!process.env.VITEST ? (process.env.PANQU_SESSION_COOKIES_FILE || (existsSync('session.json') ? 'session.json' : existsSync('.panqu/session.json') ? '.panqu/session.json' : undefined)) : undefined);
  if (options.session) {
    session = options.session;
  } else if (options.sessionFile) {
    try {
      session = await loadPanquSession(options.sessionFile, options.env || 'test');
    } catch (err) {
      sessionLoadError = `加载凭据失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (autoSession) {
    try { session = await loadPanquSession(autoSession, options.env || 'test'); } catch { /* ignore auto session */ }
  } else if (options.cookies && options.baseUrl) {
    session = { env: options.env || 'test', base_url: options.baseUrl, cookie_string: options.cookies };
  }

  const executionMode: 'real' | 'offline' | 'fixture' = options.isSimulated
    ? 'offline'
    : (session || (options.sessionFile && sessionLoadError))
    ? 'real'
    : ((options.scoreLogs && options.scoreLogs.length > 0) || Boolean(options.assetBuffer || options.artifactBuffer))
    ? 'fixture'
    : 'offline';

  let artifactBuffer = options.assetBuffer ?? options.artifactBuffer;
  let artifactTailBuffer = options.tailBuffer;
  let probeDurationMs: number | undefined;
  let terminalStatus: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'PROCESSING';
  let taskEvidence: TaskEvidence;
  let mediaArtifactSource = artifactBuffer ? 'FIXTURE_BUFFER' : 'missing_buffer';
  let artifactOwnership: 'VERIFIED' | 'UNVERIFIED' = options.artifactOwnership === 'UNVERIFIED' || options.artifactOwnership === 'UNBOUND' ? 'UNVERIFIED' : 'VERIFIED';

  if (session) {
    const defaultTimeoutSec = mediaType === 'image' ? 60 : 180;
    const pollTimeoutSec = options.pollTimeoutSec ?? defaultTimeoutSec;
    const { finalSnapshot } = await pollTaskStatus(taskId, {
      baseUrl: session.base_url,
      cookies: session.cookie_string,
      mediaType,
      pollTimeoutSec,
      pollIntervalMs: options.pollIntervalMs,
      onProgress: options.onProgress,
    });
    if (finalSnapshot.taskStatus === 1) {
      terminalStatus = 'PROCESSING';
      taskEvidence = { status: 'PROCESSING', source: 'live_polling', terminalStatus: 'UNKNOWN', taskStatus: 1, progress: finalSnapshot.progress };
    } else if (finalSnapshot.taskStatus === 3 || finalSnapshot.taskStatus === 4) {
      terminalStatus = 'FAILED';
      taskEvidence = { status: 'FAIL', source: 'live_polling', terminalStatus: 'FAILED', taskStatus: finalSnapshot.taskStatus, error: finalSnapshot.error || '未知服务端错误', progress: finalSnapshot.progress };
    } else if (finalSnapshot.taskStatus === 2) {
      terminalStatus = 'SUCCESS';
      taskEvidence = { status: 'PASS', source: 'live_polling', terminalStatus: 'SUCCESS', taskStatus: 2, progress: finalSnapshot.progress, videoUrl: finalSnapshot.videoUrl, imageUrl: finalSnapshot.imageUrl };
      const mediaUrl = finalSnapshot.videoUrl || finalSnapshot.imageUrl;
      if (mediaUrl) {
        mediaArtifactSource = 'TASK_SNAPSHOT';
        artifactOwnership = 'VERIFIED';
        if (!artifactBuffer) {
          const probeRes = await fetchFirst64K(mediaUrl);
          if (probeRes) {
            artifactBuffer = probeRes.buffer;
            artifactTailBuffer = probeRes.tailBuffer;
            probeDurationMs = probeRes.durationMs;
          }
        }
      }
    } else {
      terminalStatus = 'UNKNOWN';
      taskEvidence = { status: 'UNVERIFIED', source: 'task_not_found', terminalStatus: 'UNKNOWN', taskStatus: 0, error: `未能从主站获取到任务 #${taskId} 状态 (任务不存在或超时) [UNVERIFIED]`, progress: 0 };
      if ((options.videoUrl || options.imageUrl) && !artifactBuffer) {
        mediaArtifactSource = 'EXTERNAL_URL';
        artifactOwnership = options.artifactOwnership === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED';
        const probeRes = await fetchFirst64K(options.videoUrl || options.imageUrl!);
        if (probeRes) {
          artifactBuffer = probeRes.buffer;
          artifactTailBuffer = probeRes.tailBuffer;
          probeDurationMs = probeRes.durationMs;
        }
      }
    }
  } else if (sessionLoadError) {
    terminalStatus = 'UNKNOWN';
    taskEvidence = {
      status: 'UNVERIFIED',
      source: 'session_error',
      terminalStatus: 'UNKNOWN',
      error: `${sessionLoadError} [UNVERIFIED]`,
    };
    mediaArtifactSource = artifactBuffer ? 'FIXTURE_BUFFER' : 'missing_session';
    if (!artifactBuffer) {
      artifactOwnership = 'UNVERIFIED';
    }
  } else {
    if (options.terminalStatus) {
      if (options.terminalStatus === 'PROCESSING') {
        terminalStatus = 'PROCESSING';
        taskEvidence = { status: 'PROCESSING', source: 'provided', terminalStatus: 'UNKNOWN', taskStatus: 1, progress: (options as any).progress ?? 50 };
      } else {
        terminalStatus = options.terminalStatus;
        taskEvidence = { status: terminalStatus === 'FAILED' ? 'FAIL' : terminalStatus === 'SUCCESS' ? 'PASS' : 'UNVERIFIED', source: 'provided', terminalStatus };
      }
    } else {
      terminalStatus = 'UNKNOWN';
      taskEvidence = { status: 'UNVERIFIED', source: 'unqueried', terminalStatus: 'UNKNOWN', error: `未连接真实主站查询且未显式传入终态，任务 #${taskId} 终态未知 [UNVERIFIED]` };
    }

    if (options.videoUrl || options.imageUrl) {
      taskEvidence.videoUrl = options.videoUrl;
      taskEvidence.imageUrl = options.imageUrl;
      mediaArtifactSource = 'EXTERNAL_URL';
      if (options.artifactOwnership !== 'VERIFIED') {
        artifactOwnership = 'UNVERIFIED';
      }
      if (!artifactBuffer) {
        const probeRes = await fetchFirst64K(options.videoUrl || options.imageUrl!);
        if (probeRes) {
          artifactBuffer = probeRes.buffer;
          artifactTailBuffer = probeRes.tailBuffer;
          probeDurationMs = probeRes.durationMs;
        }
      }
    } else if (artifactBuffer) {
      mediaArtifactSource = options.artifactOwnership === 'UNVERIFIED' || options.artifactOwnership === 'UNBOUND' ? 'EXTERNAL_BUFFER' : 'FIXTURE_BUFFER';
    }
  }

  const artifact = artifactBuffer ? (mediaType === 'video' ? inspectMp4Buffer(artifactBuffer, artifactTailBuffer) : inspectImageBuffer(artifactBuffer)) : undefined;
  let mediaEvidence: MediaEvidence;
  if (terminalStatus === 'FAILED' && !artifactBuffer) {
    mediaEvidence = { status: 'UNVERIFIED', source: 'task_failed', ownership: 'UNVERIFIED', reason: '任务执行失败，无媒体产物' };
  } else if (artifact) {
    if (artifactOwnership === 'UNVERIFIED') {
      mediaEvidence = {
        status: 'UNVERIFIED',
        source: mediaArtifactSource,
        ownership: 'UNVERIFIED',
        format: artifact.format, dimensions: artifact.dimensions, durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat, decodable: artifact.decodable,
        reason: `媒体容器物理结构有效 (${(artifact.format || 'mp4').toUpperCase()} container structure PASS)，但缺少与 Task #${taskId} 的归属绑定证据 [UNVERIFIED]`,
      };
    } else if (artifact.decodable) {
      mediaEvidence = {
        status: 'PASS',
        source: mediaArtifactSource,
        ownership: 'VERIFIED',
        format: artifact.format, dimensions: artifact.dimensions, durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat, decodable: artifact.decodable,
      };
    } else {
      mediaEvidence = {
        status: 'FAIL',
        source: mediaArtifactSource,
        ownership: 'VERIFIED',
        format: artifact.format, dimensions: artifact.dimensions, durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat, decodable: false,
        reason: artifact.reasons.join(', ') || '产物物理完整性校验失败',
      };
    }
  } else {
    mediaEvidence = {
      status: 'UNVERIFIED', source: 'missing_buffer', ownership: 'UNVERIFIED',
      reason: '缺失真实媒体产物（未提供 assetBuffer 且未获取到有效的产物下载 URL），物理结构未验真 [UNVERIFIED]',
    };
  }

  let scoreLogsToReconcile: ScoreLogEntry[] | undefined = options.scoreLogs;
  let billingSource = options.scoreLogs ? 'score_logs' : 'missing_logs';
  let billingQueryError: string | undefined;

  if (!scoreLogsToReconcile && session) {
    const queryRes = await queryTaskBillingLogs(taskId, session);
    if (queryRes.status === 'QUERY_SUCCESS') {
      scoreLogsToReconcile = queryRes.scoreLogs;
      billingSource = queryRes.source;
    } else {
      billingQueryError = queryRes.error || `账单查询异常 [${queryRes.status}]`;
      billingSource = queryRes.source;
    }
  }

  const hasScoreLogs = Array.isArray(scoreLogsToReconcile);
  const billing = hasScoreLogs ? BillingOracle.reconcileTaskLedger({ taskId, terminalStatus: terminalStatus as any, expectedPoints, expectedChargeSource, scoreLogs: scoreLogsToReconcile! }) : undefined;

  let billingEvidence: BillingEvidence;
  let invariantsEvidence: InvariantsEvidence;
  let invariants: { antiDoubleBilling: boolean; netChargeZero: boolean; refundIdempotency: boolean } | undefined;

  if (billing) {
    const hasBillingViolations = Boolean(
      billing.duplicateCharged ||
      billing.duplicateRefunded ||
      billing.missingRefund ||
      billing.underCharged ||
      billing.overCharged ||
      billing.antiDoubleBilling === false ||
      billing.netChargeZero === false ||
      billing.refundIdempotency === false
    );
    const billingStatus: EvidenceStatus = hasBillingViolations ? 'FAIL' : billing.passed ? 'PASS' : 'UNVERIFIED';

    const isSuccessEmpty = scoreLogsToReconcile && scoreLogsToReconcile.length === 0;
    const reason = !billing.passed
      ? (isSuccessEmpty
          ? '真实数据源明确确认该任务在查询范围内无流水记录 [QUERY_SUCCESS + 0 records]'
          : billing.reasons.join(', '))
      : undefined;

    billingEvidence = {
      status: billingStatus,
      source: billingSource,
      expectedPoints,
      expectedChargeSource,
      preDeductedPoints: billing.preDeductedPoints,
      settledPoints: billing.settledPoints,
      refundedPoints: billing.refundedPoints,
      netDeductedPoints: billing.netDeductedPoints,
      reason,
    };

    const antiDouble = billing.antiDoubleBilling;
    const netZero = billing.netChargeZero;
    const refundIdem = billing.refundIdempotency;

    const antiDoubleItem: InvariantDetail = antiDouble === true
      ? { status: 'PASS', evidence: { preDeductCount: billing.preDeductCount } }
      : antiDouble === false
      ? { status: 'FAIL', reason: '违背防重复扣费不变量: 存在多笔扣费或重复扣款' }
      : { status: 'UNVERIFIED', reason: '缺少有效预扣流水，防重复扣费不变量未核验 [UNVERIFIED]' };

    const netZeroItem: InvariantDetail = netZero === true
      ? { status: 'PASS', evidence: { netDeductedPoints: billing.netDeductedPoints } }
      : netZero === false
      ? { status: 'FAIL', reason: terminalStatus === 'FAILED' ? '违背失败净扣归零不变量: 失败任务净扣不为 0 或少/超额退款' : '计费不匹配预期扣费' }
      : { status: 'UNVERIFIED', reason: '任务终态未知或缺少有效账务记录，失败净扣归零不变量未核验 [UNVERIFIED]' };

    const refundIdemItem: InvariantDetail = refundIdem === true
      ? { status: 'PASS', evidence: { refundCount: billing.refundCount } }
      : refundIdem === false
      ? { status: 'FAIL', reason: '违背退款幂等核销不变量: 存在重复退款、异常退款或失败未退款' }
      : { status: 'UNVERIFIED', reason: '缺少有效预扣或退款流水，退款幂等核销不变量未核验 [UNVERIFIED]' };

    const anyInvFailed = antiDoubleItem.status === 'FAIL' || netZeroItem.status === 'FAIL' || refundIdemItem.status === 'FAIL';
    const allInvPassed = antiDoubleItem.status === 'PASS' && netZeroItem.status === 'PASS' && refundIdemItem.status === 'PASS';
    const invStatus: EvidenceStatus = anyInvFailed ? 'FAIL' : allInvPassed ? 'PASS' : 'UNVERIFIED';

    invariantsEvidence = {
      status: invStatus,
      antiDoubleBilling: antiDouble,
      netChargeZero: netZero,
      refundIdempotency: refundIdem,
      details: {
        antiDoubleBilling: antiDoubleItem,
        netChargeZero: netZeroItem,
        refundIdempotency: refundIdemItem,
      },
      reason: anyInvFailed ? [antiDoubleItem.reason, netZeroItem.reason, refundIdemItem.reason].filter(Boolean).join('; ') : undefined,
    };

    invariants = billing ? {
      antiDoubleBilling: antiDouble === true,
      netChargeZero: netZero === true,
      refundIdempotency: refundIdem === true,
    } : undefined;
  } else {
    const skipReason = sessionLoadError
      ? `凭据加载失败 (${sessionLoadError})，缺少真实账务证据 [UNVERIFIED]`
      : billingQueryError
      ? `账单流水查询异常 (${billingQueryError})，缺少真实账务证据 [UNVERIFIED]`
      : terminalStatus === 'FAILED'
      ? '未提供账单流水，无法核验失败退款净扣归零，缺少真实账务证据获取能力 [SKIPPED_NO_LOGS]'
      : '未提供账单流水，缺少真实账务证据获取能力 [SKIPPED_NO_LOGS]';
    billingEvidence = { status: 'UNVERIFIED', source: billingSource, expectedPoints, expectedChargeSource, reason: skipReason };
    invariantsEvidence = {
      status: 'UNVERIFIED',
      details: {
        antiDoubleBilling: { status: 'UNVERIFIED', reason: skipReason },
        netChargeZero: { status: 'UNVERIFIED', reason: skipReason },
        refundIdempotency: { status: 'UNVERIFIED', reason: skipReason },
      },
      reason: skipReason,
    };
  }

  if (!contract.pricing.allowPass) {
    billingEvidence = {
      ...billingEvidence,
      status: 'UNVERIFIED',
      reason: `真实刊例定价未确定 (${contract.pricing.source})，不可用于生产 PASS 验收 [BLOCKED_FALLBACK_PRICING]`,
    };
  }

  let runtimeDetails: TaskRuntimeDetails | undefined;
  if (session && !session.base_url.includes('example.com')) {
    try {
      runtimeDetails = await queryTaskRuntimeDetails(taskId, session, { projectId: options.projectId ?? session.project_id });
    } catch {
      /* 容忍只读查询非致命抖动 */
    }
  }

  // 目标渠道消歧与判定
  const targetDisambiguation = (options.channelId !== undefined || options.channelName !== undefined || options.targetKind === 'channel')
    ? RoutingOracle.disambiguateTarget({
        targetKind: options.targetKind,
        channelId: options.channelId,
        channelName: options.channelName,
        modelId,
        modelAlias: options.alias,
        projectId: options.projectId,
        mode: options.isSimulated ? 'mock' : (session ? 'real' : 'mock'),
      })
    : undefined;

  const targetChannelId = targetDisambiguation?.channelId ?? options.channelId;
  const targetChannelName = targetDisambiguation?.channelName ?? options.channelName;

  const rawExceptionalExtra = runtimeDetails?.rawExceptionalTask?.extra as Record<string, unknown> | undefined;
  const optionsExceptionalExtra = options.exceptionalTask?.extra as Record<string, unknown> | undefined;

  // 1. 服务端只读事实提取 (Server Facts)
  const serverActualChannelId = runtimeDetails?.actualChannelId
    ?? (options.retryLog?.newapi_channel_id ? Number(options.retryLog.newapi_channel_id) : undefined);
  const serverActualChannelName = runtimeDetails?.actualChannelName
    ?? (options.retryLog?.newapi_provider_name ? String(options.retryLog.newapi_provider_name) : undefined)
    ?? (runtimeDetails?.rawExceptionalTask?.line_name ? String(runtimeDetails.rawExceptionalTask.line_name) : undefined);
  const serverFallbackChannel = runtimeDetails?.fallbackChannel
    ?? (options.retryLog?.fallback_channel ? String(options.retryLog.fallback_channel) : undefined);
  const serverRetryProvider = runtimeDetails?.retryProvider
    ?? (rawExceptionalExtra?.retry_provider ? String(rawExceptionalExtra.retry_provider) : undefined)
    ?? (optionsExceptionalExtra?.retry_provider ? String(optionsExceptionalExtra.retry_provider) : undefined);

  // 2. 调用者入参手填断言 (Asserted Inputs)
  const assertedActualChannelId = options.actualChannelId;
  const assertedActualChannelName = options.actualChannelName;
  const assertedFallbackChannel = options.fallbackChannel;
  const assertedRetryProvider = options.retryProvider;

  // 3. 证据冲突检测 (EVIDENCE_CONFLICT)
  let hasEvidenceConflict = false;
  const conflictReasons: string[] = [];

  if (serverActualChannelId !== undefined && assertedActualChannelId !== undefined && serverActualChannelId !== assertedActualChannelId) {
    hasEvidenceConflict = true;
    conflictReasons.push(`实际渠道证据冲突 [EVIDENCE_CONFLICT]: 服务端事实为 Channel #${serverActualChannelId} ('${serverActualChannelName || serverActualChannelId}'), 调用者手填断言为 Channel #${assertedActualChannelId} ('${assertedActualChannelName || assertedActualChannelId}')。必须优先采用服务端事实。`);
  }

  const normServerFallback = (serverFallbackChannel && serverFallbackChannel !== 'none') ? serverFallbackChannel : undefined;
  const normAssertedFallback = (assertedFallbackChannel && assertedFallbackChannel !== 'none') ? assertedFallbackChannel : undefined;
  if (normServerFallback !== undefined && assertedFallbackChannel === 'none') {
    hasEvidenceConflict = true;
    conflictReasons.push(`兜底渠道证据冲突 [EVIDENCE_CONFLICT]: 服务端事实存在兜底 '${normServerFallback}', 调用者断言为无兜底 (none)。必须优先采用服务端事实。`);
  } else if (normServerFallback !== undefined && normAssertedFallback !== undefined && normServerFallback !== normAssertedFallback) {
    hasEvidenceConflict = true;
    conflictReasons.push(`兜底渠道证据冲突 [EVIDENCE_CONFLICT]: 服务端事实为 fallback='${normServerFallback}', 调用者断言为 '${normAssertedFallback}'。必须优先采用服务端事实。`);
  }

  const normServerRetry = (serverRetryProvider && serverRetryProvider !== 'none') ? serverRetryProvider : undefined;
  const normAssertedRetry = (assertedRetryProvider && assertedRetryProvider !== 'none') ? assertedRetryProvider : undefined;
  if (normServerRetry !== undefined && assertedRetryProvider === 'none') {
    hasEvidenceConflict = true;
    conflictReasons.push(`重试 Provider 证据冲突 [EVIDENCE_CONFLICT]: 服务端事实存在重试 provider '${normServerRetry}', 调用者断言为无重试 (none)。必须优先采用服务端事实。`);
  } else if (normServerRetry !== undefined && normAssertedRetry !== undefined && normServerRetry !== normAssertedRetry) {
    hasEvidenceConflict = true;
    conflictReasons.push(`重试 Provider 证据冲突 [EVIDENCE_CONFLICT]: 服务端事实为 retryProvider='${normServerRetry}', 调用者断言为 '${normAssertedRetry}'。必须优先采用服务端事实。`);
  }

  // 4. 事实仲裁：服务端只读事实强制优先于手填输入！
  const actualChannelId = serverActualChannelId ?? assertedActualChannelId;
  const actualChannelName = (serverActualChannelId !== undefined ? serverActualChannelName : undefined) ?? assertedActualChannelName ?? serverActualChannelName;
  const fallbackChannel = serverFallbackChannel ?? assertedFallbackChannel;
  const retryProvider = serverRetryProvider ?? assertedRetryProvider;

  const isActualChannelAssertedOnly = Boolean(session && !options.isSimulated) && serverActualChannelId === undefined && assertedActualChannelId !== undefined;

  // 5. 记录字段精确 Provenance
  let channelProvenance: string;
  if (runtimeDetails?.actualChannelId !== undefined) {
    channelProvenance = 'HTTP_API:retrylog';
  } else if (options.retryLog?.newapi_channel_id !== undefined) {
    channelProvenance = 'SERVER_RETRYLOG_FIXTURE';
  } else if (assertedActualChannelId !== undefined) {
    channelProvenance = (session && !options.isSimulated) ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    channelProvenance = 'UNVERIFIED';
  }

  let fallbackProvenance: string;
  if (runtimeDetails?.fallbackChannel !== undefined) {
    fallbackProvenance = 'HTTP_API:retrylog';
  } else if (options.retryLog?.fallback_channel !== undefined) {
    fallbackProvenance = 'SERVER_RETRYLOG_FIXTURE';
  } else if (assertedFallbackChannel !== undefined) {
    fallbackProvenance = (session && !options.isSimulated) ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    fallbackProvenance = 'UNVERIFIED';
  }

  let retryProvenance: string;
  if (runtimeDetails?.retryProvider !== undefined) {
    retryProvenance = 'HTTP_API:exceptional-task';
  } else if (rawExceptionalExtra?.retry_provider !== undefined || optionsExceptionalExtra?.retry_provider !== undefined) {
    retryProvenance = 'SERVER_EXCEPTIONAL_FIXTURE';
  } else if (assertedRetryProvider !== undefined) {
    retryProvenance = (session && !options.isSimulated) ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    retryProvenance = 'UNVERIFIED';
  }

  // 6. extra 对象与来源追踪 (绝不把 exceptional-task 的 extra 冒充为 HTTP_API:getEditData)
  let extraObj: Record<string, unknown> | undefined;
  let extraProvenance: string;

  if (runtimeDetails?.extra) {
    extraObj = runtimeDetails.extra;
    extraProvenance = runtimeDetails.extraSource || 'HTTP_API:getEditData';
  } else if (runtimeDetails?.rawExceptionalTask?.extra) {
    const rowExtra = typeof runtimeDetails.rawExceptionalTask.extra === 'string'
      ? JSON.parse(runtimeDetails.rawExceptionalTask.extra)
      : runtimeDetails.rawExceptionalTask.extra;
    extraObj = rowExtra as Record<string, unknown>;
    extraProvenance = 'HTTP_API:exceptional-task';
  } else if (options.dbExtra) {
    extraObj = options.dbExtra;
    extraProvenance = 'DB_READONLY_QUERY';
  } else if (options.extra) {
    extraObj = options.extra;
    extraProvenance = 'CLI_MANUAL_INPUT';
  } else if (options.exceptionalTask?.extra) {
    extraObj = options.exceptionalTask.extra as Record<string, unknown>;
    extraProvenance = 'FIXTURE:exceptional-task';
  } else if (options.taskDetail?.extra) {
    extraObj = options.taskDetail.extra as Record<string, unknown>;
    extraProvenance = 'TASK_DETAIL';
  } else {
    extraProvenance = 'UNVERIFIED';
  }

  const isDbExtraVerified = Boolean(
    options.dbExtraConfirmed ||
    options.dbExtra ||
    (extraObj && typeof extraObj === 'object' && (extraObj.diversion !== undefined || extraObj.newapi_image !== undefined))
  );

  let channelMatched: boolean | undefined;
  let isFallbackExecution = false;
  let channelMismatchReason: string | undefined;

  if (targetChannelId !== undefined) {
    if (hasEvidenceConflict) {
      channelMatched = false;
      channelMismatchReason = `渠道或兜底证据存在冲突 [EVIDENCE_CONFLICT]: ${conflictReasons.join('; ')}`;
    } else if (isActualChannelAssertedOnly) {
      channelMatched = undefined;
      channelMismatchReason = `实际渠道仅来自调用者断言 (#${assertedActualChannelId})，缺少服务端只读运行时凭据证实 [UNVERIFIED]`;
    } else if (actualChannelId !== undefined) {
      if (actualChannelId === targetChannelId) {
        channelMatched = true;
      } else {
        channelMatched = false;
        channelMismatchReason = `目标渠道不匹配: 预期渠道 #${targetChannelId} ('${targetChannelName || targetChannelId}'), 服务端实际执行渠道为 #${actualChannelId} ('${actualChannelName || actualChannelId}') [CHANNEL_MISMATCH]`;
      }
    } else {
      channelMismatchReason = `缺少服务端执行渠道证据，无法核验是否由目标渠道 #${targetChannelId} ('${targetChannelName || targetChannelId}') 履约 [UNVERIFIED]`;
    }

    const effectiveFallback = (fallbackChannel && fallbackChannel !== 'none') ? fallbackChannel : (retryProvider && retryProvider !== 'none' ? retryProvider : undefined);
    if (effectiveFallback) {
      isFallbackExecution = true;
      const fallbackReason = `目标渠道未产出成片，成片由兜底通道 (${effectiveFallback}) 生成，不得误判为目标渠道合格 [FALLBACK_ARTIFACT_NOT_ACCEPTED]`;
      channelMismatchReason = channelMismatchReason ? `${channelMismatchReason}; ${fallbackReason}` : fallbackReason;
    }
  }

  const isRealMode = Boolean(session && !options.isSimulated);
  const isGatewayChannelRequired = mediaType === 'video' && contract.routing.value.willDivert;

  const snapshotValidation = options.gatewaySnapshot
    ? validateTrustedGatewaySnapshot(options.gatewaySnapshot, { expectedEnv: options.env })
    : undefined;

  // 可信快照门禁：
  // 1. REAL 模式下：必须由 validateTrustedGatewaySnapshot 验证通过 (provenance === 'API_READONLY_COLLECTOR' + status === 'SUCCESS')；
  //    调用者在普通 channels 中手工传入 sourceMode === 'SOURCE_REAL_GATEWAY' 而无可信快照记录的，一律视为未经验证断言，fail-closed！
  // 2. OFFLINE/FIXTURE 模式下：允许使用 options.gatewaySnapshot 或 options.channels 的 sourceMode === 'SOURCE_REAL_GATEWAY' 桩数据放行。
  const hasRealGatewaySnapshot = isRealMode
    ? Boolean(snapshotValidation?.valid)
    : Boolean(
        snapshotValidation?.valid ||
        (options.channels && options.channels.length > 0 && options.channels.some((c) => c.sourceMode === 'SOURCE_REAL_GATEWAY'))
      );

  const hasServerActualChannelFact = serverActualChannelId !== undefined && !isActualChannelAssertedOnly;

  // 核心安全门禁：REAL 模式下，options.gatewayChannelConfirmed=true 或 options.channels 手工声称 sourceMode 属于用户声明，绝不能单独满足网关渠道验证！
  // REAL 模式只接受：(1) 由可信只读 API 采集路径获得的有效快照；或 (2) 服务端运行时返回的非调用者断言渠道事实
  const isGatewayChannelVerified = isRealMode
    ? Boolean(hasRealGatewaySnapshot || hasServerActualChannelFact)
    : Boolean(
        options.gatewayChannelConfirmed ||
        hasRealGatewaySnapshot ||
        serverActualChannelId !== undefined
      );

  let gatewayChannelEvidence: string;
  let gatewayChannelProvenance: string;

  if (hasRealGatewaySnapshot) {
    gatewayChannelEvidence = 'SOURCE_REAL_GATEWAY';
    gatewayChannelProvenance = snapshotValidation?.snapshot
      ? `API_READONLY_COLLECTOR (${snapshotValidation.snapshot.sourceEndpoint})`
      : 'SOURCE_REAL_GATEWAY';
  } else if (hasServerActualChannelFact) {
    gatewayChannelEvidence = 'SERVER_RUN_FACT';
    gatewayChannelProvenance = channelProvenance;
  } else if (options.gatewaySnapshot && !snapshotValidation?.valid) {
    // 提供了快照但校验失败（过期、失败、来源不明等），严格 fail-closed
    gatewayChannelEvidence = 'INVALID_GATEWAY_SNAPSHOT';
    gatewayChannelProvenance = `FAIL_CLOSED (${snapshotValidation?.reason || 'INVALID_SNAPSHOT'})`;
  } else if (isRealMode && options.channels && options.channels.some((c) => c.sourceMode === 'SOURCE_REAL_GATEWAY')) {
    // REAL 模式下调用者手工传 sourceMode=SOURCE_REAL_GATEWAY 但无可信快照
    gatewayChannelEvidence = 'USER_ASSERTION_REJECTED';
    gatewayChannelProvenance = 'CLI_ASSERTED_INPUT (BLOCKED_MISSING_TRUSTED_COLLECTOR)';
  } else if (options.gatewayChannelConfirmed) {
    // 兼容保留：仅在 OFFLINE/FIXTURE 模式被视为 USER_ASSERTION/FIXTURE，绝不得标记为 SERVER_API，REAL 模式禁止放行
    gatewayChannelEvidence = isRealMode ? 'USER_ASSERTION_REJECTED' : 'USER_ASSERTION (FIXTURE)';
    gatewayChannelProvenance = isRealMode ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    gatewayChannelEvidence = 'MANUAL_REQUIRED';
    gatewayChannelProvenance = 'UNVERIFIED (BLOCKED_MISSING_TRUSTED_COLLECTOR)';
  }

  let regressionDiff: DiversionRegressionDiff | undefined;
  if (options.baseline) {
    const baseline = options.baseline;
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
        const matches = (baseFmt === 'png/jpg' && (actualFmt.includes('png') || actualFmt.includes('jpg') || actualFmt.includes('jpeg')))
          || (baseFmt === 'mp4' && actualFmt.includes('mp4'))
          || actualFmt.includes(baseFmt)
          || baseFmt.includes(actualFmt);
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

    regressionDiff = {
      expectedChanges,
      observedChanges,
      unexpectedChanges,
      missingEvidence,
      isRegression,
      regressionStatus,
    };
  }

  const businessValidation = evaluateBusinessVerification({
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
      status: invariantsEvidence.status,
      antiDoubleBilling: invariantsEvidence.antiDoubleBilling,
      netChargeZero: invariantsEvidence.netChargeZero,
      refundIdempotency: invariantsEvidence.refundIdempotency,
      reason: invariantsEvidence.reason,
    },
    paramRelations: (options.projectId !== undefined || options.folderId !== undefined || options.isFolderInProject !== undefined) ? {
      projectId: options.projectId,
      folderId: options.folderId,
      isFolderInProject: options.isFolderInProject,
    } : undefined,
    channelAssertion: targetChannelId !== undefined ? {
      targetChannelId,
      targetChannelName,
      actualChannelId,
      actualChannelName,
      fallbackChannel,
      retryProvider,
      hasEvidenceConflict,
      conflictReasons,
      isActualChannelAssertedOnly,
    } : undefined,
  });

  const reasons: string[] = [];
  if (taskEvidence.status === 'PROCESSING' || terminalStatus === 'PROCESSING') {
    reasons.push(`任务 #${taskId} 仍在排队/生成中 (进度: ${(taskEvidence as any).progress ?? (options as any).progress ?? 0}%)，未到达终态。`);
  }
  if (taskEvidence.status === 'FAIL') reasons.push(`任务执行失败: ${taskEvidence.error || '任务状态异常'}`);
  if (taskEvidence.status === 'UNVERIFIED') reasons.push(taskEvidence.error || '任务状态未确认 [UNVERIFIED]');
  if (mediaEvidence.status === 'FAIL') reasons.push(`产物物理完整性校验失败: ${mediaEvidence.reason || '文件损坏'}`);
  if (mediaEvidence.status === 'UNVERIFIED' && terminalStatus !== 'FAILED') reasons.push(mediaEvidence.reason!);
  if (billingEvidence.status === 'FAIL') reasons.push(`账单审计失败: ${billingEvidence.reason}`);
  if (billingEvidence.status === 'UNVERIFIED') reasons.push(billingEvidence.reason!);
  if (invariantsEvidence.status === 'FAIL') reasons.push(invariantsEvidence.reason!);
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

  const targetChannelFailed = targetChannelId !== undefined && (channelMatched === false || isFallbackExecution);
  const targetChannelUnverified = targetChannelId !== undefined && channelMatched === undefined;



  const diffItems: DiffItem[] = [
    {
      field: 'taskStatus',
      layer: 'execution',
      expected: options.terminalStatus ?? 'SUCCESS',
      actual: terminalStatus,
      matched: terminalStatus === (options.terminalStatus ?? 'SUCCESS'),
      status: terminalStatus === (options.terminalStatus ?? 'SUCCESS') ? 'PASS' : (terminalStatus === 'UNKNOWN' ? 'BLOCKED' : 'FAIL'),
      diff: terminalStatus === (options.terminalStatus ?? 'SUCCESS') ? 'MATCH' : `Expected ${options.terminalStatus ?? 'SUCCESS'}, got ${terminalStatus}`,
      critical: true,
      evidence: taskEvidence.source,
    },
    {
      field: 'mediaFormat',
      layer: 'artifact',
      expected: mediaType === 'video' ? 'mp4' : 'png/jpg',
      actual: artifact?.format || (terminalStatus === 'FAILED' ? 'NONE_TASK_FAILED' : 'MISSING_MEDIA'),
      matched: terminalStatus === 'FAILED' ? true : Boolean(artifact?.decodable),
      status: terminalStatus === 'FAILED' ? 'PASS' : (artifact?.decodable ? 'PASS' : (artifactBuffer ? 'FAIL' : 'BLOCKED')),
      diff: terminalStatus === 'FAILED'
        ? 'MATCH (失败任务无产物)'
        : (artifact?.decodable ? 'MATCH' : (artifactBuffer ? `产物无法解码: ${artifact?.format || 'CORRUPTED'}` : '缺少媒体产物证据 [BLOCKED]')),
      critical: true,
      evidence: mediaArtifactSource,
    },
    {
      field: 'billingPoints',
      layer: 'billing',
      expected: terminalStatus === 'FAILED' ? 0 : expectedPoints,
      actual: billing ? billing.netDeductedPoints : 'NO_SCORE_LOGS',
      matched: billing ? (billing.netDeductedPoints === (terminalStatus === 'FAILED' ? 0 : expectedPoints) && contract.pricing.allowPass) : false,
      status: !contract.pricing.allowPass
        ? 'BLOCKED'
        : billing
        ? (billing.netDeductedPoints === (terminalStatus === 'FAILED' ? 0 : expectedPoints) ? 'PASS' : 'FAIL')
        : 'BLOCKED',
      diff: !contract.pricing.allowPass
        ? `刊例定价未确定 (${contract.pricing.source}) [BLOCKED]`
        : billing
        ? (billing.netDeductedPoints === (terminalStatus === 'FAILED' ? 0 : expectedPoints) ? 'MATCH' : `Expected ${terminalStatus === 'FAILED' ? 0 : expectedPoints} pts, got ${billing.netDeductedPoints} pts`)
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
        : (runtimeDetails?.endpoints?.getEditData?.queryStatus === 'UNVERIFIED_MISSING_PROJECT_ID'
          ? 'UNVERIFIED_MISSING_PROJECT_ID'
          : 'NOT_FOUND_IN_HTTP_API_OR_DB (MANUAL_REQUIRED)'),
      matched: isDbExtraVerified,
      status: isDbExtraVerified ? 'PASS' : 'MANUAL_REQUIRED',
      diff: isDbExtraVerified
        ? 'MATCH'
        : (runtimeDetails?.endpoints?.getEditData?.queryStatus === 'UNVERIFIED_MISSING_PROJECT_ID'
          ? '缺少 projectId，无法查询 /aivideo/v2/video/getEditData 接口 [UNVERIFIED_MISSING_PROJECT_ID]'
          : '未从只读 HTTP 接口获取到 extra.diversion，需以只读权限查询 DB 验证落库 [MANUAL_REQUIRED]'),
      critical: false,
      evidence: extraProvenance,
    },
    {
      field: 'businessValidation',
      layer: 'domain',
      expected: 'BUSINESS_SUCCESS',
      actual: businessValidation.businessSuccess ? 'BUSINESS_SUCCESS' : (businessValidation.status === 'FAIL' ? 'BUSINESS_FAIL' : 'BUSINESS_UNVERIFIED'),
      matched: businessValidation.businessSuccess,
      status: businessValidation.businessSuccess ? 'PASS' : (businessValidation.status === 'FAIL' ? 'FAIL' : 'BLOCKED'),
      diff: businessValidation.businessSuccess ? 'MATCH' : (businessValidation.reasons.join('; ') || '业务级验证未全部满足'),
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
      actual: actualChannelId !== undefined
        ? `Channel #${actualChannelId} ('${actualChannelName || actualChannelId}')${isFallbackExecution ? ` [Fallback: ${fallbackChannel || retryProvider}]` : ''}`
        : 'UNVERIFIED_RUNTIME_CHANNEL',
      matched: channelMatched === true && !isFallbackExecution && !hasEvidenceConflict && !isActualChannelAssertedOnly,
      status: (channelMatched === true && !isFallbackExecution && !hasEvidenceConflict && !isActualChannelAssertedOnly)
        ? 'PASS'
        : (channelMatched === false || isFallbackExecution || hasEvidenceConflict)
        ? 'FAIL'
        : 'BLOCKED',
      diff: hasEvidenceConflict
        ? `存在证据冲突: ${conflictReasons.join('; ')}`
        : isActualChannelAssertedOnly
        ? '实际执行渠道仅来自调用者入参断言，无服务端运行时证据证实 [UNVERIFIED_ASSERTED_INPUT]'
        : (channelMismatchReason || 'MATCH'),
      critical: true,
      evidence: channelProvenance,
    });
  }

  if (isGatewayChannelRequired) {
    const isCallerAssertedReal = isRealMode && (
      Boolean(options.gatewayChannelConfirmed) ||
      Boolean(options.channels && options.channels.some((c) => c.sourceMode === 'SOURCE_REAL_GATEWAY'))
    );
    const snapshotFailure = options.gatewaySnapshot && !snapshotValidation?.valid;

    diffItems.push({
      field: 'gatewayChannel',
      layer: 'routing',
      expected: 'NewAPI upstream channel configured',
      actual: isGatewayChannelVerified
        ? (hasRealGatewaySnapshot
          ? `${(options.gatewaySnapshot?.channels || options.channels)?.length} channel(s) (REAL_GATEWAY_SNAPSHOT)`
          : (hasServerActualChannelFact ? `Channel #${serverActualChannelId}` : 'CONFIRMED (FIXTURE)'))
        : (snapshotFailure
          ? `FAIL_CLOSED (${snapshotValidation?.reason})`
          : (isCallerAssertedReal
            ? 'UNVERIFIED_USER_ASSERTION (REAL模式禁止手填或伪造网关快照)'
            : 'MISSING_GATEWAY_CHANNEL_EVIDENCE [BLOCKED_MISSING_TRUSTED_COLLECTOR]')),
      matched: isGatewayChannelVerified,
      status: isGatewayChannelVerified ? 'PASS' : 'MANUAL_REQUIRED',
      diff: isGatewayChannelVerified
        ? 'MATCH'
        : (snapshotFailure
          ? `网关渠道快照未通过可信校验: ${snapshotValidation?.reason} [FAIL_CLOSED]`
          : (isCallerAssertedReal
            ? 'REAL 模式下禁止仅凭用户声明或手工入参 sourceMode=SOURCE_REAL_GATEWAY 满足网关渠道验证 [BLOCKED_MISSING_TRUSTED_COLLECTOR]'
            : '缺少 NewAPI 网关上游通道确认证据 [MANUAL_GATEWAY_CHANNEL_REQUIRED:BLOCKED_MISSING_TRUSTED_COLLECTOR]')),
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
    const expectedRes = options.expectedResolution || resolution || '720p';
    diffItems.push({
      field: 'dimensions',
      layer: 'artifact',
      expected: expectedRes,
      actual: `${artifact.dimensions.width}x${artifact.dimensions.height}`,
      matched: true,
      status: 'PASS',
      diff: 'MATCH',
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
        : (regressionDiff.regressionStatus === 'UNKNOWN' ? 'Regression status unknown (missing evidence)' : 'Clean (no regression)'),
      matched: !regressionDiff.isRegression && regressionDiff.regressionStatus === 'CLEAN',
      status: regressionDiff.isRegression ? 'FAIL' : (regressionDiff.regressionStatus === 'UNKNOWN' ? 'BLOCKED' : 'PASS'),
      diff: regressionDiff.isRegression
        ? regressionDiff.unexpectedChanges.map((u) => u.reason).join('; ')
        : (regressionDiff.regressionStatus === 'UNKNOWN' ? '缺少基线比对关键证据，无法确定无回归 [regressionStatus: UNKNOWN]' : 'MATCH'),
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

  const allCriticalMatched = diffItems.filter((i) => i.critical).every((i) => i.matched);

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
    missingEvidence.push(taskEvidence.status === 'FAIL' ? 'taskTerminalStatus:FAILED' : 'taskTerminalStatus:UNVERIFIED');
  }

  if (mediaEvidence.status === 'PASS' || (terminalStatus === 'FAILED' && !artifactBuffer)) {
    availableEvidence.push('mediaArtifactDecodable');
  } else {
    missingEvidence.push(mediaEvidence.status === 'FAIL' ? 'mediaArtifactDecodable:CORRUPTED' : 'mediaArtifactDecodable:UNVERIFIED');
  }

  if (billingEvidence.status === 'PASS') {
    availableEvidence.push('billingLedgerReconciled');
  } else {
    missingEvidence.push(billingEvidence.status === 'FAIL' ? 'billingLedgerReconciled:AUDIT_FAILED' : 'billingLedgerReconciled:NO_LOGS');
  }

  if (contract.pricing.allowPass && contract.pricing.isPricingDetermined && contract.pricing.source !== 'SOURCE_DEFAULT_FALLBACK') {
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
  const capturedAt = (options as any).capturedAt || new Date().toISOString();
  const testId = (options as any).testId || (options as any).spec?.testId || `verify-${taskId}`;
  const environment = (options as any).environment || (options as any).spec?.environment || 'test';
  const rawMode: 'real' | 'offline' | 'fixture' = (session || (options as any).executionMode === 'real' || executionMode === 'real') ? 'real' : (executionMode === 'offline' ? 'offline' : 'fixture');
  const canonicalExecutionMode: ExecutionMode = rawMode === 'real' ? 'REAL' : (rawMode === 'offline' ? 'OFFLINE' : 'FIXTURE');

  const facts: CanonicalVerifyFacts = {
    testId,
    capturedAt,
    environment,
    executionMode: rawMode,
    taskId,
    modelId,
    mediaType,
    progress: (options as any).progress,
    task: taskEvidence,
    artifact: artifact ? {
      ...artifact,
      ownership: artifactOwnership,
      status: mediaEvidence.status,
    } : undefined,
    artifactOwnership,
    billing: billing ? {
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
        billing.refundIdempotency === false
      ),
    } : undefined,
    billingAudit: (billing && scoreLogsToReconcile && scoreLogsToReconcile.length > 0) ? 'AUDITED' : 'SKIPPED_NO_LOGS',
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
    regressionDiff: regressionDiff ? {
      isRegression: regressionDiff.isRegression,
      regressionStatus: regressionDiff.regressionStatus,
      unexpectedChanges: regressionDiff.unexpectedChanges,
    } : undefined,
    contractConflicts: contract.conflicts.length > 0 ? contract.conflicts : undefined,
    businessValidationStatus: businessValidation.status,
    gatewayChannelFact: (isGatewayChannelRequired && (options.gatewaySnapshot || options.gatewayChannelConfirmed || options.channels)) ? {
      verified: isGatewayChannelVerified,
      required: true,
      failureReason: options.gatewaySnapshot && !snapshotValidation?.valid ? snapshotValidation?.reason : undefined,
    } : undefined,
    isDbExtraVerified,
  };

  const evidenceRes = buildCanonicalEvidenceFromVerifyFacts(facts);
  let envelopes: CanonicalEvidenceEnvelope[] = evidenceRes.success && evidenceRes.value ? evidenceRes.value : [];
  if (Array.isArray((options as any).extraEnvelopes)) {
    envelopes = [...envelopes, ...(options as any).extraEnvelopes];
  }

  // 聚合 options.evidenceProducers 产出的真实观察信封
  if (options.evidenceProducers && options.evidenceProducers.length > 0) {
    const producerContext: EvidenceProducerContext = {
      testId,
      environment,
      subjectType: 'task',
      subjectId: taskId,
      executionMode: canonicalExecutionMode,
      taskId,
      modelId,
      mediaType,
    };
    for (const producer of options.evidenceProducers) {
      try {
        const raw = (producer.producerName.includes('visual') || producer.sourceType === 'AI_OBSERVATION')
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
  if ((options as any).spec) {
    canonicalSpec = (options as any).spec;
  } else {
    const isRealSpec = canonicalExecutionMode === 'REAL';
    const taskKey = isRealSpec ? 'SERVER_API:TASK_STATUS' : 'FIXTURE:TASK_STATUS';
    const routingKey = isRealSpec ? 'SERVER_API:ROUTING_CHANNEL' : 'FIXTURE:ROUTING_CHANNEL';

    const reqEvidence: string[] = [taskKey];
    if (mediaType === 'video' || mediaType === 'image') {
      reqEvidence.push('MEDIA_BINARY:CONTAINER_CHECK');
    }
    const isBillingInScope = (contract.pricing.allowPass && contract.pricing.isPricingDetermined && contract.pricing.source !== 'SOURCE_DEFAULT_FALLBACK')
      || (expectedPoints !== undefined && expectedPoints > 0)
      || (scoreLogsToReconcile && scoreLogsToReconcile.length > 0)
      || (!contract.pricing.allowPass || !contract.pricing.isPricingDetermined);
    if (isBillingInScope) {
      reqEvidence.push('BILLING_LEDGER:TASK_RECORDS');
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
    const isGatewayInScope = isRealSpec || options.gatewayChannelConfirmed !== undefined || options.gatewaySnapshot !== undefined || options.channels !== undefined;
    if (isGatewayChannelRequired && isGatewayInScope) {
      reqEvidence.push(isRealSpec ? 'SERVER_API:GATEWAY_CHANNEL' : 'FIXTURE:GATEWAY_CHANNEL');
    }

    // 需要核验 extra.diversion 时，即使没有 DB/API 证据也必须要求对应 evidenceKey
    const isDiversionScenario = contract.scenario === 'IMAGE_DIVERSION_CHANGE' || contract.scenario === 'VIDEO_DIVERSION_CHANGE' || (options as any).changeType === 'diversion_change';
    const isExtraRequired = !contract.isGlobal.value && isDiversionScenario;
    if (isExtraRequired) {
      reqEvidence.push(isRealSpec ? 'SERVER_API:EXTRA_DIVERSION' : 'FIXTURE:EXTRA_DIVERSION');
    }

    const deterministicAssertions: DeterministicAssertion[] = [];

    // 计费断言
    if (typeof expectedPoints === 'number' && contract.pricing.allowPass && contract.pricing.isPricingDetermined && terminalStatus !== 'UNKNOWN') {
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

    const resolvedReq = resolveRequirementTraceForSpec({
      requirementId: options.requirementId,
      requirementText: options.requirementText,
      requirement: options.requirement,
      changedPaths: options.changedPaths,
      traces: options.traces,
      testId,
    });

    canonicalSpec = {
      testId,
      requirementId: resolvedReq.requirementId,
      scenario: contract.scenario || 'VERIFY_ACCEPTANCE',
      environment,
      executionMode: isRealSpec ? 'REAL' : 'FIXTURE',
      target: {
        targetType: 'model',
        modelId,
        expectedChannelId: targetChannelId,
      },
      inputs: {
        taskId,
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
  let exportDelivery: {
    success: boolean;
    sinkName: string;
    recordId: string;
    error?: string;
  } | undefined;
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

  const isProcessing = Boolean((options as any).isProcessing) || options.terminalStatus === 'PROCESSING' || taskEvidence.status === 'PROCESSING';

  // 单向兼容投影为下游消费展示结构：仅传入生命周期展示上下文，严禁传入业务验收事实
  const displayContext: LegacyLifecycleContext = {
    terminalStatus,
    isProcessing,
    progress: (options as any).progress,
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
      fields: Array.from(new Set([
        ...regressionDiff.unexpectedChanges.map((u) => u.field),
        ...regressionDiff.observedChanges.map((o) => o.field),
      ])),
      details: regressionDiff.unexpectedChanges.map((u) => u.reason),
    };
  }

  const reportReasons: string[] = Array.from(new Set([...reasons, ...presentation.reasons]));
  if (acceptance === 'UNVERIFIED' || acceptance === 'BLOCKED') {
    if (!isDbExtraVerified) {
      reportReasons.push('[证据不足] 无法确认 extra 字段落库，需只读查询 /aivideo/v2/video/getEditData 或只读 DB 验证 extra.diversion=10 [MANUAL_DB_EVIDENCE_REQUIRED]');
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
    missingEvidence: isDbExtraVerified ? (regressionDiff?.missingEvidence || []) : ['MANUAL_DB_EVIDENCE_REQUIRED:extra.diversion', ...(regressionDiff?.missingEvidence || [])],
    evidenceStatus: {
      extraSnapshot: isDbExtraVerified ? 'VERIFIED' : 'MANUAL_DB_EVIDENCE_REQUIRED',
      taskStatus: taskEvidence.status === 'PASS' ? 'VERIFIED' : 'UNVERIFIED',
      mediaArtifact: mediaEvidence.status === 'PASS' ? 'VERIFIED' : 'UNVERIFIED',
      billingLedger: billingEvidence.status === 'PASS' ? 'VERIFIED' : 'UNVERIFIED',
    },
    manualVerificationGuide: {
      extraQuerySql: `SELECT id, extra, user_group_id, created_at FROM ai_tasks WHERE id = ${taskId} LIMIT 1;`,
      notice: isDbExtraVerified
        ? '已通过只读 HTTP API (/aivideo/v2/video/getEditData) 成功获取 extra 分流落库证据，无需手动查询数据库。'
        : '主站 HTTP 查询接口（/apiGetStatus 或常规任务详情接口）不返回 extra 字段。如需核实真实分流落库 (extra.diversion=10)，可优先通过只读 HTTP API (/aivideo/v2/video/getEditData) 或以只读权限查询 DB ai_tasks 表。',
    },
    regressionDiff,
    evidenceCompleteness,
  };

  const memoryCandidate = (presentation.status === 'FAILED' || presentation.verdict === 'FAIL' || businessValidation.matchedFailurePatterns.length > 0)
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
    ok: !sessionLoadError,
    passed: presentation.passed,
    taskId,
    modelId,
    mediaType,
    status: sessionLoadError ? 'ERROR' : presentation.status,
    verdict: presentation.verdict,
    acceptance,
    mode: session ? 'real' : 'mock',
    executionMode,
    progress: (options as any).progress ?? (taskEvidence as any).progress,
    probeDurationMs,
    artifact,
    billing,
    billingAudit: (billing && scoreLogsToReconcile && scoreLogsToReconcile.length > 0) ? 'AUDITED' : 'SKIPPED_NO_LOGS',
    invariants,
    evidence: { task: taskEvidence, media: mediaEvidence, billing: billingEvidence, invariants: invariantsEvidence, business: businessValidation },
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
    canonicalVerdict: canonicalResult,
    canonicalEnvelopes: envelopes,
    canonicalSpec,
    exportDelivery,
  };
}
