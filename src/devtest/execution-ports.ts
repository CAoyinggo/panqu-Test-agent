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

import { existsSync } from 'node:fs';
import { loadPanquSession, submitMediaTask } from './media-flow.js';
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
export const FORBIDDEN_VERDICT_FIELDS = ['verdict', 'acceptance', 'passed', 'businessPass', 'finalStatus'] as const;

export type ForbiddenVerdictField = (typeof FORBIDDEN_VERDICT_FIELDS)[number];

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
    context: EvidenceProducerContext,
  ): CanonicalEvidenceEnvelope[] | Promise<CanonicalEvidenceEnvelope[]>;
}

// ============================================================================
// 适配器执行结果防御性校验纯函数 (Fail-Closed)
// ============================================================================

/**
 * 校验适配器执行结果
 * 核心不变量：严禁适配器包含任何 verdict/passed/acceptance 等业务裁决字段
 */
export function validateExecutionResult(result: unknown): ExecutionResult {
  if (!result || typeof result !== 'object') {
    throw new Error('validateExecutionResult: 适配器输出必须为有效对象');
  }

  const res = result as Record<string, unknown>;

  // 严格拦截黑名单裁决字段
  for (const field of FORBIDDEN_VERDICT_FIELDS) {
    if (field in res && res[field] !== undefined) {
      throw new Error(
        `ADAPTER_ILLEGAL_VERDICT_FIELD: 适配器输出禁止包含业务裁决字段 "${field}"，唯一裁决权威归属于 CanonicalVerdictEngine`,
      );
    }
  }

  if (typeof res.executionId !== 'string' || res.executionId.trim() === '') {
    throw new Error('validateExecutionResult: executionId 必须为非空字符串');
  }
  if (typeof res.testId !== 'string' || res.testId.trim() === '') {
    throw new Error('validateExecutionResult: testId 必须为非空字符串');
  }

  const validStatuses: ExecutionStatus[] = ['SUBMITTED', 'COMPLETED', 'FAILED', 'BLOCKED'];
  if (!validStatuses.includes(res.status as ExecutionStatus)) {
    throw new Error(`validateExecutionResult: 非法执行状态 "${String(res.status)}"`);
  }

  if (!Array.isArray(res.evidence)) {
    throw new Error('validateExecutionResult: evidence 必须为 CanonicalEvidenceEnvelope 数组');
  }

  return result as ExecutionResult;
}

// ============================================================================
// 生产环境 API / Panqu Media 标准执行适配器
// ============================================================================

export interface PanquMediaExecutionAdapterOptions {
  readonly submitHandler?: (
    spec: Readonly<CanonicalTestSpec>,
    context?: Record<string, unknown>,
  ) => Promise<{ taskId?: number; points?: number; rawResponse?: Record<string, unknown>; message?: string }>;
  readonly sessionFile?: string;
  readonly env?: 'test' | 'preonline';
  readonly enableLiveSubmit?: boolean;
}

export type PanquSessionEnvironment = 'test' | 'preonline';

export type EnvironmentMappingResult =
  | { readonly ok: true; readonly env: PanquSessionEnvironment }
  | { readonly ok: false; readonly error: string; readonly blockerCode: 'BLOCKED_UNKNOWN_ENVIRONMENT' };

/**
 * 显式、穷尽的纯映射函数：将 Canonical TestSpec 的 environment 映射为 Panqu Session 的网络环境枚举
 * 严禁默认指向 test、preonline 或 production，未知环境一律 fail-closed
 */
export function mapCanonicalEnvironmentToPanquSessionEnv(environment: unknown): EnvironmentMappingResult {
  if (typeof environment !== 'string' || environment.trim() === '') {
    return {
      ok: false,
      error: 'BLOCKED_UNKNOWN_ENVIRONMENT: spec.environment 不能为空，拒绝推测执行环境 [FAIL_CLOSED]',
      blockerCode: 'BLOCKED_UNKNOWN_ENVIRONMENT',
    };
  }

  const normalized = environment.trim().toLowerCase();
  switch (normalized) {
    case 'test':
      return { ok: true, env: 'test' };
    case 'preonline':
      return { ok: true, env: 'preonline' };
    default:
      return {
        ok: false,
        error: `BLOCKED_UNKNOWN_ENVIRONMENT: 未知或不受支持的执行环境 "${environment}"，Panqu 网络执行环境仅支持显式穷尽白名单 ('test', 'preonline')，严禁默认指向 test/preonline/production [FAIL_CLOSED]`,
        blockerCode: 'BLOCKED_UNKNOWN_ENVIRONMENT',
      };
  }
}

export class PanquMediaExecutionAdapter implements ExecutionAdapter {
  readonly adapterName = 'panqu-media-execution-adapter';
  readonly supportedModes: readonly ExecutionMode[] = ['REAL', 'OFFLINE'];
  readonly supportedSideEffectPolicies: readonly SideEffectPolicy[] = ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'];

  private readonly submitHandler?: PanquMediaExecutionAdapterOptions['submitHandler'];
  private readonly sessionFile?: string;
  private readonly enableLiveSubmit: boolean;

  constructor(options?: PanquMediaExecutionAdapterOptions) {
    this.submitHandler = options?.submitHandler;
    this.sessionFile = options?.sessionFile;
    this.enableLiveSubmit = options?.enableLiveSubmit ?? false;
  }

  async execute(spec: Readonly<CanonicalTestSpec>, context?: Record<string, unknown>): Promise<ExecutionResult> {
    const startedAt = (context?.startedAt as string) || new Date().toISOString();
    const executionId = (context?.executionId as string) || `exec-${spec.testId}-${Date.now()}`;

    // 1. 模式支持性门禁 (Fail-Closed)
    if (!this.supportedModes.includes(spec.executionMode)) {
      const completedAt = (context?.completedAt as string) || new Date().toISOString();
      return validateExecutionResult({
        executionId,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt,
        completedAt,
        error: {
          code: 'UNSUPPORTED_EXECUTION_MODE',
          message: `PanquMediaExecutionAdapter 不支持模式: ${spec.executionMode}`,
        },
      });
    }

    // 2. 副作用与成本策略门禁 (Fail-Closed)
    if (spec.executionMode === 'REAL') {
      if (spec.sideEffectPolicy === 'READ_ONLY') {
        const completedAt = (context?.completedAt as string) || new Date().toISOString();
        return validateExecutionResult({
          executionId,
          testId: spec.testId,
          status: 'BLOCKED',
          evidence: [],
          startedAt,
          completedAt,
          error: {
            code: 'READ_ONLY_POLICY_VIOLATION',
            message: 'REAL 执行模式下 sideEffectPolicy 为 READ_ONLY，已安全阻断提交',
          },
        });
      }
    }

    // 2.5. 环境枚举门禁 (Fail-Closed)
    // 执行环境、网络目标必须完全来自 spec.environment，禁止默认指向 test/preonline/production
    const isKnownEnv =
      spec.executionMode === 'REAL'
        ? spec.environment === 'test' || spec.environment === 'preonline'
        : spec.environment === 'test' || spec.environment === 'preonline' || spec.environment === 'offline';
    if (!isKnownEnv) {
      const completedAt = (context?.completedAt as string) || new Date().toISOString();
      return validateExecutionResult({
        executionId,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt,
        completedAt,
        error: {
          code: 'BLOCKED_UNKNOWN_ENVIRONMENT',
          message: `PanquMediaExecutionAdapter 不支持未知执行环境: "${spec.environment}" (模式: ${spec.executionMode})，严禁默认指向 test/preonline/production [FAIL_CLOSED]`,
        },
      });
    }

    // 3. 自定义/注入的 submitHandler 派发
    if (this.submitHandler) {
      try {
        const submitRes = await this.submitHandler(spec, context);
        const completedAt = (context?.completedAt as string) || new Date().toISOString();
        const isSubmitted = typeof submitRes.taskId === 'number' && submitRes.taskId > 0;
        const evidence: CanonicalEvidenceEnvelope[] = [];
        if (isSubmitted) {
          evidence.push({
            evidenceId: `${spec.testId}-user-receipt`,
            testId: spec.testId,
            sourceTool: this.adapterName,
            sourceType: 'USER_ASSERTION',
            evidenceKey: 'USER_ASSERTION:TASK_SUBMISSION_RECEIPT',
            observationStatus: 'UNVERIFIED',
            capturedAt: completedAt,
            environment: spec.environment,
            subjectType: 'task',
            subjectId: submitRes.taskId!,
            normalizedFields: {
              taskId: submitRes.taskId,
              lifecycleStatus: 'SUBMITTED',
              points: submitRes.points,
              message: submitRes.message,
            },
            provenance: `${this.adapterName}:CUSTOM_SUBMIT_HANDLER_ASSERTION`,
            confidence: 1.0,
            immutable: true,
            redacted: true,
            collectionStatus: 'SUCCESS',
          });
        }
        return validateExecutionResult({
          executionId,
          testId: spec.testId,
          status: isSubmitted ? 'SUBMITTED' : 'FAILED',
          evidence,
          startedAt,
          completedAt,
          error: isSubmitted
            ? undefined
            : {
                code: 'FAILED_SUBMIT',
                message: submitRes.message || '任务提交未成功',
              },
          metadata: {
            taskId: submitRes.taskId,
            points: submitRes.points,
            rawResponse: submitRes.rawResponse,
            message: submitRes.message,
          },
        });
      } catch (err) {
        const completedAt = (context?.completedAt as string) || new Date().toISOString();
        return validateExecutionResult({
          executionId,
          testId: spec.testId,
          status: 'FAILED',
          evidence: [],
          startedAt,
          completedAt,
          error: {
            code: 'ADAPTER_EXECUTION_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // 4. 真实服务端网络提交能力 (迁移自 core-kernel，严格内聚在 Adapter)
    if (this.enableLiveSubmit && spec.executionMode === 'REAL') {
      const sessionFilePath =
        (context?.sessionFile as string) ||
        this.sessionFile ||
        (!process.env.VITEST
          ? process.env.PANQU_SESSION_COOKIES_FILE ||
            (existsSync('session.json')
              ? 'session.json'
              : existsSync('.panqu/session.json')
                ? '.panqu/session.json'
                : undefined)
          : undefined);

      if (!sessionFilePath) {
        const completedAt = (context?.completedAt as string) || new Date().toISOString();
        return validateExecutionResult({
          executionId,
          testId: spec.testId,
          status: 'FAILED',
          evidence: [],
          startedAt,
          completedAt,
          error: {
            code: 'SESSION_NOT_FOUND',
            message:
              '真实执行必须提供有效的 sessionFile 会话凭据文件（或在项目根目录放置 session.json / .panqu/session.json）',
          },
        });
      }

      try {
        const envResolution = mapCanonicalEnvironmentToPanquSessionEnv(spec.environment);
        if (!envResolution.ok) {
          const completedAt = (context?.completedAt as string) || new Date().toISOString();
          return validateExecutionResult({
            executionId,
            testId: spec.testId,
            status: 'BLOCKED',
            evidence: [],
            startedAt,
            completedAt,
            error: {
              code: envResolution.blockerCode,
              message: envResolution.error,
            },
          });
        }
        const session = await loadPanquSession(sessionFilePath, envResolution.env);
        if (
          !session.project_id ||
          typeof session.project_id !== 'number' ||
          !Number.isInteger(session.project_id) ||
          session.project_id <= 0
        ) {
          const completedAt = (context?.completedAt as string) || new Date().toISOString();
          return validateExecutionResult({
            executionId,
            testId: spec.testId,
            status: 'BLOCKED',
            evidence: [],
            startedAt,
            completedAt,
            error: {
              code: 'BLOCKED_INVALID_PROJECT_ID',
              message: 'Session 缺失有效正整数 project_id，拒绝回退默认项目执行 [BLOCKED]',
            },
          });
        }

        const mediaType = (spec.inputs?.mediaType as 'video' | 'image') || 'video';
        const modelId = Number(spec.target?.modelId || 84);
        const prompt = (spec.inputs?.prompt as string) || '';
        const resolution = (spec.inputs?.resolution as string) || '720p';
        const duration = typeof spec.inputs?.duration === 'number' ? spec.inputs.duration : 4;
        const aspectRatio = spec.inputs?.aspectRatio as string | undefined;
        const serviceline = spec.inputs?.serviceline as string | undefined;
        const extraParams = spec.inputs?.extraParams as Record<string, string> | undefined;
        const effectiveAlias = (spec.metadata?.alias as string) || undefined;

        const res = await submitMediaTask({
          baseUrl: session.base_url,
          cookies: session.cookie_string,
          csrfToken: session.csrf_token,
          projectId: session.project_id,
          mediaType,
          modelId,
          prompt,
          resolution,
          duration,
          aspectRatio,
          serviceline,
          extraParams,
          alias: effectiveAlias,
        });

        const completedAt = (context?.completedAt as string) || new Date().toISOString();
        const isBlocked = res.message.includes('BLOCKED') || res.message.includes('CSRF');

        if (!res.ok) {
          return validateExecutionResult({
            executionId,
            testId: spec.testId,
            status: isBlocked ? 'BLOCKED' : 'FAILED',
            evidence: [],
            startedAt,
            completedAt,
            error: {
              code: isBlocked ? 'BLOCKED_SUBMIT' : 'FAILED_SUBMIT',
              message: res.message,
            },
            metadata: {
              rawResponse: res.rawResponse,
            },
          });
        }

        const evidence: CanonicalEvidenceEnvelope[] = [
          {
            evidenceId: `${spec.testId}-live-receipt`,
            testId: spec.testId,
            sourceTool: this.adapterName,
            sourceType: 'SERVER_API',
            evidenceKey: 'SERVER_API:TASK_SUBMISSION_RECEIPT',
            observationStatus: 'UNVERIFIED',
            capturedAt: completedAt,
            environment: spec.environment,
            subjectType: 'task',
            subjectId: res.taskId,
            normalizedFields: {
              taskId: res.taskId,
              lifecycleStatus: 'SUBMITTED',
              message: res.message,
            },
            provenance: `${this.adapterName}:LIVE_SUBMIT_RECEIPT`,
            confidence: 1.0,
            immutable: true,
            redacted: true,
            collectionStatus: 'SUCCESS',
          },
        ];

        return validateExecutionResult({
          executionId,
          testId: spec.testId,
          status: 'SUBMITTED',
          evidence,
          startedAt,
          completedAt,
          metadata: {
            taskId: res.taskId,
            rawResponse: res.rawResponse,
            credentialsMasked: session.cookie_string.replace(/=[^;]+/g, '=***'),
            message: res.message,
          },
        });
      } catch (err) {
        const completedAt = (context?.completedAt as string) || new Date().toISOString();
        return validateExecutionResult({
          executionId,
          testId: spec.testId,
          status: 'FAILED',
          evidence: [],
          startedAt,
          completedAt,
          error: {
            code: 'ADAPTER_EXECUTION_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // 5. 生产 Adapter 缺少真实执行器时的严格防御门禁 (Requirement 4)
    // 严禁根据 context.taskId 构造 SUBMITTED，严禁伪造 COMPLETED，严禁生成模拟任务 ID
    const completedAt = (context?.completedAt as string) || new Date().toISOString();
    if (spec.executionMode === 'REAL') {
      return validateExecutionResult({
        executionId,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt,
        completedAt,
        error: {
          code: 'BLOCKED_NO_EXECUTOR',
          message: 'PanquMediaExecutionAdapter 缺少真实执行器/submitHandler，拒绝伪造真实提交',
        },
      });
    }

    // OFFLINE 模式无真实 handler 时，只允许返回明确的 DRY_RUN 未执行状态
    return validateExecutionResult({
      executionId,
      testId: spec.testId,
      status: 'BLOCKED',
      evidence: [],
      startedAt,
      completedAt,
      error: {
        code: 'OFFLINE_DRY_RUN',
        message: 'OFFLINE 模式未提供执行器，处于未执行 DRY_RUN 状态，严禁冒充真实任务提交',
      },
    });
  }
}
