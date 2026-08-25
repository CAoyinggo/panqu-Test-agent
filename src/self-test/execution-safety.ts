import type { Scenario } from '../acceptance/scenario-contract.js';
import { evaluateExecutionPolicy, type ExecutionApproval, type ProjectExecutionPolicy } from '../agents/policy/policy-gate.js';
import { computeRiskSummary, type RiskAssessment, type RiskItem } from '../agents/risk/risk-schema.js';
import type { TestCase } from '../agents/test-design/testcase-schema.js';
import type { DeveloperSelfTestInput, ExecutionRisk, FeatureRiskSummary, SelfTestExecutionMode, SelfTestSafetyDecision } from './types.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface SelfTestSafetyOptions {
  approval?: ExecutionApproval;
  projectPolicy?: ProjectExecutionPolicy;
  estimatedCost?: number;
}

function executionRisk(scenario: Scenario, risk: FeatureRiskSummary, mode: SelfTestExecutionMode, estimatedCost?: number): ExecutionRisk {
  const sideEffects = [...new Set([
    ...risk.sideEffects,
    ...scenario.operations.flatMap((operation) => (scenario.metadata?.sideEffects as string[] | undefined) ?? (MUTATING.has(operation.method ?? '') ? ['DATA_MUTATION_POSSIBLE'] : [])),
  ])];
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;
  const riskLevel = scenario.risks.reduce<ExecutionRisk['riskLevel']>((highest, item) => rank[item.level] > rank[highest] ? item.level : highest, risk.overall);
  return {
    riskLevel, estimatedCost, sideEffects,
    rollbackAvailable: scenario.cleanup.length > 0,
    requiresApproval: mode === 'LIVE' && (sideEffects.length > 0 || riskLevel === 'HIGH' || riskLevel === 'CRITICAL'),
  };
}

function policyRisk(feature: string, risk: FeatureRiskSummary, safeReadOnlyProbe: boolean): RiskAssessment {
  const items: RiskItem[] = risk.risks.map((item, index) => ({
    id: `self-test-risk-${index + 1}`,
    category: safeReadOnlyProbe && !['AUTHENTICATION', 'AUTHORIZATION'].includes(item.type)
      ? 'dependency'
      : item.type === 'BILLING' ? 'billing' : item.type === 'AUTHENTICATION' || item.type === 'AUTHORIZATION' ? 'security' : item.type === 'DATA_MUTATION' ? 'data' : 'dependency',
    level: safeReadOnlyProbe && !['AUTHENTICATION', 'AUTHORIZATION'].includes(item.type)
      ? 'medium'
      : item.level === 'CRITICAL' || item.level === 'HIGH' ? 'high' : item.level === 'MEDIUM' ? 'medium' : 'low',
    title: item.type, desc: item.reasons.join('；'), mitigation: '由 Self-Test Execution Guard 与 Evidence Gate 控制',
  }));
  return { feature, risks: items, summary: computeRiskSummary(items), issues: [], source: 'developer-self-test-risk-classifier' };
}

function policyCase(scenario: Scenario): TestCase {
  return {
    id: scenario.id, feature: scenario.domain ?? 'self-test', name: scenario.title, priority: scenario.priority,
    executionMode: 'EXECUTABLE', protocol: 'HTTP', tags: scenario.tags ?? [], steps: [],
    assertions: scenario.assertions.map((assertion) => ({
      type: 'DESIGN_EXPECTATION', target: assertion.channel === 'SIDE_EFFECT' ? 'billing' : 'response',
      description: assertion.description ?? assertion.id,
    })),
  };
}

export function evaluateSelfTestSafety(
  scenario: Scenario,
  input: DeveloperSelfTestInput,
  mode: SelfTestExecutionMode,
  featureRisk: FeatureRiskSummary,
  options: SelfTestSafetyOptions = {},
): SelfTestSafetyDecision {
  const risk = executionRisk(scenario, featureRisk, mode, options.estimatedCost);
  if (mode === 'DRY_RUN') return {
    allowed: false, mode, disposition: 'NOT_EXECUTED', risk,
    reasons: ['DRY_RUN：只生成 Discovery、Contract、Risk 与 Scenario Pack，不执行 Processor'],
    policyVerdict: 'NOT_EVALUATED',
  };
  if (scenario.executionMode !== 'EXECUTABLE') return {
    allowed: false, mode, disposition: 'BLOCKED', risk,
    reasons: scenario.blockedReasons.map((item) => `${item.code}：${item.message}`), policyVerdict: 'NOT_EVALUATED',
  };
  const operations = scenario.operations;
  if (mode === 'SAFE') {
    const unsafe = operations.find((operation) => MUTATING.has(operation.method ?? '')
      && scenario.metadata?.safeProbe !== true);
    if (unsafe) return {
      allowed: false, mode, disposition: 'BLOCKED', risk,
      reasons: [`SAFE_MODE_SIDE_EFFECT_BLOCKED：${unsafe.method} ${unsafe.path}`], policyVerdict: 'BLOCK',
    };
    const provenRejectProbe = operations.every((operation) => !MUTATING.has(operation.method ?? '') || scenario.metadata?.safeProbe === true)
      && scenario.tags?.includes('validation') === true;
    if (!provenRejectProbe && risk.sideEffects.some((effect) => /billing|charge|payment|扣费/i.test(effect))) return {
      allowed: false, mode, disposition: 'BLOCKED', risk,
      reasons: ['SAFE_MODE_BILLING_BLOCKED：SAFE 禁止任何可能真实计费的 Operation'], policyVerdict: 'BLOCK',
    };
  }
  if (mode === 'LIVE') {
    if (!options.approval || options.approval.status !== 'APPROVED') return {
      allowed: false, mode, disposition: 'BLOCKED', risk,
      reasons: ['LIVE_APPROVAL_REQUIRED：LIVE 必须提供显式人工批准'], policyVerdict: 'APPROVAL_REQUIRED',
    };
    if (input.budget?.maxCost === undefined) return {
      allowed: false, mode, disposition: 'BLOCKED', risk,
      reasons: ['LIVE_BUDGET_REQUIRED：LIVE 必须显式配置 maxCost'], policyVerdict: 'BLOCK',
    };
    if (options.estimatedCost !== undefined && options.estimatedCost > input.budget.maxCost) return {
      allowed: false, mode, disposition: 'BLOCKED', risk,
      reasons: [`BUDGET_EXCEEDED：estimated=${options.estimatedCost} max=${input.budget.maxCost}`], policyVerdict: 'BLOCK',
    };
    if (risk.sideEffects.length > 0 && !risk.rollbackAvailable) return {
      allowed: false, mode, disposition: 'BLOCKED', risk,
      reasons: ['LIVE_ROLLBACK_REQUIRED：有副作用 Scenario 缺少 Cleanup/Rollback'], policyVerdict: 'BLOCK',
    };
  }
  const plan = {
    order: [scenario.id], concurrency: 1, enableRetry: false, reason: `self-test ${mode}`,
    dryRun: false, policy: { realExecution: true, realBilling: mode === 'LIVE' },
  };
  const safeRejectProbe = mode === 'SAFE' && operations.every((operation) => (
    !MUTATING.has(operation.method ?? '') || scenario.tags?.includes('validation') === true
  ));
  const policy = evaluateExecutionPolicy({
    requirement: {
      feature: safeRejectProbe ? 'safe-validation-reject-probe' : scenario.domain ?? 'self-test',
      goal: safeRejectProbe ? '验证显式非法输入被拒绝且不产生副作用' : scenario.title,
      capabilities: [], inputs: [], requirements: [], businessRules: [], dependencies: [],
      source: safeRejectProbe ? 'sideEffectFree=true; expected rejection only' : scenario.requirement,
    },
    risk: policyRisk(scenario.domain ?? 'self-test', featureRisk, safeRejectProbe),
    testCases: [policyCase(scenario)],
    environment: input.environment, dryRun: false, projectPolicy: {
      enabled: true, allowedEnvironments: [input.environment], allowRealExecution: true,
      allowRealBilling: mode === 'LIVE', allowHighRiskOperations: mode === 'SAFE' ? true : options.projectPolicy?.allowHighRiskOperations,
      ...options.projectPolicy,
    },
    approval: options.approval, executionPlan: plan,
  });
  return {
    allowed: policy.allowed, mode, disposition: policy.allowed ? 'EXECUTE' : 'BLOCKED', risk,
    reasons: policy.reasons, policyVerdict: policy.verdict,
  };
}
