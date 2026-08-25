import { describe, expect, it } from 'vitest';
import {
  ERROR_HTTP_STATUS,
  ErrorCode,
  CodedError,
  HttpError,
  toHttpError,
} from '../../src/core/errors.js';
import { BudgetExceededError } from '../../src/agents/observability/usage-meter.js';
import { ExecutionAbortError } from '../../src/core/abort.js';
import { LLMError } from '../../src/llm/llm-errors.js';
import { validateTestCase } from '../../src/agents/test-design/testcase-schema.js';

describe('ErrorCode / HttpError 统一契约', () => {
  it.each([
    [ErrorCode.AUTH_FAILED, 401],
    [ErrorCode.POLICY_BLOCKED, 403],
    [ErrorCode.BUDGET_EXCEEDED, 429],
    [ErrorCode.EXECUTION_TIMEOUT, 504],
    [ErrorCode.INVALID_TESTCASE, 422],
    [ErrorCode.LLM_RATE_LIMIT, 429],
  ] as const)('%s 唯一映射为 HTTP %i', (code, status) => {
    expect(ERROR_HTTP_STATUS[code]).toBe(status);
    expect(new HttpError(code).status).toBe(status);
  });

  it('领域异常携带稳定机器码', async () => {
    expect(new BudgetExceededError(['maxTokens']).code).toBe(ErrorCode.BUDGET_EXCEEDED);
    expect(new ExecutionAbortError('TIMEOUT', 'timeout').code).toBe(ErrorCode.EXECUTION_TIMEOUT);
    expect(new LLMError('rate limited', {
      kind: 'http', status: 429, message: 'rate limited',
    }).code).toBe(ErrorCode.LLM_RATE_LIMIT);

    await expect(validateTestCase({})).rejects.toMatchObject({ code: ErrorCode.INVALID_TESTCASE });
  });

  it('CodedError 保留 code；普通错误无论文案如何都固定为 INTERNAL_ERROR/500', () => {
    expect(toHttpError(new CodedError(ErrorCode.POLICY_BLOCKED, 'blocked'))).toMatchObject({
      code: ErrorCode.POLICY_BLOCKED,
      status: 403,
    });
    expect(toHttpError(new Error('无权访问；资源不存在；HTTP 429'))).toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
      status: 500,
      expose: false,
    });
  });
});
