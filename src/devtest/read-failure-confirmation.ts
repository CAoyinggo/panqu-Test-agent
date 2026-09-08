import { isDeepStrictEqual } from 'node:util';
import { ApiProcessor, type AcceptanceCaseExecutionResult, type ApiProcessorOptions } from '../acceptance/api-processor.js';
import type { TestCase } from '../agents/test-design/testcase-schema.js';

/** Only a single read with HTTP-only evidence; never replay prepare/cleanup or a write flow. */
export function canConfirmReadFailure(testCase: TestCase): boolean {
  return testCase.steps.length === 1 && testCase.steps[0].type === 'HTTP_REQUEST'
    && ['GET', 'HEAD', 'OPTIONS'].includes(testCase.steps[0].method ?? '')
    && !(testCase.dependencies ?? []).some((item) => item.kind === 'LIFECYCLE')
    && (testCase.evidenceRequirements ?? []).every((item) => ['API_REQUEST', 'API_RESPONSE'].includes(item.channel));
}

function completeHttpResult(result: AcceptanceCaseExecutionResult): boolean {
  return result.executed === true && result.processorInvoked === true
    && result.evidence.transport?.responseCompleted === true
    && result.evidence.transport.outcome === 'CONFIRMED'
    && Boolean(result.evidence.request) && Boolean(result.evidence.response)
    && result.evidence.response!.status < 500 && !result.timedOut;
}

function failedFacts(result: AcceptanceCaseExecutionResult) {
  return result.evidence.assertions.filter((assertion) => !assertion.pass).map((assertion) => ({
    id: assertion.assertionId, type: assertion.type, path: assertion.path,
    expected: assertion.expected, actual: assertion.actual,
  }));
}

/** Bounded automatic reproduction for DevTest's built-in HTTP processor only. */
export class ReadFailureConfirmingProcessor extends ApiProcessor {
  override async execute(testCase: TestCase, options: ApiProcessorOptions): Promise<AcceptanceCaseExecutionResult> {
    const started = Date.now();
    const first = await super.execute(testCase, options);
    if (options.allowReadFailureConfirmation === false || !canConfirmReadFailure(testCase)
      || first.status !== 'FAIL' || !completeHttpResult(first) || !failedFacts(first).length
      || first.classification !== 'PRODUCT_FAILURE'
      || first.evidence.assertions.some((assertion) => !assertion.pass && assertion.actual === undefined
        && (first.evidence.response?.body === null || typeof first.evidence.response?.body !== 'object'))
      || options.signal?.aborted) return first;
    // Both observations share the original per-case budget and outer AbortSignal.
    const remaining = (options.timeoutMs ?? 5000) - (Date.now() - started);
    if (remaining <= 0) return first;
    const repeat = await super.execute(testCase, { ...options, timeoutMs: remaining });
    const complete = completeHttpResult(repeat) && ['PASS', 'FAIL'].includes(repeat.status ?? '');
    const same = complete && repeat.status === 'FAIL'
      && isDeepStrictEqual(first.evidence.request, repeat.evidence.request)
      && isDeepStrictEqual(failedFacts(first), failedFacts(repeat));
    return { ...first, durationMs: Date.now() - started, evidence: { ...first.evidence,
      readFailureConfirmation: {
        status: same ? 'REPRODUCED' : complete ? 'INCONSISTENT' : 'INCONCLUSIVE', attempts: 2,
        repeat: { status: repeat.status, executed: repeat.executed === true, durationMs: repeat.durationMs,
          error: repeat.error, request: repeat.evidence.request, response: repeat.evidence.response,
          transport: repeat.evidence.transport, assertions: repeat.evidence.assertions },
      },
    } };
  }
}
