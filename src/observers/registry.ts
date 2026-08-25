import type { ScenarioEvidenceKind } from '../acceptance/scenario-contract.js';
import { OBSERVER_REQUIREMENTS, type ObservationContext, type Observer, type ObserverCapability } from './types.js';

export class ObserverRegistry {
  private readonly values = new Map<string, Observer>();

  constructor(observers: readonly Observer[] = []) { observers.forEach((observer) => this.register(observer)); }

  register(observer: Observer): void {
    if (this.values.has(observer.name)) throw new Error(`OBSERVER_DUPLICATE：${observer.name}`);
    this.values.set(observer.name, observer);
  }

  list(): Observer[] { return [...this.values.values()]; }

  capabilities(): ReadonlySet<ObserverCapability> {
    return new Set(this.list().flatMap((observer) => observer.capabilities()));
  }

  async resolve(kind: ScenarioEvidenceKind, context: ObservationContext): Promise<Observer | undefined> {
    const required = OBSERVER_REQUIREMENTS.find((item) => item.evidenceKind === kind)?.capabilities ?? [];
    for (const observer of this.values.values()) {
      if (!observer.capabilities().some((capability) => required.includes(capability))) continue;
      if (await observer.available(context)) return observer;
    }
    return undefined;
  }
}
