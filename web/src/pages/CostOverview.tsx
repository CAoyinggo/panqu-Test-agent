import { useEffect, useState } from 'react';
import {
  api, getCostAnomalies, getCostBudgets, getCostForecast, getCostOverview, getEvaluationProjectId,
  getStoredUser, getWorkerCapacity, setEvaluationProjectId,
  type CapacityReport, type CostAnomalyItem, type CostBudgetItem, type CostForecastReport, type CostOverviewReport,
} from '../api';
import { Card, Empty, MetricCard, StatusBadge, Table } from '../components/ui';

const money = (value: number | null | undefined): string => value === null || value === undefined ? '—' : `$${value.toFixed(4)}`;

export default function CostOverview(): JSX.Element {
  const [projectId, setProjectId] = useState(getEvaluationProjectId());
  const [projects, setProjects] = useState<string[]>(getStoredUser()?.scopes.projects ?? []);
  const [window, setWindow] = useState('7d'); const [grain, setGrain] = useState('daily');
  const [model, setModel] = useState(''); const [provider, setProvider] = useState('');
  const [evaluationId, setEvaluationId] = useState(''); const [benchmarkId, setBenchmarkId] = useState(''); const [releaseId, setReleaseId] = useState('');
  const [overview, setOverview] = useState<CostOverviewReport | null>(null);
  const [forecast, setForecast] = useState<CostForecastReport | null>(null);
  const [anomalies, setAnomalies] = useState<CostAnomalyItem[]>([]);
  const [capacity, setCapacity] = useState<CapacityReport | null>(null);
  const [budgets, setBudgets] = useState<CostBudgetItem[]>([]);
  const [error, setError] = useState('');

  const load = async (): Promise<void> => {
    try {
      const [summary, predicted, alerts, limits] = await Promise.all([
        getCostOverview({ projectId, window, grain, model, provider, evaluationId, benchmarkId, releaseId }),
        getCostForecast(projectId), getCostAnomalies(projectId), getCostBudgets(projectId),
      ]);
      setOverview(summary); setForecast(predicted); setAnomalies(alerts.anomalies); setBudgets(limits);
      try { setCapacity(await getWorkerCapacity()); } catch { setCapacity(null); }
      setError('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  useEffect(() => { setEvaluationProjectId(projectId); void load(); }, [projectId, window, grain, model, provider, evaluationId, benchmarkId, releaseId]);
  useEffect(() => { if (projects.length) return; void api.get<Array<{ id: string }>>('/projects').then((items) => setProjects(items.map((v) => v.id))).catch(() => setProjects([projectId])); }, [projectId, projects.length]);
  const monthly = forecast?.forecasts.find((v) => v.horizon === '30d');
  const budget = budgets[0];

  return <div data-testid="cost-overview">
    <h1 className="page-title">Cost Overview</h1>
    <div className="page-sub">成本归因 · 预算 · 预测 · 异常 · 容量自适应</div>
    <div className="form-row" style={{ marginBottom: 16 }}>
      <label>Project <select aria-label="Cost Project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>{(projects.length ? projects : [projectId]).map((v) => <option key={v}>{v}</option>)}</select></label>
      <label>Range <select aria-label="Cost Range" className="select" value={window} onChange={(e) => setWindow(e.target.value)}><option value="today">今日</option><option>7d</option><option>30d</option><option value="release">Release</option><option value="version">Version</option></select></label>
      <label>Trend <select aria-label="Trend Grain" className="select" value={grain} onChange={(e) => setGrain(e.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
      <label>Model <input aria-label="Cost Model" className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="All" /></label>
      <label>Provider <input aria-label="Cost Provider" className="input" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="All" /></label>
      <label>Evaluation <input aria-label="Cost Evaluation" className="input" value={evaluationId} onChange={(e) => setEvaluationId(e.target.value)} placeholder="All" /></label>
      <label>Benchmark <input aria-label="Cost Benchmark" className="input" value={benchmarkId} onChange={(e) => setBenchmarkId(e.target.value)} placeholder="All" /></label>
      <label>Release <input aria-label="Cost Release" className="input" value={releaseId} onChange={(e) => setReleaseId(e.target.value)} placeholder="All" /></label>
    </div>
    {error && <div className="error-banner">{error}</div>}
    {!overview ? <Empty text="正在加载成本数据" /> : <>
      <div className="metric-grid">
        <MetricCard label="Total Cost" value={money(overview.totalCost)} hint={`${overview.recordCount} records`} />
        <MetricCard label="Cost / Run" value={money(overview.costPerRun)} />
        <MetricCard label="Cost / Evaluation" value={money(overview.costPerEvaluation)} />
        <MetricCard label="Cost / Benchmark" value={money(overview.costPerBenchmark)} />
        <MetricCard label="Cost / Project" value={money(overview.costPerProject)} />
        <MetricCard label="Forecast 30d" value={money(monthly?.expectedCost)} hint={`${monthly?.expectedRuns ?? 0} runs`} />
        <MetricCard label="Budget" value={money(budget?.monthly ?? budget?.daily)} hint={budget ? 'configured' : 'not configured'} />
        <MetricCard label="Anomaly" value={anomalies.length} hint={anomalies[0]?.severity ?? 'NORMAL'} />
      </div>
      <Card title={`${grain[0].toUpperCase()}${grain.slice(1)} Cost Trend`}>
        {overview.trend.length ? <Table head={['Period', 'Cost', 'Relative']}>
          {overview.trend.map((item) => <tr key={item.period}><td>{item.period}</td><td>{money(item.cost)}</td><td><div style={{ width: `${Math.min(100, item.cost / Math.max(...overview.trend.map((v) => v.cost), 1) * 100)}%`, minWidth: 2, height: 8, background: 'var(--accent)', borderRadius: 4 }} /></td></tr>)}
        </Table> : <Empty text="当前筛选无成本趋势" />}
      </Card>
      <Card title="Cost / Model & Provider"><Table head={['Dimension', 'Name', 'Cost']}>
        {Object.entries(overview.byModel).map(([name, cost]) => <tr key={`m-${name}`}><td>Model</td><td>{name}</td><td>{money(cost)}</td></tr>)}
        {Object.entries(overview.byProvider).map(([name, cost]) => <tr key={`p-${name}`}><td>Provider</td><td>{name}</td><td>{money(cost)}</td></tr>)}
      </Table></Card>
      <Card title="Cost Anomalies">{anomalies.length ? <Table head={['Severity', 'Current', 'Baseline', 'Ratio', 'Reason']}>{anomalies.map((item) => <tr key={item.id}><td><StatusBadge status={item.severity} /></td><td>{money(item.current)}</td><td>{money(item.baseline)}</td><td>{item.ratio}×</td><td>{item.message}</td></tr>)}</Table> : <Empty text="未检测到成本异常" />}</Card>
      <Card title="Capacity Dashboard" action={<span>{capacity ? `${capacity.currentWorkers} workers` : '受权限保护'}</span>}>
        {!capacity ? <Empty text="需要 OPS_READ 查看 Worker 容量" /> : <><div className="metric-grid"><MetricCard label="Current Workers" value={capacity.currentWorkers} /><MetricCard label="Desired Workers" value={capacity.events.at(-1)?.desiredWorkers ?? capacity.currentWorkers} /><MetricCard label="Min / Max" value={`${capacity.limits?.minWorkers ?? 1} / ${capacity.limits?.maxWorkers ?? '—'}`} /><MetricCard label="Scale Events" value={capacity.events.length} /></div><Table head={['At', 'Action', 'Current', 'Desired', 'Reason']}>{capacity.events.map((event) => <tr key={`${event.at}-${event.action}`}><td>{event.at}</td><td><StatusBadge status={event.action} /></td><td>{event.currentWorkers}</td><td>{event.desiredWorkers}</td><td>{event.reason}</td></tr>)}</Table></>}
      </Card>
    </>}
  </div>;
}
