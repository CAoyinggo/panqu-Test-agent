import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverScenarioAssetPacks } from '../../src/acceptance/scenario-asset-loader.js';
import type { ScenarioEvidenceKind } from '../../src/acceptance/scenario-contract.js';
import { evaluateScenarioExecutability } from '../../src/acceptance/scenario-executability-gate.js';

const assetRoot = path.resolve('tests/acceptance/scenarios');

describe('canonical Markdown Scenario asset registry', () => {
  it('discovers exactly the first 10 high-value packs with independent expected contracts', async () => {
    const packs = await discoverScenarioAssetPacks(assetRoot);
    expect(packs).toHaveLength(10);
    expect(new Set(packs.map((pack) => pack.parse.scenario.id)).size).toBe(10);

    for (const pack of packs) {
      const scenario = pack.parse.scenario;
      expect(pack.expected.scenarioId).toBe(scenario.id);
      expect(pack.expected.mode).toBe(scenario.executionMode);
      expect(pack.expected.patterns).toEqual(scenario.patternIds);
      expect(pack.expected.operations).toHaveLength(scenario.operations.length);
      expect(pack.expected.assertions).toHaveLength(scenario.assertions.length);
      expect(pack.configExample).toMatchObject({ scenarioId: scenario.id, realExecution: false });
      if (pack.expected.mode === 'EXECUTABLE') {
        expect(pack.serverScenarioPath).toBe(path.join(pack.directory, 'server-scenario.ts'));
      } else {
        expect(pack.serverScenarioPath).toBeUndefined();
      }

      const declaredKinds = new Set(scenario.evidenceRequirements.map((evidence) => evidence.kind));
      expect(pack.expected.requiredEvidenceKinds?.every((kind) => declaredKinds.has(kind as ScenarioEvidenceKind))).toBe(true);
      const blockedCodes = new Set<string>(scenario.blockedReasons.map((reason) => reason.code));
      expect(pack.expected.blockedCodes?.every((code) => blockedCodes.has(code))).toBe(true);
    }
  });

  it('keeps 4 controlled fixture assets executable and all uncertain Wan3/policy assets blocked', async () => {
    const packs = await discoverScenarioAssetPacks(assetRoot);
    const executable = packs.filter((pack) => pack.expected.mode === 'EXECUTABLE');
    const blocked = packs.filter((pack) => pack.expected.mode === 'BLOCKED');
    expect(executable).toHaveLength(4);
    expect(blocked).toHaveLength(6);
    expect(blocked.filter((pack) => pack.parse.scenario.domain === 'wan3')).toHaveLength(5);
    expect(blocked.every((pack) => pack.parse.scenario.blockedReasons.length > 0)).toBe(true);
    expect(blocked.some((pack) => pack.parse.scenario.blockedReasons.some((reason) => reason.code === 'POLICY_BLOCKED'))).toBe(true);
    expect(blocked.some((pack) => pack.parse.scenario.blockedReasons.some((reason) => reason.code === 'REQUIREMENT_CONFLICT'))).toBe(true);
  });

  it('passes the Executability Gate for the 4 controlled contracts when their declared capabilities are available', async () => {
    const packs = (await discoverScenarioAssetPacks(assetRoot)).filter((pack) => pack.expected.mode === 'EXECUTABLE');
    for (const pack of packs) {
      const config = pack.configExample!;
      const scenario = pack.parse.scenario;
      const gate = evaluateScenarioExecutability(scenario, {
        processors: new Set(config.processorAllowlist as string[]),
        evidenceKinds: new Set(config.evidenceKindAllowlist as ScenarioEvidenceKind[]),
        prepareHooks: new Set(config.prepareHookAllowlist as string[]),
        cleanupHooks: new Set(config.cleanupHookAllowlist as string[]),
        availableDependencies: new Set(scenario.dependencies),
        executorAvailable: true,
        environmentAvailable: true,
        policyAllowed: true,
        supportsOperation: () => true,
      });
      expect(gate.reasons, scenario.id).toEqual([]);
      expect(gate.allowed, scenario.id).toBe(true);
    }
  });

  it('keeps every example configuration side-effect safe by default', async () => {
    const packs = await discoverScenarioAssetPacks(assetRoot);
    expect(packs.every((pack) => pack.configExample?.realExecution === false)).toBe(true);
    expect(packs.filter((pack) => pack.expected.mode === 'BLOCKED').every((pack) => {
      const policy = pack.configExample?.policy as Record<string, unknown> | undefined;
      return policy?.decision === 'BLOCKED' || pack.parse.scenario.blockedReasons.length > 0;
    })).toBe(true);
  });
});
