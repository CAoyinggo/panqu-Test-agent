import { describe, expect, it } from 'vitest';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { applyTestCaseQualityGate } from '../../src/acceptance/test-case-quality-gate.js';
import {
  createConcurrentScenarioProcessor,
  runTestCaseV2WithScenarioRunner,
  type TestCaseScenarioExecution,
} from '../../src/acceptance/test-case-scenario-adapter.js';
import type { EvidenceEnvelope, ScenarioAssertion, ScenarioEvidenceKind } from '../../src/acceptance/scenario-contract.js';
import type { ScenarioProcessor } from '../../src/acceptance/scenario-runner.js';
import { scoreScenarioQuality } from '../../src/acceptance/scenario-quality.js';
import { buildScenarioExecutionReport } from '../../src/acceptance/scenario-report.js';

const references = [
  {
    id: 'A-USER-CRUD',
    requiredPassingAcIds: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
    markdown: `# 用户资源 CRUD
## Actors
| actorId | userId | role | tenantId | projectId | tokenRef |
| --- | --- | --- | --- | --- | --- |
| user-a | user-a | USER | tenant-a | project-a | token-user-a |
| user-b | user-b | USER | tenant-a | project-a | token-user-b |
| user-c | user-c | USER | tenant-b | project-b | token-user-c |
## Authentication
Bearer Token 认证。
## API
POST /users
GET /users/{id}
PUT /users/{id}
DELETE /users/{id}
## Acceptance Criteria
AC-1 user-a 通过 POST /users 创建自己拥有的 User userId=user-a，返回 HTTP 201。
AC-2 user-a 通过 GET /users/{id} 查询自己的 User userId=user-a，返回 HTTP 200。
AC-3 user-a 通过 PUT /users/{id} 修改自己的 User userId=user-a，返回 HTTP 200。
AC-4 user-a 通过 DELETE /users/{id} 删除自己的 User userId=user-a，返回 HTTP 204。
AC-5 user-b 通过 PUT /users/{id} 修改 user-a 的 User userId=user-a 必须拒绝并返回 HTTP 403，User 和写审计保持不变。
AC-6 tenant-b 的 user-c 通过 GET /users/{id} 访问 tenant-a 的 User userId=user-a 必须拒绝并返回 HTTP 403，数据不得泄漏。`,
  },
  {
    id: 'B-ORDER-PAYMENT',
    requiredPassingAcIds: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7'],
    markdown: `# 订单支付状态
## Actors
| actorId | userId | role | tenantId | projectId | tokenRef |
| --- | --- | --- | --- | --- | --- |
| buyer-a | buyer-a | BUYER | tenant-a | project-a | token-buyer-a |
## Authentication
Bearer Token 认证。
## API
POST /orders
POST /orders/{orderId}/pay
POST /orders/{orderId}/cancel
GET /orders/{orderId}
## Acceptance Criteria
AC-1 buyer-a 创建 Order orderId=order-a 返回 HTTP 201，Order 从 NEW 变为 PENDING。
AC-2 buyer-a 支付自己的 Order orderId=order-a 返回 HTTP 200，Order 从 PENDING 变为 PAID，扣费和库存各发生一次。
AC-3 buyer-a 重复支付 Order orderId=order-a 返回 HTTP 200 且幂等，Order 保持 PAID，不重复扣费、不重复扣减库存。
AC-4 buyer-a 并发支付 Order orderId=order-a，两个请求均返回 HTTP 200，只允许一次状态流转，最终状态为 PAID，扣费和库存只发生一次。
AC-5 buyer-a 取消未支付 Order orderId=order-b 返回 HTTP 200，Order 从 PENDING 变为 CANCELLED。
AC-6 buyer-a 取消已支付 Order orderId=order-a 返回 HTTP 409，Order、金额、库存、任务和消息均保持不变。
AC-7 buyer-a 支付 Order orderId=order-c 时外部依赖失败返回 HTTP 503，Order 恢复到 PENDING，不扣费、不扣减库存、不产生消息；重试成功后变为 PAID。`,
  },
  {
    id: 'C-MULTI-TENANT-ROLE',
    requiredPassingAcIds: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'],
    markdown: `# 多角色多租户资源
## Actors
| actorId | userId | role | tenantId | projectId | tokenRef |
| --- | --- | --- | --- | --- | --- |
| user-a | user-a | USER | tenant-a | project-a | token-a |
| admin-a | admin-a | ADMIN | tenant-a | project-a | token-admin-a |
| user-b | user-b | USER | tenant-b | project-b | token-b |
## Authentication
Bearer Token 认证。
## API
POST /resources
GET /resources
GET /resources/{resourceId}
PUT /resources/{resourceId}
DELETE /resources/{resourceId}
## Acceptance Criteria
AC-1 user-a 在 tenant-a/project-a 创建并拥有 Resource resourceId=resource-a，返回 HTTP 201。
AC-2 user-b 跨 Tenant/Project 读取 user-a 的 Resource resourceId=resource-a 必须拒绝，返回 HTTP 403。
AC-3 admin-a 按 ADMIN Role 读取 user-a 在 tenant-a/project-a 拥有的 Resource resourceId=resource-a，返回 HTTP 200。
AC-4 user-b 不是 Owner，修改 user-a 的 Resource resourceId=resource-a 必须拒绝，返回 HTTP 403，Resource 和关联资源保持不变。
AC-5 user-b 不是 Owner，删除 user-a 的 Resource resourceId=resource-a 必须拒绝，返回 HTTP 403，Resource 和关联资源保持不变。
AC-6 user-b 查询 tenant-b/project-b 列表时不得返回 user-a 在 tenant-a/project-a 拥有的 Resource resourceId=resource-a，返回 HTTP 200。`,
  },
] as const;

const ALL_EVIDENCE: readonly ScenarioEvidenceKind[] = [
  'REQUEST', 'RESPONSE', 'STATE_BEFORE', 'STATE_AFTER', 'DATABASE', 'RESOURCE', 'EVENT',
  'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD', 'LOG', 'SCREENSHOT', 'OTHER',
];

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cursor = target;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) cursor[part] = value;
    else cursor = (cursor[part] ??= {}) as Record<string, unknown>;
  }
}

function observedValue(assertion: ScenarioAssertion): unknown {
  if (assertion.expectedFrom !== undefined) return assertion.target === 'count' ? 0 : 'observed';
  if (assertion.operator === 'EXISTS') return 'observed';
  if (assertion.operator === 'NOT_EXISTS') return undefined;
  if (assertion.operator === 'NOT_CONTAINS') return [];
  if (assertion.operator === 'GREATER_THAN' && typeof assertion.expected === 'number') return assertion.expected + 1;
  if (assertion.operator === 'GREATER_THAN_OR_EQUAL') return assertion.expected;
  return assertion.expected;
}

/** Runtime fixture only supplies processors/observers; it never compiles or replaces a generated Case. */
function evidenceDrivenProcessor(): ScenarioProcessor {
  return {
    name: 'reference-runtime', supportsAbort: true, supportedEvidenceKinds: ALL_EVIDENCE,
    supports: () => true,
    supportsEvidence: () => true,
    execute: async (operation, context) => {
      const requirements = context.scenario.evidenceRequirements.filter((item) => item.operationId === operation.id);
      const evidence = requirements.map((requirement): EvidenceEnvelope => {
        const data: Record<string, unknown> = {};
        for (const assertionId of requirement.assertionIds) {
          const assertion = context.scenario.assertions.find((item) => item.id === assertionId);
          if (assertion) setPath(data, assertion.target, observedValue(assertion));
        }
        if (requirement.kind === 'REQUEST') Object.assign(data, { method: operation.method, path: operation.path });
        if (requirement.kind === 'RESPONSE' && data.status === undefined) data.status = 200;
        if ((requirement.kind === 'STATE_BEFORE' || requirement.kind === 'STATE_AFTER'
          || requirement.kind === 'DATABASE' || requirement.kind === 'RESOURCE') && data.state === undefined) data.state = 'baseline';
        if (['EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD'].includes(requirement.kind)
          && data.count === undefined) data.count = 0;
        return {
          id: requirement.id, requirementId: requirement.id, scenarioId: context.scenario.id,
          operationId: operation.id, acceptanceCriteriaIds: context.scenario.acceptanceCriteriaIds,
          kind: requirement.kind, channel: requirement.channel, source: 'reference-runtime',
          observedAt: new Date().toISOString(), data, verified: true,
        };
      });
      const output = evidence.reduce<Record<string, unknown>>((result, item) => (
        item.data && typeof item.data === 'object' && !Array.isArray(item.data)
          ? Object.assign(result, item.data) : result
      ), {});
      return { status: 'PASS', executed: true, output, evidence };
    },
  };
}

describe('P0 three end-to-end Reference Scenario Sets', () => {
  for (const reference of references) {
    it(`${reference.id}: Generator + Quality Gate 原始 Case 直接进入 Runtime/Runner`, async () => {
      const requirement = parseAcceptanceRequirement(reference.markdown, { documentId: `${reference.id}.md` });
      const design = buildAcceptanceTestDesign(requirement);
      const points = generateTestPoints(requirement, design);
      const generated = generateAcceptanceApiCases(requirement, points);
      const gate = applyTestCaseQualityGate({ requirement, objectives: design.objectives, testCases: generated });
      const delegate = evidenceDrivenProcessor();
      const concurrent = createConcurrentScenarioProcessor([delegate]);
      let cleanupCount = 0;
      const executions: TestCaseScenarioExecution[] = [];
      for (const testCase of gate.testCases) executions.push(await runTestCaseV2WithScenarioRunner(testCase, {
        processors: [concurrent, delegate], environmentAvailable: true, policyAllowed: true,
        availablePreflights: new Set([
          'runtime.statePreflight', 'user-a', 'user-b', 'user-c', 'buyer-a', 'admin-a',
          'resource-a', 'order-a', 'order-b', 'order-c',
        ]),
        availableDependencies: new Set(['runtime.caseCleanup']),
        cleanupHooks: new Map([['runtime.caseCleanup', async () => { cleanupCount++; }]]),
      }));

      const passed = executions.filter((item) => item.outcome.result.status === 'PASS');
      const unverified = executions.filter((item) => item.oracleVerdict === 'NOT_VERIFIED');
      const passedAcIds = new Set(passed.flatMap((item) => item.adapted.scenario.acceptanceCriteriaIds));
      const reports = passed.map((execution) => {
        const quality = scoreScenarioQuality(execution.adapted.scenario, execution.outcome.gate);
        return buildScenarioExecutionReport({
          scenario: execution.adapted.scenario, result: execution.outcome.result,
          gate: execution.outcome.gate, quality,
        });
      });
      const executable = executions.filter((item) => item.adapted.effectiveReadiness.status === 'EXECUTABLE');
      const executed = executions.filter((item) => item.outcome.result.executed);
      const verified = executed.filter((item) => item.oracleVerdict !== 'NOT_VERIFIED');
      const evidenceComplete = passed.filter((_, index) => reports[index]?.coverage.evidenceCoverage === 100);
      if (process.env.DEVTEST_REFERENCE_METRICS === '1') {
        process.stdout.write(`[reference-metrics] ${JSON.stringify({
          id: reference.id,
          generated: gate.testCases.length,
          executable: executable.length,
          executed: executed.length,
          verified: verified.length,
          evidenceComplete: evidenceComplete.length,
          blockedOrDesigned: executions.length - executable.length,
          oracleCompletenessOfExecuted: executed.length ? Math.round((verified.length / executed.length) * 100) : 0,
          evidenceCompletenessOfPassed: passed.length ? Math.round((evidenceComplete.length / passed.length) * 100) : 0,
          outcomeStatus: Object.fromEntries([...new Set(executions.map((item) => item.outcome.result.status))]
            .map((status) => [status, executions.filter((item) => item.outcome.result.status === status).length])),
          blockerCodes: [...new Set(executions.flatMap((item) => item.outcome.result.blockedReasons.map((reason) => reason.code)))],
        })}\n`);
      }

      expect(design.businessModel.requirementId).toBe(requirement.id);
      expect(design.businessModel.flows.length).toBeGreaterThan(0);
      expect(generated.length).toBeGreaterThan(0);
      expect(gate.assessments.length).toBe(gate.testCases.length);
      expect(executions.map((item) => item.adapted.testCase)).toEqual(gate.testCases);
      expect(executions.some((item) => item.outcome.result.status === 'FAIL'), JSON.stringify(
        executions.filter((item) => item.outcome.result.status === 'FAIL').map((item) => ({
          id: item.adapted.testCase.id,
          ac: item.adapted.scenario.acceptanceCriteriaIds,
          failedAssertions: item.outcome.result.failedAssertions,
          operations: item.outcome.result.operationResults.map((operation) => ({
            id: operation.operationId, status: operation.status,
          })),
          evidence: item.outcome.result.evidence.map((evidence) => ({
            id: evidence.id, operationId: evidence.operationId, kind: evidence.kind, data: evidence.data,
          })),
        })),
      )).toBe(false);
      expect(passed.length, JSON.stringify(executions.map((item) => ({
        id: item.adapted.testCase.id, status: item.outcome.result.status,
        readiness: item.adapted.effectiveReadiness, blocked: item.outcome.result.blockedReasons,
      })))).toBeGreaterThan(0);
      expect(reference.requiredPassingAcIds.filter((id) => !passedAcIds.has(id)), JSON.stringify(
        executions.filter((item) => item.adapted.scenario.acceptanceCriteriaIds.some((id) => !passedAcIds.has(id)))
          .map((item) => ({ id: item.adapted.testCase.id, ac: item.adapted.scenario.acceptanceCriteriaIds,
            status: item.outcome.result.status, blocked: item.outcome.result.blockedReasons })),
      )).toEqual([]);
      expect(unverified.every((item) => item.outcome.result.status === 'BLOCKED'
        || item.outcome.result.status === 'NOT_EXECUTED')).toBe(true);
      expect(unverified.every((item) => item.outcome.result.status !== 'PASS')).toBe(true);
      expect(passed.every((item) => item.adapted.effectiveReadiness.status === 'EXECUTABLE'
        && item.outcome.result.executed && item.outcome.result.processorInvoked
        && item.outcome.result.evidence.length > 0)).toBe(true);
      expect(verified.length).toBe(executed.length);
      expect(evidenceComplete.length).toBe(passed.length);
      expect(executable.length).toBe(executed.length);
      expect(cleanupCount).toBe(passed.filter((item) => item.adapted.testCase.cleanup?.length).length);
      expect(reports.every((report) => report.result.status === 'PASS'
        && report.coverage.assertionCoverage === 100 && report.coverage.evidenceCoverage === 100)).toBe(true);
    });
  }
});
