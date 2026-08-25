import type { BlockedReason, EvidenceEnvelope, ScenarioEvidenceKind } from '../acceptance/scenario-contract.js';
import type { ScenarioProcessor, ScenarioProcessorExecution } from '../acceptance/scenario-runner.js';
import type { ObservationContext, ObservationSnapshot, Observer } from './types.js';
import { OBSERVER_REQUIREMENTS } from './types.js';
import type { ObserverRegistry } from './registry.js';

function reason(kind: ScenarioEvidenceKind, operationId: string): BlockedReason {
  const sideEffect = ['BILLING_RECORD', 'AUDIT_RECORD', 'PROVIDER_CALL', 'EVENT', 'QUEUE_MESSAGE'].includes(kind);
  return {
    code: sideEffect ? 'MISSING_SIDE_EFFECT_OBSERVER' : 'MISSING_STATE_OBSERVER',
    stage: 'GATE', message: `${operationId} 所需 ${kind} Observer 不可用`,
    details: { operationId, evidenceKind: kind }, recoverable: true,
  };
}

function evidenceData(kind: ScenarioEvidenceKind, before: ObservationSnapshot, after: ObservationSnapshot, diff: unknown): unknown {
  if (kind === 'STATE_BEFORE') return before.value;
  if (kind === 'STATE_AFTER' || kind === 'DATABASE' || kind === 'RESOURCE' || kind === 'BILLING_RECORD' || kind === 'AUDIT_RECORD' || kind === 'SCREENSHOT') return after.value;
  return { before: before.value, after: after.value, diff };
}

export function observeProcessor(delegate: ScenarioProcessor, registry: ObserverRegistry, environment: string): ScenarioProcessor {
  const observerKinds = new Set<ScenarioEvidenceKind>(OBSERVER_REQUIREMENTS
    .filter((binding) => binding.capabilities.some((capability) => registry.capabilities().has(capability)))
    .map((binding) => binding.evidenceKind));
  return {
    name: delegate.name,
    supportsAbort: true,
    supportedEvidenceKinds: [...new Set<ScenarioEvidenceKind>([
      ...delegate.supportedEvidenceKinds,
      ...OBSERVER_REQUIREMENTS.filter((binding) => binding.capabilities.some((capability) => registry.capabilities().has(capability)))
        .map((binding) => binding.evidenceKind),
    ])],
    supports: (operation) => delegate.supports(operation),
    supportsEvidence: (operation, kind) => observerKinds.has(kind)
      || (delegate.supportsEvidence?.(operation, kind) ?? delegate.supportedEvidenceKinds.includes(kind)),
    execute: async (operation, context): Promise<ScenarioProcessorExecution> => {
      const required = context.scenario.evidenceRequirements.filter((item) => item.requiredForPass && item.operationId === operation.id
        && OBSERVER_REQUIREMENTS.some((binding) => binding.evidenceKind === item.kind));
      const observationContext: ObservationContext = {
        runId: context.runId, scenarioId: context.scenario.id, operationId: operation.id,
        environment, variables: context.variables, signal: context.signal,
      };
      const bindings: Array<{ kind: ScenarioEvidenceKind; observer: Observer; requirementId: string }> = [];
      for (const requirement of required) {
        const observer = await registry.resolve(requirement.kind, observationContext);
        if (!observer) return { status: 'BLOCKED', executed: false, evidence: [], blockedReasons: [reason(requirement.kind, operation.id)] };
        bindings.push({ kind: requirement.kind, observer, requirementId: requirement.id });
      }
      const snapshots = new Map<Observer, ObservationSnapshot>();
      try {
        for (const { observer } of bindings) if (!snapshots.has(observer)) snapshots.set(observer, await observer.before(observationContext));
      } catch (error) {
        return { status: 'BLOCKED', executed: false, evidence: [], error: (error as Error).message,
          blockedReasons: [reason(bindings[0]?.kind ?? 'STATE_BEFORE', operation.id)] };
      }
      const execution = await delegate.execute(operation, context);
      const observedEvidence: EvidenceEnvelope[] = [];
      try {
        const after = new Map<Observer, ObservationSnapshot>();
        for (const { observer } of bindings) if (!after.has(observer)) after.set(observer, await observer.after({ ...observationContext, actionOutput: execution.output }));
        for (const binding of bindings) {
          const before = snapshots.get(binding.observer)!;
          const afterSnapshot = after.get(binding.observer)!;
          const diff = await binding.observer.diff(before, afterSnapshot);
          const requirement = context.scenario.evidenceRequirements.find((item) => item.id === binding.requirementId)!;
          observedEvidence.push({
            id: requirement.id, requirementId: requirement.id, scenarioId: context.scenario.id,
            operationId: operation.id,
            acceptanceCriteriaIds: [...new Set(requirement.assertionIds.flatMap((id) => context.scenario.assertions.find((item) => item.id === id)?.acceptanceCriteriaIds ?? []))],
            kind: requirement.kind, channel: requirement.channel, source: `${binding.observer.name}-observer`,
            observedAt: afterSnapshot.observedAt,
            data: evidenceData(requirement.kind, before, afterSnapshot, diff), verified: true,
          });
        }
      } catch (error) {
        return { ...execution, status: 'BLOCKED', evidence: [...execution.evidence], error: (error as Error).message,
          blockedReasons: [reason(bindings[0]?.kind ?? 'STATE_AFTER', operation.id)] };
      }
      return { ...execution, evidence: [...execution.evidence, ...observedEvidence] };
    },
  };
}
