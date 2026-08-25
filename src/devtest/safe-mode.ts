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
function effectOfMethod(method: string): AcceptanceOperationPolicy['effect'] {
  if (READ_METHODS.has(method)) return 'READ';
  if (method === 'DELETE') return 'DELETE';
  return 'WRITE';
}

/**
 * 由需求解析出的 ApiSpec 列表构建 operationPolicies。
 * Key 与管线使用的 Operation Identity 一致（精确 `METHOD /path`）。
 */
export function buildOperationPolicies(apis: readonly ApiSpec[]): Record<string, AcceptanceOperationPolicy> {
  const policies: Record<string, AcceptanceOperationPolicy> = {};
  for (const api of apis) {
    policies[api.operationKey] = {
      effect: effectOfMethod(api.method),
      reason: 'devtest 自动推导：由显式 Method 映射 Effect',
    };
  }
  return policies;
}

export interface SafeMutationHoldProcessorOptions {
  /** true 时写路径真实放行（对应 --confirm-mutations）。 */
  confirmMutations: boolean;
}

/**
 * 包装 ApiProcessor 的写路径闸门。
 * 继承而非组合，保证类型即 ApiProcessor，可原样注入 runAcceptancePipeline。
 */
export class SafeMutationHoldProcessor extends ApiProcessor {
  private readonly confirmMutations: boolean;

  constructor(options: SafeMutationHoldProcessorOptions) {
    super();
    this.confirmMutations = options.confirmMutations;
  }

  override async execute(testCase: TestCase, options: ApiProcessorOptions): Promise<AcceptanceCaseExecutionResult> {
    const method = caseHttpMethod(testCase);
    if (!this.confirmMutations && isMutatingMethod(method)) {
      return heldMutationResult(testCase, options.runId);
    }
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
      message: 'SAFE 模式默认不执行写操作（POST/PUT/PATCH/DELETE），已列入待确认清单',
      recoverable: true,
    },
    error: 'BLOCKED：SAFE_MODE_MUTATION_HOLD：SAFE 模式默认不执行写操作，确认风险后可用 --confirm-mutations 重跑',
    classification: 'EXECUTION_BLOCKED',
    attribution: {
      classification: 'EXECUTION_BLOCKED',
      confidence: 'HIGH',
      reason: 'SAFE_MODE_MUTATION_HOLD：写路径默认挂起等待人工确认',
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
    },
  };
}
