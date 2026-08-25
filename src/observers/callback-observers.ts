import { isDeepStrictEqual } from 'node:util';
import type { ObservationContext, ObservationDiff, ObservationSnapshot, Observer, ObserverCapability } from './types.js';
import { ObserverUnavailableError } from './types.js';

export type ObservationProbe<T> = (context: ObservationContext, phase: 'before' | 'after') => Promise<T>;

export interface CallbackObserverOptions<T> {
  name: string;
  capability: ObserverCapability;
  probe?: ObservationProbe<T>;
  source?: string;
  diff?: (before: T, after: T) => unknown;
}

export class CallbackObserver<T = unknown> implements Observer<T> {
  readonly name: string;
  private readonly capability: ObserverCapability;
  private readonly probe?: ObservationProbe<T>;
  private readonly source?: string;
  private readonly differ?: (before: T, after: T) => unknown;

  constructor(options: CallbackObserverOptions<T>) {
    this.name = options.name;
    this.capability = options.capability;
    this.probe = options.probe;
    this.source = options.source;
    this.differ = options.diff;
  }

  capabilities(): ObserverCapability[] { return [this.capability]; }
  available(_context?: ObservationContext): boolean { return Boolean(this.probe); }

  async before(context: ObservationContext): Promise<ObservationSnapshot<T>> {
    return this.capture(context, 'before');
  }

  async after(context: ObservationContext): Promise<ObservationSnapshot<T>> {
    return this.capture(context, 'after');
  }

  async diff(before: ObservationSnapshot<T>, after: ObservationSnapshot<T>): Promise<ObservationDiff<T>> {
    const changed = !isDeepStrictEqual(before.value, after.value);
    return {
      observer: this.name, capability: this.capability, changed,
      before: before.value, after: after.value,
      delta: before.value !== undefined && after.value !== undefined && this.differ ? this.differ(before.value, after.value) : undefined,
    };
  }

  private async capture(context: ObservationContext, phase: 'before' | 'after'): Promise<ObservationSnapshot<T>> {
    if (!this.probe) throw new ObserverUnavailableError(this.name, '未配置真实数据探针');
    return {
      observer: this.name, capability: this.capability, observedAt: new Date().toISOString(),
      available: true, value: await this.probe(context, phase), source: this.source ?? this.name,
    };
  }
}

export class StateObserver<T = unknown> extends CallbackObserver<T> {
  constructor(probe?: ObservationProbe<T>, source = 'state-probe') { super({ name: 'state', capability: 'STATE', probe, source }); }
}
export class DatabaseObserver<T = unknown> extends CallbackObserver<T> {
  constructor(probe?: ObservationProbe<T>, source = 'database-query') { super({ name: 'database', capability: 'DATABASE', probe, source }); }
}
export class TaskObserver<T = unknown> extends CallbackObserver<T> {
  constructor(probe?: ObservationProbe<T>, source = 'task-query') { super({ name: 'task', capability: 'TASK', probe, source }); }
}
export class BillingObserver<T = unknown> extends CallbackObserver<T> {
  constructor(probe?: ObservationProbe<T>, source = 'billing-ledger') { super({ name: 'billing', capability: 'BILLING', probe, source }); }
}
export class AuditObserver<T = unknown> extends CallbackObserver<T> {
  constructor(probe?: ObservationProbe<T>, source = 'audit-query') { super({ name: 'audit', capability: 'AUDIT', probe, source }); }
}
export class BrowserObserver<T = unknown> extends CallbackObserver<T> {
  constructor(probe?: ObservationProbe<T>, source = 'browser-adapter') { super({ name: 'browser', capability: 'BROWSER', probe, source }); }
}
