import { describe, expect, it } from 'vitest';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { applyTestCaseQualityGate } from '../../src/acceptance/test-case-quality-gate.js';
import { reviewTestDesign, type TestStrategyArea } from '../../src/acceptance/test-design-intelligence.js';
import { generateCanonicalAgentTestDesign } from '../../src/agents/test-design/canonical-generator.js';

const crudRequirement = `# User Resource CRUD
## Actors
| actorId | userId | role | tenantId | projectId | tokenRef |
| --- | --- | --- | --- | --- | --- |
| user-a | user-a | USER | tenant-a | project-a | user-a-ref |
| user-b | user-b | USER | tenant-a | project-a | user-b-ref |
## API
POST /resources
GET /resources/{resourceId}
PUT /resources/{resourceId}
DELETE /resources/{resourceId}
## Acceptance Criteria
AC-1 user-a 创建自己拥有的 Resource resourceId=resource-a 返回 HTTP 201。
AC-2 user-a 查询自己的 Resource resourceId=resource-a 返回 HTTP 200。
AC-3 user-a 修改自己的 Resource resourceId=resource-a 返回 HTTP 200。
AC-4 user-a 删除自己的 Resource resourceId=resource-a 返回 HTTP 204，之后查询返回 HTTP 404。
AC-5 user-b 不得修改 user-a 的 Resource resourceId=resource-a，返回 HTTP 403，Resource 和关联副作用保持不变。`;

const paymentRequirement = `# Order Payment State
## Actors
| actorId | userId | role | tenantId | projectId | tokenRef |
| --- | --- | --- | --- | --- | --- |
| buyer-a | buyer-a | BUYER | tenant-a | project-a | buyer-a-ref |
## API
POST /orders
POST /orders/{orderId}/pay
GET /orders/{orderId}
## Acceptance Criteria
AC-1 buyer-a 创建 Order orderId=order-a 返回 HTTP 201，状态从 NEW 变为 PENDING。
AC-2 buyer-a 支付自己的 Order orderId=order-a 返回 HTTP 200，状态从 PENDING 变为 PAID，并扣减一次金额和库存、产生一条账务与消息记录。
AC-3 重复支付必须幂等，不重复扣减金额和库存，不重复产生账务或消息。
AC-4 并发支付只能形成一次有效状态流转，最终状态为 PAID，金额和库存只扣减一次。
AC-5 已取消 Order 从 CANCELLED 发起支付返回 HTTP 409，Order、金额、库存、账务和消息均保持不变。
AC-6 支付外部依赖失败时返回 HTTP 503，恢复到 PENDING，不扣减金额和库存，不产生账务与消息；重试成功后变为 PAID。`;

const tenantRequirement = `# Multi Role Multi Tenant Resource
## Actors
| actorId | userId | role | tenantId | projectId | tokenRef |
| --- | --- | --- | --- | --- | --- |
| user-a | user-a | USER | tenant-a | project-a | user-a-ref |
| admin-a | admin-a | ADMIN | tenant-a | project-a | admin-a-ref |
| user-b | user-b | USER | tenant-b | project-b | user-b-ref |
## API
POST /resources
GET /resources/{resourceId}
PUT /resources/{resourceId}
DELETE /resources/{resourceId}
## Acceptance Criteria
AC-1 user-a 在 tenant-a/project-a 创建并拥有 Resource resourceId=resource-a，返回 HTTP 201。
AC-2 admin-a 可按 ADMIN Role 读取 tenant-a/project-a 的 Resource resourceId=resource-a，返回 HTTP 200。
AC-3 user-b 跨 Tenant 和 Project 访问 user-a 的 Resource resourceId=resource-a 必须拒绝，返回 HTTP 403。
AC-4 user-b 跨 Tenant 修改被拒绝后，Resource、Owner 和关联资源均保持不变。`;

function generate(markdown: string) {
  const requirement = parseAcceptanceRequirement(markdown);
  const design = buildAcceptanceTestDesign(requirement);
  const points = generateTestPoints(requirement, design);
  const quality = applyTestCaseQualityGate({
    requirement,
    objectives: design.objectives,
    testCases: generateAcceptanceApiCases(requirement, points),
  });
  const review = reviewTestDesign({
    requirement,
    businessModel: design.businessModel,
    strategy: design.testStrategy,
    scenarioCandidates: design.scenarioCandidates,
    testCases: quality.testCases,
  });
  return { requirement, design, points, quality, review };
}

function requiredAreas(markdown: string): Set<TestStrategyArea> {
  return new Set(generate(markdown).design.testStrategy.decisions
    .filter((decision) => decision.applicability === 'REQUIRED')
    .map((decision) => decision.area));
}

describe('P0 Test Design Intelligence', () => {
  it('先形成 Who/Resource/State/Action/Rule/Result/Side Effect 业务理解，再设计 CRUD Case', () => {
    const { design, quality } = generate(crudRequirement);
    const ownedWrite = design.businessUnderstanding.answers.find((answer) =>
      answer.actor === 'user-a' && answer.resource === 'RESOURCE' && answer.action === 'CREATE');

    expect(ownedWrite).toMatchObject({ role: 'USER', tenant: 'tenant-a', project: 'project-a', status: 'KNOWN' });
    expect(design.businessUnderstanding.dataRelationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'OWNERSHIP' }),
      expect.objectContaining({ kind: 'SCOPE' }),
    ]));
    expect(design.scenarioCandidates.some((scenario) => scenario.goal.includes('user-a')
      && scenario.goal.includes('RESOURCE') && !/^(?:GET|POST|PUT|DELETE)\b/.test(scenario.goal))).toBe(true);
    expect(design.testStrategy.decisions.find((item) => item.area === 'CONCURRENCY_RISK')?.applicability)
      .toBe('NOT_APPLICABLE');
    expect(quality.testCases.every((testCase) => testCase.schemaVersion === 'TEST_CASE_V2'
      && typeof testCase.metadata?.riskJustification === 'string')).toBe(true);
  });

  it('为订单支付建立 State Graph，并只由显式风险选择幂等、并发、恢复和副作用场景', () => {
    const { design, quality, review } = generate(paymentRequirement);
    const areas = new Set(design.testStrategy.decisions
      .filter((decision) => decision.applicability === 'REQUIRED').map((decision) => decision.area));
    const scenarioKinds = new Set(design.scenarioCandidates.map((scenario) => scenario.kind));

    expect(design.businessUnderstanding.stateGraph.nodes).toEqual(expect.arrayContaining(['NEW', 'PENDING', 'PAID']));
    expect([...areas]).toEqual(expect.arrayContaining([
      'CORE_BUSINESS_FLOW', 'STATE_RISK', 'IDEMPOTENCY_RISK', 'CONCURRENCY_RISK',
      'SIDE_EFFECT_RISK', 'RECOVERY_RISK',
    ]));
    expect([...scenarioKinds]).toEqual(expect.arrayContaining([
      'STATE_CONFLICT', 'DUPLICATE_OPERATION', 'CONCURRENT_OPERATION', 'FAILURE_RECOVERY', 'SIDE_EFFECT',
    ]));
    expect(quality.testCases.some((testCase) => testCase.testAspects?.includes('IDEMPOTENCY'))).toBe(true);
    expect(quality.testCases.some((testCase) => testCase.testAspects?.includes('CONCURRENCY'))).toBe(true);
    expect(quality.testCases.some((testCase) => testCase.testAspects?.includes('ROLLBACK_RECOVERY'))).toBe(true);
    expect(review.stateCoverage.missingIds).toEqual([]);
    expect(review.negativeCoverage.missingIds).toEqual([]);
    expect(review.sideEffectCoverage.missingIds).toEqual([]);
  });

  it('按 Actor × Role × Resource × Operation × Ownership × Tenant 推理权限和隔离', () => {
    const { design, quality, review } = generate(tenantRequirement);
    const areas = requiredAreas(tenantRequirement);
    const crossScope = design.scenarioCandidates.filter((scenario) => scenario.kind === 'CROSS_SCOPE_ACCESS');

    expect([...areas]).toEqual(expect.arrayContaining(['PERMISSION_RISK', 'DATA_ISOLATION_RISK']));
    expect(design.businessModel.roles.map((role) => role.name)).toEqual(expect.arrayContaining(['USER', 'ADMIN']));
    expect(design.businessModel.tenants.map((tenant) => tenant.id)).toEqual(expect.arrayContaining(['tenant-a', 'tenant-b']));
    expect(design.businessModel.projects.map((project) => project.id)).toEqual(expect.arrayContaining(['project-a', 'project-b']));
    expect(design.businessUnderstanding.dataRelationships.some((relation) =>
      relation.kind === 'SCOPE' && /TENANT|PROJECT/.test(relation.relation))).toBe(true);
    expect(crossScope.length).toBeGreaterThan(0);
    expect(quality.testCases.some((testCase) => testCase.testAspects?.includes('TENANT_ISOLATION'))).toBe(true);
    expect(review.permissionCoverage.missingIds).toEqual([]);
    expect(review.isolationCoverage.missingIds).toEqual([]);
  });

  it('Test Design Review 检查覆盖、Oracle/Evidence、UNKNOWN 与语义/业务重复', () => {
    const completeness: Array<{ oracle: number; evidence: number }> = [];
    for (const markdown of [crudRequirement, paymentRequirement, tenantRequirement]) {
      const { quality, review } = generate(markdown);
      expect(review.missingHighValueScenarioIds).toEqual([]);
      expect(review.semanticDuplicateCaseIds).toEqual([]);
      expect(review.businessDuplicateCaseIds).toEqual([]);
      expect(review.unknownHandling.violations).toEqual([]);
      expect(review.oracleCompleteness).toBeGreaterThanOrEqual(0);
      expect(review.evidenceCompleteness).toBeGreaterThanOrEqual(0);
      completeness.push({ oracle: review.oracleCompleteness, evidence: review.evidenceCompleteness });
      expect(quality.assessments.every((assessment) => assessment.dimensions.riskJustified)).toBe(true);
    }
    expect(completeness.some((item) => item.oracle > 0)).toBe(true);
    expect(completeness.some((item) => item.evidence > 0)).toBe(true);

    const unknown = generate('# 查询订单\n\n查询订单。');
    expect(unknown.design.businessUnderstanding.unknowns.length).toBeGreaterThan(0);
    expect(unknown.design.scenarioCandidates.every((scenario) => scenario.status === 'NEED_CONFIRMATION')).toBe(true);
    expect(unknown.quality.testCases.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY'
      && testCase.oracle?.status !== 'READY')).toBe(true);
    expect(unknown.review.unknownHandling.violations).toEqual([]);
  });

  it('风险优先级与测试维度动态选择，不以 Case 数量或机械全维度覆盖为目标', () => {
    const crud = generate(crudRequirement).design;
    const payment = generate(paymentRequirement).design;
    const tenant = generate(tenantRequirement).design;
    const selections = [crud, payment, tenant].map((design) => design.testStrategy.selectedDimensions.slice().sort().join('|'));

    expect(new Set(selections).size).toBe(3);
    expect(payment.objectives.filter((objective) => ['FUNCTIONAL', 'API', 'STATE'].includes(objective.dimension))
      .every((objective) => objective.priority === 'P0')).toBe(true);
    expect(payment.objectives.filter((objective) => objective.strategies.some((strategy) =>
      ['REPEAT', 'CONCURRENT_REQUEST', 'RECOVERY_CHECK'].includes(strategy)))
      .every((objective) => objective.priority === 'P1')).toBe(true);
    expect(crud.objectives.filter((objective) => ['PARAMETER_VALIDATION', 'BOUNDARY'].includes(objective.dimension))
      .every((objective) => objective.priority === 'P2')).toBe(true);
  });

  it('TestDesignAgent 确定性回退复用 canonical 主链，不再生成旧 submit/result-exists Case', () => {
    const generated = [
      ['Resource CRUD', crudRequirement],
      ['Order State', paymentRequirement],
      ['Multi Tenant', tenantRequirement],
    ].map(([feature, source]) => generateCanonicalAgentTestDesign({
      feature, source, goal: `验证 ${feature} 需求`, capabilities: [], inputs: [], requirements: [],
      businessRules: [], dependencies: [], constraints: [], risks: [],
    }));

    expect(new Set(generated.map((item) => item.design.testStrategy.selectedDimensions.slice().sort().join('|'))).size).toBe(3);
    for (const item of generated) {
      expect(item.cases.length).toBeGreaterThan(0);
      expect(item.cases.every((testCase) => testCase.schemaVersion === 'TEST_CASE_V2')).toBe(true);
      expect(item.cases.every((testCase) => testCase.metadata?.canonicalGenerator === 'acceptance')).toBe(true);
      expect(item.cases.every((testCase) => Boolean(testCase.businessScenario
        && testCase.metadata?.riskJustification && testCase.source?.factIds?.length))).toBe(true);
      expect(item.review.semanticDuplicateCaseIds).toEqual([]);
      expect(item.review.businessDuplicateCaseIds).toEqual([]);
      expect(item.review.unknownHandling.violations).toEqual([]);
    }
  });
});
