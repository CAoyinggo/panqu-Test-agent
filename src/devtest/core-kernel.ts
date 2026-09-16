import { existsSync } from 'node:fs';
import { EnvironmentProbe, discoverModelContract, parseChangeIntent, type EnvProbeReport } from './env-probe.js';
import {
  RoutingOracle,
  type MainSiteConfigSnapshot,
  type GatewayRoutingVerdict,
  type GatewayChannelConfig,
  type MainSiteRoutingVerdict,
} from './routing.js';
import { BillingOracle, type ScoreLogEntry, type BillingAuditReport } from './billing.js';
import { inspectMp4Buffer, inspectImageBuffer, type MediaInspectionResult } from './media-inspector.js';
import { submitMediaTask, pollTaskStatus, loadPanquSession, queryTaskBillingLogs, type PanquSession } from './media-flow.js';
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
} from './types.js';

export interface ProbeKernelOptions {
  env?: string; baseUrl?: string; gatewayUrl?: string; sessionFile?: string; mock?: boolean; timeoutMs?: number;
}
export interface ProbeKernelResult {
  ok: boolean; status: 'HEALTHY' | 'DEGRADED' | 'BLOCKED'; env: string; baseUrl: string; gatewayUrl: string;
  probedAt: string; auth: { status: 'VALID' | 'EXPIRED' | 'MISSING'; details: string; hasSession: boolean };
  endpoints: Array<{ name: string; url: string; reachable: boolean; statusCode?: number; latencyMs?: number; message: string }>;
  candidateChannelCount: number; recommendations: string[];
}

export async function probe(options: ProbeKernelOptions = {}): Promise<ProbeKernelResult> {
  const env = options.env || 'test';
  try {
    const r: EnvProbeReport = await EnvironmentProbe.probe({
      env: env as 'test' | 'preonline', baseUrl: options.baseUrl, gatewayUrl: options.gatewayUrl,
      sessionFile: options.sessionFile, mock: options.mock ?? false, timeoutMs: options.timeoutMs ?? 5000,
    });
    return {
      ok: r.ok, status: r.status, env: r.env, baseUrl: r.baseUrl, gatewayUrl: r.gatewayUrl,
      probedAt: r.probedAt, auth: r.auth, endpoints: r.endpoints,
      candidateChannelCount: r.modelReadiness?.candidateChannelCount ?? 2, recommendations: r.recommendations,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false, status: 'BLOCKED', env, baseUrl: options.baseUrl || 'https://unknown',
      gatewayUrl: options.gatewayUrl || 'https://unknown', probedAt: new Date().toISOString(),
      auth: { status: 'MISSING', details: msg, hasSession: false }, endpoints: [], candidateChannelCount: 0,
      recommendations: [`探活异常: ${msg}`],
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
  pricingStatus: 'DETERMINED' | 'MANUAL_REQUIRED';
  missingInputs?: string[];
  acceptanceForecast?: AcceptanceResult;
  testerActionSummary?: {
    automatedSummary: string[];
    skippedSummary: string[];
    manualRequiredSummary: string[];
    nextStep: string;
  };
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
  const modelId = options.modelId ?? intent?.modelId ?? 84;
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

  const duration = options.duration ?? contract.supportedDurations?.value?.[0] ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? contract.supportedResolutions.value[0] ?? (mediaType === 'video' ? '720p' : '1k');
  const expectedPoints = BillingOracle.calculateExpectedPoints({
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
  const channels: GatewayChannelConfig[] = options.channels || (mainVerdict.willDivert
    ? [{ id: 1, name: `${targetModel}主渠道`, group: targetGroup, models: [targetModel], status: 1, weight: 100, dailyQuotaLimit: 0, usedQuota: 0 }]
    : []);

  const gwVerdict = RoutingOracle.evaluateGatewayRouting(targetGroup, targetModel, expectedPoints, channels);
  const testPlan = generateDynamicTestPlan(contract, options, mainVerdict, gwVerdict, expectedPoints);

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

  const acceptanceForecast: AcceptanceResult = missingInputs.length > 0 ? 'BLOCKED' : 'UNVERIFIED';

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
    pricingStatus: contract.pricing.isPricingDetermined ? 'DETERMINED' : 'MANUAL_REQUIRED',
    missingInputs,
    acceptanceForecast,
    testerActionSummary: testPlan.testerActionSummary,
  };
}

export interface ExecuteKernelOptions {
  modelId: number; mediaType: 'video' | 'image'; resolution?: string; duration?: number;
  aspectRatio?: string; mode?: 'mock' | 'real'; prompt?: string; sessionFile?: string;
  env?: 'test' | 'preonline'; serviceline?: string;
  contract?: DiscoveredModelContract;
  flow?: string;
  flowType?: 'direct' | 'diversion';
  customPoints?: number;
  pointsPerSecond?: number;
  price?: number;
}
export interface ExecuteKernelResult {
  ok: boolean; taskId: number; simulationId?: string; isSimulated?: boolean; mode: 'mock' | 'real'; modelId: number; mediaType: 'video' | 'image';
  status: 'SUBMITTED' | 'SUCCESS' | 'FAILED' | 'ERROR' | 'BLOCKED'; points: number; message: string;
  credentialsMasked?: string; rawResponse?: Record<string, unknown>;
}

export async function execute(options: ExecuteKernelOptions): Promise<ExecuteKernelResult> {
  const { modelId, mediaType } = options;
  const mode = options.mode === 'real' ? 'real' : 'mock';
  const customPoints = options.customPoints ?? (mediaType === 'image' && options.price !== undefined ? options.price : undefined);
  const pointsPerSecond = options.pointsPerSecond ?? (mediaType === 'video' && options.price !== undefined ? options.price : undefined);

  const contract = options.contract ?? discoverModelContract(modelId, mediaType, {
    resolution: options.resolution,
    duration: options.duration,
    customPoints,
    pointsPerSecond,
    price: options.price,
  });

  const duration = options.duration ?? contract.supportedDurations?.value?.[0] ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? contract.supportedResolutions.value[0] ?? (mediaType === 'video' ? '720p' : '1k');

  if (!contract.pricing.allowPass) {
    return {
      ok: false,
      taskId: 0,
      mode,
      modelId,
      mediaType,
      status: 'BLOCKED',
      points: 0,
      message: `模型 #${modelId} 刊例定价未确定 (${contract.pricing.source})，拒绝伪造定价执行任务 [BLOCKED / MANUAL_REQUIRED]。请通过 --price 或 --points-per-second 显式提供真实单价。`,
    };
  }

  const points = BillingOracle.calculateExpectedPoints({
    mediaType,
    modelId,
    duration,
    resolution,
    customPoints: customPoints ?? contract.pricing.customPoints?.value,
    pointsPerSecond: pointsPerSecond ?? contract.pricing.pointsPerSecond?.value,
  });
  if (mode === 'real') {
    if (!options.sessionFile) {
      return { ok: false, taskId: 0, mode: 'real', modelId, mediaType, status: 'ERROR', points, message: '真实执行必须提供有效的 sessionFile 会话凭据文件' };
    }
    try {
      const session = await loadPanquSession(options.sessionFile, options.env || 'test');
      const res = await submitMediaTask({
        baseUrl: session.base_url, cookies: session.cookie_string, csrfToken: session.csrf_token,
        projectId: session.project_id, mediaType, modelId, prompt: options.prompt, resolution,
        aspectRatio: options.aspectRatio, duration, serviceline: options.serviceline,
      });
      return {
        ok: res.ok, taskId: res.taskId, mode: 'real', modelId, mediaType, status: res.ok ? 'SUBMITTED' : 'FAILED',
        points, message: res.ok ? `真实${mediaType === 'video' ? '视频' : '图片'}任务提交成功 (taskId: #${res.taskId})` : res.message,
        credentialsMasked: session.cookie_string.replace(/=[^;]+/g, '=***'), rawResponse: res.rawResponse,
      };
    } catch (err) {
      return { ok: false, taskId: 0, mode: 'real', modelId, mediaType, status: 'ERROR', points, message: `提交异常: ${err instanceof Error ? err.message : String(err)}`, };
    }
  }
  const simulatedTaskId = 29000 + Math.floor(Math.random() * 1000);
  const simulationId = `sim-offline-${Date.now().toString(36)}-${simulatedTaskId}`;
  return {
    ok: true, taskId: simulatedTaskId, simulationId, isSimulated: true, mode: 'mock', modelId, mediaType, status: 'SUBMITTED', points,
    message: `[OFFLINE 离线仿真] 仅生成离线模拟 ID (${simulationId})，未向主站发起真实请求 (模拟任务 ID #${simulatedTaskId}，预扣 ${points} 积分)`,
    credentialsMasked: 'PHPSESSID=***; session_env=mock_test',
  };
}

async function fetchFirst64K(url: string, timeoutMs = 8000): Promise<{ buffer: Buffer; durationMs: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-65535', 'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0' }, signal: ctrl.signal });
    if (!res.ok && res.status !== 206) return null;
    const arrayBuf = await res.arrayBuffer();
    let buf = Buffer.from(arrayBuf);
    if (res.status === 200) {
      if (buf.length > 65536) {
        const head = buf.subarray(0, 65536);
        const tail = buf.subarray(Math.max(0, buf.length - 65536));
        (head as any).tailBuffer = tail;
        buf = head;
      }
      return { buffer: buf, durationMs: Date.now() - start };
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
          const tailBuf = Buffer.from(await tailRes.arrayBuffer());
          (headBuf as any).tailBuffer = tailBuf;
        }
      } catch {
        // 保留 headBuf 继续走既有 fail-closed 校验
      }
    }
    return { buffer: headBuf, durationMs: Date.now() - start };
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
}

export interface VerifyKernelOptions {
  taskId: number; modelId?: number; mediaType?: 'video' | 'image'; scoreLogs?: ScoreLogEntry[];
  expectedPoints?: number; assetBuffer?: Buffer; artifactBuffer?: Buffer; terminalStatus?: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN';
  resolution?: string; duration?: number; sessionFile?: string; env?: 'test' | 'preonline';
  baseUrl?: string; cookies?: string; videoUrl?: string; imageUrl?: string; pollTimeoutSec?: number;
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
  unconfirmedStatic?: boolean;
  customPoints?: number;
  pointsPerSecond?: number;
  price?: number;
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
  const autoSession = options.sessionFile || process.env.PANQU_SESSION_COOKIES_FILE || (existsSync('session.json') ? 'session.json' : existsSync('.panqu/session.json') ? '.panqu/session.json' : undefined);
  if (options.sessionFile) {
    try { session = await loadPanquSession(options.sessionFile, options.env || 'test'); }
    catch (err) {
      const msg = `加载凭据失败: ${err instanceof Error ? err.message : String(err)}`;
      const requiredEvidence = ['taskTerminalStatus', 'mediaArtifactDecodable', 'billingLedgerReconciled', 'pricingDetermined', 'diversionDbExtra'];
      const completeness: EvidenceCompleteness = {
        requiredEvidence,
        availableEvidence: [],
        missingEvidence: ['sessionCredentials', ...requiredEvidence],
        isComplete: false,
      };
      const acceptanceReport: ProductionAcceptanceReport = {
        scenario: contract.scenario,
        acceptance: 'BLOCKED',
        verified: [],
        unverified: requiredEvidence,
        manualEvidenceRequired: ['sessionCredentials'],
        unexpectedChanges: [],
        reasons: [msg],
        summaryText: `[BLOCKED] ${msg}`,
      };
      return {
        ok: false, passed: false, taskId, modelId, mediaType, status: 'ERROR', verdict: 'FAIL',
        acceptance: 'BLOCKED',
        mode: 'real', executionMode: 'real', billingAudit: 'SKIPPED_NO_LOGS',
        evidence: {
          task: { status: 'FAIL', source: 'session_error', error: msg },
          media: { status: 'UNVERIFIED', source: 'missing_session', ownership: 'UNVERIFIED', reason: msg },
          billing: { status: 'UNVERIFIED', source: 'missing_session', expectedPoints, expectedChargeSource, reason: msg },
          invariants: { status: 'UNVERIFIED', reason: msg },
        },
        reasons: [msg],
        contract,
        evidenceCompleteness: completeness,
        acceptanceReport,
      };
    }
  } else if (autoSession) {
    try { session = await loadPanquSession(autoSession, options.env || 'test'); } catch { /* ignore auto session */ }
  } else if (options.cookies && options.baseUrl) {
    session = { env: options.env || 'test', base_url: options.baseUrl, cookie_string: options.cookies };
  }

  const executionMode: 'real' | 'offline' | 'fixture' = options.isSimulated
    ? 'offline'
    : session
    ? 'real'
    : ((options.scoreLogs && options.scoreLogs.length > 0) || Boolean(options.assetBuffer || options.artifactBuffer))
    ? 'fixture'
    : 'offline';

  let artifactBuffer = options.assetBuffer ?? options.artifactBuffer;
  let probeDurationMs: number | undefined;
  let terminalStatus: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN';
  let taskEvidence: TaskEvidence;
  let mediaArtifactSource = artifactBuffer ? 'FIXTURE_BUFFER' : 'missing_buffer';
  let artifactOwnership: 'VERIFIED' | 'UNVERIFIED' = options.artifactOwnership === 'UNVERIFIED' || options.artifactOwnership === 'UNBOUND' ? 'UNVERIFIED' : 'VERIFIED';

  if (session) {
    const { finalSnapshot } = await pollTaskStatus(taskId, { baseUrl: session.base_url, cookies: session.cookie_string, mediaType, pollTimeoutSec: options.pollTimeoutSec ?? 10 });
    if (finalSnapshot.taskStatus === 1) {
      const msg = `任务 #${taskId} 仍在排队/生成中 (进度: ${finalSnapshot.progress}%)，未到达终态`;
      const requiredEvidence = ['taskTerminalStatus', 'mediaArtifactDecodable', 'billingLedgerReconciled', 'pricingDetermined', 'diversionDbExtra'];
      const completeness: EvidenceCompleteness = {
        requiredEvidence,
        availableEvidence: [],
        missingEvidence: ['taskTerminalStatus', 'mediaArtifactDecodable', 'billingLedgerReconciled', 'diversionDbExtra'],
        isComplete: false,
      };
      const acceptanceReport: ProductionAcceptanceReport = {
        scenario: contract.scenario,
        acceptance: 'BLOCKED',
        verified: [],
        unverified: requiredEvidence,
        manualEvidenceRequired: ['taskCompletion'],
        unexpectedChanges: [],
        reasons: [msg],
        summaryText: `[BLOCKED] ${msg}`,
      };
      return {
        ok: true, passed: false, taskId, modelId, mediaType, status: 'PROCESSING', verdict: 'PROCESSING',
        acceptance: 'BLOCKED',
        progress: finalSnapshot.progress, mode: 'real', executionMode: 'real', billingAudit: 'SKIPPED_NO_LOGS',
        evidence: {
          task: { status: 'PROCESSING', source: 'live_polling', terminalStatus: 'UNKNOWN', taskStatus: 1, progress: finalSnapshot.progress },
          media: { status: 'UNVERIFIED', source: 'in_flight', ownership: 'UNVERIFIED', reason: '任务生成中，尚无产物' },
          billing: { status: 'UNVERIFIED', source: 'in_flight', expectedPoints, expectedChargeSource, reason: '任务生成中，终态账单未对账' },
          invariants: { status: 'UNVERIFIED', reason: '任务未到达终态' },
        },
        reasons: [msg],
        contract,
        evidenceCompleteness: completeness,
        acceptanceReport,
      };
    }
    if (finalSnapshot.taskStatus === 3 || finalSnapshot.taskStatus === 4) {
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
          if (probeRes) { artifactBuffer = probeRes.buffer; probeDurationMs = probeRes.durationMs; }
        }
      }
    } else {
      terminalStatus = 'UNKNOWN';
      taskEvidence = { status: 'UNVERIFIED', source: 'task_not_found', terminalStatus: 'UNKNOWN', taskStatus: 0, error: `未能从主站获取到任务 #${taskId} 状态 (任务不存在或超时) [UNVERIFIED]`, progress: 0 };
      if ((options.videoUrl || options.imageUrl) && !artifactBuffer) {
        mediaArtifactSource = 'EXTERNAL_URL';
        artifactOwnership = options.artifactOwnership === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED';
        const probeRes = await fetchFirst64K(options.videoUrl || options.imageUrl!);
        if (probeRes) { artifactBuffer = probeRes.buffer; probeDurationMs = probeRes.durationMs; }
      }
    }
  } else {
    if (options.terminalStatus) {
      terminalStatus = options.terminalStatus;
      taskEvidence = { status: terminalStatus === 'FAILED' ? 'FAIL' : terminalStatus === 'SUCCESS' ? 'PASS' : 'UNVERIFIED', source: 'provided', terminalStatus };
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
        if (probeRes) { artifactBuffer = probeRes.buffer; probeDurationMs = probeRes.durationMs; }
      }
    } else if (artifactBuffer) {
      mediaArtifactSource = options.artifactOwnership === 'UNVERIFIED' || options.artifactOwnership === 'UNBOUND' ? 'EXTERNAL_BUFFER' : 'FIXTURE_BUFFER';
    }
  }

  const artifact = artifactBuffer ? (mediaType === 'video' ? inspectMp4Buffer(artifactBuffer) : inspectImageBuffer(artifactBuffer)) : undefined;
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
    const skipReason = billingQueryError
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

  const isDbExtraVerified = Boolean(options.dbExtraConfirmed || options.dbExtra);
  const isGatewayChannelRequired = mediaType === 'video' && contract.routing.value.willDivert;
  const isGatewayChannelVerified = Boolean(options.gatewayChannelConfirmed || (options.channels && options.channels.length > 0));

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

  const reasons: string[] = [];
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

  const hasFailures = taskEvidence.status === 'FAIL'
    || mediaEvidence.status === 'FAIL'
    || billingEvidence.status === 'FAIL'
    || invariantsEvidence.status === 'FAIL'
    || Boolean(regressionDiff?.isRegression)
    || contract.conflicts.length > 0;

  const allPassed = taskEvidence.status === 'PASS'
    && mediaEvidence.status === 'PASS'
    && billingEvidence.status === 'PASS'
    && invariantsEvidence.status === 'PASS'
    && !regressionDiff?.isRegression
    && contract.pricing.allowPass
    && contract.conflicts.length === 0;

  let verdictStatus: 'SUCCESS' | 'FAILED' | 'UNVERIFIED';
  let verdict: 'PASS' | 'FAIL' | 'UNVERIFIED';

  if (hasFailures) {
    verdictStatus = 'FAILED';
    verdict = 'FAIL';
  } else if (allPassed) {
    verdictStatus = 'SUCCESS';
    verdict = 'PASS';
  } else {
    verdictStatus = 'UNVERIFIED';
    verdict = 'UNVERIFIED';
  }

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
      actual: isDbExtraVerified ? (options.dbExtra ? JSON.stringify(options.dbExtra) : 'CONFIRMED_VIA_READONLY_QUERY') : 'NOT_RETURNED_BY_HTTP_API (MANUAL_DB_EVIDENCE_REQUIRED)',
      matched: isDbExtraVerified,
      status: isDbExtraVerified ? 'PASS' : 'MANUAL_REQUIRED',
      diff: isDbExtraVerified ? 'MATCH' : 'HTTP API 不返回 extra 字段，需以只读权限查询 DB 验证落库',
      critical: false,
      evidence: isDbExtraVerified ? 'DB_READONLY_QUERY' : 'MANUAL_DB_EVIDENCE_REQUIRED',
    },
  ];

  if (isGatewayChannelRequired) {
    diffItems.push({
      field: 'gatewayChannel',
      layer: 'routing',
      expected: 'NewAPI upstream channel configured',
      actual: isGatewayChannelVerified ? (options.channels ? `${options.channels.length} channel(s)` : 'CONFIRMED') : 'MISSING_GATEWAY_CHANNEL_EVIDENCE',
      matched: isGatewayChannelVerified,
      status: isGatewayChannelVerified ? 'PASS' : 'MANUAL_REQUIRED',
      diff: isGatewayChannelVerified ? 'MATCH' : '缺少 NewAPI 网关上游通道确认证据 [MANUAL_GATEWAY_CHANNEL_REQUIRED]',
      critical: true,
      evidence: isGatewayChannelVerified ? 'GATEWAY_API' : 'MANUAL_REQUIRED',
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

  // 生产验收最终裁决判定
  let acceptance: AcceptanceResult;
  if (hasFailures || (regressionDiff && regressionDiff.isRegression) || contract.conflicts.length > 0) {
    acceptance = 'REJECTED';
  } else if (
    !contract.pricing.allowPass ||
    !contract.pricing.isPricingDetermined ||
    contract.pricing.source === 'SOURCE_DEFAULT_FALLBACK' ||
    (taskEvidence.status === 'FAIL' && taskEvidence.source === 'session_error') ||
    options.unconfirmedStatic ||
    terminalStatus === 'UNKNOWN'
  ) {
    acceptance = 'BLOCKED';
  } else if (allPassed && isComplete && !regressionDiff?.isRegression && contract.pricing.allowPass && contract.conflicts.length === 0) {
    acceptance = 'ACCEPTED';
  } else {
    acceptance = 'UNVERIFIED';
  }

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

  const reportReasons: string[] = [...reasons];
  if (acceptance === 'UNVERIFIED') {
    if (!isDbExtraVerified) {
      reportReasons.push('[证据不足] HTTP API 无法确认 extra 字段落库，需 DB 只读查询验证 extra.diversion=10 [MANUAL_DB_EVIDENCE_REQUIRED]');
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
    matched: allCriticalMatched,
    allMatched: allCriticalMatched,
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
      notice: '主站 HTTP 查询接口（/apiGetStatus 或任务详情接口）不返回 extra 字段。如需核实真实分流落库 (extra.diversion=10)，请以只读权限查询 DB ai_tasks 表。',
    },
    regressionDiff,
    evidenceCompleteness,
  };

  return {
    ok: true,
    passed: verdictStatus === 'SUCCESS',
    taskId,
    modelId,
    mediaType,
    status: verdictStatus,
    verdict,
    acceptance,
    mode: session ? 'real' : 'mock',
    executionMode,
    probeDurationMs,
    artifact,
    billing,
    billingAudit: (billing && scoreLogsToReconcile && scoreLogsToReconcile.length > 0) ? 'AUDITED' : 'SKIPPED_NO_LOGS',
    invariants,
    evidence: { task: taskEvidence, media: mediaEvidence, billing: billingEvidence, invariants: invariantsEvidence },
    evidenceCompleteness,
    reasons: reportReasons,
    expectedVsActual,
    acceptanceReport,
    contract,
  };
}
