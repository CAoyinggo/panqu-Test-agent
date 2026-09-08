import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { runAcceptancePipeline } from '../../src/acceptance/acceptance-pipeline.js';
import { ApiProcessor } from '../../src/acceptance/api-processor.js';
import { buildRequirementAssurance } from '../../src/acceptance/requirement-assurance.js';
import { localAcceptanceSafetyPolicy } from './helpers/acceptance-safety.js';

const markdown = '# 查询资源\n## API\nGET /resources\n无需认证。\n返回 200。\n## Acceptance Criteria\nAC-1 GET /resources 查询资源返回 HTTP 200。\n';
const options = { markdown, project: 'requirement-guard', documentId: 'guard.md', baseUrl: 'http://127.0.0.1:1', environment: 'local' };
async function model() { return runAcceptancePipeline({ ...options, mode: 'dry-run' }); }

describe('mandatory no-silent-requirement-gaps gate', () => {
  it('allows a complete explicit requirement to reach PASS only after real HTTP evidence', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => { requests.push(request.url!); response.end('{}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await runAcceptancePipeline({ ...options,
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        safetyPolicy: localAcceptanceSafetyPolicy(['GET /resources']) });
      expect(requests.length, JSON.stringify(result.results)).toBeGreaterThan(0);
      expect(result.requirementPreflight.status).toBe('READY');
      expect(result.report.requirementAssurance.status).toBe('PASS');
      expect(result.report.requirementAssurance.unresolvedIds).toEqual([]);
      // Other existing validation-stage checks remain authoritative; this gate cannot promote them.
      expect(result.results.every((execution) => execution.status === 'PASS')).toBe(true);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it.each([false, true])('blocks pending business expectations before processor and lifecycle (Scenario=%s)', async (scenario) => {
    const prepare = vi.fn(); const cleanup = vi.fn();
    const processor = new ApiProcessor();
    vi.spyOn(processor, 'execute').mockImplementation(async () => { throw new Error('MUST_NOT_EXECUTE'); });
    const result = await runAcceptancePipeline({ ...options,
      markdown: markdown.replace('查询资源返回 HTTP 200。', '查询资源返回 HTTP 200（待确认）。'),
      safetyPolicy: localAcceptanceSafetyPolicy(['GET /resources']),
      lifecycle: { prepare, cleanup }, processor,
      ...(scenario ? { scenarioRunnerOptions: { processors: [], environmentAvailable: true, policyAllowed: true } } : {}) });
    expect(result.requirementPreflight.status).toBe('BLOCKED');
    expect(result.requirementPreflight.entries.some((entry) => entry.status === 'NEEDS_CONFIRMATION' && entry.question)).toBe(true);
    expect(processor.execute).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
    expect(result.results.every((execution) => !execution.executed && execution.status === 'BLOCKED')).toBe(true);
    expect(result.report.conclusion).not.toBe('PASS');
  });

  it('retains a raw source line omitted by the parser even if every known case claims PASS', async () => {
    const result = await model();
    const input = { requirement: result.requirement, allTestCases: result.testCases,
      selectedCaseIds: result.testCases.map((testCase) => testCase.id) };
    const gate = buildRequirementAssurance({ ...input, markdown: `${markdown}不可丢失的新要求。\n`, observations: new Map() });
    const omitted = gate.entries.find((entry) => entry.id.startsWith('SOURCE-'))!;
    expect(omitted).toMatchObject({ statement: '不可丢失的新要求。', status: 'NOT_UNDERSTOOD', source: { line: 8 } });
    expect(gate.unresolvedIds).toContain(omitted.id);
    expect(gate.blockedCaseIds).toEqual(input.selectedCaseIds);
    expect(gate.status).toBe('BLOCKED');
  });

  it.each(['INFERRED', 'UNKNOWN'] as const)('does not verify a %s expectation even with purported PASS evidence', async (provenance) => {
    const result = await model();
    const fact = result.requirement.factLedger.find((item) => item.statement.includes('查询资源返回'))!;
    fact.provenance = provenance;
    const gate = buildRequirementAssurance({ requirement: result.requirement, allTestCases: result.testCases,
      selectedCaseIds: result.testCases.map((testCase) => testCase.id), observations: new Map(result.testCases.map((testCase) =>
        [testCase.id, { status: 'PASS', verified: true, verifiedFactIds: testCase.source!.factIds! }])) });
    expect(gate.entries.find((entry) => entry.id === fact.id)?.status).toBe('NEEDS_CONFIRMATION');
    expect(gate.status).toBe('BLOCKED');
  });

  it('keeps an uncovered fact when another fact in the same case has a valid assertion', async () => {
    const result = await model();
    const fact = result.requirement.factLedger.find((item) => item.statement.includes('查询资源返回'))!;
    for (const testCase of result.testCases) for (const assertion of testCase.assertions) {
      assertion.factIds = assertion.factIds?.filter((id) => id !== fact.id);
    }
    const gate = buildRequirementAssurance({ requirement: result.requirement, allTestCases: result.testCases,
      selectedCaseIds: result.testCases.map((testCase) => testCase.id) });
    expect(gate.entries.find((entry) => entry.id === fact.id)?.status).toBe('UNCOVERED');
    expect(gate.blockedCaseIds).toEqual([]); // Clear unrelated checks may still execute.
    expect(gate.status).toBe('BLOCKED');
  });

  it('does not borrow an unselected or baseline PASS to complete a filtered run', async () => {
    const result = await model();
    const first = result.testCases[0]; const second = { ...first, id: 'UNSELECTED' };
    const gate = buildRequirementAssurance({ requirement: result.requirement, allTestCases: [first, second],
      selectedCaseIds: [first.id], observations: new Map([first, second].map((testCase) =>
        [testCase.id, { status: 'PASS', verified: true, verifiedFactIds: testCase.source!.factIds!, bindingApiSpecId: testCase.source!.apiSpecId }])) });
    expect(gate.status).toBe('BLOCKED');
    expect(gate.entries.filter((entry) => entry.status !== 'CONTEXT').every((entry) => entry.status === 'NOT_TESTED')).toBe(true);
    expect(gate.entries.some((entry) => entry.caseIds.includes(second.id))).toBe(true);
  });

  it('retains genuine FAIL alongside an independently unresolved requirement', async () => {
    const result = await model();
    const fact = result.requirement.factLedger.find((item) => item.statement.includes('查询资源返回'))!;
    result.requirement.factLedger.push({ ...fact, id: 'UNCOVERED-RULE', statement: '其他要求必须保留。' });
    const gate = buildRequirementAssurance({ requirement: result.requirement, allTestCases: result.testCases,
      selectedCaseIds: result.testCases.map((testCase) => testCase.id), observations: new Map(result.testCases.map((testCase) =>
        [testCase.id, { status: 'FAIL', verified: true, verifiedFactIds: testCase.source!.factIds!, bindingApiSpecId: testCase.source!.apiSpecId }])) });
    expect(gate.status).toBe('FAIL'); expect(gate.unresolvedIds).toContain('UNCOVERED-RULE');
    expect(gate.entries.find((entry) => entry.id === fact.id)?.status).toBe('FAIL');
  });

  it('does not count pending headings as product obligations or context as PASS', async () => {
    const result = await runAcceptancePipeline({ ...options, markdown: `${markdown}\n## 待确认问题\n`, mode: 'dry-run' });
    expect(result.requirementPreflight.entries.find((entry) => entry.statement === '待确认问题')?.status).toBe('CONTEXT');
    expect(result.requirementPreflight.entries.some((entry) => entry.status === 'PASS')).toBe(false);
  });
});
