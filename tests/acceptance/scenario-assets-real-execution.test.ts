import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScenarioAssetPack } from '../../src/acceptance/scenario-asset-loader.js';
import { findEvidenceForRequirement } from '../../src/acceptance/scenario-evidence.js';
import { runScenarioAssetPipeline } from '../../src/acceptance/scenario-pipeline.js';
import {
  createAcceptanceHttpScenarioProcessor,
  type ScenarioHookHandler,
} from '../../src/acceptance/scenario-runner.js';
import {
  startControlledScenarioServer,
  type ControlledServerScenarioDefinition,
} from './helpers/controlled-scenario-server.js';
import { serverScenario as multiApi } from './scenarios/generic/multi-api-operation-binding/server-scenario.js';
import { serverScenario as deniedWrite } from './scenarios/profile/profile-denied-write-non-mutation/server-scenario.js';
import { serverScenario as massAssignment } from './scenarios/profile/profile-mass-assignment/server-scenario.js';
import { serverScenario as profilePersistence } from './scenarios/profile/profile-update-persistence/server-scenario.js';

interface RealExecutionCase {
  assetDirectory: string;
  definition: ControlledServerScenarioDefinition;
}

const cases: RealExecutionCase[] = [
  { assetDirectory: 'profile/profile-update-persistence', definition: profilePersistence },
  { assetDirectory: 'profile/profile-denied-write-non-mutation', definition: deniedWrite },
  { assetDirectory: 'profile/profile-mass-assignment', definition: massAssignment },
  { assetDirectory: 'generic/multi-api-operation-binding', definition: multiApi },
];

describe('canonical Scenario packs execute against the controlled loopback fixture', () => {
  it.each(cases)('$definition.scenarioId has real HTTP execution, complete evidence, and zero cleanup residue', async ({
    assetDirectory,
    definition,
  }) => {
    const pack = await loadScenarioAssetPack(path.resolve('tests/acceptance/scenarios', assetDirectory));
    const scenario = pack.parse.scenario;
    const server = await startControlledScenarioServer();
    try {
      expect(pack.serverScenarioPath).toBe(path.join(pack.directory, 'server-scenario.ts'));
      expect(pack.parse.issues).toEqual([]);
      expect(scenario.id).toBe(definition.scenarioId);
      expect(scenario.operations).toHaveLength(definition.expectedOperationCount);

      const prepare: ScenarioHookHandler = async (context) => server.prepare(definition, context.runId);
      const cleanup: ScenarioHookHandler = async () => server.cleanup(definition);
      const processor = createAcceptanceHttpScenarioProcessor({
        baseUrl: server.baseUrl,
        actorHeaders: Object.fromEntries(Object.entries(definition.actorHeaders).map(([key, headers]) => [key, { ...headers }])),
        apiSpecs: [...definition.apiSpecs],
      });
      const pipeline = await runScenarioAssetPipeline({
        directory: pack.directory,
        runId: `REAL-${definition.scenarioId}`,
        processors: [processor],
        prepareHooks: new Map([[definition.prepareHook, prepare]]),
        cleanupHooks: new Map([[definition.cleanupHook, cleanup]]),
        environmentAvailable: true,
        policyAllowed: true,
        availableDependencies: new Set(scenario.dependencies),
      });
      const outcome = pipeline.run;

      expect(outcome.gate.reasons, JSON.stringify(outcome.gate.reasons)).toEqual([]);
      expect(outcome.gate.allowed).toBe(true);
      expect(pipeline.report.result).toEqual(outcome.result);
      expect(pipeline.report.coverage).toEqual({
        requirementCoverage: 100,
        scenarioCoverage: 100,
        executableCoverage: 100,
        assertionCoverage: 100,
        evidenceCoverage: 100,
      });
      expect(pipeline.report.trace).toHaveLength(scenario.acceptanceCriteriaIds.length);
      expect(pipeline.report.trace.every((item) => item.status === 'PASS')).toBe(true);
      const failedAssertionEvidence = outcome.result.evidence.filter((item) => (
        item.id.startsWith('ASSERTION-')
          && (item.data as { pass?: unknown }).pass === false
      ));
      expect(outcome.result.status, `${outcome.result.summary}\n${JSON.stringify(failedAssertionEvidence, null, 2)}`).toBe('PASS');
      expect(outcome.result.executed).toBe(true);
      expect(outcome.result.processorInvoked).toBe(true);
      expect(outcome.result.processors).toEqual(['api']);
      expect(outcome.result.operationResults).toHaveLength(scenario.operations.length);
      expect(outcome.result.operationResults.map((operation) => operation.operationId))
        .toEqual(scenario.operations.map((operation) => operation.id));
      expect(outcome.result.operationResults.every((operation) => (
        operation.executed && operation.processorInvoked && operation.status === 'PASS'
      ))).toBe(true);
      expect(outcome.result.assertions).toBe(scenario.assertions.length);
      expect(outcome.result.passedAssertions).toBe(scenario.assertions.length);
      expect(outcome.result.failedAssertions).toBe(0);

      for (const requirement of scenario.evidenceRequirements.filter((item) => item.requiredForPass)) {
        const evidence = findEvidenceForRequirement(scenario, requirement, outcome.result.evidence);
        expect(evidence, `${scenario.id}/${requirement.id}`).toBeDefined();
        expect(evidence).toMatchObject({
          id: requirement.id,
          requirementId: requirement.id,
          scenarioId: scenario.id,
          operationId: requirement.operationId,
          verified: true,
        });
        expect(evidence?.digest).toMatch(/^[a-f0-9]{64}$/);
      }

      // Server-side observations prove these were loopback HTTP requests, not a Processor mock.
      expect(server.requests).toHaveLength(definition.expectedOperationCount);
      expect(server.requests.every((request) => request.remoteAddress === '127.0.0.1')).toBe(true);
      expect(outcome.result.evidence.filter((item) => item.kind === 'REQUEST').every((item) => (
        typeof (item.data as { url?: unknown }).url === 'string'
          && String((item.data as { url: string }).url).startsWith(`${server.baseUrl}/`)
      ))).toBe(true);

      expect(server.lifecycle.prepared).toBe(1);
      expect(server.lifecycle.cleaned).toBe(1);
      expect(server.lifecycle.cleanupSnapshots).toEqual([definition.cleanupExpectation]);
      expect(server.resourceCounts()).toEqual({
        profiles: 0, payloads: 0, uploads: 0, tasks: 0, results: 0, total: 0,
      });
      expect(outcome.variables.cleanupResourceCount).toBe(0);
    } finally {
      await server.close();
    }
  }, 15_000);
});
