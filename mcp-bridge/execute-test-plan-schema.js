'use strict';

/**
 * execute-test-plan-schema.js — execute_test_plan 的共享定义（HTTP MCP 与 stdio MCP 共用）。
 *
 * 目的：HTTP MCP（aily-test-mcp.js）与 stdio MCP（trae-test-mcp-stdio.js）共用同一份
 *       inputSchema 与顶层字段白名单，避免两份手写 Schema 漂移。
 *
 * 约束：纯 CommonJS、零依赖、不读取任何 LLM_* / 模型密钥 / Keychain / DeepSeek 配置。
 *       schema_version 不作为 plan 顶层字段（服务端 validatePlan 的 additionalProperties=false 会拒绝）。
 */

// ===== 枚举（与 test-flow/src/agents/plan/plan-contract.ts 保持一致）=====

const PLAN_ACTIONS = new Set(['plan', 'execute', 'status']);

const PLAN_ENVIRONMENTS = ['test', 'preonline', 'prod'];
const PLAN_SCOPES = ['comprehensive', 'api', 'functional', 'ui'];
const PLAN_CASE_TYPES = [
  'API', 'FUNCTIONAL', 'UI', 'BROWSER',
  'DATA_ISOLATION', 'SECURITY', 'BUSINESS_RULE', 'STATE',
  'ERROR', 'BOUNDARY', 'COMPATIBILITY',
];
const PLAN_PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const PLAN_HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ASSETION_TYPES = ['STATUS_CODE', 'JSON_VALUE', 'JSON_PATH', 'RESPONSE_HEADER', 'CONTAINS', 'TYPE'];
const ASSERTION_OPERATORS = [
  'equals', 'notEquals', 'contains', 'notContains', 'exists', 'notExists',
  'gt', 'gte', 'lt', 'lte', 'type', 'regex',
];
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'P0', 'P1', 'P2', 'P3'];

// ===== 嵌套 plan 结构（PANQU_TEST_PLAN_V1）=====

const ASSERTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ASSETION_TYPES },
    path: { type: 'string' },
    header: { type: 'string' },
    operator: { type: 'string', enum: ASSERTION_OPERATORS },
    expected: {},
    description: { type: 'string' },
  },
  required: ['type'],
};

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['HTTP_REQUEST', 'DESCRIPTION'] },
    description: { type: 'string' },
    action: { type: 'string' },
    method: { type: 'string', enum: PLAN_HTTP_METHODS },
    url: { type: 'string' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    query: { type: 'object' },
    path_params: { type: 'object' },
    body: {},
  },
  required: ['type'],
};

const CASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    priority: { type: 'string', enum: PLAN_PRIORITIES },
    type: { type: 'string', enum: PLAN_CASE_TYPES },
    preconditions: { type: 'array', items: { type: 'string' } },
    cleanup: { type: 'array', items: { type: 'string' } },
    credential_ref: { type: 'string' },
    auth_ref: { type: 'string' },
    steps: { type: 'array', minItems: 1, items: STEP_SCHEMA },
    assertions: { type: 'array', items: ASSERTION_SCHEMA },
  },
  required: ['id', 'name', 'priority', 'type', 'steps', 'assertions'],
};

const RISK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    level: { type: 'string', enum: RISK_LEVELS },
    category: { type: 'string' },
    description: { type: 'string' },
    mitigation: { type: 'string' },
    affected_cases: { type: 'array', items: { type: 'string' } },
    affectedCases: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'level', 'category', 'description'],
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requirement_summary: { type: 'string', minLength: 1 },
    target_url: { type: 'string', minLength: 1 },
    environment: { type: 'string', enum: PLAN_ENVIRONMENTS },
    test_scope: { type: 'string', enum: PLAN_SCOPES },
    test_cases: { type: 'array', minItems: 1, items: CASE_SCHEMA },
    risks: { type: 'array', items: RISK_SCHEMA },
  },
  required: ['requirement_summary', 'target_url', 'environment', 'test_scope', 'test_cases', 'risks'],
};

// ===== execute_test_plan 完整 inputSchema =====

const EXECUTE_TEST_PLAN_TOOL = {
  name: 'execute_test_plan',
  description:
    '执行结构化测试计划（PANQU_TEST_PLAN_V1）。Trae 生成 plan 后调用本工具；本路径确定性校验/执行/报告，' +
    '不调用任何模型。第一阶段仅支持三个 action：action=plan 校验并持久化（不执行、零网络）；' +
    'action=execute 在通过确定性 Policy Gate 后执行已持久化计划（必须携带 plan_id、expected_plan_hash 与 idempotency_key）；' +
    'action=status 读取真实 manifest/result 状态。analyze/resume 第一阶段未实现。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['plan', 'execute', 'status'], description: '操作类型（必填）' },
      plan: PLAN_SCHEMA,
      plan_id: { type: 'string', description: 'action=execute/status：已持久化计划 ID' },
      expected_plan_hash: { type: 'string', description: 'action=execute 必填：计划 SHA-256，用于绑定确认防止计划被替换' },
      run_id: { type: 'string', description: 'action=status 可选：运行 ID（与 plan_id 二选一）' },
      idempotency_key: {
        type: 'string',
        pattern: '^[A-Za-z0-9_-]+$',
        description: 'action=execute 必填：幂等键，仅允许 [A-Za-z0-9_-]；同一次确认重试必须复用',
      },
      budget_cases: { type: 'integer', minimum: 1, description: '本次最多执行的 EXECUTABLE 用例数（可选）' },
      budget_duration: { type: 'integer', minimum: 1, description: '整个计划的总执行时限（毫秒，可选）' },
    },
    required: ['action'],
    allOf: [
      { if: { properties: { action: { const: 'plan' } } }, then: { required: ['plan'] } },
      { if: { properties: { action: { const: 'execute' } } }, then: { required: ['plan_id', 'expected_plan_hash', 'idempotency_key'] } },
      { if: { properties: { action: { const: 'status' } } }, then: { anyOf: [{ required: ['plan_id'] }, { required: ['run_id'] }] } },
    ],
  },
};

// execute_test_plan 顶层允许字段（严格白名单；其余字段一律拒绝）。
const PLAN_TOP_LEVEL_KEYS = new Set([
  'action', 'plan', 'plan_id', 'expected_plan_hash', 'run_id',
  'idempotency_key', 'budget_cases', 'budget_duration',
]);

// 深层扫描用「精确字段名」正则（与 plan-contract SENSITIVE_FIELD 对齐）。
const PLAN_SENSITIVE_FIELD = /^(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|token|secret|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth[-_]?token|client[-_]?secret)$/i;

module.exports = {
  PLAN_ACTIONS,
  PLAN_ENVIRONMENTS,
  PLAN_SCOPES,
  PLAN_CASE_TYPES,
  PLAN_PRIORITIES,
  PLAN_HTTP_METHODS,
  RISK_LEVELS,
  PLAN_SCHEMA,
  CASE_SCHEMA,
  STEP_SCHEMA,
  ASSERTION_SCHEMA,
  RISK_SCHEMA,
  EXECUTE_TEST_PLAN_TOOL,
  PLAN_TOP_LEVEL_KEYS,
  PLAN_SENSITIVE_FIELD,
};