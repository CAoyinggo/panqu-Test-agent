import { describe, expect, it } from 'vitest';
import { REQUIREMENT_FACT_CATEGORIES, type RequirementFact } from '../../src/acceptance/requirement-ir.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';

function factByStatement(facts: RequirementFact[], statement: string): RequirementFact {
  const fact = facts.find((item) => item.statement === statement);
  if (!fact) throw new Error(`Fact not found: ${statement}`);
  return fact;
}

describe('Requirement Fact Ledger', () => {
  it('exports the complete canonical fact category vocabulary', () => {
    expect(REQUIREMENT_FACT_CATEGORIES).toEqual([
      'FUNCTIONAL', 'UI', 'API', 'VALIDATION', 'AUTH', 'PERMISSION', 'DATA_ISOLATION',
      'BUSINESS_RULE', 'STATE', 'ERROR', 'BOUNDARY', 'PERFORMANCE', 'SECURITY',
      'COMPATIBILITY', 'SIDE_EFFECT', 'CLEANUP', 'OTHER',
    ]);
  });

  it('never silently drops normative atomicity, uniqueness, ownership, UI, state or side-effect prose', () => {
    const requirement = parseAcceptanceRequirement(`# 订单创建
系统名称为订单中心。
本页面采用蓝色主题。
POST /orders
无需认证
返回 201
订单创建和库存扣减必须原子完成。
订单号必须唯一。
订单必须属于当前用户。
库存与订单保持一致。
点击保存后按钮必须进入 loading 状态，成功后显示提示并刷新列表。
已支付订单只能从 PAID 转为 SHIPPED。
创建成功后必须发送邮件通知。
AC-1 POST /orders 返回 201`, { documentId: 'facts.md' });

    const expectations: Array<[string, RequirementFact['category']]> = [
      ['订单创建和库存扣减必须原子完成。', 'BUSINESS_RULE'],
      ['订单号必须唯一。', 'BUSINESS_RULE'],
      ['订单必须属于当前用户。', 'DATA_ISOLATION'],
      ['库存与订单保持一致。', 'BUSINESS_RULE'],
      ['点击保存后按钮必须进入 loading 状态，成功后显示提示并刷新列表。', 'UI'],
      ['已支付订单只能从 PAID 转为 SHIPPED。', 'STATE'],
      ['创建成功后必须发送邮件通知。', 'SIDE_EFFECT'],
    ];
    for (const [statement, category] of expectations) {
      expect(factByStatement(requirement.factLedger, statement)).toMatchObject({
        category,
        epistemicType: 'FACT',
        provenance: 'EXPLICIT',
        normativity: 'NORMATIVE',
        status: 'UNVERIFIED',
        source: {
          documentId: 'facts.md',
          lineStart: expect.any(Number),
          lineEnd: expect.any(Number),
          text: statement,
        },
      });
    }

    expect(factByStatement(requirement.factLedger, '系统名称为订单中心。')).toMatchObject({
      normativity: 'NON_NORMATIVE', status: 'NON_NORMATIVE', category: 'OTHER',
    });
    expect(factByStatement(requirement.factLedger, '本页面采用蓝色主题。')).toMatchObject({
      normativity: 'NON_NORMATIVE', status: 'NON_NORMATIVE', category: 'UI',
    });
    // Prose 里的角色词不能生成可执行凭据、用户或租户配置。
    expect(requirement.actors).toEqual([]);
  });

  it('keeps epistemic type and provenance as independent, explicit dimensions', () => {
    const requirement = parseAcceptanceRequirement(`# Order
## API
POST /orders/{id}
| name | type | location | required |
| --- | --- | --- | --- |
| amount | number | body | yes |
## Response
返回 201
## Actors
| Actor ID | Role | Token Ref |
| --- | --- | --- |
| checkout-user | USER | checkout-user |
## Requirement
订单必须创建成功。
因此可以推断订单必须保留 requestId。
假设未来可能支持批量订单。
建议最好增加深色主题。
AC-1 POST /orders/{id} 返回 201`);

    expect(factByStatement(requirement.factLedger, '订单必须创建成功。')).toMatchObject({
      epistemicType: 'FACT', provenance: 'EXPLICIT', normativity: 'NORMATIVE', status: 'UNVERIFIED',
    });
    expect(factByStatement(requirement.factLedger, '因此可以推断订单必须保留 requestId。')).toMatchObject({
      epistemicType: 'INFERENCE', provenance: 'EXPLICIT', normativity: 'NORMATIVE', status: 'UNVERIFIED',
    });
    expect(factByStatement(requirement.factLedger, '假设未来可能支持批量订单。')).toMatchObject({
      epistemicType: 'HYPOTHESIS', normativity: 'NON_NORMATIVE', status: 'NON_NORMATIVE',
    });
    expect(factByStatement(requirement.factLedger, '建议最好增加深色主题。')).toMatchObject({
      epistemicType: 'OPINION', normativity: 'NON_NORMATIVE', status: 'NON_NORMATIVE',
    });

    const apiFact = requirement.factLedger.find((fact) => fact.entityRefs.items.some((ref) => ref.type === 'API'));
    expect(apiFact).toMatchObject({ provenance: 'CONTRACT', epistemicType: 'FACT' });
    const configuredActor = requirement.factLedger.find((fact) => fact.entityRefs.items.some((ref) => ref.type === 'ACTOR'));
    expect(configuredActor).toMatchObject({ provenance: 'CONFIGURED', epistemicType: 'FACT' });
    const inferredPathParameter = requirement.factLedger.find((fact) =>
      fact.entityRefs.items.some((ref) => ref.type === 'PARAMETER' && ref.field === 'id'));
    expect(inferredPathParameter).toMatchObject({ provenance: 'INFERRED', epistemicType: 'INFERENCE' });
    expect(inferredPathParameter?.entityRefs).toMatchObject({
      apiSpecIds: [requirement.apis[0].id], parameterNames: ['id'],
    });
  });

  it('keeps test setup, credentials and evidence tables as non-normative context', () => {
    const requirement = parseAcceptanceRequirement(`# 创建订单
## API
POST /orders
## Authentication
- Type: TOKEN
- Reference: ACTOR_TOKEN_REF
## Preconditions
| ID | Condition | Evidence Channel |
| --- | --- | --- |
| PRE-001 | 创建隔离用户 | RESOURCE |
## Test Data
| ID | Owner | Value |
| --- | --- | --- |
| DATA-001 | test-user | order-a |
## Assertions
| ID | Target | Expected |
| --- | --- | --- |
| AS-001 | status | 201 |
## Evidence
| ID | Kind | Description |
| --- | --- | --- |
| EV-001 | RESPONSE | 创建响应 |
## Cleanup
| Handler | Required | Description |
| --- | --- | --- |
| cleanup-order | true | 删除测试订单 |
## Acceptance Criteria
AC-1 POST /orders 返回 201。`);

    for (const fragment of ['Type: TOKEN', 'PRE-001', 'DATA-001', 'AS-001', 'EV-001', 'cleanup-order']) {
      expect(requirement.factLedger.find((fact) => fact.statement.includes(fragment))).toMatchObject({
        normativity: 'NON_NORMATIVE',
        status: 'NON_NORMATIVE',
      });
    }
    expect(requirement.factLedger.find((fact) => fact.statement.includes('POST /orders 返回 201'))).toMatchObject({
      normativity: 'NORMATIVE',
    });
  });

  it('links every structured contract/rule projection with de-duplicated entityRefs', () => {
    const requirement = parseAcceptanceRequirement(`# 用户资料修改
## 页面
入口为 /profile。
## API
| Method | Path |
| --- | --- |
| PUT | /api/users/{id} |
### Body 参数
| name | type | location | required | range |
| --- | --- | --- | --- | --- |
| nickname | string | body | yes | 2~20 |
### Response
| status | description |
| --- | --- |
| 200 | success |
| 403 | forbidden |
## Actors
| Actor ID | Role | Token Ref |
| --- | --- | --- |
| profile-user | USER | profile-user |
## 权限
普通用户只能修改自己的资料。
## 数据隔离
跨租户用户禁止访问其他用户数据。
## 业务规则
资料修改必须保持唯一昵称。
## 状态
资料状态必须从 DRAFT 转为 SAVED。
## Acceptance Criteria
AC-1 PUT /api/users/{id} 返回 200`, { documentId: 'structured.md' });

    const refTypes = new Set(requirement.factLedger.flatMap((fact) => fact.entityRefs.items.map((ref) => ref.type)));
    expect(refTypes).toEqual(new Set([
      'ACTOR', 'PAGE', 'API', 'PARAMETER', 'RESPONSE', 'ACCEPTANCE_CRITERION',
      'PERMISSION', 'ISOLATION_RULE', 'BUSINESS_RULE', 'STATE_RULE',
    ]));

    for (const fact of requirement.factLedger) {
      const refKeys = fact.entityRefs.items.map((ref) => `${ref.type}:${ref.id}:${ref.field ?? ''}`);
      expect(new Set(refKeys).size).toBe(refKeys.length);
    }
    expect(requirement.factLedger.filter((fact) => fact.normativity === 'NORMATIVE').every((fact) =>
      fact.status === 'UNVERIFIED' || fact.status === 'BLOCKED')).toBe(true);
    expect(requirement.factLedger.every((fact) => fact.source.lineStart <= fact.source.lineEnd && Boolean(fact.source.text))).toBe(true);
  });

  it('marks only conflicting source facts BLOCKED; other parser-stage facts remain UNVERIFIED', () => {
    const conflict = parseAcceptanceRequirement(`# Conflict
GET /orders
无需认证
返回 200、404
AC-1 GET /orders 返回 200
AC-1 GET /orders 返回 404`);
    const conflictingFact = conflict.factLedger.find((fact) => fact.source.text.includes('AC-1 GET /orders 返回 404'));
    expect(conflictingFact).toMatchObject({ normativity: 'NORMATIVE', status: 'BLOCKED' });
    expect(conflictingFact?.statusReason).toContain('AC-1 存在冲突定义');
    expect(conflict.factLedger.filter((fact) => fact.normativity === 'NORMATIVE' && fact !== conflictingFact)
      .every((fact) => fact.status === 'UNVERIFIED')).toBe(true);

    const sideEffect = parseAcceptanceRequirement(`# Notify
POST /orders
无需认证
返回 201
创建订单后必须发送邮件通知。
AC-1 POST /orders 返回 201`);
    expect(sideEffect.warnings).toContainEqual(expect.objectContaining({ code: 'UNVERIFIED_REQUIREMENT_FACT', blocking: true }));
    expect(factByStatement(sideEffect.factLedger, '创建订单后必须发送邮件通知。')).toMatchObject({
      status: 'UNVERIFIED', category: 'SIDE_EFFECT',
    });
  });

  it('does not turn state modality into a fabricated permission or actor', () => {
    const requirement = parseAcceptanceRequirement(`# State
POST /orders/{id}/ship
无需认证
返回 200
订单只能从 PAID 转为 SHIPPED。
AC-1 POST /orders/{id}/ship 返回 200`);
    expect(requirement.stateRules).toHaveLength(1);
    expect(requirement.permissions).toEqual([]);
    expect(requirement.actors).toEqual([]);
    expect(factByStatement(requirement.factLedger, '订单只能从 PAID 转为 SHIPPED。')).toMatchObject({
      category: 'STATE', status: 'UNVERIFIED',
      entityRefs: { items: [expect.objectContaining({ type: 'STATE_RULE' })] },
    });
  });

  it('normalizes an explicit state transition into a deterministic expected state', () => {
    const requirement = parseAcceptanceRequirement(`# 异步任务
任务状态从 STEP-002 的 QUEUED 转换到 STEP-003 的 COMPLETED。
AC-1 任务状态从 STEP-002 的 QUEUED 转换到 STEP-003 的 COMPLETED。`);
    const fact = factByStatement(requirement.factLedger, '任务状态从 STEP-002 的 QUEUED 转换到 STEP-003 的 COMPLETED。');
    expect(fact.canonical).toMatchObject({
      resource: { kind: 'TASK' },
      action: { kind: 'TRANSITION' },
      expected: { kind: 'STATE_CHANGED', value: { from: 'QUEUED', to: 'COMPLETED' }, explicit: true },
      normalizationStatus: 'COMPLETE',
      unresolved: [],
    });
  });
});
