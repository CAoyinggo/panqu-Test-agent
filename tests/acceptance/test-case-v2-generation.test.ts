import { describe, expect, it, vi } from 'vitest';
import {
  checkDslExecutable,
  normalizeTestCase,
  validateTestCase,
  type TestAspect,
  type TestCase,
} from '../../src/agents/test-design/testcase-schema.js';
import { ApiProcessor, runAcceptanceApiCases } from '../../src/acceptance/api-processor.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { applyTestCaseQualityGate } from '../../src/acceptance/test-case-quality-gate.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';

function compile(markdown: string, documentId = 'test-case-v2.md') {
  const requirement = parseAcceptanceRequirement(markdown, { documentId });
  const design = buildAcceptanceTestDesign(requirement);
  const points = generateTestPoints(requirement, design);
  const cases = generateAcceptanceApiCases(requirement, points);
  return { requirement, objectives: design.objectives, cases };
}

function caseForOperation(cases: TestCase[], operationKey: string, criterionId: string): TestCase {
  const testCase = cases.find((candidate) => candidate.executionMode === 'EXECUTABLE'
    && candidate.source?.apiOperationKey === operationKey
    && candidate.source.acceptanceCriteriaIds.includes(criterionId));
  expect(testCase, `missing executable ${operationKey}/${criterionId}`).toBeDefined();
  return testCase!;
}

function expectExecutableV2Contract(
  testCase: TestCase,
  requirementId: string,
  criterionId: string,
): void {
  expect(testCase).toMatchObject({
    schemaVersion: 'TEST_CASE_V2',
    source: {
      requirementId,
      factIds: expect.any(Array),
      acceptanceCriteriaIds: expect.arrayContaining([criterionId]),
    },
    testType: expect.any(String),
    testAspects: expect.any(Array),
    priority: expect.stringMatching(/^P[0-3]$/),
    businessScenario: {
      title: expect.any(String),
      goal: expect.any(String),
      expectedBusinessOutcome: expect.any(String),
      factIds: expect.any(Array),
      acceptanceCriteriaIds: expect.arrayContaining([criterionId]),
    },
    executionMode: 'EXECUTABLE',
    requirementStatus: 'CONFIRMED',
    preconditions: expect.any(Array),
    preconditionPlan: expect.any(Array),
    data: expect.any(Object),
    testData: expect.any(Array),
    expected: expect.any(Object),
    cleanup: expect.any(Array),
    dependencies: expect.any(Array),
    tags: expect.any(Array),
    readiness: { status: 'READY' },
    oracle: {
      mode: 'ALL',
      deterministic: true,
      status: 'READY',
      assertionIds: expect.any(Array),
      evidenceRequirementIds: expect.any(Array),
    },
  });

  expect(testCase.source?.factIds?.length).toBeGreaterThan(0);
  expect(testCase.testAspects?.length).toBeGreaterThan(0);
  expect(testCase.steps.length).toBeGreaterThan(0);
  expect(testCase.assertions.length).toBeGreaterThan(0);
  expect(testCase.evidenceRequirements?.length).toBeGreaterThan(0);
  expect(testCase.dependencies?.length).toBeGreaterThan(0);

  for (const step of testCase.steps) {
    expect(step).toMatchObject({
      id: expect.any(String),
      channel: expect.any(String),
      description: expect.any(String),
      execution: 'EXECUTABLE',
      factIds: expect.any(Array),
      acceptanceCriteriaIds: expect.arrayContaining([criterionId]),
    });
    expect(step.factIds?.length).toBeGreaterThan(0);
  }

  const evidenceIds = new Set(testCase.evidenceRequirements?.map((item) => item.id));
  const assertionIds = new Set(testCase.assertions.map((item) => item.id));
  for (const assertion of testCase.assertions) {
    expect(assertion).toMatchObject({
      id: expect.any(String),
      evidenceRequirementIds: expect.any(Array),
    });
    expect(assertion.evidenceRequirementIds?.length).toBeGreaterThan(0);
    expect(assertion.evidenceRequirementIds?.every((id) => evidenceIds.has(id))).toBe(true);
  }
  for (const evidence of testCase.evidenceRequirements ?? []) {
    expect(evidence).toMatchObject({
      id: expect.any(String),
      sourceStepId: expect.any(String),
      assertionIds: expect.any(Array),
    });
    expect(testCase.steps.some((step) => step.id === evidence.sourceStepId)).toBe(true);
    expect(evidence.assertionIds?.every((id) => assertionIds.has(id))).toBe(true);
  }
  expect(testCase.oracle?.assertionIds).toEqual(expect.arrayContaining([...assertionIds]));
  expect(testCase.oracle?.evidenceRequirementIds).toEqual(expect.arrayContaining(
    (testCase.evidenceRequirements ?? []).filter((item) => item.required).map((item) => item.id!),
  ));
}

const API_CASES = [
  {
    label: 'registration', operation: 'POST /users', criterion: 'AC-1',
    markdown: `# 用户注册
POST /users
该接口无需认证
返回 201
AC-1 POST /users 创建注册用户成功并返回 201。`,
  },
  {
    label: 'CRUD create', operation: 'POST /items', criterion: 'AC-1',
    markdown: `# 创建条目
POST /items
该接口无需认证
返回 201
AC-1 POST /items 创建条目成功并返回 201。`,
  },
  {
    label: 'CRUD read', operation: 'GET /items/{id}', criterion: 'AC-1',
    markdown: `# 查询条目
GET /items/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | item-1 |
返回 200
AC-1 GET /items/{id} 查询条目成功并返回 200。`,
  },
  {
    label: 'CRUD update', operation: 'PATCH /items/{id}', criterion: 'AC-1',
    markdown: `# 更新条目
PATCH /items/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | item-1 |
返回 200
AC-1 PATCH /items/{id} 更新条目成功并返回 200。`,
  },
  {
    label: 'CRUD delete', operation: 'DELETE /items/{id}', criterion: 'AC-1',
    markdown: `# 删除条目
DELETE /items/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | item-1 |
返回 204
AC-1 DELETE /items/{id} 删除条目成功并返回 204。`,
  },
] as const;

describe('TEST_CASE_V2 generation acceptance contract', () => {
  it.each(API_CASES)('emits a complete executable V2 contract for $label', ({ markdown, operation, criterion, label }) => {
    const { requirement, cases } = compile(markdown, `${label.replaceAll(' ', '-')}.md`);
    expectExecutableV2Contract(caseForOperation(cases, operation, criterion), requirement.id, criterion);
  });

  it('keeps an UNKNOWN expected result as NEED_CONFIRMATION/DESIGNED_ONLY/PLANNED without a fake Oracle', () => {
    const { cases } = compile('# 查询订单\n\n查询订单。', 'unknown-order.md');
    const unknown = cases.find((testCase) => testCase.businessScenario?.expectedBusinessOutcome.startsWith('UNKNOWN'));

    expect(unknown).toMatchObject({
      schemaVersion: 'TEST_CASE_V2',
      requirementStatus: 'NEED_CONFIRMATION',
      executionMode: 'DESIGNED_ONLY',
      readiness: { status: 'NEED_CONFIRMATION' },
      oracle: {
        deterministic: true,
        status: 'NEED_CONFIRMATION',
        assertionIds: [],
        evidenceRequirementIds: [],
      },
      expected: { description: expect.stringContaining('UNKNOWN') },
    });
    expect(unknown?.steps.length).toBeGreaterThan(0);
    expect(unknown?.steps.every((step) => step.execution === 'PLANNED')).toBe(true);
    expect(unknown?.assertions.filter((assertion) => assertion.type !== 'DESIGN_EXPECTATION')).toEqual([]);
    expect(unknown?.expected?.response).toBeUndefined();
  });

  const aspectFixtures: ReadonlyArray<{
    label: string;
    fact: string;
    expected: TestAspect[];
    absent?: TestAspect[];
    markdown: string;
  }> = [
    {
      label: 'login/authentication', fact: '未登录用户通过 POST /login', expected: ['AUTHENTICATION'],
      absent: ['IDEMPOTENCY', 'CONCURRENCY'],
      markdown: `# 用户登录
POST /login
该接口无需认证
返回 200
AC-1 未登录用户通过 POST /login 认证成功并返回 200。`,
    },
    {
      label: 'CRUD', fact: '创建记录成功', expected: ['API_CONTRACT', 'CORE_FUNCTION'],
      absent: ['IDEMPOTENCY', 'CONCURRENCY', 'STATE_TRANSITION'],
      markdown: `# 条目 CRUD
POST /items
该接口无需认证
返回 201
AC-1 POST /items 创建记录成功并返回 201。`,
    },
    {
      label: 'order payment cancellation', fact: '支付取消后订单状态', expected: ['STATE_TRANSITION', 'SIDE_EFFECT'],
      absent: ['IDEMPOTENCY', 'CONCURRENCY'],
      markdown: `# 支付取消
POST /orders/cancel
该接口无需认证
返回 200
AC-1 支付取消后订单状态必须从 PAID 转为 CANCELLED，且必须退回已扣款。`,
    },
    {
      label: 'state transition', fact: '订单状态必须从 PENDING 转为 PAID', expected: ['STATE_TRANSITION'],
      absent: ['IDEMPOTENCY', 'CONCURRENCY'],
      markdown: `# 订单状态
POST /orders/pay
该接口无需认证
返回 200、409
AC-1 订单状态必须从 PENDING 转为 PAID，非法状态返回 409。`,
    },
    {
      label: 'role permission', fact: '管理员可以查看订单', expected: ['ROLE_PERMISSION'],
      absent: ['TENANT_ISOLATION', 'IDEMPOTENCY'],
      markdown: `# 订单角色权限
GET /orders/{id}
| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | order-1 |
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| admin | admin-1 | ADMIN | admin-token |
返回 200
AC-1 管理员可以查看订单并返回 200。`,
    },
    {
      label: 'tenant isolation', fact: '跨租户 tenant B', expected: ['TENANT_ISOLATION'],
      absent: ['IDEMPOTENCY', 'CONCURRENCY'],
      markdown: `# 租户订单隔离
GET /orders/{id}
| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | bob |
| Actor ID | 用户 ID | 角色 | Tenant ID | Token Ref |
| --- | --- | --- | --- | --- |
| alice | alice | USER | tenant-a | alice-token |
| bob | bob | USER | tenant-b | bob-token |
返回 200、403
AC-1 alice 不得访问跨租户 tenant B 中 bob 的订单，返回 403。`,
    },
    {
      label: 'required parameter and type', fact: 'age：type=integer',
      expected: ['PARAMETER_REQUIRED', 'PARAMETER_TYPE'], absent: ['IDEMPOTENCY', 'CONCURRENCY'],
      markdown: `# 创建用户参数
POST /users
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 可空 |
| --- | --- | --- | --- | --- |
| age | body | integer | 是 | 否 |
返回 201、400
AC-1 POST /users 合法参数创建用户成功返回 201。`,
    },
    {
      label: 'idempotent duplicate submission', fact: '重复提交必须幂等',
      expected: ['IDEMPOTENCY', 'DUPLICATE_SUBMISSION'], absent: ['CONCURRENCY'],
      markdown: `# 提交订单
POST /orders
该接口无需认证
返回 201
AC-1 重复提交必须幂等，不得创建第二个订单。`,
    },
    {
      label: 'concurrent submission', fact: '并发提交只能创建一个订单',
      expected: ['CONCURRENCY', 'DATA_CONSISTENCY'], absent: ['IDEMPOTENCY'],
      markdown: `# 并发订单
POST /orders
该接口无需认证
返回 201
AC-1 并发提交只能创建一个订单，最终数据必须一致。`,
    },
    {
      label: 'delete recovery', fact: '删除失败后恢复到删除前状态',
      expected: ['ROLLBACK_RECOVERY'], absent: ['IDEMPOTENCY', 'CONCURRENCY'],
      markdown: `# 删除恢复
DELETE /orders/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | order-1 |
返回 204、500
AC-1 删除失败后恢复到删除前状态并回滚所有修改。`,
    },
    {
      label: 'frontend/backend consistency', fact: '前后端数据必须一致',
      expected: ['FRONTEND_BACKEND_CONSISTENCY', 'DATA_CONSISTENCY'],
      absent: ['IDEMPOTENCY', 'CONCURRENCY'],
      markdown: `# 订单详情一致性
GET /orders/{id}
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | order-1 |
返回 200
AC-1 订单页面显示与 GET /orders/{id} 返回的前后端数据必须一致。`,
    },
  ];

  it.each(aspectFixtures)('selects only fact-driven business aspects for $label', ({ markdown, fact, expected, absent, label }) => {
    const { requirement, cases } = compile(markdown, `aspect-${label.replaceAll('/', '-')}.md`);
    const trigger = requirement.factLedger.find((candidate) => candidate.statement.includes(fact));
    expect(trigger, `missing explicit fact containing: ${fact}`).toBeDefined();
    const linked = cases.filter((testCase) => testCase.source?.factIds?.includes(trigger!.id));
    expect(linked.length, `no generated case traces to ${trigger!.id}`).toBeGreaterThan(0);

    const linkedAspects = new Set(linked.flatMap((testCase) => testCase.testAspects ?? []));
    for (const aspect of expected) expect(linkedAspects.has(aspect), `${aspect} not selected`).toBe(true);
    for (const aspect of absent ?? []) expect(linkedAspects.has(aspect), `${aspect} was invented`).toBe(false);
  });

  it('does not attach high-risk aspects as a fixed template when no fact asks for them', () => {
    const { cases } = compile(`# 健康检查
GET /health
返回 200
AC-1 GET /health 成功返回 200。`, 'aspect-neutral.md');
    const aspects = new Set(cases.flatMap((testCase) => testCase.testAspects ?? []));
    const factDriven: TestAspect[] = [
      'ROLE_PERMISSION', 'TENANT_ISOLATION', 'STATE_TRANSITION', 'IDEMPOTENCY',
      'DUPLICATE_SUBMISSION', 'CONCURRENCY', 'FRONTEND_BACKEND_CONSISTENCY',
      'ROLLBACK_RECOVERY', 'SIDE_EFFECT',
    ];
    for (const aspect of factDriven) expect(aspects.has(aspect), `${aspect} should require an explicit fact`).toBe(false);
  });

  it('validates generated V2 nested contracts and rejects an incomplete executable Step', async () => {
    const { cases } = compile(API_CASES[1].markdown, 'schema-v2.md');
    const generated = caseForOperation(cases, API_CASES[1].operation, API_CASES[1].criterion);
    await expect(validateTestCase(structuredClone(generated) as unknown)).resolves.toMatchObject({
      schemaVersion: 'TEST_CASE_V2', readiness: { status: 'READY' }, oracle: { status: 'READY' },
    });

    const broken = structuredClone(generated) as TestCase;
    delete broken.steps[0].id;
    await expect(validateTestCase(broken as unknown)).rejects.toThrow('TestCase 校验失败');
  });

  it('quality gate fails closed when mutation cleanup or non-HTTP Evidence capability is missing', () => {
    const compiled = compile(API_CASES[1].markdown, 'quality-v2.md');
    const generated = caseForOperation(compiled.cases, API_CASES[1].operation, API_CASES[1].criterion);

    const missingCleanup = structuredClone(generated);
    missingCleanup.cleanup = [];
    const cleanupGate = applyTestCaseQualityGate({
      requirement: compiled.requirement, objectives: compiled.objectives, testCases: [missingCleanup],
    });
    expect(cleanupGate.assessments[0]).toMatchObject({
      status: 'BLOCKED', issues: expect.arrayContaining([expect.objectContaining({ code: 'CLEANUP_PLAN_MISSING' })]),
    });
    expect(cleanupGate.testCases[0].executionMode).toBe('DESIGNED_ONLY');
    expect(cleanupGate.testCases[0].steps.every((step) => step.execution === 'PLANNED')).toBe(true);

    const readCompiled = compile(API_CASES[2].markdown, 'observer-v2.md');
    const observerCase = structuredClone(caseForOperation(readCompiled.cases, API_CASES[2].operation, API_CASES[2].criterion));
    const assertionId = observerCase.assertions[0].id!;
    const stepId = observerCase.steps[0].id!;
    observerCase.evidenceRequirements!.push({
      id: 'EV-DATABASE', channel: 'DATABASE_STATE', phase: 'AFTER', required: true,
      expectation: 'CONSISTENT', description: '独立读回持久化状态', factIds: [...observerCase.source!.factIds!],
      sourceStepId: stepId, assertionIds: [assertionId],
    });
    observerCase.assertions[0].evidenceRequirementIds!.push('EV-DATABASE');
    observerCase.oracle!.evidenceRequirementIds.push('EV-DATABASE');
    const observerGate = applyTestCaseQualityGate({
      requirement: readCompiled.requirement, objectives: readCompiled.objectives, testCases: [observerCase],
    });
    expect(observerGate.assessments[0]).toMatchObject({
      status: 'DESIGNED_ONLY', issues: expect.arrayContaining([expect.objectContaining({ code: 'EXECUTOR_UNAVAILABLE' })]),
    });
  });

  it('UNKNOWN remains non-executable through quality gate and never invokes a Processor', async () => {
    const compiled = compile('# 查询订单\n\n查询订单。', 'unknown-runner.md');
    const gated = applyTestCaseQualityGate({
      requirement: compiled.requirement, objectives: compiled.objectives, testCases: compiled.cases,
    });
    const execute = vi.fn();
    const run = await runAcceptanceApiCases(gated.testCases, {
      baseUrl: 'http://127.0.0.1:1',
      processor: { execute } as unknown as ApiProcessor,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(run.results.length).toBeGreaterThan(0);
    expect(run.results.every((result) => result.executed === false && result.status !== 'PASS')).toBe(true);
  });

  it('mode=ALL Oracle cannot omit a runtime Assertion or required Evidence', async () => {
    const compiled = compile(API_CASES[2].markdown, 'oracle-all-v2.md');
    const generated = structuredClone(caseForOperation(compiled.cases, API_CASES[2].operation, API_CASES[2].criterion));
    generated.assertions.push({
      ...structuredClone(generated.assertions[0]), id: 'AS-OMITTED',
      message: '这条断言不得被 Oracle 静默省略',
    });
    expect(checkDslExecutable(generated).problems).toContain('Oracle mode=ALL 必须覆盖全部 Runtime Assertion 与 required Evidence');

    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const result = await new ApiProcessor().execute(generated, {
      baseUrl: 'http://acceptance.invalid', apiSpecs: compiled.requirement.apis, fetchImpl,
    });
    expect(result).toMatchObject({ status: 'NOT_EXECUTED', executed: false, processorInvoked: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when a V2 HTTP Case contains an unbound Step or operator-only Assertion', () => {
    const compiled = compile(API_CASES[2].markdown, 'processor-coverage-v2.md');
    const generated = structuredClone(caseForOperation(compiled.cases, API_CASES[2].operation, API_CASES[2].criterion));
    generated.steps.push({
      id: 'STEP-DATA', channel: 'DATA', action: 'query', description: '读取数据库状态',
      execution: 'EXECUTABLE', dependsOn: ['STEP-001'],
      acceptanceCriteriaIds: [...generated.source!.acceptanceCriteriaIds],
      factIds: [...generated.source!.factIds!],
    });
    expect(checkDslExecutable(generated).problems).toContain(
      '当前 HTTP Processor 要求 V2 API Case 仅包含一个 channel=API 的 HTTP_REQUEST',
    );

    generated.steps.pop();
    generated.assertions.push({
      id: 'AS-OPERATOR', channel: 'RESPONSE', target: 'response', operator: 'equals', expected: {},
      acceptanceCriteriaIds: [...generated.source!.acceptanceCriteriaIds],
      factIds: [...generated.source!.factIds!],
      evidenceRequirementIds: [generated.evidenceRequirements![0].id!],
    });
    generated.evidenceRequirements![0].assertionIds!.push('AS-OPERATOR');
    generated.oracle!.assertionIds.push('AS-OPERATOR');
    expect(checkDslExecutable(generated).problems).toContain(
      '当前 HTTP Processor 不支持 operator-only V2 Assertion',
    );
  });

  it('does not reuse an unrelated 401/403/404/500 response as a parameter-validation Oracle', () => {
    const { cases } = compile(`# 创建用户
POST /users
该接口无需认证
| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| age | body | integer | 是 |
返回 201、401
AC-1 POST /users 合法参数创建成功返回 201。`, 'parameter-unrelated-error.md');
    const negative = cases.filter((testCase) => testCase.parameterContext?.expectedOutcome === 'REJECT');
    expect(negative.length).toBeGreaterThan(0);
    expect(negative.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(negative.some((testCase) => testCase.assertions.some((assertion) =>
      assertion.type === 'STATUS_CODE' && assertion.expected === 401))).toBe(false);
  });

  it('does not substitute an Actor ID for a cross-tenant business resource ID', () => {
    const { cases } = compile(`# 租户订单隔离
GET /orders/{id}
该接口需要认证
| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| id | path | string | 是 |
| Authorization | header | string | 是 |
| Actor ID | 用户 ID | 角色 | Tenant ID | Token Ref |
| --- | --- | --- | --- | --- |
| alice | alice-user | USER | tenant-a | alice-token |
| bob | bob-user | USER | tenant-b | bob-token |
返回 403
AC-1 alice 不得访问 bob 在 tenant-b 中的订单，返回 403。`, 'tenant-resource-id.md');
    const isolation = cases.filter((testCase) => testCase.testType === 'DATA_ISOLATION');
    expect(isolation.length).toBeGreaterThan(0);
    expect(isolation.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(isolation.some((testCase) => String(testCase.metadata?.reason).includes('TEST_DATA_UNAVAILABLE'))).toBe(true);
  });

  it('does not invent a happy-path value for an unknown required parameter schema', () => {
    const { cases } = compile(`# 创建订单
POST /orders
该接口无需认证
| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| opaquePayload | body |  | 是 |
返回 201
AC-1 创建订单成功返回 201。`, 'unknown-required-parameter.md');
    const linked = cases.filter((testCase) => testCase.source?.apiOperationKey === 'POST /orders');
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(linked.some((testCase) => String(testCase.metadata?.reason).includes('TEST_DATA_UNAVAILABLE'))).toBe(true);
  });

  it('keeps null and string wrong-type transport vectors designed-only when HTTP serialization erases the fault', () => {
    const { cases } = compile(`# 搜索订单
GET /orders
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 可空 |
| --- | --- | --- | --- | --- |
| keyword | query | string | 是 | 否 |
返回 200、400
AC-1 keyword 必须是非空字符串；非法参数返回 400。`, 'transport-vector.md');
    const vectors = cases.filter((testCase) => testCase.parameterContext?.parameter === 'keyword');
    for (const kind of ['NULL', 'INVALID_TYPE']) {
      const testCase = vectors.find((candidate) => candidate.parameterContext?.boundaryVector === kind);
      expect(testCase, `missing ${kind} design`).toBeDefined();
      expect(testCase?.executionMode).toBe('DESIGNED_ONLY');
      expect(testCase?.metadata?.reason).toContain('TRANSPORT_VECTOR_UNREPRESENTABLE');
    }
  });

  it('keeps an explicit business-state precondition non-executable until a state resolver exists', () => {
    const compiled = compile(`# 取消订单
POST /orders/{id}/cancel
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | order-pending |
返回 200
AC-1 当订单状态为 PENDING 时，POST /orders/{id}/cancel 返回 200。`, 'state-precondition.md');
    const candidate = compiled.cases.find((testCase) =>
      testCase.source?.acceptanceCriteriaIds.includes('AC-1')
      && testCase.source.apiOperationKey === 'POST /orders/{id}/cancel');
    expect(candidate).toBeDefined();
    expect(candidate?.preconditionPlan?.some((item) => item.kind === 'STATE'
      && item.required && !item.checkRef)).toBe(true);
    expect(candidate?.executionMode).toBe('DESIGNED_ONLY');

    const gated = applyTestCaseQualityGate({
      requirement: compiled.requirement, objectives: compiled.objectives, testCases: [candidate!],
    });
    expect(gated.assessments[0]).toMatchObject({ status: 'DESIGNED_ONLY', executable: false });
  });

  it('normalizeTestCase preserves every V2 projection and contractDependencies', () => {
    const { cases } = compile(API_CASES[0].markdown, 'normalize-v2.md');
    const generated = caseForOperation(cases, API_CASES[0].operation, API_CASES[0].criterion);
    const input: TestCase = {
      ...structuredClone(generated),
      contractDependencies: [{
        contractId: 'contract-register-user',
        version: '2026-08-26',
        fingerprint: 'sha256:test-only',
        required: true,
        sources: [{ type: 'openapi', ref: 'openapi.yaml#/paths/~1users/post', priority: 100 }],
      }],
    };
    const normalized = normalizeTestCase(input as unknown as Record<string, unknown>);
    const fields = [
      'schemaVersion', 'source', 'testType', 'testAspects', 'priority', 'businessScenario',
      'preconditions', 'preconditionPlan', 'data', 'testData', 'steps', 'expected',
      'assertions', 'oracle', 'evidenceRequirements', 'cleanup', 'dependencies', 'tags',
      'readiness', 'requirementStatus', 'contractDependencies',
    ] as const;
    const actual = normalized as unknown as Record<string, unknown>;
    const expected = input as unknown as Record<string, unknown>;

    for (const field of fields) expect(actual[field], `${field} was changed or dropped`).toEqual(expected[field]);
  });
});
