/**
  * 风险驱动的测试场景规划器（Scenario Planner）
  *
  * 基于 Risk-based Selection 策略，根据被测需求、模型特征与业务模式（分流 vs 直接接入），
  * 自动决策生成最小且完备的测试场景集合：
  *
  * 1. 分流模式（DIVERSION）：
  *    - 针对已有模型进行流量劫持与分流
  *    - 重点验证：准入规则、双向决策树（命中 NewAPI vs 降级回退原链路）、Extra 路由快照、多企业路由组隔离
  *
  * 2. 直接接入模式（DIRECT）：
  *    - 针对代码写死直连 NewAPI 的新模型（如 Image 2.5、新型视频模型）
  *    - 重点验证：代码硬编码白名单/直连路由、规格参数矩阵覆盖（分辨率/画幅/时长）、介质物理合规、单模型刊例计费与失败退款
  */

import type {
  DevTestFlowType,
  DevTestRiskItem,
  DevTestScenario,
  DevTestScenarioKind,
} from './types.js';

export interface ScenarioPlanningContext {
  domain: 'VIDEO' | 'IMAGE' | 'CANVAS' | 'MULTI_MODAL';
  targetModels: Array<{
    id: number;
    type: 'video' | 'image';
    alias: string;
    isGlobal: boolean;
    capabilities?: Record<string, unknown>;
  }>;
  flowType?: DevTestFlowType;
  hasBilling?: boolean;
  hasFailureRefund?: boolean;
  hasRouting?: boolean;
  hasMediaAsset?: boolean;
  hasPermissions?: boolean;
  hasIdempotency?: boolean;
  requirementSummary?: string;
}

export class ScenarioPlanner {
  /**
   * 基于风险评估规划测试场景
   */
  static plan(context: ScenarioPlanningContext): {
    scenarios: DevTestScenario[];
    risks: DevTestRiskItem[];
  } {
    const scenarios: DevTestScenario[] = [];
    const risks: DevTestRiskItem[] = [];

    const flowType: DevTestFlowType = context.flowType ?? 'DIVERSION';
    const isVideo = context.domain === 'VIDEO' || context.targetModels.some((m) => m.type === 'video');
    const isImage = context.domain === 'IMAGE' || context.targetModels.some((m) => m.type === 'image');
    const hasBilling = context.hasBilling ?? true;
    const hasFailureRefund = context.hasFailureRefund ?? true;
    const hasRouting = context.hasRouting ?? true;
    const hasMedia = context.hasMediaAsset ?? true;
    const hasIdempotency = context.hasIdempotency ?? true;

    for (const model of context.targetModels) {
      const modelPrefix = `MODEL_${model.id}_${model.type.toUpperCase()}`;

      if (flowType === 'DIRECT') {
        // ==========================================
        // 直接接入模式（新模型，代码写死直连 NewAPI）
        // ==========================================

        // 1. 直连主成功闭环
        scenarios.push({
          id: `SCENARIO_${modelPrefix}_DIRECT_HAPPY_PATH`,
          name: `[新模型直连] ${model.alias || `Model-${model.id}`} 代码直达生成全闭环`,
          kind: 'MAIN_HAPPY_PATH',
          whySelected: '验证新模型基于代码写死逻辑（如 supports() 白名单）直通 NewAPI 提交、轮询与成片',
          relatedRequirement: context.requirementSummary ?? '新模型直接接入与全量直达生成',
          relatedRisk: '新模型代码映射错配会导致用户提交无法分发',
          requiredEvidence: ['TASK_SUBMIT_200', 'TASK_STATUS_SUCCESS', 'ASSET_URL_VALID'],
          requiredOracles: ['RoutingOracle', 'BillingOracle', 'MediaInspector'],
          modelId: model.id,
          payloadProfile: {
            modelId: model.id,
            modelType: model.type,
            prompt: `devtest_${model.type}_${model.id}_direct_smoke`,
          },
        });

        // 2. 新模型规格参数矩阵覆盖测试（分辨率/画幅/时长）
        scenarios.push({
          id: `SCENARIO_${modelPrefix}_DIRECT_SPEC_MATRIX`,
          name: `[新模型直连] ${model.alias} 规格参数矩阵（分辨率/画幅/时长）覆盖校验`,
          kind: 'DIRECT_SPEC_MATRIX',
          whySelected: '验证新模型支持的所有分辨率与画幅参数均被上游渠道接受，无非法拉伸或裁切',
          relatedRequirement: '新模型参数能力与规格规范',
          relatedRisk: '分辨率或画幅参数未对齐导致上游报错',
          requiredEvidence: ['SPEC_PARAMS_NORMALIZED', 'HTTP_200_RESPONSE'],
          requiredOracles: ['TestOracle'],
          modelId: model.id,
          payloadProfile: {
            modelId: model.id,
            testAllSpecs: true,
          },
        });

        // 3. 产物物理介质校验
        if (hasMedia) {
          const mediaRisk: DevTestRiskItem = {
            id: `RISK_${modelPrefix}_MEDIA`,
            category: 'MEDIA_INTEGRITY',
            description: `新模型生成的 ${isVideo ? 'MP4' : 'PNG'} 容器损坏、黑屏或规格不符`,
            severity: 'HIGH',
            mitigationScenarioKind: 'MEDIA_ASSET_VERIFICATION',
          };
          risks.push(mediaRisk);

          scenarios.push({
            id: `SCENARIO_${modelPrefix}_MEDIA_ASSET`,
            name: `[新模型直连] ${model.alias} 产物介质物理结构与元数据解析校验`,
            kind: 'MEDIA_ASSET_VERIFICATION',
            whySelected: isVideo
              ? '通过 ISO-BMFF Box 遍历验证 ftyp/moov/mdat 结构、分辨率与时长'
              : '通过 PNG IHDR / JPEG SOF0 块验证宽度、高度与颜色通道',
            relatedRequirement: '新模型产物介质物理可播放与规格完整性规范',
            relatedRisk: mediaRisk.description,
            requiredEvidence: isVideo
              ? ['BOX_FTYP_MOOV_MDAT', 'METADATA_RESOLUTION_MATCH', 'DURATION_MATCH']
              : ['IHDR_OR_SOF0_HEADER', 'DIMENSION_MATCH'],
            requiredOracles: ['MediaInspector'],
            modelId: model.id,
          });
        }

        // 4. 单模型刊例计费核销
        if (hasBilling) {
          const billingRisk: DevTestRiskItem = {
            id: `RISK_${modelPrefix}_BILLING`,
            category: 'BILLING',
            description: `新模型刊例单价未配置或扣减计算错误，可能导致资损或多扣客诉`,
            severity: 'CRITICAL',
            mitigationScenarioKind: 'BILLING_RECONCILIATION',
          };
          risks.push(billingRisk);

          scenarios.push({
            id: `SCENARIO_${modelPrefix}_BILLING_RECONCILIATION`,
            name: `[新模型直连] ${model.alias} 刊例定价扣费流水与成本核销`,
            kind: 'BILLING_RECONCILIATION',
            whySelected: '验证新模型扣费流水、实扣积分以及平台毛利核算与刊例完全吻合',
            relatedRequirement: '计费中心单模型扣费流水与对账规则',
            relatedRisk: billingRisk.description,
            requiredEvidence: ['BILLING_RECORD_DEDUCT', 'ACCOUNT_BALANCE_CONSISTENCY'],
            requiredOracles: ['BillingOracle', 'SupplierCostOracle'],
            modelId: model.id,
          });
        }

        // 5. 失败全额退款
        if (hasFailureRefund) {
          const failureRisk: DevTestRiskItem = {
            id: `RISK_${modelPrefix}_REFUND`,
            category: 'FAILURE_RECOVERY',
            description: `上游供应商超时或返回错误时，未触发退款导致用户积分白白扣减`,
            severity: 'CRITICAL',
            mitigationScenarioKind: 'FAILURE_REFUND',
          };
          risks.push(failureRisk);

          scenarios.push({
            id: `SCENARIO_${modelPrefix}_FAILURE_REFUND`,
            name: `[新模型直连] ${model.alias} 任务失败自动全额退款与净扣归零核销`,
            kind: 'FAILURE_REFUND',
            whySelected: '确保新模型任务遇到上游异常时触发退款，对账流水正负抵消净扣为 0 pt',
            relatedRequirement: '任务失败全额退还积分不变量',
            relatedRisk: failureRisk.description,
            requiredEvidence: ['TASK_FAILED_STATUS', 'BILLING_REFUND_RECORD', 'NET_CHARGE_ZERO'],
            requiredOracles: ['BillingOracle', 'IdempotencyOracle'],
            modelId: model.id,
            payloadProfile: {
              modelId: model.id,
              expectFailure: true,
            },
          });
        }

        // 6. 重试与幂等防重
        if (hasIdempotency) {
          const idempotencyRisk: DevTestRiskItem = {
            id: `RISK_${modelPrefix}_IDEMPOTENCY`,
            category: 'IDEMPOTENCY',
            description: `网络抖动导致提交超时，重试可能创建两个收费任务造成双重扣款`,
            severity: 'HIGH',
            mitigationScenarioKind: 'RETRY_IDEMPOTENCY',
          };
          risks.push(idempotencyRisk);

          scenarios.push({
            id: `SCENARIO_${modelPrefix}_RETRY_IDEMPOTENCY`,
            name: `[新模型直连] ${model.alias} 超时去重、先查后投与防二次扣费`,
            kind: 'RETRY_IDEMPOTENCY',
            whySelected: '验证相同 clientToken 重试返回相同 taskId，且扣费记录严格为 1 次',
            relatedRequirement: '重试与并发提交防重规则',
            relatedRisk: idempotencyRisk.description,
            requiredEvidence: ['DEDUP_TOKEN_MATCH', 'SINGLE_TASK_CREATED', 'SINGLE_CHARGE_RECORD'],
            requiredOracles: ['IdempotencyOracle'],
            modelId: model.id,
          });
        }

        // 7. 非法参数边界前置拦截
        scenarios.push({
          id: `SCENARIO_${modelPrefix}_BOUNDARY_DEFENSE`,
          name: `[新模型直连] ${model.alias} 非法参数（无效分辨率/格式）前置防御拦截`,
          kind: 'INVALID_INPUT_BOUNDARY',
          whySelected: '验证非法参数在扣费与投递前被直接拦截，不产生无意义的供应商扣费',
          relatedRequirement: '新模型参数合法性前置防御规范',
          relatedRisk: '非法参数穿透导致上游接口报错并浪费配额',
          requiredEvidence: ['CLIENT_VALIDATION_ERROR', 'NO_CHARGE_INCURRED'],
          requiredOracles: ['TestOracle'],
          modelId: model.id,
          payloadProfile: {
            modelId: model.id,
            invalidParam: true,
          },
        });

      } else {
        // ==========================================
        // 分流模式（已有模型分流改造与降级兜底）
        // ==========================================

        // 1. 核心正向主场景（命中分流）
        scenarios.push({
          id: `SCENARIO_${modelPrefix}_HAPPY_PATH`,
          name: `[已有模型分流] ${model.alias || `Model-${model.id}`} 命中 NewAPI 分流全闭环`,
          kind: 'MAIN_HAPPY_PATH',
          whySelected: '验证满足分流条件时流量平滑切至 NewAPI 且端到端生成成功',
          relatedRequirement: context.requirementSummary ?? '已有模型平滑接入 NewAPI 分流',
          relatedRisk: '分流切流异常导致存量模型生成失败',
          requiredEvidence: ['TASK_SUBMIT_200', 'TASK_STATUS_SUCCESS', 'ASSET_URL_VALID'],
          requiredOracles: ['RoutingOracle', 'BillingOracle', 'MediaInspector'],
          modelId: model.id,
          payloadProfile: {
            modelId: model.id,
            modelType: model.type,
            prompt: `devtest_${model.type}_${model.id}_diversion_smoke`,
          },
        });

        // 2. NewAPI 路由分流快照验真
        if (hasRouting) {
          const routingRisk: DevTestRiskItem = {
            id: `RISK_${modelPrefix}_ROUTING`,
            category: 'ROUTING',
            description: `已有模型未命中分流规则或 Extra 快照缺失导致路由审计失败`,
            severity: 'CRITICAL',
            mitigationScenarioKind: 'ROUTING_DIVERSION',
          };
          risks.push(routingRisk);

          scenarios.push({
            id: `SCENARIO_${modelPrefix}_ROUTING_DIVERSION`,
            name: `[已有模型分流] ${model.alias} NewAPI 分流决策与 Extra 路由快照验真`,
            kind: 'ROUTING_DIVERSION',
            whySelected: '验证主站准入规则正确识别已有模型并写入 diversion=10 / newapi_image=1 快照',
            relatedRequirement: 'NewAPI 分流准入规则与模型别名映射',
            relatedRisk: routingRisk.description,
            requiredEvidence: isVideo
              ? ['EXTRA_DIVERSION_10', 'EXTRA_NEWAPI_MODEL']
              : ['EXTRA_NEWAPI_IMAGE_1', 'EXTRA_NEWAPI_MODEL'],
            requiredOracles: ['RoutingOracle'],
            modelId: model.id,
          });
        }

        // 3. 反向降级回退验证（分流核心特性：不满足条件时优雅回退原直连链路）
        const fallbackRisk: DevTestRiskItem = {
          id: `RISK_${modelPrefix}_FALLBACK`,
          category: 'ROUTING',
          description: `不满足 NewAPI 资格（如真人人像/特殊 task_type）时未能安全回退原链路`,
          severity: 'HIGH',
          mitigationScenarioKind: 'DIVERSION_FALLBACK_DIRECT',
        };
        risks.push(fallbackRisk);

        scenarios.push({
          id: `SCENARIO_${modelPrefix}_FALLBACK_DIRECT`,
          name: `[已有模型分流] ${model.alias} 资格不符安全降级回退原直连链路`,
          kind: 'DIVERSION_FALLBACK_DIRECT',
          whySelected: '验证当任务不满足 NewAPI 准入条件时，系统安全回退至原直连链路，不产生业务阻断',
          relatedRequirement: '分流故障与资格不符降级回退规则',
          relatedRisk: fallbackRisk.description,
          requiredEvidence: ['EXTRA_DIVERSION_NOT_NEWAPI', 'TASK_FALLBACK_SUCCESS'],
          requiredOracles: ['RoutingOracle'],
          modelId: model.id,
          payloadProfile: {
            modelId: model.id,
            simulateIneligible: true,
          },
        });

        // 4. 计费与流水对账场景
        if (hasBilling) {
          const billingRisk: DevTestRiskItem = {
            id: `RISK_${modelPrefix}_BILLING`,
            category: 'BILLING',
            description: `分流后计费流水未正确标记分流线路，或正负对账不平`,
            severity: 'CRITICAL',
            mitigationScenarioKind: 'BILLING_RECONCILIATION',
          };
          risks.push(billingRisk);

          scenarios.push({
            id: `SCENARIO_${modelPrefix}_BILLING_RECONCILIATION`,
            name: `[已有模型分流] ${model.alias} 积分扣除流水与供应商成本核销`,
            kind: 'BILLING_RECONCILIATION',
            whySelected: '验证分流任务扣费流水、实扣积分以及平台毛利核算与刊例完全吻合',
            relatedRequirement: '计费中心扣费流水与正负对账规则',
            relatedRisk: billingRisk.description,
            requiredEvidence: ['BILLING_RECORD_DEDUCT', 'ACCOUNT_BALANCE_CONSISTENCY'],
            requiredOracles: ['BillingOracle', 'SupplierCostOracle'],
            modelId: model.id,
          });
        }

        // 5. 失败自动退款场景
        if (hasFailureRefund) {
          const failureRisk: DevTestRiskItem = {
            id: `RISK_${modelPrefix}_REFUND`,
            category: 'FAILURE_RECOVERY',
            description: `分流网关返回失败时未触发主站退款`,
            severity: 'CRITICAL',
            mitigationScenarioKind: 'FAILURE_REFUND',
          };
          risks.push(failureRisk);

          scenarios.push({
            id: `SCENARIO_${modelPrefix}_FAILURE_REFUND`,
            name: `[已有模型分流] ${model.alias} 分流任务失败自动退款与净扣归零核销`,
            kind: 'FAILURE_REFUND',
            whySelected: '确保分流任务异常时触发全额退款，对账流水正负抵消净扣为 0 pt',
            relatedRequirement: '任务失败全额退还积分不变量',
            relatedRisk: failureRisk.description,
            requiredEvidence: ['TASK_FAILED_STATUS', 'BILLING_REFUND_RECORD', 'NET_CHARGE_ZERO'],
            requiredOracles: ['BillingOracle', 'IdempotencyOracle'],
            modelId: model.id,
            payloadProfile: {
              modelId: model.id,
              expectFailure: true,
            },
          });
        }

        // 6. 重试与幂等防重场景
        if (hasIdempotency) {
          const idempotencyRisk: DevTestRiskItem = {
            id: `RISK_${modelPrefix}_IDEMPOTENCY`,
            category: 'IDEMPOTENCY',
            description: `重试可能在 NewAPI 侧与主站侧产生孤儿任务`,
            severity: 'HIGH',
            mitigationScenarioKind: 'RETRY_IDEMPOTENCY',
          };
          risks.push(idempotencyRisk);

          scenarios.push({
            id: `SCENARIO_${modelPrefix}_RETRY_IDEMPOTENCY`,
            name: `[已有模型分流] ${model.alias} 超时去重、先查后投与防二次扣费`,
            kind: 'RETRY_IDEMPOTENCY',
            whySelected: '验证相同 clientToken 重试返回相同 taskId，且扣费记录严格为 1 次',
            relatedRequirement: '重试与并发提交防重规则',
            relatedRisk: idempotencyRisk.description,
            requiredEvidence: ['DEDUP_TOKEN_MATCH', 'SINGLE_TASK_CREATED', 'SINGLE_CHARGE_RECORD'],
            requiredOracles: ['IdempotencyOracle'],
            modelId: model.id,
          });
        }

        // 7. 产物介质物理结构与元数据解析校验
        if (hasMedia) {
          const mediaRisk: DevTestRiskItem = {
            id: `RISK_${modelPrefix}_MEDIA`,
            category: 'MEDIA_INTEGRITY',
            description: `分流生成的 ${isVideo ? 'MP4' : 'PNG'} 容器损坏、黑屏或规格不符`,
            severity: 'HIGH',
            mitigationScenarioKind: 'MEDIA_ASSET_VERIFICATION',
          };
          risks.push(mediaRisk);

          scenarios.push({
            id: `SCENARIO_${modelPrefix}_MEDIA_ASSET`,
            name: `[已有模型分流] ${model.alias} 产物介质物理结构与元数据解析校验`,
            kind: 'MEDIA_ASSET_VERIFICATION',
            whySelected: isVideo
              ? '通过 ISO-BMFF Box 遍历验证 ftyp/moov/mdat 结构、分辨率与时长'
              : '通过 PNG IHDR / JPEG SOF0 块验证宽度、高度与颜色通道',
            relatedRequirement: '分流产物介质物理可播放与规格完整性规范',
            relatedRisk: mediaRisk.description,
            requiredEvidence: isVideo
              ? ['BOX_FTYP_MOOV_MDAT', 'METADATA_RESOLUTION_MATCH', 'DURATION_MATCH']
              : ['IHDR_OR_SOF0_HEADER', 'DIMENSION_MATCH'],
            requiredOracles: ['MediaInspector'],
            modelId: model.id,
          });
        }

        // 8. 企业分组隔离场景（非全量分流模型必测）
        if (!model.isGlobal) {
          const permRisk: DevTestRiskItem = {
            id: `RISK_${modelPrefix}_ORG_ISOLATION`,
            category: 'PERMISSION',
            description: `非全量分组分流模型要求特定企业组绑定，未绑定组织应安全回退`,
            severity: 'MEDIUM',
            mitigationScenarioKind: 'PERMISSION_ISOLATION',
          };
          risks.push(permRisk);

          scenarios.push({
            id: `SCENARIO_${modelPrefix}_ORG_ISOLATION`,
            name: `[已有模型分流] ${model.alias} 企业路由组绑定鉴权与跨组织隔离`,
            kind: 'PERMISSION_ISOLATION',
            whySelected: '验证归属不同企业/未绑定路由组的用户访问该分流模型时的鉴权与隔离',
            relatedRequirement: '多租户与企业路由组绑定隔离规则',
            relatedRisk: permRisk.description,
            requiredEvidence: ['ORG_BINDING_VERIFIED', 'CROSS_ORG_ACCESS_DENIED'],
            requiredOracles: ['RoutingOracle'],
            modelId: model.id,
          });
        }
      }
    }

    return { scenarios, risks };
  }
}
