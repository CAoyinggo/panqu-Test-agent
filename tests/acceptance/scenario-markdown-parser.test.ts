import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseScenarioMarkdown } from '../../src/acceptance/scenario-markdown-parser.js';
import { materializeScenarioTemplate } from './helpers/scenario-template.js';

const template = readFileSync(fileURLToPath(new URL('./templates/scenario.md', import.meta.url)), 'utf8');

function executableMarkdown(): string {
  return materializeScenarioTemplate(template);
}

describe('Scenario Markdown Parser contract', () => {
  it('compiles a complete Markdown asset into a canonical executable Scenario', () => {
    const parsed = parseScenarioMarkdown(executableMarkdown(), {
      documentId: 'tests/acceptance/templates/scenario.md',
      domain: 'generic',
    });

    expect(parsed.valid).toBe(true);
    expect(parsed.issues).toEqual([]);
    expect(parsed.scenario).toMatchObject({
      id: 'SCN-generic-persistence',
      domain: 'generic',
      acceptanceCriteriaIds: ['AC-001'],
      patternIds: ['FUNCTIONAL', 'PERSISTENCE'],
      executionMode: 'EXECUTABLE',
      blockedReasons: [],
    });
    expect(parsed.scenario.operations).toEqual([
      expect.objectContaining({ id: 'STEP-001', processor: 'api', method: 'POST', path: '/api/resources' }),
      expect.objectContaining({ id: 'STEP-002', processor: 'api', method: 'GET', path: '/api/resources/${STEP-001.resourceId}' }),
    ]);
    expect(parsed.scenario.assertions).toEqual([
      expect.objectContaining({ id: 'AS-001', operationId: 'STEP-001', evidenceRequirementIds: ['EV-001'] }),
      expect.objectContaining({ id: 'AS-002', operationId: 'STEP-002', evidenceRequirementIds: ['EV-002'] }),
    ]);
    expect(parsed.scenario.evidenceRequirements).toEqual([
      expect.objectContaining({ id: 'EV-001', kind: 'RESPONSE', sourceRef: 'STEP-001' }),
      expect.objectContaining({ id: 'EV-002', kind: 'STATE_AFTER', sourceRef: 'STEP-002' }),
    ]);
  });

  it.each([
    {
      name: 'Acceptance Criteria 缺失',
      issueCode: 'MISSING_ACCEPTANCE_CRITERIA',
      blockedCode: 'MISSING_ACCEPTANCE_CRITERIA',
      mutate: (markdown: string) => markdown.replace(
        /## Acceptance Criteria\n[\s\S]*?(?=\n## Priority)/,
        '## Acceptance Criteria\n',
      ),
    },
    {
      name: 'API Method 缺失',
      issueCode: 'MISSING_METHOD',
      blockedCode: 'MISSING_METHOD',
      mutate: (markdown: string) => markdown.replace(
        '| STEP-001 | API | api | POST | /api/resources |',
        '| STEP-001 | API | api | - | /api/resources |',
      ),
    },
    {
      name: 'API Path 缺失',
      issueCode: 'MISSING_PATH',
      blockedCode: 'MISSING_PATH',
      mutate: (markdown: string) => markdown.replace(
        '| STEP-001 | API | api | POST | /api/resources |',
        '| STEP-001 | API | api | POST | - |',
      ),
    },
    {
      name: '业务 Assertion 缺失',
      issueCode: 'MISSING_ASSERTION',
      blockedCode: 'MISSING_ASSERTION',
      mutate: (markdown: string) => markdown.replace(
        /## Assertions\n[\s\S]*?(?=\n## Evidence)/,
        '## Assertions\n',
      ),
    },
  ] as const)('$name 时 fail-closed 为 BLOCKED', ({ mutate, issueCode, blockedCode }) => {
    const parsed = parseScenarioMarkdown(mutate(executableMarkdown()), { documentId: 'invalid-scenario.md' });

    expect(parsed.valid).toBe(false);
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: issueCode, severity: 'ERROR' }),
    ]));
    expect(parsed.scenario.executionMode).toBe('BLOCKED');
    expect(parsed.scenario.blockedReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: blockedCode, stage: 'PARSER' }),
    ]));
  });

  it.each([
    {
      mode: 'BLOCKED',
      blockedReasonRow: '| MISSING_TEST_DATA | DESIGN | true | fixture unavailable |',
      expectedReasons: [expect.objectContaining({
        code: 'MISSING_TEST_DATA', stage: 'DESIGN', recoverable: true, message: 'fixture unavailable',
      })],
    },
    {
      mode: 'DESIGNED_ONLY',
      blockedReasonRow: '| NONE | DESIGN | false | - |',
      expectedReasons: [],
    },
  ] as const)('preserves the explicitly declared $mode lifecycle mode', ({ mode, blockedReasonRow, expectedReasons }) => {
    const markdown = executableMarkdown()
      .replace('## Execution Mode\n\nEXECUTABLE', `## Execution Mode\n\n${mode}`)
      .replace('| NONE | DESIGN | false | - |', blockedReasonRow);
    const parsed = parseScenarioMarkdown(markdown);

    expect(parsed.valid).toBe(true);
    expect(parsed.scenario.executionMode).toBe(mode);
    expect(parsed.scenario.blockedReasons).toEqual(expectedReasons);
  });
});
