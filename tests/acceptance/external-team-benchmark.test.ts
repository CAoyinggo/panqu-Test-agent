import { describe, expect, it, vi } from 'vitest';
import { runAcceptanceCli } from '../../src/acceptance/acceptance-cli.js';
import { runAcceptancePipeline } from '../../src/acceptance/acceptance-pipeline.js';
import { buildAcceptanceReport, renderAcceptanceReportHtml, renderAcceptanceReportMarkdown } from '../../src/acceptance/acceptance-report.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { localAcceptanceSafetyPolicy } from './helpers/acceptance-safety.js';
import { startFakeApiServer } from './helpers/fake-api-server.js';

function compile(markdown: string) {
  const requirement = parseAcceptanceRequirement(markdown, { documentId: 'external-ground-truth.md' });
  const testPoints = generateTestPoints(requirement);
  const testCases = generateAcceptanceApiCases(requirement, testPoints);
  return { requirement, testPoints, testCases };
}

function blockingCodes(markdown: string): string[] {
  return compile(markdown).requirement.warnings.filter((warning) => warning.blocking).map((warning) => warning.code);
}

// 这是内部构造的 external-style 对抗回归，不是外部团队双盲 Ground Truth 结果。
describe('Internal adversarial external-style regression', () => {
  it.each([
    {
      name: 'audit retention',
      fact: 'deletion must preserve audit records',
      markdown: '# Orders\nDELETE /orders/{id}\n无需认证\n返回 200\n删除后必须保留审计记录。\nAC-1 DELETE /orders/{id} 删除成功返回 200',
      code: 'UNVERIFIED_REQUIREMENT_FACT',
    },
    {
      name: 'state transition',
      fact: 'payment transitions pending to paid',
      markdown: '# Pay\nPOST /orders/{id}/pay\n无需认证\n返回 200\n支付成功后订单必须从待支付变为已支付。\nAC-1 POST /orders/{id}/pay 返回 200',
      code: 'UNVERIFIED_REQUIREMENT_FACT',
    },
    {
      name: 'external and billable side effect',
      fact: 'confirmation sends SMS and consumes points',
      markdown: '# Confirm\nPOST /orders/{id}/confirm\n无需认证\n返回 200\n确认订单后必须发送短信并扣除积分。\nAC-1 POST /orders/{id}/confirm 返回 200',
      code: 'UNVERIFIED_REQUIREMENT_FACT',
    },
    {
      name: 'prose parameter constraint',
      fact: 'cursor is optional and at most 64 chars',
      markdown: '# Query\nGET /orders\n无需认证\n返回 200\n列表支持一个名为 cursor 的可选游标，最长 64 个字符。\nAC-1 GET /orders 返回 200',
      code: 'UNPARSED_CONTRACT_HINT',
    },
  ])('does not silently omit $name', ({ markdown, code }) => {
    expect(blockingCodes(markdown)).toContain(code);
  });

  it('blocks duplicate AC definitions with different meaning', () => {
    const markdown = '# Conflict\nDELETE /orders/{id}\n无需认证\n返回 200、403\nAC-1 DELETE /orders/{id} 普通用户可以删除订单，返回 200\nAC-1 DELETE /orders/{id} 普通用户不能删除订单，返回 403';
    expect(blockingCodes(markdown)).toContain('REQUIREMENT_CONFLICT');
  });

  it('blocks opposing permission facts even when they use different AC ids', () => {
    const markdown = '# Conflict\nDELETE /orders/{id}\n无需认证\n返回 200、403\nAC-1 DELETE /orders/{id} 普通用户可以删除订单，返回 200\nAC-2 DELETE /orders/{id} 普通用户不能删除订单，返回 403';
    expect(blockingCodes(markdown)).toContain('REQUIREMENT_CONFLICT');
  });

  it('blocks conflicting parameter and authentication contracts', () => {
    const parameter = `# Parameter\nPOST /users\n无需认证\n| name | type | location | required |\n|---|---|---|---|\n| age | integer | body | yes |\n| age | string | body | no |\n返回 201\nAC-1 POST /users 返回 201`;
    const auth = `# Auth\nGET /profile\n该接口无需认证\n| name | type | location | required |\n|---|---|---|---|\n| Authorization | string | header | yes |\n## Actors\n| Actor ID | Role | Token Ref |\n|---|---|---|\n| user-a | USER | user-a |\n返回 200\nAC-1 GET /profile 返回 200`;
    expect(blockingCodes(parameter)).toContain('REQUIREMENT_CONFLICT');
    expect(blockingCodes(auth)).toContain('REQUIREMENT_CONFLICT');
  });

  it('never rewrites an expired-token requirement into an anonymous 401 request', () => {
    const { testCases } = compile(`# Expired token\nGET /profile\n| name | type | location | required |\n|---|---|---|---|\n| Authorization | string | header | yes |\n## Actors\n| Actor ID | Role | Token Ref |\n|---|---|---|\n| user-a | USER | user-a |\n返回 200、401\nAC-1 GET /profile expired token 返回 401`);
    const linked = testCases.filter((testCase) => testCase.source?.acceptanceCriteriaIds.includes('AC-1'));
    const expired = linked.find((testCase) => String(testCase.metadata?.reason).includes('AUTH_SCENARIO_UNSUPPORTED'));
    expect(expired).toMatchObject({
      executionMode: 'DESIGNED_ONLY',
      metadata: { reason: expect.stringContaining('AUTH_SCENARIO_UNSUPPORTED') },
    });
    expect(expired?.steps.length).toBeGreaterThan(0);
    expect(expired?.steps.every((step) => step.execution === 'PLANNED')).toBe(true);
    expect(linked.some((testCase) => testCase.executionMode === 'EXECUTABLE' && testCase.actor === undefined)).toBe(false);
  });

  it('does not invent an authorization scenario from a bare 403', () => {
    const { testCases } = compile('# Forbidden\nGET /orders/{id}\n无需认证\n返回 403\nAC-1 GET /orders/{id} 返回 403');
    expect(testCases.find((testCase) => String(testCase.metadata?.reason).includes('AUTH_SCENARIO_AMBIGUOUS'))).toMatchObject({
      executionMode: 'DESIGNED_ONLY',
      metadata: { reason: expect.stringContaining('AUTH_SCENARIO_AMBIGUOUS') },
    });
  });

  it('does not invent a missing resource from a bare 404', () => {
    const { testCases } = compile('# Missing\nGET /orders/{id}\n无需认证\n返回 404\nAC-1 GET /orders/{id} 返回 404');
    expect(testCases.find((testCase) => String(testCase.metadata?.reason).includes('ERROR_SCENARIO_UNSUPPORTED'))).toMatchObject({
      executionMode: 'DESIGNED_ONLY',
      metadata: { reason: expect.stringContaining('ERROR_SCENARIO_UNSUPPORTED') },
    });
  });

  it('makes fenced request schema loss visible instead of executing an empty body', () => {
    const markdown = `# JSON schema
POST /orders
无需认证
\`\`\`json
{"type":"object","properties":{"amount":{"type":"number"}},"required":["amount"]}
\`\`\`
返回 201
AC-1 POST /orders 返回 201`;
    expect(blockingCodes(markdown)).toContain('UNPARSED_CONTRACT_HINT');
  });

  it('does not invent HTTP 400 for a negative parameter requirement that only declares success 200', () => {
    const { testCases } = compile(`# Parameter status
POST /users
无需认证
| name | type | location | required |
|---|---|---|---|
| name | string | body | yes |
返回 200
AC-1 name 类型错误时应拒绝`);
    const linked = testCases.filter((testCase) => testCase.source?.acceptanceCriteriaIds.includes('AC-1'));
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(linked.some((testCase) => testCase.assertions.some((assertion) =>
      assertion.type === 'STATUS_CODE' && assertion.expected === 400))).toBe(false);
    expect(linked.some((testCase) => /(?:EXPECTED_STATUS_UNRESOLVED|BINDING_INCOMPLETE)/
      .test(String(testCase.metadata?.reason)))).toBe(true);
  });

  it('does not treat an authorization bypass 200 as the expected result of a deny requirement', () => {
    const { testCases } = compile(`# Permission deny
DELETE /users/{id}
无需认证
返回 200
普通用户无权限删除其他用户。
AC-1 普通用户无权限删除其他用户，应该拒绝`);
    const denyCases = testCases.filter((testCase) => testCase.source?.acceptanceCriteriaIds.includes('AC-1'));
    expect(denyCases.length).toBeGreaterThan(0);
    expect(denyCases.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(denyCases.every((testCase) => testCase.steps.length > 0
      && testCase.steps.every((step) => step.execution === 'PLANNED'))).toBe(true);
    expect(denyCases.some((testCase) => testCase.assertions.some((assertion) =>
      assertion.type === 'STATUS_CODE' && assertion.expected === 200))).toBe(false);
  });

  it('does not include English sentence punctuation in the Operation path', () => {
    const { requirement } = compile('# English\nThe endpoint is GET /orders/{id}.\nIt is a public endpoint.\nAC-1 GET /orders/{id} returns 200');
    expect(requirement.apis[0].path).toBe('/orders/{id}');
  });

  it('does not treat a three-digit Path segment as the expected HTTP status', () => {
    const { requirement, testCases } = compile('# Status path\nGET /status/200\n该接口无需认证\n返回 201\nAC-1 GET /status/200 返回 201');
    expect(requirement.apis[0].responses.map((response) => response.status)).toEqual([201]);
    expect(testCases[0].assertions).toContainEqual(expect.objectContaining({ type: 'STATUS_CODE', expected: 201 }));
  });

  it('blocks a vague response business rule instead of inventing a data.id assertion', () => {
    const markdown = '# Orders\nGET /orders\n该接口无需认证\n返回 200\n## Business Rules\n- 响应必须包含数据字段。\n## Acceptance Criteria\nAC-1 GET /orders 查询成功返回 200';
    const { requirement, testCases } = compile(markdown);
    expect(requirement.warnings).toContainEqual(expect.objectContaining({ code: 'UNMAPPED_REQUIREMENT_RULE', blocking: true }));
    expect(testCases[0].assertions).toEqual([expect.objectContaining({ type: 'STATUS_CODE', expected: 200 })]);
    expect(testCases[0].assertions).not.toContainEqual(expect.objectContaining({ path: 'data.id' }));
  });

  it('executes the independently verifiable sibling and keeps the unsupported sibling NOT_EXECUTED', async () => {
    const server = await startFakeApiServer();
    const lifecycle = { prepare: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined) };
    try {
      const execution = await runAcceptancePipeline({
        project: 'external', baseUrl: server.baseUrl, lifecycle,
        environment: 'local', safetyPolicy: localAcceptanceSafetyPolicy(['GET /status/200']),
        markdown: '# Conflict\nGET /status/200\n无需认证\n返回 200、409\nAC-1 GET /status/200 查询成功返回 200\nAC-2 GET /status/200 冲突返回 409',
      });
      expect(execution.testCases.some((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
      expect(execution.results.some((result) => result.executed === true && result.status === 'PASS')).toBe(true);
      expect(execution.results.some((result) => result.executed === false && result.status === 'NOT_EXECUTED')).toBe(true);
      expect(execution.results.every((result) => result.pass === (result.executed && result.status === 'PASS'))).toBe(true);
      expect(execution.report.conclusion).toBe('PARTIAL');
      expect(lifecycle.prepare).toHaveBeenCalledOnce();
      expect(lifecycle.cleanup).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it('rejects a production-like target mislabeled as local before any request', async () => {
    await expect(runAcceptanceCli([
      '--text', '# Health\nGET /health\n无需认证\n返回 200\nAC-1 GET /health 返回 200',
      '--output', '/tmp/acceptance-never-written', '--project', 'external', '--environment', 'local',
      '--mode', 'execute', '--base-url', 'https://prod-api.example.com',
    ], {})).rejects.toThrow('ENVIRONMENT_TARGET_MISMATCH');
  });

  it('requires an explicit operation safety classification before a mutation', async () => {
    await expect(runAcceptanceCli([
      '--text', '# Create\nPOST /orders\n无需认证\n返回 201\nAC-1 POST /orders 返回 201',
      '--output', '/tmp/acceptance-never-written', '--project', 'external', '--environment', 'local',
      '--mode', 'execute', '--base-url', 'http://127.0.0.1:1',
    ], {})).rejects.toThrow('OPERATION_POLICY_REQUIRED');
  });

  it('treats cleanup failure as an incomplete run, never a successful exit outcome', async () => {
    const server = await startFakeApiServer();
    try {
      const execution = await runAcceptancePipeline({
        project: 'external', environment: 'local', baseUrl: server.baseUrl,
        safetyPolicy: localAcceptanceSafetyPolicy(['GET /status/200']),
        markdown: '# Cleanup\nGET /status/200\n该接口无需认证\n返回 200\nAC-1 GET /status/200 返回 200',
        lifecycle: {
          prepare: async () => undefined,
          cleanup: async () => { throw new Error('cleanup fixture failure'); },
        },
      });
      expect(execution.results[0]).toMatchObject({ status: 'PASS', executed: true });
      expect(execution.report).toMatchObject({ conclusion: 'BLOCKED', summary: { passed: 1 } });
      expect(execution.report.risks).toContainEqual(expect.objectContaining({
        status: 'CLEANUP_FAILED', classification: 'DATA_LIFECYCLE',
      }));
      expect(execution.outcome).toMatchObject({ executed: false, passRate: 0 });
      expect(execution.outcome.summary).toContain('DATA_LIFECYCLE_INCOMPLETE');
    } finally {
      await server.close();
    }
  });

  it('makes Operation Contract PASS distinct from complete Requirement verification in every human report', () => {
    const { requirement, testPoints, testCases } = compile('# Health\nGET /health\n无需认证\n返回 200\nAC-1 GET /health 返回 200');
    const report = buildAcceptanceReport({
      project: 'external', requirement, testPoints, testCases, defects: [],
      results: testCases.map((testCase) => ({
        caseId: testCase.id, name: testCase.name, feature: testCase.feature, scene: 'api', priority: testCase.priority, tags: testCase.tags,
        executed: true, processorInvoked: true, status: 'PASS', pass: true, passRate: 100, classification: 'SUCCESS',
        attribution: { classification: 'SUCCESS', confidence: 'HIGH', reason: 'fixture', evidenceSources: ['HTTP_RESPONSE'] },
        evidence: {
          requirementId: requirement.id, acceptanceCriteriaIds: ['AC-1'], testPointId: testPoints[0].id,
          binding: { valid: true, apiSpecId: requirement.apis[0].id, operationKey: requirement.apis[0].operationKey },
          request: { method: 'GET', url: 'http://127.0.0.1/health', headers: {}, pathParams: {}, query: {} },
          response: { status: 200, headers: {}, body: null },
          assertions: [{ type: 'STATUS_CODE', expected: 200, actual: 200, pass: true, detail: 'fixture' }],
          evidenceItems: [],
        },
      })),
    });
    expect(report.trust).toMatchObject({ resultScope: 'OPERATION_CONTRACT', requirementVerification: 'NOT_VERIFIED' });
    for (const rendered of [renderAcceptanceReportMarkdown(report), renderAcceptanceReportHtml(report)]) {
      expect(rendered).toContain('Operation Contract');
      expect(rendered).toContain('NOT_VERIFIED');
      expect(rendered).not.toMatch(/<strong>结论：PASS<\/strong>/);
    }
  });
});
