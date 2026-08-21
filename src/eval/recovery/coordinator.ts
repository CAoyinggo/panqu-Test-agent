// Phase 51.7：Evaluation failure detection、checkpoint、pause/resume。
export type RecoveryComponent = 'STORAGE' | 'WORKER' | 'QUEUE' | 'TELEMETRY' | 'BENCHMARK' | 'GROUND_TRUTH';
export type RecoveryHealth = 'HEALTHY' | 'DEGRADED' | 'RECOVERING';

export interface RecoveryAlert {
  id: string;
  component: RecoveryComponent;
  message: string;
  detectedAt: string;
  recoveredAt?: string;
}

export interface RecoveryStatus {
  health: RecoveryHealth;
  components: Record<RecoveryComponent, RecoveryHealth>;
  alerts: RecoveryAlert[];
  recoveryRate: number;
}

export class RecoveryCoordinator {
  private readonly components: Record<RecoveryComponent, RecoveryHealth> = {
    STORAGE: 'HEALTHY', WORKER: 'HEALTHY', QUEUE: 'HEALTHY', TELEMETRY: 'HEALTHY',
    BENCHMARK: 'HEALTHY', GROUND_TRUTH: 'HEALTHY',
  };
  private readonly alerts: RecoveryAlert[] = [];

  detect(component: RecoveryComponent, message: string, now = new Date().toISOString()): RecoveryAlert {
    this.components[component] = 'DEGRADED';
    const existing = [...this.alerts].reverse().find((alert) => alert.component === component && !alert.recoveredAt);
    if (existing) return structuredClone(existing);
    const alert = { id: `recovery-${this.alerts.length + 1}`, component, message, detectedAt: now };
    this.alerts.push(alert);
    return structuredClone(alert);
  }

  beginRecovery(component: RecoveryComponent): void {
    this.components[component] = 'RECOVERING';
  }

  recover(component: RecoveryComponent, now = new Date().toISOString()): void {
    this.components[component] = 'HEALTHY';
    for (const alert of this.alerts) if (alert.component === component && !alert.recoveredAt) alert.recoveredAt = now;
  }

  isHealthy(component: RecoveryComponent): boolean {
    return this.components[component] === 'HEALTHY';
  }

  status(): RecoveryStatus {
    const recovered = this.alerts.filter((alert) => alert.recoveredAt).length;
    const states = Object.values(this.components);
    return {
      health: states.includes('DEGRADED') ? 'DEGRADED' : states.includes('RECOVERING') ? 'RECOVERING' : 'HEALTHY',
      components: structuredClone(this.components),
      alerts: structuredClone(this.alerts),
      recoveryRate: this.alerts.length === 0 ? 1 : recovered / this.alerts.length,
    };
  }
}

export type EvaluationRecoveryState = 'RUNNING' | 'PAUSED' | 'BLOCKED' | 'COMPLETED';

export interface EvaluationCheckpoint {
  jobId: string;
  projectId: string;
  allCaseIds: string[];
  completedCaseIds: string[];
  remainingCaseIds: string[];
  state: EvaluationRecoveryState;
  reason?: string;
  benchmark: string;
  benchmarkChecksum: string;
  groundTruthVersion: string;
  updatedAt: string;
}

export class EvaluationCheckpointStore {
  private readonly checkpoints = new Map<string, EvaluationCheckpoint>();

  save(checkpoint: EvaluationCheckpoint): void {
    this.checkpoints.set(checkpoint.jobId, structuredClone(checkpoint));
  }

  get(jobId: string): EvaluationCheckpoint | undefined {
    const checkpoint = this.checkpoints.get(jobId);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  snapshot(): EvaluationCheckpoint[] {
    return [...this.checkpoints.values()].map((checkpoint) => structuredClone(checkpoint));
  }

  static restore(snapshot: EvaluationCheckpoint[]): EvaluationCheckpointStore {
    const store = new EvaluationCheckpointStore();
    for (const checkpoint of snapshot) store.save(checkpoint);
    return store;
  }
}

export interface ResumableEvaluationInput {
  jobId: string;
  projectId: string;
  caseIds: string[];
  benchmark: string;
  benchmarkChecksum: string;
  groundTruthVersion: string;
}

export interface ResumableEvaluationDeps {
  checkpoints: EvaluationCheckpointStore;
  recovery: RecoveryCoordinator;
  executeCase: (caseId: string) => void | Promise<void>;
  now?: () => string;
}

export async function runResumableEvaluation(input: ResumableEvaluationInput, deps: ResumableEvaluationDeps): Promise<EvaluationCheckpoint> {
  const now = deps.now ?? (() => new Date().toISOString());
  let checkpoint = deps.checkpoints.get(input.jobId) ?? {
    jobId: input.jobId,
    projectId: input.projectId,
    allCaseIds: [...input.caseIds],
    completedCaseIds: [],
    remainingCaseIds: [...input.caseIds],
    state: 'RUNNING' as const,
    benchmark: input.benchmark,
    benchmarkChecksum: input.benchmarkChecksum,
    groundTruthVersion: input.groundTruthVersion,
    updatedAt: now(),
  };
  if (checkpoint.benchmarkChecksum !== input.benchmarkChecksum || checkpoint.groundTruthVersion !== input.groundTruthVersion) {
    checkpoint = pause(checkpoint, 'Benchmark/GroundTruth version changed during recovery', 'BLOCKED', now());
    deps.checkpoints.save(checkpoint);
    return checkpoint;
  }
  const gate = dependencyGate(deps.recovery);
  if (gate) {
    checkpoint = pause(checkpoint, gate.reason, gate.state, now());
    deps.checkpoints.save(checkpoint);
    return checkpoint;
  }

  checkpoint.state = 'RUNNING';
  delete checkpoint.reason;
  for (const caseId of [...checkpoint.remainingCaseIds]) {
    const duringRunGate = dependencyGate(deps.recovery);
    if (duringRunGate) {
      checkpoint = pause(checkpoint, duringRunGate.reason, duringRunGate.state, now());
      deps.checkpoints.save(checkpoint);
      return checkpoint;
    }
    try {
      await deps.executeCase(caseId);
    } catch (caught) {
      deps.recovery.detect('WORKER', caught instanceof Error ? caught.message : String(caught), now());
      checkpoint = pause(checkpoint, 'Worker interrupted; resume from checkpoint', 'PAUSED', now());
      deps.checkpoints.save(checkpoint);
      return checkpoint;
    }
    if (!checkpoint.completedCaseIds.includes(caseId)) checkpoint.completedCaseIds.push(caseId);
    checkpoint.remainingCaseIds = checkpoint.remainingCaseIds.filter((id) => id !== caseId);
    checkpoint.updatedAt = now();
    deps.checkpoints.save(checkpoint);
  }
  checkpoint.state = 'COMPLETED';
  checkpoint.updatedAt = now();
  deps.checkpoints.save(checkpoint);
  return checkpoint;
}

function dependencyGate(recovery: RecoveryCoordinator): { state: EvaluationRecoveryState; reason: string } | undefined {
  if (!recovery.isHealthy('BENCHMARK')) return { state: 'BLOCKED', reason: 'Benchmark integrity unavailable' };
  if (!recovery.isHealthy('GROUND_TRUTH')) return { state: 'PAUSED', reason: 'Ground Truth unavailable; stale fallback forbidden' };
  for (const component of ['STORAGE', 'QUEUE', 'TELEMETRY'] as const) {
    if (!recovery.isHealthy(component)) return { state: 'PAUSED', reason: `${component} unavailable` };
  }
  return undefined;
}

function pause(checkpoint: EvaluationCheckpoint, reason: string, state: EvaluationRecoveryState, now: string): EvaluationCheckpoint {
  return { ...checkpoint, state, reason, updatedAt: now };
}
