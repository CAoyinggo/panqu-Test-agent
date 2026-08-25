import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadScenarioAssetPack } from '../../src/acceptance/scenario-asset-loader.js';
import { parseScenarioMarkdown } from '../../src/acceptance/scenario-markdown-parser.js';

const templatePath = path.resolve('tests/acceptance/templates/scenario.md');
const referencePack = path.resolve('tests/acceptance/scenarios/generic/multi-api-operation-binding');
const temporaryDirectories: string[] = [];

function executableMarkdown(template: string): string {
  return template
    .replace('SCN-<domain>-<intent>', 'SCN-strict-parser-contract')
    .replace('- <按风险选择 PERSISTENCE / NON_MUTATION / IDEMPOTENCY / AUTHORIZATION / ...>', '- PERSISTENCE')
    .replace('- <环境、服务、Processor、Evidence Provider；无则写 NONE>', '- NONE');
}

async function referenceMarkdown(): Promise<string> {
  return executableMarkdown(await readFile(templatePath, 'utf8'));
}

async function expectedContract(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(referencePack, 'expected.json'), 'utf8')) as Record<string, unknown>;
}

async function createPack(expected: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'test-flow-scenario-strict-'));
  temporaryDirectories.push(directory);
  await copyFile(path.join(referencePack, 'requirement.md'), path.join(directory, 'requirement.md'));
  await writeFile(path.join(directory, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`, 'utf8');
  return directory;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Scenario Markdown strict schema', () => {
  it('rejects an unknown Evidence Kind instead of inferring one from Channel', async () => {
    const markdown = (await referenceMarkdown()).replace('| EV-001 | RESPONSE | RESPONSE |', '| EV-001 | MADE_UP_KIND | RESPONSE |');
    const parsed = parseScenarioMarkdown(markdown, { documentId: 'invalid-evidence.md' });

    expect(parsed.valid).toBe(false);
    expect(parsed.scenario.executionMode).toBe('BLOCKED');
    expect(parsed.issues).toContainEqual(expect.objectContaining({
      code: 'INVALID_EVIDENCE_KIND', severity: 'ERROR', section: 'Evidence',
    }));
    expect(parsed.scenario.evidenceRequirements.some((item) => (item.kind as string) === 'MADE_UP_KIND')).toBe(false);
    expect(parsed.scenario.blockedReasons).toContainEqual(expect.objectContaining({ code: 'MISSING_EVIDENCE', stage: 'PARSER' }));
  });

  it.each([
    ['unknown code', '| MADE_UP_BLOCK | DESIGN | true | invalid code |'],
    ['unknown stage', '| MISSING_TEST_DATA | MADE_UP_STAGE | true | invalid stage |'],
  ])('rejects Blocked Reason with %s', async (_name, row) => {
    const markdown = (await referenceMarkdown())
      .replace('## Execution Mode\n\nEXECUTABLE', '## Execution Mode\n\nBLOCKED')
      .replace('| NONE | DESIGN | false | - |', row);
    const parsed = parseScenarioMarkdown(markdown, { documentId: 'invalid-blocked-reason.md' });

    expect(parsed.valid).toBe(false);
    expect(parsed.scenario.executionMode).toBe('BLOCKED');
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'INVALID_BLOCKED_REASON', severity: 'ERROR' }));
    expect(parsed.scenario.blockedReasons).toContainEqual(expect.objectContaining({ code: 'INVALID_SCENARIO', stage: 'PARSER' }));
  });

  it('rejects a critical table whose canonical columns were renamed', async () => {
    const markdown = (await referenceMarkdown()).replace(
      '| Step | Channel | Processor | Method | Path | Request | Capture | AC | Evidence |',
      '| Step | Channel | Executor | Method | Path | Request | Capture | AC | Evidence |',
    );
    const parsed = parseScenarioMarkdown(markdown);

    expect(parsed.valid).toBe(false);
    expect(parsed.scenario.executionMode).toBe('BLOCKED');
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_TABLE', section: 'API Contract', message: expect.stringContaining('processor') }),
      expect.objectContaining({ code: 'INVALID_TABLE', section: 'API Contract', message: expect.stringContaining('executor') }),
    ]));
  });

  it('does not accept runtime-only terminal states in authored Scenario Markdown', async () => {
    const parsed = parseScenarioMarkdown((await referenceMarkdown()).replace(
      '## Execution Mode\n\nEXECUTABLE',
      '## Execution Mode\n\nTIMEOUT',
    ));

    expect(parsed.valid).toBe(false);
    expect(parsed.scenario.executionMode).toBe('BLOCKED');
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'INVALID_EXECUTION_MODE' }));
  });

  it('parses optional Prepare and Cleanup produces columns into canonical Hook variables', async () => {
    const markdown = (await referenceMarkdown())
      .replace(
        /## Prepare\n\n\| Hook \| Required \| Description \|\n\| --- \| --- \| --- \|\n\| prepare-resource \| true \| ([^\n]+) \|/,
        '## Prepare\n\n| Hook | Required | Produces | Description |\n| --- | --- | --- | --- |\n| prepare-resource | true | resourceId, ownerId | $1 |',
      )
      .replace(
        /## Cleanup\n\n\| Hook \| Required \| Description \|\n\| --- \| --- \| --- \|\n\| cleanup-resource \| true \| ([^\n]+) \|/,
        '## Cleanup\n\n| Hook | Required | Produces | Description |\n| --- | --- | --- | --- |\n| cleanup-resource | true | cleanupDigest | $1 |',
      );
    const parsed = parseScenarioMarkdown(markdown);

    expect(parsed.valid).toBe(true);
    expect(parsed.scenario.prepare[0]).toEqual(expect.objectContaining({ produces: ['resourceId', 'ownerId'] }));
    expect(parsed.scenario.cleanup[0]).toEqual(expect.objectContaining({ produces: ['cleanupDigest'] }));
  });
});

describe('Scenario expected.json strict runtime contract', () => {
  it('rejects an invalid BLOCKED Markdown document even when expected.json also declares BLOCKED', async () => {
    const expected = clone(await expectedContract());
    expected.mode = 'BLOCKED';
    const directory = await createPack(expected);
    const requirementPath = path.join(directory, 'requirement.md');
    const markdown = (await readFile(requirementPath, 'utf8'))
      .replace('| EV-001 | RESPONSE | RESPONSE |', '| EV-001 | MADE_UP_KIND | RESPONSE |');
    await writeFile(requirementPath, markdown, 'utf8');

    await expect(loadScenarioAssetPack(directory)).rejects.toThrow(/INVALID_SCENARIO_MARKDOWN.*INVALID_EVIDENCE_KIND/);
  });

  it.each([
    ['mode', (expected: Record<string, unknown>) => { expected.mode = 'DESIGNED_ONLY'; }],
    ['patterns', (expected: Record<string, unknown>) => { expected.patterns = [...expected.patterns as unknown[]].reverse(); }],
    ['operation semantics', (expected: Record<string, unknown>) => { (expected.operations as Array<Record<string, unknown>>)[0].method = 'PUT'; }],
    ['assertion semantics', (expected: Record<string, unknown>) => { (expected.assertions as Array<Record<string, unknown>>)[0].target = 'body.wrong'; }],
    ['required evidence set', (expected: Record<string, unknown>) => { expected.requiredEvidenceKinds = (expected.requiredEvidenceKinds as unknown[]).slice(1); }],
    ['blocked code set', (expected: Record<string, unknown>) => { expected.blockedCodes = ['POLICY_BLOCKED']; }],
  ])('rejects %s mismatch even when operation/assertion counts are unchanged', async (_name, mutate) => {
    const expected = clone(await expectedContract());
    mutate(expected);
    const directory = await createPack(expected);

    await expect(loadScenarioAssetPack(directory)).rejects.toThrow(/SCENARIO_EXPECTED_CONTRACT_MISMATCH/);
  });

  it.each([
    ['invalid evidence kind', (expected: Record<string, unknown>) => { expected.requiredEvidenceKinds = ['MADE_UP_KIND']; }],
    ['invalid blocked code', (expected: Record<string, unknown>) => { expected.blockedCodes = ['MADE_UP_BLOCK']; }],
    ['unknown top-level field', (expected: Record<string, unknown>) => { expected.uncontrolled = true; }],
    ['missing assertions', (expected: Record<string, unknown>) => { delete expected.assertions; }],
  ])('rejects expected.json schema with %s', async (_name, mutate) => {
    const expected = clone(await expectedContract());
    mutate(expected);
    const directory = await createPack(expected);

    await expect(loadScenarioAssetPack(directory)).rejects.toThrow(/INVALID_SCENARIO_EXPECTED.*EXPECTED_SCHEMA_INVALID/);
  });
});
