/**
 * DevTest SAFE 模式执行保护。
 *
 * 职责：
 * 1. 从需求 API 契约自动推导安全策略所需的 Operation → Effect 映射；
 * 2. SAFE 模式下拦截写路径（POST/PUT/PATCH/DELETE）的真实执行，
 *    将其统一落为 BLOCKED（SAFE_MODE_MUTATION_HOLD），保留在报告中作为
 *    「待确认写路径」，而不是从运行中消失。
 *
 * 铁律：只读用例（GET/HEAD/OPTIONS）不受影响；确认放行必须显式传入 confirmMutations，
 * 不存在任何隐式升级路径。
 */

import { ApiProcessor, type AcceptanceCaseExecutionResult, type ApiProcessorOptions } from '../acceptance/api-processor.js';
import type { AcceptanceOperationPolicy } from '../acceptance/acceptance-safety-policy.js';
import type { ApiSpec } from '../acceptance/requirement-ir.js';
import type { TestCase } from '../agents/test-design/testcase-schema.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isMutatingMethod(method: string | undefined): boolean {
  return method !== undefined && MUTATING_METHODS.has(method.toUpperCase());
}

/** 从 TestCase 的 HTTP_REQUEST 步骤提取方法；无 HTTP 步骤返回 undefined。 */
export function caseHttpMethod(testCase: TestCase): string | undefined {
  const step = testCase.steps.find((item) => item.type === 'HTTP_REQUEST');
  return step?.method;
}

/** Method → 安全策略 Effect 的确定性映射。 */
function effectOfApi(api: ApiSpec, requirementContext = ''): AcceptanceOperationPolicy['effect'] {
  const identity = `${api.operationKey} ${api.id}`.toLowerCase();
  if (/(?:billing|charge|recharge|provider|generate|render|paid)/.test(identity)) return 'BILLABLE';
  if (/(?:publish|notification|notify|message|email|sms|webhook)/.test(identity)) return 'EXTERNAL_SIDE_EFFECT';
  if (READ_METHODS.has(api.method)) return 'READ';
  const context = requirementContext.toLowerCase();
  // Requirement 已明确声明成本/外部副作用但尚不能可靠绑定到单个 Operation 时，
  // 对所有 mutation 取更保守的 effect，不能因 Path 名字“看起来普通”而放行。
  if (/(?:estimated\s*cost|billing|billable|charge|recharge|paid|扣费|充值|计费|高成本)/.test(context)) return 'BILLABLE';
  if (/(?:provider|publish|notification|notify|message|email|sms|webhook|发布|真实消息|第三方生成)/.test(context)) return 'EXTERNAL_SIDE_EFFECT';
  if (api.method === 'DELETE') return 'DELETE';
  return 'WRITE';
}

/**
 * 由需求解析出的 ApiSpec 列表构建 operationPolicies。
 * Key 与管线使用的 Operation Identity 一致（精确 `METHOD /path`）。
 */
export function buildOperationPolicies(
  apis: readonly ApiSpec[],
  requirementContext = '',
): Record<string, AcceptanceOperationPolicy> {
  const policies: Record<string, AcceptanceOperationPolicy> = {};
  for (const api of apis) {
    policies[api.operationKey] = {
      effect: effectOfApi(api, requirementContext),
      reason: 'DevTest Execution Guard：由权威 Operation Identity 确定 Method，并对扣费/Provider/发布/消息路径 fail-closed 分类',
    };
  }
  return policies;
}

export interface SafeMutationHoldProcessorOptions {
  /** true 时写路径真实放行（对应 --confirm-mutations）。 */
  confirmMutations: boolean;
  /** 测试注入的内层处理器；缺省走真实 ApiProcessor。 */
  inner?: ApiProcessor;
}

/**
 * 包装 ApiProcessor 的写路径闸门。
 * 继承而非组合，保证类型即 ApiProcessor，可原样注入 runAcceptancePipeline。
 */
export class SafeMutationHoldProcessor extends ApiProcessor {
  private readonly confirmMutations: boolean;
  private readonly inner?: ApiProcessor;

  constructor(options: SafeMutationHoldProcessorOptions) {
    super();
    this.confirmMutations = options.confirmMutations;
    this.inner = options.inner;
  }

  override async execute(testCase: TestCase, options: ApiProcessorOptions): Promise<AcceptanceCaseExecutionResult> {
    const method = caseHttpMethod(testCase);
    // “预期 4xx”不是无副作用证明：产品若错误接受请求，测试本身就会写入真实数据。
    // 所有 mutation（含 negative probe）都必须先获得 Sandbox/Cleanup + 显式确认。
    if (!this.confirmMutations && isMutatingMethod(method)) {
      return heldMutationResult(testCase, options.runId);
    }
    if (this.inner) return this.inner.execute(testCase, options);
    return super.execute(testCase, options);
  }
}

/** 构造与管线 BLOCKED 结果同构的挂起结果，保证报告/问题引擎无需特判。 */
export function heldMutationResult(testCase: TestCase, runId?: string): AcceptanceCaseExecutionResult {
  return {
    runId,
    caseId: testCase.id,
    name: testCase.name,
    feature: testCase.feature,
    scene: 'api',
    processor: 'safe-mutation-hold',
    processorInvoked: false,
    timestamp: new Date().toISOString(),
    priority: testCase.priority,
    tags: testCase.tags,
    pass: false,
    passRate: 0,
    executed: false,
    status: 'BLOCKED',
    assertions: 0,
    passedAssertions: 0,
    failedAssertions: 0,
    blockedReason: {
      code: 'SAFE_MODE_MUTATION_HOLD',
      stage: 'GATE',
      message: 'SAFE 模式禁止未显式确认或缺少 Sandbox/Cleanup/Rollback 的写操作，已列入待确认清单',
      recoverable: true,
    },
    error: 'BLOCKED：SAFE_MODE_MUTATION_HOLD：写操作缺少显式确认或 Sandbox/Cleanup/Rollback',
    classification: 'EXECUTION_BLOCKED',
    attribution: {
      classification: 'EXECUTION_BLOCKED',
      confidence: 'HIGH',
      reason: 'SAFE_MODE_MUTATION_HOLD：写路径未满足显式确认与 Sandbox/Cleanup/Rollback 双门禁',
      evidenceSources: ['DEVTEST_SAFE_MODE'],
    },
    evidence: {
      requirementId: testCase.source?.requirementId,
      acceptanceCriteriaIds: testCase.source?.acceptanceCriteriaIds ?? [],
      factIds: testCase.source?.factIds ?? [],
      objectiveIds: testCase.source?.objectiveIds ?? [],
      scenarioId: testCase.source?.scenarioId,
      sourceType: testCase.source?.sourceType,
      testPointId: testCase.source?.testPointId,
      assertions: [],
      evidenceItems: [],
    },
  };
}
