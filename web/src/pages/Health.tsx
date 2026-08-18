// 健康检查（GET /health）
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, Table, Badge, Empty } from '../components/ui';

interface HealthCheck {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export default function Health(): JSX.Element {
  const { data, error } = usePolling<HealthCheck>(() => api.get<HealthCheck>('/health'), 2000);

  return (
    <div>
      <div className="page-title">健康检查</div>
      <div className="page-sub">平台组件健康状态 · 每 2 秒刷新</div>
      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <Empty text="加载中…" />}
      {data && (
        <>
          <div className="grid">
            <div className="metric-card">
              <div className="metric-label">整体状态</div>
              <div className="metric-value">{data.ok ? 'HEALTHY' : 'DEGRADED'}</div>
              <div className={`metric-track ${data.ok ? 'ok' : 'off'}`}>{data.ok ? '● 全部组件正常' : '● 存在异常组件'}</div>
            </div>
          </div>
          <Card title={`组件检查（${data.checks.length}）`}>
            <Table head={['组件', '状态', '详情']}>
              {data.checks.map((c) => (
                <tr key={c.name}>
                  <td className="mono">{c.name}</td>
                  <td>{c.ok ? <Badge kind="ok">OK</Badge> : <Badge kind="err">FAIL</Badge>}</td>
                  <td>{c.detail}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
