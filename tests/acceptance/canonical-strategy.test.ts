import { describe, expect, it } from 'vitest';
import { applyTestCaseQualityGate } from '../../src/acceptance/test-case-quality-gate.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';
import { TEST_STRATEGY_POLICY } from '../../src/acceptance/test-strategy-engine.js';

describe('Canonical Requirement Fact and Test Strategy Engine', () => {
  it('normalizes explicit Actor → Action → Resource → Expected and subject/target scope once', () => {
    const requirement = parseAcceptanceRequirement(`# 用户资料权限
GET /users/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | bob |
| 状态码 | 描述 |
| --- | --- |
| 200 | ok |
| 403 | forbidden |
## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| alice | alice | USER | alice-token |
| bob | bob | USER | bob-token |
AC-1 alice 不得修改 bob 用户资料，返回 403。`);

    const fact = requirement.factLedger.find((candidate) => candidate.statement.includes('alice 不得修改 bob'));
    expect(fact?.canonical).toMatchObject({
      actor: { id: 'alice', role: 'USER', source: 'CONFIGURED' },
      targetActor: { id: 'bob', role: 'USER', source: 'CONFIGURED' },
      action: { kind: 'UPDATE' },
      resource: { kind: 'USER_PROFILE', identifiers: {} },
      expected: { kind: 'DENY', status: 403, explicit: true },
      normalizationStatus: 'COMPLETE',
    });
    expect(fact?.canonical.scopes).toContainEqual(expect.objectContaining({ dimension: 'USER', relation: 'OTHER' }));
  });

  it('derives only applicable parameter strategies; optional does not become Required/Missing', () => {
    const requirement = parseAcceptanceRequirement(`# 参数约束
POST /users
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 可空 | 范围 |
| --- | --- | --- | --- | --- | --- |
| age | body | integer | 是 | 否 | 18~60 |
| nickname | body | string | 否 | 是 | |
| 状态码 | 描述 |
| --- | --- |
| 200 | ok |
| 400 | invalid |`);
    const design = buildAcceptanceTestDesign(requirement);
    const age = requirement.factLedger.find((fact) => fact.entityRefs.parameterNames.includes('age'))!;
    const nickname = requirement.factLedger.find((fact) => fact.entityRefs.parameterNames.includes('nickname'))!;
    const ageStrategies = design.objectives.filter((objective) => objective.factIds.includes(age.id)).flatMap((objective) => objective.strategies);
    const nicknameStrategies = design.objectives.filter((objective) => objective.factIds.includes(nickname.id)).flatMap((objective) => objective.strategies);

    expect(age.canonical.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'REQUIRED', field: 'age' }),
      expect.objectContaining({ kind: 'RANGE', field: 'age', min: 18, max: 60 }),
    ]));
    expect(ageStrategies).toEqual(expect.arrayContaining(['REQUIRED_MISSING', 'MIN_MAX_BOUNDARY']));
    expect(nickname.canonical.constraints.some((constraint) => constraint.kind === 'REQUIRED')).toBe(false);
    expect(nicknameStrategies).not.toContain('REQUIRED_MISSING');
  });

  it('uses one declarative policy to add CRUD functional, UI state, state error and side-effect strategies', () => {
    expect(TEST_STRATEGY_POLICY.every((rule) => Boolean(rule.id) && Boolean(rule.dimension) && rule.strategies.length > 0)).toBe(true);
    const requirement = parseAcceptanceRequirement(`# 策略覆盖
POST /orders
该接口无需认证
返回 201、409
AC-1 POST /orders 创建订单返回 201。
点击保存后按钮必须进入 loading 状态，失败时必须显示错误提示。
订单必须从 PAID 转为 SHIPPED，非法流转返回 409。
支付成功后必须扣款。`);
    const design = buildAcceptanceTestDesign(requirement);
    const dimensionsFor = (fragment: string) => new Set(design.objectives
      .filter((objective) => requirement.factLedger.some((fact) => fact.id === objective.factIds[0] && fact.statement.includes(fragment)))
      .map((objective) => objective.dimension));

    expect(dimensionsFor('创建订单').has('API')).toBe(true);
    expect(dimensionsFor('创建订单').has('FUNCTIONAL')).toBe(true);
    expect(dimensionsFor('loading').has('UI')).toBe(true);
    expect(dimensionsFor('loading').has('STATE')).toBe(true);
    expect(dimensionsFor('loading').has('ERROR')).toBe(true);
    expect(dimensionsFor('PAID').has('STATE')).toBe(true);
    expect(dimensionsFor('PAID').has('ERROR')).toBe(true);
    expect(dimensionsFor('扣款').has('SIDE_EFFECT')).toBe(true);
  });

  it('does not generate Strategy/Objectives from a conflicting BLOCKED Fact', () => {
    const requirement = parseAcceptanceRequirement(`# 冲突
GET /orders
该接口无需认证
返回 200、404
AC-1 GET /orders 返回 200
AC-1 GET /orders 返回 404`);
    const blocked = requirement.factLedger.find((fact) => fact.status === 'BLOCKED');
    const design = buildAcceptanceTestDesign(requirement);
    expect(blocked).toBeDefined();
    expect(design.objectives.some((objective) => objective.factIds.includes(blocked!.id))).toBe(false);
    expect(blocked).toMatchObject({ status: 'BLOCKED', linkedObjectiveIds: [] });
  });

  it('keeps an epistemic inference heuristic and designed-only even when its document provenance is explicit', () => {
    const requirement = parseAcceptanceRequirement(`# 推导需求不得直接验收
GET /orders
该接口无需认证
返回 200
因此可以推断用户查询订单必须成功。`);
    const inferredFact = requirement.factLedger.find((fact) => fact.statement.includes('因此可以推断'))!;
    const design = buildAcceptanceTestDesign(requirement);
    const inferredObjectives = design.objectives.filter((objective) => objective.factIds.includes(inferredFact.id));
    const quality = applyTestCaseQualityGate({
      requirement,
      objectives: design.objectives,
      testCases: generateAcceptanceApiCases(requirement, generateTestPoints(requirement, design)),
    });
    const inferredCases = quality.testCases.filter((testCase) => testCase.source?.factIds?.includes(inferredFact.id));

    expect(inferredFact).toMatchObject({ epistemicType: 'INFERENCE', provenance: 'EXPLICIT' });
    expect(inferredObjectives.length).toBeGreaterThan(0);
    expect(inferredObjectives.every((objective) => objective.sourceType === 'HEURISTIC')).toBe(true);
    expect(inferredCases.length).toBeGreaterThan(0);
    expect(inferredCases.every((testCase) => testCase.source?.sourceType === 'HEURISTIC'
      && testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
  });

  it('keeps Generator bound to canonical DENY/Actor/Target even if display text drifts later', () => {
    const requirement = parseAcceptanceRequirement(`# 权限漂移
GET /users/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | bob |
| 状态码 | 描述 |
| --- | --- |
| 200 | ok |
| 403 | forbidden |
## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| alice | alice | USER | alice-token |
| bob | bob | USER | bob-token |
AC-1 alice 不允许访问 bob，返回 403。`);
    const design = buildAcceptanceTestDesign(requirement);
    const point = generateTestPoints(requirement, design).find((candidate) => candidate.dimension === 'PERMISSION'
      && candidate.canonicalFact.actor?.id === 'alice'
      && candidate.canonicalFact.targetActor?.id === 'bob')!;
    expect(point).toBeDefined();
    point.objective = 'alice 可以访问 bob，返回 200（仅模拟下游展示文本漂移）';
    const cases = generateAcceptanceApiCases(requirement, [point]);
    const actual = cases.find((testCase) => testCase.executionMode === 'EXECUTABLE');
    expect(actual).toMatchObject({ actor: { id: 'alice' }, data: { targetId: 'bob' } });
    expect(actual?.assertions).toContainEqual(expect.objectContaining({ type: 'STATUS_CODE', expected: 403 }));
    expect(cases.some((testCase) => testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE' && assertion.expected === 200))).toBe(false);
  });

  it('keeps an explicit action with no Expected Outcome UNKNOWN instead of inventing PASS', () => {
    const requirement = parseAcceptanceRequirement('# 查询订单\n\n查询订单。');
    const fact = requirement.factLedger.find((candidate) => candidate.statement === '查询订单。')!;
    const design = buildAcceptanceTestDesign(requirement);
    const objective = design.objectives.find((candidate) => candidate.factIds.includes(fact.id));
    expect(fact.canonical).toMatchObject({ action: { kind: 'READ' }, expected: { kind: 'UNKNOWN', explicit: false } });
    expect(objective).toMatchObject({ outcomeStatus: 'UNKNOWN', dimension: 'FUNCTIONAL' });
  });

  it('normalizes the Chinese “到” range into a central boundary strategy', () => {
    const requirement = parseAcceptanceRequirement('# 年龄\n\nage 字段必须为 18 到 60 的整数，越界时返回错误。');
    const fact = requirement.factLedger.find((candidate) => candidate.statement.includes('18 到 60'))!;
    const design = buildAcceptanceTestDesign(requirement);
    expect(fact.canonical.constraints).toContainEqual(expect.objectContaining({ kind: 'RANGE', min: 18, max: 60 }));
    expect(design.objectives).toContainEqual(expect.objectContaining({
      factIds: [fact.id], dimension: 'BOUNDARY', strategies: expect.arrayContaining(['MIN_MAX_BOUNDARY']),
    }));
  });

  it('does not turn an error response prohibition into permission/Actor semantics', () => {
    const requirement = parseAcceptanceRequirement(`# 查询报表
GET /reports
该接口无需认证
| 状态码 | 描述 |
| --- | --- |
| 200 | 成功 |
| 503 | 下游不可用 |
AC-1 下游服务超时时，接口必须返回 503 且不得返回过期报表。`);
    const fact = requirement.factLedger.find((candidate) => candidate.statement.includes('过期报表'))!;
    const design = buildAcceptanceTestDesign(requirement);
    const cases = generateAcceptanceApiCases(requirement, generateTestPoints(requirement, design));
    const errorCase = cases.find((testCase) => testCase.source?.factIds?.includes(fact.id));

    expect(fact.canonical.expected).toMatchObject({ kind: 'STATUS', status: 503 });
    expect(fact.canonical.unresolved).not.toContain('ACTOR_UNRESOLVED');
    expect(errorCase).toMatchObject({ testType: 'ERROR', executionMode: 'DESIGNED_ONLY' });
    expect(errorCase?.actor).toBeUndefined();
    expect(errorCase?.design?.reason).toContain('ERROR_SCENARIO_UNSUPPORTED');
    expect(errorCase?.design?.reason).not.toContain('ACTOR_CONTEXT_INCOMPLETE');
  });

  it('retains non-HTTP business/performance semantics as explicit designed-only work', () => {
    const atomic = parseAcceptanceRequirement(`# 原子订单
POST /orders
该接口无需认证
返回 201
AC-1 订单创建和库存扣减必须原子完成；任一失败时全部回滚。`);
    const atomicFact = atomic.factLedger.find((candidate) => candidate.statement.includes('原子完成'))!;
    const atomicDesign = buildAcceptanceTestDesign(atomic);
    const atomicCase = generateAcceptanceApiCases(atomic, generateTestPoints(atomic, atomicDesign))
      .find((testCase) => testCase.testType === 'BUSINESS_RULE' && testCase.source?.factIds?.includes(atomicFact.id));
    expect(atomicCase).toMatchObject({ executionMode: 'DESIGNED_ONLY' });
    expect(atomicCase?.design?.reason).toContain('BUSINESS_OBSERVABILITY_MISSING');

    const performance = parseAcceptanceRequirement(`# 查询性能
GET /orders
该接口无需认证
返回 200
AC-1 订单查询性能应当足够快。`);
    const performanceFact = performance.factLedger.find((candidate) => candidate.statement.includes('足够快'))!;
    const performanceDesign = buildAcceptanceTestDesign(performance);
    const performanceCase = generateAcceptanceApiCases(performance, generateTestPoints(performance, performanceDesign))
      .find((testCase) => testCase.source?.factIds?.includes(performanceFact.id));
    expect(performanceCase).toMatchObject({ testType: 'PERFORMANCE', executionMode: 'DESIGNED_ONLY' });
    expect(performanceCase?.design?.reason).toContain('PERFORMANCE_EXECUTOR_UNAVAILABLE');
  });

  it('never promotes schema tokens to real resource identifiers or stale operation bindings', () => {
    const requirement = parseAcceptanceRequirement(`# Item
GET /items/{itemId}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| itemId | path | string | 是 |
返回 200
AC-1 DELETE /items/{itemId} 删除成功返回 204`);
    const parameterFact = requirement.factLedger.find((fact) => fact.statement.includes('itemId：type=string'))!;
    const criterionFact = requirement.factLedger.find((fact) => fact.statement.includes('DELETE /items/{itemId}'))!;
    const points = generateTestPoints(requirement, buildAcceptanceTestDesign(requirement));
    const criterionPoint = points.find((point) => point.factIds.includes(criterionFact.id) && point.dimension === 'API')!;

    expect(parameterFact.canonical.resource.identifiers).not.toHaveProperty('itemId');
    expect(criterionFact.canonical.action).toMatchObject({ kind: 'DELETE', operationKey: 'DELETE /items/{itemId}' });
    expect(criterionPoint.apiBinding).toBeUndefined();
    expect(criterionPoint.bindingIssue).toMatchObject({ code: 'API_NOT_FOUND', blocking: true });
    expect(generateAcceptanceApiCases(requirement, points).some((testCase) => testCase.steps.some((step) =>
      step.type === 'HTTP_REQUEST' && step.pathParams?.itemId === 'type'))).toBe(false);
  });
});
