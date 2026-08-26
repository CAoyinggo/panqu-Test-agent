/**
 * Independent Requirement -> Expected Test Design oracle.
 *
 * These expectations are intentionally written without importing production
 * parsers, classifiers, IDs, or generated output. Tests compare semantic
 * facts, vectors, actors and execution modes rather than snapshotting the
 * implementation's sequential IDs.
 */
export const DESIGN_GROUND_TRUTH = {
  atomicityWithoutProbe: {
    documentId: 'gt-atomicity-without-probe.md',
    markdown: `# 创建订单

POST /orders
该接口无需认证
返回 201

订单创建和库存扣减必须原子完成。`,
    factText: '订单创建和库存扣减必须原子完成。',
    category: 'BUSINESS_RULE',
    requiredDimension: 'BUSINESS_RULE',
    executionMode: 'DESIGNED_ONLY',
    reasonCode: 'BUSINESS_OBSERVABILITY_MISSING',
  },

  atomicityWithObservableFields: {
    documentId: 'gt-atomicity-observable.md',
    markdown: `# 创建订单

POST /orders
该接口无需认证
返回 201

订单创建和库存扣减必须原子完成，响应必须返回 created=true 且 stockAdjusted=true。`,
    factText: '订单创建和库存扣减必须原子完成，响应必须返回 created=true 且 stockAdjusted=true。',
    expectedStatus: 201,
    expectedBusinessFields: {
      created: true,
      stockAdjusted: true,
    },
  },

  userIsolation: {
    documentId: 'gt-user-isolation.md',
    markdown: `# 查询订单

GET /orders/{id}

## 参数

| 参数 | 位置 | 类型 | 必填 | 可空 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| id | path | string | 是 | 否 | bob-order |
| Authorization | header | string | 是 | 否 | |

## 响应

| 状态码 | 描述 |
| --- | --- |
| 200 | 查询成功 |
| 403 | 跨用户访问被拒绝 |

## Actors

| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| alice | alice | USER | alice-token |
| bob | bob | USER | bob-token |

alice 用户只能访问自己的订单。
alice 用户不得访问 bob 用户的订单，返回 403。`,
    sourceActor: 'alice',
    targetUserId: 'bob',
    targetResourceId: 'bob-order',
    expectedStatus: 403,
    requiredDimensions: ['DATA_ISOLATION', 'PERMISSION'],
  },

  tenantIsolation: {
    documentId: 'gt-tenant-isolation.md',
    markdown: `# 查询租户订单

GET /orders/{id}

## 参数

| 参数 | 位置 | 类型 | 必填 | 可空 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| id | path | string | 是 | 否 | tenant-b-order |
| Authorization | header | string | 是 | 否 | |

## 响应

| 状态码 | 描述 |
| --- | --- |
| 403 | 跨租户访问被拒绝 |

## Actors

| Actor ID | 用户 ID | 角色 | 租户 | Token Ref |
| --- | --- | --- | --- | --- |
| tenant-a-reader | alice | USER | tenant-A | tenant-a-token |
| tenant-b-owner | bob | USER | tenant-B | tenant-b-token |

tenant-a-reader 不得访问 tenant-b-owner 所属 tenant-B 的订单，返回 403。`,
    sourceActor: 'tenant-a-reader',
    sourceTenant: 'tenant-A',
    targetUserId: 'bob',
    targetResourceId: 'tenant-b-order',
    targetTenant: 'tenant-B',
    expectedStatus: 403,
  },

  ageBoundary: {
    documentId: 'gt-age-boundary.md',
    markdown: `# 更新年龄

PUT /users
该接口无需认证

## Body 参数

| 参数 | 位置 | 类型 | 必填 | 可空 | 范围 |
| --- | --- | --- | --- | --- | --- |
| age | body | integer | 是 | 否 | 18~60 |

## 响应

| 状态码 | 描述 |
| --- | --- |
| 200 | 参数合法 |
| 400 | 参数非法 |

age 必须为 18~60 的整数。`,
    parameter: 'age',
    vectors: {
      MIN_MINUS: 17,
      MIN: 18,
      MIN_PLUS: 19,
      MAX_MINUS: 59,
      MAX: 60,
      MAX_PLUS: 61,
      EMPTY: '',
      NULL: null,
      INVALID_TYPE: 'abc',
      DECIMAL: 18.5,
      EXTREME: Number.MAX_SAFE_INTEGER,
    },
  },

  explicitRoles: {
    documentId: 'gt-explicit-roles.md',
    markdown: `# 删除订单权限

DELETE /orders/{id}

## 参数

| 参数 | 位置 | 类型 | 必填 | 可空 | 默认值 |
| --- | --- | --- | --- | --- | --- |
| id | path | string | 是 | 否 | order-1 |
| Authorization | header | string | 是 | 否 | |

## 响应

| 状态码 | 描述 |
| --- | --- |
| 204 | 删除成功 |
| 403 | 权限不足 |

## Actors

| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| admin-root | admin-1 | ADMIN | admin-token |
| member-reader | member-1 | USER | member-token |
| guest-viewer | guest-1 | GUEST | guest-token |

管理员 admin-root 可以删除订单，返回 204。
普通用户 member-reader 不得删除订单，返回 403。
访客 guest-viewer 不得删除订单，返回 403。`,
    actorIds: ['admin-root', 'guest-viewer', 'member-reader'],
    roles: ['ADMIN', 'GUEST', 'USER'],
    forbiddenSyntheticActors: ['admin', 'tenant-b-user', 'user-a', 'user-b', 'user-c'],
  },

  underspecifiedQuery: {
    documentId: 'gt-underspecified-query.md',
    markdown: `# 查询订单

查询订单。`,
    factText: '查询订单。',
    category: 'FUNCTIONAL',
    status: 'UNVERIFIED',
    executionMode: 'DESIGNED_ONLY',
    forbiddenInferences: ['200', 'Bearer', 'tenantId', 'pagination'],
  },

  uiOnly: {
    documentId: 'gt-ui-designed-only.md',
    markdown: `# 保存资料

## 页面

入口为 /profile。
保存成功后保存按钮必须进入 disabled。`,
    factText: '保存成功后保存按钮必须进入 disabled。',
    dimension: 'UI',
    executionMode: 'DESIGNED_ONLY',
    reasonCode: 'UI_RUNTIME_BINDING_REQUIRED',
  },

  hybrid: {
    documentId: 'gt-hybrid.md',
    markdown: `# 创建订单

POST /orders
该接口无需认证
返回 201

用户点击创建按钮提交订单。
订单创建和库存扣减必须原子完成。
订单创建后页面必须刷新显示新订单。`,
    kind: 'HYBRID',
    executionMode: 'DESIGNED_ONLY',
    requiredChannels: ['API', 'UI'],
    requiredSemanticFragments: ['创建按钮', '库存扣减', '刷新显示'],
  },
} as const;
