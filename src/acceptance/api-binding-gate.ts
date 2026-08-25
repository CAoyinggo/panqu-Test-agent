import type { TestCase, TestStep } from '../agents/test-design/testcase-schema.js';
import type { ApiSpec } from './requirement-ir.js';
import type { ParameterSpec } from './requirement-ir.js';

export type ApiBindingGateCode =
  | 'BINDING_MISSING'
  | 'API_NOT_FOUND'
  | 'BINDING_AMBIGUOUS'
  | 'BINDING_MISMATCH'
  | 'PATH_PARAMETER_MISSING'
  | 'QUERY_PARAMETER_MISSING'
  | 'HEADER_MISSING'
  | 'BODY_MISMATCH';

export type ApiBindingGateResult =
  | { valid: true; apiSpecId: string; apiSpec: ApiSpec }
  | { valid: false; apiSpecId?: string; code: ApiBindingGateCode; message: string };

function hasOwn(record: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, name)
    && record[name] !== undefined;
}

function hasValue(record: Record<string, unknown>, name: string): boolean {
  return hasOwn(record, name) && record[name] !== null;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.entries(headers).some(([key, value]) => key.toLowerCase() === wanted && value.trim() !== '');
}

function pathTemplateParameters(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function valueMatchesParameter(value: unknown, parameter: ParameterSpec, serialized = false): boolean {
  if (value === null) return parameter.nullable;
  let normalized = value;
  if (serialized && typeof value === 'string') {
    if (parameter.type === 'integer' && /^-?\d+$/.test(value)) normalized = Number(value);
    else if (parameter.type === 'number' && /^-?\d+(?:\.\d+)?$/.test(value)) normalized = Number(value);
    else if (parameter.type === 'boolean' && /^(?:true|false)$/i.test(value)) normalized = value.toLowerCase() === 'true';
  }
  if (parameter.type === 'string' && typeof normalized !== 'string') return false;
  if (parameter.type === 'integer' && (typeof normalized !== 'number' || !Number.isInteger(normalized))) return false;
  if (parameter.type === 'number' && (typeof normalized !== 'number' || !Number.isFinite(normalized))) return false;
  if (parameter.type === 'boolean' && typeof normalized !== 'boolean') return false;
  if (parameter.type === 'array' && !Array.isArray(normalized)) return false;
  if (parameter.type === 'object' && (normalized === null || Array.isArray(normalized) || typeof normalized !== 'object')) return false;
  if (typeof normalized === 'string') {
    if (parameter.minLength !== undefined && normalized.length < parameter.minLength) return false;
    if (parameter.maxLength !== undefined && normalized.length > parameter.maxLength) return false;
    if (parameter.pattern) {
      try { if (!new RegExp(parameter.pattern).test(normalized)) return false; } catch { return false; }
    }
  }
  if (typeof normalized === 'number') {
    if (parameter.min !== undefined && normalized < parameter.min) return false;
    if (parameter.max !== undefined && normalized > parameter.max) return false;
  }
  if (parameter.enum?.length && !parameter.enum.some((allowed) => Object.is(allowed, normalized))) return false;
  return true;
}

function invalidNames(
  parameters: ParameterSpec[],
  values: Record<string, unknown>,
  explicitNegative: string[] | undefined,
  serialized = false,
): string[] {
  const allowedInvalid = new Set(explicitNegative ?? []);
  return parameters
    .filter((parameter) => hasOwn(values, parameter.name)
      && !allowedInvalid.has(parameter.name)
      && !valueMatchesParameter(values[parameter.name], parameter, serialized))
    .map((parameter) => parameter.name);
}

/** 执行前验证 Case 的 HTTP Operation 与原始 ApiSpec 完全一致；绝不修正错误 Case。 */
export function validateApiBindingGate(
  testCase: TestCase,
  step: TestStep,
  apiSpecs: ApiSpec[] | undefined,
  effectiveHeaders: Record<string, string>,
): ApiBindingGateResult {
  const apiSpecId = testCase.source?.apiSpecId;
  if (!apiSpecId) return { valid: false, code: 'BINDING_MISSING', message: 'Case 缺少 source.apiSpecId' };

  const matches = (apiSpecs ?? []).filter((api) => api.id === apiSpecId);
  if (!matches.length) return { valid: false, apiSpecId, code: 'API_NOT_FOUND', message: `绑定的 ApiSpec ${apiSpecId} 不存在` };
  if (matches.length > 1) return { valid: false, apiSpecId, code: 'BINDING_AMBIGUOUS', message: `ApiSpec ${apiSpecId} 不唯一` };
  const api = matches[0];

  if (testCase.source?.apiOperationKey !== api.operationKey) {
    return {
      valid: false, apiSpecId, code: 'BINDING_MISMATCH',
      message: `Case Operation Key ${testCase.source?.apiOperationKey ?? 'missing'} 与 ${api.operationKey} 不一致`,
    };
  }

  if (step.method !== api.method || step.url !== api.path) {
    return {
      valid: false, apiSpecId, code: 'BINDING_MISMATCH',
      message: `Case Operation ${String(step.method)} ${String(step.url)} 与 ${api.id} 的 ${api.method} ${api.path} 不一致`,
    };
  }

  const pathParams = step.pathParams ?? {};
  const omittedPath = new Set(testCase.negativeContractIntent?.omittedPathParams ?? []);
  const requiredPathNames = new Set([...pathTemplateParameters(api.path), ...api.pathParams.filter((item) => item.required).map((item) => item.name)]);
  const missingPath = [...requiredPathNames].filter((name) => !omittedPath.has(name) && !hasValue(pathParams, name));
  if (missingPath.length) return { valid: false, apiSpecId, code: 'PATH_PARAMETER_MISSING', message: `缺少 Path Parameter：${missingPath.join(', ')}` };
  const invalidPath = invalidNames(api.pathParams, pathParams, testCase.negativeContractIntent?.invalidPathParams, true);
  if (invalidPath.length) return { valid: false, apiSpecId, code: 'BINDING_MISMATCH', message: `Path Parameter 不符合 Schema：${invalidPath.join(', ')}` };

  const query = step.query ?? {};
  const omittedQuery = new Set(testCase.negativeContractIntent?.omittedQueryParams ?? []);
  const missingQuery = api.query.filter((item) => item.required && !omittedQuery.has(item.name) && !hasValue(query, item.name)).map((item) => item.name);
  if (missingQuery.length) return { valid: false, apiSpecId, code: 'QUERY_PARAMETER_MISSING', message: `缺少必填 Query Parameter：${missingQuery.join(', ')}` };
  const invalidQuery = invalidNames(api.query, query, testCase.negativeContractIntent?.invalidQueryParams);
  if (invalidQuery.length) return { valid: false, apiSpecId, code: 'BINDING_MISMATCH', message: `Query Parameter 不符合 Schema：${invalidQuery.join(', ')}` };

  const omittedHeaders = new Set((testCase.negativeContractIntent?.omittedHeaders ?? []).map((name) => name.toLowerCase()));
  const missingHeaders = api.headers.filter((item) => item.required && !omittedHeaders.has(item.name.toLowerCase()) && !hasHeader(effectiveHeaders, item.name)).map((item) => item.name);
  if (missingHeaders.length) return { valid: false, apiSpecId, code: 'HEADER_MISSING', message: `缺少必填 Header：${missingHeaders.join(', ')}` };
  const headerValues = Object.fromEntries(api.headers.flatMap((parameter) => {
    const entry = Object.entries(effectiveHeaders).find(([name]) => name.toLowerCase() === parameter.name.toLowerCase());
    return entry ? [[parameter.name, entry[1]]] : [];
  }));
  const invalidHeaders = invalidNames(api.headers, headerValues, testCase.negativeContractIntent?.invalidHeaders, true);
  if (invalidHeaders.length) return { valid: false, apiSpecId, code: 'BINDING_MISMATCH', message: `Header 不符合 Schema：${invalidHeaders.join(', ')}` };

  if ((api.method === 'GET' || api.method === 'HEAD') && step.body !== undefined) {
    return { valid: false, apiSpecId, code: 'BODY_MISMATCH', message: `${api.method} 请求禁止携带 Body` };
  }
  if (step.body !== undefined && (step.body === null || Array.isArray(step.body) || typeof step.body !== 'object')) {
    return { valid: false, apiSpecId, code: 'BODY_MISMATCH', message: 'JSON Body 必须是对象' };
  }
  const body = (step.body ?? {}) as Record<string, unknown>;
  const omittedBody = new Set(testCase.negativeContractIntent?.omittedBodyFields ?? []);
  const missingBody = api.body.filter((item) => item.required && !omittedBody.has(item.name) && !hasOwn(body, item.name)).map((item) => item.name);
  if (missingBody.length) return { valid: false, apiSpecId, code: 'BODY_MISMATCH', message: `缺少必填 Body 字段：${missingBody.join(', ')}` };
  const allowedBody = new Set(api.body.map((item) => item.name));
  const unknownBody = Object.keys(body).filter((name) => !allowedBody.has(name));
  if (unknownBody.length) return { valid: false, apiSpecId, code: 'BODY_MISMATCH', message: `Body 包含未声明字段：${unknownBody.join(', ')}` };
  const invalidBody = invalidNames(api.body, body, testCase.negativeContractIntent?.invalidBodyFields);
  if (invalidBody.length) return { valid: false, apiSpecId, code: 'BODY_MISMATCH', message: `Body 字段不符合 Schema：${invalidBody.join(', ')}` };

  const expectedStatuses = testCase.assertions
    .filter((assertion) => assertion.type === 'STATUS_CODE' && typeof assertion.expected === 'number')
    .map((assertion) => assertion.expected as number);
  if (api.responses.length && expectedStatuses.some((status) => !api.responses.some((response) => response.status === status))) {
    return { valid: false, apiSpecId, code: 'BINDING_MISMATCH', message: `Case 预期状态不在 ${api.id} 响应契约中` };
  }

  return { valid: true, apiSpecId, apiSpec: api };
}
