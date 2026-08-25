import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { selectTestPatterns } from '../../src/acceptance/test-pattern-registry.js';

describe('structured Test Pattern selection', () => {
  it('selects functional, persistence, authorization, isolation and boundary proof obligations from canonical facts', async () => {
    const markdown = await readFile(new URL('./fixtures/user-profile.md', import.meta.url), 'utf8');
    const requirement = parseAcceptanceRequirement(markdown, { documentId: 'user-profile.md' });
    const patterns = selectTestPatterns(requirement);
    const ids = patterns.map((item) => item.id);

    expect(ids).toEqual(expect.arrayContaining([
      'FUNCTIONAL', 'API_CONTRACT', 'PERSISTENCE', 'NON_MUTATION', 'AUTHORIZATION', 'TENANT_ISOLATION', 'BOUNDARY',
    ]));
    expect(patterns.every((item) => item.factIds.length > 0 && item.reasons.length > 0)).toBe(true);
  });

  it('does not select a Pattern from keywords left only in raw statements', async () => {
    const markdown = await readFile(new URL('./fixtures/user-profile.md', import.meta.url), 'utf8');
    const requirement = parseAcceptanceRequirement(markdown);
    requirement.apis = [];
    requirement.factLedger = requirement.factLedger.map((fact) => ({
      ...fact,
      statement: `billing idempotency provider ${fact.statement}`,
      category: 'OTHER',
      entityRefs: { items: [], apiSpecIds: [], parameterNames: [] },
      canonical: {
        ...fact.canonical,
        action: { kind: 'UNKNOWN' },
        constraints: [],
        scopes: [],
        sideEffects: [],
      },
    }));
    const ids = selectTestPatterns(requirement).map((item) => item.id);
    expect(ids).not.toEqual(expect.arrayContaining(['BILLING', 'IDEMPOTENCY', 'PROVIDER_FAILURE']));
  });

  it('keeps explicit Pattern selection auditable and rejects unknown identifiers', async () => {
    const markdown = await readFile(new URL('./fixtures/user-profile.md', import.meta.url), 'utf8');
    const requirement = parseAcceptanceRequirement(markdown);
    expect(selectTestPatterns(requirement, ['AUDIT']).find((item) => item.id === 'AUDIT')).toMatchObject({ source: 'EXPLICIT' });
    expect(() => selectTestPatterns(requirement, ['UNKNOWN' as 'AUDIT'])).toThrow('UNKNOWN_TEST_PATTERN');
  });
});
