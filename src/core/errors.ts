/** 跨 API、Agent、LLM 与执行层共用的机器可读错误码。 */
export const ErrorCode = {
  AUTH_FAILED: 'AUTH_FAILED',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
  AUTH_DISABLED: 'AUTH_DISABLED',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT',
  EXECUTION_CANCELLED: 'EXECUTION_CANCELLED',
  INVALID_TESTCASE: 'INVALID_TESTCASE',
  LLM_RATE_LIMIT: 'LLM_RATE_LIMIT',
  LLM_FAILURE: 'LLM_FAILURE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_JSON: 'INVALID_JSON',
  REQUEST_TOO_LARGE: 'REQUEST_TOO_LARGE',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  AUTH_FAILED: 401,
  AUTH_FORBIDDEN: 403,
  AUTH_DISABLED: 501,
  POLICY_BLOCKED: 403,
  BUDGET_EXCEEDED: 429,
  EXECUTION_TIMEOUT: 504,
  EXECUTION_CANCELLED: 409,
  INVALID_TESTCASE: 422,
  LLM_RATE_LIMIT: 429,
  LLM_FAILURE: 502,
  VALIDATION_ERROR: 400,
  INVALID_JSON: 400,
  REQUEST_TOO_LARGE: 413,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export const ERROR_PUBLIC_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  AUTH_FAILED: '身份认证失败',
  AUTH_FORBIDDEN: '没有权限执行此操作',
  AUTH_DISABLED: '认证服务未启用',
  POLICY_BLOCKED: '执行已被安全策略阻断',
  BUDGET_EXCEEDED: '执行预算已用尽',
  EXECUTION_TIMEOUT: '执行超时',
  EXECUTION_CANCELLED: '执行已取消',
  INVALID_TESTCASE: '测试用例不合法',
  LLM_RATE_LIMIT: '模型服务请求过于频繁',
  LLM_FAILURE: '模型服务暂时不可用',
  VALIDATION_ERROR: '请求参数不合法',
  INVALID_JSON: '请求体不是合法 JSON',
  REQUEST_TOO_LARGE: '请求体过大',
  NOT_FOUND: '请求的资源不存在',
  CONFLICT: '资源状态冲突',
  RATE_LIMITED: '请求过于频繁',
  SERVICE_UNAVAILABLE: '服务暂时不可用',
  INTERNAL_ERROR: '服务器内部错误',
};

export interface CodedErrorOptions {
  cause?: unknown;
  /** 是否允许把 message 作为 API 文案；false 时 API 只返回该 code 的公共文案。 */
  expose?: boolean;
  /** 结构化诊断数据；写 API/日志前仍必须脱敏。 */
  details?: unknown;
}

/** 领域层统一错误；禁止调用方再从 message 反推类型。 */
export class CodedError extends Error {
  readonly code: ErrorCode;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(code: ErrorCode, message = ERROR_PUBLIC_MESSAGES[code], options: CodedErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CodedError';
    this.code = code;
    this.expose = options.expose ?? true;
    this.details = options.details;
  }
}

/** API 边界错误；HTTP status 只能由 ErrorCode 映射产生。 */
export class HttpError extends CodedError {
  readonly status: number;

  constructor(code: ErrorCode, message = ERROR_PUBLIC_MESSAGES[code], options: CodedErrorOptions = {}) {
    super(code, message, options);
    this.name = 'HttpError';
    this.status = ERROR_HTTP_STATUS[code];
  }
}

export function toHttpError(error: unknown, fallbackCode: ErrorCode = ErrorCode.INTERNAL_ERROR): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof CodedError) {
    return new HttpError(error.code, error.message, {
      cause: error,
      expose: error.expose,
      details: error.details,
    });
  }
  return new HttpError(fallbackCode, ERROR_PUBLIC_MESSAGES[fallbackCode], {
    cause: error,
    expose: false,
  });
}
