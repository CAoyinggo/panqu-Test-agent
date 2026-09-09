import { ApiProcessor, type AcceptanceCaseExecutionResult, type ApiProcessorOptions } from '../acceptance/api-processor.js';
import type { TestCase } from '../agents/test-design/testcase-schema.js';
import type { PanquProjectAssessment } from './panqu-project-types.js';

/** Client protocol contradictions are missing acceptance evidence, not independently proven product bugs. */
export class PanquProtocolProcessor extends ApiProcessor {
  constructor(private readonly assessment: PanquProjectAssessment, private readonly inner: ApiProcessor = new ApiProcessor()) { super(); }

  override async execute(testCase: TestCase, options: ApiProcessorOptions): Promise<AcceptanceCaseExecutionResult> {
    const result = await this.inner.execute(testCase, options);
    if (result.status !== 'PASS' || !result.executed) return result;
    // Explicit business-body expectations belong to the requirement oracle, including legitimate negative replies.
    if (testCase.assertions.some(assertion => assertion.path === 'code' || assertion.path === '$.code' || assertion.path === 'body.code')) return result;
    if (!testCase.assertions.some(assertion => assertion.type === 'STATUS_CODE' && Number(assertion.expected) >= 200 && Number(assertion.expected) < 300)) return result;
    const request = result.evidence.request; const response = result.evidence.response;
    if (!request || !response) return result;
    const pathname = new URL(request.url, options.baseUrl).pathname;
    const actions = this.assessment.relevantActions.filter(action => action.path === pathname && action.method === request.method);
    const conflicting = actions.filter(action => action.responseProtocol === 'PHP_CODE_1'
      ? !response.body || typeof response.body !== 'object' || (response.body as Record<string, unknown>).code !== 1
      : action.responseProtocol === 'GO_HTTP_200' && response.status !== 200);
    if (!conflicting.length) return result;
    const reason = 'PANQU_SOURCE_PROTOCOL_CONFLICT: transport assertions passed but the inspected client protocol rejects the response; acceptance remains unverified.';
    return { ...result, status: 'BLOCKED', pass: false, passRate: 0, classification: 'UNCONFIRMED', error: reason,
      blockedReason: { code: 'PANQU_SOURCE_PROTOCOL_CONFLICT', stage: 'GATE', message: reason, recoverable: true },
      attribution: { classification: 'UNCONFIRMED', confidence: 'HIGH', reason, evidenceSources: ['SOURCE_OBSERVATION_ONLY', 'HTTP_RESPONSE'] },
      evidence: { ...result.evidence, preflight: [...(result.evidence.preflight ?? []), ...conflicting.map(action => ({ kind: 'PANQU_CLIENT_PROTOCOL', ref: `${action.source.file}:${action.source.line}`, status: 'BLOCKED' as const, reason }))] } };
  }
}
