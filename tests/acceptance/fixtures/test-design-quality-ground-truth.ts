import type { TestDesignGroundTruth } from '../../../src/acceptance/test-design-quality-metrics.js';

/**
 * Human-authored before observing parser/generator output.  These are semantic
 * oracles, not snapshots: no production ids, generated names or case counts are
 * copied into this fixture.
 */
export const TEST_DESIGN_QUALITY_GROUND_TRUTH: TestDesignGroundTruth[] = [
  {
    id: 'CRUD',
    documentId: 'quality-crud.md',
    markdown: `# 创建订单

POST /orders
该接口无需认证
返回 201

AC-1 用户提交有效订单后，系统必须创建订单并返回 201。`,
    facts: [{
      id: 'CRUD-CREATE',
      sourceText: 'AC-1 用户提交有效订单后，系统必须创建订单并返回 201。',
      semanticFragments: ['用户', '有效订单', '创建订单', '201'],
      allowedCategories: ['FUNCTIONAL', 'API'],
    }],
    objectives: [{ id: 'CRUD-CREATE-API', sourceFactId: 'CRUD-CREATE', dimension: 'API', semanticFragments: ['创建订单'] }],
    cases: [{
      id: 'CRUD-CREATE-POSITIVE', sourceFactIds: ['CRUD-CREATE'], testTypes: ['FUNCTIONAL', 'API'],
      executionModes: ['EXECUTABLE'], semanticFragments: ['创建订单'], expectedStatus: 201,
    }],
    expectedBlockingWarningCodes: [],
    prohibitedInterpretations: [
      { id: 'CRUD-NO-DELETE', semanticFragments: ['删除订单'] },
      { id: 'CRUD-NO-AUTH', semanticFragments: ['管理员'] },
    ],
  },
  {
    id: 'PARAMETER_RANGE',
    documentId: 'quality-range.md',
    markdown: `# 创建用户

POST /users
该接口无需认证

| 参数 | 位置 | 类型 | 必填 | 可空 | 最小值 | 最大值 |
| --- | --- | --- | --- | --- | --- | --- |
| age | body | integer | 是 | 否 | 18 | 60 |

| 状态码 | 描述 |
| --- | --- |
| 201 | 创建成功 |
| 400 | 参数越界 |

AC-1 age 必须是 18 到 60 的整数；合法值返回 201，越界值返回 400。`,
    facts: [{
      id: 'RANGE-AGE',
      sourceText: 'AC-1 age 必须是 18 到 60 的整数；合法值返回 201，越界值返回 400。',
      semanticFragments: ['age', '18', '60', '整数', '201', '400'],
      allowedCategories: ['VALIDATION', 'BOUNDARY'],
    }],
    objectives: [
      { id: 'RANGE-AGE-VALIDATION', sourceFactId: 'RANGE-AGE', dimension: 'PARAMETER_VALIDATION', semanticFragments: ['age'] },
      { id: 'RANGE-AGE-BOUNDARY', sourceFactId: 'RANGE-AGE', dimension: 'BOUNDARY', semanticFragments: ['18', '60'] },
    ],
    cases: [
      { id: 'RANGE-MIN-MINUS', sourceFactIds: ['RANGE-AGE'], testTypes: ['PARAMETER', 'BOUNDARY'], parameter: 'age', boundaryVectors: ['MIN_MINUS'], expectedStatus: 400 },
      { id: 'RANGE-MIN', sourceFactIds: ['RANGE-AGE'], testTypes: ['PARAMETER', 'BOUNDARY'], parameter: 'age', boundaryVectors: ['MIN'], expectedStatus: 201 },
      { id: 'RANGE-MAX', sourceFactIds: ['RANGE-AGE'], testTypes: ['PARAMETER', 'BOUNDARY'], parameter: 'age', boundaryVectors: ['MAX'], expectedStatus: 201 },
      { id: 'RANGE-MAX-PLUS', sourceFactIds: ['RANGE-AGE'], testTypes: ['PARAMETER', 'BOUNDARY'], parameter: 'age', boundaryVectors: ['MAX_PLUS'], expectedStatus: 400 },
    ],
    expectedBlockingWarningCodes: [],
    prohibitedInterpretations: [{ id: 'RANGE-NO-AGE-ZERO-MIN', semanticFragments: ['最小值', '0'] }],
  },
  {
    id: 'PERMISSION',
    documentId: 'quality-permission.md',
    markdown: `# 查看审计日志

GET /audit

| 参数 | 位置 | 类型 | 必填 |
| --- | --- | --- | --- |
| Authorization | header | string | 是 |

| 状态码 | 描述 |
| --- | --- |
| 200 | 查看成功 |
| 403 | 权限不足 |

## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| admin-root | admin-1 | ADMIN | admin-token |
| member-one | member-1 | USER | member-token |

AC-1 管理员 admin-root 可以查看审计日志，返回 200。
AC-2 普通用户 member-one 不得查看审计日志，返回 403。`,
    facts: [
      {
        id: 'PERMISSION-ADMIN-ALLOW', sourceText: 'AC-1 管理员 admin-root 可以查看审计日志，返回 200。',
        semanticFragments: ['admin-root', '查看审计日志', '200'], allowedCategories: ['PERMISSION'],
      },
      {
        id: 'PERMISSION-USER-DENY', sourceText: 'AC-2 普通用户 member-one 不得查看审计日志，返回 403。',
        semanticFragments: ['member-one', '不得', '查看审计日志', '403'], allowedCategories: ['PERMISSION'],
      },
    ],
    objectives: [
      { id: 'PERMISSION-ADMIN-ALLOW-OBJECTIVE', sourceFactId: 'PERMISSION-ADMIN-ALLOW', dimension: 'PERMISSION', semanticFragments: ['admin-root'] },
      { id: 'PERMISSION-USER-DENY-OBJECTIVE', sourceFactId: 'PERMISSION-USER-DENY', dimension: 'PERMISSION', semanticFragments: ['member-one'] },
    ],
    cases: [
      { id: 'PERMISSION-ADMIN-ALLOW-CASE', sourceFactIds: ['PERMISSION-ADMIN-ALLOW'], testTypes: ['PERMISSION'], executionModes: ['EXECUTABLE'], actorId: 'admin-root', expectedStatus: 200 },
      { id: 'PERMISSION-USER-DENY-CASE', sourceFactIds: ['PERMISSION-USER-DENY'], testTypes: ['PERMISSION'], executionModes: ['EXECUTABLE'], actorId: 'member-one', expectedStatus: 403 },
    ],
    expectedBlockingWarningCodes: [],
    prohibitedInterpretations: [{ id: 'PERMISSION-NO-GUEST', semanticFragments: ['访客'] }],
  },
  {
    id: 'TENANT_ISOLATION',
    documentId: 'quality-isolation.md',
    markdown: `# 查询租户订单

GET /orders/{id}

| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | tenant-b-order |
| Authorization | header | string | 是 | |

| 状态码 | 描述 |
| --- | --- |
| 403 | 跨租户拒绝 |

## Actors
| Actor ID | 用户 ID | 角色 | 租户 | Token Ref |
| --- | --- | --- | --- | --- |
| tenant-a-reader | alice | USER | tenant-A | tenant-a-token |
| tenant-b-owner | bob | USER | tenant-B | tenant-b-token |

AC-1 tenant-a-reader 不得访问 tenant-b-owner 在 tenant-B 的订单，返回 403。`,
    facts: [{
      id: 'ISOLATION-CROSS-TENANT',
      sourceText: 'AC-1 tenant-a-reader 不得访问 tenant-b-owner 在 tenant-B 的订单，返回 403。',
      semanticFragments: ['tenant-a-reader', '不得访问', 'tenant-b-owner', 'tenant-B', '403'],
      allowedCategories: ['DATA_ISOLATION'],
    }],
    objectives: [
      { id: 'ISOLATION-CROSS-TENANT-OBJECTIVE', sourceFactId: 'ISOLATION-CROSS-TENANT', dimension: 'DATA_ISOLATION', semanticFragments: ['tenant-B'] },
      { id: 'ISOLATION-CROSS-TENANT-PERMISSION', sourceFactId: 'ISOLATION-CROSS-TENANT', dimension: 'PERMISSION', semanticFragments: ['不得访问'] },
    ],
    cases: [{
      id: 'ISOLATION-A-TO-B', sourceFactIds: ['ISOLATION-CROSS-TENANT'],
      testTypes: ['DATA_ISOLATION', 'PERMISSION'], actorId: 'tenant-a-reader', expectedStatus: 403,
    }],
    expectedBlockingWarningCodes: [],
    prohibitedInterpretations: [{ id: 'ISOLATION-NO-TENANT-C', semanticFragments: ['tenant-C'] }],
  },
  {
    id: 'ATOMICITY',
    documentId: 'quality-atomicity.md',
    markdown: `# 创建订单

POST /orders
该接口无需认证
返回 201

AC-1 订单创建和库存扣减必须原子完成；任一失败时订单和库存都必须回滚。`,
    facts: [{
      id: 'ATOMICITY-ROLLBACK',
      sourceText: 'AC-1 订单创建和库存扣减必须原子完成；任一失败时订单和库存都必须回滚。',
      semanticFragments: ['订单创建', '库存扣减', '原子', '失败', '回滚'],
      allowedCategories: ['BUSINESS_RULE'],
    }],
    objectives: [{ id: 'ATOMICITY-OBJECTIVE', sourceFactId: 'ATOMICITY-ROLLBACK', dimension: 'BUSINESS_RULE', semanticFragments: ['全部回滚'] }],
    cases: [{
      id: 'ATOMICITY-PARTIAL-FAILURE', sourceFactIds: ['ATOMICITY-ROLLBACK'],
      testTypes: ['BUSINESS_RULE'], executionModes: ['DESIGNED_ONLY'], reasonCode: 'BUSINESS_OBSERVABILITY_MISSING',
    }],
    expectedBlockingWarningCodes: [],
  },
  {
    id: 'IDEMPOTENCY',
    documentId: 'quality-idempotency.md',
    markdown: `# 支付订单

POST /payments
该接口无需认证
返回 200

AC-1 相同 requestId 的重复支付必须幂等，只能产生一笔扣款和一个支付记录。`,
    facts: [{
      id: 'IDEMPOTENCY-PAYMENT',
      sourceText: 'AC-1 相同 requestId 的重复支付必须幂等，只能产生一笔扣款和一个支付记录。',
      semanticFragments: ['requestId', '重复支付', '幂等', '一笔扣款', '一个支付记录'],
      allowedCategories: ['BUSINESS_RULE'],
    }],
    objectives: [
      { id: 'IDEMPOTENCY-BUSINESS-OBJECTIVE', sourceFactId: 'IDEMPOTENCY-PAYMENT', dimension: 'BUSINESS_RULE', semanticFragments: ['重复执行'] },
      { id: 'IDEMPOTENCY-SIDE-EFFECT-OBJECTIVE', sourceFactId: 'IDEMPOTENCY-PAYMENT', dimension: 'SIDE_EFFECT', semanticFragments: ['扣款'] },
    ],
    cases: [{
      id: 'IDEMPOTENCY-REPEAT', sourceFactIds: ['IDEMPOTENCY-PAYMENT'],
      testTypes: ['BUSINESS_RULE', 'SIDE_EFFECT'], executionModes: ['DESIGNED_ONLY'],
    }],
    expectedBlockingWarningCodes: ['UNVERIFIED_REQUIREMENT_FACT'],
  },
  {
    id: 'STATE_TRANSITION',
    documentId: 'quality-state.md',
    markdown: `# 支付订单

POST /orders/{id}/pay
该接口无需认证

| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | order-1 |

| 状态码 | 描述 |
| --- | --- |
| 200 | 支付成功 |
| 409 | 状态冲突 |

AC-1 订单只能从 PENDING 转为 PAID；其他起始状态必须返回 409。`,
    facts: [{
      id: 'STATE-PENDING-PAID',
      sourceText: 'AC-1 订单只能从 PENDING 转为 PAID；其他起始状态必须返回 409。',
      semanticFragments: ['PENDING', 'PAID', '其他起始状态', '409'],
      allowedCategories: ['STATE'],
      acceptableOmissionWarningCodes: ['UNVERIFIED_REQUIREMENT_FACT'],
    }],
    objectives: [
      { id: 'STATE-TRANSITION-OBJECTIVE', sourceFactId: 'STATE-PENDING-PAID', dimension: 'STATE', semanticFragments: ['PENDING', 'PAID'] },
      { id: 'STATE-ERROR-OBJECTIVE', sourceFactId: 'STATE-PENDING-PAID', dimension: 'ERROR', semanticFragments: ['409'] },
    ],
    cases: [{
      id: 'STATE-INVALID-TRANSITION', sourceFactIds: ['STATE-PENDING-PAID'],
      testTypes: ['STATE', 'ERROR'], executionModes: ['DESIGNED_ONLY'],
    }],
    expectedBlockingWarningCodes: ['UNVERIFIED_REQUIREMENT_FACT'],
  },
  {
    id: 'UI_STATE',
    documentId: 'quality-ui.md',
    markdown: `# 保存资料

入口页面为 /profile。

AC-1 用户点击保存后，按钮必须显示 loading 并 disabled；失败时必须显示错误提示。`,
    facts: [{
      id: 'UI-SAVE-STATES',
      sourceText: 'AC-1 用户点击保存后，按钮必须显示 loading 并 disabled；失败时必须显示错误提示。',
      semanticFragments: ['点击保存', '按钮', 'loading', 'disabled', '失败', '错误提示'],
      allowedCategories: ['UI'],
    }],
    objectives: [
      { id: 'UI-STATE-OBJECTIVE', sourceFactId: 'UI-SAVE-STATES', dimension: 'UI', semanticFragments: ['loading', 'disabled'] },
      { id: 'UI-ERROR-OBJECTIVE', sourceFactId: 'UI-SAVE-STATES', dimension: 'ERROR', semanticFragments: ['失败', '错误提示'] },
      { id: 'UI-STATE-DIMENSION', sourceFactId: 'UI-SAVE-STATES', dimension: 'STATE', semanticFragments: ['disabled'] },
    ],
    cases: [{
      id: 'UI-SAVE-DESIGNED', sourceFactIds: ['UI-SAVE-STATES'], testTypes: ['UI'],
      executionModes: ['DESIGNED_ONLY'], semanticFragments: ['loading', 'disabled'], reasonCode: 'UI_EXECUTOR_UNAVAILABLE',
    }],
    expectedBlockingWarningCodes: [],
  },
  {
    id: 'ERROR_HANDLING',
    documentId: 'quality-error.md',
    markdown: `# 查询报表

GET /reports
该接口无需认证

| 状态码 | 描述 |
| --- | --- |
| 200 | 查询成功 |
| 503 | 下游不可用 |

AC-1 下游服务超时时，接口必须返回 503 且不得返回过期报表。`,
    facts: [{
      id: 'ERROR-DOWNSTREAM-TIMEOUT',
      sourceText: 'AC-1 下游服务超时时，接口必须返回 503 且不得返回过期报表。',
      semanticFragments: ['下游服务', '超时', '503', '不得返回', '过期报表'],
      allowedCategories: ['ERROR'],
    }],
    objectives: [{ id: 'ERROR-TIMEOUT-OBJECTIVE', sourceFactId: 'ERROR-DOWNSTREAM-TIMEOUT', dimension: 'ERROR', semanticFragments: ['503'] }],
    cases: [{
      id: 'ERROR-TIMEOUT-CASE', sourceFactIds: ['ERROR-DOWNSTREAM-TIMEOUT'],
      testTypes: ['ERROR'], executionModes: ['DESIGNED_ONLY'], expectedStatus: 503,
    }],
    expectedBlockingWarningCodes: [],
    prohibitedInterpretations: [{ id: 'ERROR-NO-504', semanticFragments: ['504'] }],
  },
  {
    id: 'HYBRID_UI_API_DATA',
    documentId: 'quality-hybrid.md',
    markdown: `# 创建订单

POST /orders
该接口无需认证
返回 201

AC-1 用户点击创建按钮后，页面必须提交订单。
AC-2 提交动作必须调用 POST /orders 并返回 201。
AC-3 订单创建和库存扣减必须原子完成。
AC-4 创建完成后页面必须刷新显示新订单。`,
    facts: [
      {
        id: 'HYBRID-UI-ACTION', sourceText: 'AC-1 用户点击创建按钮后，页面必须提交订单。',
        semanticFragments: ['点击创建按钮', '页面', '提交订单'], allowedCategories: ['UI'],
      },
      {
        id: 'HYBRID-API-ACTION', sourceText: 'AC-2 提交动作必须调用 POST /orders 并返回 201。',
        semanticFragments: ['POST', '/orders', '201'], allowedCategories: ['API'],
      },
      {
        id: 'HYBRID-ATOMICITY', sourceText: 'AC-3 订单创建和库存扣减必须原子完成。',
        semanticFragments: ['订单创建', '库存扣减', '原子'], allowedCategories: ['BUSINESS_RULE'],
      },
      {
        id: 'HYBRID-UI-RESULT', sourceText: 'AC-4 创建完成后页面必须刷新显示新订单。',
        semanticFragments: ['页面', '刷新显示', '新订单'], allowedCategories: ['UI'],
      },
    ],
    objectives: [
      { id: 'HYBRID-UI-ACTION-OBJECTIVE', sourceFactId: 'HYBRID-UI-ACTION', dimension: 'UI' },
      { id: 'HYBRID-API-OBJECTIVE', sourceFactId: 'HYBRID-API-ACTION', dimension: 'API' },
      { id: 'HYBRID-ATOMICITY-OBJECTIVE', sourceFactId: 'HYBRID-ATOMICITY', dimension: 'BUSINESS_RULE' },
      { id: 'HYBRID-UI-RESULT-OBJECTIVE', sourceFactId: 'HYBRID-UI-RESULT', dimension: 'UI' },
    ],
    cases: [
      { id: 'HYBRID-UI-ACTION-CASE', sourceFactIds: ['HYBRID-UI-ACTION'], testTypes: ['UI'], executionModes: ['DESIGNED_ONLY'] },
      { id: 'HYBRID-API-CASE', sourceFactIds: ['HYBRID-API-ACTION'], testTypes: ['API'], executionModes: ['EXECUTABLE'], expectedStatus: 201 },
      { id: 'HYBRID-ATOMICITY-CASE', sourceFactIds: ['HYBRID-ATOMICITY'], testTypes: ['BUSINESS_RULE'], executionModes: ['DESIGNED_ONLY'] },
      { id: 'HYBRID-UI-RESULT-CASE', sourceFactIds: ['HYBRID-UI-RESULT'], testTypes: ['UI'], executionModes: ['DESIGNED_ONLY'] },
    ],
    expectedBlockingWarningCodes: [],
  },
  {
    id: 'CONFLICT',
    documentId: 'quality-conflict.md',
    markdown: `# 删除订单

DELETE /orders/{id}
该接口无需认证
返回 204、403

AC-1 普通用户可以删除订单，返回 204。
AC-2 普通用户不得删除订单，返回 403。`,
    facts: [
      {
        id: 'CONFLICT-ALLOW', sourceText: 'AC-1 普通用户可以删除订单，返回 204。',
        semanticFragments: ['普通用户', '可以删除订单', '204'], allowedCategories: ['PERMISSION'],
        acceptableOmissionWarningCodes: ['REQUIREMENT_CONFLICT'],
      },
      {
        id: 'CONFLICT-DENY', sourceText: 'AC-2 普通用户不得删除订单，返回 403。',
        semanticFragments: ['普通用户', '不得删除订单', '403'], allowedCategories: ['PERMISSION'],
        acceptableOmissionWarningCodes: ['REQUIREMENT_CONFLICT'],
      },
    ],
    objectives: [],
    cases: [],
    expectedBlockingWarningCodes: ['REQUIREMENT_CONFLICT'],
  },
  {
    id: 'AMBIGUOUS',
    documentId: 'quality-ambiguous.md',
    markdown: `# 查询订单

GET /orders
该接口无需认证
返回 200

AC-1 订单查询性能应当足够快。`,
    facts: [{
      id: 'AMBIGUOUS-PERFORMANCE',
      sourceText: 'AC-1 订单查询性能应当足够快。',
      semanticFragments: ['订单查询', '性能', '足够快'],
      allowedCategories: ['PERFORMANCE'],
    }],
    objectives: [{
      id: 'AMBIGUOUS-PERFORMANCE-OBJECTIVE', sourceFactId: 'AMBIGUOUS-PERFORMANCE',
      dimension: 'PERFORMANCE', semanticFragments: ['足够快'],
    }],
    cases: [{
      id: 'AMBIGUOUS-PERFORMANCE-DESIGN', sourceFactIds: ['AMBIGUOUS-PERFORMANCE'],
      testTypes: ['PERFORMANCE'], executionModes: ['DESIGNED_ONLY'],
    }],
    expectedBlockingWarningCodes: [],
    prohibitedInterpretations: [
      { id: 'AMBIGUOUS-NO-LATENCY', semanticFragments: ['100ms'] },
      { id: 'AMBIGUOUS-NO-QPS', semanticFragments: ['1000qps'] },
    ],
  },
];

export const TEST_DESIGN_BENCHMARK_DIMENSIONS = [
  'CRUD', 'PARAMETER_RANGE', 'PERMISSION', 'TENANT_ISOLATION', 'ATOMICITY', 'IDEMPOTENCY',
  'STATE_TRANSITION', 'UI_STATE', 'ERROR_HANDLING', 'HYBRID_UI_API_DATA', 'CONFLICT', 'AMBIGUOUS',
] as const;
