import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Scenario } from '../../src/acceptance/scenario-contract.js';
import {
  evaluateScenarioExecutability,
  type ScenarioExecutionCapabilities,
} from '../../src/acceptance/scenario-executability-gate.js';
import { parseScenarioMarkdown } from '../../src/acceptance/scenario-markdown-parser.js';
import {
  SCENARIO_QUALITY_DIMENSIONS,
  scoreScenarioQuality,
} from '../../src/acceptance/scenario-quality.js';
import { runScenario, type ScenarioProcessor } from '../../src/acceptance/scenario-runner.js';

const template = readFileSync(fileURLToPath(new URL('./templates/scenario.md', import.meta.url)), 'utf8');

function executableScenario(): Scenario {
  const markdown = template
    .replace('SCN-<domain>-<intent>', 'SCN-generic-persistence')
    .replace('- <按风险选择 PERSISTENCE / NON_MUTATION / IDEMPOTENCY / AUTHORIZATION / ...>', '- PERSISTENCE')
    .replace('- <环境、服务、Processor、Evidence Provider；无则写 NONE>', '- NONE');
  const parsed = parseScenarioMarkdown(markdown);
  if (!parsed.valid) throw new Error(`Invalid Scenario fixture: ${JSON.stringify(parsed.issues)}`);
  return parsed.scenario;
}

function capabilities(): ScenarioExecutionCapabilities {
  return {
    processors: new Set(['api']),
    evidenceKinds: new Set(['RESPONSE', 'STATE_AFTER']),
    prepareHooks: new Set(['prepare-resource']),
    cleanupHooks: new Set(['cleanup-resource']),
    availableDependencies: new Set(),
    executorAvailable: true,
    environmentAvailable: true,
    policyAllowed: true,
    supportsOperation: () => true,
  };
}

describe('Scenario Quality contract', () => {
  it.each(SCENARIO_QUALITY_DIMENSIONS)('scores the %s dimension exactly once', (dimension) => {
    const scenario = executableScenario();
    const gate = evaluateScenarioExecutability(scenario, capabilities());
    const quality = scoreScenarioQuality(scenario, gate);

    expect(SCENARIO_QUALITY_DIMENSIONS).toHaveLength(10);
    expect(quality.dimensions.filter((item) => item.dimension === dimension)).toHaveLength(1);
    expect(quality.dimensions.find((item) => item.dimension === dimension)?.score).toBe(10);
    expect(quality.dimensions.map((item) => item.dimension)).toEqual([...SCENARIO_QUALITY_DIMENSIONS]);
    expect(quality.dimensions.reduce((sum, item) => sum + item.score, 0)).toBe(quality.score);
    expect(quality).toMatchObject({ score: 100, maxScore: 100, grade: 'EXCELLENT' });
  });

  it('keeps a high-quality DESIGNED_ONLY Scenario as NOT_EXECUTED rather than PASS', async () => {
    const scenario = executableScenario();
    scenario.executionMode = 'DESIGNED_ONLY';
    const execute = vi.fn<ScenarioProcessor['execute']>(async () => ({
      status: 'PASS', executed: true, evidence: [],
    }));
    const processor: ScenarioProcessor = {
      name: 'api',
      supportsAbort: true,
      supportedEvidenceKinds: ['RESPONSE', 'STATE_AFTER'],
      supports: () => true,
      execute,
    };

    const outcome = await runScenario(scenario, {
      processors: [processor],
      environmentAvailable: true,
      policyAllowed: true,
    });
    const quality = scoreScenarioQuality(scenario, outcome.gate);

    expect(quality).toMatchObject({
      executionMode: 'DESIGNED_ONLY',
      grade: 'EXCELLENT',
    });
    expect(quality.score).toBeGreaterThanOrEqual(90);
    expect(quality.dimensions.find((item) => item.dimension === 'Executability')?.score).toBe(5);
    expect(outcome.gate).toMatchObject({ allowed: false, disposition: 'DESIGNED_ONLY' });
    expect(outcome.result).toMatchObject({
      status: 'NOT_EXECUTED', executed: false, processorInvoked: false,
    });
    expect(outcome.result.status).not.toBe('PASS');
    expect(execute).not.toHaveBeenCalled();
  });
});
