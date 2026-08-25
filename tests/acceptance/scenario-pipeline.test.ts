import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { runScenarioAssetPipeline, runScenarioPipeline } from '../../src/acceptance/scenario-pipeline.js';
import type { ScenarioProcessor } from '../../src/acceptance/scenario-runner.js';

const markdown = `# Scenario

## Scenario ID

SCN-PIPELINE-READ

## Requirement

- Source: controlled contract
- Intent: 读取资源时返回确定性业务状态。

## Acceptance Criteria

### AC-001

GET /resources/r-1 返回 HTTP 200。

## Priority

P0

## Patterns

- FUNCTIONAL
- API_CONTRACT

## Actor

- Type: ANONYMOUS
- ID: anonymous

## Role

NOT_APPLICABLE

## Tenant

- ID: NOT_APPLICABLE

## Project

- ID: NOT_APPLICABLE

## Authentication

- Type: NONE
- Reference: NOT_APPLICABLE

## Preconditions

| ID | Condition | Evidence Channel |
| --- | --- | --- |
| PRE-001 | controlled resource exists | API |

## Test Data

| ID | Owner | Value | Source |
| --- | --- | --- | --- |
| DATA-001 | anonymous | {"id":"r-1"} | FIXTURE |

## API Contract

| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-001 | API | memory-api | GET | /resources/r-1 | - | - | AC-001 | EV-001 |

## Execution Steps

1. STEP-001：读取资源。

## Expected Response

- HTTP 200。

## Expected State

- NOT_APPLICABLE

## Expected Side Effects

- NOT_APPLICABLE

## Assertions

| ID | AC | Step | Channel | Target | Operator | Expected | Expected From |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AS-001 | AC-001 | STEP-001 | RESPONSE | status | EQUALS | 200 | - |

## Evidence

| ID | Kind | Channel | Source Step | Assertions | Description |
| --- | --- | --- | --- | --- | --- |
| EV-000 | REQUEST | API | STEP-001 | AS-001 | actual anonymous request |
| EV-001 | RESPONSE | RESPONSE | STEP-001 | AS-001 | actual response |

## Prepare

| Hook | Required | Description |
| --- | --- | --- |
| NONE | false | - |

## Cleanup

| Hook | Required | Description |
| --- | --- | --- |
| NONE | false | - |

## Execution Mode

EXECUTABLE

## Blocked Reason

| Code | Stage | Recoverable | Message |
| --- | --- | --- | --- |
| NONE | DESIGN | false | - |

## Risk

- NONE

## Dependencies

- NONE
`;

function memoryProcessor(execute = vi.fn<ScenarioProcessor['execute']>(async (operation, context) => {
  const response = { status: 200, body: { id: 'r-1' } };
  return {
    status: 'PASS', executed: true, output: response,
    evidence: [
      {
        id: 'EV-000', requirementId: 'EV-000', scenarioId: context.scenario.id, operationId: operation.id,
        acceptanceCriteriaIds: operation.acceptanceCriteriaIds, kind: 'REQUEST', channel: 'API',
        source: 'controlled-memory-api', observedAt: new Date().toISOString(),
        data: { method: operation.method, path: operation.path, actor: 'anonymous' }, verified: true,
      },
      {
        id: 'EV-001', requirementId: 'EV-001', scenarioId: context.scenario.id, operationId: operation.id,
        acceptanceCriteriaIds: operation.acceptanceCriteriaIds, kind: 'RESPONSE', channel: 'RESPONSE',
        source: 'controlled-memory-api', observedAt: new Date().toISOString(), data: response, verified: true,
      },
    ],
  };
})): ScenarioProcessor {
  return { name: 'memory-api', supportsAbort: true, supportedEvidenceKinds: ['REQUEST', 'RESPONSE'], supports: () => true, execute };
}

describe('Scenario asset main pipeline', () => {
  it('closes Markdown → Scenario → Pattern → Gate → Processor → Assertion → Evidence → Report', async () => {
    const processor = memoryProcessor();
    const result = await runScenarioPipeline({
      markdown, documentId: 'pipeline-scenario.md', domain: 'generic', processors: [processor],
      environmentAvailable: true, policyAllowed: true,
    });

    expect(result.parse.valid).toBe(true);
    expect(result.scenario.patternIds).toEqual(expect.arrayContaining(['FUNCTIONAL', 'API_CONTRACT']));
    expect(result.run.gate.allowed).toBe(true);
    expect(result.report.result).toMatchObject({
      status: 'PASS', executed: true, processorInvoked: true,
      assertions: 1, passedAssertions: 1, failedAssertions: 0,
    });
    expect(result.report.trace[0]).toMatchObject({
      acceptanceCriterionId: 'AC-001', scenarioId: 'SCN-PIPELINE-READ',
      operationIds: ['STEP-001'], assertionIds: ['AS-001'], status: 'PASS',
    });
    expect(result.report.coverage).toEqual({
      requirementCoverage: 100, scenarioCoverage: 100, executableCoverage: 100, assertionCoverage: 100, evidenceCoverage: 100,
    });
  });

  it('applies Policy before any Processor call', async () => {
    const execute = vi.fn<ScenarioProcessor['execute']>();
    const result = await runScenarioPipeline({
      markdown, processors: [memoryProcessor(execute)], environmentAvailable: true, policyAllowed: false,
    });
    expect(result.report.result).toMatchObject({ status: 'BLOCKED', executed: false, processorInvoked: false });
    expect(result.report.blockedReasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'POLICY_BLOCKED' })]));
    expect(execute).not.toHaveBeenCalled();
  });

  it('loads a persisted Scenario Pack through expected-contract validation before the main pipeline', async () => {
    const result = await runScenarioAssetPipeline({
      directory: path.resolve('tests/acceptance/scenarios/safety/false-pass-policy-block'),
      processors: [], environmentAvailable: true, policyAllowed: true,
    });
    expect(result.asset.expected.scenarioId).toBe('SCN-safety-false-pass-policy-block');
    expect(result.parse.valid).toBe(true);
    expect(result.report.result).toMatchObject({ status: 'BLOCKED', executed: false, processorInvoked: false });
    expect(result.report.blockedReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'POLICY_BLOCKED' }),
    ]));
  });
});
