import type { ScenarioEvidenceKind } from '../acceptance/scenario-contract.js';

export type ObserverCapability = 'RESPONSE' | 'STATE' | 'DATABASE' | 'TASK' | 'BILLING' | 'AUDIT' | 'BROWSER';

export interface ObservationContext {
  runId: string;
  scenarioId: string;
  operationId: string;
  environment: string;
  variables: Record<string, unknown>;
  signal: AbortSignal;
  actionOutput?: unknown;
}

export interface ObservationSnapshot<T = unknown> {
  observer: string;
  capability: ObserverCapability;
  observedAt: string;
  available: boolean;
  value?: T;
  source?: string;
  reason?: string;
}

export interface ObservationDiff<T = unknown> {
  observer: string;
  capability: ObserverCapability;
  changed: boolean;
  before?: T;
  after?: T;
  delta?: unknown;
}

export interface Observer<T = unknown> {
  name: string;
  capabilities(): ObserverCapability[];
  available(context: ObservationContext): boolean | Promise<boolean>;
  before(context: ObservationContext): Promise<ObservationSnapshot<T>>;
  after(context: ObservationContext): Promise<ObservationSnapshot<T>>;
  diff(before: ObservationSnapshot<T>, after: ObservationSnapshot<T>): Promise<ObservationDiff<T>>;
}

export interface ObserverRequirementBinding {
  evidenceKind: ScenarioEvidenceKind;
  capabilities: ObserverCapability[];
}

export const OBSERVER_REQUIREMENTS: readonly ObserverRequirementBinding[] = [
  { evidenceKind: 'STATE_BEFORE', capabilities: ['STATE', 'DATABASE', 'TASK', 'BILLING'] },
  { evidenceKind: 'STATE_AFTER', capabilities: ['STATE', 'DATABASE', 'TASK', 'BILLING'] },
  { evidenceKind: 'DATABASE', capabilities: ['DATABASE'] },
  { evidenceKind: 'RESOURCE', capabilities: ['STATE', 'DATABASE', 'TASK'] },
  { evidenceKind: 'BILLING_RECORD', capabilities: ['BILLING'] },
  { evidenceKind: 'AUDIT_RECORD', capabilities: ['AUDIT'] },
  { evidenceKind: 'SCREENSHOT', capabilities: ['BROWSER'] },
] as const;

export class ObserverUnavailableError extends Error {
  constructor(readonly observer: string, readonly reason: string) {
    super(`OBSERVER_UNAVAILABLE：${observer}：${reason}`);
    this.name = 'ObserverUnavailableError';
  }
}
