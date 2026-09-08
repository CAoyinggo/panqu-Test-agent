import type { EvidenceEnvelope, ScenarioAssertion } from '../../src/acceptance/scenario-contract.js';
import type {
  ScenarioProcessorContext,
  ScenarioProcessor,
} from '../../src/acceptance/scenario-runner.js';

function setPath(target: Record<string, unknown>, pathValue: string, value: unknown): void {
  const parts = pathValue.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cursor = target;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) cursor[part] = value;
    else cursor = (cursor[part] ??= {}) as Record<string, unknown>;
  }
}

/**
 * Scenario Runner 测试夹具：按 Scenario 已声明的 Oracle 生成可核对 Evidence。
 * 仅用于验证编排/生命周期，不进入生产运行时。
 */
export function fixtureScenarioProcessor(
  name: string,
  beforeExecute?: (context: ScenarioProcessorContext) => void | Promise<void>,
): ScenarioProcessor {
  return {
    name,
    supportsAbort: true,
    supportedEvidenceKinds: [
      'REQUEST', 'RESPONSE', 'STATE_BEFORE', 'STATE_AFTER', 'DATABASE',
      'RESOURCE', 'AUDIT_RECORD', 'LOG', 'QUEUE_MESSAGE', 'OTHER',
    ],
    supports: () => true,
    supportsEvidence: () => true,
    execute: async (operation, context) => {
      await beforeExecute?.(context);
      const requirements = context.scenario.evidenceRequirements
        .filter((requirement) => requirement.operationId === operation.id);
      const evidence = requirements.map((requirement): EvidenceEnvelope => {
        const data: Record<string, unknown> = {};
        for (const assertionId of requirement.assertionIds) {
          const assertion = context.scenario.assertions
            .find((candidate) => candidate.id === assertionId) as ScenarioAssertion | undefined;
          if (!assertion) continue;
          const value = assertion.operator === 'NOT_EXISTS' ? undefined
            : assertion.operator === 'EXISTS' ? 'observed'
              : assertion.expectedFrom ? 'observed' : assertion.expected;
          setPath(data, assertion.target, value);
        }
        return {
          id: requirement.id,
          requirementId: requirement.id,
          scenarioId: context.scenario.id,
          operationId: operation.id,
          acceptanceCriteriaIds: context.scenario.acceptanceCriteriaIds,
          kind: requirement.kind,
          channel: requirement.channel,
          source: name,
          observedAt: new Date().toISOString(),
          data,
          verified: true,
        };
      });
      return { status: 'PASS', executed: true, evidence };
    },
  };
}
