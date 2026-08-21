import { useEffect, useState } from 'react';
import {
  api, archiveEvaluationData, getAggregatedMetrics, getBenchmarkIntegrity, getEvaluationProjectId,
  getEvaluationScale, getStoredUser, restoreEvaluationData, setEvaluationProjectId,
  type AggregatedMetricItem, type EvaluationScaleReport,
} from '../api';
import { Card, Empty, MetricCard, StatusBadge, Table } from '../components/ui';

const canOperate = (): boolean => ['ADMIN', 'RELEASE_MANAGER'].includes(getStoredUser()?.role ?? '');

export default function Scale(): JSX.Element {
  const [projectId, setProjectId] = useState(getEvaluationProjectId());
  const [projects, setProjects] = useState<string[]>(getStoredUser()?.scopes.projects ?? []);
  const [range, setRange] = useState('24h');
  const [model, setModel] = useState('');
  const [benchmark, setBenchmark] = useState('RISK_BENCHMARK_v1');
  const [scale, setScale] = useState<EvaluationScaleReport | null>(null);
  const [metrics, setMetrics] = useState<AggregatedMetricItem[]>([]);
  const [integrity, setIntegrity] = useState<{ valid: boolean; checksum: string; caseCount: number; issues: string[] } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = async (): Promise<void> => {
    try {
      const dimension = model ? 'model' : benchmark ? 'benchmark' : range === '24h' ? 'hourly' : 'daily';
      const key = model || (dimension === 'benchmark' ? benchmark : undefined);
      const [nextScale, aggregated, benchmarkIntegrity] = await Promise.all([
        getEvaluationScale(), getAggregatedMetrics(dimension, key), getBenchmarkIntegrity(benchmark),
      ]);
      setScale(nextScale); setMetrics(aggregated.metrics); setIntegrity(benchmarkIntegrity); setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => {
    setEvaluationProjectId(projectId);
    void load();
  }, [projectId, range, model, benchmark]);

  useEffect(() => {
    if (projects.length > 0) return;
    void api.get<Array<{ id: string }>>('/projects').then((items) => setProjects(items.map((item) => item.id))).catch(() => setProjects([projectId]));
  }, [projectId, projects.length]);

  const action = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    try { await fn(); setMessage(ok); setError(''); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  return (
    <div>
      <h1 className="page-title">Evaluation Scale</h1>
      <div className="page-sub">生产规模 · 聚合指标 · 数据生命周期 · Drift · Recovery</div>
      <div className="form-row" style={{ marginBottom: 16 }}>
        <label>Project <select aria-label="Scale Project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>{(projects.length ? projects : [projectId]).map((id) => <option key={id}>{id}</option>)}</select></label>
        <label>Time Range <select aria-label="Time Range" className="select" value={range} onChange={(e) => setRange(e.target.value)}><option>1h</option><option>24h</option><option>7d</option><option>30d</option></select></label>
        <label>Model <select aria-label="Model Filter" className="select" value={model} onChange={(e) => setModel(e.target.value)}><option value="">All</option><option>rules-v1</option><option>rules-v2</option></select></label>
        <label>Benchmark <select aria-label="Benchmark Filter" className="select" value={benchmark} onChange={(e) => setBenchmark(e.target.value)}><option>RISK_BENCHMARK_v1</option><option>RCA_BENCHMARK_v1</option></select></label>
        <button className="btn btn-sm" onClick={() => void load()}>刷新</button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      {!scale ? <Empty text="正在加载规模数据" /> : <>
        <div className="metric-grid">
          <MetricCard label="Evaluation Throughput" value={scale.throughput.toFixed(2)} hint="eval/s" />
          <MetricCard label="Active Workers" value={scale.activeWorkers} hint={`${scale.workers.length} total`} />
          <MetricCard label="Queue" value={scale.queue.QUEUED} hint={`${scale.queue.RUNNING} running`} />
          <MetricCard label="P95" value={`${scale.p95.toFixed(1)} ms`} hint={`P99 ${scale.p99.toFixed(1)} ms`} />
          <MetricCard label="Cost" value={`$${scale.cost.toFixed(4)}`} />
          <MetricCard label="Data Growth" value={scale.dataGrowth} hint="records" />
          <MetricCard label="Archive" value={scale.archive.ARCHIVED} hint={`HOT ${scale.archive.HOT}`} />
          <MetricCard label="Drift" value={scale.drift.verdict} />
          <MetricCard label="Recovery" value={scale.recovery.health} hint={`${(scale.recovery.recoveryRate * 100).toFixed(0)}% recovered`} />
        </div>
        <Card title="Worker / Queue Capacity">
          <Table head={['Worker', '状态', 'Processed', 'Failed Attempts', 'Utilization']}>
            {scale.workers.map((worker) => <tr key={worker.id}><td className="mono">{worker.id}</td><td><StatusBadge status={worker.status} /></td><td>{worker.processed}</td><td>{worker.failedAttempts}</td><td>{(scale.workerUtilization * 100).toFixed(1)}%</td></tr>)}
          </Table>
        </Card>
        <Card title="Aggregated Evaluation History">
          {metrics.length === 0 ? <Empty text="当前筛选无聚合记录" /> : <Table head={['Bucket', 'Count', 'Average Score', 'P95', 'Failure Rate', 'Cost']}>
            {metrics.map((metric) => <tr key={`${metric.dimension}-${metric.key}`}><td className="mono">{metric.key}</td><td>{metric.count}</td><td>{(metric.averageScore * 100).toFixed(1)}%</td><td>{metric.p95LatencyMs} ms</td><td>{(metric.failureRate * 100).toFixed(1)}%</td><td>${metric.cost.toFixed(4)}</td></tr>)}
          </Table>}
        </Card>
        <Card title="Benchmark Integrity">
          <div data-testid="benchmark-integrity"><StatusBadge status={integrity?.valid ? 'HEALTHY' : 'BLOCK'} /> {' '}{benchmark} · {integrity?.caseCount ?? 0} cases · {integrity?.checksum?.slice(0, 12) ?? '—'}</div>
        </Card>
        <Card title="Drift Signals">
          {scale.drift.signals.length === 0 ? <Empty text="无 Drift" /> : <Table head={['类型', '判定', 'Baseline', 'Current', '原因']}>
            {scale.drift.signals.map((signal) => <tr key={signal.type}><td>{signal.type}</td><td><StatusBadge status={signal.verdict} /></td><td>{String(signal.baseline)}</td><td>{String(signal.current)}</td><td>{signal.reason}</td></tr>)}
          </Table>}
        </Card>
        <Card title="Data Lifecycle">
          <div>HOT {scale.archive.HOT} → WARM {scale.archive.WARM} → COLD {scale.archive.COLD} → ARCHIVED {scale.archive.ARCHIVED}</div>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-sm" disabled={!canOperate()} onClick={() => void action(() => archiveEvaluationData('2026-01-01T00:00:00.000Z'), 'Archive 完成')}>Archive</button>{' '}
            <button className="btn btn-sm" disabled={!canOperate()} onClick={() => void action(restoreEvaluationData, 'Restore 完成')}>Restore</button>
          </div>
        </Card>
      </>}
    </div>
  );
}
