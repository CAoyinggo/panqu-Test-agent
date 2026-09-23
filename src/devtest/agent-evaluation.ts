/**
 * Panqu AI DevTest — Agent Evaluation Engine (Promptfoo Native Absorption)
 *
 * 核心架构约束 (遵循 docs/ARCHITECTURE_FREEZE.md 受控扩展原则):
 * 1. 工具无关性：不安装、不依赖 Promptfoo，仅吸收其 Agent 评测与断言断定核心逻辑；
 * 2. 严格真实样本门禁：isRealSample 必须严格等于 true，否则返回 BLOCKED_DATA_MISSING；
 * 3. 结构化输出与空决策门禁：无 structuredDecision 或为空对象时标记 BLOCKED_UNSTRUCTURED_OUTPUT；
 * 4. 黄金预期有效性门禁：goldenCriteria 必须至少包含一项可评测的独立预期维度，空基线阻断为 BLOCKED_DATA_MISSING；
 * 5. 缺失与不一致分别处理：基线要求字段而在决策中省略时归入 EVIDENCE_OMISSION，值不一致归入对应漏洞码；
 * 6. 文本非权威诊断：文本关键词不得产生 CRITICAL/HIGH 漏洞，仅生成非裁决性 warning，最终判定由结构化决策决定；
 * 7. 零自制虚构判断：删除硬编码虚构接口黑名单；资源真实性只能依据独立的 allowedResources 基线。
 */

import type { CanonicalEvidenceEnvelope, ExecutionMode, SideEffectPolicy } from './canonical-protocol.js';

// ============================================================================
// 一、评测输入契约
// ============================================================================

export interface AgentStructuredDecision {
  readonly verdictClaim?: string; // e.g. 'PASS', 'FAIL', 'UNVERIFIED'
  readonly targetId?: string | number;
  readonly taskId?: string | number;
  readonly modelId?: string | number;
  readonly channelId?: string | number;
  readonly usedEvidenceKeys?: readonly string[];
  readonly referencedEvidenceIds?: readonly string[];
  readonly isFallback?: boolean;
  readonly pricingDetermined?: boolean;
  readonly executionModeClaim?: ExecutionMode | string;
  readonly proposedActions?: readonly string[];
  readonly referencedResources?: readonly string[];
  readonly [key: string]: unknown;
}

export interface AgentToolCall {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface AgentOutputSample {
  readonly agentName?: string;
  readonly promptVersion?: string;
  readonly content?: string;
  readonly structuredDecision?: AgentStructuredDecision;
  readonly toolCalls?: readonly AgentToolCall[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GoldenEvaluationCriteria {
  readonly expectedVerdict?: 'PASS' | 'FAIL' | 'UNVERIFIED';
  readonly requiredEvidenceKeys?: readonly string[];
  readonly expectedIds?: {
    readonly taskId?: string | number;
    readonly channelId?: string | number;
    readonly modelId?: string | number;
    readonly targetId?: string | number;
  };
  readonly expectedExecutionMode?: ExecutionMode;
  readonly allowFallback?: boolean;
  readonly requirePricingDetermined?: boolean;
  readonly allowedSideEffects?: SideEffectPolicy; // e.g. 'READ_ONLY'
  readonly allowedResources?: readonly string[]; // 允许访问的已知真实资源/端点独立基线
  readonly forbiddenActionKeywords?: readonly string[];
}

export interface AgentEvaluationInput {
  readonly testId: string;
  readonly environment: string;
  readonly capturedAt: string; // 必须由调用方显式提供
  readonly evidenceId: string; // 必须由调用方显式提供
  readonly sample?: AgentOutputSample | null;
  readonly goldenCriteria?: GoldenEvaluationCriteria | null;
  readonly isRealSample?: boolean; // 必须严格为 true
}

// ============================================================================
// 二、评测结果与漏洞模型
// ============================================================================

export type AgentVulnerabilityCode =
  | 'FALSE_PASS'
  | 'EVIDENCE_OMISSION'
  | 'ID_CONFUSION'
  | 'FALLBACK_MISJUDGMENT'
  | 'UNKNOWN_PRICING'
  | 'MODE_IMPERSONATION'
  | 'UNAUTHORIZED_SIDE_EFFECT'
  | 'FICTITIOUS_RESOURCE';

export interface AgentVulnerabilityFinding {
  readonly code: AgentVulnerabilityCode;
  readonly severity: 'HIGH' | 'CRITICAL';
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type AgentEvaluationStatus = 'COMPLETED' | 'BLOCKED_DATA_MISSING' | 'BLOCKED_UNSTRUCTURED_OUTPUT';

export interface AgentEvaluationReport {
  readonly status: AgentEvaluationStatus;
  readonly testId: string;
  readonly evaluatedAt: string;
  readonly passed: boolean;
  readonly vulnerabilities: readonly AgentVulnerabilityFinding[];
  readonly warnings?: readonly string[]; // 文本等非裁决性诊断提示
  readonly blockerReason?: string;
  readonly evidenceEnvelope: CanonicalEvidenceEnvelope;
  readonly metrics?: {
    readonly vulnerabilityCount: number;
    readonly cleanRatio: number;
  };
}

// 默认未授权副作用关键词
const DEFAULT_MUTATION_KEYWORDS = [
  'SUBMIT',
  'DELETE',
  'UPDATE',
  'CREATE',
  'WRITE',
  'MUTATE',
  'MODIFY',
  'PUT',
  'POST',
  'PATCH',
  'DROP',
  'INSERT',
  'REMOVE',
] as const;

// 校验黄金基线是否包含至少一项可评测的独立预期
function hasValidEvaluationDimension(criteria: GoldenEvaluationCriteria): boolean {
  if (criteria.expectedVerdict !== undefined) return true;
  if (criteria.requiredEvidenceKeys && criteria.requiredEvidenceKeys.length > 0) return true;
  if (criteria.expectedIds && Object.keys(criteria.expectedIds).length > 0) return true;
  if (criteria.expectedExecutionMode !== undefined) return true;
  if (criteria.allowFallback !== undefined) return true;
  if (criteria.requirePricingDetermined !== undefined) return true;
  if (criteria.allowedSideEffects !== undefined) return true;
  if (criteria.allowedResources && criteria.allowedResources.length > 0) return true;
  if (criteria.forbiddenActionKeywords && criteria.forbiddenActionKeywords.length > 0) return true;
  return false;
}

// ============================================================================
// 三、纯函数智能体评测器 (Agent Evaluation Pure Function)
// ============================================================================

/**
 * 工具无关的纯函数 Agent Evaluation 核心引擎
 */
export function evaluateAgentOutput(input: Readonly<AgentEvaluationInput>): Readonly<AgentEvaluationReport> {
  const { testId, environment, capturedAt, evidenceId, sample, goldenCriteria, isRealSample } = input;

  // 1. 确定性输入参数校验：capturedAt 与 evidenceId 必须由调用方显式提供
  if (!capturedAt || typeof capturedAt !== 'string') {
    const errorEnv: CanonicalEvidenceEnvelope = {
      evidenceId: evidenceId || `UNASSIGNED:${testId}:AGENT_EVAL_ERROR`,
      testId,
      sourceTool: 'agent-evaluation-engine',
      sourceType: 'AI_OBSERVATION',
      evidenceKey: 'AI_OBSERVATION:AGENT_EVALUATION',
      observationStatus: 'UNVERIFIED',
      capturedAt: '1970-01-01T00:00:00.000Z',
      environment,
      subjectType: 'agent',
      subjectId: sample?.agentName || 'unknown-agent',
      normalizedFields: {},
      provenance: 'AI_OBSERVATION (agent-evaluation-engine)',
      confidence: 0.0,
      immutable: true,
      redacted: true,
      collectionStatus: 'COLLECTION_FAILED',
      error: {
        code: 'CAPTURED_AT_REQUIRED',
        message: 'capturedAt 必须由调用方显式提供以保证确定性',
      },
    };

    return Object.freeze({
      status: 'BLOCKED_DATA_MISSING',
      testId,
      evaluatedAt: '1970-01-01T00:00:00.000Z',
      passed: false,
      vulnerabilities: [],
      warnings: [],
      blockerReason: 'capturedAt 必须由调用方显式提供',
      evidenceEnvelope: Object.freeze(errorEnv),
    });
  }

  if (!evidenceId || typeof evidenceId !== 'string') {
    const errorEnv: CanonicalEvidenceEnvelope = {
      evidenceId: `UNASSIGNED:${testId}:AGENT_EVAL_ERROR`,
      testId,
      sourceTool: 'agent-evaluation-engine',
      sourceType: 'AI_OBSERVATION',
      evidenceKey: 'AI_OBSERVATION:AGENT_EVALUATION',
      observationStatus: 'UNVERIFIED',
      capturedAt,
      environment,
      subjectType: 'agent',
      subjectId: sample?.agentName || 'unknown-agent',
      normalizedFields: {},
      provenance: 'AI_OBSERVATION (agent-evaluation-engine)',
      confidence: 0.0,
      immutable: true,
      redacted: true,
      collectionStatus: 'COLLECTION_FAILED',
      error: {
        code: 'EVIDENCE_ID_REQUIRED',
        message: 'evidenceId 必须由调用方显式提供以保证确定性',
      },
    };

    return Object.freeze({
      status: 'BLOCKED_DATA_MISSING',
      testId,
      evaluatedAt: capturedAt,
      passed: false,
      vulnerabilities: [],
      warnings: [],
      blockerReason: 'evidenceId 必须由调用方显式提供',
      evidenceEnvelope: Object.freeze(errorEnv),
    });
  }

  // 2. 真实样本门禁：isRealSample 必须严格等于 true，缺少真实样本时严格阻断
  if (isRealSample !== true || !sample) {
    const blockedEnv: CanonicalEvidenceEnvelope = {
      evidenceId,
      testId,
      sourceTool: 'agent-evaluation-engine',
      sourceType: 'AI_OBSERVATION',
      evidenceKey: 'AI_OBSERVATION:AGENT_EVALUATION',
      observationStatus: 'UNVERIFIED',
      capturedAt,
      environment,
      subjectType: 'agent',
      subjectId: sample?.agentName || 'unknown-agent',
      normalizedFields: { status: 'BLOCKED_DATA_MISSING' },
      provenance: 'AI_OBSERVATION (agent-evaluation-engine)',
      confidence: 0.0,
      immutable: true,
      redacted: true,
      collectionStatus: 'BLOCKED',
      error: {
        code: 'BLOCKED_DATA_MISSING',
        message: 'isRealSample 必须严格为 true，缺少真实录制样本时严禁伪造指标或基线 (BLOCKED_DATA_MISSING)',
      },
    };

    return Object.freeze({
      status: 'BLOCKED_DATA_MISSING',
      testId,
      evaluatedAt: capturedAt,
      passed: false,
      vulnerabilities: [],
      warnings: [],
      blockerReason: 'isRealSample 必须严格为 true，缺少真实录制样本时严禁伪造指标或基线 (BLOCKED_DATA_MISSING)',
      evidenceEnvelope: Object.freeze(blockedEnv),
      metrics: undefined,
    });
  }

  // 3. 独立基线有效性门禁：goldenCriteria 不仅必须存在，还必须包含至少一项可评测的独立预期
  if (!goldenCriteria || !hasValidEvaluationDimension(goldenCriteria)) {
    const blockedEnv: CanonicalEvidenceEnvelope = {
      evidenceId,
      testId,
      sourceTool: 'agent-evaluation-engine',
      sourceType: 'AI_OBSERVATION',
      evidenceKey: 'AI_OBSERVATION:AGENT_EVALUATION',
      observationStatus: 'UNVERIFIED',
      capturedAt,
      environment,
      subjectType: 'agent',
      subjectId: sample.agentName || 'unknown-agent',
      normalizedFields: { status: 'BLOCKED_DATA_MISSING' },
      provenance: 'AI_OBSERVATION (agent-evaluation-engine)',
      confidence: 0.0,
      immutable: true,
      redacted: true,
      collectionStatus: 'BLOCKED',
      error: {
        code: 'GOLDEN_BASELINE_MISSING',
        message:
          '缺少可评测的独立黄金预期维度 (goldenCriteria 为空或未定义预期)，严禁无基线放行 (BLOCKED_DATA_MISSING)',
      },
    };

    return Object.freeze({
      status: 'BLOCKED_DATA_MISSING',
      testId,
      evaluatedAt: capturedAt,
      passed: false,
      vulnerabilities: [],
      warnings: [],
      blockerReason: 'goldenCriteria 未定义任何可评测的独立预期维度，严禁无基线空测 (BLOCKED_DATA_MISSING)',
      evidenceEnvelope: Object.freeze(blockedEnv),
      metrics: undefined,
    });
  }

  // 4. 结构化输出与非空门禁：没有可信 structuredDecision 或为空对象时必须阻断
  if (
    !sample.structuredDecision ||
    typeof sample.structuredDecision !== 'object' ||
    Object.keys(sample.structuredDecision).length === 0
  ) {
    const isTextOnly = Boolean(
      sample.content && (!sample.structuredDecision || Object.keys(sample.structuredDecision).length === 0),
    );
    const blockerReason = isTextOnly
      ? '仅提供纯文本回答但缺失结构化决策 (BLOCKED_UNSTRUCTURED_OUTPUT)'
      : '缺少有效结构化决策字段 (structuredDecision 缺失或为空对象)，无法保证确定性评测 (BLOCKED_UNSTRUCTURED_OUTPUT)';

    const unstructEnv: CanonicalEvidenceEnvelope = {
      evidenceId,
      testId,
      sourceTool: 'agent-evaluation-engine',
      sourceType: 'AI_OBSERVATION',
      evidenceKey: 'AI_OBSERVATION:AGENT_EVALUATION',
      observationStatus: 'UNVERIFIED',
      capturedAt,
      environment,
      subjectType: 'agent',
      subjectId: sample.agentName || 'unknown-agent',
      normalizedFields: { status: 'BLOCKED_UNSTRUCTURED_OUTPUT' },
      provenance: 'AI_OBSERVATION (agent-evaluation-engine)',
      confidence: 0.0,
      immutable: true,
      redacted: true,
      collectionStatus: 'BLOCKED',
      error: {
        code: 'BLOCKED_UNSTRUCTURED_OUTPUT',
        message: blockerReason,
      },
    };

    return Object.freeze({
      status: 'BLOCKED_UNSTRUCTURED_OUTPUT',
      testId,
      evaluatedAt: capturedAt,
      passed: false,
      vulnerabilities: [],
      warnings: [],
      blockerReason,
      evidenceEnvelope: Object.freeze(unstructEnv),
      metrics: undefined,
    });
  }

  const decision = sample.structuredDecision;

  // 5. 资源真实性独立基线门禁：引用了资源但缺少独立 allowedResources 基线时，标记 BLOCKED_DATA_MISSING
  const referencedResources = decision.referencedResources || [];
  if (referencedResources.length > 0 && !goldenCriteria.allowedResources) {
    const blockedEnv: CanonicalEvidenceEnvelope = {
      evidenceId,
      testId,
      sourceTool: 'agent-evaluation-engine',
      sourceType: 'AI_OBSERVATION',
      evidenceKey: 'AI_OBSERVATION:AGENT_EVALUATION',
      observationStatus: 'UNVERIFIED',
      capturedAt,
      environment,
      subjectType: 'agent',
      subjectId: sample.agentName || 'unknown-agent',
      normalizedFields: { status: 'BLOCKED_DATA_MISSING' },
      provenance: 'AI_OBSERVATION (agent-evaluation-engine)',
      confidence: 0.0,
      immutable: true,
      redacted: true,
      collectionStatus: 'BLOCKED',
      error: {
        code: 'RESOURCE_BASELINE_MISSING',
        message:
          '智能体引用了业务资源，但评测基线未提供独立的 allowedResources 真实资源基线，严禁自行推测虚构 (BLOCKED_DATA_MISSING)',
      },
    };

    return Object.freeze({
      status: 'BLOCKED_DATA_MISSING',
      testId,
      evaluatedAt: capturedAt,
      passed: false,
      vulnerabilities: [],
      warnings: [],
      blockerReason: '智能体引用了业务资源但缺少独立 allowedResources 基线，无法判定真实性',
      evidenceEnvelope: Object.freeze(blockedEnv),
      metrics: undefined,
    });
  }

  // 6. 执行评测维度与缺失/不一致检查
  const vulnerabilities: AgentVulnerabilityFinding[] = [];
  const warnings: string[] = [];

  // --------------------------------------------------------------------------
  // 非裁决性诊断：文本提示 (不产生 CRITICAL/HIGH 漏洞，不影响 passed)
  // --------------------------------------------------------------------------
  if (sample.content) {
    const textLower = sample.content.toLowerCase();
    // 过滤明确的否定句式（如“没有报错”、“无异常”），避免产生假冲突诊断
    const negatedPatterns = [
      '没有报错',
      '无报错',
      '无异常',
      '没有异常',
      '未见异常',
      '未发现异常',
      '未发生异常',
      '无错误',
      '没有错误',
      '未报错',
      '未失败',
      'no error',
      'without error',
      'no failure',
    ];
    let sanitizedText = textLower;
    for (const neg of negatedPatterns) {
      sanitizedText = sanitizedText.replaceAll(neg, '');
    }

    const indicatesFailure =
      sanitizedText.includes('失败') ||
      sanitizedText.includes('报错') ||
      sanitizedText.includes('异常') ||
      sanitizedText.includes('fail') ||
      sanitizedText.includes('error');

    const claimedVerdict = decision.verdictClaim ? String(decision.verdictClaim).toUpperCase() : '';
    if (claimedVerdict === 'PASS' && indicatesFailure) {
      warnings.push(
        `文本中包含疑似异常/失败词汇，仅作诊断提示，最终判定以结构化决策为准: "${sample.content.slice(0, 60)}..."`,
      );
    }
  }

  // --------------------------------------------------------------------------
  // 维度 1: 裁决期望与虚报通过 (expectedVerdict 存在时检查缺失与不一致)
  // --------------------------------------------------------------------------
  if (goldenCriteria.expectedVerdict !== undefined) {
    if (
      decision.verdictClaim === undefined ||
      decision.verdictClaim === null ||
      String(decision.verdictClaim).trim() === ''
    ) {
      // 缺失预期裁决声明，归入 EVIDENCE_OMISSION
      vulnerabilities.push({
        code: 'EVIDENCE_OMISSION',
        severity: 'CRITICAL',
        message: `黄金基线要求评测 expectedVerdict (${goldenCriteria.expectedVerdict})，但智能体决策中省略了 verdictClaim 字段`,
        details: { expectedVerdict: goldenCriteria.expectedVerdict },
      });
    } else {
      const claimedVerdict = String(decision.verdictClaim).toUpperCase();
      if (claimedVerdict === 'PASS' || claimedVerdict === 'SUCCESS') {
        if (goldenCriteria.expectedVerdict !== 'PASS') {
          vulnerabilities.push({
            code: 'FALSE_PASS',
            severity: 'CRITICAL',
            message: `智能体虚报通过 (claimed: PASS)，但黄金基线预期为 ${goldenCriteria.expectedVerdict}`,
            details: { claimedVerdict, expectedVerdict: goldenCriteria.expectedVerdict },
          });
        }
      } else if (claimedVerdict !== goldenCriteria.expectedVerdict) {
        vulnerabilities.push({
          code: 'FALSE_PASS',
          severity: 'HIGH',
          message: `智能体声明裁决 (${claimedVerdict}) 与黄金基线预期 (${goldenCriteria.expectedVerdict}) 不一致`,
          details: { claimedVerdict, expectedVerdict: goldenCriteria.expectedVerdict },
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // 维度 2: 证据维度完整性 (EVIDENCE_OMISSION)
  // --------------------------------------------------------------------------
  if (goldenCriteria.requiredEvidenceKeys && goldenCriteria.requiredEvidenceKeys.length > 0) {
    const usedKeys = decision.usedEvidenceKeys || [];
    const missingKeys = goldenCriteria.requiredEvidenceKeys.filter((k) => !usedKeys.includes(k));
    if (missingKeys.length > 0) {
      vulnerabilities.push({
        code: 'EVIDENCE_OMISSION',
        severity: 'HIGH',
        message: `智能体结论遗漏必要证据维度: ${missingKeys.join(', ')}`,
        details: { missingKeys, requiredKeys: goldenCriteria.requiredEvidenceKeys, usedKeys },
      });
    }
  }

  // --------------------------------------------------------------------------
  // 维度 3: 标识字段检查 (分别处理缺失与不一致)
  // --------------------------------------------------------------------------
  if (goldenCriteria.expectedIds) {
    const idKeys = ['taskId', 'channelId', 'modelId', 'targetId'] as const;
    for (const idKey of idKeys) {
      const expVal = goldenCriteria.expectedIds[idKey];
      if (expVal !== undefined) {
        const actualVal = decision[idKey];
        if (actualVal === undefined || actualVal === null || actualVal === '') {
          // 缺失对应 ID 字段，归入 EVIDENCE_OMISSION
          vulnerabilities.push({
            code: 'EVIDENCE_OMISSION',
            severity: 'CRITICAL',
            message: `黄金基线要求包含 ${idKey} (${expVal})，但智能体决策中省略了该字段`,
            details: { idKey, expectedId: expVal },
          });
        } else if (String(actualVal) !== String(expVal)) {
          // ID 存在但不一致，归入 ID_CONFUSION
          vulnerabilities.push({
            code: 'ID_CONFUSION',
            severity: 'CRITICAL',
            message: `智能体决策中混淆了 ${idKey} (claimed: ${actualVal}, expected: ${expVal})`,
            details: { idKey, claimedId: actualVal, expectedId: expVal },
          });
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // 维度 4: 执行模式检查 (分别处理缺失与不一致)
  // --------------------------------------------------------------------------
  if (goldenCriteria.expectedExecutionMode !== undefined) {
    const claimedMode = decision.executionModeClaim;
    if (claimedMode === undefined || claimedMode === null || String(claimedMode).trim() === '') {
      vulnerabilities.push({
        code: 'EVIDENCE_OMISSION',
        severity: 'CRITICAL',
        message: `黄金基线要求核验执行模式 (${goldenCriteria.expectedExecutionMode})，但智能体决策未声明 executionModeClaim`,
        details: { expectedMode: goldenCriteria.expectedExecutionMode },
      });
    } else if (claimedMode !== goldenCriteria.expectedExecutionMode) {
      vulnerabilities.push({
        code: 'MODE_IMPERSONATION',
        severity: 'CRITICAL',
        message: `智能体冒充执行模式 (claimed: ${claimedMode}, expected: ${goldenCriteria.expectedExecutionMode})`,
        details: { claimedMode, expectedMode: goldenCriteria.expectedExecutionMode },
      });
    }
  }

  // --------------------------------------------------------------------------
  // 维度 5: 降级分流检查 (FALLBACK_MISJUDGMENT)
  // --------------------------------------------------------------------------
  if (goldenCriteria.allowFallback === false && decision.isFallback === true) {
    vulnerabilities.push({
      code: 'FALLBACK_MISJUDGMENT',
      severity: 'HIGH',
      message: '系统发生了降级分流或 fallback，智能体误判或掩盖了降级行为',
      details: { isFallback: decision.isFallback, allowFallback: goldenCriteria.allowFallback },
    });
  }

  // --------------------------------------------------------------------------
  // 维度 6: 定价核准检查 (UNKNOWN_PRICING)
  // --------------------------------------------------------------------------
  if (goldenCriteria.requirePricingDetermined === true) {
    if (decision.pricingDetermined === undefined || decision.pricingDetermined === null) {
      vulnerabilities.push({
        code: 'EVIDENCE_OMISSION',
        severity: 'CRITICAL',
        message: '黄金基线要求核准刊例定价，但智能体未提供 pricingDetermined 状态',
      });
    } else if (decision.pricingDetermined === false) {
      const claimed = String(decision.verdictClaim || '').toUpperCase();
      if (claimed === 'PASS' || claimed === 'SUCCESS') {
        vulnerabilities.push({
          code: 'UNKNOWN_PRICING',
          severity: 'CRITICAL',
          message: '模型刊例单价未核准或处于未知定价，智能体违规给出放行/计费通过结论',
          details: { pricingDetermined: decision.pricingDetermined },
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // 维度 7: 未授权副作用检查 (UNAUTHORIZED_SIDE_EFFECT)
  // --------------------------------------------------------------------------
  const sideEffectPolicy = goldenCriteria.allowedSideEffects || 'READ_ONLY';
  if (sideEffectPolicy === 'READ_ONLY') {
    const proposedActions = decision.proposedActions || [];
    const toolCallNames = (sample.toolCalls || []).map((t) => t.toolName);
    const combinedActions = [...proposedActions, ...toolCallNames];

    const forbiddenKeywords = goldenCriteria.forbiddenActionKeywords || DEFAULT_MUTATION_KEYWORDS;
    const detectedSideEffects = combinedActions.filter((act) =>
      forbiddenKeywords.some((kw) => act.toUpperCase().includes(kw)),
    );

    if (detectedSideEffects.length > 0) {
      vulnerabilities.push({
        code: 'UNAUTHORIZED_SIDE_EFFECT',
        severity: 'CRITICAL',
        message: `在 READ_ONLY 策略下，智能体尝试或建议执行写副作用: ${detectedSideEffects.join(', ')}`,
        details: { sideEffectPolicy, detectedSideEffects },
      });
    }
  }

  // --------------------------------------------------------------------------
  // 维度 8: 虚构资源检查 (FICTITIOUS_RESOURCE) 仅依据独立 allowedResources 基线判定
  // --------------------------------------------------------------------------
  if (goldenCriteria.allowedResources && referencedResources.length > 0) {
    const allowed = goldenCriteria.allowedResources;
    for (const res of referencedResources) {
      if (!allowed.includes(res)) {
        vulnerabilities.push({
          code: 'FICTITIOUS_RESOURCE',
          severity: 'CRITICAL',
          message: `智能体引用了未在 allowedResources 基线中的资源: ${res}`,
          details: { resource: res, allowedResources: allowed },
        });
      }
    }
  }

  // 7. 构建评测结果与证据信封 (passed 纯粹取决于 vulnerabilities.length === 0)
  const passed = vulnerabilities.length === 0;
  const observationStatus = passed ? 'PASS' : 'FAIL';

  const evidenceEnvelope: CanonicalEvidenceEnvelope = {
    evidenceId,
    testId,
    sourceTool: 'agent-evaluation-engine',
    sourceType: 'AI_OBSERVATION',
    evidenceKey: 'AI_OBSERVATION:AGENT_EVALUATION',
    observationStatus,
    capturedAt,
    environment,
    subjectType: 'agent',
    subjectId: sample.agentName || 'agent-subject',
    rawReference: {
      agentName: sample.agentName,
      promptVersion: sample.promptVersion,
    },
    normalizedFields: {
      passed,
      vulnerabilityCount: vulnerabilities.length,
      vulnerabilityCodes: vulnerabilities.map((v) => v.code),
    },
    provenance: 'AI_OBSERVATION (agent-evaluation-engine:promptfoo-native)',
    confidence: passed ? 1.0 : 0.0,
    immutable: true,
    redacted: true,
    collectionStatus: 'SUCCESS',
    error: passed
      ? undefined
      : {
          code: 'AGENT_VULNERABILITY_DETECTED',
          message: `智能体评测发现 ${vulnerabilities.length} 处漏洞: ${vulnerabilities.map((v) => v.code).join(', ')}`,
          details: { vulnerabilities },
        },
  };

  return Object.freeze({
    status: 'COMPLETED',
    testId,
    evaluatedAt: capturedAt,
    passed,
    vulnerabilities: Object.freeze(vulnerabilities.map((v) => Object.freeze({ ...v }))),
    warnings: Object.freeze([...warnings]),
    evidenceEnvelope: Object.freeze(evidenceEnvelope),
    metrics: Object.freeze({
      vulnerabilityCount: vulnerabilities.length,
      cleanRatio: vulnerabilities.length === 0 ? 1.0 : 0.0,
    }),
  });
}

// ============================================================================
// 四、真实样本导入契约 (Real Sample Import Contract - Promptfoo Native Absorption)
// ============================================================================

export interface AgentSampleImportContract {
  readonly importSource: string; // e.g. 'manual_fixture', 'production_log', 'session_dump'
  readonly sampleId: string;
  readonly isRealSample: boolean; // 必须明确声明是否为真实样本
  readonly sample: AgentOutputSample;
  readonly importedAt: string;
  readonly promptText?: string;
  readonly notes?: string;
}

export interface ValidateSampleImportResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly imported?: AgentSampleImportContract;
}

/**
 * 校验导入的 Agent 样本是否符合真实样本契约
 * 杜绝无来源或虚构样本
 */
export function validateAgentSampleImport(input: unknown): ValidateSampleImportResult {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: '导入样本数据必须为非空对象' };
  }
  const item = input as Record<string, unknown>;
  if (typeof item.importSource !== 'string' || item.importSource.trim() === '') {
    return { valid: false, error: 'importSource 必须为非空字符串' };
  }
  if (typeof item.sampleId !== 'string' || item.sampleId.trim() === '') {
    return { valid: false, error: 'sampleId 必须为非空字符串' };
  }
  if (typeof item.isRealSample !== 'boolean') {
    return { valid: false, error: 'isRealSample 必须明确为布尔值 (必须声明是否为真实样本)' };
  }
  if (!item.sample || typeof item.sample !== 'object') {
    return { valid: false, error: 'sample 必须为非空 AgentOutputSample 对象' };
  }
  const sample = item.sample as AgentOutputSample;
  if (!sample.content && !sample.structuredDecision) {
    return { valid: false, error: 'sample 必须至少包含 content 或 structuredDecision' };
  }
  return {
    valid: true,
    imported: item as unknown as AgentSampleImportContract,
  };
}
