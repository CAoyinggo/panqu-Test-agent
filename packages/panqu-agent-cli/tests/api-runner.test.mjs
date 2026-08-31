/**
 * 测试 20-21：API 默认不执行；非白名单 origin fail-closed。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateApiRequest, resolveAllowedOrigins, buildPlanOnly, DEFAULT_ALLOWED_API_ORIGINS } from '../src/api-runner.mjs';

test('API 默认不执行：未传 --execute-api → SKIPPED，requested=false', () => {
  const res = evaluateApiRequest({ executeApi: false, apiOrigin: 'https://test.panqu.com' });
  assert.equal(res.requested, false);
  assert.equal(res.executed, false);
  assert.equal(res.status, 'SKIPPED');
});

test('--execute-api 但缺 --api-origin → BLOCKED fail closed', () => {
  const res = evaluateApiRequest({ executeApi: true, apiOrigin: null });
  assert.equal(res.status, 'BLOCKED');
  assert.match(res.reason, /缺少 --api-origin/);
});

test('非白名单 origin → BLOCKED fail closed', () => {
  const res = evaluateApiRequest({ executeApi: true, apiOrigin: 'https://evil.example.com' });
  assert.equal(res.status, 'BLOCKED');
  assert.match(res.reason, /不在允许列表/);
});

test('prod/preonline / 本地 host 一律 BLOCKED', () => {
  assert.equal(evaluateApiRequest({ executeApi: true, apiOrigin: 'https://preonline.panqu.com' }).status, 'BLOCKED');
  assert.equal(evaluateApiRequest({ executeApi: true, apiOrigin: 'https://prod-api.example.com' }).status, 'BLOCKED');
  assert.equal(evaluateApiRequest({ executeApi: true, apiOrigin: 'https://localhost:8080' }).status, 'BLOCKED');
  assert.equal(evaluateApiRequest({ executeApi: true, apiOrigin: 'https://127.0.0.1' }).status, 'BLOCKED');
});

test('白名单 origin 通过 → 只做 plan-only（BLOCKED_PLAN_ONLY），executed=false，未发起 HTTP', () => {
  const res = evaluateApiRequest({ executeApi: true, apiOrigin: 'https://test.panqu.com' });
  assert.equal(res.status, 'BLOCKED_PLAN_ONLY');
  assert.equal(res.requested, true);
  assert.equal(res.executed, false);
  assert.equal(res.origin, 'https://test.panqu.com');
  assert.ok(res.plan, '应生成 plan-only');
  assert.equal(res.cases.length, 0);
});

test('带凭据 / 带路径的 origin → BLOCKED', () => {
  assert.equal(evaluateApiRequest({ executeApi: true, apiOrigin: 'https://u:p@test.panqu.com' }).status, 'BLOCKED');
  assert.equal(evaluateApiRequest({ executeApi: true, apiOrigin: 'https://test.panqu.com/api' }).status, 'BLOCKED');
});

test('resolveAllowedOrigins：环境变量覆盖；为空退回默认', () => {
  const custom = resolveAllowedOrigins({ PANQU_ALLOWED_TARGET_ORIGINS: 'https://a.com, https://b.com/' });
  assert.deepEqual(custom, new Set(['https://a.com', 'https://b.com']));
  assert.deepEqual(resolveAllowedOrigins({}), DEFAULT_ALLOWED_API_ORIGINS);
  assert.deepEqual(resolveAllowedOrigins({ PANQU_ALLOWED_TARGET_ORIGINS: '  ' }), DEFAULT_ALLOWED_API_ORIGINS);
});

test('buildPlanOnly 生成 PANQU_TEST_PLAN_V1 形状（无 schema_version 顶层字段）', () => {
  const plan = buildPlanOnly('https://test.panqu.com');
  assert.equal(plan.requirement_summary, '对本地项目验证目标做只读健康检查（plan-only，未执行）');
  assert.equal(plan.target_url, 'https://test.panqu.com');
  assert.equal(plan.environment, 'test');
  assert.ok(Array.isArray(plan.test_cases));
  assert.equal(plan.schema_version, undefined);
});
