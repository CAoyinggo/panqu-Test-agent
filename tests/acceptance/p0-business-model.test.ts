import { describe, expect, it } from 'vitest';
import { buildBusinessModelProjection } from '../../src/acceptance/business-model.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { applyTestCaseQualityGate } from '../../src/acceptance/test-case-quality-gate.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';

const markdown = `# 多租户订单

## Actors
| actorId | userId | role | tenantId | projectId | tokenRef |
| --- | --- | --- | --- | --- | --- |
| user-a | user-a | BUYER | tenant-a | project-a | token-a |
| admin-a | admin-a | ADMIN | tenant-a | project-a | token-admin-a |
| user-b | user-b | BUYER | tenant-b | project-b | token-b |

## API
POST /orders
GET /orders/{orderId}
POST /orders/{orderId}/pay

## Acceptance Criteria
AC-1 user-a 创建订单 orderId=order-a 返回 HTTP 201。
AC-2 user-a 可以访问自己的订单 orderId=order-a，属于同一 tenant-a 和 project-a，返回 HTTP 200。
AC-3 user-b 不得访问 user-a 的订单 orderId=order-a，跨 tenant-b 和 project-b 返回 HTTP 403。
AC-4 订单从 PENDING 支付后变为 PAID。
AC-5 订单支付依赖库存资源，扣费只允许发生一次且必须产生审计记录。
AC-6 admin-a 可以查询 tenant-a 内订单，user-a 只能查询自己拥有的订单。
`;

describe('P0 Business Model Projection', () => {
  it('保留 Fact/Source/Confidence/Conflict，并表达单资源、角色和状态', () => {
    const requirement = parseAcceptanceRequirement(markdown, { documentId: 'p0-business.md' });
    const model = buildBusinessModelProjection(requirement);

    expect(model.schemaVersion).toBe('BUSINESS_MODEL_PROJECTION_V1');
    expect(model.actors.map((actor) => actor.id)).toEqual(expect.arrayContaining(['user-a', 'admin-a', 'user-b']));
    expect(model.roles.map((role) => role.name)).toEqual(expect.arrayContaining(['BUYER', 'ADMIN']));
    expect(model.resources.some((resource) => resource.type === 'ORDER')).toBe(true);
    expect(model.states.some((state) => state.from === 'PENDING' && state.to === 'PAID')).toBe(true);
    expect(model.flows.every((flow) => flow.factIds.length > 0 && flow.sources.length > 0
      && Number.isFinite(flow.confidence) && typeof flow.conflict === 'boolean')).toBe(true);
  });

  it('完整保留多角色、多租户、Project、Owner 与全部 Scope，不只取第一个 Scope', () => {
    const requirement = parseAcceptanceRequirement(markdown);
    const model = buildBusinessModelProjection(requirement);
    const cross = model.ownerships.find((ownership) => ownership.relation === 'CROSS_TENANT');

    expect(model.tenants.map((tenant) => tenant.id)).toEqual(['tenant-a', 'tenant-b']);
    expect(model.projects.map((project) => project.id)).toEqual(['project-a', 'project-b']);
    expect(cross).toBeDefined();
    expect(cross?.scopes.map((scope) => scope.dimension)).toEqual(expect.arrayContaining(['TENANT', 'PROJECT']));
    expect(model.ownerships.some((ownership) => ownership.ownerActorId === 'user-a')).toBe(true);
  });

  it('表达多资源、资源依赖、业务风险，并由 Business Model Flow 派生 Scenario', () => {
    const requirement = parseAcceptanceRequirement(`${markdown}\nAC-7 库存资源从 AVAILABLE 扣减后变为 RESERVED。`);
    const design = buildAcceptanceTestDesign(requirement);

    expect(design.businessModel.resources.map((resource) => resource.type)).toEqual(expect.arrayContaining(['ORDER', 'INVENTORY']));
    expect(design.businessModel.dependencies.some((dependency) => dependency.kind === 'RESOURCE')).toBe(true);
    expect(design.businessModel.risks.map((risk) => risk.category)).toEqual(expect.arrayContaining(['SECURITY', 'FINANCIAL', 'DATA_INTEGRITY']));
    expect(design.scenarios.length).toBeGreaterThan(0);
    expect(design.scenarios.every((scenario) => design.businessModel.flows.some((flow) =>
      flow.factIds.some((factId) => scenario.factIds.includes(factId))))).toBe(true);
  });

  it('Generator 保留完整 Scope/Project，Quality Gate 明确报告错误归属关系', () => {
    const requirement = parseAcceptanceRequirement(markdown);
    const design = buildAcceptanceTestDesign(requirement);
    const generated = generateAcceptanceApiCases(requirement, generateTestPoints(requirement, design));
    const scoped = generated.find((testCase) => (testCase.businessScenario?.scopes?.length ?? 0) > 1
      && (testCase.businessScenario?.ownerships?.length ?? 0) > 0)!;

    expect(scoped.businessScenario?.scopes?.map((scope) => scope.dimension))
      .toEqual(expect.arrayContaining(['TENANT', 'PROJECT']));
    expect(scoped.businessScenario?.ownerships?.some((ownership) => ownership.projectId)).toBe(true);
    expect(scoped.businessScenario?.ownership.projectId).toBeDefined();

    const broken = structuredClone(scoped);
    broken.businessScenario!.ownerships![0].resourceId = 'RES-NOT-IN-SCENARIO';
    const gate = applyTestCaseQualityGate({ requirement, objectives: design.objectives, testCases: [broken] });
    expect(gate.assessments[0].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BUSINESS_RELATIONSHIP_INVALID', disposition: 'BLOCKED' }),
    ]));
  });
});
