import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import { runAcceptancePipeline } from '../../src/acceptance/acceptance-pipeline.js';
import { ApiProcessor } from '../../src/acceptance/api-processor.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import {
  buildAcceptanceTestDesign,
  finalizeRequirementFactLedger,
  type AcceptanceTestDesign,
} from '../../src/acceptance/test-objective.js';
import { validateAcceptanceTrace } from '../../src/acceptance/traceability.js';
import { DESIGN_GROUND_TRUTH } from './fixtures/design-ground-truth.js';

type GroundTruthFixture = {
  documentId: string;
  markdown: string;
};

function compile(fixture: GroundTruthFixture): {
  requirement: ReturnType<typeof parseAcceptanceRequirement>;
  design: AcceptanceTestDesign;
  points: ReturnType<typeof generateTestPoints>;
  cases: TestCase[];
} {
  const requirement = parseAcceptanceRequirement(fixture.markdown, { documentId: fixture.documentId });
  const design = buildAcceptanceTestDesign(requirement);
  const points = generateTestPoints(requirement, design);
  const cases = generateAcceptanceApiCases(requirement, points);
  finalizeRequirementFactLedger(requirement, design.objectives, cases);
  return { requirement, design, points, cases };
}

function factContaining(
  requirement: ReturnType<typeof parseAcceptanceRequirement>,
  text: string,
) {
  const fact = requirement.factLedger.find((candidate) => candidate.statement.includes(text));
  expect(fact, `Ground Truth fact was omitted: ${text}`).toBeDefined();
  return fact!;
}

function casesForFact(cases: TestCase[], factId: string): TestCase[] {
  return cases.filter((testCase) => testCase.source?.factIds?.includes(factId));
}

describe('Independent Requirement -> Expected Test Design Ground Truth', () => {
  it.each([
    'alice 无权删除 bob，应当被阻止。',
    'alice 不允许删除 bob。',
    'alice 没有权利删除 bob。',
    'alice should not delete bob.',
    'alice cannot delete bob.',
    'alice may not delete bob.',
    'alice is not allowed to delete bob.',
  ])('normalizes deny polarity, routes subject -> target, and never treats an observed 200 as expected: %s', async (rule) => {
    const markdown = `# Delete user

GET /users/{id}
该接口无需认证

## 参数
| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| id | path | string | 是 |

## 响应
| 状态码 | 描述 |
| --- | --- |
| 200 | deleted |
| 403 | forbidden |

## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| alice | alice | USER | alice-token |
| bob | bob | USER | bob-token |

AC-1 ${rule} 若实际返回 200 必须判定为失败。`;
    const compiled = compile({ documentId: 'gt-permission-polarity.md', markdown });
    const fact = factContaining(compiled.requirement, rule);
    const permissionCase = casesForFact(compiled.cases, fact.id).find((testCase) =>
      testCase.executionMode === 'EXECUTABLE'
      && testCase.actor?.id === 'alice'
      && testCase.data?.targetId === 'bob'
      && testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE' && assertion.expected === 403));

    expect(permissionCase).toBeDefined();
    expect(casesForFact(compiled.cases, fact.id).filter((testCase) => testCase.executionMode === 'EXECUTABLE')
      .some((testCase) => testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE' && assertion.expected === 200))).toBe(false);

    let requestDispatched = false;
    const result = await new ApiProcessor().execute(permissionCase!, {
      baseUrl: 'http://acceptance.invalid',
      apiSpecs: compiled.requirement.apis,
      actorHeaders: { alice: { Authorization: 'Bearer test-only' } },
      fetchImpl: async () => {
        requestDispatched = true;
        return new Response('{"deleted":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    expect(result).toMatchObject({ executed: false, processorInvoked: false, status: 'BLOCKED', pass: false });
    expect(result.error).toContain('MISSING_EVIDENCE_PROVIDER');
    expect(requestDispatched).toBe(false);
  });

  it('routes an explicit positive subject -> target relation instead of reusing the subject as resource id', () => {
    const { cases } = compile({
      documentId: 'gt-permission-allow-relation.md',
      markdown: `# Delete user
DELETE /users/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| id | path | string | 是 |
| 状态码 | 描述 |
| --- | --- |
| 200 | deleted |
## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| alice | alice | ADMIN | alice-token |
| bob | bob | USER | bob-token |
AC-1 alice 可以删除 bob，返回 200。`,
    });
    expect(cases.some((testCase) => testCase.executionMode === 'EXECUTABLE'
      && testCase.actor?.id === 'alice' && testCase.data?.targetId === 'bob')).toBe(true);
    expect(cases.some((testCase) => testCase.executionMode === 'EXECUTABLE'
      && testCase.actor?.id === 'alice' && testCase.data?.targetId === 'alice')).toBe(false);
  });

  it('does not inject the sole configured Actor into an explicitly public endpoint', async () => {
    const compiled = compile({
      documentId: 'gt-public-no-auth.md',
      markdown: `# Public profile
GET /public-profile
该接口无需认证
返回 200
## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| alice | alice | USER | alice-token |
AC-1 GET /public-profile 返回 200`,
    });
    const publicCase = compiled.cases.find((testCase) => testCase.executionMode === 'EXECUTABLE'
      && testCase.source?.acceptanceCriteriaIds.includes('AC-1'));
    expect(publicCase).toBeDefined();
    expect(publicCase?.actor).toBeUndefined();
    let requestHeaders: Headers | undefined;
    const result = await new ApiProcessor().execute(publicCase!, {
      baseUrl: 'http://acceptance.invalid',
      apiSpecs: compiled.requirement.apis,
      fetchImpl: async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    expect(result).toMatchObject({ executed: true, status: 'PASS' });
    expect(requestHeaders?.has('Authorization')).toBe(false);
  });

  it('resolves passive actor direction and an explicitly named administrator deterministically', () => {
    const passive = compile({
      documentId: 'gt-passive-relation.md',
      markdown: `# Read profile
GET /users/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| id | path | string | 是 |
| 状态码 | 描述 |
| --- | --- |
| 200 | ok |
| 403 | forbidden |
## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| alice | alice | USER | alice-token |
| bob | bob | USER | bob-token |
AC-1 bob 数据不得被 alice 访问，返回 403`,
    });
    expect(passive.cases.some((testCase) => testCase.executionMode === 'EXECUTABLE'
      && testCase.actor?.id === 'alice' && testCase.data?.targetId === 'bob'
      && testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE' && assertion.expected === 403))).toBe(true);

    const ownerFirst = compile({
      documentId: 'gt-owner-first-relation.md',
      markdown: `# Read profile
GET /users/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| id | path | string | 是 |
| 状态码 | 描述 |
| --- | --- |
| 200 | ok |
| 403 | forbidden |
## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| alice | alice | USER | alice-token |
| bob | bob | USER | bob-token |
AC-1 bob 的数据禁止 alice 访问，返回 403`,
    });
    expect(ownerFirst.cases.some((testCase) => testCase.executionMode === 'EXECUTABLE'
      && testCase.actor?.id === 'alice' && testCase.data?.targetId === 'bob'
      && testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE' && assertion.expected === 403))).toBe(true);

    const admin = compile({
      documentId: 'gt-explicit-admin.md',
      markdown: `# Delete profile
DELETE /users/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| id | path | string | 是 |
| 状态码 | 描述 |
| --- | --- |
| 200 | deleted |
## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| admin-one | admin-one | ADMIN | admin-one-token |
| admin-two | admin-two | ADMIN | admin-two-token |
| bob | bob | USER | bob-token |
AC-1 admin-two 管理员可以删除 bob，返回 200`,
    });
    expect(admin.cases.some((testCase) => testCase.executionMode === 'EXECUTABLE'
      && testCase.actor?.id === 'admin-two' && testCase.data?.targetId === 'bob')).toBe(true);
    expect(admin.cases.some((testCase) => testCase.executionMode === 'EXECUTABLE'
      && testCase.actor?.id === 'admin-one')).toBe(false);
  });

  it('never substitutes an Actor id for an unrelated resource path or fabricates a not-found id', () => {
    const order = compile({
      documentId: 'gt-resource-identity.md',
      markdown: `# Delete order
DELETE /orders/{orderId}
该接口无需认证
返回 204、404
## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| alice | user-alice | USER | alice-token |
AC-1 删除订单 ord-123 返回 204
AC-2 不存在订单返回 404`,
    });
    for (const acId of ['AC-1', 'AC-2']) {
      const linked = order.cases.filter((testCase) => testCase.source?.acceptanceCriteriaIds.includes(acId));
      expect(linked.length).toBeGreaterThan(0);
      expect(linked.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    }
    expect(JSON.stringify(order.cases)).not.toContain('acceptance-not-found');
    expect(order.cases.some((testCase) => testCase.data?.targetId === 'user-alice')).toBe(false);

    const explicit = compile({
      documentId: 'gt-explicit-resource-identity.md',
      markdown: `# Delete order
DELETE /orders/{orderId}
该接口无需认证
返回 204
AC-1 orderId=ord-123 删除成功返回 204`,
    });
    expect(explicit.cases.some((testCase) => testCase.executionMode === 'EXECUTABLE'
      && testCase.data?.targetId === 'ord-123')).toBe(true);

    const multiPath = compile({
      documentId: 'gt-multi-path-no-fanout.md',
      markdown: `# Delete tenant order
DELETE /tenants/{tenantId}/orders/{orderId}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| tenantId | path | string | 是 | tenant-A |
| orderId | path | string | 是 | |
返回 200
AC-1 DELETE /tenants/{tenantId}/orders/{orderId} 返回 200`,
    });
    expect(multiPath.cases.length).toBeGreaterThan(0);
    expect(multiPath.cases.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(multiPath.cases.some((testCase) => String(testCase.design?.reason).includes('MULTI_PATH_BINDING_INCOMPLETE'))).toBe(true);
  });

  it('does not parse digits in resource ids as HTTP status and blocks ambiguous repeated write oracles', () => {
    const parsed = parseAcceptanceRequirement(`# Delete order
DELETE /orders/{orderId}
该接口无需认证
ord-200 删除成功返回 204
AC-1 orderId=ord-200 返回 204`);
    expect(parsed.apis[0].responses.map((response) => response.status)).toEqual([204]);

    const ambiguousWrite = compile({
      documentId: 'gt-multi-success-write.md',
      markdown: `# Create order
POST /orders
该接口无需认证
返回 200、201`,
    });
    expect(ambiguousWrite.cases.length).toBeGreaterThan(0);
    expect(ambiguousWrite.cases.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(ambiguousWrite.cases.some((testCase) => String(testCase.design?.reason).includes('SUCCESS_RESPONSE_AMBIGUOUS'))).toBe(true);
  });

  it('keeps denied mutations DESIGNED_ONLY until non-mutation evidence is available', () => {
    const compiled = compile({
      documentId: 'gt-denied-mutation.md',
      markdown: `# Delete profile
DELETE /users/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| id | path | string | 是 |
| 状态码 | 描述 |
| --- | --- |
| 403 | forbidden |
## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| alice | alice | USER | alice-token |
| bob | bob | USER | bob-token |
AC-1 alice 不允许删除 bob，返回 403`,
    });
    const deny = compiled.cases.filter((testCase) => testCase.source?.acceptanceCriteriaIds.includes('AC-1'));
    expect(deny.length).toBeGreaterThan(0);
    expect(deny.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(deny.some((testCase) => String(testCase.design?.reason).includes('NON_MUTATION_EVIDENCE_UNAVAILABLE'))).toBe(true);
  });

  it('never treats generated Path boundary ids as prepared mutation fixtures', () => {
    const compiled = compile({
      documentId: 'gt-mutation-path-vector.md',
      markdown: `# Delete order
DELETE /orders/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 最小值 | 最大值 |
| --- | --- | --- | --- | --- | --- |
| id | path | integer | 是 | 1 | 2 |
| 状态码 | 描述 |
| --- | --- |
| 204 | deleted |
| 400 | invalid |
AC-1 id 最小值1最大值2，合法返回204，非法返回400`,
    });
    const pathVectors = compiled.cases.filter((testCase) => testCase.parameterContext?.parameter === 'id');
    expect(pathVectors.length).toBeGreaterThan(0);
    expect(pathVectors.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(pathVectors.some((testCase) => String(testCase.design?.reason).includes('MUTATION_PATH_FIXTURE_UNAVAILABLE'))).toBe(true);
  });

  it('does not reinterpret UI or database state fields as HTTP response assertions', () => {
    const compiled = compile({
      documentId: 'gt-evidence-channel.md',
      markdown: `# Save order
POST /orders
该接口无需认证
返回 201
页面保存成功后按钮 status="disabled"。
数据库中订单 status="PAID"。`,
    });
    for (const statement of ['页面保存成功后按钮 status="disabled"。', '数据库中订单 status="PAID"。']) {
      const fact = factContaining(compiled.requirement, statement);
      const linked = casesForFact(compiled.cases, fact.id);
      expect(linked.length).toBeGreaterThan(0);
      expect(linked.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
      expect(linked.flatMap((testCase) => testCase.assertions).some((assertion) => assertion.type === 'JSON_VALUE')).toBe(false);
    }
  });

  it('keeps real side effects DESIGNED_ONLY even when the response echoes a boolean flag', () => {
    const compiled = compile({
      documentId: 'gt-side-effect-evidence.md',
      markdown: `# Notify
POST /orders
该接口无需认证
返回 201
创建后必须真实发送邮件通知，响应 emailSent=true。`,
    });
    const fact = factContaining(compiled.requirement, '创建后必须真实发送邮件通知');
    const linked = casesForFact(compiled.cases, fact.id).filter((testCase) => testCase.testType === 'SIDE_EFFECT');
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(linked.every((testCase) => String(testCase.design?.reason).includes('EXTERNAL_EVIDENCE_UNAVAILABLE'))).toBe(true);
  });

  it('combines min/max/pattern vectors, uses contract-valid success data, and ignores status digits inside a path', () => {
    const compiled = compile({
      documentId: 'gt-combined-boundary.md',
      markdown: `# Validate code
POST /status/404
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 最小长度 | 最大长度 | 格式 |
| --- | --- | --- | --- | --- | --- | --- |
| code | body | string | 是 | 1 | 1 | ^Z$ |
| 状态码 | 描述 |
| --- | --- |
| 200 | valid |
| 422 | invalid |
AC-1 code minLength=1 maxLength=1 pattern=^Z$ 违反约束返回 422。`,
    });
    const parameterCases = compiled.cases.filter((testCase) => testCase.parameterContext?.parameter === 'code');
    const executable = parameterCases.filter((testCase) => testCase.executionMode === 'EXECUTABLE');
    expect(executable.some((testCase) => testCase.parameterContext?.expectedOutcome === 'ACCEPT'
      && testCase.parameterContext.testData === 'Z'
      && testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE' && assertion.expected === 200))).toBe(true);
    expect(executable.some((testCase) => testCase.parameterContext?.boundaryVector === 'MAX_PLUS'
      && testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE' && assertion.expected === 422))).toBe(true);
    expect(executable.some((testCase) => testCase.parameterContext?.boundaryVector === 'FORMAT_INVALID'
      && testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE' && assertion.expected === 422))).toBe(true);
    const formatInvalid = executable.find((testCase) => testCase.parameterContext?.boundaryVector === 'FORMAT_INVALID');
    expect(formatInvalid?.parameterContext?.testData).toBeTypeOf('string');
    expect(String(formatInvalid?.parameterContext?.testData)).toHaveLength(1);
    expect(/^Z$/.test(String(formatInvalid?.parameterContext?.testData))).toBe(false);
    expect(executable.some((testCase) => testCase.assertions.some((assertion) =>
      assertion.type === 'STATUS_CODE' && assertion.expected === 404))).toBe(false);
    expect(executable.filter((testCase) => testCase.parameterContext?.expectedOutcome === 'ACCEPT')
      .every((testCase) => testCase.parameterContext?.testData === 'Z')).toBe(true);
  });

  it('retains atomicity as a BUSINESS_RULE and keeps it DESIGNED_ONLY without an observable state probe', () => {
    const oracle = DESIGN_GROUND_TRUTH.atomicityWithoutProbe;
    const { requirement, design, cases } = compile(oracle);
    const fact = factContaining(requirement, oracle.factText);

    expect(fact).toMatchObject({
      category: oracle.category,
      normativity: 'NORMATIVE',
      provenance: 'EXPLICIT',
    });
    const objective = design.objectives.find((candidate) =>
      candidate.factIds.includes(fact.id) && candidate.dimension === oracle.requiredDimension);
    expect(objective).toMatchObject({
      dimension: oracle.requiredDimension,
      sourceType: 'REQUIREMENT',
      outcomeStatus: 'KNOWN',
    });

    const businessCases = casesForFact(cases, fact.id)
      .filter((testCase) => testCase.testType === 'BUSINESS_RULE');
    expect(businessCases.length).toBeGreaterThan(0);
    expect(businessCases.every((testCase) => testCase.executionMode === oracle.executionMode)).toBe(true);
    expect(businessCases.every((testCase) => testCase.steps.length > 0
      && testCase.steps.every((step) => step.execution === 'PLANNED'))).toBe(true);
    expect(businessCases.every((testCase) => String(testCase.design?.reason).includes(oracle.reasonCode))).toBe(true);
    expect(businessCases.flatMap((testCase) => testCase.assertions).every((assertion) => assertion.type === 'DESIGN_EXPECTATION')).toBe(true);
  });

  it('compiles explicitly observable atomicity fields into executable business assertions', () => {
    const oracle = DESIGN_GROUND_TRUTH.atomicityWithObservableFields;
    const { requirement, cases } = compile(oracle);
    const fact = factContaining(requirement, oracle.factText);
    const executable = casesForFact(cases, fact.id)
      .filter((testCase) => testCase.executionMode === 'EXECUTABLE');

    expect(executable.length).toBeGreaterThan(0);
    for (const [path, expected] of Object.entries(oracle.expectedBusinessFields)) {
      expect(executable.some((testCase) => testCase.assertions.some((assertion) =>
        assertion.type === 'JSON_VALUE'
        && assertion.path === path
        && assertion.expected === expected
        && assertion.factIds?.includes(fact.id)))).toBe(true);
    }
    expect(executable.some((testCase) => testCase.assertions.some((assertion) =>
      assertion.type === 'STATUS_CODE' && assertion.expected === oracle.expectedStatus))).toBe(true);
  });

  it('designs an explicit cross-user isolation case with the declared actors and target', () => {
    const oracle = DESIGN_GROUND_TRUTH.userIsolation;
    const { requirement, design, cases } = compile(oracle);
    const fact = factContaining(requirement, 'alice 用户不得访问 bob 用户的订单');
    const dimensions = new Set(design.objectives
      .filter((objective) => objective.factIds.includes(fact.id) && objective.sourceType !== 'HEURISTIC')
      .map((objective) => objective.dimension));

    for (const expected of oracle.requiredDimensions) expect(dimensions.has(expected)).toBe(true);
    const crossUser = casesForFact(cases, fact.id).find((testCase) =>
      testCase.testType === 'DATA_ISOLATION'
      && testCase.actor?.id === oracle.sourceActor
      && testCase.data?.targetId === oracle.targetResourceId);
    expect(crossUser).toBeDefined();
    expect(crossUser?.assertions).toContainEqual(expect.objectContaining({
      type: 'STATUS_CODE', expected: oracle.expectedStatus, factIds: expect.arrayContaining([fact.id]),
    }));
  });

  it('designs tenant-A -> tenant-B isolation without replacing the declared scope identities', () => {
    const oracle = DESIGN_GROUND_TRUTH.tenantIsolation;
    const { requirement, cases } = compile(oracle);
    const fact = factContaining(requirement, 'tenant-a-reader 不得访问 tenant-b-owner');
    const isolationCase = casesForFact(cases, fact.id).find((testCase) =>
      testCase.testType === 'DATA_ISOLATION'
      && testCase.actor?.id === oracle.sourceActor
      && testCase.actor?.tenantId === oracle.sourceTenant
      && testCase.data?.targetId === oracle.targetResourceId);

    expect(isolationCase).toBeDefined();
    expect(requirement.actors.find((actor) => actor.userId === oracle.targetUserId)?.tenantId).toBe(oracle.targetTenant);
    expect(isolationCase?.assertions).toContainEqual(expect.objectContaining({
      type: 'STATUS_CODE', expected: oracle.expectedStatus,
    }));
  });

  it('produces the independently specified age 18..60 boundary vector and no unrelated parameter vector', () => {
    const oracle = DESIGN_GROUND_TRUTH.ageBoundary;
    const { cases } = compile(oracle);
    const parameterCases = cases.filter((testCase) => testCase.parameterContext);
    expect(new Set(parameterCases.map((testCase) => testCase.parameterContext?.parameter))).toEqual(new Set([oracle.parameter]));

    const actualByVector = new Map(parameterCases.map((testCase) => [
      testCase.parameterContext!.boundaryVector,
      testCase.parameterContext!.testData,
    ]));
    for (const [vector, expectedValue] of Object.entries(oracle.vectors)) {
      expect(actualByVector.has(vector), `Missing independent boundary vector ${vector}`).toBe(true);
      expect(actualByVector.get(vector)).toEqual(expectedValue);
    }
  });

  it('uses only roles and actors that are present in the requirement', () => {
    const oracle = DESIGN_GROUND_TRUTH.explicitRoles;
    const { requirement, design, cases } = compile(oracle);

    expect(requirement.actors.map((actor) => actor.id).sort()).toEqual([...oracle.actorIds]);
    expect(requirement.actors.map((actor) => actor.role).sort()).toEqual([...oracle.roles]);
    const serialized = JSON.stringify({ actors: requirement.actors, objectives: design.objectives, cases });
    for (const forbidden of oracle.forbiddenSyntheticActors) {
      expect(serialized).not.toContain(`"id":"${forbidden}"`);
    }
    for (const actorId of oracle.actorIds) {
      expect(design.objectives.some((objective) => objective.scenario.includes(actorId))).toBe(true);
    }
    expect(cases.filter((testCase) => testCase.actor).every((testCase) =>
      oracle.actorIds.includes(testCase.actor!.id as typeof oracle.actorIds[number]))).toBe(true);
  });

  it('keeps an underspecified query UNVERIFIED and never invents status, auth, tenant or pagination', () => {
    const oracle = DESIGN_GROUND_TRUTH.underspecifiedQuery;
    const { requirement, cases } = compile(oracle);
    const fact = factContaining(requirement, oracle.factText);

    expect(fact).toMatchObject({ category: oracle.category, status: oracle.status, normativity: 'NORMATIVE' });
    const linked = casesForFact(cases, fact.id);
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.every((testCase) => testCase.executionMode === oracle.executionMode)).toBe(true);
    expect(linked.every((testCase) => testCase.steps.length > 0
      && testCase.steps.every((step) => step.execution === 'PLANNED')
      && testCase.assertions.length === 0
      && testCase.readiness?.status === 'NEED_CONFIRMATION')).toBe(true);
    expect(requirement.apis).toHaveLength(0);
    expect(requirement.actors).toHaveLength(0);
    const serialized = JSON.stringify({ apis: requirement.apis, actors: requirement.actors, cases: linked });
    for (const forbidden of oracle.forbiddenInferences) expect(serialized).not.toContain(forbidden);
  });

  it('keeps UI validation DESIGNED_ONLY and produces no PASS result without a UI executor', async () => {
    const oracle = DESIGN_GROUND_TRUTH.uiOnly;
    const compiled = compile(oracle);
    const fact = factContaining(compiled.requirement, oracle.factText);
    const objective = compiled.design.objectives.find((candidate) =>
      candidate.factIds.includes(fact.id) && candidate.dimension === oracle.dimension);
    expect(objective).toBeDefined();
    const uiCases = casesForFact(compiled.cases, fact.id).filter((testCase) => testCase.testType === 'UI');
    expect(uiCases.length).toBeGreaterThan(0);
    expect(uiCases.every((testCase) => testCase.executionMode === oracle.executionMode)).toBe(true);
    expect(uiCases.every((testCase) => String(testCase.design?.reason).includes(oracle.reasonCode))).toBe(true);

    const pipeline = await runAcceptancePipeline({
      markdown: oracle.markdown,
      documentId: oracle.documentId,
      project: 'ground-truth-ui',
      baseUrl: 'http://127.0.0.1:1',
      environment: 'local',
      mode: 'dry-run',
    });
    const uiIds = new Set(pipeline.testCases.filter((testCase) => testCase.testType === 'UI').map((testCase) => testCase.id));
    const uiResults = pipeline.results.filter((result) => uiIds.has(result.caseId));
    expect(uiResults.length).toBeGreaterThan(0);
    expect(uiResults.every((result) => result.executed === false && result.status !== 'PASS')).toBe(true);
  });

  it('forms a DESIGNED_ONLY Hybrid Scenario spanning UI, API and business/data semantics', () => {
    const oracle = DESIGN_GROUND_TRUTH.hybrid;
    const { design } = compile(oracle);
    const hybrid = design.scenarios.find((scenario) => scenario.kind === oracle.kind
      && scenario.factIds.length >= 3
      && oracle.requiredChannels.every((channel) => scenario.actions.some((action) => action.channel === channel)));

    expect(hybrid).toBeDefined();
    expect(hybrid?.executionMode).toBe(oracle.executionMode);
    expect(hybrid?.factIds.length).toBeGreaterThanOrEqual(3);
    const semanticText = [hybrid?.title, ...hybrid?.actions.map((action) => action.description) ?? []].join('\n');
    for (const fragment of oracle.requiredSemanticFragments) expect(semanticText).toContain(fragment);
  });

  it('closes Fact -> Objective -> Case -> Assertion trace using independent semantic checks', () => {
    const oracle = DESIGN_GROUND_TRUTH.atomicityWithObservableFields;
    const { requirement, design, points, cases } = compile(oracle);
    const fact = factContaining(requirement, oracle.factText);
    const requiredObjectives = design.objectives.filter((objective) =>
      objective.factIds.includes(fact.id) && objective.sourceType !== 'HEURISTIC');

    expect(fact.status).toBe('CONSUMED');
    expect(fact.linkedObjectiveIds).toEqual(expect.arrayContaining(requiredObjectives.map((objective) => objective.id)));
    for (const objective of requiredObjectives) {
      const linkedCases = cases.filter((testCase) => testCase.source?.objectiveIds?.includes(objective.id));
      expect(linkedCases.length, `Objective has no Case: ${objective.dimension}`).toBeGreaterThan(0);
      expect(linkedCases.some((testCase) => testCase.assertions.some((assertion) =>
        assertion.factIds?.includes(fact.id)
        && (assertion.objectiveIds?.includes(objective.id) || assertion.objectiveId === objective.id)))).toBe(true);
    }
    expect(validateAcceptanceTrace(requirement, points, cases, design.objectives)).toEqual([]);
  });

  it('reports Fact, Objective, Case, Execution and Evidence coverage as five separate layers', async () => {
    const oracle = DESIGN_GROUND_TRUTH.hybrid;
    const execution = await runAcceptancePipeline({
      markdown: oracle.markdown,
      documentId: oracle.documentId,
      project: 'ground-truth-report',
      baseUrl: 'http://127.0.0.1:1',
      environment: 'local',
      mode: 'dry-run',
    });
    const coverage = execution.report.coverage as unknown as {
      factCoverage: number;
      factVerificationCoverage: number;
      objectiveCoverage: number;
      caseCoverage: number;
      executionCoverage: number;
      evidenceCoverage: number;
    };

    expect(coverage.factCoverage).toBeTypeOf('number');
    expect(coverage.factVerificationCoverage).toBeTypeOf('number');
    expect(coverage.objectiveCoverage).toBeTypeOf('number');
    expect(coverage.caseCoverage).toBeTypeOf('number');
    expect(coverage.executionCoverage).toBe(0);
    expect(coverage.evidenceCoverage).toBe(0);
    expect(coverage.factCoverage).toBeGreaterThan(0);
    expect(coverage.factVerificationCoverage).toBeGreaterThan(0);
    expect(coverage.objectiveCoverage).toBeGreaterThan(0);
    expect(coverage.caseCoverage).toBeGreaterThan(0);

    const report = execution.rendered.markdown;
    expect(report).toMatch(/Requirement Fact Design Coverage|需求事实设计覆盖/i);
    expect(report).toMatch(/Requirement Fact Verification Coverage|需求事实验证覆盖/i);
    expect(report).toMatch(/Objective Coverage|测试目标覆盖/i);
    expect(report).toMatch(/Case Coverage|用例覆盖/i);
    expect(report).toMatch(/Execution Coverage|执行覆盖/i);
    expect(report).toMatch(/Evidence Coverage|证据覆盖/i);
    expect(report).toMatch(/未验证|UNVERIFIED/i);
  });
});
