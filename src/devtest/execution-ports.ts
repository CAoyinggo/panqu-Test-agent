/**
 * Panqu AI DevTest — ExecutionAdapter & EvidenceProducer Standard Ports
 * Phase 1.2 最小标准端口接口定义
 *
 * 核心架构约束 (遵循 docs/ARCHITECTURE_FREEZE.md 受控扩展原则):
 * 1. 适配器只能负责执行操作或采集证据，绝对不得拥有最终裁决权；
 * 2. 严禁在端口输入输出中引入 verdict, acceptance, passed, businessPass, finalStatus 等第二套裁决字段；
 * 3. 适配器必须可开关、可替换、可单测、可删除；
 * 4. 执行前必须校验 executionMode、sideEffectPolicy、costLimit，不支持时严格 fail-closed 返回 BLOCKED。
 */

import type {
  CanonicalTestSpec,
  CanonicalEvidenceEnvelope,
  ExecutionMode,
  SideEffectPolicy,
  EvidenceSourceType,
} from './canonical-protocol.js';

export type ExecutionStatus = 'SUBMITTED' | 'COMPLETED' | 'FAILED' | 'BLOCKED';

export interface ExecutionError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * 适配器执行结果契约
 * 仅表达执行层生命周期与产出的证据信封，严禁承载最终验收裁决
 */
export interface ExecutionResult {
  executionId: string;
  testId: string;
  status: ExecutionStatus;
  evidence: CanonicalEvidenceEnvelope[];
  startedAt: string; // ISO 8601
  completedAt: string; // ISO 8601
  error?: ExecutionError;
  metadata?: Record<string, unknown>;
}

// 严禁存在于适配器输出中的第二套裁决字段黑名单
export const FORBIDDEN_VERDICT_FIELDS = [
  'verdict',
  'acceptance',
  'passed',
  'businessPass',
  'finalStatus',
] as const;

export type ForbiddenVerdictField = typeof FORBIDDEN_VERDICT_FIELDS[number];

/**
 * ExecutionAdapter 最小标准端口
 */
export interface ExecutionAdapter {
  readonly adapterName: string;
  readonly supportedModes: readonly ExecutionMode[];
  readonly supportedSideEffectPolicies: readonly SideEffectPolicy[];
  execute(spec: Readonly<CanonicalTestSpec>, context?: Record<string, unknown>): Promise<ExecutionResult>;
}

/**
 * EvidenceProducer 上下文契约
 */
export interface EvidenceProducerContext {
  testId: string;
  environment: string;
  subjectType: string;
  subjectId: string | number;
  [key: string]: unknown;
}

/**
 * EvidenceProducer 最小标准端口
 */
export interface EvidenceProducer {
  readonly producerName: string;
  readonly sourceType: EvidenceSourceType;
  produce(
    rawCollection: unknown,
    context: EvidenceProducerContext
  ): CanonicalEvidenceEnvelope[] | Promise<CanonicalEvidenceEnvelope[]>;
}
