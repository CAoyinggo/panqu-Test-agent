import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, MetricCard, StatusBadge, Table, fmtTime, Empty } from '../components/ui';

interface DashboardData {
  projects: number;
  runs: number;
  runsByStatus: Record<string, number>;
  queue: { queued: number; running: number; failed: number };
  workers: number;
  workersOnline: number;
  approvalsPending: number;
  auditEntries: number;
  successRate: number;
  metrics: Record<string, { value: number | null; tracked: boolean; unit?: string }>;
  projectsList: Array<{ id: string; name: string; businesses: string[] }>;
}

export default function Dashboard(): JSX.Element {
  const { data, error } = usePolling<DashboardData>(() => api.get<DashboardData>('/dashboard'), 2000);

  return (
    <div>
      <h1 className="page-title">平台总览</h1>
      <div className="page-sub">每 2 秒自动刷新 · 实时运营视图</div>
      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <Empty text="加载中…" />}
      {data && (
        <>
          <div className="grid">
            <MetricCard label="项目数" value={data.projects} />
            <MetricCard label="执行数" value={data.runs} />
            <MetricCard label="成功率" value={data.successRate} unit="%" />
            <MetricCard label="队列(排队/运行)" value={`${data.queue.queued}/${data.queue.running}`} />
            <MetricCard label="Worker 在线" value={`${data.workersOnline}/${data.workers}`} />
            <MetricCard label="待审批" value={data.approvalsPending} />
            <MetricCard label="审计条数" value={data.auditEntries} />
            <MetricCard label="LLM 成本" value={data.metrics?.llmCost?.value} unit="CNY" tracked={data.metrics?.llmCost?.tracked} />
          </div>

          <div className="grid">
            <MetricCard label="RCA 准确率" value={data.metrics?.rcaAccuracy?.value} unit="%" tracked={data.metrics?.rcaAccuracy?.tracked} />
            <MetricCard label="Flaky 率" value={data.metrics?.flakyRate?.value} unit="%" tracked={data.metrics?.flakyRate?.tracked} />
            <MetricCard label="自愈率" value={data.metrics?.healingRate?.value} unit="%" tracked={data.metrics?.healingRate?.tracked} />
            <MetricCard label="执行成本" value={data.metrics?.executionCost?.value} unit="CNY" tracked={data.metrics?.executionCost?.tracked} />
          </div>

          <Card title="执行状态分布" action={<Link className="link" to="/runs">查看全部 →</Link>}>
            {Object.keys(data.runsByStatus).length === 0 ? (
              <Empty text="暂无执行记录" />
            ) : (
              <Table head={['状态', '数量']}>
                {Object.entries(data.runsByStatus).map(([s, n]) => (
                  <tr key={s}>
                    <td><StatusBadge status={s} /></td>
                    <td>{n}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card title="项目">
            {data.projectsList.length === 0 ? (
              <Empty text="暂无项目" />
            ) : (
              <Table head={['ID', '名称', '业务线']}>
                {data.projectsList.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>{p.name}</td>
                    <td>{(p.businesses ?? []).join(', ')}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
