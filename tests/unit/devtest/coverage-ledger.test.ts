import { describe, expect, it } from 'vitest';
import {
  buildCaseDataBindings,
  buildCoverageLedger,
  maskDataValue,
  renderCoverageLedgerMarkdownTable,
  renderFourParallelListsMarkdown,
  type TestPointCoverageLedgerItem,
} from '../../../src/devtest/coverage-ledger.js';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';
import type { AcceptanceRequirement } from '../../../src/acceptance/requirement-ir.js';
import type { DevTestEnvironmentPreflight } from '../../../src/devtest/types.js';
import type { AcceptanceReport } from '../../../src/acceptance/acceptance-report.js';
import type { AcceptanceCaseExecutionResult } from '../../../src/acceptance/api-processor.js';

function makeTestCase(overrides: Partial<TestCase> & { id: string; name: string }): TestCase {
  return {
    feature: 'CoreModule',
    priority: 'P1',
    tags: ['api'],
    testType: 'FUNCTIONAL',
    executionMode: 'EXECUTABLE',
    assertions: [],
    steps: [{ action: 'execute', description: 'default step' }],
    ...overrides,
  };
}

function makeRequirement(overrides?: Partial<AcceptanceRequirement>): AcceptanceRequirement {
  return {
    id: 'REQ-DEMO',
    title: '演示系统核心接口',
    source: { documentId: 'test.md', line: 1 },
    features: [],
    actors: [],
    pages: [],
    apis: [],
    dataModels: [],
    permissions: [],
    isolationRules: [],
    stateRules: [],
    acceptanceCriteria: [
      { criterionId: 'AC1', objective: 'AC1', source: { documentId: 'test.md', line: 1 } },
      { criterionId: 'AC2', objective: 'AC2', source: { documentId: 'test.md', line: 2 } },
    ],
    businessRules: [],
    factLedger: [],
    warnings: [],
    ...overrides,
  };
}

describe('Coverage Ledger & Data Binding Fact Model', () => {
  describe('maskDataValue (敏感信息脱敏与指纹安全)', () => {
    it('masks authentication credentials and produces SHA-256 fingerprint without leaking plaintext', () => {
      const secret = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-secret-token';
      const result = maskDataValue('authorization_token', secret);
      expect(result.masked).toContain('[SENSITIVE_CREDENTIAL:');
      expect(result.masked).toContain('len=');
      expect(result.masked).toContain('fp=');
      expect(result.masked).not.toContain('super-secret-token');
      expect(result.fingerprint).toHaveLength(8);
    });

    it('masks phone numbers to standard 11-digit masked format', () => {
      const result = maskDataValue('user_phone', '13812345678');
      expect(result.masked).toBe('138****5678');
      expect(result.fingerprint).toHaveLength(8);
    });

    it('strips credentials embedded in base URLs', () => {
      const result = maskDataValue('endpoint_url', 'https://admin:pass123@api.internal.net/v1/projects');
      expect(result.masked).toBe('https://api.internal.net/v1/projects');
      expect(result.masked).not.toContain('admin');
      expect(result.masked).not.toContain('pass123');
    });

    it('handles undefined and null gracefully', () => {
      const undef = maskDataValue('missingKey', undefined);
      expect(undef.masked).toBe('N/A（未提供）');
      expect(undef.fingerprint).toBe('none');
    });
  });

  describe('buildCaseDataBindings (数据绑定事实提取)', () => {
    const preflightReady: DevTestEnvironmentPreflight = {
      status: 'READY',
      ambiguous: false,
      candidates: [],
      checks: {
        baseUrl: 'READY',
        health: 'READY',
        authentication: 'READY',
        api: 'READY',
        browser: 'READY',
        database: 'READY',
      },
      executableDimensions: ['API', 'FUNCTIONAL'],
      blockedDimensions: [],
    };

    it('records PROVIDED_AND_CONSUMED when baseUrl is provided and valid', () => {
      const testCase = makeTestCase({
        id: 'TC-001',
        name: '基础查询接口',
        testType: 'FUNCTIONAL',
        steps: [{ action: 'GET /api/v1/items', description: 'GET /api/v1/items' }],
      });

      const bindings = buildCaseDataBindings(testCase, {
        baseUrl: 'https://api.staging.panqu.com',
        preflight: preflightReady,
        deliveredBindingIds: new Set(['bind:TC-001:baseUrl']),
      });

      const urlBinding = bindings.find((b) => b.dataKey === 'baseUrl');
      expect(urlBinding).toBeDefined();
      expect(urlBinding?.bindingStatus).toBe('PROVIDED_AND_CONSUMED');
      expect(urlBinding?.reasonCode).toBe('DELIVERED_TO_PROCESSOR');
    });

    it('records PROVIDED_BUT_INVALID when baseUrl has invalid protocol scheme', () => {
      const testCase = makeTestCase({
        id: 'TC-002',
        name: '非法地址用例',
        testType: 'FUNCTIONAL',
        steps: [{ action: 'GET /api/v1/items', description: 'GET /api/v1/items' }],
      });

      const bindings = buildCaseDataBindings(testCase, {
        baseUrl: 'invalid-host-without-protocol',
        preflight: preflightReady,
      });

      const urlBinding = bindings.find((b) => b.dataKey === 'baseUrl');
      expect(urlBinding?.bindingStatus).toBe('PROVIDED_BUT_INVALID');
      expect(urlBinding?.reasonCode).toBe('INVALID_URL_SCHEME');
    });

    it('distinguishes between auth required (CONSUMED) and not required (PROVIDED_BUT_UNBOUND) for actorHeaders', () => {
      const authCase = makeTestCase({
        id: 'TC-AUTH',
        name: '越权拦截验证',
        testType: 'AUTH',
        steps: [{ action: 'GET /api/v1/admin/settings', description: 'GET /api/v1/admin/settings' }],
      });

      const normalCase = makeTestCase({
        id: 'TC-NORMAL',
        name: '公开健康检查',
        testType: 'FUNCTIONAL',
        steps: [{ action: 'GET /api/v1/health', description: 'GET /api/v1/health' }],
      });

      const authBindings = buildCaseDataBindings(authCase, {
        baseUrl: 'https://api.test',
        actorHeaders: { defaultActor: { Authorization: 'Bearer test-token' } },
        preflight: preflightReady,
        deliveredBindingIds: new Set(['bind:TC-AUTH:actorHeaders:defaultActor']),
      });

      const normalBindings = buildCaseDataBindings(normalCase, {
        baseUrl: 'https://api.test',
        actorHeaders: { defaultActor: { Authorization: 'Bearer test-token' } },
        preflight: preflightReady,
      });

      const authHeaderBinding = authBindings.find((b) => b.dataKey.startsWith('actorHeaders'));
      expect(authHeaderBinding?.bindingStatus).toBe('PROVIDED_AND_CONSUMED');

      const normalHeaderBinding = normalBindings.find((b) => b.dataKey.startsWith('actorHeaders'));
      expect(normalHeaderBinding?.bindingStatus).toBe('PROVIDED_BUT_UNBOUND');
      expect(normalHeaderBinding?.reasonCode).toBe('CASE_NO_AUTH_REQUIRED');
    });
  });

  describe('buildCoverageLedger (覆盖事实账本与四类清单互斥性)', () => {
    const dummyReq = makeRequirement();

    const preflightReady: DevTestEnvironmentPreflight = {
      status: 'READY',
      ambiguous: false,
      candidates: [],
      checks: {
        baseUrl: 'READY',
        health: 'READY',
        authentication: 'READY',
        api: 'READY',
        browser: 'READY',
        database: 'READY',
      },
      executableDimensions: ['API', 'FUNCTIONAL'],
      blockedDimensions: [],
    };

    it('accurately accounts for data binding when user provided data but pipeline is DRY_RUN', () => {
      const cases: TestCase[] = [
        makeTestCase({ id: 'TC-01', name: '用户查询', steps: [{ action: 'GET /user', description: 'GET /user' }] }),
        makeTestCase({ id: 'TC-02', name: '用户更新', steps: [{ action: 'POST /user', description: 'POST /user' }] }),
      ];

      const ledger = buildCoverageLedger({
        requirement: dummyReq,
        testCases: cases,
        selectedCaseIds: ['TC-01'],
        pipelineMode: 'dry-run',
        environmentPreflight: preflightReady,
        options: {
          baseUrl: 'https://api.example.com',
        },
      });

      expect(ledger.summary.totalPlanned).toBe(2);
      expect(ledger.summary.totalSelected).toBe(1);
      expect(ledger.summary.totalExecuted).toBe(0);
      expect(ledger.summary.totalUntested).toBe(2);

      // TC-01 is selected but in DRY_RUN -> UNTESTED with explicit explanation
      const tc01 = ledger.items.find((i) => i.caseId === 'TC-01')!;
      expect(tc01.finalClassification).toBe('UNTESTED');
      expect(tc01.statusReason).toContain('DRY_RUN');
      expect(tc01.dataBindings.find((b) => b.dataKey === 'baseUrl')?.bindingStatus).toBe('BOUND_NOT_DISPATCHED');

      // TC-02 was unselected -> UNTESTED with unselected reason
      const tc02 = ledger.items.find((i) => i.caseId === 'TC-02')!;
      expect(tc02.finalClassification).toBe('UNTESTED');
      expect(tc02.statusReason).toContain('未入选');
    });

    it('enforces strict mutual exclusivity across four parallel lists (A, B, C, D)', () => {
      const cases: TestCase[] = [
        makeTestCase({ id: 'TC-PASS', name: '成功用例', steps: [{ action: 'GET /ok', description: 'GET /ok' }] }),
        makeTestCase({ id: 'TC-BUG', name: '缺陷用例', steps: [{ action: 'GET /bug', description: 'GET /bug' }] }),
        makeTestCase({ id: 'TC-BLOCK', name: '阻断用例', steps: [{ action: 'GET /blocked', description: 'GET /blocked' }] }),
        makeTestCase({ id: 'TC-UNTESTED', name: '未测用例', steps: [{ action: 'GET /untested', description: 'GET /untested' }] }),
      ];

      const mockExecutions: AcceptanceReport['executions'] = [
        {
          caseId: 'TC-PASS',
          name: '成功用例',
          testType: 'FUNCTIONAL',
          executionMode: 'EXECUTABLE',
          status: 'PASS',
          executed: true,
          classification: 'SUCCESS',
          attribution: { classification: 'SUCCESS', confidence: 'HIGH', reason: 'Pass', evidenceSources: [] },
          evidence: {
            acceptanceCriteriaIds: [],
            request: { method: 'GET', url: 'https://api/ok', headers: {}, pathParams: {}, query: {} },
            response: { status: 200, headers: {}, body: { success: true } },
            assertions: [{ pass: true, detail: 'status is 200', type: 'STATUS' }],
          },
        },
        {
          caseId: 'TC-BUG',
          name: '缺陷用例',
          testType: 'FUNCTIONAL',
          executionMode: 'EXECUTABLE',
          status: 'FAIL',
          executed: true,
          classification: 'PRODUCT_FAILURE',
          attribution: { classification: 'PRODUCT_FAILURE', confidence: 'HIGH', reason: 'Fail', evidenceSources: [] },
          evidence: {
            acceptanceCriteriaIds: [],
            request: { method: 'GET', url: 'https://api/bug', headers: {}, pathParams: {}, query: {} },
            response: { status: 500, headers: {}, body: { error: 'Internal Error' } },
            assertions: [{ pass: false, detail: 'status expected 200 got 500', type: 'STATUS' }],
          },
        },
        {
          caseId: 'TC-BLOCK',
          name: '阻断用例',
          testType: 'FUNCTIONAL',
          executionMode: 'EXECUTABLE',
          status: 'BLOCKED',
          executed: false,
          classification: 'EXECUTION_BLOCKED',
          attribution: { classification: 'EXECUTION_BLOCKED', confidence: 'HIGH', reason: 'Preflight fail', evidenceSources: [] },
          evidence: {
            acceptanceCriteriaIds: [],
            assertions: [],
          },
        },
      ];

      const mockResults: AcceptanceCaseExecutionResult[] = [
        {
          caseId: 'TC-PASS',
          name: '成功用例',
          pass: true,
          passRate: 1,
          executed: true,
          processorInvoked: true,
          processor: 'PanquProtocolProcessor',
          classification: 'SUCCESS',
          attribution: { classification: 'SUCCESS', confidence: 'HIGH', reason: 'Pass', evidenceSources: [] },
          evidence: mockExecutions[0].evidence,
        },
        {
          caseId: 'TC-BUG',
          name: '缺陷用例',
          pass: false,
          passRate: 0,
          executed: true,
          processorInvoked: true,
          processor: 'PanquProtocolProcessor',
          classification: 'PRODUCT_FAILURE',
          attribution: { classification: 'PRODUCT_FAILURE', confidence: 'HIGH', reason: 'Fail', evidenceSources: [] },
          evidence: mockExecutions[1].evidence,
        },
        {
          caseId: 'TC-BLOCK',
          name: '阻断用例',
          pass: false,
          passRate: 0,
          executed: false,
          processorInvoked: false,
          classification: 'EXECUTION_BLOCKED',
          attribution: { classification: 'EXECUTION_BLOCKED', confidence: 'HIGH', reason: 'Preflight fail', evidenceSources: [] },
          evidence: mockExecutions[2].evidence,
        },
      ];

      const ledger = buildCoverageLedger({
        requirement: dummyReq,
        testCases: cases,
        selectedCaseIds: ['TC-PASS', 'TC-BUG', 'TC-BLOCK'],
        pipelineMode: 'execute',
        environmentPreflight: preflightReady,
        results: mockResults,
        pipelineReport: { executions: mockExecutions } as AcceptanceReport,
        syntheticBlocks: [{ code: 'PREFLIGHT', message: 'Preflight blocked', affectedCases: ['TC-BLOCK'] }],
        options: { baseUrl: 'https://api.example.com' },
      });

      const { confirmedBugs, testBlocked, untested, passed } = ledger.fourLists;

      // 1. 验证数量
      expect(confirmedBugs.length).toBe(1);
      expect(testBlocked.length).toBe(1);
      expect(untested.length).toBe(1);
      expect(passed.length).toBe(1);

      // 2. 验证总和等于规划总数 (A + B + C + D = totalPlanned)
      const total = confirmedBugs.length + testBlocked.length + untested.length + passed.length;
      expect(total).toBe(ledger.summary.totalPlanned);
      expect(ledger.summary.totalPlanned).toBe(4);

      // 3. 验证四清单完全互斥（集合无交集）
      const idsA = new Set(confirmedBugs.map((i) => i.caseId));
      const idsB = new Set(testBlocked.map((i) => i.caseId));
      const idsC = new Set(untested.map((i) => i.caseId));
      const idsD = new Set(passed.map((i) => i.caseId));

      for (const id of idsA) {
        expect(idsB.has(id)).toBe(false);
        expect(idsC.has(id)).toBe(false);
        expect(idsD.has(id)).toBe(false);
      }
      for (const id of idsB) {
        expect(idsA.has(id)).toBe(false);
        expect(idsC.has(id)).toBe(false);
        expect(idsD.has(id)).toBe(false);
      }
      for (const id of idsC) {
        expect(idsA.has(id)).toBe(false);
        expect(idsB.has(id)).toBe(false);
        expect(idsD.has(id)).toBe(false);
      }
      for (const id of idsD) {
        expect(idsA.has(id)).toBe(false);
        expect(idsB.has(id)).toBe(false);
        expect(idsC.has(id)).toBe(false);
      }

      // 4. 首屏 7 项速览核验
      expect(ledger.quickView.confirmedBugsCount).toBe(1);
      expect(ledger.quickView.testBlockedCount).toBe(1);
      expect(ledger.quickView.testedSummary).toContain('已真实执行验证');
      expect(ledger.quickView.businessConclusion).toContain('存在已确认产品缺陷');
      expect(ledger.quickView.nextStepAndOwner.role).toContain('研发负责人');
    });

    it('does not misclassify environment/cleanup failures as product bugs', () => {
      const cases: TestCase[] = [
        makeTestCase({ id: 'TC-CLEANUP', name: '数据清理异常项', steps: [{ action: 'DELETE /temp', description: 'DELETE /temp' }] }),
      ];

      const mockExecutions: AcceptanceReport['executions'] = [
        {
          caseId: 'TC-CLEANUP',
          name: '数据清理异常项',
          testType: 'FUNCTIONAL',
          executionMode: 'EXECUTABLE',
          status: 'FAIL',
          executed: true,
          classification: 'SYSTEM_ERROR',
          attribution: { classification: 'SYSTEM_ERROR', confidence: 'HIGH', reason: 'Cleanup failed', evidenceSources: [] },
          evidence: {
            acceptanceCriteriaIds: [],
            assertions: [{ pass: false, detail: 'Cleanup returned 500', type: 'CLEANUP' }],
          },
        },
      ];

      const ledger = buildCoverageLedger({
        requirement: dummyReq,
        testCases: cases,
        selectedCaseIds: ['TC-CLEANUP'],
        pipelineMode: 'execute',
        environmentPreflight: preflightReady,
        dataLifecycle: {
          runId: 'run-clean-test',
          createdBy: 'DEVTEST',
          prepareStatus: 'READY',
          cleanupStatus: 'FAILED',
          traceable: true,
          cleanupIssues: ['DB connection reset during cleanup'],
          entitiesCreated: [{ type: 'record', id: 'E1', runId: 'run-clean-test' }],
        },
        pipelineReport: { executions: mockExecutions } as AcceptanceReport,
        options: { baseUrl: 'https://api.example.com' },
      });

      // 清理失败不应被错报为产品缺陷（清单 A），而必须归入测试阻断（清单 B）
      expect(ledger.fourLists.confirmedBugs.length).toBe(0);
      expect(ledger.fourLists.testBlocked.length).toBe(1);
      expect(ledger.fourLists.testBlocked[0].finalClassification).toBe('TEST_BLOCKED');
    });
  });

  describe('Markdown table and list rendering', () => {
    it('renders coverage ledger table without undefined or raw placeholder text', () => {
      const item: TestPointCoverageLedgerItem = {
        requirementId: 'REQ-01',
        linkedFactIds: ['FACT-01'],
        isUntracedCase: false,
        testPointId: 'TP-01',
        caseId: 'TC-01',
        title: '测试用例标题',
        dimension: 'FUNCTIONAL',
        planned: true,
        selected: true,
        selectionReason: '核心调度',
        applicable: true,
        executionMode: 'API',
        readinessStatus: 'READY',
        readinessReasons: [],
        dataBindings: [
          {
            bindingId: 'bind:TC-01:baseUrl',
            dataKey: 'baseUrl',
            targetField: 'HTTP.baseUrl',
            sourceRef: 'options',
            sourceOrigin: 'USER_PROVIDED',
            bindingStatus: 'PROVIDED_AND_CONSUMED',
            bindingPhase: 'DELIVERED',
            reasonCode: 'CONSUMED',
            maskedValueSummary: 'https://api.test',
            fingerprint: 'abcd1234',
          },
        ],
        dispatchAttempted: true,
        processorInvoked: true,
        executed: true,
        oracleRan: true,
        oracleVerdict: 'PASS',
        requiredEvidence: ['HTTP_REQUEST', 'HTTP_RESPONSE'],
        collectedEvidence: ['HTTP_REQUEST', 'HTTP_RESPONSE'],
        missingEvidence: [],
        finalStatus: 'PASS',
        finalClassification: 'PASSED',
        statusReason: '全部断言通过',
        relatedProblemIds: [],
      };

      const tableMarkdown = renderCoverageLedgerMarkdownTable([item]);
      expect(tableMarkdown).toContain('| 测试点/用例编号 | 测试类型 | 数据准备与消费 | 执行状态 | Oracle 结论 | 证据状态 | 最终分类 | 原因与处置 |');
      expect(tableMarkdown).toContain('TC-01');
      expect(tableMarkdown).toContain('🟢 已通过');
      expect(tableMarkdown).not.toContain('undefined');
    });

    it('renders four parallel lists with explicit Markdown headers', () => {
      const listsMarkdown = renderFourParallelListsMarkdown({
        confirmedBugs: [],
        testBlocked: [],
        untested: [],
        passed: [],
      });

      expect(listsMarkdown).toContain('### 🔴 清单 A：确认产品缺陷 (Confirmed Product Bugs)');
      expect(listsMarkdown).toContain('### 🟡 清单 B：测试阻断 (Test Blockers)');
      expect(listsMarkdown).toContain('### ⚪ 清单 C：未测试项 (Untested Items)');
      expect(listsMarkdown).toContain('### 🟢 清单 D：已通过项 (Passed Items)');
    });
  });

  describe('Scenario C & D: Precise classification and reason codes', () => {
    const dummyReq = makeRequirement();
    const preflightReady: DevTestEnvironmentPreflight = {
      status: 'READY', ambiguous: false, candidates: [],
      checks: { baseUrl: 'READY', health: 'READY', authentication: 'READY', api: 'READY', browser: 'READY', database: 'READY' },
      executableDimensions: ['API'], blockedDimensions: [],
    };

    it('Scenario C: classifies synthetic SAFE policy blocked case as TEST_BLOCKED with SAFE_POLICY_BLOCKED', () => {
      const readCase = makeTestCase({ id: 'TC-READ', name: 'GET /items' });
      const writeCase = makeTestCase({ id: 'TC-WRITE', name: 'POST /items' });
      const ledger = buildCoverageLedger({
        requirement: dummyReq,
        testCases: [readCase, writeCase],
        selectedCaseIds: ['TC-READ', 'TC-WRITE'],
        pipelineMode: 'dry-run',
        environmentPreflight: preflightReady,
        syntheticBlocks: [{
          code: 'SAFE_POLICY_BLOCKED',
          message: 'SAFE 只读策略拦截写操作 POST /items',
          scope: 'OPERATION',
          affectedCases: ['TC-WRITE'],
        }],
      });

      const writeItem = ledger.items.find((i) => i.caseId === 'TC-WRITE');
      expect(writeItem?.finalClassification).toBe('TEST_BLOCKED');
      expect(writeItem?.blockedReasonCode).toBe('SAFE_POLICY_BLOCKED');

      const readItem = ledger.items.find((i) => i.caseId === 'TC-READ');
      expect(readItem?.finalClassification).toBe('UNTESTED');
      expect(readItem?.untestedReasonCode).toBe('DRY_RUN');
    });

    it('Scenario D: records specific NOT_SELECTED reason codes for pruned cases', () => {
      const case1 = makeTestCase({ id: 'TC-PRUNED', name: '超出上限用例' });
      const ledger = buildCoverageLedger({
        requirement: dummyReq,
        testCases: [case1],
        selectedCaseIds: [],
        pipelineMode: 'dry-run',
        environmentPreflight: preflightReady,
        selection: {
          candidates: [case1],
          selected: [],
          unselected: [{ caseId: 'TC-PRUNED', reason: 'MAX_CASES' }],
          decisions: [],
          scores: {},
          profiles: {},
          deduplication: { generated: 1, retained: 0, removed: 0, groups: [] },
          adaptiveScores: {},
        },
      });

      const item = ledger.items.find((i) => i.caseId === 'TC-PRUNED');
      expect(item?.finalClassification).toBe('UNTESTED');
      expect(item?.untestedReasonCode).toBe('NOT_SELECTED:MAX_CASES');
      expect(ledger.fourLists.untested.some((u) => u.caseId === 'TC-PRUNED' && u.untestedReasonCode === 'NOT_SELECTED:MAX_CASES')).toBe(true);
    });
  });

  describe('Contract 3 & 4: Evidence Hard Gate, Ledger Determinism & Reconciliation Invariants', () => {
    const dummyReq = makeRequirement();
    const preflightReady: DevTestEnvironmentPreflight = {
      status: 'READY', ambiguous: false, candidates: [],
      checks: { baseUrl: 'READY', health: 'READY', authentication: 'READY', api: 'READY', browser: 'READY', database: 'READY' },
      executableDimensions: ['API'], blockedDimensions: [],
    };

    const stateCases = [
      {
        status: 'PASS',
        expectedFinalStatus: 'PASS',
        expectedClassification: 'PASSED',
        expectedBadge: '🟢 已通过',
        listKey: 'passed' as const,
      },
      {
        status: 'FAIL',
        expectedFinalStatus: 'FAIL',
        expectedClassification: 'CONFIRMED_BUG',
        expectedBadge: '🔴 产品缺陷',
        listKey: 'confirmedBugs' as const,
      },
      {
        status: 'BLOCKED',
        expectedFinalStatus: 'BLOCKED',
        expectedClassification: 'TEST_BLOCKED',
        expectedBadge: '🟡 测试阻断',
        listKey: 'testBlocked' as const,
      },
      {
        status: 'NOT_EXECUTED',
        expectedFinalStatus: 'NOT_EXECUTED',
        expectedClassification: 'UNTESTED',
        expectedBadge: '⚪ 未测试',
        listKey: 'untested' as const,
      },
    ] as const;

    it.each(stateCases)(
      'parameterized case state: $status maps to JSON classification $expectedClassification and Markdown badge $expectedBadge',
      ({ status, expectedFinalStatus, expectedClassification, expectedBadge, listKey }) => {
        const tc = makeTestCase({ id: `TC-${status}`, name: `用例 ${status}` });
        const isExecuted = status === 'PASS' || status === 'FAIL';
        const isBlocked = status === 'BLOCKED';

        const mockExec: AcceptanceReport['executions'][number] = {
          caseId: tc.id,
          name: tc.name,
          testType: 'FUNCTIONAL',
          executionMode: 'EXECUTABLE',
          status: status as any,
          executed: isExecuted,
          classification: status === 'PASS' ? 'SUCCESS' : status === 'FAIL' ? 'PRODUCT_FAILURE' : status === 'BLOCKED' ? 'EXECUTION_BLOCKED' : 'NOT_EXECUTED',
          attribution: { classification: status === 'PASS' ? 'SUCCESS' : status === 'FAIL' ? 'PRODUCT_FAILURE' : 'EXECUTION_BLOCKED', confidence: 'HIGH', reason: status, evidenceSources: [] },
          evidence: {
            acceptanceCriteriaIds: [],
            request: isExecuted ? { method: 'GET', url: 'https://api/test', headers: {}, pathParams: {}, query: {} } : undefined,
            response: isExecuted ? { status: status === 'PASS' ? 200 : 500, headers: {}, body: {} } : undefined,
            assertions: isExecuted ? [{ pass: status === 'PASS', detail: 'test assert', type: 'STATUS' }] : [],
          },
        };

        const mockRes: AcceptanceCaseExecutionResult = {
          caseId: tc.id,
          name: tc.name,
          pass: status === 'PASS',
          passRate: status === 'PASS' ? 1 : 0,
          executed: isExecuted,
          processorInvoked: isExecuted,
          processor: isExecuted ? 'PanquProtocolProcessor' : undefined,
          classification: mockExec.classification,
          attribution: mockExec.attribution,
          evidence: mockExec.evidence,
        };

        const ledger = buildCoverageLedger({
          requirement: dummyReq,
          testCases: [tc],
          selectedCaseIds: status === 'NOT_EXECUTED' ? [] : [tc.id],
          pipelineMode: 'execute',
          environmentPreflight: preflightReady,
          results: status === 'NOT_EXECUTED' ? [] : [mockRes],
          pipelineReport: {
            cases: [{ caseId: tc.id, executionStatus: status as any }],
            executions: [mockExec],
          } as unknown as AcceptanceReport,
          syntheticBlocks: isBlocked ? [{ code: 'PREFLIGHT', message: 'Preflight blocked', affectedCases: [tc.id] }] : undefined,
        });

        const item = ledger.items.find((i) => i.caseId === tc.id)!;
        expect(item.finalStatus).toBe(expectedFinalStatus);
        expect(item.finalClassification).toBe(expectedClassification);
        expect(ledger.fourLists[listKey].map((c) => c.caseId)).toContain(tc.id);

        const tableMarkdown = renderCoverageLedgerMarkdownTable([item]);
        expect(tableMarkdown).toContain(expectedBadge);
        expect(tableMarkdown).toContain(tc.id);
      },
    );

    it('composite four-state invariant: sum of four lists equals totalPlanned and pipeline completion does not require all PASS', () => {
      const cases = [
        makeTestCase({ id: 'TC-1', name: 'Pass Case' }),
        makeTestCase({ id: 'TC-2', name: 'Fail Case' }),
        makeTestCase({ id: 'TC-3', name: 'Blocked Case' }),
        makeTestCase({ id: 'TC-4', name: 'Untested Case' }),
      ];

      const executions: AcceptanceReport['executions'] = [
        {
          caseId: 'TC-1', name: 'Pass Case', testType: 'FUNCTIONAL', executionMode: 'EXECUTABLE', status: 'PASS', executed: true,
          classification: 'SUCCESS', attribution: { classification: 'SUCCESS', confidence: 'HIGH', reason: 'Pass', evidenceSources: [] },
          evidence: { acceptanceCriteriaIds: [], request: { method: 'GET', url: 'https://api/1', headers: {}, pathParams: {}, query: {} }, response: { status: 200, headers: {}, body: {} }, assertions: [{ pass: true, detail: 'ok', type: 'STATUS' }] },
        },
        {
          caseId: 'TC-2', name: 'Fail Case', testType: 'FUNCTIONAL', executionMode: 'EXECUTABLE', status: 'FAIL', executed: true,
          classification: 'PRODUCT_FAILURE', attribution: { classification: 'PRODUCT_FAILURE', confidence: 'HIGH', reason: 'Fail', evidenceSources: [] },
          evidence: { acceptanceCriteriaIds: [], request: { method: 'GET', url: 'https://api/2', headers: {}, pathParams: {}, query: {} }, response: { status: 500, headers: {}, body: {} }, assertions: [{ pass: false, detail: 'fail', type: 'STATUS' }] },
        },
        {
          caseId: 'TC-3', name: 'Blocked Case', testType: 'FUNCTIONAL', executionMode: 'EXECUTABLE', status: 'BLOCKED', executed: false,
          classification: 'EXECUTION_BLOCKED', attribution: { classification: 'EXECUTION_BLOCKED', confidence: 'HIGH', reason: 'Blocked', evidenceSources: [] },
          evidence: { acceptanceCriteriaIds: [], assertions: [] },
        },
      ];

      const results: AcceptanceCaseExecutionResult[] = [
        { caseId: 'TC-1', name: 'Pass Case', pass: true, passRate: 1, executed: true, processorInvoked: true, processor: 'API', classification: 'SUCCESS', attribution: executions[0].attribution, evidence: executions[0].evidence },
        { caseId: 'TC-2', name: 'Fail Case', pass: false, passRate: 0, executed: true, processorInvoked: true, processor: 'API', classification: 'PRODUCT_FAILURE', attribution: executions[1].attribution, evidence: executions[1].evidence },
        { caseId: 'TC-3', name: 'Blocked Case', pass: false, passRate: 0, executed: false, processorInvoked: false, classification: 'EXECUTION_BLOCKED', attribution: executions[2].attribution, evidence: executions[2].evidence },
      ];

      const ledger = buildCoverageLedger({
        requirement: dummyReq,
        testCases: cases,
        selectedCaseIds: ['TC-1', 'TC-2', 'TC-3'],
        pipelineMode: 'execute',
        environmentPreflight: preflightReady,
        results,
        pipelineReport: {
          cases: [
            { caseId: 'TC-1', executionStatus: 'PASS' },
            { caseId: 'TC-2', executionStatus: 'FAIL' },
            { caseId: 'TC-3', executionStatus: 'BLOCKED' },
            { caseId: 'TC-4', executionStatus: 'NOT_EXECUTED' },
          ],
          executions,
        } as unknown as AcceptanceReport,
        syntheticBlocks: [{ code: 'PREFLIGHT', message: 'Blocked', affectedCases: ['TC-3'] }],
      });

      // 1. Exact list counts
      expect(ledger.fourLists.passed).toHaveLength(1);
      expect(ledger.fourLists.confirmedBugs).toHaveLength(1);
      expect(ledger.fourLists.testBlocked).toHaveLength(1);
      expect(ledger.fourLists.untested).toHaveLength(1);

      // 2. Sum equals totalPlanned
      const sum = ledger.fourLists.passed.length + ledger.fourLists.confirmedBugs.length +
        ledger.fourLists.testBlocked.length + ledger.fourLists.untested.length;
      expect(sum).toBe(ledger.summary.totalPlanned);
      expect(sum).toBe(4);

      // 3. Pipeline execution completion is orthogonal to all-PASS:
      // Pipeline completed successfully with MATCH reconciliation despite 1 fail and 1 blocked
      expect(ledger.reconciliation.status).toBe('MATCH');
      expect(ledger.reconciliation.reconciled).toBe(true);
      expect(ledger.summary.totalPassed).toBe(1);
      expect(ledger.summary.totalConfirmedBugs).toBe(1);
      expect(ledger.summary.totalTestBlocked).toBe(1);
      expect(ledger.summary.totalUntested).toBe(1);
    });

    it('Contract 3: downgrades PASS to TEST_BLOCKED when required evidence (HTTP_RESPONSE) is missing', () => {
      const tc = makeTestCase({ id: 'TC-EVIDENCE-GAP', name: '缺少响应证据的虚假通过用例', steps: [{ action: 'GET /check', description: 'GET /check' }] });
      const mockExecution: AcceptanceReport['executions'][number] = {
        caseId: 'TC-EVIDENCE-GAP',
        name: tc.name,
        testType: 'FUNCTIONAL',
        executionMode: 'EXECUTABLE',
        status: 'PASS',
        executed: true,
        classification: 'SUCCESS',
        attribution: { classification: 'SUCCESS', confidence: 'HIGH', reason: 'Pass', evidenceSources: [] },
        evidence: {
          acceptanceCriteriaIds: [],
          request: { method: 'GET', url: 'https://api/check', headers: {}, pathParams: {}, query: {} },
          // Note: response is intentionally missing here!
          assertions: [{ pass: true, detail: 'status is 200', type: 'STATUS' }],
        },
      };

      const mockResult: AcceptanceCaseExecutionResult = {
        caseId: 'TC-EVIDENCE-GAP',
        name: tc.name,
        pass: true,
        passRate: 1,
        executed: true,
        processorInvoked: true,
        processor: 'PanquProtocolProcessor',
        classification: 'SUCCESS',
        attribution: { classification: 'SUCCESS', confidence: 'HIGH', reason: 'Pass', evidenceSources: [] },
        evidence: mockExecution.evidence,
      };

      const ledger = buildCoverageLedger({
        requirement: dummyReq,
        testCases: [tc],
        selectedCaseIds: ['TC-EVIDENCE-GAP'],
        pipelineMode: 'execute',
        environmentPreflight: preflightReady,
        results: [mockResult],
        pipelineReport: { executions: [mockExecution] } as AcceptanceReport,
      });

      const item = ledger.items.find((i) => i.caseId === 'TC-EVIDENCE-GAP')!;
      expect(item).toBeDefined();
      // Invariant: MUST NOT be PASSED
      expect(item.finalClassification).not.toBe('PASSED');
      expect(item.finalClassification).toBe('TEST_BLOCKED');
      expect(item.finalStatus).toBe('BLOCKED');
      expect(item.missingEvidence).toContain('HTTP_RESPONSE');
      expect(item.statusReason).toContain('缺少: HTTP_RESPONSE');
      expect(ledger.fourLists.passed).toHaveLength(0);
      expect(ledger.fourLists.testBlocked.map((b) => b.caseId)).toContain('TC-EVIDENCE-GAP');
    });

    it('Contract 4: buildCoverageLedger is completely deterministic and idempotent on identical inputs', () => {
      const tc1 = makeTestCase({ id: 'TC-DET-1', name: 'GET /item1' });
      const tc2 = makeTestCase({ id: 'TC-DET-2', name: 'POST /item2' });

      const dryRunInput = {
        requirement: dummyReq,
        testCases: [tc1, tc2],
        selectedCaseIds: ['TC-DET-1', 'TC-DET-2'],
        pipelineMode: 'dry-run' as const,
        environmentPreflight: preflightReady,
        syntheticBlocks: [{
          code: 'SAFE_POLICY_BLOCKED',
          message: 'SAFE 只读策略拦截写操作 POST /item2',
          scope: 'OPERATION' as const,
          affectedCases: ['TC-DET-2'],
        }],
      };

      const run1 = buildCoverageLedger(dryRunInput);
      const run2 = buildCoverageLedger(dryRunInput);

      // Invariant: summary, fourLists, and reconciliation are strictly deep-equal
      expect(run1.summary).toEqual(run2.summary);
      expect(run1.fourLists).toEqual(run2.fourLists);
      expect(run1.reconciliation).toEqual(run2.reconciliation);
      expect(run1.items).toEqual(run2.items);

      // Invariant: in dry-run mode, reconciliation is NOT_COMPARABLE but reconciled
      expect(run1.reconciliation.status).toBe('NOT_COMPARABLE');
      expect(run1.reconciliation.reconciled).toBe(true);
      expect(run1.reconciliation.ledgerCount.total).toBe(2);

      // Invariant: in execute mode with matching results, reconciliation is MATCH
      const executeResult: AcceptanceCaseExecutionResult = {
        caseId: 'TC-DET-1',
        name: tc1.name,
        pass: true,
        passRate: 1,
        executed: true,
        processorInvoked: true,
        processor: 'PanquProtocolProcessor',
        classification: 'SUCCESS',
        attribution: { classification: 'SUCCESS', confidence: 'HIGH', reason: 'Pass', evidenceSources: [] },
        evidence: {
          acceptanceCriteriaIds: [],
          request: { method: 'GET', url: 'https://api/item1', headers: {}, pathParams: {}, query: {} },
          response: { status: 200, headers: {}, body: { ok: true } },
          assertions: [{ pass: true, detail: 'status is 200', type: 'STATUS' }],
        },
      };
      const executeReport = {
        cases: [{
          caseId: 'TC-DET-1',
          executionStatus: 'PASS',
        }],
        executions: [{
          caseId: 'TC-DET-1',
          name: tc1.name,
          testType: 'FUNCTIONAL',
          executionMode: 'EXECUTABLE',
          status: 'PASS',
          executed: true,
          classification: 'SUCCESS',
          attribution: { classification: 'SUCCESS', confidence: 'HIGH', reason: 'Pass', evidenceSources: [] },
          evidence: executeResult.evidence,
        }],
      } as unknown as AcceptanceReport;

      const execLedger = buildCoverageLedger({
        requirement: dummyReq,
        testCases: [tc1],
        selectedCaseIds: ['TC-DET-1'],
        pipelineMode: 'execute',
        environmentPreflight: preflightReady,
        results: [executeResult],
        pipelineReport: executeReport,
      });
      expect(execLedger.reconciliation.status).toBe('MATCH');
      expect(execLedger.reconciliation.reconciled).toBe(true);
      expect(execLedger.reconciliation.mismatches).toHaveLength(0);
    });
  });
});
