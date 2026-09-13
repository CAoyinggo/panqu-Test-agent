/**
 * 业务变更影响分析器（Business Change Impact Analyzer）
 *
 * 核心升级（超越粗暴文件名正则）：
 * 基于 Feature Model、业务实体规则、API 映射关系、Oracle 依赖与 Acceptance 契约。
 *
 * 核心能力：
 * 1. 准确推导受影响业务领域（VIDEO, IMAGE, DIVERSION, BILLING, REFUND）
 * 2. 映射底层 API 与入参（如 /aivideo/videonew/index, task_type=28, model_id=84）
 * 3. 激活对应 Oracle 集合（RoutingOracle, BillingOracle, SupplierCostOracle, MediaInspector 等）
 * 4. 风险驱动的用例自主裁剪与扩充（高风险扩展逆向/降级用例，低风险文案裁剪重型 E2E）
 * 5. 结合历史执行画像进行优先级加权
 */

import {
  BUSINESS_CAPABILITY_REGISTRY,
  getCapabilityByModel,
  validateBusinessCombination,
  type BusinessCapabilitySpec,
  type MediaType,
} from './business-capability-knowledge.js';
import { assessHistoricalFragility } from './historical-execution-feedback.js';
import type { DevTestFeatureModel } from './types.js';

export type BusinessDomain = 'VIDEO' | 'IMAGE' | 'DIVERSION' | 'BILLING' | 'REFUND';

export type TestScenarioKind =
  | 'MAIN_FLOW'
  | 'ROUTING_GUARD'
  | 'FAILURE_REFUND'
  | 'BILLING_CONSISTENCY'
  | 'FALLBACK_RETRY'
  | 'INVALID_COMBINATION';

export interface RecommendedScenario {
  id: string;
  title: string;
  kind: TestScenarioKind;
  targetModelId: number;
  mediaType: MediaType;
  riskWeight: number; // 1 ~ 100
  requiredEvidence: string[];
  description: string;
  historicalFragility?: boolean;
}

export interface AffectedApiSpec {
  method: string;
  path: string;
  operationKey: string;
  keyParameters: string[];
  description: string;
}

export type RequiredOracle =
  | 'RoutingOracle'
  | 'BillingOracle'
  | 'SupplierCostOracle'
  | 'MediaInspector'
  | 'Traceability'
  | 'IdempotencyOracle';

export interface ChangeImpactAnalysisInput {
  requirementText?: string;
  codeDiff?: string;
  changedFiles?: string[];
  featureModel?: DevTestFeatureModel;
}

export interface ChangeImpactAnalysisResult {
  affectedDomains: BusinessDomain[];
  affectedCapabilities: BusinessCapabilitySpec[];
  affectedApis: AffectedApiSpec[];
  activatedOracles: RequiredOracle[];
  riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  riskFactors: string[];
  prunedCategories: string[];
  recommendedScenarios: RecommendedScenario[];
  mandatoryEvidence: string[];
  reasons: string[];
}

/**
 * 变更影响分析核心入口
 */
export function analyzeChangeImpact(input: ChangeImpactAnalysisInput): ChangeImpactAnalysisResult {
  const corpus = [
    input.requirementText ?? '',
    input.codeDiff ?? '',
    (input.changedFiles ?? []).join(' '),
    input.featureModel ? JSON.stringify(input.featureModel) : '',
  ].join('\n').toLowerCase();

  const reasons: string[] = [];
  const affectedDomains = new Set<BusinessDomain>();
  const activatedOracles = new Set<RequiredOracle>(['Traceability']); // 全链路始终需要 Traceability
  const riskFactors: string[] = [];
  const prunedCategories: string[] = [];
  const targetCapabilities = new Set<BusinessCapabilitySpec>();

  // 1. 业务领域与模型实体命中分析
  const hasVideoKeywords = /(wan|video|视频|videonew|84|88|seedance|ep-m-|mp4|fps|resolution|task_type)/i.test(corpus);
  const hasImageKeywords = /(image|生图|图片|scene|runninghub|nano.banana|banana|201|12|serviceline)/i.test(corpus);
  const hasDiversionKeywords = /(diversion|分流|newapi|line.?10|万相|火山|volcengine|fallback|兜底|重试|retrylog|channel|503)/i.test(corpus);
  const hasBillingKeywords = /(billing|score|point|积分|充值|扣除|扣费|计费|毛利|成本|supplier.?cost|定价|单价)/i.test(corpus);
  const hasRefundKeywords = /(refund|退款|失败|全额退|回退|rollback|safe)/i.test(corpus);

  if (hasVideoKeywords) {
    affectedDomains.add('VIDEO');
    activatedOracles.add('MediaInspector');
    reasons.push('检测到视频生成相关特征（Wan / Seedance / VideoNew）');
    if (/88|prime/i.test(corpus)) {
      targetCapabilities.add(BUSINESS_CAPABILITY_REGISTRY.WAN_3_0_PRIME);
    } else if (/seedance|15|41/i.test(corpus)) {
      targetCapabilities.add(BUSINESS_CAPABILITY_REGISTRY.SEEDANCE_2_0);
    } else {
      targetCapabilities.add(BUSINESS_CAPABILITY_REGISTRY.WAN_3_0);
    }
  }

  if (hasImageKeywords) {
    affectedDomains.add('IMAGE');
    activatedOracles.add('MediaInspector');
    reasons.push('检测到图片生成相关特征（RunningHub / Scene / Image）');
    if (/201|runninghub|nano/i.test(corpus)) {
      targetCapabilities.add(BUSINESS_CAPABILITY_REGISTRY.RUNNINGHUB_NANO_BANANA_2);
    } else {
      targetCapabilities.add(BUSINESS_CAPABILITY_REGISTRY.PAN_BANANA_PRO);
    }
  }

  if (hasDiversionKeywords) {
    affectedDomains.add('DIVERSION');
    activatedOracles.add('RoutingOracle');
    reasons.push('检测到分流与路由规则相关特征（NewAPI / 渠道切换 / 兜底降级）');
    if (/retry|重试|fallback|503/i.test(corpus)) {
      activatedOracles.add('IdempotencyOracle');
    }
  }

  if (hasBillingKeywords) {
    affectedDomains.add('BILLING');
    activatedOracles.add('BillingOracle');
    activatedOracles.add('SupplierCostOracle');
    reasons.push('检测到账单扣费、积分流水或供应商成本核对需求');
  }

  if (hasRefundKeywords) {
    affectedDomains.add('REFUND');
    activatedOracles.add('BillingOracle');
    reasons.push('检测到任务失败退款与资金回滚逻辑');
  }

  // 默认兜底：若未识别具体模型，默认覆盖主打视频 Wan 3.0
  if (!targetCapabilities.size) {
    targetCapabilities.add(BUSINESS_CAPABILITY_REGISTRY.WAN_3_0);
    affectedDomains.add('VIDEO');
    activatedOracles.add('RoutingOracle');
    activatedOracles.add('BillingOracle');
    activatedOracles.add('MediaInspector');
  }

  // 2. 底层 API 与参数映射推导
  const affectedApis: AffectedApiSpec[] = [];
  if (affectedDomains.has('VIDEO')) {
    affectedApis.push({
      method: 'POST',
      path: '/aivideo/videonew/index',
      operationKey: 'POST /aivideo/videonew/index',
      keyParameters: ['model_id', 'task_type', 'prompt', 'duration', 'resolution'],
      description: '视频生成任务提交入口（支持 Wan 3.0 task_type=28/105 分流）',
    });
    affectedApis.push({
      method: 'POST',
      path: '/aivideo/v2/task_status/apiGetStatus',
      operationKey: 'POST /aivideo/v2/task_status/apiGetStatus',
      keyParameters: ['task_id'],
      description: '异步任务生命周期与终态轮询接口',
    });
  }

  if (affectedDomains.has('IMAGE')) {
    affectedApis.push({
      method: 'POST',
      path: '/aivideo/scene/add',
      operationKey: 'POST /aivideo/scene/add',
      keyParameters: ['model_id', 'serviceline', 'prompt', 'resolution'],
      description: '生图任务提交入口（支持 RunningHub extra.newapi_image 分流）',
    });
    if (!affectedApis.some((a) => a.path.includes('task_status'))) {
      affectedApis.push({
        method: 'POST',
        path: '/aivideo/v2/task_status/apiGetStatus',
        operationKey: 'POST /aivideo/v2/task_status/apiGetStatus',
        keyParameters: ['task_id'],
        description: '生图任务状态追踪接口',
      });
    }
  }

  if (affectedDomains.has('DIVERSION')) {
    affectedApis.push({
      method: 'POST',
      path: '/aivideo/diversion/retrylog',
      operationKey: 'POST /aivideo/diversion/retrylog',
      keyParameters: ['task_id', 'from_channel', 'to_channel', 'error_code'],
      description: '分流失败与重试兜底流水查询接口',
    });
  }

  if (affectedDomains.has('BILLING') || affectedDomains.has('REFUND')) {
    affectedApis.push({
      method: 'POST',
      path: '/general/pay/getconfig',
      operationKey: 'POST /general/pay/getconfig',
      keyParameters: ['platform'],
      description: '充值档位与赠送积分规则配置接口',
    });
  }

  // 3. 风险评估与用例自主裁剪/扩充决策 (Risk-Driven Selection)
  const isPureCosmeticOrCopy = /(文案|提示语|placeholder|描述修改|css|样式|padding|颜色|color|style|icon|typo)/i.test(corpus)
    && !hasDiversionKeywords
    && !hasBillingKeywords
    && !/(api|sql|table|schema|controller|model|router|state|status)/i.test(corpus);

  let riskLevel: ChangeImpactAnalysisResult['riskLevel'] = 'MEDIUM';

  if (isPureCosmeticOrCopy) {
    riskLevel = 'LOW';
    riskFactors.push('仅涉及纯前端展示样式或提示文案变动，无后端状态机、分流与资金风险');
    prunedCategories.push('重型端到端轮询生成 (30s+ 超时轮询)');
    prunedCategories.push('全链路供应商外部成本对账');
    prunedCategories.push('并发极端压力与熔断演练');
    reasons.push('风险驱动裁剪：低风险变更，裁剪重型端到端验证，优先使用轻量级契约/冒烟测试，节约耗时与 Token');
  } else {
    // 高风险判定
    const isCoreRisk = hasDiversionKeywords || hasBillingKeywords || hasRefundKeywords
      || /(权限|鉴权|auth|token|session|state_machine|状态机|死锁|concurrent|并发)/i.test(corpus);
    if (isCoreRisk) {
      riskLevel = (affectedDomains.size >= 3 || (hasDiversionKeywords && hasBillingKeywords)) ? 'CRITICAL' : 'HIGH';
      if (hasDiversionKeywords) riskFactors.push('涉及渠道分流规则变更（可能引发未预期直连或上游调用击穿）');
      if (hasBillingKeywords) riskFactors.push('涉及计费扣款与资金流水逻辑（可能引发超扣、少扣或毛利倒挂）');
      if (hasRefundKeywords) riskFactors.push('涉及任务失败退款保证（可能引发资损或退款缺失漏退）');
      reasons.push('风险驱动扩充：高风险业务变更，强制扩充逆向用例、失败退款分支、异常参数拦截与全链路证据链');
    }
  }

  // 4. 自主规划推荐验证场景组合
  const recommendedScenarios: RecommendedScenario[] = [];
  const mandatoryEvidenceSet = new Set<string>(['TASK_ID']);

  for (const cap of targetCapabilities) {
    // 检查该模型的历史脆弱画像
    const fragility = assessHistoricalFragility({ modelId: cap.modelId, taskType: cap.validTaskTypes[0] });

    // 基础主流程 (Happy Path)
    recommendedScenarios.push({
      id: `${cap.id}_MAIN_FLOW`,
      title: `${cap.name} - 确定性端到端主流程闭环`,
      kind: 'MAIN_FLOW',
      targetModelId: cap.modelId,
      mediaType: cap.mediaType,
      riskWeight: fragility.priorityBoost ? 95 : 80,
      requiredEvidence: [...cap.requiredEvidences],
      description: `验证任务提交、异步轮询终态、分流快照命中 (${cap.upstream.diversionField}=${cap.upstream.expectedDiversionValue})、产物合法与对账扣除。`,
      historicalFragility: fragility.isFragile,
    });

    for (const ev of cap.requiredEvidences) mandatoryEvidenceSet.add(ev);

    // 若涉及分流或高风险：增加分流防线检查
    if (affectedDomains.has('DIVERSION') || riskLevel === 'HIGH' || riskLevel === 'CRITICAL') {
      recommendedScenarios.push({
        id: `${cap.id}_ROUTING_GUARD`,
        title: `${cap.name} - 渠道分流防线与快照双向核对`,
        kind: 'ROUTING_GUARD',
        targetModelId: cap.modelId,
        mediaType: cap.mediaType,
        riskWeight: 90,
        requiredEvidence: ['TASK_ID', 'ROUTING_SNAPSHOT'],
        description: `核验任务落库快照 extra 字段，严防非预期回退为主站直连或模型别名错乱。`,
      });
    }

    // 若涉及计费或高风险：增加失败退款与计费对账逆向分支
    if (affectedDomains.has('REFUND') || affectedDomains.has('BILLING') || riskLevel === 'HIGH' || riskLevel === 'CRITICAL') {
      recommendedScenarios.push({
        id: `${cap.id}_FAILURE_REFUND`,
        title: `${cap.name} - 生成失败与全额退款资金闭环 (逆向验证)`,
        kind: 'FAILURE_REFUND',
        targetModelId: cap.modelId,
        mediaType: cap.mediaType,
        riskWeight: 88,
        requiredEvidence: ['TASK_ID', 'BILLING_FLOW', 'STATUS_POLLING'],
        description: `诱发上游或系统拒绝失败，校验跳过产物校验，严格核查扣款与退款流水，最终净扣积分归零。`,
      });

      recommendedScenarios.push({
        id: `${cap.id}_BILLING_CONSISTENCY`,
        title: `${cap.name} - 充值折算与供应商毛利对账`,
        kind: 'BILLING_CONSISTENCY',
        targetModelId: cap.modelId,
        mediaType: cap.mediaType,
        riskWeight: 85,
        requiredEvidence: ['TASK_ID', 'BILLING_FLOW'],
        description: `基于充值批次规则核算有效单价，结合万相/TD 上游实际采购成本核算毛利率，防范负毛利与定价倒挂。`,
      });
    }

    // 若为 Seedance 或存在 fallback 需求：扩充 503 降级与重试场景
    if (cap.upstream.fallbackChannel || fragility.requireFallbackVerification) {
      recommendedScenarios.push({
        id: `${cap.id}_FALLBACK_RETRY`,
        title: `${cap.name} - 上游 503 熔断降级至 ${cap.upstream.fallbackChannel} (容错验证)`,
        kind: 'FALLBACK_RETRY',
        targetModelId: cap.modelId,
        mediaType: cap.mediaType,
        riskWeight: 82,
        requiredEvidence: ['TASK_ID', 'ROUTING_SNAPSHOT'],
        description: `模拟主路由返回 503 服务不可用，核对自动转接火山引擎兜底，并核查多次调用成本累加。`,
      });
    }

    // 逆向参数组合合法性防线 (Case 4 校验)
    if (riskLevel === 'HIGH' || riskLevel === 'CRITICAL') {
      recommendedScenarios.push({
        id: `${cap.id}_INVALID_COMBINATION`,
        title: `${cap.name} - 非法参数与分流冲突拦截 (防御验证)`,
        kind: 'INVALID_COMBINATION',
        targetModelId: cap.modelId,
        mediaType: cap.mediaType,
        riskWeight: 75,
        requiredEvidence: ['TASK_ID'],
        description: `传入互斥或非法参数（如视频传入 serviceline、负数时长），校验系统优雅拒绝报 400，严防脏数据入库。`,
      });
    }
  }

  return {
    affectedDomains: [...affectedDomains],
    affectedCapabilities: [...targetCapabilities],
    affectedApis,
    activatedOracles: [...activatedOracles],
    riskLevel,
    riskFactors,
    prunedCategories,
    recommendedScenarios,
    mandatoryEvidence: [...mandatoryEvidenceSet],
    reasons,
  };
}
