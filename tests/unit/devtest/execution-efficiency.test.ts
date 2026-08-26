import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';
import { ApiProcessor, runAcceptanceApiCases, type AcceptanceCaseExecutionResult } from '../../../src/acceptance/api-processor.js';

function httpCase(id: string, method: 'GET' | 'POST', priority: TestCase['priority'] = 'P1'): TestCase {
  return {
    id, feature: '并发安全', name: id, priority, testType: 'API', executionMode: 'EXECUTABLE', protocol: 'HTTP', tags: [],
    steps: [{ type: 'HTTP_REQUEST', method, url: '/api/items' }], assertions: [{ type: 'STATUS_CODE', expected: 200 }],
  } as TestCase;
}

function execution(testCase: TestCase, status: 'PASS' | 'FAIL'): AcceptanceCaseExecutionResult {
  return {
    caseId: testCase.id, name: testCase.name, feature: testCase.feature, priority: testCase.priority, tags: [], scene: 'api',
    timestamp: new Date().toISOString(), pass: status === 'PASS', passRate: status === 'PASS' ? 1 : 0,
    executed: true, processorInvoked: true, processor: 'TrackingProcessor', status,
    assertions: 1, passedAssertions: status === 'PASS' ? 1 : 0, failedAssertions: status === 'FAIL' ? 1 : 0,
    classification: status === 'PASS' ? 'SUCCESS' : 'PRODUCT_FAILURE',
    attribution: { classification: status === 'PASS' ? 'SUCCESS' : 'PRODUCT_FAILURE', confidence: 'HIGH', reason: 'test', evidenceSources: ['TEST'] },
    evidence: { acceptanceCriteriaIds: [], request: { method: 'GET', url: '/api/items', headers: {}, pathParams: {}, query: {} },
      response: { status: status === 'PASS' ? 200 : 500, headers: {}, body: {} }, assertions: [{ type: 'STATUS_CODE', expected: 200,
        actual: status === 'PASS' ? 200 : 500, pass: status === 'PASS', detail: status }], evidenceItems: [] },
  };
}

class TrackingProcessor extends ApiProcessor {
  active = 0;
  maxActive = 0;
  invoked: string[] = [];
  constructor(private readonly failId?: string) { super(); }
  override async execute(testCase: TestCase): Promise<AcceptanceCaseExecutionResult> {
    this.invoked.push(testCase.id);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.active -= 1;
    return execution(testCase, testCase.id === this.failId ? 'FAIL' : 'PASS');
  }
}

describe('DevTest execution efficiency and safety', () => {
  it('互不依赖的只读 Case 并发执行', async () => {
    const processor = new TrackingProcessor();
    await runAcceptanceApiCases([httpCase('R1', 'GET'), httpCase('R2', 'GET'), httpCase('R3', 'GET')], {
      baseUrl: 'http://127.0.0.1:1', processor, concurrency: 3,
    });
    expect(processor.maxActive).toBe(3);
  });

  it('共享写操作即使配置并发也强制串行', async () => {
    const processor = new TrackingProcessor();
    await runAcceptanceApiCases([httpCase('W1', 'POST'), httpCase('W2', 'POST')], {
      baseUrl: 'http://127.0.0.1:1', processor, concurrency: 3,
    });
    expect(processor.maxActive).toBe(1);
  });

  it('P0 真实失败后 fail-fast 取消后续 Case', async () => {
    const processor = new TrackingProcessor('P0-FAIL');
    const run = await runAcceptanceApiCases([httpCase('P0-FAIL', 'POST', 'P0'), httpCase('NEXT', 'POST')], {
      baseUrl: 'http://127.0.0.1:1', processor, concurrency: 2, failFast: true,
    });
    expect(processor.invoked).toEqual(['P0-FAIL']);
    expect(run.results[1]).toEqual(expect.objectContaining({ status: 'CANCELLED', executed: false }));
    expect(run.results[1].error).toContain('FAIL_FAST_P0');
  });
});
