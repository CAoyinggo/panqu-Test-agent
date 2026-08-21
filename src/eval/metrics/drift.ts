export interface DriftSnapshot {
  score: number;
  benchmarkChecksum: string;
  benchmarkHealthy: boolean;
  modelVersion: string;
  promptVersion: string;
  latencyMs: number;
  cost: number;
}

export type DriftVerdict = 'PASS' | 'REVIEW' | 'BLOCK';
export type DriftType = 'SCORE' | 'BENCHMARK' | 'MODEL' | 'PROMPT' | 'LATENCY' | 'COST';

export interface DriftSignal {
  type: DriftType;
  verdict: DriftVerdict;
  baseline: string | number | boolean;
  current: string | number | boolean;
  delta?: number;
  reason: string;
}

export interface DriftReport {
  verdict: DriftVerdict;
  signals: DriftSignal[];
}

export function detectEvaluationDrift(baseline: DriftSnapshot, current: DriftSnapshot): DriftReport {
  const signals: DriftSignal[] = [];
  const scoreDrop = baseline.score - current.score;
  signals.push(numericSignal('SCORE', baseline.score, current.score, scoreDrop, 0.03, 0.1, 'score drop'));
  if (!current.benchmarkHealthy) {
    signals.push({ type: 'BENCHMARK', verdict: 'BLOCK', baseline: baseline.benchmarkChecksum, current: current.benchmarkChecksum, reason: 'Benchmark integrity invalid' });
  } else if (baseline.benchmarkChecksum !== current.benchmarkChecksum) {
    signals.push({ type: 'BENCHMARK', verdict: 'REVIEW', baseline: baseline.benchmarkChecksum, current: current.benchmarkChecksum, reason: 'Benchmark version/content changed' });
  } else {
    signals.push({ type: 'BENCHMARK', verdict: 'PASS', baseline: baseline.benchmarkChecksum, current: current.benchmarkChecksum, reason: 'Benchmark unchanged and healthy' });
  }
  signals.push(versionSignal('MODEL', baseline.modelVersion, current.modelVersion));
  signals.push(versionSignal('PROMPT', baseline.promptVersion, current.promptVersion));
  signals.push(ratioSignal('LATENCY', baseline.latencyMs, current.latencyMs));
  signals.push(ratioSignal('COST', baseline.cost, current.cost));
  return { verdict: highest(signals.map((signal) => signal.verdict)), signals };
}

function numericSignal(type: DriftType, baseline: number, current: number, delta: number, review: number, block: number, label: string): DriftSignal {
  const verdict: DriftVerdict = delta >= block ? 'BLOCK' : delta >= review ? 'REVIEW' : 'PASS';
  return { type, verdict, baseline, current, delta, reason: `${label}=${round4(delta)}` };
}

function ratioSignal(type: 'LATENCY' | 'COST', baseline: number, current: number): DriftSignal {
  const delta = baseline === 0 ? (current === 0 ? 0 : Infinity) : (current - baseline) / baseline;
  const verdict: DriftVerdict = delta >= 0.5 ? 'BLOCK' : delta >= 0.2 ? 'REVIEW' : 'PASS';
  return { type, verdict, baseline, current, delta, reason: `${type.toLowerCase()} increase=${Number.isFinite(delta) ? round4(delta) : 'infinite'}` };
}

function versionSignal(type: 'MODEL' | 'PROMPT', baseline: string, current: string): DriftSignal {
  const changed = baseline !== current;
  return { type, verdict: changed ? 'REVIEW' : 'PASS', baseline, current, reason: changed ? `${type.toLowerCase()} version changed` : `${type.toLowerCase()} unchanged` };
}

function highest(verdicts: DriftVerdict[]): DriftVerdict {
  return verdicts.includes('BLOCK') ? 'BLOCK' : verdicts.includes('REVIEW') ? 'REVIEW' : 'PASS';
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
