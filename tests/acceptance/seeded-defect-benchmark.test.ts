import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import { ApiProcessor, buildAcceptanceDefects } from '../../src/acceptance/api-processor.js';
import { applyTestCaseQualityGate } from '../../src/acceptance/test-case-quality-gate.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import {
  evaluateSeededDefectYield,
  type SeededDefectGroundTruth,
  type SeededDefectObservation,
} from '../../src/acceptance/test-design-quality-metrics.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';

const SEEDED_DEFECT_GROUND_TRUTH: SeededDefectGroundTruth[] = [
  { id: 'API-STATUS-CONTRACT', dimension: 'API', availability: 'EXECUTABLE' },
  { id: 'PERMISSION-BYPASS', dimension: 'PERMISSION', availability: 'EXECUTABLE' },
  { id: 'PARAMETER-MIN-BYPASS', dimension: 'PARAMETER', availability: 'EXECUTABLE' },
  { id: 'UI-DISABLED-MISSING', dimension: 'UI', availability: 'NOT_AVAILABLE' },
  { id: 'INVENTORY-ATOMICITY', dimension: 'BUSINESS_RULE', availability: 'NOT_AVAILABLE' },
];

interface BuggyService {
  baseUrl: string;
  requests: Array<{ method: string; path: string; authorization?: string }>;
  close(): Promise<void>;
}

async function startBuggyService(): Promise<BuggyService> {
  const requests: BuggyService['requests'] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: request.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
    });
    response.setHeader('content-type', 'application/json');
    // Deliberately seeded product defects, defined independently from generated Cases:
    // 1. /health violates its 200 contract with 201;
    // 2. cross-user document access returns 200 instead of 403;
    // 3. limit=0 is accepted instead of rejected with 400.
    if (url.pathname === '/health') {
      response.statusCode = 201;
      response.end(JSON.stringify({ status: 'created-instead-of-ok' }));
      return;
    }
    if (url.pathname === '/documents/bob-document') {
      response.statusCode = 200;
      response.end(JSON.stringify({ id: 'bob-document', secret: 'leaked' }));
      return;
    }
    if (url.pathname === '/search') {
      response.statusCode = 200;
      response.end(JSON.stringify({ acceptedLimit: url.searchParams.get('limit') }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not-found' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Buggy benchmark service did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function compile(markdown: string, documentId: string) {
  const requirement = parseAcceptanceRequirement(markdown, { documentId });
  const design = buildAcceptanceTestDesign(requirement);
  const points = generateTestPoints(requirement, design);
  const quality = applyTestCaseQualityGate({
    requirement,
    objectives: design.objectives,
    testCases: generateAcceptanceApiCases(requirement, points),
  });
  return { requirement, design, testCases: quality.testCases };
}

function expectedStatus(testCase: TestCase, status: number): boolean {
  return testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE' && assertion.expected === status);
}

describe('Independent Seeded Defect Yield benchmark', () => {
  it('discovers executable API, permission and parameter defects through real HTTP evidence', async () => {
    const service = await startBuggyService();
    try {
      const api = compile(`# Health
GET /health
该接口无需认证
返回 200
AC-1 GET /health 必须返回 200。`, 'seed-api.md');
      const apiCase = api.testCases.find((testCase) => testCase.executionMode === 'EXECUTABLE'
        && expectedStatus(testCase, 200));
      expect(apiCase).toBeDefined();

      const permission = compile(`# Document permission
GET /documents/{id}

| 参数 | 位置 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- | --- |
| id | path | string | 是 | bob-document |
| Authorization | header | string | 是 |

| 状态码 | 描述 |
| --- | --- |
| 200 | 查看成功 |
| 403 | 权限不足 |

## Actors
| Actor ID | 用户 ID | 角色 | Token Ref |
| --- | --- | --- | --- |
| alice | alice | USER | alice-token |
| bob | bob | USER | bob-token |

AC-1 alice 不得访问 bob 的文档，返回 403。`, 'seed-permission.md');
      const permissionCase = permission.testCases.find((testCase) => testCase.executionMode === 'EXECUTABLE'
        && testCase.actor?.id === 'alice'
        && testCase.data?.targetId === 'bob-document'
        && expectedStatus(testCase, 403));
      expect(permissionCase).toBeDefined();

      const parameter = compile(`# Search limit
GET /search
该接口无需认证

| 参数 | 位置 | 类型 | 必填 | 可空 | 最小值 | 最大值 |
| --- | --- | --- | --- | --- | --- | --- |
| limit | query | integer | 是 | 否 | 1 | 10 |

| 状态码 | 描述 |
| --- | --- |
| 200 | 查询成功 |
| 400 | 参数越界 |

AC-1 limit 必须是 1 到 10 的整数；合法值返回 200，越界值返回 400。`, 'seed-parameter.md');
      const parameterCase = parameter.testCases.find((testCase) => testCase.executionMode === 'EXECUTABLE'
        && (testCase.parameterContext?.boundaryVector === 'MIN_MINUS'
          || testCase.parameterCoverage?.some((coverage) => coverage.boundaryVectors.includes('MIN_MINUS')))
        && expectedStatus(testCase, 400));
      expect(parameterCase).toBeDefined();

      const ui = compile(`# Save UI
入口页面为 /profile。
AC-1 点击保存后按钮必须 disabled。`, 'seed-ui.md');
      const uiDesigned = ui.testCases.find((testCase) => testCase.testType === 'UI');
      expect(uiDesigned).toMatchObject({ executionMode: 'DESIGNED_ONLY' });

      const atomicity = compile(`# Order atomicity
POST /orders
该接口无需认证
返回 201
AC-1 订单创建和库存扣减必须原子完成。`, 'seed-atomicity.md');
      const atomicityDesigned = atomicity.testCases.find((testCase) => testCase.testType === 'BUSINESS_RULE');
      expect(atomicityDesigned).toMatchObject({ executionMode: 'DESIGNED_ONLY' });

      const processor = new ApiProcessor();
      const [apiResult, permissionResult, parameterResult] = await Promise.all([
        processor.execute(apiCase!, { baseUrl: service.baseUrl, apiSpecs: api.requirement.apis }),
        processor.execute(permissionCase!, {
          baseUrl: service.baseUrl,
          apiSpecs: permission.requirement.apis,
          actorHeaders: { 'alice-token': { Authorization: 'Bearer alice' } },
        }),
        processor.execute(parameterCase!, { baseUrl: service.baseUrl, apiSpecs: parameter.requirement.apis }),
      ]);

      for (const result of [apiResult, permissionResult, parameterResult]) {
        expect(result).toMatchObject({ executed: true, status: 'FAIL', pass: false, classification: 'PRODUCT_FAILURE' });
        expect(result.evidence.response).toBeDefined();
        expect(result.evidence.assertions.some((assertion) => assertion.pass === false)).toBe(true);
      }
      expect(service.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'GET', path: '/health' }),
        expect.objectContaining({ method: 'GET', path: '/documents/bob-document', authorization: 'Bearer alice' }),
        expect.objectContaining({ method: 'GET', path: '/search?limit=0' }),
      ]));
      const defects = buildAcceptanceDefects(
        [apiResult, permissionResult, parameterResult],
        'local-seeded-benchmark',
        { runId: 'RUN-SEEDED-DEFECTS', testCases: [apiCase!, permissionCase!, parameterCase!] },
      );
      expect(defects).toHaveLength(3);
      expect(defects.every((defect) => defect.classification === 'PRODUCT_DEFECT'
        && defect.source === 'acceptance-deterministic'
        && defect.expected.length > 0
        && defect.actual.length > 0
        && defect.factIds.length > 0
        && defect.objectiveIds.length > 0)).toBe(true);

      const observations: SeededDefectObservation[] = [
        { id: 'API-STATUS-CONTRACT', caseGenerated: true, executed: apiResult.executed === true, executionStatus: apiResult.status as 'FAIL', attribution: apiResult.classification },
        { id: 'PERMISSION-BYPASS', caseGenerated: true, executed: permissionResult.executed === true, executionStatus: permissionResult.status as 'FAIL', attribution: permissionResult.classification },
        { id: 'PARAMETER-MIN-BYPASS', caseGenerated: true, executed: parameterResult.executed === true, executionStatus: parameterResult.status as 'FAIL', attribution: parameterResult.classification },
        { id: 'UI-DISABLED-MISSING', caseGenerated: Boolean(uiDesigned), executed: false, executionStatus: 'NOT_AVAILABLE' },
        { id: 'INVENTORY-ATOMICITY', caseGenerated: Boolean(atomicityDesigned), executed: false, executionStatus: 'NOT_AVAILABLE' },
      ];
      const metrics = evaluateSeededDefectYield(SEEDED_DEFECT_GROUND_TRUTH, observations);
      expect(metrics).toMatchObject({
        totalSeeds: 5,
        executableSeeds: 3,
        designedSeeds: 5,
        executedSeeds: 3,
        detectedSeeds: 3,
        correctlyAttributedSeeds: 3,
        designCoverage: 1,
        executionCoverage: 1,
        defectYield: 1,
        attributionPrecision: 1,
        unavailableSeeds: ['UI-DISABLED-MISSING', 'INVENTORY-ATOMICITY'],
      });
    } finally {
      await service.close();
    }
  });

  it('does not inflate attribution precision with an UNCONFIRMED failure', () => {
    const metrics = evaluateSeededDefectYield(
      [{ id: 'uncertain-503', dimension: 'API', availability: 'EXECUTABLE' }],
      [{ id: 'uncertain-503', caseGenerated: true, executed: true, executionStatus: 'FAIL', attribution: 'UNCONFIRMED' }],
    );
    expect(metrics).toMatchObject({ defectYield: 1, correctlyAttributedSeeds: 0, attributionPrecision: 0 });
  });
});
