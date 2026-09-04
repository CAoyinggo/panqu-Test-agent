import fs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import type { AcceptanceCaseExecutionResult } from '../../src/acceptance/api-processor.js';
import { buildAcceptanceDefects } from '../../src/acceptance/api-processor.js';
import {
  buildAcceptanceReport,
  renderAcceptanceReportHtml,
  renderAcceptanceReportJson,
  renderAcceptanceReportMarkdown,
  writeAcceptanceReports,
} from '../../src/acceptance/acceptance-report.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints, type TestPoint } from '../../src/acceptance/test-point.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';

const fixture = fs.readFileSync(fileURLToPath(new URL('./fixtures/user-profile.md', import.meta.url)), 'utf8');

function testCase(index: number, type: NonNullable<TestCase['testType']>, point?: TestPoint): TestCase {
  const factIds = point?.factIds ?? [];
  const objectiveIds = point?.objectiveId ? [point.objectiveId] : [];
  return {
    id: `CASE-${index}`,
    feature: '用户资料修改',
    name: `case ${index}`,
    priority: 'P0',
    testType: type,
    executionMode: 'EXECUTABLE',
    protocol: 'HTTP',
    source: {
      requirementId: point?.requirementId ?? 'REQ',
      testPointId: point?.id ?? `TP-00${index}`,
      acceptanceCriteriaIds: point?.acceptanceCriteriaIds ?? [`AC-${index}`],
      factIds,
      objectiveIds,
      scenarioId: point?.scenarioId,
    },
    tags: [],
    steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/echo' }],
    assertions: [{ type: 'STATUS_CODE', expected: 200, factIds, objectiveIds }],
  };
}

function result(test: TestCase, status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED'): AcceptanceCaseExecutionResult {
  const executed = status === 'PASS' || status === 'FAIL';
  return {
    classification: status === 'PASS' ? 'SUCCESS' : status === 'FAIL' ? 'PRODUCT_FAILURE' : status === 'BLOCKED' ? 'EXECUTION_BLOCKED' : 'NOT_EXECUTED',
    attribution: {
      classification: status === 'PASS' ? 'SUCCESS' : status === 'FAIL' ? 'PRODUCT_FAILURE' : status === 'BLOCKED' ? 'EXECUTION_BLOCKED' : 'NOT_EXECUTED',
      confidence: status === 'FAIL' ? 'MEDIUM' : 'HIGH',
      reason: 'test fixture',
      evidenceSources: ['TEST_FIXTURE'],
    },
    caseId: test.id,
    name: test.name,
    feature: test.feature,
    scene: 'api',
    priority: test.priority,
    tags: [],
    pass: status === 'PASS',
    passRate: status === 'PASS' ? 100 : 0,
    executed,
    processor: executed ? 'api' : undefined,
    processorInvoked: executed,
    assertions: executed ? 1 : 0,
    passedAssertions: status === 'PASS' ? 1 : 0,
    failedAssertions: status === 'FAIL' ? 1 : 0,
    blockedReason: status === 'BLOCKED' ? { code: 'TEST_BLOCKED', stage: 'GATE' } : null,
    status,
    error: status === 'BLOCKED' ? '环境不可用' : status === 'NOT_EXECUTED' ? 'Processor 不存在' : undefined,
    evidence: {
      requirementId: test.source?.requirementId,
      acceptanceCriteriaIds: test.source?.acceptanceCriteriaIds ?? [],
      factIds: test.source?.factIds,
      objectiveIds: test.source?.objectiveIds,
      scenarioId: test.source?.scenarioId,
      testPointId: test.source?.testPointId,
      request: executed ? { method: 'GET', url: 'http://127.0.0.1/echo', headers: { Authorization: 'Bearer secret' }, pathParams: {}, query: {} } : undefined,
      response: executed ? { status: 200, headers: {}, body: { ok: status === 'PASS' } } : undefined,
      assertions: executed ? [{
        type: 'STATUS_CODE',
        expected: 200,
        actual: status === 'PASS' ? 200 : 500,
        pass: status === 'PASS',
        detail: 'status',
        factIds: test.source?.factIds,
        objectiveIds: test.source?.objectiveIds,
      }] : [],
      binding: executed ? { valid: true, apiSpecId: 'API-REPORT', operationKey: 'GET /echo' } : undefined,
      evidenceItems: [],
    },
  };
}

describe('AcceptanceReport', () => {
  it('separates coverage, type statistics, defect, risk, not-tested and conclusion', () => {
    const requirement = parseAcceptanceRequirement(fixture, { documentId: 'profile.md' });
    const design = buildAcceptanceTestDesign(requirement);
    const points = generateTestPoints(requirement, design);
    const cases = [
      testCase(1, 'FUNCTIONAL', points[0]), testCase(2, 'PARAMETER', points[1]),
      testCase(3, 'PERMISSION', points[2]), testCase(4, 'DATA_ISOLATION', points[3]),
    ];
    const results = [result(cases[0], 'PASS'), result(cases[1], 'FAIL'), result(cases[2], 'BLOCKED'), result(cases[3], 'NOT_EXECUTED')];
    const defects = buildAcceptanceDefects(results);
    const report = buildAcceptanceReport({
      project: 'test-flow', requirement,
      objectives: design.objectives, dimensionDecisions: design.dimensionDecisions, scenarios: design.scenarios,
      testPoints: points, testCases: cases, results, defects,
    });

    expect(report.summary).toEqual({
      total: 4, designed: 4, executable: 4, designedOnly: 0, executed: 2,
      passed: 1, failed: 1, blocked: 1, notExecuted: 1, timedOut: 0, cancelled: 0, unverified: 0,
    });
    expect(report.coverage).toMatchObject({
      factCoverage: 96.6,
      factVerificationCoverage: 100,
      objectiveCoverage: expect.any(Number),
      caseCoverage: 100,
      executionCoverage: 50,
      evidenceCoverage: 50,
      operationContractEvidenceCoverage: 50,
    });
    expect(report.byType).toMatchObject({ functional: 1, parameter: 1, permission: 1, dataIsolation: 1 });
    expect(report.summary.unverified).toBe(report.coverage.unverifiedFacts.length);
    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]).toMatchObject({
      affectedFactIds: expect.any(Array),
      affectedObjectiveIds: expect.any(Array),
      affectedCaseIds: [cases[1].id],
    });
    expect(report.regression).toMatchObject({
      available: true,
      plan: {
        strategy: 'FACT_BASED_REGRESSION_V1',
        seedCaseIds: [cases[1].id],
        affectedCaseIds: expect.arrayContaining([cases[1].id]),
      },
    });
    expect(report.cases[0]).toMatchObject({
      caseId: cases[0].id,
      testType: 'FUNCTIONAL',
      priority: 'P0',
      scenario: expect.any(String),
      preconditions: [],
      sourceFactIds: expect.any(Array),
      sourceObjectiveIds: expect.any(Array),
      executionStatus: 'PASS',
      evidence: { request: expect.any(Object), response: expect.any(Object), assertions: expect.any(Array) },
    });
    expect(report.risks).toHaveLength(1);
    expect(report.notTested).toHaveLength(1);
    expect(report.conclusion).toBe('FAIL');
    expect(report.executions[0].evidence.request?.headers.Authorization).toBe('***');
  });

  it('renders JSON, Markdown and HTML from the same deterministic report', () => {
    const requirement = parseAcceptanceRequirement(fixture);
    const points = generateTestPoints(requirement);
    const cases = [testCase(1, 'API')];
    const results = [result(cases[0], 'PASS')];
    const report = buildAcceptanceReport({ project: 'test-flow', requirement, testPoints: points, testCases: cases, results, defects: [] });
    const json = JSON.parse(renderAcceptanceReportJson(report));
    const markdown = renderAcceptanceReportMarkdown(report);
    expect(json.summary.passed).toBe(1);
    expect(json.validationStage).toBe('INITIAL_VALIDATION');
    expect(json.conclusion).toBe(report.conclusion);
    expect(json.operationContractConclusion).toBe(report.operationContractConclusion);
    expect(markdown.match(/^## \d+\..+$/gm)).toEqual([
      '## 1. 测试结论',
      '## 2. 测试摘要',
      '## 3. 需求理解',
      '## 4. 测试范围',
      '## 5. 测试统计',
      '## 6. 核心问题',
      '## 7. 缺陷详情',
      '## 8. 未验证项',
      '## 9. 测试覆盖',
      '## 10. 建议开发修复顺序',
      '## 11. 回归建议',
    ]);
    expect(markdown.indexOf('发现核心问题')).toBeLessThan(markdown.indexOf('## 3. 需求理解'));
    expect(markdown).toContain('### 统一测试用例');
    expect(markdown).toContain('- Expected Result：');
    expect(markdown).toContain('- Source Facts：');
    expect(markdown).toContain('- Execution Status：PASS');
    expect(markdown).toContain('| 类型 | Designed | Executable | Designed Only | PASS | FAIL | BLOCKED | NOT_EXECUTED | TIMEOUT | CANCELLED |');
    expect(renderAcceptanceReportHtml(report)).toContain('<!doctype html>');
  });

  it('projects the complete TEST_CASE_V2 template into JSON and Markdown case details', () => {
    const requirement = parseAcceptanceRequirement(fixture);
    const design = buildAcceptanceTestDesign(requirement);
    const points = generateTestPoints(requirement, design);
    const base = testCase(1, 'API', points[0]);
    const factIds = base.source?.factIds ?? [];
    const acceptanceCriteriaIds = base.source?.acceptanceCriteriaIds ?? [];
    const candidate: TestCase = {
      ...base,
      schemaVersion: 'TEST_CASE_V2',
      testAspects: ['API_CONTRACT', 'CORE_FUNCTION', 'PRE_POST_CONDITION'],
      requirementStatus: 'CONFIRMED',
      businessScenario: {
        title: '用户读取资料', goal: '用户读取自己的资料并获得成功响应', actor: 'USER',
        action: 'READ', resource: 'PROFILE', expectedBusinessOutcome: '返回用户资料',
        kind: 'CORE_FLOW',
        actors: [{ id: 'user-1', role: 'USER', relation: 'SUBJECT', provenance: 'CONFIGURED' }],
        resourceContext: { type: 'PROFILE', idRef: 'profile-1', provenance: 'EXPLICIT' },
        ownership: { relation: 'SELF', ownerActorId: 'user-1', provenance: 'EXPLICIT' },
        state: { status: 'NOT_APPLICABLE', provenance: 'EXPLICIT' },
        permission: { decision: 'ALLOW', role: 'USER', action: 'READ', provenance: 'EXPLICIT' },
        flow: {
          id: 'FLOW-001', name: '用户读取资料', mode: 'SINGLE_OPERATION',
          steps: [{ id: 'STEP-001', action: 'READ', resourceRef: 'profile-1', dependsOn: [] }],
        },
        dependencies: [], risks: [],
        provenance: 'EXPLICIT', factIds, acceptanceCriteriaIds,
      },
      preconditions: ['目标 API 可访问'],
      preconditionPlan: [{
        id: 'PRE-001', kind: 'ENVIRONMENT', description: '目标 API 可访问', required: true,
        checkRef: 'runtime.preflight.api', evidenceRequirementId: 'EV-REQ-001',
      }],
      data: { targetId: 'profile-1' },
      testData: [{
        id: 'DATA-001', source: 'FIXTURE', valueRef: 'fixture.profile-1', resourceType: 'PROFILE',
        resourceOwnerId: 'user-1', mutable: false, sensitive: false,
      }],
      steps: [{
        id: 'STEP-001', channel: 'API', description: 'GET /echo', execution: 'EXECUTABLE',
        dependsOn: [], acceptanceCriteriaIds, factIds, type: 'HTTP_REQUEST', method: 'GET', url: '/echo',
      }],
      assertions: [{
        id: 'AS-001', channel: 'RESPONSE', acceptanceCriteriaIds,
        evidenceRequirementIds: ['EV-RES-001'], type: 'STATUS_CODE', expected: 200,
        factIds, objectiveIds: base.source?.objectiveIds,
      }],
      expected: {
        status: '200', description: '返回用户资料', response: { status: 200, description: '成功响应' },
        state: { expectation: 'UNCHANGED', description: '读取不修改资料' }, sideEffects: [],
      },
      evidenceRequirements: [
        {
          id: 'EV-REQ-001', channel: 'API_REQUEST', phase: 'DURING', required: true,
          expectation: 'PRESENT', description: '保存真实请求', factIds, sourceStepId: 'STEP-001', assertionIds: [],
        },
        {
          id: 'EV-RES-001', channel: 'API_RESPONSE', phase: 'AFTER', required: true,
          expectation: 'PRESENT', description: '保存真实响应', factIds, sourceStepId: 'STEP-001', assertionIds: ['AS-001'],
        },
      ],
      oracle: {
        mode: 'ALL', deterministic: true, status: 'READY', assertionIds: ['AS-001'],
        evidenceRequirementIds: ['EV-REQ-001', 'EV-RES-001'],
      },
      prepare: [{
        id: 'PREPARE-001', phase: 'PREPARE', handler: 'runtime.casePrepare', required: true,
        produces: ['fixture.profile-1'],
      }],
      cleanup: [{ id: 'CLEANUP-001', phase: 'CLEANUP', handler: 'runtime.caseCleanup', required: true }],
      dependencies: [{
        id: 'DEP-ENV-API', kind: 'ENVIRONMENT', ref: 'runtime.baseUrl',
        description: '目标 API 环境通过 Preflight', required: true, resolution: 'RUNTIME_REQUIRED',
      }],
      executionContract: {
        executor: { kind: 'HTTP', ref: 'acceptance.apiProcessor', status: 'AVAILABLE', supports: ['GET /echo'] },
        observers: [],
        preflight: [
          { kind: 'ENVIRONMENT', ref: 'runtime.baseUrl', required: true },
          { kind: 'RESOURCE', ref: 'profile-1', required: true },
        ],
        lifecycleHooks: [
          { phase: 'PREPARE', hookId: 'PREPARE-001', required: true, evidenceRequired: true },
          { phase: 'CLEANUP', hookId: 'CLEANUP-001', required: true, evidenceRequired: true },
        ],
      },
      readiness: { status: 'READY', reasons: [], missingCapabilities: [] },
    };
    const report = buildAcceptanceReport({
      project: 'test-flow', requirement, objectives: design.objectives, scenarios: design.scenarios,
      testPoints: points, testCases: [candidate], results: [result(candidate, 'PASS')], defects: [],
    });

    expect(report.cases[0]).toMatchObject({
      schemaVersion: 'TEST_CASE_V2',
      testAspects: ['API_CONTRACT', 'CORE_FUNCTION', 'PRE_POST_CONDITION'],
      requirementStatus: 'CONFIRMED',
      businessScenario: { title: '用户读取资料', expectedBusinessOutcome: '返回用户资料' },
      preconditionPlan: [{ id: 'PRE-001', evidenceRequirementId: 'EV-REQ-001' }],
      testData: [{ id: 'DATA-001', valueRef: 'fixture.profile-1' }],
      steps: [{ id: 'STEP-001', acceptanceCriteriaIds }],
      assertions: [{ id: 'AS-001', evidenceRequirementIds: ['EV-RES-001'] }],
      evidenceRequirements: [
        { id: 'EV-REQ-001', sourceStepId: 'STEP-001' },
        { id: 'EV-RES-001', assertionIds: ['AS-001'] },
      ],
      oracle: { status: 'READY', assertionIds: ['AS-001'], evidenceRequirementIds: ['EV-REQ-001', 'EV-RES-001'] },
      prepare: [{ id: 'PREPARE-001' }], cleanup: [{ id: 'CLEANUP-001' }],
      dependencies: [{ id: 'DEP-ENV-API' }], readiness: { status: 'READY' },
    });
    const json = JSON.parse(renderAcceptanceReportJson(report));
    expect(json.cases[0].expected.response.status).toBe(200);
    expect(report.businessCoverage).toEqual({
      businessFlowCoverage: expect.objectContaining({ total: expect.any(Number), generated: expect.anything(), executable: expect.anything(), executed: expect.anything(), verified: expect.anything() }),
      stateCoverage: expect.objectContaining({ total: expect.any(Number), generated: expect.anything(), executable: expect.anything(), executed: expect.anything(), verified: expect.anything() }),
      permissionCoverage: expect.objectContaining({ total: expect.any(Number), generated: expect.anything(), executable: expect.anything(), executed: expect.anything(), verified: expect.anything() }),
      isolationCoverage: expect.objectContaining({ total: expect.any(Number), generated: expect.anything(), executable: expect.anything(), executed: expect.anything(), verified: expect.anything() }),
      sideEffectCoverage: expect.objectContaining({ total: expect.any(Number), generated: expect.anything(), executable: expect.anything(), executed: expect.anything(), verified: expect.anything() }),
    });
    const markdown = renderAcceptanceReportMarkdown(report);
    for (const label of [
      'Schema Version', 'Test Aspects', 'Requirement Status', 'Business Scenario',
      'Precondition Plan', 'Test Data', 'Assertions', 'Expected Contract',
      'Evidence Requirements', 'Oracle', 'Prepare', 'Cleanup', 'Dependencies', 'Readiness',
    ]) expect(markdown).toContain(label);
    for (const id of ['STEP-001', 'AS-001', 'EV-REQ-001', 'EV-RES-001', 'DEP-ENV-API']) {
      expect(markdown).toContain(id);
    }
    expect(markdown).toContain('| 一级业务覆盖 | Targets | GENERATED | EXECUTABLE | EXECUTED | VERIFIED |');
    expect(markdown).toContain('### Business Quality Gate');
  });

  it('preserves structural AUTH statistics while still redacting authentication secrets', () => {
    const requirement = parseAcceptanceRequirement(fixture);
    const points = generateTestPoints(requirement);
    const authCase = testCase(1, 'AUTH');
    const report = buildAcceptanceReport({
      project: 'test-flow', requirement, testPoints: points,
      testCases: [authCase], results: [result(authCase, 'PASS')], defects: [],
    });
    const json = JSON.parse(renderAcceptanceReportJson(report));
    const markdown = renderAcceptanceReportMarkdown(report);

    expect(report.byType.auth).toBe(1);
    expect(report.typeResults.AUTH).toMatchObject({ total: 1, passed: 1 });
    expect(json.byType.auth).toBe(1);
    expect(json.typeResults.AUTH).toMatchObject({ total: 1, passed: 1 });
    expect(markdown).toContain('| AUTH | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |');
    expect(JSON.stringify(json.executions)).not.toContain('Bearer secret');
  });

  it.each([
    {
      name: 'not executed',
      mutate: (value: AcceptanceCaseExecutionResult) => { value.executed = false; },
      expectedStatus: 'NOT_EXECUTED',
      expectedCount: 'notExecuted',
    },
    {
      name: 'invalid binding',
      mutate: (value: AcceptanceCaseExecutionResult) => { value.evidence.binding = { valid: false, code: 'BINDING_MISMATCH' }; },
      expectedStatus: 'BLOCKED',
      expectedCount: 'blocked',
    },
    {
      name: 'missing request evidence',
      mutate: (value: AcceptanceCaseExecutionResult) => { value.evidence.request = undefined; },
      expectedStatus: 'BLOCKED',
      expectedCount: 'blocked',
    },
    {
      name: 'missing response evidence',
      mutate: (value: AcceptanceCaseExecutionResult) => { value.evidence.response = undefined; },
      expectedStatus: 'BLOCKED',
      expectedCount: 'blocked',
    },
    {
      name: 'empty assertions',
      mutate: (value: AcceptanceCaseExecutionResult) => { value.evidence.assertions = []; },
      expectedStatus: 'BLOCKED',
      expectedCount: 'blocked',
    },
    {
      name: 'failed assertion',
      mutate: (value: AcceptanceCaseExecutionResult) => { value.evidence.assertions[0].pass = false; },
      expectedStatus: 'BLOCKED',
      expectedCount: 'blocked',
    },
  ])('fails closed when an upstream PASS has $name', ({ mutate, expectedStatus, expectedCount }) => {
    const requirement = parseAcceptanceRequirement(fixture);
    const points = generateTestPoints(requirement);
    const test = testCase(1, 'API');
    const inconsistent = result(test, 'PASS');
    mutate(inconsistent);

    const report = buildAcceptanceReport({
      project: 'test-flow', requirement, testPoints: points, testCases: [test], results: [inconsistent], defects: [],
    });

    expect(report.summary.passed).toBe(0);
    expect(report.summary[expectedCount as 'blocked' | 'notExecuted']).toBe(1);
    expect(report.conclusion).toBe('BLOCKED');
    expect(report.executions[0]).toMatchObject({
      status: expectedStatus,
      rawStatus: 'PASS',
      classification: 'SYSTEM_ERROR',
      attribution: { evidenceSources: ['REPORT_INTEGRITY_GATE'] },
    });
    expect(report.risks).toContainEqual(expect.objectContaining({
      caseId: test.id,
      status: 'RESULT_INTEGRITY_VIOLATION',
      classification: 'RESULT_INTEGRITY',
    }));
  });

  it('blocks the report when cleanup produces a data lifecycle risk', () => {
    const requirement = parseAcceptanceRequirement(fixture);
    const points = generateTestPoints(requirement);
    const test = testCase(1, 'API');
    const report = buildAcceptanceReport({
      project: 'test-flow',
      requirement,
      testPoints: points,
      testCases: [test],
      results: [result(test, 'PASS')],
      defects: [],
      externalRisks: [{
        caseId: test.id,
        status: 'CLEANUP_FAILED',
        classification: 'DATA_LIFECYCLE',
        description: '测试数据清理失败',
      }],
    });

    expect(report.summary.passed).toBe(1);
    expect(report.risks).toContainEqual(expect.objectContaining({
      status: 'CLEANUP_FAILED',
      classification: 'DATA_LIFECYCLE',
    }));
    expect(report.conclusion).toBe('BLOCKED');
  });

  it('reports cross-channel Observation Gaps as unverified instead of PASS', () => {
    const requirement = parseAcceptanceRequirement(fixture);
    const design = buildAcceptanceTestDesign(requirement);
    const points = generateTestPoints(requirement, design);
    const point = points.find((candidate) => candidate.factIds.length > 0)!;
    const designedOnly: TestCase = {
      ...testCase(1, 'SIDE_EFFECT', point),
      executionMode: 'DESIGNED_ONLY',
      protocol: undefined,
      steps: [],
      assertions: [{
        type: 'DESIGN_EXPECTATION',
        description: '必须验证库存真实扣减',
        factIds: point.factIds,
        objectiveIds: point.objectiveId ? [point.objectiveId] : [],
      }],
      design: {
        objectiveIds: point.objectiveId ? [point.objectiveId] : [],
        factIds: point.factIds,
        sourceType: 'REQUIREMENT',
        expectedOutcome: '库存真实扣减一次',
        actions: ['读取库存前后状态'],
        executability: 'DESIGNED_ONLY',
        reason: 'SIDE_EFFECT_EVIDENCE_UNAVAILABLE',
      },
      metadata: {
        caseQuality: {
          status: 'DESIGNED_ONLY',
          issues: [{ code: 'EXECUTOR_UNAVAILABLE', message: '缺少 side-effect observer' }],
        },
      },
    };
    const report = buildAcceptanceReport({
      project: 'test-flow', requirement,
      objectives: design.objectives, scenarios: design.scenarios,
      testPoints: points, testCases: [designedOnly], results: [result(designedOnly, 'NOT_EXECUTED')], defects: [],
    });

    expect(report.summary.passed).toBe(0);
    expect(report.observationGaps).toEqual([expect.objectContaining({
      status: 'UNVERIFIED',
      testType: 'SIDE_EFFECT',
      requiredCapability: 'SIDE_EFFECT_OBSERVER',
      factIds: point.factIds,
      caseIds: [designedOnly.id],
    })]);
    expect(report.coreIssues).toContainEqual(expect.objectContaining({
      kind: 'OBSERVATION_GAP',
      affectedCaseIds: [designedOnly.id],
    }));
    expect(report.cases[0]).toMatchObject({
      qualityStatus: 'DESIGNED_ONLY',
      executionStatus: 'NOT_EXECUTED',
    });
    const markdown = renderAcceptanceReportMarkdown(report);
    expect(markdown).toContain('### Observation Gap');
    expect(markdown).toContain('无法验证：下游服务、消息、库存、扣费、文件或第三方状态');
    expect(markdown).not.toContain('- Execution Status：PASS');
  });

  it('preserves Case Quality BLOCKED instead of downgrading it to designed-only NOT_EXECUTED', () => {
    const requirement = parseAcceptanceRequirement(fixture);
    const design = buildAcceptanceTestDesign(requirement);
    const points = generateTestPoints(requirement, design);
    const blockedCase: TestCase = {
      ...testCase(1, 'DATA_ISOLATION', points.find((point) => point.factIds.length > 0)),
      executionMode: 'DESIGNED_ONLY',
      protocol: undefined,
      steps: [],
      assertions: [{ type: 'DESIGN_EXPECTATION', description: '缺少 Actor/Target，禁止执行' }],
      metadata: {
        caseQuality: {
          status: 'BLOCKED',
          issues: [{ code: 'ACTOR_CONTEXT_MISSING', message: '权限 Case 缺少 Actor' }],
        },
      },
    };
    const blockedResult = result(blockedCase, 'BLOCKED');
    const report = buildAcceptanceReport({
      project: 'test-flow', requirement,
      objectives: design.objectives, scenarios: design.scenarios,
      testPoints: points, testCases: [blockedCase], results: [blockedResult], defects: [],
    });

    expect(report.summary).toMatchObject({ blocked: 1, notExecuted: 0, passed: 0 });
    expect(report.cases[0]).toMatchObject({ qualityStatus: 'BLOCKED', executionStatus: 'BLOCKED' });
    expect(report.conclusion).toBe('BLOCKED');
    expect(report.observationGaps).toHaveLength(0);
  });

  it('keeps the original Fact-based affected scope in a successful fix verification report', () => {
    const requirement = parseAcceptanceRequirement(fixture);
    const design = buildAcceptanceTestDesign(requirement);
    const points = generateTestPoints(requirement, design);
    const candidate = testCase(1, 'PERMISSION', points.find((point) => point.factIds.length > 0));
    const failed = result(candidate, 'FAIL');
    const failedReport = buildAcceptanceReport({
      project: 'test-flow', requirement,
      objectives: design.objectives, scenarios: design.scenarios,
      testPoints: points, testCases: [candidate], results: [failed], defects: buildAcceptanceDefects([failed]),
    });
    expect(failedReport.regression.available).toBe(true);

    const fixedReport = buildAcceptanceReport({
      project: 'test-flow', parentRunId: failedReport.runId, requirement,
      objectives: design.objectives, scenarios: design.scenarios,
      testPoints: points, testCases: [candidate], results: [result(candidate, 'PASS')], defects: [],
      regressionPlan: failedReport.regression.plan,
    });

    expect(fixedReport.summary.failed).toBe(0);
    expect(fixedReport.regression).toMatchObject({
      available: true,
      plan: {
        seedCaseIds: [candidate.id],
        affectedFactIds: candidate.source?.factIds,
        affectedCaseIds: [candidate.id],
      },
    });
    expect(renderAcceptanceReportMarkdown(fixedReport)).toContain('- 原失败 Cases：CASE-1');
  });

  it('redacts secrets and common PII defensively in JSON, Markdown, HTML and written artifacts', async () => {
    const requirement = parseAcceptanceRequirement(fixture);
    const points = generateTestPoints(requirement);
    const cases = [testCase(1, 'API')];
    const results = [result(cases[0], 'PASS')];
    const report = buildAcceptanceReport({ project: 'test-flow', requirement, testPoints: points, testCases: cases, results, defects: [] });
    const rawSecrets = [
      'raw-bearer-secret-123456', 'raw-cookie-secret-123456', 'raw-password-secret-123456',
      'raw-query-secret-123456', 'person@example.com', '13812345678', '4111111111111111',
    ];
    report.warnings.push({
      code: 'UNPARSED_CONTRACT_HINT', message: `Authorization: Bearer ${rawSecrets[0]}`,
      source: { content: `Cookie=session=${rawSecrets[1]} password=${rawSecrets[2]} ${rawSecrets[4]} ${rawSecrets[5]} ${rawSecrets[6]}` },
    });
    report.executions[0].evidence.request = {
      method: 'GET', url: `https://internal.example/users/user-a?token=${rawSecrets[3]}&userId=user-a`,
      headers: { Authorization: `Bearer ${rawSecrets[0]}`, Cookie: rawSecrets[1] }, pathParams: {}, query: {},
    };
    report.executions[0].evidence.response = {
      status: 200, headers: { 'set-cookie': rawSecrets[1] },
      body: { level1: { level2: { level3: { level4: { level5: { level6: { level7: { password: rawSecrets[2] } } } } } } } },
    };

    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'acceptance-redaction-'));
    try {
      const rendered = [
        renderAcceptanceReportJson(report), renderAcceptanceReportMarkdown(report), renderAcceptanceReportHtml(report),
      ];
      const files = await writeAcceptanceReports(report, outputDir);
      rendered.push(await readFile(files.json, 'utf8'), await readFile(files.markdown, 'utf8'), await readFile(files.html, 'utf8'));
      for (const output of rendered) {
        for (const secret of rawSecrets) expect(output).not.toContain(secret);
        expect(output).not.toContain('https://internal.example');
      }
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
