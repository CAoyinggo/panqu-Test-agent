// Worker 列表（GET /workers）
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, Table, Badge, fmtTime, Empty } from '../components/ui';

interface TestWorker {
  workerId: string;
  capabilities: string[];
  environments: string[];
  maxConcurrency: number;
  health: string;
  busy: number;
  registeredAt: string;
  lastHeartbeatAt?: string;
  lastError?: string;
}

const HEALTH_KIND: Record<string, 'ok' | 'warn' | 'err' | 'info' | 'muted'> = {
  healthy: 'ok',
  degraded: 'warn',
  down: 'err',
};

export default function Workers(): JSX.Element {
  const { data, error } = usePolling<TestWorker[]>(() => api.get<TestWorker[]>('/workers'), 2000);

  return (
    <div>
      <div className="page-title">Worker</div>
      <div className="page-sub">执行 Worker 池 · 每 2 秒刷新 · 在线 {data?.filter((w) => w.health === 'healthy').length ?? 0}/{data?.length ?? 0}</div>
      {error && <div className="error-banner">{error}</div>}
      <Card>
        {!data && !error && <Empty text="加载中…" />}
        {data && data.length === 0 && <Empty text="暂无 Worker" />}
        {data && data.length > 0 && (
          <Table head={['Worker ID', '健康', '能力', '环境', '并发', '繁忙', '心跳', '最近错误']}>
            {data.map((w) => (
              <tr key={w.workerId}>
                <td className="mono">{w.workerId}</td>
                <td><Badge kind={HEALTH_KIND[w.health] ?? 'muted'}>{w.health}</Badge></td>
                <td>{(w.capabilities ?? []).join(', ') || '—'}</td>
                <td>{(w.environments ?? []).join(', ') || '—'}</td>
                <td>{w.maxConcurrency}</td>
                <td>{w.busy}</td>
                <td>{fmtTime(w.lastHeartbeatAt)}</td>
                <td className="cell-clip" title={w.lastError}>{w.lastError ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
