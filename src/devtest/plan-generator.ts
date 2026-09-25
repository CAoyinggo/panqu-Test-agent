/**
 * Panqu AI DevTest · Plan Generator (计划生成器)
 *
 * 承载 plan 动作的输入契约 (PlanKernelOptions) 与动态测试计划生成纯函数
 * (generateDynamicTestPlan)。由 core-kernel 单向 import 并对外 re-export，
 * 保持 probe/plan/execute/verify 四大动作公共导出面零变化。
 *
 * 架构约束 (见 docs/ARCHITECTURE_FREEZE.md §2.2 Phase 4 授权)：
 * - 仅做行为等价的物理搬迁，不新增任何中间层/包装层；
 * - 仅单向向下依赖 (routing/types/domain-knowledge/requirement-trace)，严禁反向 import core-kernel。
 */

import type {
  MainSiteConfigSnapshot,
  GatewayChannelConfig,
  MainSiteRoutingVerdict,
  GatewayRoutingVerdict,
} from './routing.js';
import type {
  ChangeScenario,
  TargetKind,
  DiscoveredModelContract,
  TestCasePlan,
  TestPlan,
  TestPlanBlockedItem,
  DiversionBaseline,
} from './types.js';
import type { Experience } from './domain-knowledge.js';
import type { RequirementTrace } from './requirement-trace.js';
import type { RouteRules, GroupedRouteRules, RouteMode } from './newapi-route-eligibility.js';
import type { DiversionPrediction } from './diversion-context.js';

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
  // 分流预测接地（opt-in）：提供 line=10 路由规则时，plan 的分流预期改由资格引擎按真实规则算，而非场景假设。
  routeRules?: RouteRules | null;
  groupRules?: GroupedRouteRules | null;
  routeMode?: RouteMode;
  routeGroup?: { newapi_group: string; usable: boolean } | null;
}

export function generateDynamicTestPlan(
  contract: DiscoveredModelContract,
  options: PlanKernelOptions,
  mainVerdict: MainSiteRoutingVerdict,
  gwVerdict: GatewayRoutingVerdict,
  expectedPoints: number,
  diversionPrediction?: DiversionPrediction,
): TestPlan {
  const scenario = contract.scenario;
  // 接地分流预测（仅当基于真实 line=10 路由规则）：用于把分流场景的 willDivert/decision/line
  // 从"场景假设"改为"按真实规则计算"。未接地(无规则)时为 undefined，保持既有场景默认，杜绝破坏离线行为。
  const grounded = diversionPrediction?.provenance === 'GROUNDED_ROUTE_RULES' ? diversionPrediction : undefined;
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

  const res =
    options.resolution || contract.supportedResolutions.value[0] || (contract.mediaType === 'video' ? '720p' : '1k');
  const dur =
    options.duration || contract.supportedDurations?.value?.[0] || (contract.mediaType === 'video' ? 4 : undefined);

  if (scenario === 'IMAGE_NEW_MODEL') {
    tests.push({
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
    });

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
        skipReason: contract.pricing.isPricingDetermined
          ? undefined
          : '真实刊例单价缺失，账务对账已阻断 (BLOCKED / MANUAL_REQUIRED)',
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
        skipReason: contract.pricing.isPricingDetermined
          ? undefined
          : '真实刊例单价缺失，账务对账已阻断 (BLOCKED / MANUAL_REQUIRED)',
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
        expected: grounded
          ? {
              willDivert: grounded.willDivert,
              decision: grounded.decision,
              line: grounded.line,
              newapiModel: contract.alias.value,
            }
          : { willDivert: true, decision: 'NEWAPI_IMAGE', line: 10, newapiModel: contract.alias.value },
        requiredEvidence: ['routing_decision', 'expectedSnapshot'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded: contract.isGlobal.value
            ? '验证全量开放生图模型命中全局分流'
            : '验证非全量生图模型命中组织路由组分流',
          riskAddressed: '防范分流切流规则未生效或配置遗漏',
        },
      },
      {
        id: 'gateway-candidate',
        layer: 'routing',
        purpose: 'NewAPI 网关上游渠道加权调度候选与每日配额校验',
        input: {
          tokenGroup: mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test',
          targetModel: contract.alias.value,
          expectedPoints,
        },
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
        skipReason: contract.pricing.isPricingDetermined
          ? undefined
          : '真实刊例单价缺失，账务对账已阻断 (BLOCKED / MANUAL_REQUIRED)',
        rationale: {
          whyIncluded: '核验证明新增分流未破坏原有防重复扣费与退款幂等',
          riskAddressed: '防范切流后计费规则篡改或重扣',
        },
      },
    );
    expectedEvidence.push(
      'taskId',
      'taskStatus',
      'imageUrl',
      'png_ihdr',
      'scoreLogs',
      'MANUAL_DB_EVIDENCE_REQUIRED:extra.newapi_image=1',
    );

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
    tests.push({
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
    });

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
        expected: {
          willDivert: true,
          decision: 'NEWAPI_GLOBAL',
          line: 10,
          orgId: 0,
          newapiModel: contract.alias.value,
        },
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
        expected: grounded
          ? { willDivert: grounded.willDivert, decision: grounded.decision, line: grounded.line }
          : { willDivert: true, decision: 'NEWAPI_ORG_GROUP', line: 10 },
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
      input: {
        tokenGroup: mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test',
        targetModel: contract.alias.value,
        expectedPoints,
      },
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
        purpose:
          contract.fallback.value.action === 'VOLCENGINE_RETRY_QUEUE'
            ? 'Seedance 模型分流失败自动派发至火山重试队列并标记 is_need_fallback=1'
            : `模型 #${contract.modelId} 属于非 Seedance 系列，分流失败直接报错中断，严禁进入重试列表`,
        input: { modelId: contract.modelId },
        expected:
          contract.fallback.value.action === 'VOLCENGINE_RETRY_QUEUE'
            ? { fallbackAction: 'VOLCENGINE_RETRY_QUEUE', recordRetryLog: true }
            : { fallbackAction: 'DIRECT_FAIL_NO_RETRY', recordRetryLog: false },
        requiredEvidence: ['fallback_verdict'],
        executionMode: 'plan_only',
        status: 'READY',
        rationale: {
          whyIncluded:
            contract.fallback.value.action === 'VOLCENGINE_RETRY_QUEUE'
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
        skipReason: contract.pricing.isPricingDetermined
          ? undefined
          : '真实刊例单价缺失，账务对账已阻断 (BLOCKED / MANUAL_REQUIRED)',
        rationale: {
          whyIncluded: '积分对账与三大账务不变量核验，证明分流未破坏原有防重复扣费',
          riskAddressed: '防范分流导致重复扣费、失败漏退等重大资损',
        },
      },
    );
    expectedEvidence.push(
      'taskId',
      'taskStatus',
      'videoUrl',
      'mp4_box_tree',
      'scoreLogs',
      'MANUAL_DB_EVIDENCE_REQUIRED:extra.diversion=10',
    );

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
        : '底层落库核验: 执行 SQL `SELECT extra FROM pq_aivideo_goods WHERE id = <taskId>;`（图片按模式亦可能在 character/scene/fusion）确认 extra.newapi_image=1',
    );
  } else {
    if (contract.mediaType === 'video') {
      manualRequiredSummary.push(
        '物理产物核验: 抽检任务产物 MP4 Box 结构（moov/mdat 原子完整性）及 OSS 归档存储下载可用性',
      );
    } else {
      manualRequiredSummary.push('物理产物核验: 抽检生图产物 PNG IHDR 头物理尺寸完整性及 OSS 归档存储');
    }
  }

  let nextStep = '';
  if (blocked.length > 0) {
    nextStep = `先补充缺失事实 (${blocked.map((b) => b.missingField || b.field).join(', ')})，然后再执行真实任务`;
  } else {
    const videoParams =
      contract.mediaType === 'video' ? ` --resolution ${res}${dur !== undefined ? ` --duration ${dur}` : ''}` : '';
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
